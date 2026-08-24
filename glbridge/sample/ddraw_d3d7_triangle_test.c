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
    char title[160];
    wsprintfA(title, "FAIL %s (0x%08lx)", step, (unsigned long)result);
    SetWindowTextA(window, title);
    MessageBoxA(window, title, "Direct3D 7 WebGPU smoke test", MB_ICONERROR);
    return 1;
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
    D3DVIEWPORT7 viewport;
    D3DTLVERTEX vertices[3];
    MSG message;
    HRESULT result;
    DWORD started;

    (void)previous; (void)command_line;
    ZeroMemory(&window_class, sizeof(window_class));
    window_class.lpfnWndProc = test_window_proc;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
    window_class.lpszClassName = "D7WGSmoke";
    if (!RegisterClassA(&window_class)) return 2;
    window = CreateWindowA(window_class.lpszClassName,
            "Direct3D 7 WebGPU smoke test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT, CW_USEDEFAULT, 656, 519, NULL, NULL, instance, NULL);
    if (!window) return 3;
    ShowWindow(window, show);

    result = DirectDrawCreateEx(NULL, (void **)&ddraw, &IID_IDirectDraw7, NULL);
    if (FAILED(result)) return fail(window, "DirectDrawCreateEx", result);
    result = IDirectDraw7_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    if (FAILED(result)) return fail(window, "SetCooperativeLevel", result);
    ZeroMemory(&surface_desc, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_3DDEVICE;
    result = IDirectDraw7_CreateSurface(ddraw, &surface_desc, &target, NULL);
    if (FAILED(result)) return fail(window, "CreateSurface", result);
    result = IDirectDraw7_QueryInterface(ddraw, &IID_IDirect3D7,
            (void **)&d3d);
    if (FAILED(result)) return fail(window, "QueryInterface(IDirect3D7)", result);
    result = IDirect3D7_CreateDevice(d3d, &IID_IDirect3DTnLHalDevice, target,
            &device);
    if (FAILED(result)) return fail(window, "CreateDevice", result);

    ZeroMemory(&viewport, sizeof(viewport));
    viewport.dwWidth = 640;
    viewport.dwHeight = 480;
    viewport.dvMinZ = 0.0f;
    viewport.dvMaxZ = 1.0f;
    result = IDirect3DDevice7_SetViewport(device, &viewport);
    if (FAILED(result)) return fail(window, "SetViewport", result);
    result = IDirect3DDevice7_Clear(device, 0, NULL, D3DCLEAR_TARGET,
            0xff102040u, 1.0f, 0);
    if (FAILED(result)) return fail(window, "Clear", result);
    result = IDirect3DDevice7_BeginScene(device);
    if (FAILED(result)) return fail(window, "BeginScene", result);

    ZeroMemory(vertices, sizeof(vertices));
    vertices[0].sx = 320.0f; vertices[0].sy = 70.0f;
    vertices[1].sx = 100.0f; vertices[1].sy = 410.0f;
    vertices[2].sx = 540.0f; vertices[2].sy = 410.0f;
    vertices[0].sz = vertices[1].sz = vertices[2].sz = 0.5f;
    vertices[0].rhw = vertices[1].rhw = vertices[2].rhw = 1.0f;
    vertices[0].color = 0xffff4040u;
    vertices[1].color = 0xff40ff40u;
    vertices[2].color = 0xff4080ffu;
    vertices[0].specular = vertices[1].specular =
            vertices[2].specular = 0xff000000u;
    result = IDirect3DDevice7_SetTextureStageState(device, 0,
            D3DTSS_COLOROP, D3DTOP_SELECTARG2);
    if (FAILED(result)) return fail(window, "SetTextureStageState", result);
    result = IDirect3DDevice7_SetTextureStageState(device, 0,
            D3DTSS_COLORARG2, D3DTA_DIFFUSE);
    if (FAILED(result)) return fail(window, "SetTextureStageState arg", result);
    result = IDirect3DDevice7_DrawPrimitive(device, D3DPT_TRIANGLELIST,
            D3DFVF_TLVERTEX, vertices, 3, 0);
    if (FAILED(result)) return fail(window, "DrawPrimitive", result);
    result = IDirect3DDevice7_EndScene(device);
    if (FAILED(result)) return fail(window, "EndScene", result);
    result = IDirectDrawSurface7_Flip(target, NULL, DDFLIP_WAIT);
    if (FAILED(result)) return fail(window, "Flip", result);
    SetWindowTextA(window, "PASS Direct3D 7 WebGPU triangle");

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
