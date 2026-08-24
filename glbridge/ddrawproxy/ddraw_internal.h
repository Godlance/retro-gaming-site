/*
 * ddraw_internal.h — Internal shared declarations for ddraw bridge
 *
 * Shared between ddraw.c and d3d7.c
 */

#ifndef DDRAW_INTERNAL_H
#define DDRAW_INTERNAL_H

#include <stdint.h>
#include <ddraw.h>
#include <d3d.h>

/* Surface handle allocator */
uint32_t alloc_handle(void);

/* Surface implementation (forward declaration for d3d7.c) */
struct surface7_impl {
    void **vtable;
    LONG   refcount;
    uint32_t handle;          /* bridge handle */
    int32_t  width, height, pitch;
    uint32_t flags;
    uint32_t pal_handle;      /* attached palette (0 = none) */
    uint32_t color_key;
    uint32_t d3d_tex;         /* D3D texture handle (0 = none) */
};

/* Surface creation */
struct surface7_impl *ddraw_surface7_create(uint32_t bridge_handle,
                                             const BridgeCreateSurfaceParams *cp);

/* Palette implementation */
struct palette_impl {
    void **vtable;
    LONG   refcount;
    uint32_t handle;
    DWORD  flags;
    PALETTEENTRY entries[256];
};
struct palette_impl *ddraw_palette_create(uint32_t handle, DWORD flags,
                                           const PALETTEENTRY *entries);
uint32_t ddraw_palette_get_handle(void *pal);

/* Clipper */
struct clipper_impl {
    void **vtable;
    LONG   refcount;
    HWND   hwnd;
};
struct clipper_impl *ddraw_clipper_create(void);

/* MinGW compatibility: DDCAPS_DX7 field names */
#ifdef __MINGW32__
#  ifndef DDCAPS_3D
#    define DDCAPS_3D 0x00000001L
#  endif
#  ifndef DDCAPS_BLT
#    define DDCAPS_BLT 0x00000002L
#  endif
#  ifndef DDCAPS_BLTCOLORFILL
#    define DDCAPS_BLTCOLORFILL 0x00000400L
#  endif
#  ifndef DDCAPS_BLTSTRETCH
#    define DDCAPS_BLTSTRETCH 0x00000800L
#  endif
#  ifndef DDCAPS_BLTQUEUE
#    define DDCAPS_BLTQUEUE 0x00001000L
#  endif
#  ifndef DDCKEYCAPS_SRCOVERLAY
#    define DDCKEYCAPS_SRCOVERLAY 0x00000001L
#  endif
#  ifndef DDCKEYCAPS_DESTOVERLAY
#    define DDCKEYCAPS_DESTOVERLAY 0x00000002L
#  endif
#  ifndef DDPCAPS_8BIT
#    define DDPCAPS_8BIT 0x00000001L
#  endif
#  ifndef DDPF_PALETTEINDEXED8
#    define DDPF_PALETTEINDEXED8 0x00000020L
#  endif
#  ifndef DDPF_ZBUFFER
#    define DDPF_ZBUFFER 0x00000080L
#  endif
#  ifndef DDPF_ZPIXELS
#    define DDPF_ZPIXELS 0x00000200L
#  endif
#endif

/* MinGW DDCAPS_DX7 uses dwNumFourCCCodes (not dwNumFourCC) */
/* ── DirectDraw error codes ── */
#ifndef DDERR_NOINTERFACE
#  define DDERR_NOINTERFACE             ((HRESULT)0x80004002L)
#endif
#ifndef DDERR_INVALIDPARAMS
#  define DDERR_INVALIDPARAMS           ((HRESULT)0x80070057L)
#endif
#ifndef DD_OK
#  define DD_OK                         ((HRESULT)0x00000000L)
#  define DDERR_ALREADYINITIALIZED           (-2147483646)
#  define DDERR_CANNOTATTACHSURFACE          (-2147483645)
#  define DDERR_CANNOTDETACHSURFACE          (-2147483644)
#  define DDERR_CURRENTLYNOTAVAIL            (-2147483643)
#  define DDERR_EXCEPTION                    (-2147483642)
#  define DDERR_GENERIC                      (-2147483641)
#  define DDERR_HEIGHTALIGN                  (-2147483640)
#  define DDERR_INCOMPATIBLEPRIMARY          (-2147483639)
#  define DDERR_INVALIDCAPS                  (-2147483638)
#  define DDERR_INVALIDCLIPLIST              (-2147483637)
#  define DDERR_INVALIDMODE                  (-2147483636)
#  define DDERR_INVALIDOBJECT                (-2147483635)
#  define DDERR_INVALIDPARAMS                (-2147483634)
#  define DDERR_INVALIDPIXELFORMAT           (-2147483633)
#  define DDERR_INVALIDRECT                  (-2147483632)
#  define DDERR_LOCKEDSURFACES               (-2147483631)
#  define DDERR_NO3D                         (-2147483630)
#  define DDERR_NOALPHAHW                    (-2147483629)
#  define DDERR_NOSTEREOSCENE                (-2147483628)
#  define DDERR_NOPALETTEATTACHED            (-2147483627)
#  define DDERR_NOPALETTEHW                  (-2147483626)
#  define DDERR_NORASTEROPHW                 (-2147483625)
#  define DDERR_NOTFOUND                     (-2147483624)
#  define DDERR_NOTLOCKED                    (-2147483623)
#  define DDERR_NOCOLORCONVHW                (-2147483622)
#  define DDERR_NOZBUFFERHW                  (-2147483620)
#  define DDERR_NOZBUFFER                    (-2147483618)
#  define DDERR_NOEXCLUSIVEMODE              (-2147483596)
#  define DDERR_NOFLIPHW                     (-2147483615)
#  define DDERR_NOOVERLAYHW                  (-2147483602)
#  define DDERR_NOGDI                        (-2147483610)
#  define DDERR_NOMIRRORHW                   (-2147483609)
#  define DDERR_NOTEXCLUSIVE                 (-2147483608)
#  define DDERR_NOTFLIPPABLE                 (-2147483607)
#  define DDERR_NOTAOVERLAYSURFACE           (-2147483588)
#  define DDERR_OUTOFMEMORY                  (-2147483606)
#  define DDERR_OUTOFVIDEOMEMORY             (-2147483605)
#  define DDERR_OVERLAYNOTVISIBLE            (-2147483604)
#  define DDERR_OVERLAYCANTCLIP              (-2147483603)
#  define DDERR_PALETTEBUSY                  (-2147483601)
#  define DDERR_COLORKEYNOTSET               (-2147483600)
#  define DDERR_SURFACELOST                  (-2147483599)
#  define DDERR_SURFACEBUSY                  (-2147483598)
#  define DDERR_NOIBUFFER                    (-2147483587)
#  define DDERR_NOEXCLUSIVEMODE              (-2147483596)
#  define DDERR_NOFLIPHW                     (-2147483615)
#  define DDERR_NOOVERLAYHW                  (-2147483602)
#  define DDERR_NOGDI                        (-2147483610)
#  define DDERR_NOMIRRORHW                   (-2147483609)
#  define DDERR_NOTEXCLUSIVE                 (-2147483608)
#  define DDERR_NOTFLIPPABLE                 (-2147483607)
#  define DDERR_NOTAOVERLAYSURFACE           (-2147483588)
#  define DDERR_WASSTILLDRAWING              (-2147483594)
#  define DDERR_VERTICALBLANKINPROGRESS      (-2147483593)
#  define DDERR_UNSUPPORTED                  (-2147483592)
#  define DDERR_UNSUPPORTEDFORMAT            (-2147483591)
#  define DDERR_XALIGN                       (-2147483590)
#  define DDERR_NOCOLORCONVHW                (-2147483622)
#endif

#ifndef DDENUMRET_OK
#  define DDENUMRET_OK 0
#  define DDENUMRET_CANCEL 1
#endif

#ifndef D3DENUMRET_OK
#  define D3DENUMRET_OK 0
#  define D3DENUMRET_CANCEL 1
#endif

#ifndef CLASS_E_NOAGGREGATION
#  define CLASS_E_NOAGGREGATION ((HRESULT)0x80040110L)
#endif

#ifndef DDSCL_FULLSCREEN
#  define DDSCL_FULLSCREEN 0x00000001L
#endif
#ifndef DDSCL_NORMAL
#  define DDSCL_NORMAL 0x00000008L
#endif
#ifndef DDSCL_EXCLUSIVE
#  define DDSCL_EXCLUSIVE 0x00000010L
#endif

#ifndef DDSCAPS_PRIMARYSURFACE
#  define DDSCAPS_PRIMARYSURFACE 0x00000001L
#  define DDSCAPS_BACKBUFFER 0x00000004L
#  define DDSCAPS_COMPLEX 0x00000008L
#  define DDSCAPS_FLIP 0x00000010L
#  define DDSCAPS_OFFSCREENPLAIN 0x00000040L
#  define DDSCAPS_SYSTEMMEMORY 0x00000800L
#  define DDSCAPS_VIDEOMEMORY 0x00004000L
#  define DDSCAPS_TEXTURE 0x00001000L
#endif

#ifndef DDSD_CAPS
#  define DDSD_CAPS 0x00000001L
#  define DDSD_HEIGHT 0x00000002L
#  define DDSD_WIDTH 0x00000004L
#  define DDSD_PITCH 0x00000008L
#  define DDSD_PIXELFORMAT 0x00001000L
#  define DDSD_BACKBUFFERCOUNT 0x00000020L
#endif

#ifndef DDPF_RGB
#  define DDPF_RGB 0x00000040L
#endif

/* LPD3DENUMPIXELFORMATSCALLBACK if missing */
#ifndef LPD3DENUMPIXELFORMATSCALLBACK
typedef HRESULT (CALLBACK *LPD3DENUMPIXELFORMATSCALLBACK)(LPDDPIXELFORMAT, LPVOID);
#endif

/* DDPIXELFORMAT_OP */
#ifndef D3DOP_DDRAW
#  define D3DOP_DDRAW 0x00040000L
#endif

#endif /* DDRAW_INTERNAL_H */