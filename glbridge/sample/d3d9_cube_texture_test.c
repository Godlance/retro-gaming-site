// D3D9 cube-texture creation and capability-agreement regression test.
//
// The bug this exists to catch is not "cube maps are broken" but something
// narrower and much more damaging: CheckDeviceFormat and CreateCubeTexture
// disagreeing. 3DMark06 asked whether it could filter a G16R16 cube map, was
// told yes, and got D3DERR_INVALIDCALL back from the create. Real D3D9 never
// produces that combination, so applications do not defend against it -- 3DMark
// threw a C++ exception out of the failure and died dereferencing an
// uninitialised COM pointer while unwinding.
//
// So the assertion here is an invariant rather than a feature: for every format
// the runtime blesses, the matching create must succeed, and D3DUSAGE_AUTOGEN-
// MIPMAP must report D3DOK_NOAUTOGEN with a usable texture rather than refusing.
// Like the other smoke tests it has no MinGW CRT dependency and runs on XP.

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <initguid.h>
#include <d3d9.h>

#define TEST_WIDTH  320
#define TEST_HEIGHT 240
#define CUBE_EDGE   64

static const char g_window_class[] = "V86GLD3D9CubeTextureTest";
static IDirect3D9 *g_d3d;
static IDirect3DDevice9 *g_device;
static D3DFORMAT g_adapter_format;
static const char *g_stage = "startup";

static const D3DFORMAT g_candidates[] = {
    D3DFMT_A8R8G8B8, D3DFMT_X8R8G8B8, D3DFMT_R5G6B5, D3DFMT_A1R5G5B5,
    D3DFMT_G16R16, D3DFMT_A16B16G16R16, D3DFMT_A16B16G16R16F,
    D3DFMT_A32B32G32R32F, D3DFMT_L8, D3DFMT_A8L8, D3DFMT_DXT1, D3DFMT_DXT5,
};

static void trace_result(const char *stage, HRESULT hr)
{
    char line[192];

    wsprintfA(line, "[d3d9-cube-texture] %s -> 0x%08lX\r\n",
            stage, (unsigned long)hr);
    OutputDebugStringA(line);
}

static HRESULT fail(const char *stage, HRESULT hr)
{
    g_stage = stage;
    trace_result(stage, hr);
    return FAILED(hr) ? hr : E_FAIL;
}

static void release_d3d9(void)
{
    if (g_device)
    {
        IDirect3DDevice9_Release(g_device);
        g_device = NULL;
    }
    if (g_d3d)
    {
        IDirect3D9_Release(g_d3d);
        g_d3d = NULL;
    }
}

static HRESULT create_device(HWND hwnd)
{
    D3DDISPLAYMODE mode;
    D3DPRESENT_PARAMETERS present;
    HRESULT hr;

    g_stage = "Direct3DCreate9";
    g_d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!g_d3d)
        return fail(g_stage, E_FAIL);

    ZeroMemory(&mode, sizeof(mode));
    g_stage = "GetAdapterDisplayMode";
    hr = IDirect3D9_GetAdapterDisplayMode(g_d3d, D3DADAPTER_DEFAULT, &mode);
    if (FAILED(hr))
        return fail(g_stage, hr);
    g_adapter_format = mode.Format;

    ZeroMemory(&present, sizeof(present));
    present.BackBufferWidth = TEST_WIDTH;
    present.BackBufferHeight = TEST_HEIGHT;
    present.BackBufferFormat = mode.Format;
    present.BackBufferCount = 1;
    present.MultiSampleType = D3DMULTISAMPLE_NONE;
    present.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present.hDeviceWindow = hwnd;
    present.Windowed = TRUE;
    present.EnableAutoDepthStencil = FALSE;
    present.PresentationInterval = D3DPRESENT_INTERVAL_DEFAULT;

    g_stage = "CreateDevice";
    hr = IDirect3D9_CreateDevice(g_d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING,
            &present, &g_device);
    if (FAILED(hr) || !g_device)
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    return D3D_OK;
}

// The invariant: whatever CheckDeviceFormat blesses, CreateCubeTexture must
// deliver. Every usage the query is asked about is asked in the same shape the
// create will use it, so a "yes" that the create then refuses fails the test
// here rather than in an application's exception handler.
static HRESULT verify_query_matches_create(void)
{
    static const DWORD usages[] = {
        0,
        D3DUSAGE_QUERY_FILTER,
        D3DUSAGE_QUERY_WRAPANDMIP,
        D3DUSAGE_QUERY_SRGBREAD,
    };
    IDirect3DCubeTexture9 *cube;
    HRESULT query, hr;
    UINT format_index, usage_index;
    char stage[192];

    for (format_index = 0;
            format_index < sizeof(g_candidates) / sizeof(g_candidates[0]);
            ++format_index)
    {
        const D3DFORMAT format = g_candidates[format_index];
        for (usage_index = 0;
                usage_index < sizeof(usages) / sizeof(usages[0]);
                ++usage_index)
        {
            query = IDirect3D9_CheckDeviceFormat(g_d3d, D3DADAPTER_DEFAULT,
                    D3DDEVTYPE_HAL, g_adapter_format, usages[usage_index],
                    D3DRTYPE_CUBETEXTURE, format);
            if (FAILED(query))
                continue;

            cube = NULL;
            hr = IDirect3DDevice9_CreateCubeTexture(g_device, CUBE_EDGE, 1,
                    0, format, D3DPOOL_MANAGED, &cube, NULL);
            if (FAILED(hr) || !cube)
            {
                wsprintfA(stage, "CheckDeviceFormat said yes to format=%lu "
                        "usage=%08lX but CreateCubeTexture refused",
                        (unsigned long)format,
                        (unsigned long)usages[usage_index]);
                return fail(stage, FAILED(hr) ? hr : E_FAIL);
            }
            IDirect3DCubeTexture9_Release(cube);
        }
    }
    return D3D_OK;
}

// D3DUSAGE_AUTOGENMIPMAP is a hint. A backend that cannot generate mip chains
// answers D3DOK_NOAUTOGEN -- a *success* code -- and still hands back a working
// texture. Refusing it outright is the failure mode no application handles.
static HRESULT verify_autogen_is_a_hint(void)
{
    IDirect3DCubeTexture9 *cube = NULL;
    IDirect3DTexture9 *texture = NULL;
    IDirect3DSurface9 *face = NULL;
    HRESULT hr;

    g_stage = "CreateCubeTexture(D3DUSAGE_AUTOGENMIPMAP)";
    hr = IDirect3DDevice9_CreateCubeTexture(g_device, CUBE_EDGE, 0,
            D3DUSAGE_AUTOGENMIPMAP, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED,
            &cube, NULL);
    if (FAILED(hr) || !cube)
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    trace_result(g_stage, hr);

    // Whether auto-generation happened or not, level 0 has to be reachable:
    // that is what makes the returned texture usable rather than a token.
    g_stage = "CubeTexture.GetCubeMapSurface(level 0)";
    hr = IDirect3DCubeTexture9_GetCubeMapSurface(cube,
            D3DCUBEMAP_FACE_POSITIVE_X, 0, &face);
    if (FAILED(hr) || !face)
    {
        IDirect3DCubeTexture9_Release(cube);
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    }
    IDirect3DSurface9_Release(face);
    IDirect3DCubeTexture9_Release(cube);

    g_stage = "CreateTexture(D3DUSAGE_AUTOGENMIPMAP)";
    hr = IDirect3DDevice9_CreateTexture(g_device, CUBE_EDGE, CUBE_EDGE, 0,
            D3DUSAGE_AUTOGENMIPMAP, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED,
            &texture, NULL);
    if (FAILED(hr) || !texture)
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    trace_result(g_stage, hr);
    IDirect3DTexture9_Release(texture);
    return D3D_OK;
}

// The dynamic environment map: a cube render target, each face bound in turn.
// Protocol 1.4 carries the face index, so all six are distinct attachments --
// before that they all resolved to layer 0 and five faces of every environment
// map were painted over the first.
static HRESULT verify_render_target_cube(void)
{
    IDirect3DCubeTexture9 *cube = NULL;
    IDirect3DSurface9 *original = NULL;
    IDirect3DSurface9 *face_surface = NULL;
    HRESULT query, hr;
    UINT face;

    query = IDirect3D9_CheckDeviceFormat(g_d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, g_adapter_format, D3DUSAGE_RENDERTARGET,
            D3DRTYPE_CUBETEXTURE, D3DFMT_A8R8G8B8);
    g_stage = "CreateCubeTexture(D3DUSAGE_RENDERTARGET)";
    hr = IDirect3DDevice9_CreateCubeTexture(g_device, CUBE_EDGE, 1,
            D3DUSAGE_RENDERTARGET, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT,
            &cube, NULL);
    /* The invariant again, in the direction that matters here. */
    if (SUCCEEDED(query) != SUCCEEDED(hr)) {
        if (cube) IDirect3DCubeTexture9_Release(cube);
        return fail("CheckDeviceFormat and CreateCubeTexture disagree about "
                "render-target cube maps", E_FAIL);
    }
    if (FAILED(hr))
        return D3D_OK; /* Consistently unavailable is a legitimate answer. */
    if (!cube)
        return fail(g_stage, E_FAIL);

    g_stage = "GetRenderTarget(0) before binding a face";
    hr = IDirect3DDevice9_GetRenderTarget(g_device, 0, &original);
    if (FAILED(hr) || !original) {
        IDirect3DCubeTexture9_Release(cube);
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    }

    for (face = 0; face < 6u; ++face) {
        g_stage = "GetCubeMapSurface + SetRenderTarget(face)";
        hr = IDirect3DCubeTexture9_GetCubeMapSurface(cube,
                (D3DCUBEMAP_FACES)face, 0, &face_surface);
        if (SUCCEEDED(hr) && face_surface) {
            hr = IDirect3DDevice9_SetRenderTarget(g_device, 0, face_surface);
            if (SUCCEEDED(hr))
                hr = IDirect3DDevice9_Clear(g_device, 0, NULL, D3DCLEAR_TARGET,
                        D3DCOLOR_XRGB(face * 40u, 0, 0), 1.0f, 0);
            IDirect3DSurface9_Release(face_surface);
            face_surface = NULL;
        }
        if (FAILED(hr))
            break;
    }

    IDirect3DDevice9_SetRenderTarget(g_device, 0, original);
    IDirect3DSurface9_Release(original);
    IDirect3DCubeTexture9_Release(cube);
    if (FAILED(hr))
        return fail(g_stage, hr);
    return D3D_OK;
}

/* The formats a palettized or video-sourced title needs. Each one is asked
 * about and then created, because the whole point of the shared predicate is
 * that those two answers cannot disagree. */
static HRESULT verify_extended_formats(void)
{
    static const D3DFORMAT formats[] = {
        D3DFMT_P8, D3DFMT_A8P8, D3DFMT_Q16W16V16U16,
        D3DFMT_UYVY, D3DFMT_YUY2, D3DFMT_R8G8_B8G8, D3DFMT_G8R8_G8B8,
    };
    IDirect3DTexture9 *texture;
    HRESULT query, hr;
    UINT index;
    char stage[192];

    for (index = 0; index < sizeof(formats) / sizeof(formats[0]); ++index) {
        query = IDirect3D9_CheckDeviceFormat(g_d3d, D3DADAPTER_DEFAULT,
                D3DDEVTYPE_HAL, g_adapter_format, 0, D3DRTYPE_TEXTURE,
                formats[index]);
        if (FAILED(query))
            continue;
        texture = NULL;
        /* Even edge length: the packed formats put two texels in one block. */
        hr = IDirect3DDevice9_CreateTexture(g_device, 16, 16, 1, 0,
                formats[index], D3DPOOL_MANAGED, &texture, NULL);
        if (FAILED(hr) || !texture) {
            wsprintfA(stage, "format %08lX passed CheckDeviceFormat but "
                    "CreateTexture refused it",
                    (unsigned long)formats[index]);
            return fail(stage, FAILED(hr) ? hr : E_FAIL);
        }
        IDirect3DTexture9_Release(texture);
    }
    return D3D_OK;
}

/*
 * The second half of the capability invariant: a create the query blessed must
 * succeed, *and* the operations D3D9 defines on the result must work. Reporting
 * offscreen plain surfaces as available while StretchRect refused them is what
 * put an "IDirect3DDevice9::StretchRect failed" box on screen, so the blit is
 * exercised here rather than the creation alone.
 */
static HRESULT verify_offscreen_plain_blits(void)
{
    IDirect3DSurface9 *offscreen = NULL;
    IDirect3DSurface9 *target = NULL;
    HRESULT query, hr;

    query = IDirect3D9_CheckDeviceFormat(g_d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, g_adapter_format, 0, D3DRTYPE_SURFACE,
            D3DFMT_A8R8G8B8);
    if (FAILED(query))
        return D3D_OK; /* Consistently unavailable is a legitimate answer. */

    g_stage = "CreateOffscreenPlainSurface(D3DPOOL_DEFAULT)";
    hr = IDirect3DDevice9_CreateOffscreenPlainSurface(g_device, 64, 64,
            D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &offscreen, NULL);
    if (FAILED(hr) || !offscreen)
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);

    /*
     * A D3DPOOL_DEFAULT off-screen plain surface is lockable -- it is the one
     * default-pool surface D3D9 lets an app write to directly, and apps seed
     * GPU-side data through it (3DMark06's SM3.0 particle test locks a 640x640
     * A32B32G32R32F one to lay down its initial particle state). Checked here
     * because the surface is already at hand and because the lock is easy to
     * lose to a "default pool is not lockable" shortcut.
     */
    g_stage = "Surface.LockRect on a D3DPOOL_DEFAULT offscreen plain surface";
    {
        D3DLOCKED_RECT locked;
        hr = IDirect3DSurface9_LockRect(offscreen, &locked, NULL, 0);
        if (FAILED(hr) || !locked.pBits || locked.Pitch < 64 * 4) {
            IDirect3DSurface9_Release(offscreen);
            return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
        }
        /* Touch the first and last row so a pitch that is right for level 0 but
         * wrong for the allocation shows up as a heap overrun rather than as a
         * silently truncated upload. */
        *(DWORD *)locked.pBits = 0xFF102030u;
        *(DWORD *)((BYTE *)locked.pBits + 63 * locked.Pitch) = 0xFF405060u;
        g_stage = "Surface.UnlockRect on a D3DPOOL_DEFAULT offscreen plain "
                "surface";
        hr = IDirect3DSurface9_UnlockRect(offscreen);
        if (FAILED(hr)) {
            IDirect3DSurface9_Release(offscreen);
            return fail(g_stage, hr);
        }
    }

    g_stage = "CreateRenderTarget for the blit source";
    hr = IDirect3DDevice9_CreateRenderTarget(g_device, 64, 64,
            D3DFMT_A8R8G8B8, D3DMULTISAMPLE_NONE, 0, FALSE, &target, NULL);
    if (FAILED(hr) || !target) {
        IDirect3DSurface9_Release(offscreen);
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    }

    /* Both directions: D3D9 allows either, and they take different host paths
     * (one is a copy into the surface, the other out of it). */
    g_stage = "StretchRect(render target -> offscreen plain)";
    hr = IDirect3DDevice9_StretchRect(g_device, target, NULL, offscreen, NULL,
            D3DTEXF_NONE);
    if (SUCCEEDED(hr)) {
        g_stage = "StretchRect(offscreen plain -> render target)";
        hr = IDirect3DDevice9_StretchRect(g_device, offscreen, NULL, target,
                NULL, D3DTEXF_NONE);
    }
    IDirect3DSurface9_Release(target);
    IDirect3DSurface9_Release(offscreen);
    if (FAILED(hr))
        return fail(g_stage, hr);
    return D3D_OK;
}

/* Automatic mip generation. D3D9 reports one level for such a texture -- the
 * driver owns everything below it -- so the level count is part of the contract
 * rather than an implementation detail, and GenerateMipSubLevels has to be
 * callable without the app ever seeing a sublevel. */
static HRESULT verify_autogen_mipmaps(void)
{
    IDirect3DTexture9 *texture = NULL;
    IDirect3DSurface9 *level0 = NULL;
    IDirect3DSurface9 *level1 = NULL;
    D3DTEXTUREFILTERTYPE filter;
    HRESULT query, hr;

    query = IDirect3D9_CheckDeviceFormat(g_d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, g_adapter_format, D3DUSAGE_AUTOGENMIPMAP,
            D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8);
    g_stage = "CreateTexture(D3DUSAGE_AUTOGENMIPMAP)";
    hr = IDirect3DDevice9_CreateTexture(g_device, 64, 64, 0,
            D3DUSAGE_AUTOGENMIPMAP, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED,
            &texture, NULL);
    if (SUCCEEDED(query) != SUCCEEDED(hr)) {
        if (texture) IDirect3DTexture9_Release(texture);
        return fail("CheckDeviceFormat and CreateTexture disagree about "
                "automatic mipmap generation", E_FAIL);
    }
    if (FAILED(hr) || !texture)
        return SUCCEEDED(query) ? fail(g_stage, hr) : D3D_OK;

    if (IDirect3DTexture9_GetLevelCount(texture) != 1) {
        IDirect3DTexture9_Release(texture);
        return fail("an autogen texture must report exactly one level",
                E_FAIL);
    }
    g_stage = "Texture.GetSurfaceLevel(0) on an autogen texture";
    hr = IDirect3DTexture9_GetSurfaceLevel(texture, 0, &level0);
    if (FAILED(hr) || !level0) {
        IDirect3DTexture9_Release(texture);
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    }
    IDirect3DSurface9_Release(level0);
    /* Sublevels belong to the driver, so asking for one must fail. */
    if (SUCCEEDED(IDirect3DTexture9_GetSurfaceLevel(texture, 1, &level1))) {
        if (level1) IDirect3DSurface9_Release(level1);
        IDirect3DTexture9_Release(texture);
        return fail("an autogen texture must not hand out sublevels", E_FAIL);
    }

    g_stage = "Texture.SetAutoGenFilterType(D3DTEXF_LINEAR)";
    hr = IDirect3DTexture9_SetAutoGenFilterType(texture, D3DTEXF_LINEAR);
    if (FAILED(hr)) {
        IDirect3DTexture9_Release(texture);
        return fail(g_stage, hr);
    }
    filter = IDirect3DTexture9_GetAutoGenFilterType(texture);
    if (filter != D3DTEXF_LINEAR) {
        IDirect3DTexture9_Release(texture);
        return fail("GetAutoGenFilterType did not report what was set", E_FAIL);
    }
    IDirect3DTexture9_GenerateMipSubLevels(texture);
    IDirect3DTexture9_Release(texture);
    return D3D_OK;
}

/* Palettes are device state consulted at sample time, so they have to survive
 * a round trip and select independently of any texture. */
static HRESULT verify_palettes(void)
{
    PALETTEENTRY entries[256];
    PALETTEENTRY readback[256];
    UINT current = 0xFFFFFFFFu;
    HRESULT hr;
    UINT entry;

    for (entry = 0; entry < 256u; ++entry) {
        entries[entry].peRed = (BYTE)entry;
        entries[entry].peGreen = (BYTE)(255u - entry);
        entries[entry].peBlue = (BYTE)((entry * 3u) & 0xFFu);
        entries[entry].peFlags = 0xFF; /* D3D9 reads peFlags as alpha */
    }
    g_stage = "Device.SetPaletteEntries";
    hr = IDirect3DDevice9_SetPaletteEntries(g_device, 0, entries);
    if (FAILED(hr))
        return fail(g_stage, hr);

    g_stage = "Device.GetPaletteEntries round trip";
    ZeroMemory(readback, sizeof(readback));
    hr = IDirect3DDevice9_GetPaletteEntries(g_device, 0, readback);
    if (FAILED(hr))
        return fail(g_stage, hr);
    for (entry = 0; entry < 256u; ++entry) {
        if (readback[entry].peRed != entries[entry].peRed
                || readback[entry].peGreen != entries[entry].peGreen
                || readback[entry].peBlue != entries[entry].peBlue
                || readback[entry].peFlags != entries[entry].peFlags)
            return fail("GetPaletteEntries returned different entries", E_FAIL);
    }

    g_stage = "Device.SetCurrentTexturePalette";
    hr = IDirect3DDevice9_SetCurrentTexturePalette(g_device, 0);
    if (FAILED(hr))
        return fail(g_stage, hr);
    g_stage = "Device.GetCurrentTexturePalette";
    hr = IDirect3DDevice9_GetCurrentTexturePalette(g_device, &current);
    if (FAILED(hr) || current != 0)
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    return D3D_OK;
}

static HRESULT verify_cube_textures(void)
{
    HRESULT hr;

    hr = verify_query_matches_create();
    if (FAILED(hr))
        return hr;
    hr = verify_autogen_is_a_hint();
    if (FAILED(hr))
        return hr;
    hr = verify_render_target_cube();
    if (FAILED(hr))
        return hr;
    hr = verify_extended_formats();
    if (FAILED(hr))
        return hr;
    hr = verify_offscreen_plain_blits();
    if (FAILED(hr))
        return hr;
    hr = verify_autogen_mipmaps();
    if (FAILED(hr))
        return hr;
    return verify_palettes();
}

static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam,
        LPARAM lparam)
{
    switch (message)
    {
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT:
        {
            PAINTSTRUCT paint;
            BeginPaint(hwnd, &paint);
            EndPaint(hwnd, &paint);
            return 0;
        }
        case WM_DESTROY:
            release_d3d9();
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcA(hwnd, message, wparam, lparam);
}

static int run_test(HINSTANCE instance, int show_command)
{
    WNDCLASSA window_class;
    RECT window_rect;
    HWND hwnd;
    MSG message;
    HRESULT hr;

    ZeroMemory(&window_class, sizeof(window_class));
    window_class.style = CS_OWNDC;
    window_class.lpfnWndProc = window_proc;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursorA(NULL, IDC_ARROW);
    window_class.lpszClassName = g_window_class;
    if (!RegisterClassA(&window_class))
        return 1;

    SetRect(&window_rect, 0, 0, TEST_WIDTH, TEST_HEIGHT);
    AdjustWindowRect(&window_rect, WS_OVERLAPPEDWINDOW, FALSE);
    hwnd = CreateWindowA(g_window_class, "D3D9 cube texture: starting",
            WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
            window_rect.right - window_rect.left,
            window_rect.bottom - window_rect.top,
            NULL, NULL, instance, NULL);
    if (!hwnd)
        return 2;

    ShowWindow(hwnd, show_command);
    UpdateWindow(hwnd);
    hr = create_device(hwnd);
    if (SUCCEEDED(hr))
        hr = verify_cube_textures();
    if (FAILED(hr))
    {
        char title[192];
        wsprintfA(title, "D3D9 cube texture: %s (0x%08lX)",
                g_stage, (unsigned long)hr);
        SetWindowTextA(hwnd, title);
        MessageBoxA(hwnd, "The cube-texture capability contract failed.",
                "D3D9 cube texture test", MB_OK | MB_ICONERROR);
    }

    while (GetMessageA(&message, NULL, 0, 0) > 0)
    {
        TranslateMessage(&message);
        DispatchMessageA(&message);
    }
    return FAILED(hr) ? 3 : 0;
}

void WINAPI WinMainCRTStartup(void)
{
    int result = run_test(GetModuleHandleA(NULL), SW_SHOWDEFAULT);
    ExitProcess((UINT)result);
}
