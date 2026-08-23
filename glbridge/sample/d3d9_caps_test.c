// D3D9 Shader Model 3 and 3DMark06 format-capability regression test.
//
// The first four CheckDeviceFormat calls below are the exact combinations
// issued by 3DMark06 during its startup check. The remaining probes cover the
// complete floating-point format family exposed by this proxy. Keeping them in
// a CRT-free XP executable means a newly built proxy can be verified in the
// same guest without relying on 3DMark's generic shader-capability dialog.

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <d3d9.h>

static HRESULT fail(const char *stage, HRESULT hr)
{
    char line[224];

    wsprintfA(line, "[d3d9-caps] %s -> 0x%08lX\r\n", stage,
            (unsigned long)hr);
    OutputDebugStringA(line);
    return FAILED(hr) ? hr : E_FAIL;
}

static HRESULT require_format(IDirect3D9 *d3d, D3DFORMAT adapter_format,
        DWORD usage, D3DRESOURCETYPE type, D3DFORMAT format,
        const char *stage)
{
    HRESULT hr = IDirect3D9_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, adapter_format, usage, type, format);

    return FAILED(hr) ? fail(stage, hr) : D3D_OK;
}

static int run_test(HINSTANCE instance, HINSTANCE previous, LPSTR command_line,
        int show_command)
{
    IDirect3D9 *d3d;
    D3DDISPLAYMODE mode;
    D3DCAPS9 caps;
    DWORD quality_levels = 0;
    HRESULT hr;

    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show_command;

    d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d)
        return (int)fail("Direct3DCreate9", E_FAIL);

    ZeroMemory(&mode, sizeof(mode));
    hr = IDirect3D9_GetAdapterDisplayMode(d3d, D3DADAPTER_DEFAULT, &mode);
    if (FAILED(hr)) {
        IDirect3D9_Release(d3d);
        return (int)fail("GetAdapterDisplayMode", hr);
    }

    ZeroMemory(&caps, sizeof(caps));
    hr = IDirect3D9_GetDeviceCaps(d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, &caps);
    if (FAILED(hr) || caps.VertexShaderVersion < D3DVS_VERSION(3, 0)
            || caps.PixelShaderVersion < D3DPS_VERSION(3, 0)
            || caps.MaxVertexShader30InstructionSlots < 512
            || caps.MaxPixelShader30InstructionSlots < 512
            || caps.MaxUserClipPlanes < 6
            || !(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP)
            || !caps.VertexTextureFilterCaps) {
        IDirect3D9_Release(d3d);
        return (int)fail("GetDeviceCaps(SM3)", FAILED(hr) ? hr : E_FAIL);
    }

    hr = require_format(d3d, mode.Format, D3DUSAGE_QUERY_WRAPANDMIP,
            D3DRTYPE_TEXTURE, D3DFMT_A16B16G16R16F,
            "A16B16G16R16F texture wrap/mip query");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format,
                D3DUSAGE_RENDERTARGET | D3DUSAGE_QUERY_FILTER
                | D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING,
                D3DRTYPE_TEXTURE, D3DFMT_A16B16G16R16F,
                "A16B16G16R16F HDR render-target/filter query");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format,
                D3DUSAGE_RENDERTARGET
                | D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING,
                D3DRTYPE_TEXTURE, D3DFMT_A16B16G16R16F,
                "A16B16G16R16F HDR blend query");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format,
                D3DUSAGE_QUERY_WRAPANDMIP | D3DUSAGE_QUERY_FILTER,
                D3DRTYPE_CUBETEXTURE, D3DFMT_A16B16G16R16,
                "A16B16G16R16 cube wrap/mip/filter query");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, 0, D3DRTYPE_TEXTURE,
                D3DFMT_R16F, "R16F sampled texture");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, D3DUSAGE_RENDERTARGET,
                D3DRTYPE_TEXTURE, D3DFMT_R16F, "R16F render target");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, 0, D3DRTYPE_TEXTURE,
                D3DFMT_G16R16F, "G16R16F sampled texture");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, D3DUSAGE_RENDERTARGET,
                D3DRTYPE_TEXTURE, D3DFMT_G16R16F, "G16R16F render target");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, 0, D3DRTYPE_TEXTURE,
                D3DFMT_R32F, "R32F sampled texture");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, D3DUSAGE_RENDERTARGET,
                D3DRTYPE_TEXTURE, D3DFMT_R32F, "R32F render target");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, 0, D3DRTYPE_TEXTURE,
                D3DFMT_G32R32F, "G32R32F sampled texture");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, D3DUSAGE_RENDERTARGET,
                D3DRTYPE_TEXTURE, D3DFMT_G32R32F, "G32R32F render target");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, 0, D3DRTYPE_TEXTURE,
                D3DFMT_A32B32G32R32F,
                "A32B32G32R32F sampled texture");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, D3DUSAGE_RENDERTARGET,
                D3DRTYPE_TEXTURE, D3DFMT_A32B32G32R32F,
                "A32B32G32R32F render target");
    if (SUCCEEDED(hr))
        hr = require_format(d3d, mode.Format, 0, D3DRTYPE_VOLUMETEXTURE,
                D3DFMT_A8R8G8B8, "A8R8G8B8 volume texture");
    if (SUCCEEDED(hr)) {
        hr = IDirect3D9_CheckDeviceMultiSampleType(d3d,
                D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, mode.Format, TRUE,
                D3DMULTISAMPLE_4_SAMPLES, &quality_levels);
        if (FAILED(hr) || quality_levels != 1)
            hr = fail("four-sample MSAA with quality level zero",
                    FAILED(hr) ? hr : E_FAIL);
    }

    IDirect3D9_Release(d3d);
    if (SUCCEEDED(hr))
        OutputDebugStringA("[d3d9-caps] SM3/HDR/MSAA/volume probes: PASS\r\n");
    return FAILED(hr) ? (int)hr : 0;
}

void WINAPI WinMainCRTStartup(void)
{
    int result = run_test(GetModuleHandleA(NULL), NULL, NULL, SW_SHOWDEFAULT);
    ExitProcess((UINT)result);
}
