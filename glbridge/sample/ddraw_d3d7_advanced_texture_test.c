#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <ddraw.h>
#include <d3d.h>

static LRESULT CALLBACK test_window_proc(HWND window, UINT message,
        WPARAM wparam, LPARAM lparam)
{
    if (message == WM_DESTROY) {
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcA(window, message, wparam, lparam);
}

static int fail(HWND window, const char *step, HRESULT result)
{
    char title[192];
    wsprintfA(title, "FAIL %s (0x%08lx)", step, (unsigned long)result);
    SetWindowTextA(window, title);
    MessageBoxA(window, title, "Direct3D 7 advanced WebGPU smoke test",
            MB_ICONERROR);
    return 1;
}

static void fill_bytes(void *pointer, DWORD byte_count, BYTE seed)
{
    BYTE *bytes = (BYTE *)pointer;
    DWORD index;
    for (index = 0; index < byte_count; ++index)
        bytes[index] = (BYTE)(seed + index * 13u);
}

static HRESULT test_sphere_visibility(IDirect3DDevice7 *device)
{
    D3DMATRIX identity;
    D3DVECTOR centers[4];
    D3DVALUE radii[4];
    D3DVALUE user_plane[4];
    DWORD result[4];
    HRESULT hr;

    ZeroMemory(&identity, sizeof(identity));
    identity._11 = identity._22 = identity._33 = identity._44 = 1.0f;
    hr = IDirect3DDevice7_SetTransform(device, D3DTRANSFORMSTATE_WORLD,
            &identity);
    if (FAILED(hr)) return hr;
    hr = IDirect3DDevice7_SetTransform(device, D3DTRANSFORMSTATE_VIEW,
            &identity);
    if (FAILED(hr)) return hr;
    hr = IDirect3DDevice7_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION,
            &identity);
    if (FAILED(hr)) return hr;

    centers[0].x = 0.0f; centers[0].y = 0.0f; centers[0].z = 0.5f;
    centers[1].x = 2.0f; centers[1].y = 0.0f; centers[1].z = 0.5f;
    centers[2].x = 0.95f; centers[2].y = 0.0f; centers[2].z = 0.5f;
    centers[3].x = 0.9f; centers[3].y = 0.0f; centers[3].z = 0.5f;
    radii[0] = radii[1] = radii[2] = radii[3] = 0.1f;
    hr = IDirect3DDevice7_ComputeSphereVisibility(device, centers, radii, 4,
            0, result);
    if (FAILED(hr)) return hr;
    if (result[0] != 0 ||
            result[1] != (D3DSTATUS_CLIPUNIONRIGHT |
                    D3DSTATUS_CLIPINTERSECTIONRIGHT) ||
            result[2] != D3DSTATUS_CLIPUNIONRIGHT ||
            result[3] != 0)
        return E_FAIL;

    user_plane[0] = 1.0f; user_plane[1] = 0.0f;
    user_plane[2] = 0.0f; user_plane[3] = -0.5f;
    hr = IDirect3DDevice7_SetClipPlane(device, 0, user_plane);
    if (FAILED(hr)) return hr;
    hr = IDirect3DDevice7_SetRenderState(device,
            D3DRENDERSTATE_CLIPPLANEENABLE, 1);
    if (FAILED(hr)) return hr;
    hr = IDirect3DDevice7_ComputeSphereVisibility(device, centers, radii, 1,
            0, result);
    if (FAILED(hr)) return hr;
    if (result[0] != (D3DSTATUS_CLIPUNIONGEN0 |
            D3DSTATUS_CLIPINTERSECTIONGEN0))
        return E_FAIL;
    hr = IDirect3DDevice7_SetRenderState(device,
            D3DRENDERSTATE_CLIPPLANEENABLE, 0);
    if (FAILED(hr)) return hr;
    return D3D_OK;
}

static HRESULT upload_dxt_mips(IDirectDraw7 *ddraw)
{
    IDirectDrawSurface7 *root = NULL;
    IDirectDrawSurface7 *level = NULL;
    IDirectDrawSurface7 *next = NULL;
    DDSURFACEDESC2 create;
    DDSURFACEDESC2 locked;
    DDSCAPS2 caps;
    DWORD expected = 8;
    DWORD level_index;
    HRESULT hr;

    ZeroMemory(&create, sizeof(create));
    create.dwSize = sizeof(create);
    create.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT |
            DDSD_PIXELFORMAT | DDSD_MIPMAPCOUNT;
    create.dwWidth = create.dwHeight = 8;
    create.dwMipMapCount = 4;
    create.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX |
            DDSCAPS_MIPMAP;
    create.ddpfPixelFormat.dwSize = sizeof(create.ddpfPixelFormat);
    create.ddpfPixelFormat.dwFlags = DDPF_FOURCC;
    create.ddpfPixelFormat.dwFourCC = MAKEFOURCC('D', 'X', 'T', '1');
    hr = IDirectDraw7_CreateSurface(ddraw, &create, &root, NULL);
    if (FAILED(hr)) return hr;

    level = root;
    IDirectDrawSurface7_AddRef(level);
    for (level_index = 0; level_index < 4; ++level_index) {
        DWORD block_rows = (expected + 3u) / 4u;
        ZeroMemory(&locked, sizeof(locked));
        locked.dwSize = sizeof(locked);
        hr = IDirectDrawSurface7_Lock(level, NULL, &locked, DDLOCK_WRITEONLY,
                NULL);
        if (FAILED(hr)) goto done;
        if (locked.dwWidth != expected || locked.dwHeight != expected ||
                locked.lPitch != (LONG)(((expected + 3u) / 4u) * 8u)) {
            IDirectDrawSurface7_Unlock(level, NULL);
            hr = E_FAIL;
            goto done;
        }
        fill_bytes(locked.lpSurface, (DWORD)locked.lPitch * block_rows,
                (BYTE)(0x20u + level_index));
        hr = IDirectDrawSurface7_Unlock(level, NULL);
        if (FAILED(hr)) goto done;
        if (level_index + 1u == 4u) break;
        ZeroMemory(&caps, sizeof(caps));
        caps.dwCaps = DDSCAPS_MIPMAP;
        hr = IDirectDrawSurface7_GetAttachedSurface(level, &caps, &next);
        if (FAILED(hr)) goto done;
        IDirectDrawSurface7_Release(level);
        level = next;
        next = NULL;
        expected = expected > 1u ? expected / 2u : 1u;
    }
done:
    if (next) IDirectDrawSurface7_Release(next);
    if (level) IDirectDrawSurface7_Release(level);
    if (root) IDirectDrawSurface7_Release(root);
    return hr;
}

static HRESULT upload_cube_mips(IDirectDraw7 *ddraw)
{
    static const DWORD face_caps[6] = {
        DDSCAPS2_CUBEMAP_POSITIVEX, DDSCAPS2_CUBEMAP_NEGATIVEX,
        DDSCAPS2_CUBEMAP_POSITIVEY, DDSCAPS2_CUBEMAP_NEGATIVEY,
        DDSCAPS2_CUBEMAP_POSITIVEZ, DDSCAPS2_CUBEMAP_NEGATIVEZ,
    };
    IDirectDrawSurface7 *root = NULL;
    DDSURFACEDESC2 create;
    HRESULT hr;
    DWORD face;

    ZeroMemory(&create, sizeof(create));
    create.dwSize = sizeof(create);
    create.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT |
            DDSD_PIXELFORMAT | DDSD_MIPMAPCOUNT;
    create.dwWidth = create.dwHeight = 4;
    create.dwMipMapCount = 3;
    create.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX |
            DDSCAPS_MIPMAP;
    create.ddsCaps.dwCaps2 = DDSCAPS2_CUBEMAP |
            DDSCAPS2_CUBEMAP_ALLFACES;
    create.ddpfPixelFormat.dwSize = sizeof(create.ddpfPixelFormat);
    create.ddpfPixelFormat.dwFlags = DDPF_RGB;
    create.ddpfPixelFormat.dwRGBBitCount = 32;
    create.ddpfPixelFormat.dwRBitMask = 0x00ff0000u;
    create.ddpfPixelFormat.dwGBitMask = 0x0000ff00u;
    create.ddpfPixelFormat.dwBBitMask = 0x000000ffu;
    hr = IDirectDraw7_CreateSurface(ddraw, &create, &root, NULL);
    if (FAILED(hr)) return hr;

    for (face = 0; face < 6; ++face) {
        IDirectDrawSurface7 *level = NULL;
        IDirectDrawSurface7 *next = NULL;
        DDSCAPS2 caps;
        DWORD expected = 4;
        DWORD mip;
        ZeroMemory(&caps, sizeof(caps));
        caps.dwCaps2 = face_caps[face];
        hr = IDirectDrawSurface7_GetAttachedSurface(root, &caps, &level);
        if (FAILED(hr)) goto done;
        for (mip = 0; mip < 3; ++mip) {
            DDSURFACEDESC2 locked;
            ZeroMemory(&locked, sizeof(locked));
            locked.dwSize = sizeof(locked);
            hr = IDirectDrawSurface7_Lock(level, NULL, &locked,
                    DDLOCK_WRITEONLY, NULL);
            if (FAILED(hr)) {
                IDirectDrawSurface7_Release(level);
                goto done;
            }
            if (locked.dwWidth != expected || locked.dwHeight != expected) {
                IDirectDrawSurface7_Unlock(level, NULL);
                IDirectDrawSurface7_Release(level);
                hr = E_FAIL;
                goto done;
            }
            fill_bytes(locked.lpSurface, (DWORD)locked.lPitch * expected,
                    (BYTE)(face * 32u + mip));
            hr = IDirectDrawSurface7_Unlock(level, NULL);
            if (FAILED(hr)) {
                IDirectDrawSurface7_Release(level);
                goto done;
            }
            if (mip + 1u == 3u) break;
            ZeroMemory(&caps, sizeof(caps));
            caps.dwCaps = DDSCAPS_MIPMAP;
            hr = IDirectDrawSurface7_GetAttachedSurface(level, &caps, &next);
            if (FAILED(hr)) {
                IDirectDrawSurface7_Release(level);
                goto done;
            }
            IDirectDrawSurface7_Release(level);
            level = next;
            next = NULL;
            expected >>= 1;
        }
        IDirectDrawSurface7_Release(level);
    }
done:
    if (root) IDirectDrawSurface7_Release(root);
    return hr;
}

static HRESULT test_texture_color_key(IDirectDraw7 *ddraw,
        IDirect3DDevice7 *device)
{
    IDirectDrawSurface7 *texture = NULL;
    IDirectDrawSurface7 *bound = NULL;
    DDSURFACEDESC2 create;
    DDSURFACEDESC2 locked;
    DDCOLORKEY key;
    DWORD *pixels;
    HRESULT hr;

    ZeroMemory(&create, sizeof(create));
    create.dwSize = sizeof(create);
    create.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    create.dwWidth = create.dwHeight = 2;
    create.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    create.ddpfPixelFormat.dwSize = sizeof(create.ddpfPixelFormat);
    create.ddpfPixelFormat.dwFlags = DDPF_RGB;
    create.ddpfPixelFormat.dwRGBBitCount = 32;
    create.ddpfPixelFormat.dwRBitMask = 0x00ff0000u;
    create.ddpfPixelFormat.dwGBitMask = 0x0000ff00u;
    create.ddpfPixelFormat.dwBBitMask = 0x000000ffu;
    hr = IDirectDraw7_CreateSurface(ddraw, &create, &texture, NULL);
    if (FAILED(hr)) return hr;
    ZeroMemory(&locked, sizeof(locked));
    locked.dwSize = sizeof(locked);
    hr = IDirectDrawSurface7_Lock(texture, NULL, &locked, DDLOCK_WRITEONLY,
            NULL);
    if (FAILED(hr)) goto done;
    pixels = (DWORD *)locked.lpSurface;
    pixels[0] = 0x00ff00ffu;
    pixels[1] = 0x00ffffffu;
    pixels[locked.lPitch / 4] = 0x00ffffffu;
    pixels[locked.lPitch / 4 + 1] = 0x00ff00ffu;
    hr = IDirectDrawSurface7_Unlock(texture, NULL);
    if (FAILED(hr)) goto done;
    key.dwColorSpaceLowValue = key.dwColorSpaceHighValue = 0x00ff00ffu;
    hr = IDirectDrawSurface7_SetColorKey(texture, DDCKEY_SRCBLT, &key);
    if (FAILED(hr)) goto done;
    hr = IDirect3DDevice7_SetTexture(device, 0, texture);
    if (FAILED(hr)) goto done;
    hr = IDirect3DDevice7_SetRenderState(device,
            D3DRENDERSTATE_COLORKEYENABLE, TRUE);
    if (FAILED(hr)) goto done;
    hr = IDirect3DDevice7_SetRenderState(device,
            D3DRENDERSTATE_COLORKEYBLENDENABLE, TRUE);
    if (FAILED(hr)) goto done;
    hr = IDirect3DDevice7_GetTexture(device, 0, &bound);
    if (FAILED(hr) || bound != texture) {
        if (SUCCEEDED(hr)) hr = E_FAIL;
        goto done;
    }
done:
    if (bound) IDirectDrawSurface7_Release(bound);
    if (device) IDirect3DDevice7_SetTexture(device, 0, NULL);
    if (texture) IDirectDrawSurface7_Release(texture);
    return hr;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command_line,
        int show)
{
    WNDCLASSA window_class;
    HWND window;
    IDirectDraw7 *ddraw = NULL;
    IDirectDrawSurface7 *target = NULL;
    IDirect3D7 *d3d = NULL;
    IDirect3DDevice7 *device = NULL;
    DDSURFACEDESC2 surface_desc;
    MSG message;
    HRESULT hr;
    DWORD started;

    (void)previous; (void)command_line;
    ZeroMemory(&window_class, sizeof(window_class));
    window_class.lpfnWndProc = test_window_proc;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
    window_class.lpszClassName = "D7WGAdvanced";
    if (!RegisterClassA(&window_class)) return 2;
    window = CreateWindowA(window_class.lpszClassName,
            "Direct3D 7 advanced WebGPU smoke test",
            WS_OVERLAPPEDWINDOW | WS_VISIBLE, CW_USEDEFAULT, CW_USEDEFAULT,
            656, 519, NULL, NULL, instance, NULL);
    if (!window) return 3;
    ShowWindow(window, show);

    hr = DirectDrawCreateEx(NULL, (void **)&ddraw, &IID_IDirectDraw7, NULL);
    if (FAILED(hr)) return fail(window, "DirectDrawCreateEx", hr);
    hr = IDirectDraw7_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    if (FAILED(hr)) return fail(window, "SetCooperativeLevel", hr);
    ZeroMemory(&surface_desc, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_3DDEVICE;
    hr = IDirectDraw7_CreateSurface(ddraw, &surface_desc, &target, NULL);
    if (FAILED(hr)) return fail(window, "Create primary", hr);
    hr = IDirectDraw7_QueryInterface(ddraw, &IID_IDirect3D7, (void **)&d3d);
    if (FAILED(hr)) return fail(window, "QueryInterface(IDirect3D7)", hr);
    hr = IDirect3D7_CreateDevice(d3d, &IID_IDirect3DTnLHalDevice, target,
            &device);
    if (FAILED(hr)) return fail(window, "CreateDevice", hr);

    hr = test_sphere_visibility(device);
    if (FAILED(hr)) return fail(window, "ComputeSphereVisibility", hr);
    hr = upload_dxt_mips(ddraw);
    if (FAILED(hr)) return fail(window, "DXT1 mip chain", hr);
    hr = upload_cube_mips(ddraw);
    if (FAILED(hr)) return fail(window, "cube mip chain", hr);
    hr = test_texture_color_key(ddraw, device);
    if (FAILED(hr)) return fail(window, "texture colour key", hr);

    SetWindowTextA(window,
            "PASS D3D7 DXT mip + cube mip + colour key + sphere visibility");
    started = GetTickCount();
    while (GetTickCount() - started < 5000u) {
        while (PeekMessageA(&message, NULL, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) goto done;
            TranslateMessage(&message);
            DispatchMessageA(&message);
        }
        Sleep(10);
    }
done:
    if (device) IDirect3DDevice7_Release(device);
    if (d3d) IDirect3D7_Release(d3d);
    if (target) IDirectDrawSurface7_Release(target);
    if (ddraw) IDirectDraw7_Release(ddraw);
    return 0;
}

void WINAPI WinMainCRTStartup(void)
{
    ExitProcess((UINT)WinMain(GetModuleHandleA(NULL), NULL,
            GetCommandLineA(), SW_SHOWDEFAULT));
}
