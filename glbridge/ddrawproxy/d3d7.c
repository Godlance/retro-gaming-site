/*
 * d3d7.c — Direct3D 7 support for v86 ddraw bridge
 *
 * DX6-era games access D3D7 through IDirectDraw7::QueryInterface
 * with IID_IDirect3D7, then create a D3DDevice7 and render.
 *
 * This is a minimal implementation supporting the fixed-function
 * pipeline: vertex buffers, textures, render states, zbuffer.
 */

#include <stdint.h>
#include <windows.h>
#include <ddraw.h>
#include <d3d.h>

#include "ddraw_bridge.h"
#include "ddraw_internal.h"

/* ── IDirect3D7 implementation ────────────────────────────────── */

struct d3d7_impl {
    void **vtable;
    LONG   refcount;
};

static HRESULT WINAPI d3d7_QueryInterface(void *, REFIID, void **);
static ULONG   WINAPI d3d7_AddRef(void *);
static ULONG   WINAPI d3d7_Release(void *);
static HRESULT WINAPI d3d7_CreateDevice(void *, REFIID, LPDIRECTDRAWSURFACE7,
                                          LPDIRECT3DDEVICE7 *);
static HRESULT WINAPI d3d7_EnumZBufferFormats(void *, REFIID, LPD3DENUMPIXELFORMATSCALLBACK,
                                                LPVOID);

static void *d3d7_vtable[] = {
    (void *)d3d7_QueryInterface,
    (void *)d3d7_AddRef,
    (void *)d3d7_Release,
    (void *)d3d7_CreateDevice,
    (void *)d3d7_EnumZBufferFormats,
};

/* ── IDirect3DDevice7 implementation ──────────────────────────── */

struct d3ddev7_impl {
    void **vtable;
    LONG   refcount;
    uint32_t handle;                 /* bridge handle */
    uint32_t rt_handle;              /* render target surface handle */
    uint32_t zbuf_handle;            /* z-buffer surface handle (0 = none) */
};

static HRESULT WINAPI dev7_QueryInterface(void *, REFIID, void **);
static ULONG   WINAPI dev7_AddRef(void *);
static ULONG   WINAPI dev7_Release(void *);
static HRESULT WINAPI dev7_SetRenderTarget(void *, LPDIRECTDRAWSURFACE7, DWORD);
static HRESULT WINAPI dev7_Clear(void *, DWORD, LPD3DRECT, DWORD, D3DCOLOR, D3DVALUE, DWORD);
static HRESULT WINAPI dev7_BeginScene(void *);
static HRESULT WINAPI dev7_EndScene(void *);
static HRESULT WINAPI dev7_DrawIndexedPrimitive(void *, D3DPRIMITIVETYPE, D3DVERTEX *,
                                                  DWORD, WORD *, DWORD, DWORD);
static HRESULT WINAPI dev7_DrawPrimitive(void *, D3DPRIMITIVETYPE, D3DVERTEX *,
                                           DWORD, DWORD);
static HRESULT WINAPI dev7_SetMaterial(void *, LPD3DMATERIAL7);
static HRESULT WINAPI dev7_SetLight(void *, DWORD, LPD3DLIGHT7);
static HRESULT WINAPI dev7_LightEnable(void *, DWORD, BOOL);
static HRESULT WINAPI dev7_SetTexture(void *, DWORD, LPDIRECTDRAWSURFACE7);
static HRESULT WINAPI dev7_SetRenderState(void *, D3DRENDERSTATETYPE, D3DVALUE);
static HRESULT WINAPI dev7_SetTextureStageState(void *, DWORD, D3DTEXTURESTAGESTATETYPE,
                                                  DWORD);
static HRESULT WINAPI dev7_SetViewport(void *, LPD3DVIEWPORT7);
static HRESULT WINAPI dev7_SetTransform(void *, D3DTRANSFORMSTATETYPE, LPD3DMATRIX);
static HRESULT WINAPI dev7_GetRenderState(void *, D3DRENDERSTATETYPE, LPD3DVALUE);
static HRESULT WINAPI dev7_GetTextureStageState(void *, DWORD, D3DTEXTURESTAGESTATETYPE,
                                                  LPDWORD);
static HRESULT WINAPI dev7_GetViewport(void *, LPD3DVIEWPORT7);
static HRESULT WINAPI dev7_GetTransform(void *, D3DTRANSFORMSTATETYPE, LPD3DMATRIX);
static HRESULT WINAPI dev7_LightElements(void *, DWORD, LPD3DLIGHT7 *);
static HRESULT WINAPI dev7_ValidateDevice(void *, LPDWORD);
static HRESULT WINAPI dev7_ApplyStateBlock(void *, DWORD);

/* Stubs for vtable entries needed by MinGW's Direct3D device layout */
static HRESULT WINAPI dev7_GetRenderTarget(void *, LPDIRECTDRAWSURFACE7 *, DWORD *)
{
    return DD_OK;
}
static HRESULT WINAPI dev7_MultiplyTransform(void *, D3DTRANSFORMSTATETYPE, LPD3DMATRIX)
{
    return DD_OK;
}

static void *dev7_vtable[] = {
    (void *)dev7_QueryInterface, (void *)dev7_AddRef, (void *)dev7_Release,
    (void *)dev7_SetRenderTarget, (void *)dev7_GetRenderTarget, /* stub for now */
    (void *)dev7_Clear, (void *)dev7_BeginScene, (void *)dev7_EndScene,
    (void *)dev7_DrawIndexedPrimitive, (void *)dev7_DrawPrimitive,
    (void *)dev7_SetMaterial, (void *)dev7_SetLight, (void *)dev7_LightEnable,
    (void *)dev7_SetTexture, (void *)dev7_SetRenderState,
    (void *)dev7_SetTextureStageState, (void *)dev7_SetTransform,
    (void *)dev7_SetViewport, (void *)dev7_MultiplyTransform, /* stub */
    (void *)dev7_GetRenderState, (void *)dev7_GetTextureStageState,
    (void *)dev7_GetViewport, (void *)dev7_GetTransform,
    (void *)dev7_LightElements, (void *)dev7_ValidateDevice,
    (void *)dev7_ApplyStateBlock,
};

/* ── Implementation ────────────────────────────────────────────── */

static struct d3d7_impl *d3d7_alloc(void)
{
    struct d3d7_impl *d = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*d));
    if (d) { d->vtable = d3d7_vtable; d->refcount = 1; }
    return d;
}

static struct d3ddev7_impl *d3ddev7_alloc(uint32_t handle)
{
    struct d3ddev7_impl *d = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*d));
    if (d) { d->vtable = dev7_vtable; d->refcount = 1; d->handle = handle; }
    return d;
}

/* ── IDirect3D7 methods ──────────────────────────────────────── */

static HRESULT WINAPI d3d7_QueryInterface(void *self, REFIID riid, void **obj)
{
    if (!obj) return DDERR_INVALIDPARAMS;
    *obj = NULL;
    if (IsEqualGUID(riid, &IID_IDirect3D7) || IsEqualGUID(riid, &IID_IUnknown)) {
        *obj = self; d3d7_AddRef(self); return DD_OK;
    }
    return DDERR_NOINTERFACE;
}

static ULONG WINAPI d3d7_AddRef(void *self)
{
    return InterlockedIncrement(&((struct d3d7_impl *)self)->refcount);
}

static ULONG WINAPI d3d7_Release(void *self)
{
    struct d3d7_impl *d = (struct d3d7_impl *)self;
    if (InterlockedDecrement(&d->refcount) == 0) {
        HeapFree(GetProcessHeap(), 0, d);
    }
    return 0;
}

static HRESULT WINAPI d3d7_CreateDevice(void *self, REFIID riid,
                                          LPDIRECTDRAWSURFACE7 surface,
                                          LPDIRECT3DDEVICE7 *device)
{
    if (!device || !surface) return DDERR_INVALIDPARAMS;
    *device = NULL;

    if (!IsEqualGUID(riid, &IID_IDirect3DHALDevice) &&
        !IsEqualGUID(riid, &IID_IDirect3DMMXDevice) &&
        !IsEqualGUID(riid, &IID_IDirect3DTnLHalDevice)) {
        return DDERR_NOINTERFACE;
    }

    uint32_t handle = alloc_handle();
    uint32_t surf_handle = ((struct surface7_impl *)surface)->handle;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_CREATE_DEVICE;
    slot.surface = handle;
    slot.param1  = (int32_t)surf_handle;
    int ret = bridge_call(&slot);

    if (ret == DD_OK) {
        *device = (LPDIRECT3DDEVICE7)d3ddev7_alloc(handle);
        if (*device) {
            ((struct d3ddev7_impl *)*device)->rt_handle = surf_handle;
        } else {
            return DDERR_OUTOFMEMORY;
        }
    }
    return ret;
}

static HRESULT WINAPI d3d7_EnumZBufferFormats(void *self, REFIID riid,
                                                LPD3DENUMPIXELFORMATSCALLBACK cb, LPVOID ctx)
{
    if (!cb) return DDERR_INVALIDPARAMS;
    /* Advertise 16-bit zbuffer — DX6 games use this most */
    DDPIXELFORMAT pf = {0};
    pf.dwSize = sizeof(pf);
    pf.dwFlags = DDPF_ZBUFFER | DDPF_ZPIXELS;
    pf.dwZBufferBitDepth = 16;
    pf.dwZBitMask = 0xFFFF;  /* 16-bit depth */
    pf.dwStencilBitDepth = 0;
    cb(&pf, ctx);
    /* Also 24/8 stencil */
    pf.dwZBufferBitDepth = 32;
    pf.dwZBitMask = 0xFFFFFF00;
    pf.dwStencilBitDepth = 8;
    cb(&pf, ctx);
    return DD_OK;
}

/* ── IDirect3DDevice7 methods ────────────────────────────────── */

static HRESULT WINAPI dev7_QueryInterface(void *self, REFIID riid, void **obj)
{
    if (!obj) return DDERR_INVALIDPARAMS;
    *obj = NULL;
    if (IsEqualGUID(riid, &IID_IDirect3DDevice7) || IsEqualGUID(riid, &IID_IUnknown)) {
        *obj = self; dev7_AddRef(self); return DD_OK;
    }
    return DDERR_NOINTERFACE;
}

static ULONG WINAPI dev7_AddRef(void *self)
{
    return InterlockedIncrement(&((struct d3ddev7_impl *)self)->refcount);
}

static ULONG WINAPI dev7_Release(void *self)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    if (InterlockedDecrement(&d->refcount) == 0) {
        BridgeSlot slot = {0};
        slot.type = BRIDGE_CMD_D3D_DESTROY_DEVICE;
        slot.surface = d->handle;
        bridge_call(&slot);
        HeapFree(GetProcessHeap(), 0, d);
    }
    return 0;
}

static HRESULT WINAPI dev7_SetRenderTarget(void *self, LPDIRECTDRAWSURFACE7 surf,
                                             DWORD flags)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    uint32_t surf_handle = surf ? ((struct surface7_impl *)surf)->handle : 0;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_RENDER_TARGET;
    slot.surface = d->handle;
    slot.param1  = (int32_t)surf_handle;
    int ret = bridge_call(&slot);
    if (ret == DD_OK) d->rt_handle = surf_handle;
    return ret;
}

static HRESULT WINAPI dev7_Clear(void *self, DWORD rect_count, LPD3DRECT rects,
                                  DWORD flags, D3DCOLOR color, D3DVALUE z, DWORD stencil)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_CLEAR;
    slot.surface = d->handle;
    slot.param1  = (int32_t)flags;
    slot.param2  = (int32_t)color;
    slot.param3  = *(int32_t *)&z;  /* reinterpret float bits */
    slot.param4  = (int32_t)stencil;

    /* Pack rects into payload (up to 4 rects in 32 bytes) */
    if (rects && rect_count > 0) {
        memcpy(slot.payload, rects, min(rect_count, 4) * sizeof(D3DRECT));
    }
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_BeginScene(void *self)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_BEGIN_SCENE;
    slot.surface = d->handle;
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_EndScene(void *self)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_END_SCENE;
    slot.surface = d->handle;
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_DrawIndexedPrimitive(void *self, D3DPRIMITIVETYPE type,
                                                  D3DVERTEX *vertices, DWORD vcount,
                                                  WORD *indices, DWORD icount, DWORD flags)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;

    BridgeD3DDrawParams dp = {0};
    dp.primitive_type = (uint32_t)type;
    dp.vertex_count   = vcount;
    dp.index_count    = icount;
    dp.vertex_stride  = sizeof(D3DVERTEX);

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_DRAW_INDEXED;
    slot.surface = d->handle;
    slot.param1  = (int32_t)flags;
    memcpy(slot.payload, &dp, sizeof(dp));
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_DrawPrimitive(void *self, D3DPRIMITIVETYPE type,
                                          D3DVERTEX *vertices, DWORD vcount, DWORD flags)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;

    BridgeD3DDrawParams dp = {0};
    dp.primitive_type = (uint32_t)type;
    dp.vertex_count   = vcount;
    dp.vertex_stride  = sizeof(D3DVERTEX);

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_DRAW_PRIMITIVE;
    slot.surface = d->handle;
    slot.param1  = (int32_t)flags;
    memcpy(slot.payload, &dp, sizeof(dp));
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_SetMaterial(void *self, LPD3DMATERIAL7 mat)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_MATERIAL;
    slot.surface = d->handle;
    if (mat) memcpy(slot.payload, mat, sizeof(D3DMATERIAL7));
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_SetLight(void *self, DWORD index, LPD3DLIGHT7 light)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_LIGHT;
    slot.surface = d->handle;
    slot.param1  = (int32_t)index;
    if (light) memcpy(slot.payload, light, sizeof(D3DLIGHT7));
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_LightEnable(void *self, DWORD index, BOOL enable)
{
    return DD_OK;  /* Lights are a nice-to-have for DX6 games */
}

static HRESULT WINAPI dev7_SetTexture(void *self, DWORD stage,
                                       LPDIRECTDRAWSURFACE7 tex)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    uint32_t tex_handle = tex ? ((struct surface7_impl *)tex)->handle : 0;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_TEXTURE;
    slot.surface = d->handle;
    slot.param1  = (int32_t)stage;
    slot.param2  = (int32_t)tex_handle;
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_SetRenderState(void *self, D3DRENDERSTATETYPE state,
                                            D3DVALUE value)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;

    BridgeD3DRenderStateParams rp = {0};
    rp.state = (uint32_t)state;
    rp.value = *(int32_t *)&value;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_RENDER_STATE;
    slot.surface = d->handle;
    memcpy(slot.payload, &rp, sizeof(rp));
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_SetTextureStageState(void *self, DWORD stage,
                                                  D3DTEXTURESTAGESTATETYPE type,
                                                  DWORD value)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;

    BridgeD3DRenderStateParams rp = {0};
    rp.state = (uint32_t)type;
    rp.stage = stage;
    rp.value = (int32_t)value;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_TEXTURE_STAGE;
    slot.surface = d->handle;
    memcpy(slot.payload, &rp, sizeof(rp));
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_SetViewport(void *self, LPD3DVIEWPORT7 vp)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_VIEWPORT;
    slot.surface = d->handle;
    if (vp) memcpy(slot.payload, vp, sizeof(D3DVIEWPORT7));
    return bridge_call(&slot);
}

static HRESULT WINAPI dev7_SetTransform(void *self, D3DTRANSFORMSTATETYPE type,
                                          LPD3DMATRIX mat)
{
    struct d3ddev7_impl *d = (struct d3ddev7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_D3D_SET_TRANSFORM;
    slot.surface = d->handle;
    slot.param1  = (int32_t)type;
    if (mat) memcpy(slot.payload, mat, sizeof(D3DMATRIX));
    return bridge_call(&slot);
}

/* ── Stubs ──────────────────────────────────────────────────────── */

static HRESULT WINAPI dev7_GetRenderState(void *self, D3DRENDERSTATETYPE s, LPD3DVALUE v)
{
    if (v) *v = 0; return DD_OK;
}
static HRESULT WINAPI dev7_GetTextureStageState(void *self, DWORD s, D3DTEXTURESTAGESTATETYPE t, LPDWORD v)
{
    if (v) *v = 0;
    return DD_OK;
}
static HRESULT WINAPI dev7_GetViewport(void *self, LPD3DVIEWPORT7 vp)
{
    return DDERR_INVALIDPARAMS;
}
static HRESULT WINAPI dev7_GetTransform(void *self, D3DTRANSFORMSTATETYPE t, LPD3DMATRIX m)
{
    return DDERR_INVALIDPARAMS;
}
static HRESULT WINAPI dev7_LightElements(void *self, DWORD max, LPD3DLIGHT7 *lights)
{
    if (lights) *lights = NULL; return DD_OK;
}
static HRESULT WINAPI dev7_ValidateDevice(void *self, LPDWORD p)
{
    if (p) *p = 0; return DD_OK;
}
static HRESULT WINAPI dev7_ApplyStateBlock(void *self, DWORD block)
{
    return DD_OK;
}