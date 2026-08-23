// Direct3D 9 higher-order primitive test for the v86 WebGPU bridge.
//
// WebGPU has no tessellation stage, so DrawRectPatch, DrawTriPatch and the
// N-patch path all evaluate their surfaces in the guest DLL and draw the
// result as an ordinary indexed triangle list. That means none of them can be
// checked by the host-side JS suites -- by the time anything crosses the wire
// it is plain geometry with nothing left to say it came from a patch.
//
// This test draws each of the three in its own viewport. What it checks
// without a human looking is the part that can be checked from inside the
// process:
//
//   - every call returns D3D_OK, so a refusal shows up as a failure rather
//     than as a silently empty viewport;
//   - D3DCAPS9 actually advertises RTPATCHES, RTPATCHHANDLEZERO and NPATCHES,
//     so a device that claims patches and then refuses them fails here;
//   - GetNPatchMode reads back what SetNPatchMode was given;
//   - a B-spline basis is *refused*, not quietly drawn as Bezier, which would
//     put a smooth surface in the wrong place.
//
// The geometry itself still needs eyes. The two Bezier control nets are planar
// and evenly spaced, so a correct evaluation reproduces the flat quad and
// triangle they describe -- a wrong basis or a transposed control net visibly
// bulges or folds them. The N-patch viewport draws the same triangle twice,
// flat and then tessellated, and the tessellated one is visibly rounder.
//
// Build for Windows XP as documented in ../d3d9proxy/README.md.

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <d3d9.h>

#define TEST_CLIENT_WIDTH  640
#define TEST_CLIENT_HEIGHT 480

typedef struct PatchVertex
{
    FLOAT x, y, z;
    FLOAT nx, ny, nz;
    DWORD color;
} PatchVertex;

static const char g_window_class[] = "V86GLD3D9PatchTest";

/* A flat 4x4 Bezier control net spanning the unit square at z = 0. Evaluating
 * a Bezier surface over a planar, evenly spaced net must reproduce the plane,
 * which is what makes this net a checkable case rather than just a pretty one. */
static PatchVertex g_rect_control[16];
/* A flat cubic triangular net: 10 control points over a triangle at z = 0. */
static PatchVertex g_tri_control[10];
/* Two triangles sharing an edge, with normals fanned outward so PN
 * tessellation has something to curve. */
static const PatchVertex g_npatch_mesh[] =
{
    { -1.0f, -1.0f, 0.0f,  -0.4f, -0.4f, 0.82f, D3DCOLOR_XRGB(255, 200, 120) },
    {  1.0f, -1.0f, 0.0f,   0.4f, -0.4f, 0.82f, D3DCOLOR_XRGB(120, 255, 200) },
    {  0.0f,  1.0f, 0.0f,   0.0f,  0.5f, 0.87f, D3DCOLOR_XRGB(200, 120, 255) },
};

static const D3DVERTEXELEMENT9 g_declaration[] =
{
    { 0,  0, D3DDECLTYPE_FLOAT3,   D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_POSITION, 0 },
    { 0, 12, D3DDECLTYPE_FLOAT3,   D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_NORMAL,   0 },
    { 0, 24, D3DDECLTYPE_D3DCOLOR, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_COLOR,    0 },
    D3DDECL_END()
};

static IDirect3D9 *g_d3d;
static IDirect3DDevice9 *g_device;
static IDirect3DVertexDeclaration9 *g_decl;
static IDirect3DVertexBuffer9 *g_rect_buffer;
static IDirect3DVertexBuffer9 *g_tri_buffer;
static IDirect3DVertexBuffer9 *g_mesh_buffer;
static HWND g_window;
static const char *g_stage = "unknown stage";
static int g_failures;

static void trace_text(const char *text)
{
    OutputDebugStringA("[d3d9-patch] ");
    OutputDebugStringA(text);
    OutputDebugStringA("\r\n");
}

static void check(const char *stage, HRESULT hr)
{
    char line[192];
    g_stage = stage;
    if (SUCCEEDED(hr)) return;
    ++g_failures;
    wsprintfA(line, "[d3d9-patch] %s -> 0x%08lX\r\n", stage,
            (unsigned long)hr);
    OutputDebugStringA(line);
}

static void set_identity(D3DMATRIX *matrix)
{
    ZeroMemory(matrix, sizeof(*matrix));
    matrix->_11 = matrix->_22 = matrix->_33 = matrix->_44 = 1.0f;
}

static void build_control_nets(void)
{
    int row, column, index = 0;

    /* 4x4 evenly spaced control points over [-1,1] squared, all at z = 0. */
    for (row = 0; row < 4; ++row)
    {
        for (column = 0; column < 4; ++column)
        {
            PatchVertex *v = &g_rect_control[row * 4 + column];
            v->x = -1.0f + (2.0f / 3.0f) * (FLOAT)column;
            v->y = -1.0f + (2.0f / 3.0f) * (FLOAT)row;
            v->z = 0.0f;
            v->nx = 0.0f; v->ny = 0.0f; v->nz = 1.0f;
            v->color = D3DCOLOR_XRGB(60 + column * 60, 60 + row * 60, 200);
        }
    }
    /* The cubic triangular net, laid out row by row the way D3D9 reads it:
     * 4 points, then 3, then 2, then 1. */
    for (row = 0; row < 4; ++row)
    {
        for (column = 0; column + row < 4; ++column)
        {
            PatchVertex *v = &g_tri_control[index++];
            v->x = -1.0f + (2.0f / 3.0f) * (FLOAT)column;
            v->y = -1.0f + (2.0f / 3.0f) * (FLOAT)row;
            v->z = 0.0f;
            v->nx = 0.0f; v->ny = 0.0f; v->nz = 1.0f;
            v->color = D3DCOLOR_XRGB(200, 60 + column * 60, 60 + row * 60);
        }
    }
}

static HRESULT upload(IDirect3DVertexBuffer9 **buffer, const void *data,
        UINT bytes)
{
    void *bits;
    HRESULT hr = IDirect3DDevice9_CreateVertexBuffer(g_device, bytes, 0, 0,
            D3DPOOL_MANAGED, buffer, NULL);
    if (FAILED(hr)) return hr;
    hr = IDirect3DVertexBuffer9_Lock(*buffer, 0, bytes, &bits, 0);
    if (FAILED(hr)) return hr;
    CopyMemory(bits, data, bytes);
    IDirect3DVertexBuffer9_Unlock(*buffer);
    return D3D_OK;
}

static void set_viewport(DWORD x, DWORD y, DWORD width, DWORD height)
{
    D3DVIEWPORT9 viewport;
    viewport.X = x;
    viewport.Y = y;
    viewport.Width = width;
    viewport.Height = height;
    viewport.MinZ = 0.0f;
    viewport.MaxZ = 1.0f;
    IDirect3DDevice9_SetViewport(g_device, &viewport);
}

static HRESULT render(HWND hwnd)
{
    D3DPRESENT_PARAMETERS present;
    D3DCAPS9 caps;
    D3DMATRIX identity;
    D3DRECTPATCH_INFO rect_info;
    D3DTRIPATCH_INFO tri_info;
    float segments[4] = { 8.0f, 8.0f, 8.0f, 8.0f };
    HRESULT hr;

    build_control_nets();

    g_stage = "Direct3DCreate9";
    g_d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!g_d3d) { check("Direct3DCreate9", E_FAIL); return E_FAIL; }

    ZeroMemory(&present, sizeof(present));
    present.Windowed = TRUE;
    present.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present.BackBufferFormat = D3DFMT_UNKNOWN;
    present.hDeviceWindow = hwnd;
    hr = IDirect3D9_CreateDevice(g_d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present, &g_device);
    check("CreateDevice", hr);
    if (FAILED(hr)) return hr;

    /* The caps have to agree with what the calls below actually do; a device
     * that advertises patches and then refuses them is the failure this
     * catches. */
    hr = IDirect3DDevice9_GetDeviceCaps(g_device, &caps);
    check("GetDeviceCaps", hr);
    if (!(caps.DevCaps & D3DDEVCAPS_RTPATCHES))
        check("caps claim D3DDEVCAPS_RTPATCHES", E_FAIL);
    if (!(caps.DevCaps & D3DDEVCAPS_RTPATCHHANDLEZERO))
        check("caps claim D3DDEVCAPS_RTPATCHHANDLEZERO", E_FAIL);
    if (!(caps.DevCaps & D3DDEVCAPS_NPATCHES))
        check("caps claim D3DDEVCAPS_NPATCHES", E_FAIL);

    hr = IDirect3DDevice9_CreateVertexDeclaration(g_device, g_declaration,
            &g_decl);
    check("CreateVertexDeclaration", hr);
    check("upload rect control net",
            upload(&g_rect_buffer, g_rect_control, sizeof(g_rect_control)));
    check("upload tri control net",
            upload(&g_tri_buffer, g_tri_control, sizeof(g_tri_control)));
    check("upload npatch mesh",
            upload(&g_mesh_buffer, g_npatch_mesh, sizeof(g_npatch_mesh)));
    if (g_failures) return E_FAIL;

    set_identity(&identity);
    IDirect3DDevice9_SetTransform(g_device, D3DTS_WORLD, &identity);
    IDirect3DDevice9_SetTransform(g_device, D3DTS_VIEW, &identity);
    IDirect3DDevice9_SetTransform(g_device, D3DTS_PROJECTION, &identity);
    IDirect3DDevice9_SetRenderState(g_device, D3DRS_LIGHTING, FALSE);
    IDirect3DDevice9_SetRenderState(g_device, D3DRS_CULLMODE, D3DCULL_NONE);
    IDirect3DDevice9_SetVertexDeclaration(g_device, g_decl);

    hr = IDirect3DDevice9_Clear(g_device, 0, NULL, D3DCLEAR_TARGET,
            D3DCOLOR_XRGB(16, 16, 32), 1.0f, 0);
    check("Clear", hr);
    hr = IDirect3DDevice9_BeginScene(g_device);
    check("BeginScene", hr);

    /* 1. A rectangular Bezier patch over the flat 4x4 net. */
    set_viewport(0, 0, TEST_CLIENT_WIDTH / 3, TEST_CLIENT_HEIGHT);
    IDirect3DDevice9_SetStreamSource(g_device, 0, g_rect_buffer, 0,
            sizeof(PatchVertex));
    rect_info.StartVertexOffsetWidth = 0;
    rect_info.StartVertexOffsetHeight = 0;
    rect_info.Width = 4;
    rect_info.Height = 4;
    rect_info.Stride = 4;
    rect_info.Basis = D3DBASIS_BEZIER;
    rect_info.Degree = D3DDEGREE_CUBIC;
    check("DrawRectPatch",
            IDirect3DDevice9_DrawRectPatch(g_device, 0, segments, &rect_info));

    /* 2. A triangular Bezier patch over the flat 10-point net. */
    set_viewport(TEST_CLIENT_WIDTH / 3, 0, TEST_CLIENT_WIDTH / 3,
            TEST_CLIENT_HEIGHT);
    IDirect3DDevice9_SetStreamSource(g_device, 0, g_tri_buffer, 0,
            sizeof(PatchVertex));
    tri_info.StartVertexOffset = 0;
    tri_info.NumVertices = 10;
    tri_info.Basis = D3DBASIS_BEZIER;
    tri_info.Degree = D3DDEGREE_CUBIC;
    check("DrawTriPatch",
            IDirect3DDevice9_DrawTriPatch(g_device, 0, segments, &tri_info));

    /* 3. N-patch tessellation of an ordinary triangle draw. The same draw runs
     * twice, once flat and once tessellated, so a refusal or a silent no-op is
     * distinguishable from working tessellation. */
    set_viewport(2 * (TEST_CLIENT_WIDTH / 3), 0, TEST_CLIENT_WIDTH / 3,
            TEST_CLIENT_HEIGHT);
    IDirect3DDevice9_SetStreamSource(g_device, 0, g_mesh_buffer, 0,
            sizeof(PatchVertex));
    check("DrawPrimitive (flat control)",
            IDirect3DDevice9_DrawPrimitive(g_device, D3DPT_TRIANGLELIST, 0, 1));
    check("SetNPatchMode(6)",
            IDirect3DDevice9_SetNPatchMode(g_device, 6.0f));
    if (IDirect3DDevice9_GetNPatchMode(g_device) < 5.9f)
        check("GetNPatchMode reads back what was set", E_FAIL);
    check("DrawPrimitive (N-patch)",
            IDirect3DDevice9_DrawPrimitive(g_device, D3DPT_TRIANGLELIST, 0, 1));
    check("SetNPatchMode(0)",
            IDirect3DDevice9_SetNPatchMode(g_device, 0.0f));

    /* A basis this profile does not evaluate must be refused, not silently
     * drawn as Bezier -- that would put a smooth surface in the wrong place. */
    rect_info.Basis = D3DBASIS_BSPLINE;
    if (SUCCEEDED(IDirect3DDevice9_DrawRectPatch(g_device, 0, segments,
            &rect_info)))
        check("B-spline basis is refused rather than drawn as Bezier", E_FAIL);

    check("EndScene", IDirect3DDevice9_EndScene(g_device));
    check("Present",
            IDirect3DDevice9_Present(g_device, NULL, NULL, NULL, NULL));
    if (!g_failures) g_stage = "all checks passed";
    return g_failures ? E_FAIL : D3D_OK;
}

static void release_d3d9(void)
{
    if (g_mesh_buffer) { IDirect3DVertexBuffer9_Release(g_mesh_buffer); g_mesh_buffer = NULL; }
    if (g_tri_buffer) { IDirect3DVertexBuffer9_Release(g_tri_buffer); g_tri_buffer = NULL; }
    if (g_rect_buffer) { IDirect3DVertexBuffer9_Release(g_rect_buffer); g_rect_buffer = NULL; }
    if (g_decl) { IDirect3DVertexDeclaration9_Release(g_decl); g_decl = NULL; }
    if (g_device) { IDirect3DDevice9_Release(g_device); g_device = NULL; }
    if (g_d3d) { IDirect3D9_Release(g_d3d); g_d3d = NULL; }
}

static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam,
        LPARAM lparam)
{
    if (message == WM_DESTROY)
    {
        g_window = NULL;
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
    char title[192];

    ZeroMemory(&window_class, sizeof(window_class));
    window_class.style = CS_OWNDC;
    window_class.lpfnWndProc = window_proc;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursorA(NULL, IDC_ARROW);
    window_class.lpszClassName = g_window_class;
    if (!RegisterClassA(&window_class)) { trace_text("RegisterClass failed"); return 1; }

    SetRect(&window_rect, 0, 0, TEST_CLIENT_WIDTH, TEST_CLIENT_HEIGHT);
    AdjustWindowRect(&window_rect, WS_OVERLAPPEDWINDOW, FALSE);
    hwnd = CreateWindowA(g_window_class, "D3D9 patches: starting",
            WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
            window_rect.right - window_rect.left,
            window_rect.bottom - window_rect.top,
            NULL, NULL, instance, NULL);
    if (!hwnd) { trace_text("CreateWindow failed"); return 2; }

    g_window = hwnd;
    ShowWindow(hwnd, show_command);
    UpdateWindow(hwnd);

    hr = render(hwnd);
    wsprintfA(title, "D3D9 patches: %s (%ld failure(s), 0x%08lX)",
            g_stage, (long)g_failures, (unsigned long)hr);
    SetWindowTextA(hwnd, title);
    trace_text(title);

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
