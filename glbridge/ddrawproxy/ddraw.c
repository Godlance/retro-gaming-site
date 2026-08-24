/*
 * ddraw.c — v86 DirectDraw bridge DLL
 *
 * Implements the core ddraw COM interfaces, translating calls into
 * bridge protocol commands dispatched to JS/WebGL via the v86 ring buffer.
 */

#include <stdint.h>
#include <stdbool.h>
#include <windows.h>
#include <ddraw.h>
#include <d3d.h>

#include "ddraw_bridge.h"
#include "ddraw_internal.h"

/* ── DLL entry point ──────────────────────────────────────────── */

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved)
{
    (void)hinstDLL; (void)lpvReserved;

    if (fdwReason == DLL_PROCESS_ATTACH) {
        bridge_init_ring();
        /* Avoid thread attach/detach overhead */
        DisableThreadLibraryCalls(hinstDLL);
    }
    return TRUE;
}

/* ── COM infrastructure ────────────────────────────────────────── */

#define COM_METHOD(ptr, idx, rettype, ...) \
    ((rettype (*)(void *, ## __VA_ARGS__))((void ***)(ptr))[0][idx])

/* ── Surface handle allocator — simple monotonic counter */

uint32_t alloc_handle(void)
{
    static uint32_t next_handle = 1;
    return next_handle++;
}

/* ── Basic ddraw capabilities exposed to game ────────────────── */

/* ── IDirectDraw7 implementation ─────────────────────────────── */

struct ddraw7_impl {
    void **vtable;
    LONG   refcount;
};

/* Forward declarations of vtable methods */
static HRESULT WINAPI ddraw7_QueryInterface(void *, REFIID, void **);
static ULONG   WINAPI ddraw7_AddRef(void *);
static ULONG   WINAPI ddraw7_Release(void *);
static HRESULT WINAPI ddraw7_SetCooperativeLevel(void *, HWND, DWORD);
static HRESULT WINAPI ddraw7_SetDisplayMode(void *, DWORD, DWORD, DWORD, DWORD, DWORD);
static HRESULT WINAPI ddraw7_GetDisplayMode(void *, LPDDSURFACEDESC2);
static HRESULT WINAPI ddraw7_CreateSurface(void *, LPDDSURFACEDESC2, LPDIRECTDRAWSURFACE7 *, IUnknown *);
static HRESULT WINAPI ddraw7_CreatePalette(void *, DWORD, LPPALETTEENTRY, LPDIRECTDRAWPALETTE *, IUnknown *);
static HRESULT WINAPI ddraw7_CreateClipper(void *, DWORD, LPDIRECTDRAWCLIPPER *, IUnknown *);
static HRESULT WINAPI ddraw7_GetCaps(void *, LPDDCAPS, LPDDCAPS);
static HRESULT WINAPI ddraw7_GetAvailableVidMem(void *, LPDDCAPS, DWORD *, DWORD *);
static HRESULT WINAPI ddraw7_RestoreDisplayMode(void *);
static HRESULT WINAPI ddraw7_WaitForVerticalBlank(void *, DWORD, HANDLE);
static HRESULT WINAPI ddraw7_GetVerticalBlankStatus(void *, BOOL *);
static HRESULT WINAPI ddraw7_EnumDisplayModes(void *, DWORD, LPDDSURFACEDESC2, LPVOID, LPDDENUMMODESCALLBACK2);
static HRESULT WINAPI ddraw7_FlipToGDISurface(void *);
static HRESULT WINAPI ddraw7_GetMonitorFrequency(void *, DWORD *);

/* vtable — matches IDirectDraw7 COM layout */
static void *ddraw7_vtable[] = {
    (void *)ddraw7_QueryInterface,
    (void *)ddraw7_AddRef,
    (void *)ddraw7_Release,
    (void *)ddraw7_SetCooperativeLevel,
    (void *)ddraw7_EnumDisplayModes,
    (void *)ddraw7_SetDisplayMode,
    (void *)ddraw7_GetDisplayMode,
    (void *)ddraw7_GetCaps,
    (void *)ddraw7_RestoreDisplayMode,
    (void *)ddraw7_GetMonitorFrequency,
    (void *)ddraw7_WaitForVerticalBlank,
    (void *)ddraw7_GetVerticalBlankStatus,
    (void *)ddraw7_CreateSurface,
    (void *)ddraw7_CreateClipper,
    (void *)ddraw7_CreatePalette,
    (void *)ddraw7_GetAvailableVidMem,
    (void *)ddraw7_SetCooperativeLevel,   /* reused — no HW cursor needed */
    (void *)ddraw7_FlipToGDISurface,
};

static struct ddraw7_impl *ddraw7_alloc(void)
{
    struct ddraw7_impl *d = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*d));
    if (d) {
        d->vtable = ddraw7_vtable;
        d->refcount = 1;
    }
    return d;
}

static HRESULT WINAPI ddraw7_QueryInterface(void *self, REFIID riid, void **obj)
{
    if (!obj) return DDERR_INVALIDPARAMS;
    *obj = NULL;

    if (IsEqualGUID(riid, &IID_IDirectDraw7) ||
        IsEqualGUID(riid, &IID_IUnknown)) {
        *obj = self;
        ddraw7_AddRef(self);
        return DD_OK;
    }
    /* Also support older IIDs (game might QueryInt for IDirectDraw4, 2, 1) */
    if (IsEqualGUID(riid, &IID_IDirectDraw4) ||
        IsEqualGUID(riid, &IID_IDirectDraw2) ||
        IsEqualGUID(riid, &IID_IDirectDraw)) {
        /* We lie and return the same object — games don't care about
         * interface version differences for basic operations */
        *obj = self;
        ddraw7_AddRef(self);
        return DD_OK;
    }
    return DDERR_NOINTERFACE;
}

static ULONG WINAPI ddraw7_AddRef(void *self)
{
    struct ddraw7_impl *d = (struct ddraw7_impl *)self;
    return InterlockedIncrement(&d->refcount);
}

static ULONG WINAPI ddraw7_Release(void *self)
{
    struct ddraw7_impl *d = (struct ddraw7_impl *)self;
    LONG ref = InterlockedDecrement(&d->refcount);
    if (ref == 0) {
        HeapFree(GetProcessHeap(), 0, d);
    }
    return ref;
}

static HRESULT WINAPI ddraw7_SetCooperativeLevel(void *self, HWND hwnd, DWORD flags)
{
    /* Normal or exclusive — we handle both. Just log it. */
    if (flags & DDSCL_FULLSCREEN) {
        /* DX6 games set this; acknowledge and proceed */
    }
    return DD_OK;
}

static HRESULT WINAPI ddraw7_SetDisplayMode(void *self, DWORD width, DWORD height,
                                              DWORD bpp, DWORD refresh, DWORD flags)
{
    BridgeSlot slot = {0};
    slot.type    = BRIDGE_CMD_SET_DISPLAY_MODE;
    slot.param1  = (int32_t)width;
    slot.param2  = (int32_t)height;
    slot.param3  = (int32_t)bpp;
    slot.param4  = (int32_t)refresh;
    return bridge_call(&slot);
}

static HRESULT WINAPI ddraw7_GetDisplayMode(void *self, LPDDSURFACEDESC2 desc)
{
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_GET_DISPLAY_MODE;
    int ret = bridge_call(&slot);
    if (ret == DD_OK && desc) {
        desc->dwWidth  = (DWORD)slot.param1;
        desc->dwHeight = (DWORD)slot.param2;
        desc->ddpfPixelFormat.dwRGBBitCount = (DWORD)slot.param3;
    }
    return ret;
}

static HRESULT WINAPI ddraw7_CreateSurface(void *self, LPDDSURFACEDESC2 desc,
                                             LPDIRECTDRAWSURFACE7 *surf, IUnknown *outer)
{
    if (!desc || !surf) return DDERR_INVALIDPARAMS;
    *surf = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;

    /* Build surface creation params */
    BridgeCreateSurfaceParams cp = {0};
    cp.width  = desc->dwWidth;
    cp.height = desc->dwHeight;
    cp.pitch  = desc->lPitch;
    cp.flags  = 0;

    uint32_t caps = desc->dwFlags;
    if (caps & DDSCAPS_PRIMARYSURFACE)  cp.flags |= SURF_PRIMARY;
    if (caps & DDSCAPS_OFFSCREENPLAIN)  cp.flags |= SURF_OFFSCREEN_PLAIN;
    if (caps & DDSCAPS_SYSTEMMEMORY)    cp.flags |= SURF_SYSTEM_MEMORY;
    if (caps & DDSCAPS_VIDEOMEMORY)     cp.flags |= SURF_VIDEO_MEMORY;
    if (caps & DDSCAPS_BACKBUFFER)       cp.flags |= SURF_BACK_BUFFER;
    if (caps & DDSCAPS_COMPLEX)          cp.flags |= SURF_COMPLEX;
    if (caps & DDSCAPS_FLIP)             cp.flags |= SURF_FLIP;
    if (caps & DDSCAPS_TEXTURE)          cp.flags |= SURF_TEXTURE;
    if (desc->ddpfPixelFormat.dwRGBBitCount == 8)
        cp.flags |= SURF_INDEXED;
    else if (desc->ddpfPixelFormat.dwRGBBitCount == 16)
        cp.flags |= SURF_16BIT;
    else if (desc->ddpfPixelFormat.dwRGBBitCount == 32)
        cp.flags |= SURF_32BIT;

    uint32_t handle = alloc_handle();

    BridgeSlot slot = {0};
    slot.type    = BRIDGE_CMD_CREATE_SURFACE;
    slot.surface = handle;
    slot.param1  = cp.width;
    slot.param2  = cp.height;
    slot.param3  = (int32_t)cp.pitch ? cp.pitch : cp.width * (desc->ddpfPixelFormat.dwRGBBitCount / 8);
    slot.param4  = (int32_t)cp.flags;
    memcpy(slot.payload, &cp, sizeof(cp));

    int ret = bridge_call(&slot);

    if (ret == DD_OK) {
        /* Allocate surface object and return it */
        *surf = ddraw_surface7_create(handle, &cp);
        if (!*surf) {
            return DDERR_OUTOFMEMORY;
        }
    }

    return ret;
}

static HRESULT WINAPI ddraw7_CreatePalette(void *self, DWORD flags, LPPALETTEENTRY entries,
                                             LPDIRECTDRAWPALETTE *pal, IUnknown *outer)
{
    if (!pal) return DDERR_INVALIDPARAMS;
    *pal = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;

    uint32_t handle = alloc_handle();

    BridgeSlot slot = {0};
    slot.type    = BRIDGE_CMD_CREATE_PALETTE;
    slot.surface = handle;
    slot.param1  = (int32_t)flags;
    /* Copy palette entries into payload (256 entries × 4 bytes = 1024) */
    if (entries) {
        memcpy(slot.payload, entries, sizeof(PALETTEENTRY) * 256);
    }

    int ret = bridge_call(&slot);
    if (ret == DD_OK) {
        *pal = ddraw_palette_create(handle, flags, entries);
        if (!*pal) return DDERR_OUTOFMEMORY;
    }
    return ret;
}

static HRESULT WINAPI ddraw7_CreateClipper(void *self, DWORD flags,
                                            LPDIRECTDRAWCLIPPER *clipper, IUnknown *outer)
{
    if (!clipper) return DDERR_INVALIDPARAMS;
    *clipper = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;

    *clipper = ddraw_clipper_create();
    return *clipper ? DD_OK : DDERR_OUTOFMEMORY;
}

static HRESULT WINAPI ddraw7_GetCaps(void *self, LPDDCAPS driver, LPDDCAPS hel)
{
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_GET_CAPS;
    int ret = bridge_call(&slot);

    if (ret == DD_OK && driver) {
        memset(driver, 0, sizeof(*driver));
        driver->dwSize = sizeof(DDCAPS);
        driver->dwCaps = DDCAPS_3D | DDCAPS_BLT | DDCAPS_BLTCOLORFILL |
                         DDCAPS_BLTSTRETCH | DDCAPS_BLTQUEUE;
        driver->dwCKeyCaps = DDCKEYCAPS_SRCOVERLAY | DDCKEYCAPS_DESTOVERLAY;
        driver->dwPalCaps  = DDPCAPS_8BIT;
        driver->dwVidMemTotal = 32 * 1024 * 1024;  /* 32 MB */
        driver->dwVidMemFree  = 24 * 1024 * 1024;  /* 24 MB */
        driver->dwMaxVisibleOverlays = 0;
        driver->dwCurrVisibleOverlays = 0;
    }
    if (ret == DD_OK && hel) {
        memset(hel, 0, sizeof(*hel));
        hel->dwSize = sizeof(DDCAPS);
    }
    return ret;
}

static HRESULT WINAPI ddraw7_GetAvailableVidMem(void *self, LPDDCAPS caps,
                                                  DWORD *total, DWORD *free)
{
    if (total) *total = 32 * 1024 * 1024;
    if (free)  *free  = 24 * 1024 * 1024;
    return DD_OK;
}

static HRESULT WINAPI ddraw7_RestoreDisplayMode(void *self)
{
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_RESTORE_DISPLAY_MODE;
    return bridge_call(&slot);
}

static HRESULT WINAPI ddraw7_WaitForVerticalBlank(void *self, DWORD flags, HANDLE hEvent)
{
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_WAIT_FOR_VSYNC;
    return bridge_call(&slot);
}

static HRESULT WINAPI ddraw7_GetVerticalBlankStatus(void *self, BOOL *status)
{
    if (status) *status = FALSE;
    return DD_OK;
}

static HRESULT WINAPI ddraw7_EnumDisplayModes(void *self, DWORD flags,
                                                LPDDSURFACEDESC2 desc, LPVOID ctx,
                                                LPDDENUMMODESCALLBACK2 cb)
{
    if (!cb) return DDERR_INVALIDPARAMS;

    /* Report a few standard modes the bridge supports */
    static const struct { DWORD w, h, bpp; } modes[] = {
        {640, 480, 8}, {640, 480, 16}, {640, 480, 32},
        {800, 600, 8}, {800, 600, 16}, {800, 600, 32},
        {1024, 768, 16}, {1024, 768, 32},
        {1280, 720, 16}, {1280, 720, 32},
    };

    DDSURFACEDESC2 d = {0};
    d.dwSize = sizeof(d);

    for (int i = 0; i < sizeof(modes)/sizeof(modes[0]); i++) {
        if (desc && desc->dwWidth && desc->dwWidth != modes[i].w) continue;
        if (desc && desc->dwHeight && desc->dwHeight != modes[i].h) continue;
        d.dwWidth  = modes[i].w;
        d.dwHeight = modes[i].h;
        d.ddpfPixelFormat.dwRGBBitCount = modes[i].bpp;
        if (cb(&d, ctx) != DDENUMRET_OK)
            break;
    }
    return DD_OK;
}

static HRESULT WINAPI ddraw7_FlipToGDISurface(void *self)
{
    return DD_OK;
}

static HRESULT WINAPI ddraw7_GetMonitorFrequency(void *self, DWORD *freq)
{
    if (freq) *freq = 60;  /* pretend 60 Hz */
    return DD_OK;
}

/* ── IDirectDrawSurface7 implementation ──────────────────────── */

/* Surface vtable methods */
static HRESULT WINAPI surf7_QueryInterface(void *, REFIID, void **);
static ULONG   WINAPI surf7_AddRef(void *);
static ULONG   WINAPI surf7_Release(void *);
static HRESULT WINAPI surf7_GetDC(void *, HDC *);
static HRESULT WINAPI surf7_ReleaseDC(void *, HDC);
static HRESULT WINAPI surf7_Blt(void *, LPRECT, LPDIRECTDRAWSURFACE7, LPRECT, DWORD, LPDDBLTFX);
static HRESULT WINAPI surf7_BltFast(void *, DWORD, DWORD, LPDIRECTDRAWSURFACE7, LPRECT, DWORD);
static HRESULT WINAPI surf7_Lock(void *, LPRECT, LPDDSURFACEDESC2, DWORD, HANDLE);
static HRESULT WINAPI surf7_Unlock(void *, LPRECT);
static HRESULT WINAPI surf7_Flip(void *, LPDIRECTDRAWSURFACE7, DWORD);
static HRESULT WINAPI surf7_GetSurfaceDesc(void *, LPDDSURFACEDESC2);
static HRESULT WINAPI surf7_SetPalette(void *, LPDIRECTDRAWPALETTE);
static HRESULT WINAPI surf7_GetPalette(void *, LPDIRECTDRAWPALETTE *);
static HRESULT WINAPI surf7_SetColorKey(void *, DWORD, LPDDCOLORKEY);
static HRESULT WINAPI surf7_GetColorKey(void *, DWORD, LPDDCOLORKEY);
static HRESULT WINAPI surf7_Restore(void *);
static HRESULT WINAPI surf7_SetOverlayPosition(void *, LONG, LONG);
static HRESULT WINAPI surf7_GetOverlayPosition(void *, LONG *, LONG *);

static void *surf7_vtable[] = {
    (void *)surf7_QueryInterface, (void *)surf7_AddRef, (void *)surf7_Release,
    (void *)surf7_GetDC, (void *)surf7_ReleaseDC,
    (void *)surf7_SetOverlayPosition, (void *)surf7_GetOverlayPosition,
    (void *)surf7_SetPalette, (void *)surf7_GetPalette,
    (void *)surf7_SetColorKey, (void *)surf7_GetColorKey,
    (void *)surf7_Flip, (void *)surf7_Blt, (void *)surf7_BltFast,
    (void *)surf7_Lock, (void *)surf7_Unlock,
    (void *)surf7_GetSurfaceDesc,
    (void *)surf7_Restore,
};

struct surface7_impl *ddraw_surface7_create(uint32_t bridge_handle,
                                             const BridgeCreateSurfaceParams *cp)
{
    struct surface7_impl *s = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*s));
    if (s) {
        s->vtable  = surf7_vtable;
        s->refcount = 1;
        s->handle  = bridge_handle;
        s->width   = cp->width;
        s->height  = cp->height;
        s->pitch   = cp->pitch;
        s->flags   = cp->flags;
    }
    return s;
}

static HRESULT WINAPI surf7_QueryInterface(void *self, REFIID riid, void **obj)
{
    if (!obj) return DDERR_INVALIDPARAMS;
    *obj = NULL;
    if (IsEqualGUID(riid, &IID_IDirectDrawSurface7) ||
        IsEqualGUID(riid, &IID_IUnknown)) {
        *obj = self;
        surf7_AddRef(self);
        return DD_OK;
    }
    return DDERR_NOINTERFACE;
}

static ULONG WINAPI surf7_AddRef(void *self)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    return InterlockedIncrement(&s->refcount);
}

static ULONG WINAPI surf7_Release(void *self)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    LONG ref = InterlockedDecrement(&s->refcount);
    if (ref == 0) {
        BridgeSlot slot = {0};
        slot.type = BRIDGE_CMD_DESTROY_SURFACE;
        slot.surface = s->handle;
        bridge_call(&slot);
        HeapFree(GetProcessHeap(), 0, s);
    }
    return ref;
}

static HRESULT WINAPI surf7_Lock(void *self, LPRECT rect, LPDDSURFACEDESC2 desc,
                                   DWORD flags, HANDLE hEvent)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    if (!desc) return DDERR_INVALIDPARAMS;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_LOCK_SURFACE;
    slot.surface = s->handle;
    int ret = bridge_call(&slot);

    if (ret == DD_OK) {
        desc->dwSize = sizeof(*desc);
        desc->dwWidth  = s->width;
        desc->dwHeight = s->height;
        desc->lPitch   = s->pitch;
        desc->lpSurface = (LPVOID)(uintptr_t)slot.param1;  /* host tells us linear addr */
        desc->ddpfPixelFormat.dwSize = sizeof(desc->ddpfPixelFormat);
        if (s->flags & SURF_INDEXED) {
            desc->ddpfPixelFormat.dwRGBBitCount = 8;
            desc->ddpfPixelFormat.dwFlags = DDPF_PALETTEINDEXED8;
        } else if (s->flags & SURF_16BIT) {
            desc->ddpfPixelFormat.dwRGBBitCount = 16;
            desc->ddpfPixelFormat.dwRBitMask = 0xF800;
            desc->ddpfPixelFormat.dwGBitMask = 0x07E0;
            desc->ddpfPixelFormat.dwBBitMask = 0x001F;
        } else if (s->flags & SURF_32BIT) {
            desc->ddpfPixelFormat.dwRGBBitCount = 32;
            desc->ddpfPixelFormat.dwRBitMask = 0x00FF0000;
            desc->ddpfPixelFormat.dwGBitMask = 0x0000FF00;
            desc->ddpfPixelFormat.dwBBitMask = 0x000000FF;
        }
        desc->ddpfPixelFormat.dwRGBAlphaBitMask = 0;
    }
    return ret;
}

static HRESULT WINAPI surf7_Unlock(void *self, LPRECT rect)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_UNLOCK_SURFACE;
    slot.surface = s->handle;
    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_GetDC(void *self, HDC *dc)
{
    if (!dc) return DDERR_INVALIDPARAMS;
    *dc = NULL;

    struct surface7_impl *s = (struct surface7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_GET_DC;
    slot.surface = s->handle;
    return bridge_call(&slot);
    /* Note: real GetDC would need GDI interop — stub for now */
}

static HRESULT WINAPI surf7_ReleaseDC(void *self, HDC dc)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_RELEASE_DC;
    slot.surface = s->handle;
    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_Blt(void *self, LPRECT dst_rect,
                                 LPDIRECTDRAWSURFACE7 src, LPRECT src_rect,
                                 DWORD flags, LPDDBLTFX fx)
{
    struct surface7_impl *s = (struct surface7_impl *)self;

    BridgeBltParams bp = {0};
    if (dst_rect) {
        bp.dst_x = dst_rect->left;  bp.dst_y = dst_rect->top;
        bp.dst_w = dst_rect->right - dst_rect->left;
        bp.dst_h = dst_rect->bottom - dst_rect->top;
    }
    if (src_rect) {
        bp.src_x = src_rect->left;  bp.src_y = src_rect->top;
        bp.src_w = src_rect->right - src_rect->left;
        bp.src_h = src_rect->bottom - src_rect->top;
    }

    bp.flags = flags;
    if (fx) {
        bp.color_fill = fx->dwFillColor;
        if (fx->ddckDestColorkey.dwColorSpaceLowValue ||
            fx->ddckSrcColorkey.dwColorSpaceLowValue)
            bp.color_key = fx->ddckSrcColorkey.dwColorSpaceLowValue;
    }

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_BLT;
    slot.surface = s->handle;
    slot.param1  = src ? ((struct surface7_impl *)src)->handle : 0;
    memcpy(slot.payload, &bp, sizeof(bp));

    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_BltFast(void *self, DWORD x, DWORD y,
                                     LPDIRECTDRAWSURFACE7 src, LPRECT src_rect,
                                     DWORD flags)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    uint32_t src_handle = src ? ((struct surface7_impl *)src)->handle : 0;

    BridgeBltParams bp = {0};
    bp.dst_x = (int32_t)x;
    bp.dst_y = (int32_t)y;
    if (src_rect) {
        bp.src_x = src_rect->left;  bp.src_y = src_rect->top;
        bp.src_w = src_rect->right - src_rect->left;
        bp.src_h = src_rect->bottom - src_rect->top;
    }
    bp.flags = flags;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_BLT_FAST;
    slot.surface = s->handle;
    slot.param1  = (int32_t)src_handle;
    memcpy(slot.payload, &bp, sizeof(bp));

    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_Flip(void *self, LPDIRECTDRAWSURFACE7 target, DWORD flags)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    uint32_t tgt_handle = target ? ((struct surface7_impl *)target)->handle : 0;

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_FLIP;
    slot.surface = s->handle;
    slot.param1  = (int32_t)tgt_handle;
    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_GetSurfaceDesc(void *self, LPDDSURFACEDESC2 desc)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    if (!desc) return DDERR_INVALIDPARAMS;

    desc->dwSize = sizeof(*desc);
    desc->dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH |
                    DDSD_PIXELFORMAT | DDSD_BACKBUFFERCOUNT;
    desc->ddsCaps.dwCaps = 0;
    if (s->flags & SURF_PRIMARY)         desc->ddsCaps.dwCaps |= DDSCAPS_PRIMARYSURFACE;
    if (s->flags & SURF_OFFSCREEN_PLAIN) desc->ddsCaps.dwCaps |= DDSCAPS_OFFSCREENPLAIN;
    if (s->flags & SURF_SYSTEM_MEMORY)   desc->ddsCaps.dwCaps |= DDSCAPS_SYSTEMMEMORY;
    if (s->flags & SURF_VIDEO_MEMORY)    desc->ddsCaps.dwCaps |= DDSCAPS_VIDEOMEMORY;
    if (s->flags & SURF_BACK_BUFFER)     desc->ddsCaps.dwCaps |= DDSCAPS_BACKBUFFER;
    if (s->flags & SURF_TEXTURE)          desc->ddsCaps.dwCaps |= DDSCAPS_TEXTURE;
    desc->dwWidth  = s->width;
    desc->dwHeight = s->height;
    desc->lPitch   = s->pitch;
    /* pixel format */
    desc->ddpfPixelFormat.dwSize = sizeof(desc->ddpfPixelFormat);
    if (s->flags & SURF_INDEXED) {
        desc->ddpfPixelFormat.dwRGBBitCount = 8;
        desc->ddpfPixelFormat.dwFlags = DDPF_PALETTEINDEXED8;
    } else if (s->flags & SURF_16BIT) {
        desc->ddpfPixelFormat.dwRGBBitCount = 16;
        desc->ddpfPixelFormat.dwFlags = DDPF_RGB;
        desc->ddpfPixelFormat.dwRBitMask = 0xF800;
        desc->ddpfPixelFormat.dwGBitMask = 0x07E0;
        desc->ddpfPixelFormat.dwBBitMask = 0x001F;
    } else if (s->flags & SURF_32BIT) {
        desc->ddpfPixelFormat.dwRGBBitCount = 32;
        desc->ddpfPixelFormat.dwFlags = DDPF_RGB;
        desc->ddpfPixelFormat.dwRBitMask = 0x00FF0000;
        desc->ddpfPixelFormat.dwGBitMask = 0x0000FF00;
        desc->ddpfPixelFormat.dwBBitMask = 0x000000FF;
    }
    return DD_OK;
}

static HRESULT WINAPI surf7_SetPalette(void *self, LPDIRECTDRAWPALETTE palette)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    if (!palette) {
        s->pal_handle = 0;
        return DD_OK;
    }
    s->pal_handle = ddraw_palette_get_handle(palette);

    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_SET_PALETTE;
    slot.surface = s->handle;
    slot.param1  = (int32_t)s->pal_handle;
    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_GetPalette(void *self, LPDIRECTDRAWPALETTE *palette)
{
    if (!palette) return DDERR_INVALIDPARAMS;
    *palette = NULL;
    return DDERR_NOPALETTEATTACHED;
}

static HRESULT WINAPI surf7_SetColorKey(void *self, DWORD flags, LPDDCOLORKEY key)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    if (!key) return DDERR_INVALIDPARAMS;

    s->color_key = key->dwColorSpaceLowValue;
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_SET_COLOR_KEY;
    slot.surface = s->handle;
    slot.param1  = (int32_t)flags;
    slot.param2  = (int32_t)key->dwColorSpaceLowValue;
    slot.param3  = (int32_t)key->dwColorSpaceHighValue;
    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_GetColorKey(void *self, DWORD flags, LPDDCOLORKEY key)
{
    struct surface7_impl *s = (struct surface7_impl *)self;
    if (!key) return DDERR_INVALIDPARAMS;
    key->dwColorSpaceLowValue  = s->color_key;
    key->dwColorSpaceHighValue = s->color_key;
    return DD_OK;
}

static HRESULT WINAPI surf7_Restore(void *self)
{
    BridgeSlot slot = {0};
    slot.type = BRIDGE_CMD_FLUSH;
    return bridge_call(&slot);
}

static HRESULT WINAPI surf7_SetOverlayPosition(void *self, LONG x, LONG y)
{
    return DDERR_NOOVERLAYHW;
}

static HRESULT WINAPI surf7_GetOverlayPosition(void *self, LONG *x, LONG *y)
{
    return DDERR_NOOVERLAYHW;
}

/* ── IDirectDrawPalette implementation ────────────────────────── */

static void *palette_vtable[] = {
    (void *)surf7_QueryInterface,  /* reuse: QueryInterface, AddRef, Release generic */
    (void *)surf7_AddRef,
    (void *)surf7_Release,
};

struct palette_impl *ddraw_palette_create(uint32_t handle, DWORD flags,
                                            const PALETTEENTRY *entries)
{
    struct palette_impl *p = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*p));
    if (p) {
        p->vtable = palette_vtable;
        p->refcount = 1;
        p->handle = handle;
        p->flags = flags;
        if (entries) memcpy(p->entries, entries, sizeof(p->entries));
    }
    return p;
}

uint32_t ddraw_palette_get_handle(void *pal)
{
    if (!pal) return 0;
    return ((struct palette_impl *)pal)->handle;
}

/* ── IDirectDrawClipper implementation ───────────────────────────── */

static void *clipper_vtable[] = {
    (void *)surf7_QueryInterface,  /* reuse */
    (void *)surf7_AddRef,
    (void *)surf7_Release,
};

struct clipper_impl *ddraw_clipper_create(void)
{
    struct clipper_impl *c = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*c));
    if (c) {
        c->vtable = clipper_vtable;
        c->refcount = 1;
    }
    return c;
}

/* ── API exports ────────────────────────────────────────────────── */

HRESULT WINAPI DirectDrawCreate(GUID *guid, LPDIRECTDRAW *dd, IUnknown *outer)
{
    if (!dd) return DDERR_INVALIDPARAMS;
    *dd = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;

    struct ddraw7_impl *d = ddraw7_alloc();
    if (!d) return DDERR_OUTOFMEMORY;

    /* Return as IDirectDraw (old interface) */
    *dd = (LPDIRECTDRAW)d;
    return DD_OK;
}

HRESULT WINAPI DirectDrawCreateEx(GUID *guid, LPVOID *dd, REFIID riid, IUnknown *outer)
{
    if (!dd) return DDERR_INVALIDPARAMS;
    *dd = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;

    /* Ensure the caller wants IDirectDraw7 (which is the expected pattern) */
    if (!IsEqualGUID(riid, &IID_IDirectDraw7))
        return DDERR_NOINTERFACE;

    struct ddraw7_impl *d = ddraw7_alloc();
    if (!d) return DDERR_OUTOFMEMORY;

    *dd = d;
    return DD_OK;
}

HRESULT WINAPI DirectDrawEnumerateA(LPDDENUMCALLBACKA cb, LPVOID ctx)
{
    if (!cb) return DDERR_INVALIDPARAMS;
    /* Advertise a single primary adapter */
    cb(NULL, "v86 DDraw Bridge", "v86 DDraw Bridge", ctx);
    return DD_OK;
}

HRESULT WINAPI DirectDrawEnumerateExA(LPDDENUMCALLBACKEXA cb, LPVOID ctx, DWORD flags)
{
    if (!cb) return DDERR_INVALIDPARAMS;
    cb(NULL, "v86 DDraw Bridge", "v86 DDraw Bridge", ctx, NULL);
    return DD_OK;
}

HRESULT WINAPI DirectDrawEnumerateExW(LPDDENUMCALLBACKEXW cb, LPVOID ctx, DWORD flags)
{
    if (!cb) return DDERR_INVALIDPARAMS;
    cb(NULL, L"v86 DDraw Bridge", L"v86 DDraw Bridge", ctx, NULL);
    return DD_OK;
}