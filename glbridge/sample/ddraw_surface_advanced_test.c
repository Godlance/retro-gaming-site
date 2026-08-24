#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <ddraw.h>

#ifndef DDOVERZ_SENDTOFRONT
#define DDOVERZ_SENDTOFRONT 0u
#endif
#ifndef DDENUMOVERLAYZ_BACKTOFRONT
#define DDENUMOVERLAYZ_BACKTOFRONT 0u
#endif

static DWORD external_pixels[16 * 16];

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
    MessageBoxA(window, title, "DirectDraw advanced surface smoke test",
            MB_ICONERROR);
    return 1;
}

static void rgb32_format(DDPIXELFORMAT *format)
{
    ZeroMemory(format, sizeof(*format));
    format->dwSize = sizeof(*format);
    format->dwFlags = DDPF_RGB;
    format->dwRGBBitCount = 32;
    format->dwRBitMask = 0x00ff0000u;
    format->dwGBitMask = 0x0000ff00u;
    format->dwBBitMask = 0x000000ffu;
}

static HRESULT create_rgb_surface(IDirectDraw7 *ddraw, DWORD width,
        DWORD height, DWORD caps, IDirectDrawSurface7 **out)
{
    DDSURFACEDESC2 description;
    ZeroMemory(&description, sizeof(description));
    description.dwSize = sizeof(description);
    description.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT |
            DDSD_PIXELFORMAT;
    description.dwWidth = width;
    description.dwHeight = height;
    description.ddsCaps.dwCaps = caps;
    rgb32_format(&description.ddpfPixelFormat);
    return IDirectDraw7_CreateSurface(ddraw, &description, out, NULL);
}

static HRESULT test_duplicate_and_set_desc(IDirectDraw7 *ddraw,
        IDirectDrawSurface7 **source_out)
{
    IDirectDrawSurface7 *source = NULL;
    IDirectDrawSurface7 *duplicate = NULL;
    DDSURFACEDESC2 locked;
    DDSURFACEDESC2 replacement;
    void *source_pointer;
    HRESULT hr;

    hr = create_rgb_surface(ddraw, 16, 16,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, &source);
    if (FAILED(hr)) return hr;
    ZeroMemory(&locked, sizeof(locked));
    locked.dwSize = sizeof(locked);
    hr = IDirectDrawSurface7_Lock(source, NULL, &locked, DDLOCK_WRITEONLY,
            NULL);
    if (FAILED(hr)) goto done;
    source_pointer = locked.lpSurface;
    *(DWORD *)locked.lpSurface = 0x00112233u;
    hr = IDirectDrawSurface7_Unlock(source, NULL);
    if (FAILED(hr)) goto done;

    hr = IDirectDraw7_DuplicateSurface(ddraw, source, &duplicate);
    if (FAILED(hr)) goto done;
    ZeroMemory(&locked, sizeof(locked));
    locked.dwSize = sizeof(locked);
    hr = IDirectDrawSurface7_Lock(duplicate, NULL, &locked, DDLOCK_READONLY,
            NULL);
    if (FAILED(hr)) goto done;
    if (locked.lpSurface != source_pointer ||
            *(DWORD *)locked.lpSurface != 0x00112233u) {
        IDirectDrawSurface7_Unlock(duplicate, NULL);
        hr = E_FAIL;
        goto done;
    }
    hr = IDirectDrawSurface7_Unlock(duplicate, NULL);
    if (FAILED(hr)) goto done;

    ZeroMemory(external_pixels, sizeof(external_pixels));
    external_pixels[0] = 0x00445566u;
    ZeroMemory(&replacement, sizeof(replacement));
    replacement.dwSize = sizeof(replacement);
    replacement.dwFlags = DDSD_LPSURFACE;
    replacement.lpSurface = external_pixels;
    hr = IDirectDrawSurface7_SetSurfaceDesc(duplicate, &replacement, 0);
    if (FAILED(hr)) goto done;
    ZeroMemory(&locked, sizeof(locked));
    locked.dwSize = sizeof(locked);
    hr = IDirectDrawSurface7_Lock(duplicate, NULL, &locked, DDLOCK_READONLY,
            NULL);
    if (FAILED(hr)) goto done;
    if (locked.lpSurface != external_pixels ||
            *(DWORD *)locked.lpSurface != 0x00445566u) {
        IDirectDrawSurface7_Unlock(duplicate, NULL);
        hr = E_FAIL;
        goto done;
    }
    hr = IDirectDrawSurface7_Unlock(duplicate, NULL);
    if (FAILED(hr)) goto done;

    /* Re-pointing one alias must detach it without changing the original. */
    ZeroMemory(&locked, sizeof(locked));
    locked.dwSize = sizeof(locked);
    hr = IDirectDrawSurface7_Lock(source, NULL, &locked, DDLOCK_READONLY,
            NULL);
    if (FAILED(hr)) goto done;
    if (locked.lpSurface != source_pointer ||
            *(DWORD *)locked.lpSurface != 0x00112233u) {
        IDirectDrawSurface7_Unlock(source, NULL);
        hr = E_FAIL;
        goto done;
    }
    hr = IDirectDrawSurface7_Unlock(source, NULL);
    if (FAILED(hr)) goto done;

    *source_out = duplicate;
    duplicate = NULL;
done:
    if (duplicate) IDirectDrawSurface7_Release(duplicate);
    if (source) IDirectDrawSurface7_Release(source);
    return hr;
}

static HRESULT test_destination_key(IDirectDrawSurface7 *primary,
        IDirectDrawSurface7 *source)
{
    DDCOLORKEY key;
    DDCOLORKEY queried;
    DDBLTFX fx;
    RECT source_rect = { 0, 0, 16, 16 };
    RECT destination_rect = { 0, 0, 16, 16 };
    HRESULT hr;

    key.dwColorSpaceLowValue = 0;
    key.dwColorSpaceHighValue = 0;
    hr = IDirectDrawSurface7_SetColorKey(primary,
            DDCKEY_DESTBLT | DDCKEY_COLORSPACE, &key);
    if (FAILED(hr)) return hr;
    hr = IDirectDrawSurface7_GetColorKey(primary, DDCKEY_DESTBLT, &queried);
    if (FAILED(hr) || queried.dwColorSpaceLowValue != 0 ||
            queried.dwColorSpaceHighValue != 0)
        return E_FAIL;
    hr = IDirectDrawSurface7_Blt(primary, &destination_rect, source,
            &source_rect, DDBLT_KEYDEST | DDBLT_WAIT, NULL);
    if (FAILED(hr)) return hr;
    hr = IDirectDrawSurface7_BltFast(primary, 20, 0, source, &source_rect,
            DDBLTFAST_DESTCOLORKEY | DDBLTFAST_WAIT);
    if (FAILED(hr)) return hr;

    ZeroMemory(&fx, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.ddckDestColorkey.dwColorSpaceLowValue = 0x00445566u;
    fx.ddckDestColorkey.dwColorSpaceHighValue = 0x00445566u;
    destination_rect.left = 40;
    destination_rect.right = 56;
    return IDirectDrawSurface7_Blt(primary, &destination_rect, source,
            &source_rect, DDBLT_KEYDESTOVERRIDE | DDBLT_WAIT, &fx);
}

static HRESULT CALLBACK count_overlay(IDirectDrawSurface7 *surface,
        DDSURFACEDESC2 *description, void *context)
{
    DWORD *count = (DWORD *)context;
    if (!(description->ddsCaps.dwCaps & DDSCAPS_OVERLAY))
        *count = 0xffffffffu;
    else
        ++*count;
    IDirectDrawSurface7_Release(surface);
    return DDENUMRET_OK;
}

static HRESULT test_overlays(IDirectDraw7 *ddraw,
        IDirectDrawSurface7 *primary)
{
    IDirectDrawSurface7 *overlay = NULL;
    IDirectDrawSurface7 *alias = NULL;
    DDSURFACEDESC2 locked;
    DDOVERLAYFX fx;
    DDCOLORKEY source_key;
    DDCOLORKEY destination_key;
    RECT source_rect = { 0, 0, 64, 32 };
    RECT first_rect = { 10, 20, 138, 84 };
    RECT second_rect = { 150, 20, 278, 84 };
    RECT dirty = { 4, 4, 20, 20 };
    LONG x, y;
    DWORD count = 0;
    HRESULT hr;

    hr = create_rgb_surface(ddraw, 64, 32,
            DDSCAPS_OVERLAY | DDSCAPS_SYSTEMMEMORY, &overlay);
    if (FAILED(hr)) return hr;
    ZeroMemory(&locked, sizeof(locked));
    locked.dwSize = sizeof(locked);
    hr = IDirectDrawSurface7_Lock(overlay, NULL, &locked, DDLOCK_WRITEONLY,
            NULL);
    if (FAILED(hr)) goto done;
    ZeroMemory(locked.lpSurface, (SIZE_T)locked.lPitch * 32u);
    ((DWORD *)locked.lpSurface)[0] = 0x00ffffffu;
    hr = IDirectDrawSurface7_Unlock(overlay, NULL);
    if (FAILED(hr)) goto done;

    source_key.dwColorSpaceLowValue = source_key.dwColorSpaceHighValue = 0;
    destination_key.dwColorSpaceLowValue = 0;
    destination_key.dwColorSpaceHighValue = 0;
    hr = IDirectDrawSurface7_SetColorKey(overlay, DDCKEY_SRCOVERLAY,
            &source_key);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_SetColorKey(primary, DDCKEY_DESTOVERLAY,
            &destination_key);
    if (FAILED(hr)) goto done;
    hr = IDirectDraw7_DuplicateSurface(ddraw, overlay, &alias);
    if (FAILED(hr)) goto done;

    ZeroMemory(&fx, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwDDFX = DDOVERFX_MIRRORLEFTRIGHT;
    hr = IDirectDrawSurface7_UpdateOverlay(overlay, &source_rect, primary,
            &first_rect, DDOVER_SHOW | DDOVER_KEYSRC | DDOVER_KEYDEST |
            DDOVER_DDFX, &fx);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_UpdateOverlay(alias, &source_rect, primary,
            &second_rect, DDOVER_SHOW | DDOVER_KEYSRC, NULL);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_SetOverlayPosition(overlay, 12, 24);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_GetOverlayPosition(overlay, &x, &y);
    if (FAILED(hr) || x != 12 || y != 24) { hr = E_FAIL; goto done; }
    hr = IDirectDrawSurface7_AddOverlayDirtyRect(overlay, &dirty);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_UpdateOverlay(overlay, NULL, NULL, NULL,
            DDOVER_REFRESHDIRTYRECTS, NULL);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_UpdateOverlayZOrder(overlay,
            DDOVERZ_SENDTOFRONT, NULL);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_EnumOverlayZOrders(primary,
            DDENUMOVERLAYZ_BACKTOFRONT, &count, count_overlay);
    if (FAILED(hr) || count != 2) { hr = E_FAIL; goto done; }
    hr = IDirectDrawSurface7_UpdateOverlay(alias, NULL, NULL, NULL,
            DDOVER_HIDE, NULL);
    if (FAILED(hr)) goto done;
    hr = IDirectDrawSurface7_UpdateOverlay(overlay, NULL, NULL, NULL,
            DDOVER_HIDE, NULL);
done:
    if (alias) IDirectDrawSurface7_Release(alias);
    if (overlay) IDirectDrawSurface7_Release(overlay);
    return hr;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command_line,
        int show)
{
    WNDCLASSA window_class;
    HWND window;
    IDirectDraw7 *ddraw = NULL;
    IDirectDrawSurface7 *primary = NULL;
    IDirectDrawSurface7 *source = NULL;
    DDSURFACEDESC2 description;
    MSG message;
    HRESULT hr;
    DWORD started;

    (void)previous; (void)command_line;
    ZeroMemory(&window_class, sizeof(window_class));
    window_class.lpfnWndProc = test_window_proc;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
    window_class.lpszClassName = "DDWGSurfaceAdvanced";
    if (!RegisterClassA(&window_class)) return 2;
    window = CreateWindowA(window_class.lpszClassName,
            "DirectDraw advanced surface smoke test",
            WS_OVERLAPPEDWINDOW | WS_VISIBLE, CW_USEDEFAULT, CW_USEDEFAULT,
            656, 519, NULL, NULL, instance, NULL);
    if (!window) return 3;
    ShowWindow(window, show);

    hr = DirectDrawCreateEx(NULL, (void **)&ddraw, &IID_IDirectDraw7, NULL);
    if (FAILED(hr)) return fail(window, "DirectDrawCreateEx", hr);
    hr = IDirectDraw7_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    if (FAILED(hr)) return fail(window, "SetCooperativeLevel", hr);
    ZeroMemory(&description, sizeof(description));
    description.dwSize = sizeof(description);
    description.dwFlags = DDSD_CAPS;
    description.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw7_CreateSurface(ddraw, &description, &primary, NULL);
    if (FAILED(hr)) return fail(window, "Create primary", hr);

    hr = test_duplicate_and_set_desc(ddraw, &source);
    if (FAILED(hr)) return fail(window, "DuplicateSurface/SetSurfaceDesc", hr);
    hr = test_destination_key(primary, source);
    if (FAILED(hr)) return fail(window, "destination colour key", hr);
    hr = test_overlays(ddraw, primary);
    if (FAILED(hr)) return fail(window, "overlay state machine", hr);

    SetWindowTextA(window, "PASS DirectDraw target key + overlay + aliases");
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
    if (source) IDirectDrawSurface7_Release(source);
    if (primary) IDirectDrawSurface7_Release(primary);
    if (ddraw) IDirectDraw7_Release(ddraw);
    return 0;
}

void WINAPI WinMainCRTStartup(void)
{
    ExitProcess((UINT)WinMain(GetModuleHandleA(NULL), NULL,
            GetCommandLineA(), SW_SHOWDEFAULT));
}
