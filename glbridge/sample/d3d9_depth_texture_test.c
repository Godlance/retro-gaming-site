// D3D9 depth-texture capability and binding regression test.
//
// This covers the complete path used by games which allocate a mipmapped depth
// stencil texture instead of using CreateDepthStencilSurface:
// CheckDeviceFormat(D24S8 texture), CreateTexture, GetSurfaceLevel for several
// mips, and binding a nonzero mip with SetDepthStencilSurface.  Like the other
// smoke tests, it has no MinGW CRT dependency and is suitable for Windows XP.

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <initguid.h>
#include <d3d9.h>

#define TEST_WIDTH  320
#define TEST_HEIGHT 240
#define DEPTH_WIDTH  (TEST_WIDTH * 2)
#define DEPTH_HEIGHT (TEST_HEIGHT * 2)
#define DEPTH_LEVELS 3

static const char g_window_class[] = "V86GLD3D9DepthTextureTest";
static IDirect3D9 *g_d3d;
static IDirect3DDevice9 *g_device;
static const char *g_stage = "startup";

static void trace_result(const char *stage, HRESULT hr)
{
    char line[192];

    wsprintfA(line, "[d3d9-depth-texture] %s -> 0x%08lX\r\n",
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

    g_stage = "CheckDeviceFormat(D24S8 depth texture)";
    hr = IDirect3D9_CheckDeviceFormat(g_d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, mode.Format, D3DUSAGE_DEPTHSTENCIL,
            D3DRTYPE_TEXTURE, D3DFMT_D24S8);
    if (FAILED(hr))
        return fail(g_stage, hr);

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

    g_stage = "CreateDevice(no automatic depth stencil)";
    hr = IDirect3D9_CreateDevice(g_d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING,
            &present, &g_device);
    if (FAILED(hr) || !g_device)
        return fail(g_stage, FAILED(hr) ? hr : E_FAIL);
    return D3D_OK;
}

static HRESULT verify_depth_texture_chain(HWND hwnd)
{
    IDirect3DTexture9 *texture = NULL;
    IDirect3DSurface9 *surface0 = NULL;
    IDirect3DSurface9 *surface1 = NULL;
    IDirect3DSurface9 *surface1_again = NULL;
    IDirect3DSurface9 *surface2 = NULL;
    IDirect3DSurface9 *bound = NULL;
    IDirect3DBaseTexture9 *container = NULL;
    D3DSURFACE_DESC desc;
    BOOL device_has_surface = FALSE;
    HRESULT hr;

    g_stage = "CreateTexture(D24S8, three levels)";
    hr = IDirect3DDevice9_CreateTexture(g_device, DEPTH_WIDTH, DEPTH_HEIGHT,
            DEPTH_LEVELS,
            D3DUSAGE_DEPTHSTENCIL, D3DFMT_D24S8, D3DPOOL_DEFAULT,
            &texture, NULL);
    if (FAILED(hr) || !texture)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    g_stage = "GetLevelCount";
    if (IDirect3DTexture9_GetLevelCount(texture) != DEPTH_LEVELS)
    {
        hr = E_FAIL;
        goto done;
    }

    ZeroMemory(&desc, sizeof(desc));
    g_stage = "GetLevelDesc(0)";
    hr = IDirect3DTexture9_GetLevelDesc(texture, 0, &desc);
    if (FAILED(hr) || desc.Format != D3DFMT_D24S8
            || desc.Type != D3DRTYPE_SURFACE
            || desc.Usage != D3DUSAGE_DEPTHSTENCIL
            || desc.Pool != D3DPOOL_DEFAULT
            || desc.Width != DEPTH_WIDTH || desc.Height != DEPTH_HEIGHT)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    g_stage = "GetSurfaceLevel(0)";
    hr = IDirect3DTexture9_GetSurfaceLevel(texture, 0, &surface0);
    if (FAILED(hr) || !surface0)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    ZeroMemory(&desc, sizeof(desc));
    g_stage = "GetLevelDesc(1)";
    hr = IDirect3DTexture9_GetLevelDesc(texture, 1, &desc);
    if (FAILED(hr) || desc.Width != TEST_WIDTH || desc.Height != TEST_HEIGHT)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    g_stage = "GetSurfaceLevel(1)";
    hr = IDirect3DTexture9_GetSurfaceLevel(texture, 1, &surface1);
    if (FAILED(hr) || !surface1)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    g_stage = "GetSurfaceLevel(1, same object)";
    hr = IDirect3DTexture9_GetSurfaceLevel(texture, 1, &surface1_again);
    if (FAILED(hr) || surface1_again != surface1)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    ZeroMemory(&desc, sizeof(desc));
    g_stage = "GetLevelDesc(2)";
    hr = IDirect3DTexture9_GetLevelDesc(texture, 2, &desc);
    if (FAILED(hr) || desc.Width != TEST_WIDTH / 2
            || desc.Height != TEST_HEIGHT / 2)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    g_stage = "GetSurfaceLevel(2)";
    hr = IDirect3DTexture9_GetSurfaceLevel(texture, 2, &surface2);
    if (FAILED(hr) || !surface2)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    g_stage = "DepthSurface::GetContainer";
    hr = IDirect3DSurface9_GetContainer(surface1,
            &IID_IDirect3DBaseTexture9, (void **)&container);
    if (FAILED(hr) || container != (IDirect3DBaseTexture9 *)texture)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    /* Level 1 is exactly the back-buffer size. This exercises the wire-level
     * subresource selector without creating an invalid D3D9 RT/depth pair. */
    g_stage = "SetDepthStencilSurface(texture level 1)";
    hr = IDirect3DDevice9_SetDepthStencilSurface(g_device, surface1);
    if (FAILED(hr))
        goto done;
    device_has_surface = TRUE;

    g_stage = "GetDepthStencilSurface(same object)";
    hr = IDirect3DDevice9_GetDepthStencilSurface(g_device, &bound);
    if (FAILED(hr) || bound != surface1)
    {
        hr = FAILED(hr) ? hr : E_FAIL;
        goto done;
    }

    g_stage = "Clear(D24S8 depth texture)";
    hr = IDirect3DDevice9_Clear(g_device, 0, NULL,
            D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER | D3DCLEAR_STENCIL,
            D3DCOLOR_XRGB(18, 52, 86), 1.0f, 0x5a);
    if (FAILED(hr))
        goto done;

    g_stage = "Present";
    hr = IDirect3DDevice9_Present(g_device, NULL, NULL, NULL, NULL);
    if (SUCCEEDED(hr))
        SetWindowTextA(hwnd, "D3D9 D24S8 depth texture chain: PASS");

done:
    if (bound)
        IDirect3DSurface9_Release(bound);
    if (device_has_surface)
        IDirect3DDevice9_SetDepthStencilSurface(g_device, NULL);
    if (container)
        IDirect3DBaseTexture9_Release(container);
    if (surface2)
        IDirect3DSurface9_Release(surface2);
    if (surface1_again)
        IDirect3DSurface9_Release(surface1_again);
    if (surface1)
        IDirect3DSurface9_Release(surface1);
    if (surface0)
        IDirect3DSurface9_Release(surface0);
    if (texture)
        IDirect3DTexture9_Release(texture);
    if (FAILED(hr))
        return fail(g_stage, hr);
    trace_result("complete", D3D_OK);
    return D3D_OK;
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
    hwnd = CreateWindowA(g_window_class, "D3D9 depth texture: starting",
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
        hr = verify_depth_texture_chain(hwnd);
    if (FAILED(hr))
    {
        char title[192];
        wsprintfA(title, "D3D9 depth texture: %s (0x%08lX)",
                g_stage, (unsigned long)hr);
        SetWindowTextA(hwnd, title);
        MessageBoxA(hwnd, "The D24S8 depth-texture chain failed.",
                "D3D9 depth texture test", MB_OK | MB_ICONERROR);
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
