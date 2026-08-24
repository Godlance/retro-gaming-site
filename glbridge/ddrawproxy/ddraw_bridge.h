/*
 * ddraw-bridge.h — Shared protocol between guest ddraw.dll and host JS
 *
 * This file is designed to compile under C (MinGW for the guest DLL) and
 * also serves as documentation for the JavaScript host implementation.
 *
 * Memory layout at physical address 0x500:
 *   +0x00: ring_head (uint32, guest advances)
 *   +0x04: ring_tail (uint32, host advances)
 *   +0x08: cmd_slot[0]  (64 bytes each)
 *   +0x48: cmd_slot[1]
 *   ... up to 1023 slots = 64 KB total ring
 */

#ifndef DDRAW_BRIDGE_H
#define DDRAW_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Ring buffer constants ───────────────────────────────────── */

#define BRIDGE_RING_PHYS_ADDR   0x500uL
#define BRIDGE_RING_SIZE        65536uL   /* 64 KB */
#define BRIDGE_IO_PORT          0xDE00

#define BRIDGE_SLOT_SIZE        64
#define BRIDGE_MAX_SLOTS        (BRIDGE_RING_SIZE / BRIDGE_SLOT_SIZE)

/* ── Command types ────────────────────────────────────────────── */

enum BridgeCommand {
    /* Surface management */
    BRIDGE_CMD_CREATE_SURFACE        = 0x0001,
    BRIDGE_CMD_DESTROY_SURFACE       = 0x0002,
    BRIDGE_CMD_LOCK_SURFACE          = 0x0003,
    BRIDGE_CMD_UNLOCK_SURFACE        = 0x0004,
    BRIDGE_CMD_BLT                   = 0x0005,
    BRIDGE_CMD_BLT_FAST              = 0x0006,
    BRIDGE_CMD_FLIP                  = 0x0007,
    BRIDGE_CMD_SET_COLOR_KEY         = 0x0008,
    BRIDGE_CMD_FILL                  = 0x0009,
    BRIDGE_CMD_GET_DC                = 0x000A,
    BRIDGE_CMD_RELEASE_DC            = 0x000B,

    /* Display mode */
    BRIDGE_CMD_SET_DISPLAY_MODE      = 0x0010,
    BRIDGE_CMD_GET_DISPLAY_MODE      = 0x0011,
    BRIDGE_CMD_RESTORE_DISPLAY_MODE  = 0x0012,
    BRIDGE_CMD_SET_COOPERATIVE_LEVEL = 0x0013,

    /* Palette */
    BRIDGE_CMD_CREATE_PALETTE        = 0x0020,
    BRIDGE_CMD_DESTROY_PALETTE       = 0x0021,
    BRIDGE_CMD_SET_PALETTE           = 0x0022,  /* attach palette to surface */
    BRIDGE_CMD_SET_PALETTE_ENTRIES   = 0x0023,
    BRIDGE_CMD_GET_PALETTE_ENTRIES   = 0x0024,

    /* Clipper (mostly stub) */
    BRIDGE_CMD_CREATE_CLIPPER        = 0x0030,
    BRIDGE_CMD_SET_CLIP_LIST         = 0x0031,
    BRIDGE_CMD_GET_CLIP_LIST         = 0x0032,

    /* Direct3D 7 */
    BRIDGE_CMD_D3D_CREATE_DEVICE     = 0x0100,
    BRIDGE_CMD_D3D_DESTROY_DEVICE    = 0x0101,
    BRIDGE_CMD_D3D_SET_RENDER_TARGET = 0x0102,
    BRIDGE_CMD_D3D_CLEAR             = 0x0103,
    BRIDGE_CMD_D3D_BEGIN_SCENE       = 0x0104,
    BRIDGE_CMD_D3D_END_SCENE         = 0x0105,
    BRIDGE_CMD_D3D_DRAW_INDEXED      = 0x0106,
    BRIDGE_CMD_D3D_DRAW_PRIMITIVE    = 0x0107,
    BRIDGE_CMD_D3D_SET_MATERIAL      = 0x0108,
    BRIDGE_CMD_D3D_SET_LIGHT         = 0x0109,
    BRIDGE_CMD_D3D_SET_TEXTURE       = 0x010A,
    BRIDGE_CMD_D3D_SET_RENDER_STATE  = 0x010B,
    BRIDGE_CMD_D3D_SET_TEXTURE_STAGE = 0x010C,
    BRIDGE_CMD_D3D_SET_VIEWPORT      = 0x010D,
    BRIDGE_CMD_D3D_SET_TRANSFORM     = 0x010E,

    /* Misc */
    BRIDGE_CMD_WAIT_FOR_VSYNC        = 0x0200,
    BRIDGE_CMD_GET_CAPS              = 0x0201,
    BRIDGE_CMD_GET_AVAILABLE_VIDMEM  = 0x0202,
    BRIDGE_CMD_FLUSH                 = 0x0203,

    BRIDGE_CMD_INVALID               = 0xFFFF,
};

/* ── Surface type flags ──────────────────────────────────────── */

enum BridgeSurfaceFlags {
    SURF_PRIMARY             = 0x00000001,
    SURF_OFFSCREEN_PLAIN     = 0x00000002,
    SURF_SYSTEM_MEMORY       = 0x00000004,
    SURF_VIDEO_MEMORY        = 0x00000008,
    SURF_BACK_BUFFER         = 0x00000010,
    SURF_COMPLEX             = 0x00000020,
    SURF_FLIP                = 0x00000040,
    SURF_TEXTURE             = 0x00000080,  /* 3D texture */
    SURF_INDEXED             = 0x00000100,  /* 8-bit paletted */
    SURF_16BIT               = 0x00000200,  /* RGB565 */
    SURF_32BIT               = 0x00000400,  /* X8R8G8B8 */
};

/* ── Blit flags ──────────────────────────────────────────────── */

enum BridgeBltFlags {
    BLT_COLOR_FILL           = 0x00000001,
    BLT_KEY_SRC              = 0x00000002,
    BLT_KEY_DEST             = 0x00000004,
    BLT_ALPHA                = 0x00000008,
    BLT_WAIT                 = 0x00000010,
};

/* ── 3D constants ────────────────────────────────────────────── */
/* NOTE: The actual D3D enum values (D3DPT_*, D3DRS_*, D3DTSS_*) 
   are defined by MinGW's <d3d.h> / <d3dtypes.h>. These are kept 
   as documentation. The JS host uses the numeric values directly. */

enum BridgeD3DPrimitiveType {
    D3DPT_TRIANGLE_LIST      = 0,
    D3DPT_TRIANGLE_STRIP     = 1,
    D3DPT_TRIANGLE_FAN       = 2,
    D3DPT_LINE_LIST          = 3,
    D3DPT_LINE_STRIP         = 4,
    D3DPT_POINT_LIST         = 5,
};

/* ── Status codes ────────────────────────────────────────────── */

enum BridgeStatus {
    BRIDGE_OK                = 0,
    BRIDGE_ERR_UNKNOWN_CMD   = -1,
    BRIDGE_ERR_NO_MEMORY     = -2,
    BRIDGE_ERR_INVALID_PARAM = -3,
    BRIDGE_ERR_NOT_IMPLEMENTED = -4,
    BRIDGE_ERR_SURFACE_LOST  = -5,
};

/* ── Slot structure (exactly 64 bytes) ────────────────────────── */

typedef struct __attribute__((packed)) BridgeSlot {
    uint16_t type;           /* BridgeCommand */
    uint16_t _pad;
    uint32_t surface;        /* surface handle (cookie) */
    int32_t  param1;
    int32_t  param2;
    int32_t  param3;
    int32_t  param4;
    int32_t  param5;
    int32_t  status;         /* host writes result here */
    uint8_t  payload[32];    /* arbitrary extra data */
} BridgeSlot;

/* compile-time assertion: BridgeSlot must be exactly 64 bytes */
typedef char assert_bridge_slot_size[(sizeof(BridgeSlot) == BRIDGE_SLOT_SIZE) ? 1 : -1];

/* ── Surface creation parameters (in payload) ────────────────── */

typedef struct __attribute__((packed)) {
    int32_t  width;
    int32_t  height;
    int32_t  pitch;
    uint32_t flags;          /* BridgeSurfaceFlags */
    uint32_t buffer_phys;    /* physical address of backing memory (0 = host allocates) */
    uint32_t mipmap_levels;
} BridgeCreateSurfaceParams;

/* ── Blit parameters (in payload) ────────────────────────────── */

typedef struct __attribute__((packed)) {
    int32_t  src_x, src_y, src_w, src_h;
    int32_t  dst_x, dst_y, dst_w, dst_h;
    uint32_t flags;
    uint32_t color_fill;     /* for BLT_COLOR_FILL */
    uint32_t color_key;      /* transparent color */
} BridgeBltParams;

/* ── 3D draw parameter (in payload) ──────────────────────────── */

typedef struct __attribute__((packed)) {
    uint32_t primitive_type;  /* BridgeD3DPrimitiveType */
    uint32_t vertex_count;
    uint32_t index_count;
    uint32_t vertex_stride;
    uint32_t vertex_phys;     /* guest physical address of vertex buffer */
    uint32_t index_phys;      /* guest physical of index buffer (0 = non-indexed) */
    uint32_t start_index;
} BridgeD3DDrawParams;

/* ── Render state (in payload) ───────────────────────────────── */

typedef struct __attribute__((packed)) {
    uint32_t state;           /* BridgeD3DRenderState or BridgeD3DTextureStageState */
    uint32_t stage;           /* 0 for RS, texture stage index for TSS */
    int32_t  value;
} BridgeD3DRenderStateParams;

/* ── Inline helpers ───────────────────────────────────────────── */

static inline uint32_t bridge_slot_offset(uint32_t index)
{
    return 8 + index * BRIDGE_SLOT_SIZE;  /* 8 = head + tail */
}

static inline uint32_t bridge_wrap(uint32_t index)
{
    return index & (BRIDGE_MAX_SLOTS - 1);
}

/* ── Sends a command by writing the slot and ringing the doorbell ── */
/*     implementación en bridge.c */

int bridge_send_command(const BridgeSlot *slot);
void bridge_init_ring(void);
void bridge_ring_doorbell(void);

#ifdef __cplusplus
}
#endif

#endif /* DDRAW_BRIDGE_H */