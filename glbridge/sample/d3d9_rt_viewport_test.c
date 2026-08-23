// D3D9 off-screen render-target viewport regression test.
//
// 3DMark06 creates a 2048x2048 render target on an 800x600 device. D3D9
// resets the viewport to the full new target when SetRenderTarget(0) succeeds,
// so the viewport limit is the bound RT0 rather than the back-buffer size.

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <d3d9.h>

#define BACK_WIDTH  320u
#define BACK_HEIGHT 240u
#define RT_WIDTH    2048u
#define RT_HEIGHT   2048u

static const char g_window_class[] = "V86GLD3D9RTViewportTest";

static LRESULT CALLBACK window_proc(HWND hwnd, UINT message,
        WPARAM wparam, LPARAM lparam)
{
    return DefWindowProcA(hwnd, message, wparam, lparam);
}

static HRESULT fail(const char *stage, HRESULT hr)
{
    char line[224];

    wsprintfA(line, "[d3d9-rt-viewport] %s -> 0x%08lX\r\n",
            stage, (unsigned long)hr);
    OutputDebugStringA(line);
    return FAILED(hr) ? hr : E_FAIL;
}

static HRESULT run_test(HINSTANCE instance)
{
    WNDCLASSEXA window_class;
    D3DDISPLAYMODE mode;
    D3DPRESENT_PARAMETERS present;
    D3DVIEWPORT9 viewport;
    IDirect3D9 *d3d = NULL;
    IDirect3DDevice9 *device = NULL;
    IDirect3DTexture9 *texture = NULL;
    IDirect3DSurface9 *target = NULL;
    IDirect3DSurface9 *back_buffer = NULL;
    HWND window = NULL;
    HRESULT hr = E_FAIL;

    ZeroMemory(&window_class, sizeof(window_class));
    window_class.cbSize = sizeof(window_class);
    window_class.lpfnWndProc = window_proc;
    window_class.hInstance = instance;
    window_class.lpszClassName = g_window_class;
    if (!RegisterClassExA(&window_class))
        return fail("RegisterClassEx", HRESULT_FROM_WIN32(GetLastError()));

    window = CreateWindowExA(0, g_window_class,
            "D3D9 RT viewport: running", WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT, CW_USEDEFAULT, BACK_WIDTH, BACK_HEIGHT,
            NULL, NULL, instance, NULL);
    if (!window) {
        hr = fail("CreateWindow", HRESULT_FROM_WIN32(GetLastError()));
        goto done;
    }

    d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) {
        hr = fail("Direct3DCreate9", E_FAIL);
        goto done;
    }
    ZeroMemory(&mode, sizeof(mode));
    hr = IDirect3D9_GetAdapterDisplayMode(d3d, D3DADAPTER_DEFAULT, &mode);
    if (FAILED(hr)) {
        hr = fail("GetAdapterDisplayMode", hr);
        goto done;
    }

    ZeroMemory(&present, sizeof(present));
    present.BackBufferWidth = BACK_WIDTH;
    present.BackBufferHeight = BACK_HEIGHT;
    present.BackBufferFormat = mode.Format;
    present.BackBufferCount = 1;
    present.MultiSampleType = D3DMULTISAMPLE_NONE;
    present.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present.hDeviceWindow = window;
    present.Windowed = TRUE;

    hr = IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present, &device);
    if (FAILED(hr) || !device) {
        hr = fail("CreateDevice", FAILED(hr) ? hr : E_FAIL);
        goto done;
    }
    hr = IDirect3DDevice9_GetBackBuffer(device, 0, 0,
            D3DBACKBUFFER_TYPE_MONO, &back_buffer);
    if (FAILED(hr)) {
        hr = fail("GetBackBuffer", hr);
        goto done;
    }
    hr = IDirect3DDevice9_CreateTexture(device, RT_WIDTH, RT_HEIGHT, 1,
            D3DUSAGE_RENDERTARGET, D3DFMT_R5G6B5, D3DPOOL_DEFAULT,
            &texture, NULL);
    if (FAILED(hr) || !texture) {
        hr = fail("CreateTexture(2048x2048 RT)", FAILED(hr) ? hr : E_FAIL);
        goto done;
    }
    hr = IDirect3DTexture9_GetSurfaceLevel(texture, 0, &target);
    if (FAILED(hr) || !target) {
        hr = fail("GetSurfaceLevel", FAILED(hr) ? hr : E_FAIL);
        goto done;
    }

    hr = IDirect3DDevice9_SetRenderTarget(device, 0, target);
    if (FAILED(hr)) {
        hr = fail("SetRenderTarget(2048x2048)", hr);
        goto done;
    }
    ZeroMemory(&viewport, sizeof(viewport));
    hr = IDirect3DDevice9_GetViewport(device, &viewport);
    if (FAILED(hr) || viewport.X != 0 || viewport.Y != 0
            || viewport.Width != RT_WIDTH || viewport.Height != RT_HEIGHT
            || viewport.MinZ != 0.0f || viewport.MaxZ != 1.0f) {
        hr = fail("automatic 2048x2048 viewport", FAILED(hr) ? hr : E_FAIL);
        goto done;
    }
    hr = IDirect3DDevice9_SetViewport(device, &viewport);
    if (FAILED(hr)) {
        hr = fail("explicit 2048x2048 viewport", hr);
        goto done;
    }
    hr = IDirect3DDevice9_Clear(device, 0, NULL, D3DCLEAR_TARGET,
            D3DCOLOR_XRGB(0, 255, 0), 1.0f, 0);
    if (FAILED(hr)) {
        hr = fail("Clear off-screen RT", hr);
        goto done;
    }
    hr = IDirect3DDevice9_SetRenderTarget(device, 0, back_buffer);
    if (FAILED(hr)) {
        hr = fail("restore back buffer", hr);
        goto done;
    }
    SetWindowTextA(window, "D3D9 2048x2048 RT viewport: PASS");
    OutputDebugStringA("[d3d9-rt-viewport] PASS\r\n");

done:
    if (target)
        IDirect3DSurface9_Release(target);
    if (texture)
        IDirect3DTexture9_Release(texture);
    if (back_buffer)
        IDirect3DSurface9_Release(back_buffer);
    if (device)
        IDirect3DDevice9_Release(device);
    if (d3d)
        IDirect3D9_Release(d3d);
    if (window)
        DestroyWindow(window);
    UnregisterClassA(g_window_class, instance);
    return hr;
}

void WINAPI WinMainCRTStartup(void)
{
    ExitProcess((UINT)run_test(GetModuleHandleA(NULL)));
}
