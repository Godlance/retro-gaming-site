#ifndef D9WG_PROTOCOL_H
#define D9WG_PROTOCOL_H

#include <stdint.h>

/*
 * D9WG v0.1 (frozen at M1, see docs/d3d9-webgpu-implementation-plan.zh-CN.md
 * section 6 and milestone M1). This is an independent protocol from D8WG: it
 * does not share opcode numbering, resource handle namespace, or payload
 * shapes with the D3D8 path, even though both ride the same VGL2 DMA
 * transport (v86gl.sys, 16 MiB ring, PCI BAR) via a different outer record
 * type. A guest process loads either d3d8.dll or d3d9.dll, never both.
 *
 * M1 implements only: HELLO, CREATE_DEVICE, RESET, PRESENT, CLEAR,
 * BEGIN_SCENE, END_SCENE, CREATE_BUFFER, UPDATE_BUFFER, DESTROY_RESOURCE,
 * CREATE_TEXTURE_2D, CREATE_VERTEX_DECLARATION, SET_RENDER_STATE,
 * SET_TEXTURE_STAGE_STATE, SET_TEXTURE, SET_VIEWPORT, SET_TRANSFORM,
 * SET_STREAM_SOURCE, SET_INDICES, SET_VERTEX_DECLARATION, SET_FVF, the four
 * DRAW_* opcodes. Every other opcode below is part of the frozen v0.1 wire
 * shape but has no guest emitter yet -- d3d9_proxy.c returns
 * D3DERR_INVALIDCALL/D3DERR_NOTAVAILABLE for the D3D9 API calls that would
 * produce them, rather than emitting a command the M1 executor cannot act
 * on. Do not repurpose an opcode number when its real implementation lands;
 * add a new one instead so archived traces stay decodable.
 */
#define V86GL_CTRL_D3D9_BATCH 0xFFE1u

#define D9WG_MAGIC 0x47573944u /* "D9WG" */
#define D9WG_VERSION_MAJOR 1u
#define D9WG_VERSION_MINOR 0u

#define D9WG_BATCH_FLAG_PRESENT (1u << 0)

enum D9WGOpcode {
    D9WG_OP_HELLO = 1,
    D9WG_OP_CREATE_DEVICE = 2,
    D9WG_OP_RESET = 3,
    D9WG_OP_PRESENT = 4,
    D9WG_OP_CLEAR = 5,
    D9WG_OP_BEGIN_SCENE = 6,
    D9WG_OP_END_SCENE = 7,
    D9WG_OP_STRETCH_RECT = 8,        /* M4 */
    D9WG_OP_COLOR_FILL = 9,          /* M4 */
    D9WG_OP_UPDATE_SURFACE = 10,     /* not before M2 */

    D9WG_OP_CREATE_BUFFER = 0x100,
    D9WG_OP_UPDATE_BUFFER = 0x101,
    D9WG_OP_DESTROY_RESOURCE = 0x103,
    D9WG_OP_CREATE_TEXTURE_2D = 0x110,
    D9WG_OP_CREATE_TEXTURE_CUBE = 0x111,     /* not before M3 */
    D9WG_OP_CREATE_TEXTURE_VOLUME = 0x112,   /* not before M3 */
    D9WG_OP_UPDATE_TEXTURE = 0x113,          /* not before M2 */
    D9WG_OP_CREATE_VERTEX_DECLARATION = 0x120,
    D9WG_OP_CREATE_VERTEX_SHADER = 0x121,     /* M2 */
    D9WG_OP_CREATE_PIXEL_SHADER = 0x122,      /* M2 */
    D9WG_OP_CREATE_QUERY = 0x123,             /* M4 */
    D9WG_OP_CREATE_STATE_BLOCK = 0x124,       /* not before M3 */

    D9WG_OP_SET_RENDER_STATE = 0x200,
    D9WG_OP_SET_SAMPLER_STATE = 0x201,       /* M2 */
    D9WG_OP_SET_TEXTURE_STAGE_STATE = 0x202,
    D9WG_OP_SET_TEXTURE = 0x203,
    D9WG_OP_SET_VIEWPORT = 0x204,
    D9WG_OP_SET_SCISSOR_RECT = 0x205,        /* not before M3 */
    D9WG_OP_SET_TRANSFORM = 0x206,
    D9WG_OP_SET_MATERIAL = 0x207,            /* not before M3 */
    D9WG_OP_SET_LIGHT = 0x208,               /* not before M3 */
    D9WG_OP_LIGHT_ENABLE = 0x209,            /* not before M3 */
    D9WG_OP_SET_STREAM_SOURCE = 0x20A,
    D9WG_OP_SET_STREAM_SOURCE_FREQ = 0x20B,  /* instancing, M6 前不实现 */
    D9WG_OP_SET_INDICES = 0x20C,
    D9WG_OP_SET_VERTEX_DECLARATION = 0x20D,
    D9WG_OP_SET_FVF = 0x20E,                 /* 兼容路径 */
    D9WG_OP_SET_RENDER_TARGET = 0x20F,       /* MRT 本体在 M4 */
    D9WG_OP_SET_DEPTH_STENCIL_SURFACE = 0x210, /* not before M4 */
    D9WG_OP_SET_VERTEX_SHADER = 0x211,       /* M2 */
    D9WG_OP_SET_PIXEL_SHADER = 0x212,        /* M2 */
    D9WG_OP_SET_VERTEX_SHADER_CONSTANT_F = 0x213, /* M2 */
    D9WG_OP_SET_VERTEX_SHADER_CONSTANT_I = 0x214, /* M2 */
    D9WG_OP_SET_VERTEX_SHADER_CONSTANT_B = 0x215, /* M2 */
    D9WG_OP_SET_PIXEL_SHADER_CONSTANT_F = 0x216,  /* M2 */
    D9WG_OP_SET_PIXEL_SHADER_CONSTANT_I = 0x217,  /* M2 */
    D9WG_OP_SET_PIXEL_SHADER_CONSTANT_B = 0x218,  /* M2 */
    D9WG_OP_SET_CLIP_PLANE = 0x219,          /* not before M3/M5, see 9.11 */

    D9WG_OP_DRAW_PRIMITIVE = 0x300,
    D9WG_OP_DRAW_INDEXED_PRIMITIVE = 0x301,
    D9WG_OP_DRAW_PRIMITIVE_UP = 0x302,
    D9WG_OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303,

    D9WG_OP_BEGIN_QUERY = 0x400,             /* M4 */
    D9WG_OP_END_QUERY = 0x401,               /* M4 */
    D9WG_OP_GET_QUERY_DATA = 0x402           /* M4 */
};

#define D9WG_RESOURCE_BUFFER_VERTEX      1u
#define D9WG_RESOURCE_BUFFER_INDEX       2u
#define D9WG_RESOURCE_TEXTURE_2D         3u
#define D9WG_RESOURCE_TEXTURE_CUBE       4u
#define D9WG_RESOURCE_TEXTURE_VOLUME     5u
#define D9WG_RESOURCE_VERTEX_DECLARATION 6u
#define D9WG_RESOURCE_VERTEX_SHADER      7u
#define D9WG_RESOURCE_PIXEL_SHADER       8u
#define D9WG_RESOURCE_QUERY              9u
#define D9WG_RESOURCE_STATE_BLOCK        10u

/* Shader handles (once M2 starts allocating them) live in a namespace
 * disjoint from allocate_handle()'s buffer/texture/declaration counter, with
 * bit 0 always set, purely so a host-side resource table keyed by a single
 * flat handle space can never collide a shader handle with a buffer/texture/
 * declaration handle. Unlike D3D8, D3D9's SetVertexShader/SetFVF/
 * SetVertexDeclaration are three distinct COM methods with distinct
 * parameter types, so the guest never needs to disambiguate a shader handle
 * from an FVF token on the wire -- each has its own opcode. */
#define D9WG_SHADER_HANDLE_BASE 0x40000001u

#pragma pack(push, 1)
typedef struct D9WGBatchHeader {
    uint32_t magic;
    uint16_t version_major;
    uint16_t version_minor;
    uint32_t frame_id;
    uint32_t flags;
    uint32_t command_count;
    uint32_t command_bytes;
    uint32_t session_id_low;
    uint32_t session_id_high;
} D9WGBatchHeader; /* 32 bytes */

typedef struct D9WGCommandHeader {
    uint16_t opcode;
    uint16_t flags;
    uint32_t size;
    uint32_t sequence;
    uint32_t reserved;
} D9WGCommandHeader; /* 16 bytes */

typedef struct D9WGHello {
    uint32_t guest_pointer_bits;
    uint32_t feature_bits;
    uint32_t session_id_low;
    uint32_t session_id_high;
} D9WGHello;

typedef struct D9WGCreateDevice {
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
} D9WGCreateDevice;

typedef struct D9WGResetDevice {
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
} D9WGResetDevice;

typedef struct D9WGPresent {
    uint32_t device_handle;
    uint32_t hwnd;
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
} D9WGPresent;

typedef struct D9WGClear {
    uint32_t device_handle;
    uint32_t clear_flags;
    uint32_t color;
    float depth;
    uint32_t stencil;
    uint32_t rect_count;
} D9WGClear;

typedef struct D9WGDeviceOnly {
    uint32_t device_handle;
    uint32_t reserved;
} D9WGDeviceOnly;

typedef struct D9WGCreateBuffer {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t resource_kind;
    uint32_t byte_count;
    uint32_t usage;
    uint32_t fvf; /* index buffers store D3DFORMAT (INDEX16/INDEX32) here */
    uint32_t pool;
    uint32_t reserved;
} D9WGCreateBuffer;

typedef struct D9WGUpdateBuffer {
    uint32_t resource_handle;
    uint32_t destination_offset;
    uint32_t byte_count;
    uint32_t data_offset;
    uint32_t lock_flags;
    uint32_t reserved;
} D9WGUpdateBuffer;

typedef struct D9WGCreateTexture2D {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t width;
    uint32_t height;
    uint32_t level_count;
    uint32_t format;
    uint32_t usage;
    uint32_t pool;
} D9WGCreateTexture2D;

/* depth/slice_pitch are always 1/0 for a 2D texture; the fields exist now so
 * D9WG_OP_CREATE_TEXTURE_VOLUME's UpdateTexture traffic (M3) does not need a
 * new opcode. */
typedef struct D9WGUpdateTexture {
    uint32_t resource_handle;
    uint32_t level;
    uint32_t x;
    uint32_t y;
    uint32_t z;
    uint32_t width;
    uint32_t height;
    uint32_t depth;
    uint32_t row_pitch;
    uint32_t slice_pitch;
    uint32_t data_bytes;
    uint32_t data_offset;
} D9WGUpdateTexture;

typedef struct D9WGDestroyResource {
    uint32_t resource_handle;
    uint32_t resource_kind;
} D9WGDestroyResource;

typedef struct D9WGSetRenderState {
    uint32_t device_handle;
    uint32_t state;
    uint32_t value;
    uint32_t reserved;
} D9WGSetRenderState;

typedef struct D9WGSetSamplerState {
    uint32_t device_handle;
    uint32_t sampler;
    uint32_t state;
    uint32_t value;
} D9WGSetSamplerState;

typedef struct D9WGSetTextureStageState {
    uint32_t device_handle;
    uint32_t stage;
    uint32_t state;
    uint32_t value;
} D9WGSetTextureStageState;

typedef struct D9WGSetTexture {
    uint32_t device_handle;
    uint32_t stage;
    uint32_t texture_handle;
    uint32_t reserved;
} D9WGSetTexture;

typedef struct D9WGSetViewport {
    uint32_t device_handle;
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
    float min_z;
    float max_z;
    uint32_t reserved;
} D9WGSetViewport;

typedef struct D9WGSetTransform {
    uint32_t device_handle;
    uint32_t state; /* raw D3DTRANSFORMSTATETYPE value, not remapped */
    float matrix[16];
} D9WGSetTransform;

typedef struct D9WGSetMaterial {
    uint32_t device_handle;
    float diffuse[4];
    float ambient[4];
    float specular[4];
    float emissive[4];
    float power;
} D9WGSetMaterial;

typedef struct D9WGSetLight {
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
} D9WGSetLight;

typedef struct D9WGLightEnable {
    uint32_t device_handle;
    uint32_t index;
    uint32_t enable;
    uint32_t reserved;
} D9WGLightEnable;

/* offset_in_bytes is D3D9's SetStreamSource OffsetInBytes: the byte offset
 * of this binding's first vertex within the buffer. Packing several meshes
 * into one large vertex buffer and binding each at its own offset is a very
 * common engine pattern, so this is carried on the wire rather than
 * restricted to zero. */
typedef struct D9WGSetStreamSource {
    uint32_t device_handle;
    uint32_t stream;
    uint32_t buffer_handle;
    uint32_t stride;
    uint32_t offset_in_bytes;
    uint32_t reserved;
} D9WGSetStreamSource;

/* D3D9's IDirect3DDevice9::SetIndices, unlike D3D8's, carries no base vertex
 * index -- that moved to a per-draw parameter (see D9WGDrawIndexedPrimitive).
 */
typedef struct D9WGSetIndices {
    uint32_t device_handle;
    uint32_t buffer_handle;
} D9WGSetIndices;

/* Per plan section 4.3, the host never decodes raw FVF bits: the guest
 * expands SetFVF(fvf) into the equivalent D3DVERTEXELEMENT9 array (see
 * fvf_to_declaration() in d3d9_proxy.c) and sends it here in the same shape
 * CREATE_VERTEX_DECLARATION uses, so the host has exactly one vertex-layout
 * code path regardless of which legacy/modern API produced it. `fvf` is
 * carried only for host-side logging/diagnostics, never interpreted. */
typedef struct D9WGSetFVF {
    uint32_t device_handle;
    uint32_t fvf;
    uint32_t element_count;
    uint32_t reserved;
    /* element_count 个 D9WGVertexElement 紧随其后 */
} D9WGSetFVF;

typedef struct D9WGSetVertexDeclaration {
    uint32_t device_handle;
    uint32_t declaration_handle;
} D9WGSetVertexDeclaration;

/* D3DVERTEXELEMENT9 has the identical 8-byte shape (Stream/Offset/Type/
 * Method/Usage/UsageIndex as WORD/WORD/BYTE/BYTE/BYTE/BYTE), so the guest
 * copies the app's array into this type without reinterpreting fields. */
typedef struct D9WGVertexElement {
    uint16_t stream;
    uint16_t offset;
    uint8_t  type;
    uint8_t  method;
    uint8_t  usage;
    uint8_t  usage_index;
} D9WGVertexElement; /* 8 bytes */

typedef struct D9WGCreateVertexDeclaration {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t element_count;
    uint32_t reserved;
    /* element_count 个 D9WGVertexElement 紧随其后, 不含 D3DDECL_END() 哨兵 */
} D9WGCreateVertexDeclaration;

/* M2: CREATE_VERTEX_SHADER / CREATE_PIXEL_SHADER. bytecode_hash lets host
 * dedupe compiled WGSL across CreateXShader calls with identical bytecode. */
typedef struct D9WGCreateVertexShader {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t instruction_token_count;
    uint32_t code_offset;
    uint32_t bytecode_hash_low;
    uint32_t bytecode_hash_high;
} D9WGCreateVertexShader;
/* D9WGCreatePixelShader is byte-for-byte identical. */
typedef D9WGCreateVertexShader D9WGCreatePixelShader;

typedef struct D9WGSetShader {
    uint32_t device_handle;
    uint32_t shader_handle; /* 0 = unbind (fixed function) */
} D9WGSetShader;

typedef struct D9WGSetShaderConstantF {
    uint32_t device_handle;
    uint32_t start_register;
    uint32_t vector_count; /* float4 count */
    uint32_t data_offset;  /* vector_count*16 bytes, relative to batch base */
} D9WGSetShaderConstantF;

typedef struct D9WGSetRenderTarget {
    uint32_t device_handle;
    uint32_t target_index;         /* 0..3, MRT (M4) */
    uint32_t color_texture_handle; /* 0 = 解除绑定该槽位 */
    uint32_t color_level;
} D9WGSetRenderTarget;

typedef struct D9WGSetScissorRect {
    uint32_t device_handle;
    int32_t  left;
    int32_t  top;
    int32_t  right;
    int32_t  bottom;
} D9WGSetScissorRect;

typedef struct D9WGCreateQuery {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t query_type; /* D3DQUERYTYPE_OCCLUSION / EVENT, 第一版仅这两种 */
    uint32_t reserved;
} D9WGCreateQuery;

typedef struct D9WGDrawPrimitive {
    uint32_t device_handle;
    uint32_t primitive_type;
    uint32_t start_vertex;
    uint32_t primitive_count;
} D9WGDrawPrimitive;

/* base_vertex_index is a per-draw parameter in D3D9 (see D9WGSetIndices). */
typedef struct D9WGDrawIndexedPrimitive {
    uint32_t device_handle;
    uint32_t primitive_type;
    int32_t  base_vertex_index;
    uint32_t min_vertex_index;
    uint32_t vertex_count;
    uint32_t start_index;
    uint32_t primitive_count;
} D9WGDrawIndexedPrimitive;

typedef struct D9WGDrawPrimitiveUP {
    uint32_t device_handle;
    uint32_t primitive_type;
    uint32_t primitive_count;
    uint32_t stride;
    uint32_t vertex_count;
    uint32_t vertex_bytes;
    uint32_t vertex_data_offset;
    uint32_t reserved;
} D9WGDrawPrimitiveUP;

typedef struct D9WGDrawIndexedPrimitiveUP {
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
} D9WGDrawIndexedPrimitiveUP;
#pragma pack(pop)

#define D9WG_ALIGN8(value) (((uint32_t)(value) + 7u) & ~7u)

typedef char D9WGAssertBatchHeaderSize[
        sizeof(D9WGBatchHeader) == 32 ? 1 : -1];
typedef char D9WGAssertCommandHeaderSize[
        sizeof(D9WGCommandHeader) == 16 ? 1 : -1];
typedef char D9WGAssertHelloSize[
        sizeof(D9WGHello) == 16 ? 1 : -1];
typedef char D9WGAssertCreateDeviceSize[
        sizeof(D9WGCreateDevice) == 44 ? 1 : -1];
typedef char D9WGAssertPresentSize[
        sizeof(D9WGPresent) == 24 ? 1 : -1];
typedef char D9WGAssertCreateBufferSize[
        sizeof(D9WGCreateBuffer) == 32 ? 1 : -1];
typedef char D9WGAssertUpdateBufferSize[
        sizeof(D9WGUpdateBuffer) == 24 ? 1 : -1];
typedef char D9WGAssertCreateTexture2DSize[
        sizeof(D9WGCreateTexture2D) == 32 ? 1 : -1];
typedef char D9WGAssertUpdateTextureSize[
        sizeof(D9WGUpdateTexture) == 48 ? 1 : -1];
typedef char D9WGAssertSetTextureSize[
        sizeof(D9WGSetTexture) == 16 ? 1 : -1];
typedef char D9WGAssertSetViewportSize[
        sizeof(D9WGSetViewport) == 32 ? 1 : -1];
typedef char D9WGAssertSetTransformSize[
        sizeof(D9WGSetTransform) == 72 ? 1 : -1];
typedef char D9WGAssertSetMaterialSize[
        sizeof(D9WGSetMaterial) == 72 ? 1 : -1];
typedef char D9WGAssertSetLightSize[
        sizeof(D9WGSetLight) == 112 ? 1 : -1];
typedef char D9WGAssertLightEnableSize[
        sizeof(D9WGLightEnable) == 16 ? 1 : -1];
typedef char D9WGAssertSetStreamSourceSize[
        sizeof(D9WGSetStreamSource) == 24 ? 1 : -1];
typedef char D9WGAssertSetIndicesSize[
        sizeof(D9WGSetIndices) == 8 ? 1 : -1];
typedef char D9WGAssertSetFVFSize[
        sizeof(D9WGSetFVF) == 16 ? 1 : -1];
typedef char D9WGAssertVertexElementSize[
        sizeof(D9WGVertexElement) == 8 ? 1 : -1];
typedef char D9WGAssertCreateVertexDeclarationSize[
        sizeof(D9WGCreateVertexDeclaration) == 16 ? 1 : -1];
typedef char D9WGAssertCreateVertexShaderSize[
        sizeof(D9WGCreateVertexShader) == 24 ? 1 : -1];
typedef char D9WGAssertSetShaderSize[
        sizeof(D9WGSetShader) == 8 ? 1 : -1];
typedef char D9WGAssertSetShaderConstantFSize[
        sizeof(D9WGSetShaderConstantF) == 16 ? 1 : -1];
typedef char D9WGAssertDrawIndexedPrimitiveSize[
        sizeof(D9WGDrawIndexedPrimitive) == 28 ? 1 : -1];
typedef char D9WGAssertDrawPrimitiveUPSize[
        sizeof(D9WGDrawPrimitiveUP) == 32 ? 1 : -1];
typedef char D9WGAssertDrawIndexedPrimitiveUPSize[
        sizeof(D9WGDrawIndexedPrimitiveUP) == 48 ? 1 : -1];

#endif
