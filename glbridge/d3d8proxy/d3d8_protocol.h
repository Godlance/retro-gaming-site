#ifndef D8WG_PROTOCOL_H
#define D8WG_PROTOCOL_H

#include <stdint.h>

/*
 * The existing VGL2 PCI descriptor remains the transport envelope.  A single
 * V86GL_CTRL_D3D8_BATCH record carries this D8WG stream, so the v86 PCI device
 * and the XP transport driver stay protocol-agnostic.
 */
#define V86GL_CTRL_D3D8_BATCH 0xFFE0u

#define D8WG_MAGIC 0x47573844u /* "D8WG" */
#define D8WG_VERSION_MAJOR 1u
#define D8WG_VERSION_MINOR 6u

#define D8WG_BATCH_FLAG_PRESENT (1u << 0)

enum D8WGOpcode {
    D8WG_OP_HELLO = 1,
    D8WG_OP_CREATE_DEVICE = 2,
    D8WG_OP_RESET = 3,
    D8WG_OP_PRESENT = 4,
    D8WG_OP_CLEAR = 5,
    D8WG_OP_BEGIN_SCENE = 6,
    D8WG_OP_END_SCENE = 7,
    D8WG_OP_UPDATE_SURFACE = 8,

    D8WG_OP_CREATE_BUFFER = 0x100,
    D8WG_OP_UPDATE_BUFFER = 0x101,
    D8WG_OP_DESTROY_RESOURCE = 0x103,
    D8WG_OP_CREATE_TEXTURE = 0x110,
    D8WG_OP_UPDATE_TEXTURE = 0x111,

    D8WG_OP_SET_RENDER_STATE = 0x200,
    D8WG_OP_SET_TEXTURE_STAGE_STATE = 0x201,
    D8WG_OP_SET_TEXTURE = 0x202,
    D8WG_OP_SET_VIEWPORT = 0x203,
    D8WG_OP_SET_TRANSFORM = 0x204,
    D8WG_OP_SET_MATERIAL = 0x205,
    D8WG_OP_SET_LIGHT = 0x206,
    D8WG_OP_LIGHT_ENABLE = 0x207,
    D8WG_OP_SET_STREAM_SOURCE = 0x208,
    D8WG_OP_SET_INDICES = 0x209,
    D8WG_OP_SET_VERTEX_FORMAT = 0x20A,
    D8WG_OP_SET_RENDER_TARGET = 0x20B,

    D8WG_OP_DRAW_PRIMITIVE = 0x300,
    D8WG_OP_DRAW_INDEXED_PRIMITIVE = 0x301,
    D8WG_OP_DRAW_PRIMITIVE_UP = 0x302,
    D8WG_OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303
};

#define D8WG_RESOURCE_BUFFER_VERTEX 1u
#define D8WG_RESOURCE_BUFFER_INDEX 2u
#define D8WG_RESOURCE_TEXTURE_2D 3u

#pragma pack(push, 1)
typedef struct D8WGBatchHeader {
    uint32_t magic;
    uint16_t version_major;
    uint16_t version_minor;
    uint32_t frame_id;
    uint32_t flags;
    uint32_t command_count;
    uint32_t command_bytes;
    /* Per-process namespace. Handles are unique only inside this session. */
    uint32_t session_id_low;
    uint32_t session_id_high;
} D8WGBatchHeader;

typedef struct D8WGCommandHeader {
    uint16_t opcode;
    uint16_t flags;
    uint32_t size;
    uint32_t sequence;
    uint32_t reserved;
} D8WGCommandHeader;

typedef struct D8WGHello {
    uint32_t guest_pointer_bits;
    uint32_t feature_bits;
    uint32_t session_id_low;
    uint32_t session_id_high;
} D8WGHello;

typedef struct D8WGCreateDevice {
    uint32_t device_handle;
    uint32_t hwnd;
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
    uint32_t backbuffer_format;
    uint32_t windowed;
    uint32_t behavior_flags;
    uint32_t enable_auto_depth_stencil;
    uint32_t auto_depth_stencil_format;
} D8WGCreateDevice;

/* Reset replaces the device namespace.  Commands carrying the old handle are
 * stale after this record and can never resolve resources of the new epoch. */
typedef struct D8WGResetDevice {
    uint32_t old_device_handle;
    uint32_t new_device_handle;
    uint32_t hwnd;
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
    uint32_t backbuffer_format;
    uint32_t windowed;
    uint32_t behavior_flags;
    uint32_t enable_auto_depth_stencil;
    uint32_t auto_depth_stencil_format;
} D8WGResetDevice;

typedef struct D8WGPresent {
    uint32_t device_handle;
    uint32_t hwnd;
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
} D8WGPresent;

typedef struct D8WGUpdateSurface {
    uint32_t device_handle;
    uint32_t hwnd;
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
} D8WGUpdateSurface;

typedef struct D8WGClear {
    uint32_t device_handle;
    uint32_t clear_flags;
    uint32_t color;
    float depth;
    uint32_t stencil;
    uint32_t rect_count;
} D8WGClear;

typedef struct D8WGDeviceOnly {
    uint32_t device_handle;
    uint32_t reserved;
} D8WGDeviceOnly;

typedef struct D8WGCreateBuffer {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t resource_kind;
    uint32_t byte_count;
    uint32_t usage;
    uint32_t fvf;
    uint32_t pool;
    uint32_t reserved;
} D8WGCreateBuffer;

typedef struct D8WGUpdateBuffer {
    uint32_t resource_handle;
    uint32_t destination_offset;
    uint32_t byte_count;
    uint32_t data_offset;
    uint32_t lock_flags;
    uint32_t reserved;
} D8WGUpdateBuffer;

typedef struct D8WGCreateTexture {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t width;
    uint32_t height;
    uint32_t level_count;
    uint32_t format;
    uint32_t usage;
    uint32_t pool;
} D8WGCreateTexture;

typedef struct D8WGUpdateTexture {
    uint32_t resource_handle;
    uint32_t level;
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
    uint32_t row_pitch;
    uint32_t data_bytes;
    uint32_t data_offset;
    uint32_t reserved;
} D8WGUpdateTexture;

typedef struct D8WGDestroyResource {
    uint32_t resource_handle;
    uint32_t resource_kind;
} D8WGDestroyResource;

typedef struct D8WGSetRenderState {
    uint32_t device_handle;
    uint32_t state;
    uint32_t value;
    uint32_t reserved;
} D8WGSetRenderState;

typedef struct D8WGSetTextureStageState {
    uint32_t device_handle;
    uint32_t stage;
    uint32_t state;
    uint32_t value;
} D8WGSetTextureStageState;

typedef struct D8WGSetTexture {
    uint32_t device_handle;
    uint32_t stage;
    uint32_t texture_handle;
    uint32_t reserved;
} D8WGSetTexture;

typedef struct D8WGSetRenderTarget {
    uint32_t device_handle;
    uint32_t color_texture_handle;
    uint32_t color_level;
    uint32_t depth_enabled;
} D8WGSetRenderTarget;

typedef struct D8WGSetViewport {
    uint32_t device_handle;
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
    float min_z;
    float max_z;
    uint32_t reserved;
} D8WGSetViewport;

typedef struct D8WGSetTransform {
    uint32_t device_handle;
    uint32_t state;
    float matrix[16];
} D8WGSetTransform;

typedef struct D8WGSetMaterial {
    uint32_t device_handle;
    float diffuse[4];
    float ambient[4];
    float specular[4];
    float emissive[4];
    float power;
} D8WGSetMaterial;

typedef struct D8WGSetLight {
    uint32_t device_handle;
    uint32_t index;
    uint32_t type;
    float diffuse[4];
    float specular[4];
    float ambient[4];
    float position[3];
    float direction[3];
    float range;
    float falloff;
    float attenuation[3];
    float theta;
    float phi;
} D8WGSetLight;

typedef struct D8WGLightEnable {
    uint32_t device_handle;
    uint32_t index;
    uint32_t enable;
    uint32_t reserved;
} D8WGLightEnable;

typedef struct D8WGSetStreamSource {
    uint32_t device_handle;
    uint32_t stream;
    uint32_t buffer_handle;
    uint32_t stride;
} D8WGSetStreamSource;

typedef struct D8WGSetIndices {
    uint32_t device_handle;
    uint32_t buffer_handle;
    uint32_t base_vertex_index;
    uint32_t reserved;
} D8WGSetIndices;

typedef struct D8WGSetVertexFormat {
    uint32_t device_handle;
    uint32_t fvf;
} D8WGSetVertexFormat;

typedef struct D8WGDrawPrimitive {
    uint32_t device_handle;
    uint32_t primitive_type;
    uint32_t start_vertex;
    uint32_t primitive_count;
} D8WGDrawPrimitive;

typedef struct D8WGDrawIndexedPrimitive {
    uint32_t device_handle;
    uint32_t primitive_type;
    uint32_t min_vertex_index;
    uint32_t vertex_count;
    uint32_t start_index;
    uint32_t primitive_count;
} D8WGDrawIndexedPrimitive;

typedef struct D8WGDrawPrimitiveUP {
    uint32_t device_handle;
    uint32_t primitive_type;
    uint32_t primitive_count;
    uint32_t stride;
    uint32_t vertex_count;
    uint32_t vertex_bytes;
    uint32_t vertex_data_offset;
    uint32_t reserved;
} D8WGDrawPrimitiveUP;

typedef struct D8WGDrawIndexedPrimitiveUP {
    uint32_t device_handle;
    uint32_t primitive_type;
    uint32_t min_vertex_index;
    uint32_t vertex_count;
    uint32_t primitive_count;
    uint32_t index_format;
    uint32_t stride;
    uint32_t index_count;
    uint32_t index_bytes;
    uint32_t vertex_bytes;
    uint32_t index_data_offset;
    uint32_t vertex_data_offset;
} D8WGDrawIndexedPrimitiveUP;
#pragma pack(pop)

#define D8WG_ALIGN8(value) (((uint32_t)(value) + 7u) & ~7u)

typedef char D8WGAssertBatchHeaderSize[
        sizeof(D8WGBatchHeader) == 32 ? 1 : -1];
typedef char D8WGAssertCommandHeaderSize[
        sizeof(D8WGCommandHeader) == 16 ? 1 : -1];
typedef char D8WGAssertHelloSize[
        sizeof(D8WGHello) == 16 ? 1 : -1];
typedef char D8WGAssertCreateDeviceSize[
        sizeof(D8WGCreateDevice) == 44 ? 1 : -1];
typedef char D8WGAssertPresentSize[
        sizeof(D8WGPresent) == 24 ? 1 : -1];
typedef char D8WGAssertUpdateSurfaceSize[
        sizeof(D8WGUpdateSurface) == 24 ? 1 : -1];
typedef char D8WGAssertCreateBufferSize[
        sizeof(D8WGCreateBuffer) == 32 ? 1 : -1];
typedef char D8WGAssertUpdateBufferSize[
        sizeof(D8WGUpdateBuffer) == 24 ? 1 : -1];
typedef char D8WGAssertCreateTextureSize[
        sizeof(D8WGCreateTexture) == 32 ? 1 : -1];
typedef char D8WGAssertUpdateTextureSize[
        sizeof(D8WGUpdateTexture) == 40 ? 1 : -1];
typedef char D8WGAssertSetTextureSize[
        sizeof(D8WGSetTexture) == 16 ? 1 : -1];
typedef char D8WGAssertSetViewportSize[
        sizeof(D8WGSetViewport) == 32 ? 1 : -1];
typedef char D8WGAssertSetTransformSize[
        sizeof(D8WGSetTransform) == 72 ? 1 : -1];
typedef char D8WGAssertSetMaterialSize[
        sizeof(D8WGSetMaterial) == 72 ? 1 : -1];
typedef char D8WGAssertSetLightSize[
        sizeof(D8WGSetLight) == 112 ? 1 : -1];
typedef char D8WGAssertLightEnableSize[
        sizeof(D8WGLightEnable) == 16 ? 1 : -1];
typedef char D8WGAssertSetIndicesSize[
        sizeof(D8WGSetIndices) == 16 ? 1 : -1];
typedef char D8WGAssertDrawIndexedPrimitiveSize[
        sizeof(D8WGDrawIndexedPrimitive) == 24 ? 1 : -1];
typedef char D8WGAssertDrawPrimitiveUPSize[
        sizeof(D8WGDrawPrimitiveUP) == 32 ? 1 : -1];
typedef char D8WGAssertDrawIndexedPrimitiveUPSize[
        sizeof(D8WGDrawIndexedPrimitiveUP) == 48 ? 1 : -1];

#endif
