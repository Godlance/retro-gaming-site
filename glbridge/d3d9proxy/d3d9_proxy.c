/*
 * App-local Direct3D 9 frontend for Windows XP guests running in v86.
 *
 * Independent from d3d8.dll: separate COM objects, separate D9WG protocol
 * (d3d9_protocol.h), separate host executor. A game directory loads exactly
 * one of d3d8.dll/d3d9.dll/opengl32.dll -- never more than one.
 *
 * M1 scope only (see docs/d3d9-webgpu-implementation-plan.zh-CN.md, section
 * 15): device/resource lifecycle, vertex declarations (plus the common FVF
 * combinations translated to an equivalent declaration per section 4.3),
 * vertex/index buffers, 2D textures, and the fixed-function XYZ/XYZRHW draw
 * path with no programmable shaders. Every D3D9 entry point outside that
 * scope returns D3DERR_INVALIDCALL rather than pretending to have executed
 * something this milestone does not implement yet.
 */

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <initguid.h>
#include <d3d9.h>
#include <stdint.h>
#include "../winproxy/v86gl_ioctl.h"
#include "d3d9_protocol.h"

#define D9WG_LOG_PREFIX "[d3d9-webgpu] "
#define D9_MAX_RENDER_STATES 256u
#define D9_MAX_TEXTURE_STAGES 8u
#define D9_MAX_TEXTURE_STAGE_STATES 33u
#define D9_MAX_STREAMS 4u
#define D9_MAX_TRANSFORMS 512u
#define D9_MAX_LIGHTS 8u
#define D9_MAX_SAMPLERS 16u
#define D9_MAX_SAMPLER_STATES 14u

/*
 * Reported adapter identity (see d3d_get_adapter_identifier).
 *
 * This is deliberately a single switchable block because it is a *test
 * variable*, not a settled design decision. Warcraft III was observed
 * calling GetAdapterIdentifier and then releasing IDirect3D9 without ever
 * asking for caps, formats or a device -- which leaves two live
 * explanations: either it gates on recognising the hardware, or it only
 * wanted the video card name and never intended to render through D3D9 at
 * all. Reporting a GPU the game certainly knows discriminates between them:
 * if it still walks away, hardware recognition is definitively not the
 * gate.
 *
 * D9_ADAPTER_GEFORCE4_MX is the honest choice for that test rather than a
 * faster card: the GeForce4 MX (NV17) has hardware T&L but no programmable
 * vertex/pixel shaders, which is exactly the capability profile fill_caps()
 * already reports (VertexShaderVersion/PixelShaderVersion = 0.0). Claiming
 * a shader-capable card would invite the game down code paths this
 * milestone cannot serve.
 *
 * Set D9_ADAPTER_IDENTITY to D9_ADAPTER_NATIVE to go back to advertising
 * ourselves honestly once the question is settled.
 */
#define D9_ADAPTER_NATIVE       0
#define D9_ADAPTER_GEFORCE4_MX  1
#define D9_ADAPTER_VMWARE_SVGA  2

#define D9_ADAPTER_IDENTITY D9_ADAPTER_GEFORCE4_MX
#define D9_VGL2_RECORD_HEADER_BYTES 8u
#define D9_HANDLE_GENERATION_ONE (1u << 20)

typedef struct D9Direct3D D9Direct3D;
typedef struct D9Device D9Device;
typedef struct D9VertexBuffer D9VertexBuffer;
typedef struct D9IndexBuffer D9IndexBuffer;
typedef struct D9Texture D9Texture;
typedef struct D9VertexDeclaration D9VertexDeclaration;
typedef struct D9Surface D9Surface;

typedef struct D9TextureLevel {
    BYTE *shadow;
    UINT width;
    UINT height;
    UINT row_pitch;
    UINT row_count;
    UINT byte_count;
    RECT lock_rect;
    DWORD lock_flags;
    BOOL locked;
} D9TextureLevel;

typedef struct D9StreamBinding {
    D9VertexBuffer *buffer;
    UINT stride;
    UINT offset; /* SetStreamSource OffsetInBytes */
} D9StreamBinding;

struct D9Direct3D {
    IDirect3D9 iface;
    LONG refcount;
};

struct D9Device {
    IDirect3DDevice9 iface;
    LONG refcount;
    LONG child_parent_refs;
    BOOL releasing_owned_refs;
    D9Direct3D *parent;
    uint32_t handle;
    D3DDEVICE_CREATION_PARAMETERS creation;
    D3DPRESENT_PARAMETERS present;
    D3DDISPLAYMODE display_mode;
    D3DVIEWPORT9 viewport;
    float transforms[D9_MAX_TRANSFORMS][16];
    DWORD render_states[D9_MAX_RENDER_STATES];
    DWORD texture_stage_states[D9_MAX_TEXTURE_STAGES][D9_MAX_TEXTURE_STAGE_STATES];
    DWORD sampler_states[D9_MAX_SAMPLERS][D9_MAX_SAMPLER_STATES];
    D3DMATERIAL9 material;
    D3DLIGHT9 lights[D9_MAX_LIGHTS];
    BOOL light_set[D9_MAX_LIGHTS];
    BOOL light_enabled[D9_MAX_LIGHTS];
    D9StreamBinding streams[D9_MAX_STREAMS];
    D9IndexBuffer *index_buffer;
    D9Texture *textures[D9_MAX_TEXTURE_STAGES];
    DWORD fvf;
    D9VertexDeclaration *vertex_declaration;
    BOOL in_scene;
    D9VertexBuffer *vertex_buffers;
    D9IndexBuffer *index_buffers;
    D9Texture *texture_resources;
    D9VertexDeclaration *vertex_declarations;
    uint32_t reset_epoch;
};

struct D9VertexBuffer {
    IDirect3DVertexBuffer9 iface;
    LONG refcount;
    D9Device *device;
    uint32_t handle;
    BYTE *shadow;
    UINT length;
    DWORD usage;
    DWORD fvf;
    D3DPOOL pool;
    DWORD priority;
    UINT lock_offset;
    UINT lock_size;
    DWORD lock_flags;
    BOOL locked;
    D9VertexBuffer *next_device_resource;
};

struct D9IndexBuffer {
    IDirect3DIndexBuffer9 iface;
    LONG refcount;
    D9Device *device;
    uint32_t handle;
    BYTE *shadow;
    UINT length;
    DWORD usage;
    D3DFORMAT format;
    D3DPOOL pool;
    DWORD priority;
    UINT lock_offset;
    UINT lock_size;
    DWORD lock_flags;
    BOOL locked;
    D9IndexBuffer *next_device_resource;
};

struct D9Texture {
    IDirect3DTexture9 iface;
    LONG refcount;
    D9Device *device;
    uint32_t handle;
    UINT width;
    UINT height;
    UINT level_count;
    DWORD usage;
    D3DFORMAT format;
    D3DPOOL pool;
    DWORD priority;
    DWORD lod;
    D9TextureLevel *levels;
    D9Texture *next_device_resource;
};

/* D3DMAXDECLLENGTH (18) bounds the app-supplied element array; +0 is enough
 * since we never append our own sentinel back into this array. */
struct D9VertexDeclaration {
    IDirect3DVertexDeclaration9 iface;
    LONG refcount;
    D9Device *device;
    uint32_t handle;
    UINT element_count;
    D3DVERTEXELEMENT9 elements[D3DMAXDECLLENGTH];
    D9VertexDeclaration *next_device_resource;
};

/* GetBackBuffer's return value. M1 gives this real GetDesc() dimensions/
 * format (real games have been observed gating an entire render branch on
 * GetBackBuffer succeeding, even when they never actually read pixels back
 * from it), but it is not backed by any GPU resource: LockRect/GetDC honestly
 * fail rather than claim readback support the plan's non-goals (2.2) exclude
 * from M1. It is re-obtained fresh from device state on every call rather
 * than cached, so it never needs Reset-time recreation. */
struct D9Surface {
    IDirect3DSurface9 iface;
    LONG refcount;
    D9Device *device;
    /* Non-NULL for a surface obtained from IDirect3DTexture9::GetSurfaceLevel:
     * the surface is then just a view onto that texture level, and its
     * LockRect/UnlockRect share the texture's shadow storage and upload path.
     * NULL for the GetBackBuffer surface, which is not backed by anything. */
    D9Texture *texture;
    UINT level;
    UINT width;
    UINT height;
    D3DFORMAT format;
};

static IDirect3D9Vtbl g_d3d_vtbl;
static IDirect3DDevice9Vtbl g_device_vtbl;
static IDirect3DVertexBuffer9Vtbl g_vb_vtbl;
static IDirect3DIndexBuffer9Vtbl g_ib_vtbl;
static IDirect3DTexture9Vtbl g_texture_vtbl;
static IDirect3DVertexDeclaration9Vtbl g_decl_vtbl;
static IDirect3DSurface9Vtbl g_surface_vtbl;

static void device_clear_bindings(D9Device *device);
static BOOL device_has_reset_blockers(D9Device *device);
static void device_release_owned_references(D9Device *device);
static BOOL recreate_device_resources(D9Device *device);
static void device_child_add_ref(D9Device *device);
static void device_child_release(D9Device *device);

static D9Direct3D *d3d_from_iface(IDirect3D9 *iface)
{
    return (D9Direct3D *)iface;
}

static D9Device *device_from_iface(IDirect3DDevice9 *iface)
{
    return (D9Device *)iface;
}

static D9VertexBuffer *vb_from_iface(IDirect3DVertexBuffer9 *iface)
{
    return (D9VertexBuffer *)iface;
}

static D9IndexBuffer *ib_from_iface(IDirect3DIndexBuffer9 *iface)
{
    return (D9IndexBuffer *)iface;
}

static D9Texture *texture_from_iface(IDirect3DTexture9 *iface)
{
    return (D9Texture *)iface;
}

static D9VertexDeclaration *decl_from_iface(IDirect3DVertexDeclaration9 *iface)
{
    return (D9VertexDeclaration *)iface;
}

static BOOL guid_equal(REFIID left, REFIID right)
{
    UINT index;
    if (!left || !right || left->Data1 != right->Data1
            || left->Data2 != right->Data2 || left->Data3 != right->Data3)
        return FALSE;
    for (index = 0; index < 8; ++index) {
        if (left->Data4[index] != right->Data4[index]) return FALSE;
    }
    return TRUE;
}

static BOOL iid_is_unknown(REFIID iid)
{
    static const IID unknown = { 0x00000000, 0x0000, 0x0000,
        { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
    return guid_equal(iid, &unknown);
}

/*
 * OutputDebugStringA is only visible with a kernel/user-mode debugger (e.g.
 * DebugView) attached inside the guest, which a fresh XP install used only
 * to run a game usually does not have. Mirror every log line into a plain
 * text file next to the app's working directory as well, so "what did this
 * game actually call that we don't implement yet" can be answered just by
 * opening a file after the game exits or hangs.
 */
static HANDLE g_trace_log_file = INVALID_HANDLE_VALUE;
static BOOL g_trace_log_failed;
static HINSTANCE g_module_instance;

/*
 * The log path is derived from this DLL's own location, not the process's
 * current directory. A game is free to SetCurrentDirectory during startup,
 * and any helper process that loads this DLL has its own working directory
 * -- with a bare relative name the log then lands somewhere nobody is
 * looking, which is indistinguishable from "the DLL was never called".
 * Anchoring it to the module keeps every user of this DLL appending to the
 * one file next to it.
 */
static void ensure_trace_log_open(void)
{
    char path[MAX_PATH];
    DWORD length;
    DWORD index;

    if (g_trace_log_file != INVALID_HANDLE_VALUE || g_trace_log_failed)
        return;
    length = GetModuleFileNameA(g_module_instance, path, sizeof(path));
    if (!length || length >= sizeof(path)) {
        lstrcpynA(path, "d3d9_trace.log", sizeof(path));
    } else {
        /* Replace the file name component with our log's name. */
        for (index = length; index > 0; --index) {
            if (path[index - 1] == '\\' || path[index - 1] == '/')
                break;
        }
        if (index + lstrlenA("d3d9_trace.log") >= sizeof(path))
            lstrcpynA(path, "d3d9_trace.log", sizeof(path));
        else
            lstrcpynA(path + index, "d3d9_trace.log",
                    (int)(sizeof(path) - index));
    }
    g_trace_log_file = CreateFileA(path, GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL, NULL);
    if (g_trace_log_file == INVALID_HANDLE_VALUE) {
        g_trace_log_failed = TRUE;
        return;
    }
    SetFilePointer(g_trace_log_file, 0, NULL, FILE_END);
}

static void d9wg_log(const char *text)
{
    DWORD written;

    OutputDebugStringA(D9WG_LOG_PREFIX);
    OutputDebugStringA(text);
    OutputDebugStringA("\r\n");

    ensure_trace_log_open();
    if (g_trace_log_file == INVALID_HANDLE_VALUE)
        return;
    WriteFile(g_trace_log_file, D9WG_LOG_PREFIX,
            (DWORD)lstrlenA(D9WG_LOG_PREFIX), &written, NULL);
    WriteFile(g_trace_log_file, text, (DWORD)lstrlenA(text), &written, NULL);
    WriteFile(g_trace_log_file, "\r\n", 2, &written, NULL);
    FlushFileBuffers(g_trace_log_file);
}

/* Logs the current function's name (via __func__) the first time it is
 * called and never again, so a real game session cannot flood the trace log
 * by calling the same unimplemented method every frame. */
#define TRACE_STUB_ONCE() \
    do { \
        static BOOL traced_once; \
        if (!traced_once) { \
            traced_once = TRUE; \
            d9wg_log(__func__); \
        } \
    } while (0)

/*
 * Diagnostic-only: TRACE_STUB_ONCE covers unimplemented calls, but a game
 * that never hits any of those (as War3 did not, past the earlier fixes)
 * leaves the trace log with nothing at all -- indistinguishable from "the
 * DLL never got used". TRACE_ONCE(text) is the same "log the first hit,
 * never again" behavior for calls that already have a real implementation,
 * so a single test run shows exactly how far the app actually got: device
 * creation, scene brackets, first clear, first draw and whether it
 * succeeded. Each call site's `static BOOL` is private to that site (a
 * macro expansion, not a shared variable), so this stays one line per
 * distinct call, never one per frame.
 */
#define TRACE_ONCE(text) \
    do { \
        static BOOL traced_call_once; \
        if (!traced_call_once) { \
            traced_call_once = TRUE; \
            d9wg_log(text); \
        } \
    } while (0)

/*
 * The blind spot TRACE_STUB_ONCE/TRACE_ONCE cannot cover: a call that *is*
 * implemented but rejects the app's specific arguments (an unsupported
 * D3DDECLTYPE, a texture format outside the M1 table, a render-target
 * usage...). Those return D3DERR_INVALIDCALL silently, so a game dying on
 * one of them produces an empty trace log that looks identical to a clean
 * run. TRACE_FIRST runs an arbitrary block exactly once per call site, so
 * the (relatively expensive) wsprintfA that formats the offending values
 * only happens on the first rejection and never in a per-frame hot path.
 */
#define TRACE_FIRST(block) \
    do { \
        static BOOL traced_first_once; \
        if (!traced_first_once) { \
            traced_first_once = TRUE; \
            block \
        } \
    } while (0)

/*
 * Adapter/caps probing (everything between Direct3DCreate9 and CreateDevice)
 * needs per-call logging rather than TRACE_FIRST's once-per-site: an app
 * walks dozens of distinct format/usage combinations here, and the
 * interesting datum is exactly *which* combination made it give up. A
 * once-per-site trace would show only the first probe and hide the one that
 * actually mattered. This is bounded by a shared budget instead, so a game
 * that probes in a loop cannot grow the trace file without limit.
 */
static LONG g_probe_trace_budget = 120;

#define TRACE_PROBE(block) \
    do { \
        if (InterlockedDecrement(&g_probe_trace_budget) >= 0) { \
            block \
        } \
    } while (0)

static uint32_t g_next_handle = D9_HANDLE_GENERATION_ONE;

static uint32_t allocate_handle(void)
{
    uint32_t handle = (uint32_t)InterlockedIncrement((LONG *)&g_next_handle);
    if (!handle)
        handle = (uint32_t)InterlockedIncrement((LONG *)&g_next_handle);
    return handle;
}

/* ---- VGL2 transport / D9WG batch buffer ---- */

static HANDLE g_transport = INVALID_HANDLE_VALUE;
static uint8_t *g_dma_buffer;
static uint32_t g_dma_capacity;
static uint32_t g_batch_bytes;
static uint32_t g_command_count;
static uint32_t g_frame_id = 1;
static uint32_t g_sequence = 1;
static uint32_t g_session_id_low;
static uint32_t g_session_id_high;
static BOOL g_transport_failed;
static BOOL g_hello_emitted;
static CRITICAL_SECTION g_transport_lock;

static uint8_t *batch_base(void)
{
    return g_dma_buffer + sizeof(V86GLDMADesc) + D9_VGL2_RECORD_HEADER_BYTES;
}

static uint32_t batch_capacity(void)
{
    if (g_dma_capacity <= sizeof(V86GLDMADesc) + D9_VGL2_RECORD_HEADER_BYTES)
        return 0;
    return g_dma_capacity - (uint32_t)sizeof(V86GLDMADesc)
            - D9_VGL2_RECORD_HEADER_BYTES;
}

static void reset_batch_locked(void)
{
    D9WGBatchHeader *header;

    g_batch_bytes = sizeof(D9WGBatchHeader);
    g_command_count = 0;
    if (!g_dma_buffer || batch_capacity() < sizeof(D9WGBatchHeader))
        return;

    header = (D9WGBatchHeader *)batch_base();
    ZeroMemory(header, sizeof(*header));
    header->magic = D9WG_MAGIC;
    header->version_major = D9WG_VERSION_MAJOR;
    header->version_minor = D9WG_VERSION_MINOR;
    header->frame_id = g_frame_id;
    header->session_id_low = g_session_id_low;
    header->session_id_high = g_session_id_high;
}

static void close_transport_locked(void)
{
    DWORD returned = 0;

    if (g_transport != INVALID_HANDLE_VALUE) {
        if (g_dma_buffer) {
            DeviceIoControl(g_transport, V86GL_IOCTL_UNMAP_BUFFER,
                    NULL, 0, NULL, 0, &returned, NULL);
        }
        CloseHandle(g_transport);
    }
    g_transport = INVALID_HANDLE_VALUE;
    g_dma_buffer = NULL;
    g_dma_capacity = 0;
    g_batch_bytes = 0;
    g_command_count = 0;
}

static BOOL open_transport_locked(void)
{
    V86GLMapBuffer mapping;
    DWORD returned = 0;

    if (g_dma_buffer)
        return TRUE;
    if (g_transport_failed)
        return FALSE;

    g_transport = CreateFileA(V86GL_DEVICE_DOS_NAME,
            GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL, NULL);
    if (g_transport == INVALID_HANDLE_VALUE) {
        g_transport_failed = TRUE;
        d9wg_log("could not open \\.\\v86gl");
        return FALSE;
    }

    ZeroMemory(&mapping, sizeof(mapping));
    if (!DeviceIoControl(g_transport, V86GL_IOCTL_MAP_BUFFER,
            NULL, 0, &mapping, sizeof(mapping), &returned, NULL)
            || returned != sizeof(mapping)
            || !mapping.user_address
            || mapping.buffer_bytes < sizeof(V86GLDMADesc)
                    + D9_VGL2_RECORD_HEADER_BYTES
                    + sizeof(D9WGBatchHeader)
                    + sizeof(D9WGCommandHeader)) {
        d9wg_log("v86gl MAP_BUFFER failed");
        close_transport_locked();
        g_transport_failed = TRUE;
        return FALSE;
    }

    g_dma_buffer = (uint8_t *)(uintptr_t)mapping.user_address;
    g_dma_capacity = mapping.buffer_bytes;
    reset_batch_locked();
    return TRUE;
}

static BOOL submit_batch_locked(BOOL present)
{
    V86GLDMADesc *descriptor;
    D9WGBatchHeader *batch;
    V86GLSubmit submit;
    uint8_t *outer;
    uint32_t outer_bytes;
    DWORD returned = 0;

    if (!open_transport_locked())
        return FALSE;
    if (g_command_count == 0)
        return TRUE;

    batch = (D9WGBatchHeader *)batch_base();
    batch->frame_id = g_frame_id;
    batch->flags = present ? D9WG_BATCH_FLAG_PRESENT : 0;
    batch->command_count = g_command_count;
    batch->command_bytes = g_batch_bytes - sizeof(*batch);
    batch->session_id_low = g_session_id_low;
    batch->session_id_high = g_session_id_high;

    outer = g_dma_buffer + sizeof(V86GLDMADesc);
    outer[0] = (uint8_t)(V86GL_CTRL_D3D9_BATCH & 0xFFu);
    outer[1] = (uint8_t)(V86GL_CTRL_D3D9_BATCH >> 8);
    outer[2] = 0xFF;
    outer[3] = 0xFF;
    outer[4] = (uint8_t)(g_batch_bytes & 0xFFu);
    outer[5] = (uint8_t)((g_batch_bytes >> 8) & 0xFFu);
    outer[6] = (uint8_t)((g_batch_bytes >> 16) & 0xFFu);
    outer[7] = (uint8_t)((g_batch_bytes >> 24) & 0xFFu);

    outer_bytes = D9_VGL2_RECORD_HEADER_BYTES + g_batch_bytes;
    descriptor = (V86GLDMADesc *)g_dma_buffer;
    descriptor->magic = V86GL_MAGIC;
    descriptor->version = V86GL_VERSION;
    descriptor->flags = 0;
    descriptor->frame_id = g_frame_id;
    descriptor->command_count = 1;
    descriptor->command_bytes = outer_bytes;
    descriptor->reserved0 = D9WG_MAGIC;
    descriptor->reserved1 = 0;

    submit.descriptor_bytes = (uint32_t)sizeof(*descriptor) + outer_bytes;
    submit.flags = 0;
    if (!DeviceIoControl(g_transport, V86GL_IOCTL_SUBMIT,
            &submit, sizeof(submit), NULL, 0, &returned, NULL)) {
        d9wg_log("D9WG batch submit failed");
        close_transport_locked();
        g_transport_failed = TRUE;
        return FALSE;
    }

    if (present)
        ++g_frame_id;
    reset_batch_locked();
    return TRUE;
}

static BOOL reserve_command_locked(uint16_t opcode, uint32_t payload_bytes,
        uint32_t extra_bytes, D9WGCommandHeader **command_out,
        uint8_t **payload_out, uint8_t **extra_out)
{
    uint32_t raw_size;
    uint32_t record_size;
    D9WGCommandHeader *command;

    if (!open_transport_locked())
        return FALSE;
    if (payload_bytes > 0xFFFFFFFFu - sizeof(*command) - extra_bytes)
        return FALSE;
    raw_size = (uint32_t)sizeof(*command) + payload_bytes + extra_bytes;
    record_size = D9WG_ALIGN8(raw_size);
    if (record_size > batch_capacity() - sizeof(D9WGBatchHeader))
        return FALSE;
    if (g_batch_bytes + record_size > batch_capacity()
            && !submit_batch_locked(FALSE))
        return FALSE;

    command = (D9WGCommandHeader *)(batch_base() + g_batch_bytes);
    ZeroMemory(command, record_size);
    command->opcode = opcode;
    command->size = record_size;
    command->sequence = g_sequence++;
    if (command_out)
        *command_out = command;
    if (payload_out)
        *payload_out = (uint8_t *)(command + 1);
    if (extra_out)
        *extra_out = (uint8_t *)(command + 1) + payload_bytes;
    g_batch_bytes += record_size;
    ++g_command_count;
    return TRUE;
}

static BOOL emit_command(uint16_t opcode, const void *payload,
        uint32_t payload_bytes)
{
    uint8_t *destination;
    BOOL result;

    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(opcode, payload_bytes, 0, NULL,
            &destination, NULL);
    if (result && payload_bytes)
        CopyMemory(destination, payload, payload_bytes);
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static BOOL emit_buffer_update(uint32_t handle, uint32_t destination_offset,
        const void *data, uint32_t byte_count, uint32_t lock_flags)
{
    D9WGUpdateBuffer update;
    uint8_t *payload;
    uint8_t *blob;
    BOOL result;

    ZeroMemory(&update, sizeof(update));
    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_UPDATE_BUFFER,
            sizeof(update), byte_count, NULL, &payload, &blob);
    if (result) {
        update.resource_handle = handle;
        update.destination_offset = destination_offset;
        update.byte_count = byte_count;
        update.data_offset = (uint32_t)(blob - batch_base());
        update.lock_flags = lock_flags;
        CopyMemory(payload, &update, sizeof(update));
        if (byte_count)
            CopyMemory(blob, data, byte_count);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

/* ---- format / geometry helpers (format-agnostic; mirrors d3d8proxy) ---- */

static BOOL multiply_u32(UINT left, UINT right, UINT *result)
{
    if (left && right > 0xFFFFFFFFu / left)
        return FALSE;
    *result = left * right;
    return TRUE;
}

static BOOL texture_format_layout(D3DFORMAT format, UINT *block_width,
        UINT *block_height, UINT *block_bytes)
{
    *block_width = 1;
    *block_height = 1;
    switch (format) {
    case D3DFMT_A8R8G8B8:
    case D3DFMT_X8R8G8B8:
        *block_bytes = 4;
        return TRUE;
    case D3DFMT_R5G6B5:
    case D3DFMT_X1R5G5B5:
    case D3DFMT_A1R5G5B5:
    case D3DFMT_A4R4G4B4:
        *block_bytes = 2;
        return TRUE;
    case D3DFMT_L8:
    case D3DFMT_A8:
        *block_bytes = 1;
        return TRUE;
    case D3DFMT_DXT1:
        *block_width = 4;
        *block_height = 4;
        *block_bytes = 8;
        return TRUE;
    case D3DFMT_DXT3:
    case D3DFMT_DXT5:
        *block_width = 4;
        *block_height = 4;
        *block_bytes = 16;
        return TRUE;
    default:
        return FALSE;
    }
}

static BOOL texture_level_layout(D3DFORMAT format, UINT width, UINT height,
        UINT *row_pitch, UINT *row_count, UINT *byte_count)
{
    UINT block_width;
    UINT block_height;
    UINT block_bytes;
    UINT columns;

    if (!texture_format_layout(format, &block_width, &block_height,
            &block_bytes))
        return FALSE;
    columns = (width + block_width - 1u) / block_width;
    *row_count = (height + block_height - 1u) / block_height;
    return multiply_u32(columns, block_bytes, row_pitch)
            && multiply_u32(*row_pitch, *row_count, byte_count);
}

static BOOL supported_texture_format(D3DFORMAT format)
{
    switch (format) {
    case D3DFMT_A8R8G8B8:
    case D3DFMT_X8R8G8B8:
    case D3DFMT_R5G6B5:
    case D3DFMT_X1R5G5B5:
    case D3DFMT_A1R5G5B5:
    case D3DFMT_A4R4G4B4:
    case D3DFMT_L8:
    case D3DFMT_A8:
    case D3DFMT_DXT1:
    case D3DFMT_DXT3:
    case D3DFMT_DXT5:
        return TRUE;
    default:
        return FALSE;
    }
}

static BOOL supported_backbuffer_format(D3DFORMAT format)
{
    return format == D3DFMT_A8R8G8B8 || format == D3DFMT_X8R8G8B8
            || format == D3DFMT_R5G6B5;
}

static UINT full_mip_level_count(UINT width, UINT height)
{
    UINT levels = 1;
    while (width > 1 || height > 1) {
        if (width > 1) width >>= 1;
        if (height > 1) height >>= 1;
        ++levels;
    }
    return levels;
}

static BOOL emit_texture_update(D9Texture *texture, UINT level,
        const RECT *rect)
{
    D9TextureLevel *level_data = &texture->levels[level];
    D9WGUpdateTexture update;
    UINT block_width;
    UINT block_height;
    UINT block_bytes;
    UINT block_x;
    UINT block_y;
    UINT row_bytes;
    UINT row_count;
    UINT data_bytes;
    UINT row;
    uint8_t *payload;
    uint8_t *blob;
    BOOL result;

    if (!texture_format_layout(texture->format, &block_width, &block_height,
            &block_bytes))
        return FALSE;
    block_x = (UINT)rect->left / block_width;
    block_y = (UINT)rect->top / block_height;
    if (!multiply_u32(((UINT)(rect->right - rect->left)
            + block_width - 1u) / block_width, block_bytes, &row_bytes))
        return FALSE;
    row_count = ((UINT)(rect->bottom - rect->top)
            + block_height - 1u) / block_height;
    if (!multiply_u32(row_bytes, row_count, &data_bytes))
        return FALSE;

    ZeroMemory(&update, sizeof(update));
    update.resource_handle = texture->handle;
    update.level = level;
    update.x = (uint32_t)rect->left;
    update.y = (uint32_t)rect->top;
    update.z = 0;
    update.width = (uint32_t)(rect->right - rect->left);
    update.height = (uint32_t)(rect->bottom - rect->top);
    update.depth = 1;
    update.row_pitch = row_bytes;
    update.slice_pitch = 0;
    update.data_bytes = data_bytes;

    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_UPDATE_TEXTURE,
            sizeof(update), data_bytes, NULL, &payload, &blob);
    if (result) {
        update.data_offset = (uint32_t)(blob - batch_base());
        CopyMemory(payload, &update, sizeof(update));
        for (row = 0; row < row_count; ++row) {
            CopyMemory(blob + row * row_bytes,
                    level_data->shadow
                    + (block_y + row) * level_data->row_pitch
                    + block_x * block_bytes, row_bytes);
        }
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static BOOL primitive_element_count(D3DPRIMITIVETYPE type,
        UINT primitive_count, UINT *element_count)
{
    switch (type) {
    case D3DPT_POINTLIST:
        *element_count = primitive_count;
        return TRUE;
    case D3DPT_LINELIST:
        return multiply_u32(primitive_count, 2u, element_count);
    case D3DPT_LINESTRIP:
        if (primitive_count == 0xFFFFFFFFu)
            return FALSE;
        *element_count = primitive_count + 1u;
        return TRUE;
    case D3DPT_TRIANGLELIST:
        return multiply_u32(primitive_count, 3u, element_count);
    case D3DPT_TRIANGLESTRIP:
    case D3DPT_TRIANGLEFAN:
        if (primitive_count > 0xFFFFFFFDu)
            return FALSE;
        *element_count = primitive_count + 2u;
        return TRUE;
    default:
        return FALSE;
    }
}

/* ---- FVF -> vertex declaration (plan section 4.3) ---- */

/*
 * Only the position/normal/diffuse/specular/2D-texcoord subset that M1's
 * fixed pipeline understands. Blended positions (XYZB*), pretransformed
 * XYZW, and non-default (1D/3D/4D) texture coordinate sizes are honestly
 * rejected rather than silently truncated -- FALSE means "SetFVF/CreateVertex
 * Buffer(..., this fvf, ...) should fail with D3DERR_INVALIDCALL", not "best
 * effort".
 */
static BOOL fvf_to_declaration(DWORD fvf, D9WGVertexElement *elements,
        UINT *element_count)
{
    UINT count = 0;
    UINT offset = 0;
    UINT tex_count;
    UINT i;

    if (fvf & D3DFVF_RESERVED0)
        return FALSE;
    if ((fvf & D3DFVF_POSITION_MASK) == D3DFVF_XYZ) {
        elements[count].stream = 0;
        elements[count].offset = (uint16_t)offset;
        elements[count].type = D3DDECLTYPE_FLOAT3;
        elements[count].method = D3DDECLMETHOD_DEFAULT;
        elements[count].usage = D3DDECLUSAGE_POSITION;
        elements[count].usage_index = 0;
        ++count;
        offset += 12;
    } else if ((fvf & D3DFVF_POSITION_MASK) == D3DFVF_XYZRHW) {
        elements[count].stream = 0;
        elements[count].offset = (uint16_t)offset;
        elements[count].type = D3DDECLTYPE_FLOAT4;
        elements[count].method = D3DDECLMETHOD_DEFAULT;
        elements[count].usage = D3DDECLUSAGE_POSITIONT;
        elements[count].usage_index = 0;
        ++count;
        offset += 16;
    } else {
        return FALSE;
    }
    if (fvf & D3DFVF_NORMAL) {
        elements[count].stream = 0;
        elements[count].offset = (uint16_t)offset;
        elements[count].type = D3DDECLTYPE_FLOAT3;
        elements[count].method = D3DDECLMETHOD_DEFAULT;
        elements[count].usage = D3DDECLUSAGE_NORMAL;
        elements[count].usage_index = 0;
        ++count;
        offset += 12;
    }
    if (fvf & D3DFVF_PSIZE) {
        elements[count].stream = 0;
        elements[count].offset = (uint16_t)offset;
        elements[count].type = D3DDECLTYPE_FLOAT1;
        elements[count].method = D3DDECLMETHOD_DEFAULT;
        elements[count].usage = D3DDECLUSAGE_PSIZE;
        elements[count].usage_index = 0;
        ++count;
        offset += 4;
    }
    if (fvf & D3DFVF_DIFFUSE) {
        elements[count].stream = 0;
        elements[count].offset = (uint16_t)offset;
        elements[count].type = D3DDECLTYPE_D3DCOLOR;
        elements[count].method = D3DDECLMETHOD_DEFAULT;
        elements[count].usage = D3DDECLUSAGE_COLOR;
        elements[count].usage_index = 0;
        ++count;
        offset += 4;
    }
    if (fvf & D3DFVF_SPECULAR) {
        elements[count].stream = 0;
        elements[count].offset = (uint16_t)offset;
        elements[count].type = D3DDECLTYPE_D3DCOLOR;
        elements[count].method = D3DDECLMETHOD_DEFAULT;
        elements[count].usage = D3DDECLUSAGE_COLOR;
        elements[count].usage_index = 1;
        ++count;
        offset += 4;
    }
    tex_count = (fvf & D3DFVF_TEXCOUNT_MASK) >> D3DFVF_TEXCOUNT_SHIFT;
    if (tex_count > 8)
        return FALSE;
    for (i = 0; i < tex_count; ++i) {
        DWORD size_bits = (fvf >> (16 + i * 2)) & 0x3u;
        if (size_bits != 0)
            return FALSE; /* non-default (1D/3D/4D) texcoord size: not M1 */
        elements[count].stream = 0;
        elements[count].offset = (uint16_t)offset;
        elements[count].type = D3DDECLTYPE_FLOAT2;
        elements[count].method = D3DDECLMETHOD_DEFAULT;
        elements[count].usage = D3DDECLUSAGE_TEXCOORD;
        elements[count].usage_index = (uint8_t)i;
        ++count;
        offset += 8;
    }
    *element_count = count;
    return TRUE;
}

/* ---- vertex declaration validation ---- */

static BOOL declaration_element_supported(const D3DVERTEXELEMENT9 *e)
{
    if (e->Stream >= D9_MAX_STREAMS || e->Method != D3DDECLMETHOD_DEFAULT)
        return FALSE;
    switch (e->Usage) {
    case D3DDECLUSAGE_POSITION:
    case D3DDECLUSAGE_POSITIONT:
    case D3DDECLUSAGE_NORMAL:
    case D3DDECLUSAGE_COLOR:
    case D3DDECLUSAGE_TEXCOORD:
    case D3DDECLUSAGE_PSIZE:
        break;
    default:
        /* BLENDWEIGHT/BLENDINDICES/TANGENT/BINORMAL/TESSFACTOR/FOG/DEPTH/
         * SAMPLE wait on the skinning/shader milestones (M2/M5). */
        return FALSE;
    }
    switch (e->Type) {
    case D3DDECLTYPE_FLOAT1:
    case D3DDECLTYPE_FLOAT2:
    case D3DDECLTYPE_FLOAT3:
    case D3DDECLTYPE_FLOAT4:
    case D3DDECLTYPE_D3DCOLOR:
        return TRUE;
    default:
        return FALSE;
    }
}

/* Scans the app's D3DDECL_END()-terminated array (sentinel Stream==0xFF),
 * bounded by D3DMAXDECLLENGTH so a missing sentinel can never walk off the
 * app's allocation. On success fills `wire` with the exact wire shape
 * CREATE_VERTEX_DECLARATION/SET_FVF send. */
static BOOL parse_vertex_declaration(const D3DVERTEXELEMENT9 *elements,
        D9WGVertexElement *wire, UINT *count_out)
{
    UINT count = 0;
    while (count < D3DMAXDECLLENGTH && elements[count].Stream != 0xFF) {
        const D3DVERTEXELEMENT9 *e = &elements[count];
        if (!declaration_element_supported(e))
            return FALSE;
        wire[count].stream = e->Stream;
        wire[count].offset = e->Offset;
        wire[count].type = e->Type;
        wire[count].method = e->Method;
        wire[count].usage = e->Usage;
        wire[count].usage_index = e->UsageIndex;
        ++count;
    }
    if (count == D3DMAXDECLLENGTH && elements[count].Stream != 0xFF)
        return FALSE;
    *count_out = count;
    return TRUE;
}

/* ---- resource create/update emitters ---- */

static BOOL emit_vertex_buffer_create(D9Device *device, D9VertexBuffer *buffer)
{
    D9WGCreateBuffer command;
    command.device_handle = device->handle;
    command.resource_handle = buffer->handle;
    command.resource_kind = D9WG_RESOURCE_BUFFER_VERTEX;
    command.byte_count = buffer->length;
    command.usage = buffer->usage;
    command.fvf = buffer->fvf;
    command.pool = buffer->pool;
    command.reserved = 0;
    return emit_command(D9WG_OP_CREATE_BUFFER, &command, sizeof(command));
}

static BOOL emit_index_buffer_create(D9Device *device, D9IndexBuffer *buffer)
{
    D9WGCreateBuffer command;
    command.device_handle = device->handle;
    command.resource_handle = buffer->handle;
    command.resource_kind = D9WG_RESOURCE_BUFFER_INDEX;
    command.byte_count = buffer->length;
    command.usage = buffer->usage;
    command.fvf = (uint32_t)buffer->format;
    command.pool = buffer->pool;
    command.reserved = 0;
    return emit_command(D9WG_OP_CREATE_BUFFER, &command, sizeof(command));
}

static BOOL emit_texture_create(D9Device *device, D9Texture *texture)
{
    D9WGCreateTexture2D command;
    command.device_handle = device->handle;
    command.resource_handle = texture->handle;
    command.width = texture->width;
    command.height = texture->height;
    command.level_count = texture->level_count;
    command.format = texture->format;
    command.usage = texture->usage;
    command.pool = texture->pool;
    return emit_command(D9WG_OP_CREATE_TEXTURE_2D, &command, sizeof(command));
}

static BOOL emit_vertex_declaration_create(D9Device *device, uint32_t handle,
        const D9WGVertexElement *elements, UINT count)
{
    D9WGCreateVertexDeclaration command;
    uint8_t *payload;
    uint8_t *blob;
    uint32_t element_bytes = (uint32_t)count * sizeof(D9WGVertexElement);
    BOOL result;

    command.device_handle = device->handle;
    command.resource_handle = handle;
    command.element_count = count;
    command.reserved = 0;
    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_CREATE_VERTEX_DECLARATION,
            sizeof(command), element_bytes, NULL, &payload, &blob);
    if (result) {
        CopyMemory(payload, &command, sizeof(command));
        if (element_bytes)
            CopyMemory(blob, elements, element_bytes);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static BOOL emit_set_fvf(D9Device *device, DWORD fvf,
        const D9WGVertexElement *elements, UINT count)
{
    D9WGSetFVF command;
    uint8_t *payload;
    uint8_t *blob;
    uint32_t element_bytes = (uint32_t)count * sizeof(D9WGVertexElement);
    BOOL result;

    command.device_handle = device->handle;
    command.fvf = fvf;
    command.element_count = count;
    command.reserved = 0;
    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_SET_FVF,
            sizeof(command), element_bytes, NULL, &payload, &blob);
    if (result) {
        CopyMemory(payload, &command, sizeof(command));
        if (element_bytes)
            CopyMemory(blob, elements, element_bytes);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static BOOL emit_draw_primitive_up(const D9WGDrawPrimitiveUP *draw,
        const void *vertices)
{
    D9WGDrawPrimitiveUP payload_value = *draw;
    uint8_t *payload;
    uint8_t *blob;
    BOOL result;

    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_DRAW_PRIMITIVE_UP,
            sizeof(payload_value), payload_value.vertex_bytes, NULL,
            &payload, &blob);
    if (result) {
        payload_value.vertex_data_offset = (uint32_t)(blob - batch_base());
        CopyMemory(payload, &payload_value, sizeof(payload_value));
        CopyMemory(blob, vertices, payload_value.vertex_bytes);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static BOOL emit_draw_indexed_primitive_up(
        const D9WGDrawIndexedPrimitiveUP *draw, const void *indices,
        const void *vertices)
{
    D9WGDrawIndexedPrimitiveUP payload_value = *draw;
    uint32_t extra_bytes;
    uint8_t *payload;
    uint8_t *blob;
    BOOL result;

    if (payload_value.index_bytes > 0xFFFFFFFFu - payload_value.vertex_bytes)
        return FALSE;
    extra_bytes = payload_value.index_bytes + payload_value.vertex_bytes;
    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_DRAW_INDEXED_PRIMITIVE_UP,
            sizeof(payload_value), extra_bytes, NULL, &payload, &blob);
    if (result) {
        payload_value.index_data_offset = (uint32_t)(blob - batch_base());
        payload_value.vertex_data_offset = payload_value.index_data_offset
                + payload_value.index_bytes;
        CopyMemory(payload, &payload_value, sizeof(payload_value));
        CopyMemory(blob, indices, payload_value.index_bytes);
        CopyMemory(blob + payload_value.index_bytes, vertices,
                payload_value.vertex_bytes);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

/* ---- device lifecycle plumbing ---- */

static void emit_hello_once(void)
{
    D9WGHello hello;

    if (InterlockedCompareExchange((LONG *)&g_hello_emitted, TRUE, FALSE))
        return;
    hello.guest_pointer_bits = 32;
    hello.feature_bits = 0;
    hello.session_id_low = g_session_id_low;
    hello.session_id_high = g_session_id_high;
    emit_command(D9WG_OP_HELLO, &hello, sizeof(hello));
}

static void initialize_session_id(HINSTANCE instance)
{
    FILETIME time;
    LARGE_INTEGER counter;
    DWORD process_id = GetCurrentProcessId();
    DWORD thread_id = GetCurrentThreadId();

    GetSystemTimeAsFileTime(&time);
    if (!QueryPerformanceCounter(&counter)) {
        counter.LowPart = GetTickCount();
        counter.HighPart = process_id ^ thread_id;
    }
    g_session_id_low = time.dwLowDateTime ^ counter.LowPart ^ process_id
            ^ (uint32_t)(uintptr_t)instance;
    g_session_id_high = time.dwHighDateTime ^ counter.HighPart
            ^ GetTickCount() ^ (thread_id * 0x9E3779B9u);
    if (!g_session_id_low && !g_session_id_high)
        g_session_id_high = 0xD9A80001u;
}

static void fill_display_mode(D3DDISPLAYMODE *mode, UINT width, UINT height,
        D3DFORMAT format)
{
    mode->Width = width;
    mode->Height = height;
    mode->RefreshRate = 60;
    mode->Format = format;
}

/*
 * M1 caps are deliberately honest about what is not implemented yet:
 * VertexShaderVersion/PixelShaderVersion report (0,0) -- no programmable
 * shader support until M2 -- and MaxVertexShaderConst/MaxSimultaneousTextures
 * reflect only what the fixed pipeline in this milestone can actually do.
 */
static void fill_caps(D3DCAPS9 *caps)
{
    ZeroMemory(caps, sizeof(*caps));
    caps->DeviceType = D3DDEVTYPE_HAL;
    caps->AdapterOrdinal = D3DADAPTER_DEFAULT;
    caps->Caps2 = D3DCAPS2_CANMANAGERESOURCE;
    caps->PresentationIntervals = D3DPRESENT_INTERVAL_IMMEDIATE
            | D3DPRESENT_INTERVAL_ONE;
    caps->DevCaps = D3DDEVCAPS_HWRASTERIZATION
            | D3DDEVCAPS_HWTRANSFORMANDLIGHT
            | D3DDEVCAPS_DRAWPRIMTLVERTEX
            | D3DDEVCAPS_EXECUTESYSTEMMEMORY
            | D3DDEVCAPS_EXECUTEVIDEOMEMORY
            | D3DDEVCAPS_TEXTURESYSTEMMEMORY
            | D3DDEVCAPS_TEXTUREVIDEOMEMORY;
    caps->PrimitiveMiscCaps = D3DPMISCCAPS_CULLNONE
            | D3DPMISCCAPS_CULLCW | D3DPMISCCAPS_CULLCCW
            | D3DPMISCCAPS_COLORWRITEENABLE | D3DPMISCCAPS_BLENDOP;
    caps->RasterCaps = D3DPRASTERCAPS_ZTEST | D3DPRASTERCAPS_DEPTHBIAS
            | D3DPRASTERCAPS_FOGVERTEX | D3DPRASTERCAPS_FOGTABLE
            | D3DPRASTERCAPS_WFOG | D3DPRASTERCAPS_FOGRANGE;
    caps->ZCmpCaps = 0xFFu;
    caps->SrcBlendCaps = 0x1FFFu;
    caps->DestBlendCaps = 0x1FFFu;
    caps->AlphaCmpCaps = 0xFFu;
    caps->StencilCaps = D3DSTENCILCAPS_KEEP | D3DSTENCILCAPS_ZERO
            | D3DSTENCILCAPS_REPLACE | D3DSTENCILCAPS_INCRSAT
            | D3DSTENCILCAPS_DECRSAT | D3DSTENCILCAPS_INVERT
            | D3DSTENCILCAPS_INCR | D3DSTENCILCAPS_DECR;
    caps->ShadeCaps = D3DPSHADECAPS_COLORGOURAUDRGB
            | D3DPSHADECAPS_FOGGOURAUD | D3DPSHADECAPS_ALPHAGOURAUDBLEND;
    caps->TextureCaps = D3DPTEXTURECAPS_ALPHA | D3DPTEXTURECAPS_MIPMAP
            | D3DPTEXTURECAPS_PERSPECTIVE;
    caps->TextureFilterCaps = D3DPTFILTERCAPS_MINFPOINT
            | D3DPTFILTERCAPS_MINFLINEAR | D3DPTFILTERCAPS_MAGFPOINT
            | D3DPTFILTERCAPS_MAGFLINEAR | D3DPTFILTERCAPS_MIPFPOINT
            | D3DPTFILTERCAPS_MIPFLINEAR;
    caps->TextureAddressCaps = D3DPTADDRESSCAPS_WRAP
            | D3DPTADDRESSCAPS_MIRROR | D3DPTADDRESSCAPS_CLAMP;
    caps->TextureOpCaps = D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1
            | D3DTEXOPCAPS_SELECTARG2 | D3DTEXOPCAPS_MODULATE
            | D3DTEXOPCAPS_MODULATE2X | D3DTEXOPCAPS_MODULATE4X
            | D3DTEXOPCAPS_ADD | D3DTEXOPCAPS_ADDSIGNED
            | D3DTEXOPCAPS_ADDSIGNED2X | D3DTEXOPCAPS_SUBTRACT
            | D3DTEXOPCAPS_ADDSMOOTH | D3DTEXOPCAPS_BLENDDIFFUSEALPHA
            | D3DTEXOPCAPS_BLENDTEXTUREALPHA | D3DTEXOPCAPS_BLENDFACTORALPHA
            | D3DTEXOPCAPS_BLENDTEXTUREALPHAPM
            | D3DTEXOPCAPS_BLENDCURRENTALPHA | D3DTEXOPCAPS_DOTPRODUCT3
            | D3DTEXOPCAPS_MULTIPLYADD | D3DTEXOPCAPS_LERP;
    caps->MaxTextureWidth = 4096;
    caps->MaxTextureHeight = 4096;
    caps->MaxTextureRepeat = 8192;
    caps->MaxTextureAspectRatio = 4096;
    caps->MaxAnisotropy = 1;
    caps->MaxVertexW = 1.0e10f;
    caps->MaxPrimitiveCount = 0xFFFFFu;
    caps->MaxVertexIndex = 0xFFFFFFu;
    caps->MaxStreams = D9_MAX_STREAMS;
    caps->MaxStreamStride = 255;
    /* No programmable shader support until M2: report the honest (0,0)
     * version rather than a real driver's non-zero-but-unsupported value. */
    caps->VertexShaderVersion = (DWORD)D3DVS_VERSION(0, 0);
    caps->MaxVertexShaderConst = 0;
    caps->PixelShaderVersion = (DWORD)D3DPS_VERSION(0, 0);
    caps->FVFCaps = 8u & D3DFVFCAPS_TEXCOORDCOUNTMASK;
    caps->MaxTextureBlendStages = D9_MAX_TEXTURE_STAGES;
    caps->MaxSimultaneousTextures = D9_MAX_TEXTURE_STAGES;
    caps->VertexProcessingCaps = D3DVTXPCAPS_TEXGEN
            | D3DVTXPCAPS_DIRECTIONALLIGHTS | D3DVTXPCAPS_POSITIONALLIGHTS
            | D3DVTXPCAPS_LOCALVIEWER;
    caps->MaxActiveLights = 8;
    caps->MaxUserClipPlanes = 0;
    caps->MaxVertexBlendMatrices = 0;
    caps->NumSimultaneousRTs = 1;
}

static BOOL device_has_reset_blockers(D9Device *device)
{
    D9VertexBuffer *vb;
    D9IndexBuffer *ib;
    D9Texture *texture;
    UINT level;

    if (device->in_scene)
        return TRUE;
    for (vb = device->vertex_buffers; vb; vb = vb->next_device_resource) {
        if (vb->pool == D3DPOOL_DEFAULT || vb->locked)
            return TRUE;
    }
    for (ib = device->index_buffers; ib; ib = ib->next_device_resource) {
        if (ib->pool == D3DPOOL_DEFAULT || ib->locked)
            return TRUE;
    }
    for (texture = device->texture_resources; texture;
            texture = texture->next_device_resource) {
        if (texture->pool == D3DPOOL_DEFAULT)
            return TRUE;
        for (level = 0; level < texture->level_count; ++level) {
            if (texture->levels[level].locked)
                return TRUE;
        }
    }
    return FALSE;
}

static void device_clear_bindings(D9Device *device)
{
    UINT index;
    for (index = 0; index < D9_MAX_STREAMS; ++index) {
        D9VertexBuffer *buffer = device->streams[index].buffer;
        device->streams[index].buffer = NULL;
        device->streams[index].stride = 0;
        if (buffer) IDirect3DVertexBuffer9_Release(&buffer->iface);
    }
    if (device->index_buffer) {
        D9IndexBuffer *buffer = device->index_buffer;
        device->index_buffer = NULL;
        IDirect3DIndexBuffer9_Release(&buffer->iface);
    }
    for (index = 0; index < D9_MAX_TEXTURE_STAGES; ++index) {
        D9Texture *texture = device->textures[index];
        device->textures[index] = NULL;
        if (texture) IDirect3DTexture9_Release(&texture->iface);
    }
    if (device->vertex_declaration) {
        D9VertexDeclaration *decl = device->vertex_declaration;
        device->vertex_declaration = NULL;
        IDirect3DVertexDeclaration9_Release(&decl->iface);
    }
    device->fvf = 0;
}

static void device_release_owned_references(D9Device *device)
{
    device_clear_bindings(device);
}

static BOOL recreate_device_resources(D9Device *device)
{
    D9VertexBuffer *vb;
    D9IndexBuffer *ib;
    D9Texture *texture;
    D9VertexDeclaration *decl;
    UINT level;

    for (vb = device->vertex_buffers; vb; vb = vb->next_device_resource) {
        vb->handle = allocate_handle();
        if (!emit_vertex_buffer_create(device, vb)
                || !emit_buffer_update(vb->handle, 0, vb->shadow,
                        vb->length, 0))
            return FALSE;
    }
    for (ib = device->index_buffers; ib; ib = ib->next_device_resource) {
        ib->handle = allocate_handle();
        if (!emit_index_buffer_create(device, ib)
                || !emit_buffer_update(ib->handle, 0, ib->shadow,
                        ib->length, 0))
            return FALSE;
    }
    for (texture = device->texture_resources; texture;
            texture = texture->next_device_resource) {
        texture->handle = allocate_handle();
        if (!emit_texture_create(device, texture)) return FALSE;
        for (level = 0; level < texture->level_count; ++level) {
            RECT full;
            SetRect(&full, 0, 0, (int)texture->levels[level].width,
                    (int)texture->levels[level].height);
            if (!emit_texture_update(texture, level, &full)) return FALSE;
        }
    }
    for (decl = device->vertex_declarations; decl;
            decl = decl->next_device_resource) {
        D9WGVertexElement wire[D3DMAXDECLLENGTH];
        UINT i;
        decl->handle = allocate_handle();
        for (i = 0; i < decl->element_count; ++i) {
            wire[i].stream = decl->elements[i].Stream;
            wire[i].offset = decl->elements[i].Offset;
            wire[i].type = decl->elements[i].Type;
            wire[i].method = decl->elements[i].Method;
            wire[i].usage = decl->elements[i].Usage;
            wire[i].usage_index = decl->elements[i].UsageIndex;
        }
        if (!emit_vertex_declaration_create(device, decl->handle, wire,
                decl->element_count))
            return FALSE;
    }
    return TRUE;
}

static void device_child_add_ref(D9Device *device)
{
    InterlockedIncrement(&device->child_parent_refs);
    IDirect3DDevice9_AddRef(&device->iface);
}

static void device_child_release(D9Device *device)
{
    InterlockedDecrement(&device->child_parent_refs);
    IDirect3DDevice9_Release(&device->iface);
}

static void device_init_states(D9Device *device)
{
    UINT slot;
    ZeroMemory(device->render_states, sizeof(device->render_states));
    ZeroMemory(device->texture_stage_states,
            sizeof(device->texture_stage_states));
    for (slot = 0; slot < D9_MAX_TRANSFORMS; ++slot) {
        ZeroMemory(device->transforms[slot], sizeof(device->transforms[slot]));
        device->transforms[slot][0] = 1.0f;
        device->transforms[slot][5] = 1.0f;
        device->transforms[slot][10] = 1.0f;
        device->transforms[slot][15] = 1.0f;
    }
}

/* ---- IDirect3D9 ---- */

static HRESULT WINAPI d3d_query_interface(IDirect3D9 *iface, REFIID iid,
        void **object)
{
    if (!object)
        return E_POINTER;
    *object = NULL;
    if (!iid || (!iid_is_unknown(iid) && !guid_equal(iid, &IID_IDirect3D9))) {
        /* An app probing for IDirect3D9Ex (or anything else we do not
         * expose) and reacting to the refusal is another way to bail out
         * before CreateDevice; log the GUID so it is identifiable. */
        TRACE_PROBE({
            char line[160];
            if (iid) {
                wsprintfA(line,
                        "d3d_query_interface E_NOINTERFACE "
                        "{%08lX-%04X-%04X-%02X%02X%02X%02X%02X%02X%02X%02X}",
                        (unsigned long)iid->Data1, iid->Data2, iid->Data3,
                        iid->Data4[0], iid->Data4[1], iid->Data4[2],
                        iid->Data4[3], iid->Data4[4], iid->Data4[5],
                        iid->Data4[6], iid->Data4[7]);
            } else {
                lstrcpynA(line, "d3d_query_interface(iid=NULL)", sizeof(line));
            }
            d9wg_log(line);
        });
        return E_NOINTERFACE;
    }
    *object = iface;
    IDirect3D9_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI d3d_add_ref(IDirect3D9 *iface)
{
    return (ULONG)InterlockedIncrement(&d3d_from_iface(iface)->refcount);
}

static ULONG WINAPI d3d_release(IDirect3D9 *iface)
{
    D9Direct3D *d3d = d3d_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&d3d->refcount);
    if (!refs) {
        /* Distinguishes "the app inspected us, decided against us, and tidily
         * let go" from "it hung or crashed mid-probe": only the former
         * reaches a zero refcount. */
        TRACE_ONCE("d3d_release: IDirect3D9 refcount reached 0");
        HeapFree(GetProcessHeap(), 0, d3d);
    }
    return refs;
}

static HRESULT WINAPI d3d_register_software_device(IDirect3D9 *iface,
        void *initialize)
{
    (void)iface; (void)initialize;
    TRACE_ONCE("d3d_register_software_device -> INVALIDCALL");
    return D3DERR_INVALIDCALL;
}

static UINT WINAPI d3d_get_adapter_count(IDirect3D9 *iface)
{
    (void)iface;
    TRACE_ONCE("d3d_get_adapter_count -> 1");
    return 1;
}

static HRESULT WINAPI d3d_get_adapter_identifier(IDirect3D9 *iface,
        UINT adapter, DWORD flags, D3DADAPTER_IDENTIFIER9 *identifier)
{
    (void)iface; (void)flags;
    TRACE_ONCE("d3d_get_adapter_identifier");
    if (adapter || !identifier)
        return D3DERR_INVALIDCALL;
    ZeroMemory(identifier, sizeof(*identifier));
    /*
     * Fields other than the identity triple are the same in every variant:
     * no real driver reports an all-zero DriverVersion, an all-zero
     * DeviceIdentifier GUID (apps cache it to notice a driver change) or an
     * empty DeviceName, and a caller that sanity-checks the struct would
     * reject those regardless of which card we claim to be.
     */
    lstrcpynA(identifier->DeviceName, "\\\\.\\DISPLAY1",
            sizeof(identifier->DeviceName));
#if D9_ADAPTER_IDENTITY == D9_ADAPTER_GEFORCE4_MX
    /* NV17. Hardware T&L, no programmable shaders -- the one widely-known
     * card whose real capabilities match what fill_caps() reports. */
    lstrcpynA(identifier->Driver, "nv4_disp.dll", sizeof(identifier->Driver));
    lstrcpynA(identifier->Description, "NVIDIA GeForce4 MX 440",
            sizeof(identifier->Description));
    identifier->VendorId = 0x10DE;
    identifier->DeviceId = 0x0171;
    identifier->SubSysId = 0x017110DE;
    identifier->Revision = 0xA3;
    /* ForceWare 45.23, a real driver revision for this card on XP. */
    identifier->DriverVersion.HighPart = (6 << 16) | 14;
    identifier->DriverVersion.LowPart = (10 << 16) | 4523;
#elif D9_ADAPTER_IDENTITY == D9_ADAPTER_VMWARE_SVGA
    lstrcpynA(identifier->Driver, "vm3dum.dll", sizeof(identifier->Driver));
    lstrcpynA(identifier->Description, "VMware SVGA 3D",
            sizeof(identifier->Description));
    identifier->VendorId = 0x15AD;
    identifier->DeviceId = 0x0405;
    identifier->SubSysId = 0x040515AD;
    identifier->Revision = 0;
    identifier->DriverVersion.HighPart = (6 << 16) | 14;
    identifier->DriverVersion.LowPart = (1 << 16) | 1264;
#else
    lstrcpynA(identifier->Driver, "d3d9-webgpu.dll",
            sizeof(identifier->Driver));
    lstrcpynA(identifier->Description, "v86 Direct3D 9 WebGPU Adapter",
            sizeof(identifier->Description));
    identifier->VendorId = 0x1234;
    identifier->DeviceId = 0x5687;
    identifier->SubSysId = 0x56871234;
    identifier->Revision = 1;
    /* product.version.subversion.build packed as two DWORDs, the way real
     * drivers report it (here 6.14.10.6764, a plausible XP-era driver). */
    identifier->DriverVersion.HighPart = (6 << 16) | 14;
    identifier->DriverVersion.LowPart = (10 << 16) | 6764;
#endif
    /* Stable and non-zero; derived from the identity so switching variants
     * also looks like a different driver, which is what an app caching this
     * field would expect. */
    identifier->DeviceIdentifier.Data1 = 0xD9E60000u | identifier->DeviceId;
    identifier->DeviceIdentifier.Data2 = (WORD)identifier->VendorId;
    identifier->DeviceIdentifier.Data3 = (WORD)identifier->DeviceId;
    identifier->DeviceIdentifier.Data4[0] = 0x9A;
    identifier->DeviceIdentifier.Data4[1] = 0xB1;
    identifier->DeviceIdentifier.Data4[2] = 0xC2;
    identifier->DeviceIdentifier.Data4[3] = 0xD3;
    identifier->DeviceIdentifier.Data4[4] = 0xE4;
    identifier->DeviceIdentifier.Data4[5] = 0xF5;
    identifier->DeviceIdentifier.Data4[6] = 0x06;
    identifier->DeviceIdentifier.Data4[7] = 0x17;
    /* 1 = WHQL-signed but no date info, rather than 0 = "not certified",
     * which some titles treat as an unusable/blacklisted driver. */
    identifier->WHQLLevel = 1;
    TRACE_FIRST({
        char line[192];
        wsprintfA(line, "  reporting adapter: %s (vendor=0x%04lX device=0x%04lX)",
                identifier->Description, (unsigned long)identifier->VendorId,
                (unsigned long)identifier->DeviceId);
        d9wg_log(line);
    });
    return D3D_OK;
}

static UINT WINAPI d3d_get_adapter_mode_count(IDirect3D9 *iface, UINT adapter,
        D3DFORMAT format)
{
    (void)iface;
    TRACE_PROBE({
        char line[128];
        wsprintfA(line, "d3d_get_adapter_mode_count(adapter=%lu format=%lu) -> %lu",
                (unsigned long)adapter, (unsigned long)format,
                (unsigned long)((adapter || (format != D3DFMT_X8R8G8B8
                        && format != D3DFMT_R5G6B5)) ? 0 : 3));
        d9wg_log(line);
    });
    if (adapter || (format != D3DFMT_X8R8G8B8 && format != D3DFMT_R5G6B5))
        return 0;
    return 3;
}

static HRESULT WINAPI d3d_enum_adapter_modes(IDirect3D9 *iface, UINT adapter,
        D3DFORMAT format, UINT index, D3DDISPLAYMODE *mode)
{
    static const struct { UINT width; UINT height; } sizes[] = {
        { 640, 480 }, { 800, 600 }, { 1024, 768 }
    };
    (void)iface;
    TRACE_PROBE({
        char line[128];
        wsprintfA(line, "d3d_enum_adapter_modes(format=%lu index=%lu)",
                (unsigned long)format, (unsigned long)index);
        d9wg_log(line);
    });
    if (adapter || !mode || (format != D3DFMT_X8R8G8B8
            && format != D3DFMT_R5G6B5)
            || index >= sizeof(sizes) / sizeof(sizes[0]))
        return D3DERR_INVALIDCALL;
    fill_display_mode(mode, sizes[index].width, sizes[index].height, format);
    return D3D_OK;
}

static HRESULT WINAPI d3d_get_adapter_display_mode(IDirect3D9 *iface,
        UINT adapter, D3DDISPLAYMODE *mode)
{
    (void)iface;
    TRACE_ONCE("d3d_get_adapter_display_mode -> 1024x768 X8R8G8B8");
    if (adapter || !mode)
        return D3DERR_INVALIDCALL;
    fill_display_mode(mode, 1024, 768, D3DFMT_X8R8G8B8);
    return D3D_OK;
}

/*
 * M1 does not implement depth testing at all (no depth attachment exists on
 * the host side yet), so this list is not a claim about what the renderer
 * honours -- it is only about which AutoDepthStencilFormat values are
 * allowed to get past CreateDevice. Restricting it to D16/D24S8 made
 * CreateDevice fail outright for the very common case of a game asking for
 * D24X8 (depth, no stencil), which is a much worse outcome than the already
 * documented "depth is ignored" boundary: the app cannot render anything at
 * all rather than rendering without depth. Widening it keeps the same
 * honesty level for every format instead of only two.
 */
static BOOL supported_depth_stencil_format(D3DFORMAT format)
{
    switch (format) {
    case D3DFMT_D16:
    case D3DFMT_D16_LOCKABLE:
    case D3DFMT_D15S1:
    case D3DFMT_D24S8:
    case D3DFMT_D24X8:
    case D3DFMT_D24X4S4:
    case D3DFMT_D32:
        return TRUE;
    default:
        return FALSE;
    }
}

static HRESULT WINAPI d3d_check_device_type(IDirect3D9 *iface, UINT adapter,
        D3DDEVTYPE type, D3DFORMAT display_format,
        D3DFORMAT backbuffer_format, WINBOOL windowed)
{
    BOOL ok;
    (void)iface; (void)windowed;
    ok = !adapter && type == D3DDEVTYPE_HAL
            && (display_format == D3DFMT_X8R8G8B8
                || display_format == D3DFMT_R5G6B5)
            && supported_backbuffer_format(backbuffer_format);
    TRACE_PROBE({
        char line[176];
        wsprintfA(line,
                "d3d_check_device_type(adapter=%lu type=%lu display=%lu "
                "backbuffer=%lu windowed=%lu) -> %s",
                (unsigned long)adapter, (unsigned long)type,
                (unsigned long)display_format,
                (unsigned long)backbuffer_format, (unsigned long)windowed,
                ok ? "OK" : "NOTAVAILABLE");
        d9wg_log(line);
    });
    return ok ? D3D_OK : D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_check_device_format(IDirect3D9 *iface,
        UINT adapter, D3DDEVTYPE type, D3DFORMAT adapter_format,
        DWORD usage, D3DRESOURCETYPE resource_type, D3DFORMAT format)
{
    BOOL ok = FALSE;
    (void)iface; (void)adapter_format;
    if (!adapter && type == D3DDEVTYPE_HAL) {
        if (resource_type == D3DRTYPE_TEXTURE
                && !(usage & (D3DUSAGE_RENDERTARGET | D3DUSAGE_DEPTHSTENCIL))
                && supported_texture_format(format))
            ok = TRUE;
        else if (resource_type == D3DRTYPE_SURFACE
                && (usage & D3DUSAGE_DEPTHSTENCIL)
                && supported_depth_stencil_format(format))
            ok = TRUE;
    }
    /* The likeliest place for a game to decide this adapter is unusable and
     * silently give up before ever calling CreateDevice, so log the full
     * argument tuple for accepted *and* rejected probes -- the rejected set
     * is what tells us which capability to add next. */
    TRACE_PROBE({
        char line[192];
        wsprintfA(line,
                "d3d_check_device_format(type=%lu adapterFmt=%lu usage=0x%08lX "
                "rtype=%lu fmt=%lu) -> %s",
                (unsigned long)type, (unsigned long)adapter_format,
                (unsigned long)usage, (unsigned long)resource_type,
                (unsigned long)format, ok ? "OK" : "NOTAVAILABLE");
        d9wg_log(line);
    });
    return ok ? D3D_OK : D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_check_multisample(IDirect3D9 *iface, UINT adapter,
        D3DDEVTYPE type, D3DFORMAT format, WINBOOL windowed,
        D3DMULTISAMPLE_TYPE multisample, DWORD *quality_levels)
{
    BOOL ok;
    (void)iface; (void)format; (void)windowed;
    if (quality_levels) *quality_levels = 1;
    ok = !adapter && type == D3DDEVTYPE_HAL
            && multisample == D3DMULTISAMPLE_NONE;
    TRACE_PROBE({
        char line[160];
        wsprintfA(line,
                "d3d_check_multisample(fmt=%lu windowed=%lu multisample=%lu) -> %s",
                (unsigned long)format, (unsigned long)windowed,
                (unsigned long)multisample, ok ? "OK" : "NOTAVAILABLE");
        d9wg_log(line);
    });
    return ok ? D3D_OK : D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_check_depth_stencil(IDirect3D9 *iface,
        UINT adapter, D3DDEVTYPE type, D3DFORMAT adapter_format,
        D3DFORMAT render_format, D3DFORMAT depth_format)
{
    BOOL ok;
    (void)iface; (void)adapter_format; (void)render_format;
    ok = !adapter && type == D3DDEVTYPE_HAL
            && supported_depth_stencil_format(depth_format);
    TRACE_PROBE({
        char line[176];
        wsprintfA(line,
                "d3d_check_depth_stencil(adapterFmt=%lu renderFmt=%lu "
                "depthFmt=%lu) -> %s",
                (unsigned long)adapter_format, (unsigned long)render_format,
                (unsigned long)depth_format, ok ? "OK" : "NOTAVAILABLE");
        d9wg_log(line);
    });
    return ok ? D3D_OK : D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_check_device_format_conversion(IDirect3D9 *iface,
        UINT adapter, D3DDEVTYPE type, D3DFORMAT source, D3DFORMAT target)
{
    (void)iface;
    if (adapter || type != D3DDEVTYPE_HAL)
        return D3DERR_NOTAVAILABLE;
    return source == target ? D3D_OK : D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_get_device_caps(IDirect3D9 *iface, UINT adapter,
        D3DDEVTYPE type, D3DCAPS9 *caps)
{
    (void)iface;
    if (adapter || type != D3DDEVTYPE_HAL || !caps) {
        TRACE_FIRST({
            char line[128];
            wsprintfA(line, "d3d_get_device_caps REJECTED adapter=%lu type=%lu",
                    (unsigned long)adapter, (unsigned long)type);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    fill_caps(caps);
    /* Dump the values an engine is most likely to gate its renderer on, so a
     * "caps looked unusable, gave up" bail-out is visible in the trace
     * rather than having to be inferred from the absence of CreateDevice. */
    TRACE_FIRST({
        char line[192];
        wsprintfA(line,
                "d3d_get_device_caps: VS=0x%08lX PS=0x%08lX DevCaps=0x%08lX "
                "TexCaps=0x%08lX MaxTexW=%lu Stages=%lu SimulTex=%lu",
                (unsigned long)caps->VertexShaderVersion,
                (unsigned long)caps->PixelShaderVersion,
                (unsigned long)caps->DevCaps,
                (unsigned long)caps->TextureCaps,
                (unsigned long)caps->MaxTextureWidth,
                (unsigned long)caps->MaxTextureBlendStages,
                (unsigned long)caps->MaxSimultaneousTextures);
        d9wg_log(line);
        wsprintfA(line,
                "d3d_get_device_caps: RasterCaps=0x%08lX SrcBlend=0x%08lX "
                "DestBlend=0x%08lX TexOpCaps=0x%08lX MaxStreams=%lu "
                "MaxPrimCount=%lu",
                (unsigned long)caps->RasterCaps,
                (unsigned long)caps->SrcBlendCaps,
                (unsigned long)caps->DestBlendCaps,
                (unsigned long)caps->TextureOpCaps,
                (unsigned long)caps->MaxStreams,
                (unsigned long)caps->MaxPrimitiveCount);
        d9wg_log(line);
    });
    return D3D_OK;
}

static HMONITOR WINAPI d3d_get_adapter_monitor(IDirect3D9 *iface, UINT adapter)
{
    (void)iface;
    if (adapter)
        return NULL;
    return MonitorFromWindow(NULL, MONITOR_DEFAULTTOPRIMARY);
}

static HRESULT WINAPI d3d_create_device(IDirect3D9 *iface, UINT adapter,
        D3DDEVTYPE type, HWND focus_window, DWORD behavior,
        D3DPRESENT_PARAMETERS *parameters,
        IDirect3DDevice9 **device_out)
{
    D9Direct3D *d3d = d3d_from_iface(iface);
    D9Device *device;
    D9WGCreateDevice command;
    HWND window;
    RECT client;
    POINT origin;

    if (parameters) {
        char line[160];
        wsprintfA(line,
                "d3d_create_device(adapter=%lu type=%lu behavior=0x%08lX "
                "%lux%lu fmt=%lu windowed=%lu multisample=%lu autoDS=%lu)",
                (unsigned long)adapter, (unsigned long)type,
                (unsigned long)behavior,
                (unsigned long)parameters->BackBufferWidth,
                (unsigned long)parameters->BackBufferHeight,
                (unsigned long)parameters->BackBufferFormat,
                (unsigned long)parameters->Windowed,
                (unsigned long)parameters->MultiSampleType,
                (unsigned long)parameters->EnableAutoDepthStencil);
        TRACE_ONCE(line);
    } else {
        TRACE_ONCE("d3d_create_device(parameters=NULL)");
    }
    if (!device_out)
        return D3DERR_INVALIDCALL;
    *device_out = NULL;
    if (adapter || type != D3DDEVTYPE_HAL || !parameters)
        return D3DERR_INVALIDCALL;
    if (parameters->MultiSampleType != D3DMULTISAMPLE_NONE)
        return D3DERR_NOTAVAILABLE;
    if (parameters->EnableAutoDepthStencil
            && !supported_depth_stencil_format(
                    parameters->AutoDepthStencilFormat))
        return D3DERR_NOTAVAILABLE;
    if (parameters->BackBufferFormat != D3DFMT_UNKNOWN
            && !supported_backbuffer_format(parameters->BackBufferFormat))
        return D3DERR_NOTAVAILABLE;
    if (parameters->BackBufferWidth > 8192
            || parameters->BackBufferHeight > 8192)
        return D3DERR_INVALIDCALL;
    if (parameters->BackBufferCount > 3)
        return D3DERR_INVALIDCALL;

    device = (D9Device *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*device));
    if (!device)
        return E_OUTOFMEMORY;
    device->iface.lpVtbl = &g_device_vtbl;
    device->refcount = 1;
    device->parent = d3d;
    IDirect3D9_AddRef(iface);
    device->handle = allocate_handle();
    device->present = *parameters;
    device->creation.AdapterOrdinal = adapter;
    device->creation.DeviceType = type;
    device->creation.hFocusWindow = focus_window;
    device->creation.BehaviorFlags = behavior;
    fill_display_mode(&device->display_mode,
            parameters->BackBufferWidth ? parameters->BackBufferWidth : 640,
            parameters->BackBufferHeight ? parameters->BackBufferHeight : 480,
            parameters->BackBufferFormat == D3DFMT_UNKNOWN
                    ? D3DFMT_X8R8G8B8 : parameters->BackBufferFormat);
    device->viewport.X = 0;
    device->viewport.Y = 0;
    device->viewport.Width = device->display_mode.Width;
    device->viewport.Height = device->display_mode.Height;
    device->viewport.MinZ = 0.0f;
    device->viewport.MaxZ = 1.0f;
    device_init_states(device);

    window = parameters->hDeviceWindow ? parameters->hDeviceWindow
            : focus_window;
    SetRect(&client, 0, 0, (int)device->display_mode.Width,
            (int)device->display_mode.Height);
    origin.x = 0;
    origin.y = 0;
    if (window) {
        GetClientRect(window, &client);
        ClientToScreen(window, &origin);
    }
    command.device_handle = device->handle;
    command.hwnd = (uint32_t)(uintptr_t)window;
    command.x = origin.x;
    command.y = origin.y;
    command.width = parameters->BackBufferWidth
            ? parameters->BackBufferWidth : (uint32_t)(client.right - client.left);
    command.height = parameters->BackBufferHeight
            ? parameters->BackBufferHeight : (uint32_t)(client.bottom - client.top);
    if (!command.width) command.width = 640;
    if (!command.height) command.height = 480;
    command.backbuffer_format = device->display_mode.Format;
    command.windowed = parameters->Windowed;
    command.behavior_flags = behavior;
    command.enable_auto_depth_stencil = parameters->EnableAutoDepthStencil;
    command.auto_depth_stencil_format = parameters->AutoDepthStencilFormat;
    if (!emit_command(D9WG_OP_CREATE_DEVICE, &command, sizeof(command))) {
        IDirect3D9_Release(iface);
        HeapFree(GetProcessHeap(), 0, device);
        return D3DERR_DRIVERINTERNALERROR;
    }
    {
        char line[128];
        wsprintfA(line,
                "d3d_create_device -> D3D_OK handle=%lu %lux%lu fmt=%lu windowed=%lu",
                (unsigned long)device->handle, (unsigned long)command.width,
                (unsigned long)command.height,
                (unsigned long)command.backbuffer_format,
                (unsigned long)command.windowed);
        TRACE_ONCE(line);
    }
    *device_out = &device->iface;
    return D3D_OK;
}

/* ---- IDirect3DDevice9: COM + lifecycle ---- */

static HRESULT WINAPI device_query_interface(IDirect3DDevice9 *iface,
        REFIID iid, void **object)
{
    if (!object)
        return E_POINTER;
    *object = NULL;
    if (!iid || (!iid_is_unknown(iid)
            && !guid_equal(iid, &IID_IDirect3DDevice9)))
        return E_NOINTERFACE;
    *object = iface;
    IDirect3DDevice9_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI device_add_ref(IDirect3DDevice9 *iface)
{
    return (ULONG)InterlockedIncrement(&device_from_iface(iface)->refcount);
}

static ULONG WINAPI device_release(IDirect3DDevice9 *iface)
{
    D9Device *device = device_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&device->refcount);

    if (device->releasing_owned_refs)
        return refs;
    if ((LONG)refs == InterlockedCompareExchange(
            &device->child_parent_refs, 0, 0)) {
        device->releasing_owned_refs = TRUE;
        device_release_owned_references(device);
        device->releasing_owned_refs = FALSE;
        refs = (ULONG)InterlockedCompareExchange(&device->refcount, 0, 0);
    }
    if (!refs) {
        D9WGDestroyResource destroy;
        destroy.resource_handle = device->handle;
        destroy.resource_kind = 0;
        emit_command(D9WG_OP_DESTROY_RESOURCE, &destroy, sizeof(destroy));
        EnterCriticalSection(&g_transport_lock);
        if (g_command_count)
            submit_batch_locked(FALSE);
        LeaveCriticalSection(&g_transport_lock);
        IDirect3D9_Release(&device->parent->iface);
        HeapFree(GetProcessHeap(), 0, device);
    }
    return refs;
}

static HRESULT WINAPI device_test_cooperative_level(IDirect3DDevice9 *iface)
{
    (void)iface;
    return D3D_OK;
}

static UINT WINAPI device_get_available_texture_mem(IDirect3DDevice9 *iface)
{
    (void)iface;
    return 256u * 1024u * 1024u;
}

static HRESULT WINAPI device_evict_managed_resources(IDirect3DDevice9 *iface)
{
    (void)iface;
    return D3D_OK;
}

static HRESULT WINAPI device_get_direct3d(IDirect3DDevice9 *iface,
        IDirect3D9 **d3d_out)
{
    D9Device *device = device_from_iface(iface);
    if (!d3d_out)
        return D3DERR_INVALIDCALL;
    *d3d_out = &device->parent->iface;
    IDirect3D9_AddRef(*d3d_out);
    return D3D_OK;
}

static HRESULT WINAPI device_get_caps(IDirect3DDevice9 *iface, D3DCAPS9 *caps)
{
    (void)iface;
    if (!caps)
        return D3DERR_INVALIDCALL;
    fill_caps(caps);
    return D3D_OK;
}

static HRESULT WINAPI device_get_display_mode(IDirect3DDevice9 *iface,
        UINT swapchain, D3DDISPLAYMODE *mode)
{
    D9Device *device = device_from_iface(iface);
    if (swapchain || !mode)
        return D3DERR_INVALIDCALL;
    *mode = device->display_mode;
    return D3D_OK;
}

static HRESULT WINAPI device_get_creation_parameters(IDirect3DDevice9 *iface,
        D3DDEVICE_CREATION_PARAMETERS *parameters)
{
    D9Device *device = device_from_iface(iface);
    if (!parameters)
        return D3DERR_INVALIDCALL;
    *parameters = device->creation;
    return D3D_OK;
}

static void WINAPI device_set_cursor_position(IDirect3DDevice9 *iface,
        int x, int y, DWORD flags)
{ (void)iface; (void)x; (void)y; (void)flags; }

static WINBOOL WINAPI device_show_cursor(IDirect3DDevice9 *iface,
        WINBOOL show)
{ (void)iface; (void)show; return FALSE; }

static UINT WINAPI device_get_number_of_swap_chains(IDirect3DDevice9 *iface)
{ (void)iface; return 1; }

static HRESULT WINAPI device_reset(IDirect3DDevice9 *iface,
        D3DPRESENT_PARAMETERS *parameters)
{
    D9Device *device = device_from_iface(iface);
    D9WGResetDevice reset;
    RECT client;
    POINT origin;
    HWND window;

    TRACE_ONCE("device_reset(...)");
    if (!parameters || parameters->MultiSampleType != D3DMULTISAMPLE_NONE
            || parameters->BackBufferCount > 1
            || device_has_reset_blockers(device))
        return D3DERR_INVALIDCALL;
    if (parameters->EnableAutoDepthStencil
            && !supported_depth_stencil_format(
                    parameters->AutoDepthStencilFormat))
        return D3DERR_NOTAVAILABLE;
    if (parameters->BackBufferFormat != D3DFMT_UNKNOWN
            && !supported_backbuffer_format(parameters->BackBufferFormat))
        return D3DERR_NOTAVAILABLE;
    window = parameters->hDeviceWindow ? parameters->hDeviceWindow
            : device->creation.hFocusWindow;
    SetRect(&client, 0, 0, 640, 480);
    origin.x = origin.y = 0;
    if (window) {
        GetClientRect(window, &client);
        ClientToScreen(window, &origin);
    }
    ZeroMemory(&reset, sizeof(reset));
    reset.old_device_handle = device->handle;
    reset.new_device_handle = allocate_handle();
    reset.hwnd = (uint32_t)(uintptr_t)window;
    reset.x = origin.x;
    reset.y = origin.y;
    reset.width = parameters->BackBufferWidth
            ? parameters->BackBufferWidth : (uint32_t)(client.right - client.left);
    reset.height = parameters->BackBufferHeight
            ? parameters->BackBufferHeight : (uint32_t)(client.bottom - client.top);
    if (!reset.width) reset.width = device->display_mode.Width;
    if (!reset.height) reset.height = device->display_mode.Height;
    reset.backbuffer_format = parameters->BackBufferFormat == D3DFMT_UNKNOWN
            ? device->display_mode.Format : parameters->BackBufferFormat;
    reset.windowed = parameters->Windowed;
    reset.behavior_flags = device->creation.BehaviorFlags;
    reset.enable_auto_depth_stencil = parameters->EnableAutoDepthStencil;
    reset.auto_depth_stencil_format = parameters->AutoDepthStencilFormat;
    if (reset.width > 8192 || reset.height > 8192)
        return D3DERR_INVALIDCALL;
    if (!emit_command(D9WG_OP_RESET, &reset, sizeof(reset)))
        return D3DERR_DRIVERINTERNALERROR;
    device_clear_bindings(device);
    device->handle = reset.new_device_handle;
    ++device->reset_epoch;
    device->present = *parameters;
    fill_display_mode(&device->display_mode, reset.width, reset.height,
            reset.backbuffer_format);
    device_init_states(device);
    device->viewport.X = device->viewport.Y = 0;
    device->viewport.Width = reset.width;
    device->viewport.Height = reset.height;
    device->viewport.MinZ = 0.0f;
    device->viewport.MaxZ = 1.0f;
    if (!recreate_device_resources(device))
        return D3DERR_DRIVERINTERNALERROR;
    TRACE_ONCE("device_reset -> D3D_OK");
    return D3D_OK;
}

static BOOL emit_present_and_flush(D9Device *device, HWND override_window)
{
    D9WGPresent present;
    HWND window = override_window ? override_window
            : device->present.hDeviceWindow;
    RECT client;
    POINT origin;
    uint8_t *payload;
    BOOL result;

    if (!window)
        window = device->creation.hFocusWindow;
    SetRect(&client, 0, 0, (int)device->display_mode.Width,
            (int)device->display_mode.Height);
    origin.x = 0;
    origin.y = 0;
    if (window) {
        GetClientRect(window, &client);
        ClientToScreen(window, &origin);
    }
    present.device_handle = device->handle;
    present.hwnd = (uint32_t)(uintptr_t)window;
    present.x = origin.x;
    present.y = origin.y;
    present.width = (uint32_t)(client.right - client.left);
    present.height = (uint32_t)(client.bottom - client.top);

    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_PRESENT, sizeof(present), 0,
            NULL, &payload, NULL);
    if (result) {
        CopyMemory(payload, &present, sizeof(present));
        result = submit_batch_locked(TRUE);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static HRESULT WINAPI device_present(IDirect3DDevice9 *iface,
        const RECT *src_rect, const RECT *dst_rect, HWND override_window,
        const RGNDATA *dirty_region)
{
    BOOL ok;
    (void)src_rect; (void)dst_rect; (void)dirty_region;
    TRACE_ONCE("device_present: first call");
    ok = emit_present_and_flush(device_from_iface(iface), override_window);
    if (ok)
        TRACE_ONCE("device_present: first successful submit");
    return ok ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_set_dialog_box_mode(IDirect3DDevice9 *iface,
        WINBOOL enable)
{ (void)iface; (void)enable; return D3D_OK; }

static void WINAPI device_set_gamma_ramp(IDirect3DDevice9 *iface,
        UINT swapchain, DWORD flags, const D3DGAMMARAMP *ramp)
{ (void)iface; (void)swapchain; (void)flags; (void)ramp; }

static void WINAPI device_get_gamma_ramp(IDirect3DDevice9 *iface,
        UINT swapchain, D3DGAMMARAMP *ramp)
{ (void)iface; (void)swapchain; if (ramp) ZeroMemory(ramp, sizeof(*ramp)); }

static HRESULT WINAPI device_begin_scene(IDirect3DDevice9 *iface)
{
    D9Device *device = device_from_iface(iface);
    D9WGDeviceOnly command;
    TRACE_ONCE("device_begin_scene: first call");
    if (device->in_scene)
        return D3DERR_INVALIDCALL;
    device->in_scene = TRUE;
    command.device_handle = device->handle;
    command.reserved = 0;
    return emit_command(D9WG_OP_BEGIN_SCENE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_end_scene(IDirect3DDevice9 *iface)
{
    D9Device *device = device_from_iface(iface);
    D9WGDeviceOnly command;
    TRACE_ONCE("device_end_scene: first call");
    if (!device->in_scene)
        return D3DERR_INVALIDCALL;
    device->in_scene = FALSE;
    command.device_handle = device->handle;
    command.reserved = 0;
    return emit_command(D9WG_OP_END_SCENE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_clear(IDirect3DDevice9 *iface, DWORD rect_count,
        const D3DRECT *rects, DWORD flags, D3DCOLOR color, float z,
        DWORD stencil)
{
    D9Device *device = device_from_iface(iface);
    D9WGClear command;
    uint8_t *payload;
    uint8_t *rect_data;
    uint32_t rect_bytes;
    BOOL result;

    if (rect_count && !rects)
        return D3DERR_INVALIDCALL;
    if (!(flags & (D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER | D3DCLEAR_STENCIL)))
        return D3DERR_INVALIDCALL;
    if (rect_count > 0xFFFFFFFFu / sizeof(*rects))
        return D3DERR_INVALIDCALL;
    rect_bytes = rect_count * sizeof(*rects);
    command.device_handle = device->handle;
    command.clear_flags = flags;
    command.color = color;
    command.depth = z;
    command.stencil = stencil;
    command.rect_count = rect_count;

    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D9WG_OP_CLEAR, sizeof(command), rect_bytes,
            NULL, &payload, &rect_data);
    if (result) {
        CopyMemory(payload, &command, sizeof(command));
        if (rect_bytes)
            CopyMemory(rect_data, rects, rect_bytes);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_set_transform(IDirect3DDevice9 *iface,
        D3DTRANSFORMSTATETYPE state, const D3DMATRIX *matrix)
{
    D9Device *device = device_from_iface(iface);
    D9WGSetTransform command;
    if (!matrix || (UINT)state >= D9_MAX_TRANSFORMS)
        return D3DERR_INVALIDCALL;
    CopyMemory(device->transforms[state], matrix, sizeof(float) * 16);
    command.device_handle = device->handle;
    command.state = (uint32_t)state;
    CopyMemory(command.matrix, matrix, sizeof(command.matrix));
    return emit_command(D9WG_OP_SET_TRANSFORM, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_transform(IDirect3DDevice9 *iface,
        D3DTRANSFORMSTATETYPE state, D3DMATRIX *matrix)
{
    D9Device *device = device_from_iface(iface);
    if (!matrix || (UINT)state >= D9_MAX_TRANSFORMS)
        return D3DERR_INVALIDCALL;
    CopyMemory(matrix, device->transforms[state], sizeof(float) * 16);
    return D3D_OK;
}

static HRESULT WINAPI device_set_viewport(IDirect3DDevice9 *iface,
        const D3DVIEWPORT9 *viewport)
{
    D9Device *device = device_from_iface(iface);
    D9WGSetViewport command;
    if (!viewport || !viewport->Width || !viewport->Height)
        return D3DERR_INVALIDCALL;
    if (viewport->X > device->display_mode.Width
            || viewport->Y > device->display_mode.Height
            || viewport->Width > device->display_mode.Width - viewport->X
            || viewport->Height > device->display_mode.Height - viewport->Y
            || viewport->MinZ < 0.0f || viewport->MaxZ > 1.0f
            || viewport->MinZ > viewport->MaxZ)
        return D3DERR_INVALIDCALL;
    device->viewport = *viewport;
    command.device_handle = device->handle;
    command.x = viewport->X;
    command.y = viewport->Y;
    command.width = viewport->Width;
    command.height = viewport->Height;
    command.min_z = viewport->MinZ;
    command.max_z = viewport->MaxZ;
    command.reserved = 0;
    return emit_command(D9WG_OP_SET_VIEWPORT, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_viewport(IDirect3DDevice9 *iface,
        D3DVIEWPORT9 *viewport)
{
    if (!viewport)
        return D3DERR_INVALIDCALL;
    *viewport = device_from_iface(iface)->viewport;
    return D3D_OK;
}

static HRESULT WINAPI device_set_render_state(IDirect3DDevice9 *iface,
        D3DRENDERSTATETYPE state, DWORD value)
{
    D9Device *device = device_from_iface(iface);
    D9WGSetRenderState command;
    if ((UINT)state >= D9_MAX_RENDER_STATES)
        return D3DERR_INVALIDCALL;
    if (device->render_states[state] == value)
        return D3D_OK;
    device->render_states[state] = value;
    command.device_handle = device->handle;
    command.state = state;
    command.value = value;
    command.reserved = 0;
    return emit_command(D9WG_OP_SET_RENDER_STATE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_render_state(IDirect3DDevice9 *iface,
        D3DRENDERSTATETYPE state, DWORD *value)
{
    if (!value || (UINT)state >= D9_MAX_RENDER_STATES)
        return D3DERR_INVALIDCALL;
    *value = device_from_iface(iface)->render_states[state];
    return D3D_OK;
}

static HRESULT WINAPI device_get_texture(IDirect3DDevice9 *iface,
        DWORD stage, IDirect3DBaseTexture9 **texture_out)
{
    D9Device *device = device_from_iface(iface);
    if (!texture_out || stage >= D9_MAX_TEXTURE_STAGES)
        return D3DERR_INVALIDCALL;
    *texture_out = device->textures[stage]
            ? (IDirect3DBaseTexture9 *)&device->textures[stage]->iface : NULL;
    if (*texture_out)
        IDirect3DBaseTexture9_AddRef(*texture_out);
    return D3D_OK;
}

static HRESULT WINAPI device_set_texture(IDirect3DDevice9 *iface,
        DWORD stage, IDirect3DBaseTexture9 *texture_iface)
{
    D9Device *device = device_from_iface(iface);
    D9Texture *texture = texture_iface ? (D9Texture *)texture_iface : NULL;
    D9WGSetTexture command;

    if (stage >= D9_MAX_TEXTURE_STAGES
            || (texture && (texture->iface.lpVtbl != &g_texture_vtbl
                || texture->device != device)))
        return D3DERR_INVALIDCALL;
    if (device->textures[stage] == texture)
        return D3D_OK;
    if (texture)
        IDirect3DTexture9_AddRef(&texture->iface);
    if (device->textures[stage])
        IDirect3DTexture9_Release(&device->textures[stage]->iface);
    device->textures[stage] = texture;
    command.device_handle = device->handle;
    command.stage = stage;
    command.texture_handle = texture ? texture->handle : 0;
    command.reserved = 0;
    return emit_command(D9WG_OP_SET_TEXTURE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_texture_stage_state(IDirect3DDevice9 *iface,
        DWORD stage, D3DTEXTURESTAGESTATETYPE state, DWORD *value)
{
    if (!value || stage >= D9_MAX_TEXTURE_STAGES
            || (UINT)state >= D9_MAX_TEXTURE_STAGE_STATES)
        return D3DERR_INVALIDCALL;
    *value = device_from_iface(iface)->texture_stage_states[stage][state];
    return D3D_OK;
}

static HRESULT WINAPI device_set_texture_stage_state(IDirect3DDevice9 *iface,
        DWORD stage, D3DTEXTURESTAGESTATETYPE state, DWORD value)
{
    D9Device *device = device_from_iface(iface);
    D9WGSetTextureStageState command;
    if (stage >= D9_MAX_TEXTURE_STAGES
            || (UINT)state >= D9_MAX_TEXTURE_STAGE_STATES)
        return D3DERR_INVALIDCALL;
    if (device->texture_stage_states[stage][state] == value)
        return D3D_OK;
    device->texture_stage_states[stage][state] = value;
    command.device_handle = device->handle;
    command.stage = stage;
    command.state = state;
    command.value = value;
    return emit_command(D9WG_OP_SET_TEXTURE_STAGE_STATE, &command,
            sizeof(command)) ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_validate_device(IDirect3DDevice9 *iface,
        DWORD *passes)
{
    (void)iface;
    if (!passes)
        return D3DERR_INVALIDCALL;
    *passes = 1;
    return D3D_OK;
}

static HRESULT WINAPI device_set_software_vertex_processing(
        IDirect3DDevice9 *iface, WINBOOL software)
{ (void)iface; (void)software; return D3D_OK; }

static WINBOOL WINAPI device_get_software_vertex_processing(
        IDirect3DDevice9 *iface)
{ (void)iface; return FALSE; }

static HRESULT WINAPI device_set_npatch_mode(IDirect3DDevice9 *iface,
        float segments)
{ (void)iface; (void)segments; return D3D_OK; }

static float WINAPI device_get_npatch_mode(IDirect3DDevice9 *iface)
{ (void)iface; return 0.0f; }

/* ---- IDirect3DDevice9: resources, streams, draws ---- */

static HRESULT WINAPI device_create_vertex_buffer(IDirect3DDevice9 *iface,
        UINT length, DWORD usage, DWORD fvf, D3DPOOL pool,
        IDirect3DVertexBuffer9 **buffer_out, HANDLE *shared_handle)
{
    D9Device *device = device_from_iface(iface);
    D9VertexBuffer *buffer;
    (void)shared_handle;
    if (!buffer_out)
        return D3DERR_INVALIDCALL;
    *buffer_out = NULL;
    if (!length || pool > D3DPOOL_SCRATCH)
        return D3DERR_INVALIDCALL;
    buffer = (D9VertexBuffer *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*buffer));
    if (!buffer)
        return E_OUTOFMEMORY;
    buffer->shadow = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            length);
    if (!buffer->shadow) {
        HeapFree(GetProcessHeap(), 0, buffer);
        return E_OUTOFMEMORY;
    }
    buffer->iface.lpVtbl = &g_vb_vtbl;
    buffer->refcount = 1;
    buffer->device = device;
    device_child_add_ref(device);
    buffer->handle = allocate_handle();
    buffer->length = length;
    buffer->usage = usage;
    buffer->fvf = fvf;
    buffer->pool = pool;

    if (!emit_vertex_buffer_create(device, buffer)) {
        device_child_release(device);
        HeapFree(GetProcessHeap(), 0, buffer->shadow);
        HeapFree(GetProcessHeap(), 0, buffer);
        return D3DERR_DRIVERINTERNALERROR;
    }
    buffer->next_device_resource = device->vertex_buffers;
    device->vertex_buffers = buffer;
    *buffer_out = &buffer->iface;
    return D3D_OK;
}

static HRESULT WINAPI device_create_index_buffer(IDirect3DDevice9 *iface,
        UINT length, DWORD usage, D3DFORMAT format, D3DPOOL pool,
        IDirect3DIndexBuffer9 **buffer_out, HANDLE *shared_handle)
{
    D9Device *device = device_from_iface(iface);
    D9IndexBuffer *buffer;
    UINT index_size;
    (void)shared_handle;

    if (!buffer_out)
        return D3DERR_INVALIDCALL;
    *buffer_out = NULL;
    if (!length || pool > D3DPOOL_SCRATCH)
        return D3DERR_INVALIDCALL;
    if (format == D3DFMT_INDEX16) index_size = 2;
    else if (format == D3DFMT_INDEX32) index_size = 4;
    else return D3DERR_INVALIDCALL;
    if (length % index_size)
        return D3DERR_INVALIDCALL;

    buffer = (D9IndexBuffer *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*buffer));
    if (!buffer)
        return E_OUTOFMEMORY;
    buffer->shadow = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            length);
    if (!buffer->shadow) {
        HeapFree(GetProcessHeap(), 0, buffer);
        return E_OUTOFMEMORY;
    }
    buffer->iface.lpVtbl = &g_ib_vtbl;
    buffer->refcount = 1;
    buffer->device = device;
    device_child_add_ref(device);
    buffer->handle = allocate_handle();
    buffer->length = length;
    buffer->usage = usage;
    buffer->format = format;
    buffer->pool = pool;

    if (!emit_index_buffer_create(device, buffer)) {
        device_child_release(device);
        HeapFree(GetProcessHeap(), 0, buffer->shadow);
        HeapFree(GetProcessHeap(), 0, buffer);
        return D3DERR_DRIVERINTERNALERROR;
    }
    buffer->next_device_resource = device->index_buffers;
    device->index_buffers = buffer;
    *buffer_out = &buffer->iface;
    return D3D_OK;
}

static HRESULT WINAPI device_create_texture(IDirect3DDevice9 *iface,
        UINT width, UINT height, UINT levels, DWORD usage, D3DFORMAT format,
        D3DPOOL pool, IDirect3DTexture9 **texture_out, HANDLE *shared_handle)
{
    D9Device *device = device_from_iface(iface);
    D9Texture *texture;
    UINT full_levels;
    UINT level;
    UINT level_width;
    UINT level_height;
    HRESULT failure = E_OUTOFMEMORY;
    (void)shared_handle;

    if (!texture_out)
        return D3DERR_INVALIDCALL;
    *texture_out = NULL;
    if (!width || !height || width > 4096 || height > 4096
            || !supported_texture_format(format)
            || (usage & (D3DUSAGE_DEPTHSTENCIL | D3DUSAGE_RENDERTARGET
                    | D3DUSAGE_AUTOGENMIPMAP))
            || pool > D3DPOOL_SCRATCH) {
        TRACE_FIRST({
            char line[176];
            wsprintfA(line,
                    "device_create_texture REJECTED %lux%lu levels=%lu "
                    "usage=0x%08lX format=%lu pool=%lu",
                    (unsigned long)width, (unsigned long)height,
                    (unsigned long)levels, (unsigned long)usage,
                    (unsigned long)format, (unsigned long)pool);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    full_levels = full_mip_level_count(width, height);
    if (!levels) levels = full_levels;
    if (levels > full_levels)
        return D3DERR_INVALIDCALL;

    texture = (D9Texture *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*texture));
    if (!texture)
        return E_OUTOFMEMORY;
    texture->levels = (D9TextureLevel *)HeapAlloc(GetProcessHeap(),
            HEAP_ZERO_MEMORY, levels * sizeof(*texture->levels));
    if (!texture->levels) {
        HeapFree(GetProcessHeap(), 0, texture);
        return E_OUTOFMEMORY;
    }
    texture->iface.lpVtbl = &g_texture_vtbl;
    texture->refcount = 1;
    texture->device = device;
    texture->handle = allocate_handle();
    texture->width = width;
    texture->height = height;
    texture->level_count = levels;
    texture->usage = usage;
    texture->format = format;
    texture->pool = pool;
    device_child_add_ref(device);

    level_width = width;
    level_height = height;
    for (level = 0; level < levels; ++level) {
        D9TextureLevel *level_data = &texture->levels[level];
        level_data->width = level_width;
        level_data->height = level_height;
        if (!texture_level_layout(format, level_width, level_height,
                &level_data->row_pitch, &level_data->row_count,
                &level_data->byte_count))
            goto allocation_failed;
        level_data->shadow = (BYTE *)HeapAlloc(GetProcessHeap(),
                HEAP_ZERO_MEMORY, level_data->byte_count);
        if (!level_data->shadow)
            goto allocation_failed;
        if (level_width > 1) level_width >>= 1;
        if (level_height > 1) level_height >>= 1;
    }

    if (!emit_texture_create(device, texture)) {
        failure = D3DERR_DRIVERINTERNALERROR;
        goto allocation_failed;
    }
    texture->next_device_resource = device->texture_resources;
    device->texture_resources = texture;
    *texture_out = &texture->iface;
    return D3D_OK;

allocation_failed:
    for (level = 0; level < levels; ++level) {
        if (texture->levels[level].shadow)
            HeapFree(GetProcessHeap(), 0, texture->levels[level].shadow);
    }
    device_child_release(device);
    HeapFree(GetProcessHeap(), 0, texture->levels);
    HeapFree(GetProcessHeap(), 0, texture);
    return failure;
}

static HRESULT WINAPI device_set_stream_source(IDirect3DDevice9 *iface,
        UINT stream, IDirect3DVertexBuffer9 *buffer_iface, UINT offset,
        UINT stride)
{
    D9Device *device = device_from_iface(iface);
    D9VertexBuffer *buffer = buffer_iface ? vb_from_iface(buffer_iface) : NULL;
    D9WGSetStreamSource command;
    if (stream >= D9_MAX_STREAMS) {
        TRACE_FIRST({
            char line[128];
            wsprintfA(line, "device_set_stream_source REJECTED stream=%lu "
                    "(max=%lu)", (unsigned long)stream,
                    (unsigned long)D9_MAX_STREAMS - 1);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    if (buffer && (buffer_iface->lpVtbl != &g_vb_vtbl
            || buffer->device != device))
        return D3DERR_INVALIDCALL;
    if (buffer && offset >= buffer->length)
        return D3DERR_INVALIDCALL;
    if (device->streams[stream].buffer == buffer
            && device->streams[stream].stride == stride
            && device->streams[stream].offset == offset)
        return D3D_OK;
    if (buffer)
        IDirect3DVertexBuffer9_AddRef(buffer_iface);
    if (device->streams[stream].buffer)
        IDirect3DVertexBuffer9_Release(&device->streams[stream].buffer->iface);
    device->streams[stream].buffer = buffer;
    device->streams[stream].stride = stride;
    device->streams[stream].offset = offset;
    command.device_handle = device->handle;
    command.stream = stream;
    command.buffer_handle = buffer ? buffer->handle : 0;
    command.stride = stride;
    command.offset_in_bytes = offset;
    command.reserved = 0;
    return emit_command(D9WG_OP_SET_STREAM_SOURCE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_stream_source(IDirect3DDevice9 *iface,
        UINT stream, IDirect3DVertexBuffer9 **buffer_out, UINT *offset_out,
        UINT *stride_out)
{
    D9Device *device = device_from_iface(iface);
    if (stream >= D9_MAX_STREAMS || !buffer_out || !stride_out)
        return D3DERR_INVALIDCALL;
    if (offset_out) *offset_out = device->streams[stream].offset;
    *stride_out = device->streams[stream].stride;
    *buffer_out = device->streams[stream].buffer
            ? &device->streams[stream].buffer->iface : NULL;
    if (*buffer_out)
        IDirect3DVertexBuffer9_AddRef(*buffer_out);
    return D3D_OK;
}

static HRESULT WINAPI device_set_indices(IDirect3DDevice9 *iface,
        IDirect3DIndexBuffer9 *buffer_iface)
{
    D9Device *device = device_from_iface(iface);
    D9IndexBuffer *buffer = buffer_iface ? ib_from_iface(buffer_iface) : NULL;
    D9WGSetIndices command;

    if (buffer && (buffer_iface->lpVtbl != &g_ib_vtbl
            || buffer->device != device))
        return D3DERR_INVALIDCALL;
    if (device->index_buffer == buffer)
        return D3D_OK;
    if (buffer)
        IDirect3DIndexBuffer9_AddRef(buffer_iface);
    if (device->index_buffer)
        IDirect3DIndexBuffer9_Release(&device->index_buffer->iface);
    device->index_buffer = buffer;
    command.device_handle = device->handle;
    command.buffer_handle = buffer ? buffer->handle : 0;
    return emit_command(D9WG_OP_SET_INDICES, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_indices(IDirect3DDevice9 *iface,
        IDirect3DIndexBuffer9 **buffer_out)
{
    D9Device *device = device_from_iface(iface);
    if (!buffer_out)
        return D3DERR_INVALIDCALL;
    *buffer_out = device->index_buffer ? &device->index_buffer->iface : NULL;
    if (*buffer_out)
        IDirect3DIndexBuffer9_AddRef(*buffer_out);
    return D3D_OK;
}

static BOOL device_has_vertex_format(D9Device *device)
{
    return device->vertex_declaration != NULL || device->fvf != 0;
}

static HRESULT WINAPI device_draw_primitive(IDirect3DDevice9 *iface,
        D3DPRIMITIVETYPE primitive_type, UINT start_vertex,
        UINT primitive_count)
{
    D9Device *device = device_from_iface(iface);
    D9WGDrawPrimitive command;
    UINT vertex_count = 0;
    UINT available_vertices;

    TRACE_ONCE("device_draw_primitive: first call");
    if (!device->streams[0].buffer || !device->streams[0].stride
            || device->streams[0].buffer->locked
            || !device_has_vertex_format(device) || !primitive_count
            || !primitive_element_count(primitive_type, primitive_count,
                    &vertex_count)) {
        /* Six separate reasons collapse into this one branch; log which
         * ones actually tripped rather than just "a draw was rejected". */
        TRACE_FIRST({
            char line[192];
            wsprintfA(line,
                    "device_draw_primitive REJECTED: stream0=%s stride=%lu "
                    "locked=%s vertexFormat=%s primType=%lu primCount=%lu",
                    device->streams[0].buffer ? "set" : "NULL",
                    (unsigned long)device->streams[0].stride,
                    (device->streams[0].buffer
                        && device->streams[0].buffer->locked) ? "YES" : "no",
                    device_has_vertex_format(device) ? "set" : "NONE",
                    (unsigned long)primitive_type,
                    (unsigned long)primitive_count);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    /* Vertices addressable by this draw start after the stream's
     * OffsetInBytes, not at the start of the buffer. */
    available_vertices = (device->streams[0].buffer->length
            - device->streams[0].offset) / device->streams[0].stride;
    if (start_vertex > available_vertices
            || vertex_count > available_vertices - start_vertex) {
        TRACE_FIRST({
            char line[176];
            wsprintfA(line,
                    "device_draw_primitive REJECTED out of range: "
                    "startVertex=%lu vertexCount=%lu available=%lu",
                    (unsigned long)start_vertex, (unsigned long)vertex_count,
                    (unsigned long)available_vertices);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    command.device_handle = device->handle;
    command.primitive_type = primitive_type;
    command.start_vertex = start_vertex;
    command.primitive_count = primitive_count;
    TRACE_ONCE("device_draw_primitive: first accepted draw");
    return emit_command(D9WG_OP_DRAW_PRIMITIVE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_draw_indexed_primitive(IDirect3DDevice9 *iface,
        D3DPRIMITIVETYPE primitive_type, INT base_vertex_index,
        UINT min_vertex_index, UINT vertex_count, UINT start_index,
        UINT primitive_count)
{
    D9Device *device = device_from_iface(iface);
    D9WGDrawIndexedPrimitive command;
    UINT index_count = 0;
    UINT index_size;
    UINT available_indices;
    UINT available_vertices;

    TRACE_ONCE("device_draw_indexed_primitive: first call");
    if (!device->streams[0].buffer || !device->streams[0].stride
            || device->streams[0].buffer->locked || !device->index_buffer
            || device->index_buffer->locked || !device_has_vertex_format(device)
            || !primitive_count || !vertex_count
            || !primitive_element_count(primitive_type, primitive_count,
                    &index_count)) {
        TRACE_FIRST({
            char line[192];
            wsprintfA(line,
                    "device_draw_indexed_primitive REJECTED: stream0=%s "
                    "stride=%lu ib=%s vertexFormat=%s primType=%lu "
                    "primCount=%lu vertexCount=%lu",
                    device->streams[0].buffer ? "set" : "NULL",
                    (unsigned long)device->streams[0].stride,
                    device->index_buffer ? "set" : "NULL",
                    device_has_vertex_format(device) ? "set" : "NONE",
                    (unsigned long)primitive_type,
                    (unsigned long)primitive_count,
                    (unsigned long)vertex_count);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    index_size = device->index_buffer->format == D3DFMT_INDEX16 ? 2u : 4u;
    available_indices = device->index_buffer->length / index_size;
    if (start_index > available_indices
            || index_count > available_indices - start_index) {
        TRACE_FIRST({
            char line[176];
            wsprintfA(line,
                    "device_draw_indexed_primitive REJECTED index range: "
                    "startIndex=%lu indexCount=%lu available=%lu",
                    (unsigned long)start_index, (unsigned long)index_count,
                    (unsigned long)available_indices);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    /* Vertices addressable by this draw start after the stream's
     * OffsetInBytes, not at the start of the buffer. */
    available_vertices = (device->streams[0].buffer->length
            - device->streams[0].offset) / device->streams[0].stride;
    if (min_vertex_index > available_vertices
            || vertex_count > available_vertices - min_vertex_index) {
        TRACE_FIRST({
            char line[176];
            wsprintfA(line,
                    "device_draw_indexed_primitive REJECTED vertex range: "
                    "minVertex=%lu vertexCount=%lu available=%lu",
                    (unsigned long)min_vertex_index,
                    (unsigned long)vertex_count,
                    (unsigned long)available_vertices);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    TRACE_ONCE("device_draw_indexed_primitive: first accepted draw");

    command.device_handle = device->handle;
    command.primitive_type = primitive_type;
    command.base_vertex_index = base_vertex_index;
    command.min_vertex_index = min_vertex_index;
    command.vertex_count = vertex_count;
    command.start_index = start_index;
    command.primitive_count = primitive_count;
    return emit_command(D9WG_OP_DRAW_INDEXED_PRIMITIVE, &command,
            sizeof(command)) ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static void clear_stream_zero_after_up(D9Device *device)
{
    D9VertexBuffer *old = device->streams[0].buffer;
    device->streams[0].buffer = NULL;
    device->streams[0].stride = 0;
    if (old) IDirect3DVertexBuffer9_Release(&old->iface);
}

static void clear_indices_after_indexed_up(D9Device *device)
{
    D9IndexBuffer *old = device->index_buffer;
    device->index_buffer = NULL;
    if (old) IDirect3DIndexBuffer9_Release(&old->iface);
}

static HRESULT WINAPI device_draw_primitive_up(IDirect3DDevice9 *iface,
        D3DPRIMITIVETYPE primitive_type, UINT primitive_count,
        const void *vertex_data, UINT stride)
{
    D9Device *device = device_from_iface(iface);
    D9WGDrawPrimitiveUP command;
    UINT vertex_count;
    UINT vertex_bytes;
    BOOL result;

    if (!vertex_data || !stride || !device_has_vertex_format(device)
            || !primitive_count
            || !primitive_element_count(primitive_type, primitive_count,
                    &vertex_count)
            || !multiply_u32(vertex_count, stride, &vertex_bytes))
        return D3DERR_INVALIDCALL;
    ZeroMemory(&command, sizeof(command));
    command.device_handle = device->handle;
    command.primitive_type = primitive_type;
    command.primitive_count = primitive_count;
    command.stride = stride;
    command.vertex_count = vertex_count;
    command.vertex_bytes = vertex_bytes;
    result = emit_draw_primitive_up(&command, vertex_data);
    if (result)
        clear_stream_zero_after_up(device);
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_draw_indexed_primitive_up(
        IDirect3DDevice9 *iface, D3DPRIMITIVETYPE primitive_type,
        UINT min_vertex_index, UINT vertex_count, UINT primitive_count,
        const void *index_data, D3DFORMAT index_format,
        const void *vertex_data, UINT stride)
{
    D9Device *device = device_from_iface(iface);
    D9WGDrawIndexedPrimitiveUP command;
    UINT index_count;
    UINT index_size;
    UINT vertex_elements;
    BOOL result;

    if (!index_data || !vertex_data || !stride
            || !device_has_vertex_format(device) || !primitive_count
            || !vertex_count
            || !primitive_element_count(primitive_type, primitive_count,
                    &index_count))
        return D3DERR_INVALIDCALL;
    if (index_format == D3DFMT_INDEX16) index_size = 2;
    else if (index_format == D3DFMT_INDEX32) index_size = 4;
    else return D3DERR_INVALIDCALL;
    if (min_vertex_index > 0xFFFFFFFFu - vertex_count)
        return D3DERR_INVALIDCALL;
    vertex_elements = min_vertex_index + vertex_count;
    ZeroMemory(&command, sizeof(command));
    if (!multiply_u32(index_count, index_size, &command.index_bytes)
            || !multiply_u32(vertex_elements, stride, &command.vertex_bytes))
        return D3DERR_INVALIDCALL;
    command.device_handle = device->handle;
    command.primitive_type = primitive_type;
    command.min_vertex_index = min_vertex_index;
    command.vertex_count = vertex_count;
    command.primitive_count = primitive_count;
    command.index_format = index_format;
    command.stride = stride;
    command.index_count = index_count;
    result = emit_draw_indexed_primitive_up(&command, index_data, vertex_data);
    if (result) {
        clear_stream_zero_after_up(device);
        clear_indices_after_indexed_up(device);
    }
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_create_vertex_declaration(
        IDirect3DDevice9 *iface, const D3DVERTEXELEMENT9 *elements,
        IDirect3DVertexDeclaration9 **decl_out)
{
    D9Device *device = device_from_iface(iface);
    D9VertexDeclaration *decl;
    D9WGVertexElement wire[D3DMAXDECLLENGTH];
    UINT count;

    if (!decl_out || !elements)
        return D3DERR_INVALIDCALL;
    *decl_out = NULL;
    if (!parse_vertex_declaration(elements, wire, &count)) {
        /* The single most likely silent killer for a real game: one
         * unsupported D3DDECLTYPE/usage anywhere in the array rejects the
         * whole declaration, and without this the app just never draws. */
        TRACE_FIRST({
            UINT i;
            char line[192];
            d9wg_log("device_create_vertex_declaration REJECTED, elements:");
            for (i = 0; i < D3DMAXDECLLENGTH && elements[i].Stream != 0xFF; ++i) {
                wsprintfA(line,
                        "  [%lu] stream=%lu offset=%lu type=%lu method=%lu "
                        "usage=%lu usageIndex=%lu",
                        (unsigned long)i, (unsigned long)elements[i].Stream,
                        (unsigned long)elements[i].Offset,
                        (unsigned long)elements[i].Type,
                        (unsigned long)elements[i].Method,
                        (unsigned long)elements[i].Usage,
                        (unsigned long)elements[i].UsageIndex);
                d9wg_log(line);
            }
        });
        return D3DERR_INVALIDCALL;
    }

    decl = (D9VertexDeclaration *)HeapAlloc(GetProcessHeap(),
            HEAP_ZERO_MEMORY, sizeof(*decl));
    if (!decl)
        return E_OUTOFMEMORY;
    decl->iface.lpVtbl = &g_decl_vtbl;
    decl->refcount = 1;
    decl->device = device;
    decl->handle = allocate_handle();
    decl->element_count = count;
    CopyMemory(decl->elements, elements, count * sizeof(D3DVERTEXELEMENT9));
    device_child_add_ref(device);

    if (!emit_vertex_declaration_create(device, decl->handle, wire, count)) {
        device_child_release(device);
        HeapFree(GetProcessHeap(), 0, decl);
        return D3DERR_DRIVERINTERNALERROR;
    }
    decl->next_device_resource = device->vertex_declarations;
    device->vertex_declarations = decl;
    *decl_out = &decl->iface;
    return D3D_OK;
}

static HRESULT WINAPI device_set_vertex_declaration(IDirect3DDevice9 *iface,
        IDirect3DVertexDeclaration9 *decl_iface)
{
    D9Device *device = device_from_iface(iface);
    D9VertexDeclaration *decl = decl_iface ? decl_from_iface(decl_iface) : NULL;
    D9WGSetVertexDeclaration command;

    if (decl && (decl_iface->lpVtbl != &g_decl_vtbl || decl->device != device))
        return D3DERR_INVALIDCALL;
    if (decl)
        IDirect3DVertexDeclaration9_AddRef(decl_iface);
    if (device->vertex_declaration)
        IDirect3DVertexDeclaration9_Release(
                &device->vertex_declaration->iface);
    device->vertex_declaration = decl;
    device->fvf = 0;
    command.device_handle = device->handle;
    command.declaration_handle = decl ? decl->handle : 0;
    return emit_command(D9WG_OP_SET_VERTEX_DECLARATION, &command,
            sizeof(command)) ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_vertex_declaration(IDirect3DDevice9 *iface,
        IDirect3DVertexDeclaration9 **decl_out)
{
    D9Device *device = device_from_iface(iface);
    if (!decl_out)
        return D3DERR_INVALIDCALL;
    *decl_out = device->vertex_declaration
            ? &device->vertex_declaration->iface : NULL;
    if (*decl_out)
        IDirect3DVertexDeclaration9_AddRef(*decl_out);
    return D3D_OK;
}

static HRESULT WINAPI device_set_fvf(IDirect3DDevice9 *iface, DWORD fvf)
{
    D9Device *device = device_from_iface(iface);
    D9WGVertexElement wire[D3DMAXDECLLENGTH];
    UINT count;

    if (!fvf_to_declaration(fvf, wire, &count)) {
        TRACE_FIRST({
            char line[128];
            wsprintfA(line, "device_set_fvf REJECTED fvf=0x%08lX",
                    (unsigned long)fvf);
            d9wg_log(line);
        });
        return D3DERR_INVALIDCALL;
    }
    if (device->vertex_declaration) {
        IDirect3DVertexDeclaration9_Release(
                &device->vertex_declaration->iface);
        device->vertex_declaration = NULL;
    }
    device->fvf = fvf;
    return emit_set_fvf(device, fvf, wire, count)
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_fvf(IDirect3DDevice9 *iface, DWORD *fvf)
{
    if (!fvf)
        return D3DERR_INVALIDCALL;
    *fvf = device_from_iface(iface)->fvf;
    return D3D_OK;
}

/*
 * D3D9 gives SetVertexShader/SetPixelShader a real COM pointer type, unlike
 * D3D8's overloaded DWORD, so there is no FVF-vs-shader-handle ambiguity to
 * resolve here. M1 never creates a shader object (CreateVertexShader/
 * CreatePixelShader always fail below), so the only value that can ever
 * legitimately arrive is NULL -- "go back to fixed function", which is
 * already the only mode this milestone has. Treat that as a real no-op
 * success rather than routing it through the same stub that rejects actual
 * shader creation, since defensive `SetVertexShader(NULL)` at fixed-function
 * init is common even in games that never intend to use shaders.
 */
static HRESULT WINAPI device_set_vertex_shader(IDirect3DDevice9 *iface,
        IDirect3DVertexShader9 *shader)
{ (void)iface; return shader ? D3DERR_INVALIDCALL : D3D_OK; }

static HRESULT WINAPI device_get_vertex_shader(IDirect3DDevice9 *iface,
        IDirect3DVertexShader9 **shader_out)
{
    (void)iface;
    if (!shader_out) return D3DERR_INVALIDCALL;
    *shader_out = NULL;
    return D3D_OK;
}

static HRESULT WINAPI device_set_pixel_shader(IDirect3DDevice9 *iface,
        IDirect3DPixelShader9 *shader)
{ (void)iface; return shader ? D3DERR_INVALIDCALL : D3D_OK; }

static HRESULT WINAPI device_get_pixel_shader(IDirect3DDevice9 *iface,
        IDirect3DPixelShader9 **shader_out)
{
    (void)iface;
    if (!shader_out) return D3DERR_INVALIDCALL;
    *shader_out = NULL;
    return D3D_OK;
}

/* ---- Everything else: honestly not implemented before a later milestone.
 * Typed per-method stubs (rather than one variadic stub) keep stdcall stack
 * cleanup correct on 32-bit XP. Returning D3DERR_INVALIDCALL rather than
 * pretending to succeed matches the D3D8 path's established discipline. */
#define DEV_STUB0(name) \
    static HRESULT WINAPI device_##name(IDirect3DDevice9 *iface) \
    { TRACE_STUB_ONCE(); (void)iface; return D3DERR_INVALIDCALL; }
#define DEV_STUB(name, ...) \
    static HRESULT WINAPI device_##name(IDirect3DDevice9 *iface, __VA_ARGS__)

DEV_STUB(set_cursor_properties, UINT x, UINT y, IDirect3DSurface9 *bitmap)
{ TRACE_STUB_ONCE(); (void)iface; (void)x; (void)y; (void)bitmap; return D3DERR_INVALIDCALL; }
DEV_STUB(create_additional_swap_chain, D3DPRESENT_PARAMETERS *params,
        IDirect3DSwapChain9 **out)
{ TRACE_STUB_ONCE(); (void)iface; (void)params; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(get_swap_chain, UINT index, IDirect3DSwapChain9 **out)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
/* Real as of the War3 trace run: engines have been observed gating an
 * entire render branch on this succeeding even when they never read pixels
 * back from the result (StretchRect/LockRect against it still honestly
 * fail -- see the D9Surface struct comment and surface_lock_rect()). Only
 * the single implicit swap chain / single back buffer M1 supports. */
static HRESULT WINAPI device_get_back_buffer(IDirect3DDevice9 *iface,
        UINT swapchain, UINT index, D3DBACKBUFFER_TYPE type,
        IDirect3DSurface9 **out)
{
    D9Device *device = device_from_iface(iface);
    D9Surface *surface;
    (void)type;
    if (!out)
        return D3DERR_INVALIDCALL;
    *out = NULL;
    if (swapchain || index)
        return D3DERR_INVALIDCALL;
    surface = (D9Surface *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*surface));
    if (!surface)
        return E_OUTOFMEMORY;
    surface->iface.lpVtbl = &g_surface_vtbl;
    surface->refcount = 1;
    surface->device = device;
    surface->width = device->display_mode.Width;
    surface->height = device->display_mode.Height;
    surface->format = device->display_mode.Format;
    device_child_add_ref(device);
    *out = &surface->iface;
    return D3D_OK;
}
DEV_STUB(get_raster_status, UINT swapchain, D3DRASTER_STATUS *status)
{ TRACE_STUB_ONCE(); (void)iface; (void)swapchain; (void)status; return D3DERR_INVALIDCALL; }
DEV_STUB(create_volume_texture, UINT w, UINT h, UINT d, UINT levels,
        DWORD usage, D3DFORMAT format, D3DPOOL pool,
        IDirect3DVolumeTexture9 **out, HANDLE *shared)
{ TRACE_STUB_ONCE(); (void)iface; (void)w; (void)h; (void)d; (void)levels; (void)usage;
  (void)format; (void)pool; (void)shared;
  if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(create_cube_texture, UINT edge, UINT levels, DWORD usage,
        D3DFORMAT format, D3DPOOL pool, IDirect3DCubeTexture9 **out,
        HANDLE *shared)
{ TRACE_STUB_ONCE(); (void)iface; (void)edge; (void)levels; (void)usage; (void)format;
  (void)pool; (void)shared; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(create_render_target, UINT w, UINT h, D3DFORMAT format,
        D3DMULTISAMPLE_TYPE ms, DWORD quality, WINBOOL lockable,
        IDirect3DSurface9 **out, HANDLE *shared)
{ TRACE_STUB_ONCE(); (void)iface; (void)w; (void)h; (void)format; (void)ms; (void)quality;
  (void)lockable; (void)shared; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(create_depth_stencil_surface, UINT w, UINT h, D3DFORMAT format,
        D3DMULTISAMPLE_TYPE ms, DWORD quality, WINBOOL discard,
        IDirect3DSurface9 **out, HANDLE *shared)
{ TRACE_STUB_ONCE(); (void)iface; (void)w; (void)h; (void)format; (void)ms; (void)quality;
  (void)discard; (void)shared; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(update_surface, IDirect3DSurface9 *src, const RECT *src_rect,
        IDirect3DSurface9 *dst, const POINT *dst_point)
{ TRACE_STUB_ONCE(); (void)iface; (void)src; (void)src_rect; (void)dst; (void)dst_point;
  return D3DERR_INVALIDCALL; }
/*
 * The other classic upload route besides Lock/Unlock: fill a
 * D3DPOOL_SYSTEMMEM texture on the CPU, then blit it into the
 * D3DPOOL_DEFAULT one the device actually samples. Both sides already keep a
 * full per-level shadow here, so this is a shadow-to-shadow copy followed by
 * the same UPDATE_TEXTURE emission an unlock would have produced. Declared
 * after the texture helpers it calls; see the forward declaration above.
 */
static HRESULT WINAPI device_update_texture(IDirect3DDevice9 *iface,
        IDirect3DBaseTexture9 *src_iface, IDirect3DBaseTexture9 *dst_iface)
{
    D9Device *device = device_from_iface(iface);
    D9Texture *source = (D9Texture *)src_iface;
    D9Texture *destination = (D9Texture *)dst_iface;
    UINT level;

    TRACE_ONCE("device_update_texture: first call");
    if (!source || !destination
            || source->iface.lpVtbl != &g_texture_vtbl
            || destination->iface.lpVtbl != &g_texture_vtbl
            || source->device != device || destination->device != device
            || source->format != destination->format
            || source->width != destination->width
            || source->height != destination->height)
        return D3DERR_INVALIDCALL;
    /* D3D9 allows the source to carry fewer levels than the destination;
     * only the levels both actually have can be copied. */
    for (level = 0; level < source->level_count
            && level < destination->level_count; ++level) {
        D9TextureLevel *from = &source->levels[level];
        D9TextureLevel *to = &destination->levels[level];
        RECT full;
        if (from->locked || to->locked)
            return D3DERR_INVALIDCALL;
        if (from->byte_count != to->byte_count)
            return D3DERR_INVALIDCALL;
        CopyMemory(to->shadow, from->shadow, to->byte_count);
        SetRect(&full, 0, 0, (int)to->width, (int)to->height);
        if (!emit_texture_update(destination, level, &full))
            return D3DERR_DRIVERINTERNALERROR;
    }
    return D3D_OK;
}
DEV_STUB(get_render_target_data, IDirect3DSurface9 *rt,
        IDirect3DSurface9 *dst)
{ TRACE_STUB_ONCE(); (void)iface; (void)rt; (void)dst; return D3DERR_INVALIDCALL; }
DEV_STUB(get_front_buffer_data, UINT swapchain, IDirect3DSurface9 *dst)
{ TRACE_STUB_ONCE(); (void)iface; (void)swapchain; (void)dst; return D3DERR_INVALIDCALL; }
DEV_STUB(stretch_rect, IDirect3DSurface9 *src, const RECT *src_rect,
        IDirect3DSurface9 *dst, const RECT *dst_rect,
        D3DTEXTUREFILTERTYPE filter)
{ TRACE_STUB_ONCE(); (void)iface; (void)src; (void)src_rect; (void)dst; (void)dst_rect;
  (void)filter; return D3DERR_INVALIDCALL; }
DEV_STUB(color_fill, IDirect3DSurface9 *surface, const RECT *rect,
        D3DCOLOR color)
{ TRACE_STUB_ONCE(); (void)iface; (void)surface; (void)rect; (void)color;
  return D3DERR_INVALIDCALL; }
DEV_STUB(create_offscreen_plain_surface, UINT w, UINT h, D3DFORMAT format,
        D3DPOOL pool, IDirect3DSurface9 **out, HANDLE *shared)
{ TRACE_STUB_ONCE(); (void)iface; (void)w; (void)h; (void)format; (void)pool; (void)shared;
  if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(set_render_target, DWORD index, IDirect3DSurface9 *target)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; (void)target; return D3DERR_INVALIDCALL; }
DEV_STUB(get_render_target, DWORD index, IDirect3DSurface9 **out)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(set_depth_stencil_surface, IDirect3DSurface9 *surface)
{ TRACE_STUB_ONCE(); (void)iface; (void)surface; return D3DERR_INVALIDCALL; }
DEV_STUB(get_depth_stencil_surface, IDirect3DSurface9 **out)
{ TRACE_STUB_ONCE(); (void)iface; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(multiply_transform, D3DTRANSFORMSTATETYPE state,
        const D3DMATRIX *matrix)
{ TRACE_STUB_ONCE(); (void)iface; (void)state; (void)matrix; return D3DERR_INVALIDCALL; }
/*
 * SetMaterial/SetLight/LightEnable/SetSamplerState are real (not DEV_STUB)
 * as of the War3 trace run: the guest stores and forwards the state
 * honestly, but the M1 fixed-function shader in d3d9_executor.js does not
 * apply lighting math or per-sampler filtering yet (that is real M2/M3
 * work, see plan section 4.7/12). The win here over the previous
 * D3DERR_INVALIDCALL stubs is specifically for engines that gate an entire
 * render branch on these calls succeeding -- accepting the state honestly
 * (without yet acting on it) can only help, never regress M1's already-
 * documented "no lighting" boundary.
 */
static HRESULT WINAPI device_set_material(IDirect3DDevice9 *iface,
        const D3DMATERIAL9 *material)
{
    D9Device *device = device_from_iface(iface);
    D9WGSetMaterial command;
    if (!material)
        return D3DERR_INVALIDCALL;
    device->material = *material;
    command.device_handle = device->handle;
    CopyMemory(command.diffuse, &material->Diffuse, sizeof(command.diffuse));
    CopyMemory(command.ambient, &material->Ambient, sizeof(command.ambient));
    CopyMemory(command.specular, &material->Specular, sizeof(command.specular));
    CopyMemory(command.emissive, &material->Emissive, sizeof(command.emissive));
    command.power = material->Power;
    return emit_command(D9WG_OP_SET_MATERIAL, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_material(IDirect3DDevice9 *iface,
        D3DMATERIAL9 *material)
{
    if (!material)
        return D3DERR_INVALIDCALL;
    *material = device_from_iface(iface)->material;
    return D3D_OK;
}

static HRESULT WINAPI device_set_light(IDirect3DDevice9 *iface, DWORD index,
        const D3DLIGHT9 *light)
{
    D9Device *device = device_from_iface(iface);
    D9WGSetLight command;
    if (!light || index >= D9_MAX_LIGHTS)
        return D3DERR_INVALIDCALL;
    device->lights[index] = *light;
    device->light_set[index] = TRUE;
    command.device_handle = device->handle;
    command.index = index;
    command.type = (uint32_t)light->Type;
    CopyMemory(command.diffuse, &light->Diffuse, sizeof(command.diffuse));
    CopyMemory(command.specular, &light->Specular, sizeof(command.specular));
    CopyMemory(command.ambient, &light->Ambient, sizeof(command.ambient));
    CopyMemory(command.position, &light->Position, sizeof(command.position));
    CopyMemory(command.direction, &light->Direction, sizeof(command.direction));
    command.range = light->Range;
    command.falloff = light->Falloff;
    command.attenuation[0] = light->Attenuation0;
    command.attenuation[1] = light->Attenuation1;
    command.attenuation[2] = light->Attenuation2;
    command.theta = light->Theta;
    command.phi = light->Phi;
    return emit_command(D9WG_OP_SET_LIGHT, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_light(IDirect3DDevice9 *iface, DWORD index,
        D3DLIGHT9 *light)
{
    D9Device *device = device_from_iface(iface);
    if (!light || index >= D9_MAX_LIGHTS || !device->light_set[index])
        return D3DERR_INVALIDCALL;
    *light = device->lights[index];
    return D3D_OK;
}

static HRESULT WINAPI device_light_enable(IDirect3DDevice9 *iface,
        DWORD index, WINBOOL enable)
{
    D9Device *device = device_from_iface(iface);
    D9WGLightEnable command;
    if (index >= D9_MAX_LIGHTS)
        return D3DERR_INVALIDCALL;
    device->light_enabled[index] = enable ? TRUE : FALSE;
    command.device_handle = device->handle;
    command.index = index;
    command.enable = enable ? 1u : 0u;
    command.reserved = 0;
    return emit_command(D9WG_OP_LIGHT_ENABLE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_light_enable(IDirect3DDevice9 *iface,
        DWORD index, WINBOOL *enable)
{
    D9Device *device = device_from_iface(iface);
    if (!enable || index >= D9_MAX_LIGHTS)
        return D3DERR_INVALIDCALL;
    *enable = device->light_enabled[index];
    return D3D_OK;
}
DEV_STUB(set_clip_plane, DWORD index, const float *plane)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; (void)plane; return D3DERR_INVALIDCALL; }
DEV_STUB(get_clip_plane, DWORD index, float *plane)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; (void)plane; return D3DERR_INVALIDCALL; }
DEV_STUB(create_state_block, D3DSTATEBLOCKTYPE type,
        IDirect3DStateBlock9 **out)
{ TRACE_STUB_ONCE(); (void)iface; (void)type; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB0(begin_state_block)
DEV_STUB(end_state_block, IDirect3DStateBlock9 **out)
{ TRACE_STUB_ONCE(); (void)iface; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(set_clip_status, const D3DCLIPSTATUS9 *status)
{ TRACE_STUB_ONCE(); (void)iface; (void)status; return D3DERR_INVALIDCALL; }
DEV_STUB(get_clip_status, D3DCLIPSTATUS9 *status)
{ TRACE_STUB_ONCE(); (void)iface; (void)status; return D3DERR_INVALIDCALL; }
static HRESULT WINAPI device_get_sampler_state(IDirect3DDevice9 *iface,
        DWORD sampler, D3DSAMPLERSTATETYPE type, DWORD *value)
{
    D9Device *device = device_from_iface(iface);
    if (!value || sampler >= D9_MAX_SAMPLERS || (UINT)type >= D9_MAX_SAMPLER_STATES)
        return D3DERR_INVALIDCALL;
    *value = device->sampler_states[sampler][type];
    return D3D_OK;
}

/* Stored and forwarded honestly (see the comment above device_set_material),
 * but the M1 fixed-function pipeline always samples with one hardcoded
 * default sampler regardless of what is stored here -- real per-D3DSAMP_*
 * GPUSampler variants are M2 scope (plan section 4.4/12). */
static HRESULT WINAPI device_set_sampler_state(IDirect3DDevice9 *iface,
        DWORD sampler, D3DSAMPLERSTATETYPE type, DWORD value)
{
    D9Device *device = device_from_iface(iface);
    D9WGSetSamplerState command;
    if (sampler >= D9_MAX_SAMPLERS || (UINT)type >= D9_MAX_SAMPLER_STATES)
        return D3DERR_INVALIDCALL;
    if (device->sampler_states[sampler][type] == value)
        return D3D_OK;
    device->sampler_states[sampler][type] = value;
    command.device_handle = device->handle;
    command.sampler = sampler;
    command.state = type;
    command.value = value;
    return emit_command(D9WG_OP_SET_SAMPLER_STATE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}
DEV_STUB(set_palette_entries, UINT index, const PALETTEENTRY *entries)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; (void)entries; return D3DERR_INVALIDCALL; }
DEV_STUB(get_palette_entries, UINT index, PALETTEENTRY *entries)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; (void)entries; return D3DERR_INVALIDCALL; }
DEV_STUB(set_current_texture_palette, UINT index)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; return D3DERR_INVALIDCALL; }
DEV_STUB(get_current_texture_palette, UINT *index)
{ TRACE_STUB_ONCE(); (void)iface; (void)index; return D3DERR_INVALIDCALL; }
DEV_STUB(set_scissor_rect, const RECT *rect)
{ TRACE_STUB_ONCE(); (void)iface; (void)rect; return D3DERR_INVALIDCALL; }
DEV_STUB(get_scissor_rect, RECT *rect)
{ TRACE_STUB_ONCE(); (void)iface; (void)rect; return D3DERR_INVALIDCALL; }
DEV_STUB(process_vertices, UINT src_start, UINT dst_index, UINT count,
        IDirect3DVertexBuffer9 *dst, IDirect3DVertexDeclaration9 *decl,
        DWORD flags)
{ TRACE_STUB_ONCE(); (void)iface; (void)src_start; (void)dst_index; (void)count; (void)dst;
  (void)decl; (void)flags; return D3DERR_INVALIDCALL; }
DEV_STUB(create_vertex_shader, const DWORD *bytecode,
        IDirect3DVertexShader9 **out)
{ TRACE_STUB_ONCE(); (void)iface; (void)bytecode; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(set_vertex_shader_constant_f, UINT start, const float *data,
        UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(get_vertex_shader_constant_f, UINT start, float *data, UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(set_vertex_shader_constant_i, UINT start, const int *data,
        UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(get_vertex_shader_constant_i, UINT start, int *data, UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(set_vertex_shader_constant_b, UINT start, const WINBOOL *data,
        UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(get_vertex_shader_constant_b, UINT start, WINBOOL *data, UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(set_stream_source_freq, UINT stream, UINT divider)
{ TRACE_STUB_ONCE(); (void)iface; (void)stream; (void)divider; return D3DERR_INVALIDCALL; }
DEV_STUB(get_stream_source_freq, UINT stream, UINT *divider)
{ TRACE_STUB_ONCE(); (void)iface; (void)stream; (void)divider; return D3DERR_INVALIDCALL; }
DEV_STUB(create_pixel_shader, const DWORD *bytecode,
        IDirect3DPixelShader9 **out)
{ TRACE_STUB_ONCE(); (void)iface; (void)bytecode; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }
DEV_STUB(set_pixel_shader_constant_f, UINT start, const float *data,
        UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(get_pixel_shader_constant_f, UINT start, float *data, UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(set_pixel_shader_constant_i, UINT start, const int *data,
        UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(get_pixel_shader_constant_i, UINT start, int *data, UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(set_pixel_shader_constant_b, UINT start, const WINBOOL *data,
        UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(get_pixel_shader_constant_b, UINT start, WINBOOL *data, UINT count)
{ TRACE_STUB_ONCE(); (void)iface; (void)start; (void)data; (void)count;
  return D3DERR_INVALIDCALL; }
DEV_STUB(draw_rect_patch, UINT handle, const float *segments,
        const D3DRECTPATCH_INFO *info)
{ TRACE_STUB_ONCE(); (void)iface; (void)handle; (void)segments; (void)info;
  return D3DERR_INVALIDCALL; }
DEV_STUB(draw_tri_patch, UINT handle, const float *segments,
        const D3DTRIPATCH_INFO *info)
{ TRACE_STUB_ONCE(); (void)iface; (void)handle; (void)segments; (void)info;
  return D3DERR_INVALIDCALL; }
DEV_STUB(delete_patch, UINT handle)
{ TRACE_STUB_ONCE(); (void)iface; (void)handle; return D3DERR_INVALIDCALL; }
DEV_STUB(create_query, D3DQUERYTYPE type, IDirect3DQuery9 **out)
{ TRACE_STUB_ONCE(); (void)iface; (void)type; if (out) { *out = NULL; } return D3DERR_INVALIDCALL; }

/* ---- IDirect3DVertexBuffer9 ---- */

static HRESULT WINAPI vb_query_interface(IDirect3DVertexBuffer9 *iface,
        REFIID iid, void **object)
{
    if (!object)
        return E_POINTER;
    *object = NULL;
    if (!iid || (!iid_is_unknown(iid)
            && !guid_equal(iid, &IID_IDirect3DResource9)
            && !guid_equal(iid, &IID_IDirect3DVertexBuffer9)))
        return E_NOINTERFACE;
    *object = iface;
    IDirect3DVertexBuffer9_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI vb_add_ref(IDirect3DVertexBuffer9 *iface)
{
    return (ULONG)InterlockedIncrement(&vb_from_iface(iface)->refcount);
}

static ULONG WINAPI vb_release(IDirect3DVertexBuffer9 *iface)
{
    D9VertexBuffer *buffer = vb_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&buffer->refcount);
    if (!refs) {
        D9VertexBuffer **link = &buffer->device->vertex_buffers;
        D9WGDestroyResource destroy;
        while (*link && *link != buffer)
            link = &(*link)->next_device_resource;
        if (*link) *link = buffer->next_device_resource;
        destroy.resource_handle = buffer->handle;
        destroy.resource_kind = D9WG_RESOURCE_BUFFER_VERTEX;
        emit_command(D9WG_OP_DESTROY_RESOURCE, &destroy, sizeof(destroy));
        HeapFree(GetProcessHeap(), 0, buffer->shadow);
        device_child_release(buffer->device);
        HeapFree(GetProcessHeap(), 0, buffer);
    }
    return refs;
}

static HRESULT WINAPI vb_get_device(IDirect3DVertexBuffer9 *iface,
        IDirect3DDevice9 **device_out)
{
    D9VertexBuffer *buffer = vb_from_iface(iface);
    if (!device_out)
        return D3DERR_INVALIDCALL;
    *device_out = &buffer->device->iface;
    IDirect3DDevice9_AddRef(*device_out);
    return D3D_OK;
}

static HRESULT WINAPI vb_set_private_data(IDirect3DVertexBuffer9 *iface,
        REFGUID guid, const void *data, DWORD size, DWORD flags)
{ (void)iface; (void)guid; (void)data; (void)size; (void)flags;
  return D3DERR_INVALIDCALL; }

static HRESULT WINAPI vb_get_private_data(IDirect3DVertexBuffer9 *iface,
        REFGUID guid, void *data, DWORD *size)
{ (void)iface; (void)guid; (void)data; (void)size; return D3DERR_NOTFOUND; }

static HRESULT WINAPI vb_free_private_data(IDirect3DVertexBuffer9 *iface,
        REFGUID guid)
{ (void)iface; (void)guid; return D3DERR_NOTFOUND; }

static DWORD WINAPI vb_set_priority(IDirect3DVertexBuffer9 *iface,
        DWORD priority)
{
    D9VertexBuffer *buffer = vb_from_iface(iface);
    DWORD old = buffer->priority;
    buffer->priority = priority;
    return old;
}

static DWORD WINAPI vb_get_priority(IDirect3DVertexBuffer9 *iface)
{ return vb_from_iface(iface)->priority; }

static void WINAPI vb_preload(IDirect3DVertexBuffer9 *iface)
{ (void)iface; }

static D3DRESOURCETYPE WINAPI vb_get_type(IDirect3DVertexBuffer9 *iface)
{ (void)iface; return D3DRTYPE_VERTEXBUFFER; }

static HRESULT WINAPI vb_lock(IDirect3DVertexBuffer9 *iface, UINT offset,
        UINT size, void **data_out, DWORD flags)
{
    D9VertexBuffer *buffer = vb_from_iface(iface);
    if (!data_out || buffer->locked || offset > buffer->length)
        return D3DERR_INVALIDCALL;
    if ((flags & D3DLOCK_DISCARD) && (flags & D3DLOCK_NOOVERWRITE))
        return D3DERR_INVALIDCALL;
    if ((flags & (D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE))
            && !(buffer->usage & D3DUSAGE_DYNAMIC))
        return D3DERR_INVALIDCALL;
    if ((flags & D3DLOCK_READONLY)
            && (flags & (D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE)))
        return D3DERR_INVALIDCALL;
    if (!size)
        size = buffer->length - offset;
    if (size > buffer->length - offset)
        return D3DERR_INVALIDCALL;
    buffer->locked = TRUE;
    buffer->lock_offset = offset;
    buffer->lock_size = size;
    buffer->lock_flags = flags;
    if (flags & D3DLOCK_DISCARD)
        ZeroMemory(buffer->shadow, buffer->length);
    *data_out = buffer->shadow + offset;
    return D3D_OK;
}

static HRESULT WINAPI vb_unlock(IDirect3DVertexBuffer9 *iface)
{
    D9VertexBuffer *buffer = vb_from_iface(iface);
    BOOL result;
    if (!buffer->locked)
        return D3DERR_INVALIDCALL;
    result = (buffer->lock_flags & D3DLOCK_READONLY)
            || emit_buffer_update(buffer->handle, buffer->lock_offset,
                    buffer->shadow + buffer->lock_offset, buffer->lock_size,
                    buffer->lock_flags);
    buffer->locked = FALSE;
    buffer->lock_offset = 0;
    buffer->lock_size = 0;
    buffer->lock_flags = 0;
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI vb_get_desc(IDirect3DVertexBuffer9 *iface,
        D3DVERTEXBUFFER_DESC *desc)
{
    D9VertexBuffer *buffer = vb_from_iface(iface);
    if (!desc)
        return D3DERR_INVALIDCALL;
    ZeroMemory(desc, sizeof(*desc));
    desc->Format = D3DFMT_VERTEXDATA;
    desc->Type = D3DRTYPE_VERTEXBUFFER;
    desc->Usage = buffer->usage;
    desc->Pool = buffer->pool;
    desc->Size = buffer->length;
    desc->FVF = buffer->fvf;
    return D3D_OK;
}

/* ---- IDirect3DIndexBuffer9 ---- */

static HRESULT WINAPI ib_query_interface(IDirect3DIndexBuffer9 *iface,
        REFIID iid, void **object)
{
    if (!object)
        return E_POINTER;
    *object = NULL;
    if (!iid || (!iid_is_unknown(iid)
            && !guid_equal(iid, &IID_IDirect3DResource9)
            && !guid_equal(iid, &IID_IDirect3DIndexBuffer9)))
        return E_NOINTERFACE;
    *object = iface;
    IDirect3DIndexBuffer9_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI ib_add_ref(IDirect3DIndexBuffer9 *iface)
{
    return (ULONG)InterlockedIncrement(&ib_from_iface(iface)->refcount);
}

static ULONG WINAPI ib_release(IDirect3DIndexBuffer9 *iface)
{
    D9IndexBuffer *buffer = ib_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&buffer->refcount);
    if (!refs) {
        D9IndexBuffer **link = &buffer->device->index_buffers;
        D9WGDestroyResource destroy;
        while (*link && *link != buffer)
            link = &(*link)->next_device_resource;
        if (*link) *link = buffer->next_device_resource;
        destroy.resource_handle = buffer->handle;
        destroy.resource_kind = D9WG_RESOURCE_BUFFER_INDEX;
        emit_command(D9WG_OP_DESTROY_RESOURCE, &destroy, sizeof(destroy));
        HeapFree(GetProcessHeap(), 0, buffer->shadow);
        device_child_release(buffer->device);
        HeapFree(GetProcessHeap(), 0, buffer);
    }
    return refs;
}

static HRESULT WINAPI ib_get_device(IDirect3DIndexBuffer9 *iface,
        IDirect3DDevice9 **device_out)
{
    D9IndexBuffer *buffer = ib_from_iface(iface);
    if (!device_out)
        return D3DERR_INVALIDCALL;
    *device_out = &buffer->device->iface;
    IDirect3DDevice9_AddRef(*device_out);
    return D3D_OK;
}

static HRESULT WINAPI ib_set_private_data(IDirect3DIndexBuffer9 *iface,
        REFGUID guid, const void *data, DWORD size, DWORD flags)
{ (void)iface; (void)guid; (void)data; (void)size; (void)flags;
  return D3DERR_INVALIDCALL; }

static HRESULT WINAPI ib_get_private_data(IDirect3DIndexBuffer9 *iface,
        REFGUID guid, void *data, DWORD *size)
{ (void)iface; (void)guid; (void)data; (void)size; return D3DERR_NOTFOUND; }

static HRESULT WINAPI ib_free_private_data(IDirect3DIndexBuffer9 *iface,
        REFGUID guid)
{ (void)iface; (void)guid; return D3DERR_NOTFOUND; }

static DWORD WINAPI ib_set_priority(IDirect3DIndexBuffer9 *iface,
        DWORD priority)
{
    D9IndexBuffer *buffer = ib_from_iface(iface);
    DWORD old = buffer->priority;
    buffer->priority = priority;
    return old;
}

static DWORD WINAPI ib_get_priority(IDirect3DIndexBuffer9 *iface)
{ return ib_from_iface(iface)->priority; }

static void WINAPI ib_preload(IDirect3DIndexBuffer9 *iface)
{ (void)iface; }

static D3DRESOURCETYPE WINAPI ib_get_type(IDirect3DIndexBuffer9 *iface)
{ (void)iface; return D3DRTYPE_INDEXBUFFER; }

static HRESULT WINAPI ib_lock(IDirect3DIndexBuffer9 *iface, UINT offset,
        UINT size, void **data_out, DWORD flags)
{
    D9IndexBuffer *buffer = ib_from_iface(iface);
    if (!data_out || buffer->locked || offset > buffer->length)
        return D3DERR_INVALIDCALL;
    if ((flags & D3DLOCK_DISCARD) && (flags & D3DLOCK_NOOVERWRITE))
        return D3DERR_INVALIDCALL;
    if ((flags & (D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE))
            && !(buffer->usage & D3DUSAGE_DYNAMIC))
        return D3DERR_INVALIDCALL;
    if (!size)
        size = buffer->length - offset;
    if (size > buffer->length - offset)
        return D3DERR_INVALIDCALL;
    buffer->locked = TRUE;
    buffer->lock_offset = offset;
    buffer->lock_size = size;
    buffer->lock_flags = flags;
    if (flags & D3DLOCK_DISCARD)
        ZeroMemory(buffer->shadow, buffer->length);
    *data_out = buffer->shadow + offset;
    return D3D_OK;
}

static HRESULT WINAPI ib_unlock(IDirect3DIndexBuffer9 *iface)
{
    D9IndexBuffer *buffer = ib_from_iface(iface);
    BOOL result;
    if (!buffer->locked)
        return D3DERR_INVALIDCALL;
    result = (buffer->lock_flags & D3DLOCK_READONLY)
            || emit_buffer_update(buffer->handle, buffer->lock_offset,
                    buffer->shadow + buffer->lock_offset, buffer->lock_size,
                    buffer->lock_flags);
    buffer->locked = FALSE;
    buffer->lock_offset = 0;
    buffer->lock_size = 0;
    buffer->lock_flags = 0;
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI ib_get_desc(IDirect3DIndexBuffer9 *iface,
        D3DINDEXBUFFER_DESC *desc)
{
    D9IndexBuffer *buffer = ib_from_iface(iface);
    if (!desc)
        return D3DERR_INVALIDCALL;
    ZeroMemory(desc, sizeof(*desc));
    desc->Format = buffer->format;
    desc->Type = D3DRTYPE_INDEXBUFFER;
    desc->Usage = buffer->usage;
    desc->Pool = buffer->pool;
    desc->Size = buffer->length;
    return D3D_OK;
}

/* ---- IDirect3DTexture9 ---- */

static HRESULT texture_lock_level(D9Texture *texture, UINT level,
        D3DLOCKED_RECT *locked_rect, const RECT *rect, DWORD flags)
{
    D9TextureLevel *level_data;
    RECT area;
    UINT block_width;
    UINT block_height;
    UINT block_bytes;
    UINT block_x;
    UINT block_y;

    if (!locked_rect || level >= texture->level_count)
        return D3DERR_INVALIDCALL;
    level_data = &texture->levels[level];
    if (level_data->locked)
        return D3DERR_INVALIDCALL;
    if (rect) {
        area = *rect;
    } else {
        SetRect(&area, 0, 0, (int)level_data->width, (int)level_data->height);
    }
    if (area.left < 0 || area.top < 0 || area.right <= area.left
            || area.bottom <= area.top
            || (UINT)area.right > level_data->width
            || (UINT)area.bottom > level_data->height
            || !texture_format_layout(texture->format, &block_width,
                    &block_height, &block_bytes))
        return D3DERR_INVALIDCALL;
    if (block_width > 1
            && (((UINT)area.left % block_width)
                || ((UINT)area.top % block_height)
                || ((UINT)area.right != level_data->width
                    && (UINT)area.right % block_width)
                || ((UINT)area.bottom != level_data->height
                    && (UINT)area.bottom % block_height)))
        return D3DERR_INVALIDCALL;

    block_x = (UINT)area.left / block_width;
    block_y = (UINT)area.top / block_height;
    level_data->lock_rect = area;
    level_data->lock_flags = flags;
    level_data->locked = TRUE;
    locked_rect->Pitch = (INT)level_data->row_pitch;
    locked_rect->pBits = level_data->shadow
            + block_y * level_data->row_pitch + block_x * block_bytes;
    return D3D_OK;
}

static HRESULT texture_unlock_level(D9Texture *texture, UINT level)
{
    D9TextureLevel *level_data;
    BOOL result = TRUE;

    if (level >= texture->level_count)
        return D3DERR_INVALIDCALL;
    level_data = &texture->levels[level];
    if (!level_data->locked)
        return D3DERR_INVALIDCALL;
    if (!(level_data->lock_flags & D3DLOCK_READONLY))
        result = emit_texture_update(texture, level, &level_data->lock_rect);
    level_data->locked = FALSE;
    level_data->lock_flags = 0;
    ZeroMemory(&level_data->lock_rect, sizeof(level_data->lock_rect));
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI texture_query_interface(IDirect3DTexture9 *iface,
        REFIID iid, void **object)
{
    if (!object)
        return E_POINTER;
    *object = NULL;
    if (!iid || (!iid_is_unknown(iid)
            && !guid_equal(iid, &IID_IDirect3DResource9)
            && !guid_equal(iid, &IID_IDirect3DBaseTexture9)
            && !guid_equal(iid, &IID_IDirect3DTexture9)))
        return E_NOINTERFACE;
    *object = iface;
    IDirect3DTexture9_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI texture_add_ref(IDirect3DTexture9 *iface)
{
    return (ULONG)InterlockedIncrement(&texture_from_iface(iface)->refcount);
}

static ULONG WINAPI texture_release(IDirect3DTexture9 *iface)
{
    D9Texture *texture = texture_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&texture->refcount);
    if (!refs) {
        D9Texture **link = &texture->device->texture_resources;
        D9WGDestroyResource destroy;
        UINT level;
        while (*link && *link != texture)
            link = &(*link)->next_device_resource;
        if (*link) *link = texture->next_device_resource;
        destroy.resource_handle = texture->handle;
        destroy.resource_kind = D9WG_RESOURCE_TEXTURE_2D;
        emit_command(D9WG_OP_DESTROY_RESOURCE, &destroy, sizeof(destroy));
        for (level = 0; level < texture->level_count; ++level)
            HeapFree(GetProcessHeap(), 0, texture->levels[level].shadow);
        HeapFree(GetProcessHeap(), 0, texture->levels);
        device_child_release(texture->device);
        HeapFree(GetProcessHeap(), 0, texture);
    }
    return refs;
}

static HRESULT WINAPI texture_get_device(IDirect3DTexture9 *iface,
        IDirect3DDevice9 **device_out)
{
    D9Texture *texture = texture_from_iface(iface);
    if (!device_out)
        return D3DERR_INVALIDCALL;
    *device_out = &texture->device->iface;
    IDirect3DDevice9_AddRef(*device_out);
    return D3D_OK;
}

static HRESULT WINAPI texture_set_private_data(IDirect3DTexture9 *iface,
        REFGUID guid, const void *data, DWORD size, DWORD flags)
{ (void)iface; (void)guid; (void)data; (void)size; (void)flags;
  return D3DERR_INVALIDCALL; }

static HRESULT WINAPI texture_get_private_data(IDirect3DTexture9 *iface,
        REFGUID guid, void *data, DWORD *size)
{ (void)iface; (void)guid; (void)data; (void)size; return D3DERR_NOTFOUND; }

static HRESULT WINAPI texture_free_private_data(IDirect3DTexture9 *iface,
        REFGUID guid)
{ (void)iface; (void)guid; return D3DERR_NOTFOUND; }

static DWORD WINAPI texture_set_priority(IDirect3DTexture9 *iface,
        DWORD priority)
{
    D9Texture *texture = texture_from_iface(iface);
    DWORD old = texture->priority;
    texture->priority = priority;
    return old;
}

static DWORD WINAPI texture_get_priority(IDirect3DTexture9 *iface)
{ return texture_from_iface(iface)->priority; }

static void WINAPI texture_preload(IDirect3DTexture9 *iface)
{ (void)iface; }

static D3DRESOURCETYPE WINAPI texture_get_type(IDirect3DTexture9 *iface)
{ (void)iface; return D3DRTYPE_TEXTURE; }

static DWORD WINAPI texture_set_lod(IDirect3DTexture9 *iface, DWORD lod)
{
    D9Texture *texture = texture_from_iface(iface);
    DWORD old = texture->lod;
    if (lod >= texture->level_count)
        lod = texture->level_count - 1;
    texture->lod = lod;
    return old;
}

static DWORD WINAPI texture_get_lod(IDirect3DTexture9 *iface)
{ return texture_from_iface(iface)->lod; }

static DWORD WINAPI texture_get_level_count(IDirect3DTexture9 *iface)
{ return texture_from_iface(iface)->level_count; }

/* Auto mipmap generation is not implemented in M1 (CreateTexture already
 * rejects D3DUSAGE_AUTOGENMIPMAP); these three exist only to keep the vtable
 * complete for titles that probe the capability defensively. */
static HRESULT WINAPI texture_set_auto_gen_filter_type(
        IDirect3DTexture9 *iface, D3DTEXTUREFILTERTYPE filter)
{ (void)iface; (void)filter; return D3DERR_INVALIDCALL; }

static D3DTEXTUREFILTERTYPE WINAPI texture_get_auto_gen_filter_type(
        IDirect3DTexture9 *iface)
{ (void)iface; return D3DTEXF_NONE; }

static void WINAPI texture_generate_mip_sublevels(IDirect3DTexture9 *iface)
{ (void)iface; }

static HRESULT WINAPI texture_get_level_desc(IDirect3DTexture9 *iface,
        UINT level, D3DSURFACE_DESC *desc)
{
    D9Texture *texture = texture_from_iface(iface);
    D9TextureLevel *level_data;
    if (!desc || level >= texture->level_count)
        return D3DERR_INVALIDCALL;
    level_data = &texture->levels[level];
    ZeroMemory(desc, sizeof(*desc));
    desc->Format = texture->format;
    desc->Type = D3DRTYPE_SURFACE;
    desc->Usage = texture->usage;
    desc->Pool = texture->pool;
    desc->MultiSampleType = D3DMULTISAMPLE_NONE;
    desc->Width = level_data->width;
    desc->Height = level_data->height;
    return D3D_OK;
}

/*
 * Returns a surface view onto one texture level. Originally stubbed out on
 * the assumption that an app would always upload through
 * IDirect3DTexture9::LockRect directly -- Warcraft III does not: it takes the
 * level's surface and locks that, so failing here meant its textures were
 * created and bound but never received a single byte of pixel data (117
 * textures created, 0 uploads), rendering the whole scene black.
 *
 * The surface holds a reference on its texture and forwards Lock/Unlock to
 * the same per-level shadow storage and UPDATE_TEXTURE emitter the texture's
 * own LockRect uses, so both upload routes stay identical.
 */
static HRESULT WINAPI texture_get_surface_level(IDirect3DTexture9 *iface,
        UINT level, IDirect3DSurface9 **surface_out)
{
    D9Texture *texture = texture_from_iface(iface);
    D9Surface *surface;

    TRACE_ONCE("texture_get_surface_level: first call");
    if (!surface_out)
        return D3DERR_INVALIDCALL;
    *surface_out = NULL;
    if (level >= texture->level_count)
        return D3DERR_INVALIDCALL;
    surface = (D9Surface *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*surface));
    if (!surface)
        return E_OUTOFMEMORY;
    surface->iface.lpVtbl = &g_surface_vtbl;
    surface->refcount = 1;
    surface->device = texture->device;
    surface->texture = texture;
    surface->level = level;
    surface->width = texture->levels[level].width;
    surface->height = texture->levels[level].height;
    surface->format = texture->format;
    IDirect3DTexture9_AddRef(iface);
    device_child_add_ref(texture->device);
    *surface_out = &surface->iface;
    return D3D_OK;
}

static HRESULT WINAPI texture_lock_rect(IDirect3DTexture9 *iface, UINT level,
        D3DLOCKED_RECT *locked_rect, const RECT *rect, DWORD flags)
{
    return texture_lock_level(texture_from_iface(iface), level, locked_rect,
            rect, flags);
}

static HRESULT WINAPI texture_unlock_rect(IDirect3DTexture9 *iface,
        UINT level)
{
    return texture_unlock_level(texture_from_iface(iface), level);
}

static HRESULT WINAPI texture_add_dirty_rect(IDirect3DTexture9 *iface,
        const RECT *rect)
{
    D9Texture *texture = texture_from_iface(iface);
    if (rect && (rect->left < 0 || rect->top < 0
            || rect->right <= rect->left || rect->bottom <= rect->top
            || (UINT)rect->right > texture->width
            || (UINT)rect->bottom > texture->height))
        return D3DERR_INVALIDCALL;
    return D3D_OK;
}

/* ---- IDirect3DVertexDeclaration9 ---- */

static HRESULT WINAPI decl_query_interface(IDirect3DVertexDeclaration9 *iface,
        REFIID iid, void **object)
{
    if (!object)
        return E_POINTER;
    *object = NULL;
    if (!iid || (!iid_is_unknown(iid)
            && !guid_equal(iid, &IID_IDirect3DVertexDeclaration9)))
        return E_NOINTERFACE;
    *object = iface;
    IDirect3DVertexDeclaration9_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI decl_add_ref(IDirect3DVertexDeclaration9 *iface)
{
    return (ULONG)InterlockedIncrement(&decl_from_iface(iface)->refcount);
}

static ULONG WINAPI decl_release(IDirect3DVertexDeclaration9 *iface)
{
    D9VertexDeclaration *decl = decl_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&decl->refcount);
    if (!refs) {
        D9VertexDeclaration **link = &decl->device->vertex_declarations;
        D9WGDestroyResource destroy;
        while (*link && *link != decl)
            link = &(*link)->next_device_resource;
        if (*link) *link = decl->next_device_resource;
        destroy.resource_handle = decl->handle;
        destroy.resource_kind = D9WG_RESOURCE_VERTEX_DECLARATION;
        emit_command(D9WG_OP_DESTROY_RESOURCE, &destroy, sizeof(destroy));
        device_child_release(decl->device);
        HeapFree(GetProcessHeap(), 0, decl);
    }
    return refs;
}

static HRESULT WINAPI decl_get_device(IDirect3DVertexDeclaration9 *iface,
        IDirect3DDevice9 **device_out)
{
    D9VertexDeclaration *decl = decl_from_iface(iface);
    if (!device_out)
        return D3DERR_INVALIDCALL;
    *device_out = &decl->device->iface;
    IDirect3DDevice9_AddRef(*device_out);
    return D3D_OK;
}

static HRESULT WINAPI decl_get_declaration(IDirect3DVertexDeclaration9 *iface,
        D3DVERTEXELEMENT9 *elements, UINT *count_out)
{
    D9VertexDeclaration *decl = decl_from_iface(iface);
    if (!count_out)
        return D3DERR_INVALIDCALL;
    if (!elements) {
        *count_out = decl->element_count + 1; /* +1 for the END() sentinel */
        return D3D_OK;
    }
    if (*count_out < decl->element_count + 1)
        return D3DERR_INVALIDCALL;
    CopyMemory(elements, decl->elements,
            decl->element_count * sizeof(D3DVERTEXELEMENT9));
    {
        D3DVERTEXELEMENT9 end = D3DDECL_END();
        elements[decl->element_count] = end;
    }
    *count_out = decl->element_count + 1;
    return D3D_OK;
}

/* ---- IDirect3DSurface9 (GetBackBuffer only; see the struct comment) ---- */

static D9Surface *surface_from_iface(IDirect3DSurface9 *iface)
{
    return (D9Surface *)iface;
}

static HRESULT WINAPI surface_query_interface(IDirect3DSurface9 *iface,
        REFIID iid, void **object)
{
    if (!object)
        return E_POINTER;
    *object = NULL;
    if (!iid || (!iid_is_unknown(iid)
            && !guid_equal(iid, &IID_IDirect3DResource9)
            && !guid_equal(iid, &IID_IDirect3DSurface9)))
        return E_NOINTERFACE;
    *object = iface;
    IDirect3DSurface9_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI surface_add_ref(IDirect3DSurface9 *iface)
{
    return (ULONG)InterlockedIncrement(&surface_from_iface(iface)->refcount);
}

static ULONG WINAPI surface_release(IDirect3DSurface9 *iface)
{
    D9Surface *surface = surface_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&surface->refcount);
    if (!refs) {
        /* A level surface keeps its texture alive for as long as it exists
         * (GetSurfaceLevel took that reference); the back-buffer surface has
         * no texture and only holds the device. */
        if (surface->texture)
            IDirect3DTexture9_Release(&surface->texture->iface);
        device_child_release(surface->device);
        HeapFree(GetProcessHeap(), 0, surface);
    }
    return refs;
}

static HRESULT WINAPI surface_get_device(IDirect3DSurface9 *iface,
        IDirect3DDevice9 **device_out)
{
    D9Surface *surface = surface_from_iface(iface);
    if (!device_out)
        return D3DERR_INVALIDCALL;
    *device_out = &surface->device->iface;
    IDirect3DDevice9_AddRef(*device_out);
    return D3D_OK;
}

static HRESULT WINAPI surface_set_private_data(IDirect3DSurface9 *iface,
        REFGUID guid, const void *data, DWORD size, DWORD flags)
{ (void)iface; (void)guid; (void)data; (void)size; (void)flags;
  return D3DERR_INVALIDCALL; }

static HRESULT WINAPI surface_get_private_data(IDirect3DSurface9 *iface,
        REFGUID guid, void *data, DWORD *size)
{ (void)iface; (void)guid; (void)data; (void)size; return D3DERR_NOTFOUND; }

static HRESULT WINAPI surface_free_private_data(IDirect3DSurface9 *iface,
        REFGUID guid)
{ (void)iface; (void)guid; return D3DERR_NOTFOUND; }

static DWORD WINAPI surface_set_priority(IDirect3DSurface9 *iface,
        DWORD priority)
{ (void)iface; (void)priority; return 0; }

static DWORD WINAPI surface_get_priority(IDirect3DSurface9 *iface)
{ (void)iface; return 0; }

static void WINAPI surface_preload(IDirect3DSurface9 *iface)
{ (void)iface; }

static D3DRESOURCETYPE WINAPI surface_get_type(IDirect3DSurface9 *iface)
{ (void)iface; return D3DRTYPE_SURFACE; }

static HRESULT WINAPI surface_get_container(IDirect3DSurface9 *iface,
        REFIID riid, void **container)
{
    D9Surface *surface = surface_from_iface(iface);
    if (!container)
        return D3DERR_INVALIDCALL;
    *container = NULL;
    if (!surface->texture)
        return D3DERR_INVALIDCALL;
    if (riid && !iid_is_unknown(riid)
            && !guid_equal(riid, &IID_IDirect3DResource9)
            && !guid_equal(riid, &IID_IDirect3DBaseTexture9)
            && !guid_equal(riid, &IID_IDirect3DTexture9))
        return E_NOINTERFACE;
    *container = &surface->texture->iface;
    IDirect3DTexture9_AddRef(&surface->texture->iface);
    return D3D_OK;
}

static HRESULT WINAPI surface_get_desc(IDirect3DSurface9 *iface,
        D3DSURFACE_DESC *desc)
{
    D9Surface *surface = surface_from_iface(iface);
    if (!desc)
        return D3DERR_INVALIDCALL;
    ZeroMemory(desc, sizeof(*desc));
    desc->Format = surface->format;
    desc->Type = D3DRTYPE_SURFACE;
    desc->Usage = 0;
    desc->Pool = D3DPOOL_DEFAULT;
    desc->MultiSampleType = D3DMULTISAMPLE_NONE;
    desc->Width = surface->width;
    desc->Height = surface->height;
    return D3D_OK;
}

/*
 * A texture-level surface locks the very same shadow storage as
 * IDirect3DTexture9::LockRect on that level, so an app can upload through
 * either route and the UPDATE_TEXTURE emitted on unlock is identical.
 *
 * The back-buffer surface (texture == NULL) still fails honestly: M1 has no
 * GPU-backed readback (plan section 2.2 non-goal), and fabricating pixels
 * would be worse than saying so.
 */
static HRESULT WINAPI surface_lock_rect(IDirect3DSurface9 *iface,
        D3DLOCKED_RECT *locked_rect, const RECT *rect, DWORD flags)
{
    D9Surface *surface = surface_from_iface(iface);
    TRACE_ONCE("surface_lock_rect: first call");
    if (!surface->texture)
        return D3DERR_INVALIDCALL;
    return texture_lock_level(surface->texture, surface->level, locked_rect,
            rect, flags);
}

static HRESULT WINAPI surface_unlock_rect(IDirect3DSurface9 *iface)
{
    D9Surface *surface = surface_from_iface(iface);
    if (!surface->texture)
        return D3DERR_INVALIDCALL;
    return texture_unlock_level(surface->texture, surface->level);
}

static HRESULT WINAPI surface_get_dc(IDirect3DSurface9 *iface, HDC *hdc)
{ (void)iface; if (hdc) { *hdc = NULL; } return D3DERR_INVALIDCALL; }

static HRESULT WINAPI surface_release_dc(IDirect3DSurface9 *iface, HDC hdc)
{ (void)iface; (void)hdc; return D3DERR_INVALIDCALL; }

/* ---- vtables ---- */

static IDirect3D9Vtbl g_d3d_vtbl = {
    .QueryInterface = d3d_query_interface,
    .AddRef = d3d_add_ref,
    .Release = d3d_release,
    .RegisterSoftwareDevice = d3d_register_software_device,
    .GetAdapterCount = d3d_get_adapter_count,
    .GetAdapterIdentifier = d3d_get_adapter_identifier,
    .GetAdapterModeCount = d3d_get_adapter_mode_count,
    .EnumAdapterModes = d3d_enum_adapter_modes,
    .GetAdapterDisplayMode = d3d_get_adapter_display_mode,
    .CheckDeviceType = d3d_check_device_type,
    .CheckDeviceFormat = d3d_check_device_format,
    .CheckDeviceMultiSampleType = d3d_check_multisample,
    .CheckDepthStencilMatch = d3d_check_depth_stencil,
    .CheckDeviceFormatConversion = d3d_check_device_format_conversion,
    .GetDeviceCaps = d3d_get_device_caps,
    .GetAdapterMonitor = d3d_get_adapter_monitor,
    .CreateDevice = d3d_create_device
};

static IDirect3DDevice9Vtbl g_device_vtbl = {
    .QueryInterface = device_query_interface,
    .AddRef = device_add_ref,
    .Release = device_release,
    .TestCooperativeLevel = device_test_cooperative_level,
    .GetAvailableTextureMem = device_get_available_texture_mem,
    .EvictManagedResources = device_evict_managed_resources,
    .GetDirect3D = device_get_direct3d,
    .GetDeviceCaps = device_get_caps,
    .GetDisplayMode = device_get_display_mode,
    .GetCreationParameters = device_get_creation_parameters,
    .SetCursorProperties = device_set_cursor_properties,
    .SetCursorPosition = device_set_cursor_position,
    .ShowCursor = device_show_cursor,
    .CreateAdditionalSwapChain = device_create_additional_swap_chain,
    .GetSwapChain = device_get_swap_chain,
    .GetNumberOfSwapChains = device_get_number_of_swap_chains,
    .Reset = device_reset,
    .Present = device_present,
    .GetBackBuffer = device_get_back_buffer,
    .GetRasterStatus = device_get_raster_status,
    .SetDialogBoxMode = device_set_dialog_box_mode,
    .SetGammaRamp = device_set_gamma_ramp,
    .GetGammaRamp = device_get_gamma_ramp,
    .CreateTexture = device_create_texture,
    .CreateVolumeTexture = device_create_volume_texture,
    .CreateCubeTexture = device_create_cube_texture,
    .CreateVertexBuffer = device_create_vertex_buffer,
    .CreateIndexBuffer = device_create_index_buffer,
    .CreateRenderTarget = device_create_render_target,
    .CreateDepthStencilSurface = device_create_depth_stencil_surface,
    .UpdateSurface = device_update_surface,
    .UpdateTexture = device_update_texture,
    .GetRenderTargetData = device_get_render_target_data,
    .GetFrontBufferData = device_get_front_buffer_data,
    .StretchRect = device_stretch_rect,
    .ColorFill = device_color_fill,
    .CreateOffscreenPlainSurface = device_create_offscreen_plain_surface,
    .SetRenderTarget = device_set_render_target,
    .GetRenderTarget = device_get_render_target,
    .SetDepthStencilSurface = device_set_depth_stencil_surface,
    .GetDepthStencilSurface = device_get_depth_stencil_surface,
    .BeginScene = device_begin_scene,
    .EndScene = device_end_scene,
    .Clear = device_clear,
    .SetTransform = device_set_transform,
    .GetTransform = device_get_transform,
    .MultiplyTransform = device_multiply_transform,
    .SetViewport = device_set_viewport,
    .GetViewport = device_get_viewport,
    .SetMaterial = device_set_material,
    .GetMaterial = device_get_material,
    .SetLight = device_set_light,
    .GetLight = device_get_light,
    .LightEnable = device_light_enable,
    .GetLightEnable = device_get_light_enable,
    .SetClipPlane = device_set_clip_plane,
    .GetClipPlane = device_get_clip_plane,
    .SetRenderState = device_set_render_state,
    .GetRenderState = device_get_render_state,
    .CreateStateBlock = device_create_state_block,
    .BeginStateBlock = device_begin_state_block,
    .EndStateBlock = device_end_state_block,
    .SetClipStatus = device_set_clip_status,
    .GetClipStatus = device_get_clip_status,
    .GetTexture = device_get_texture,
    .SetTexture = device_set_texture,
    .GetTextureStageState = device_get_texture_stage_state,
    .SetTextureStageState = device_set_texture_stage_state,
    .GetSamplerState = device_get_sampler_state,
    .SetSamplerState = device_set_sampler_state,
    .ValidateDevice = device_validate_device,
    .SetPaletteEntries = device_set_palette_entries,
    .GetPaletteEntries = device_get_palette_entries,
    .SetCurrentTexturePalette = device_set_current_texture_palette,
    .GetCurrentTexturePalette = device_get_current_texture_palette,
    .SetScissorRect = device_set_scissor_rect,
    .GetScissorRect = device_get_scissor_rect,
    .SetSoftwareVertexProcessing = device_set_software_vertex_processing,
    .GetSoftwareVertexProcessing = device_get_software_vertex_processing,
    .SetNPatchMode = device_set_npatch_mode,
    .GetNPatchMode = device_get_npatch_mode,
    .DrawPrimitive = device_draw_primitive,
    .DrawIndexedPrimitive = device_draw_indexed_primitive,
    .DrawPrimitiveUP = device_draw_primitive_up,
    .DrawIndexedPrimitiveUP = device_draw_indexed_primitive_up,
    .ProcessVertices = device_process_vertices,
    .CreateVertexDeclaration = device_create_vertex_declaration,
    .SetVertexDeclaration = device_set_vertex_declaration,
    .GetVertexDeclaration = device_get_vertex_declaration,
    .SetFVF = device_set_fvf,
    .GetFVF = device_get_fvf,
    .CreateVertexShader = device_create_vertex_shader,
    .SetVertexShader = device_set_vertex_shader,
    .GetVertexShader = device_get_vertex_shader,
    .SetVertexShaderConstantF = device_set_vertex_shader_constant_f,
    .GetVertexShaderConstantF = device_get_vertex_shader_constant_f,
    .SetVertexShaderConstantI = device_set_vertex_shader_constant_i,
    .GetVertexShaderConstantI = device_get_vertex_shader_constant_i,
    .SetVertexShaderConstantB = device_set_vertex_shader_constant_b,
    .GetVertexShaderConstantB = device_get_vertex_shader_constant_b,
    .SetStreamSource = device_set_stream_source,
    .GetStreamSource = device_get_stream_source,
    .SetStreamSourceFreq = device_set_stream_source_freq,
    .GetStreamSourceFreq = device_get_stream_source_freq,
    .SetIndices = device_set_indices,
    .GetIndices = device_get_indices,
    .CreatePixelShader = device_create_pixel_shader,
    .SetPixelShader = device_set_pixel_shader,
    .GetPixelShader = device_get_pixel_shader,
    .SetPixelShaderConstantF = device_set_pixel_shader_constant_f,
    .GetPixelShaderConstantF = device_get_pixel_shader_constant_f,
    .SetPixelShaderConstantI = device_set_pixel_shader_constant_i,
    .GetPixelShaderConstantI = device_get_pixel_shader_constant_i,
    .SetPixelShaderConstantB = device_set_pixel_shader_constant_b,
    .GetPixelShaderConstantB = device_get_pixel_shader_constant_b,
    .DrawRectPatch = device_draw_rect_patch,
    .DrawTriPatch = device_draw_tri_patch,
    .DeletePatch = device_delete_patch,
    .CreateQuery = device_create_query
};

static IDirect3DVertexBuffer9Vtbl g_vb_vtbl = {
    .QueryInterface = vb_query_interface,
    .AddRef = vb_add_ref,
    .Release = vb_release,
    .GetDevice = vb_get_device,
    .SetPrivateData = vb_set_private_data,
    .GetPrivateData = vb_get_private_data,
    .FreePrivateData = vb_free_private_data,
    .SetPriority = vb_set_priority,
    .GetPriority = vb_get_priority,
    .PreLoad = vb_preload,
    .GetType = vb_get_type,
    .Lock = vb_lock,
    .Unlock = vb_unlock,
    .GetDesc = vb_get_desc
};

static IDirect3DIndexBuffer9Vtbl g_ib_vtbl = {
    .QueryInterface = ib_query_interface,
    .AddRef = ib_add_ref,
    .Release = ib_release,
    .GetDevice = ib_get_device,
    .SetPrivateData = ib_set_private_data,
    .GetPrivateData = ib_get_private_data,
    .FreePrivateData = ib_free_private_data,
    .SetPriority = ib_set_priority,
    .GetPriority = ib_get_priority,
    .PreLoad = ib_preload,
    .GetType = ib_get_type,
    .Lock = ib_lock,
    .Unlock = ib_unlock,
    .GetDesc = ib_get_desc
};

static IDirect3DTexture9Vtbl g_texture_vtbl = {
    .QueryInterface = texture_query_interface,
    .AddRef = texture_add_ref,
    .Release = texture_release,
    .GetDevice = texture_get_device,
    .SetPrivateData = texture_set_private_data,
    .GetPrivateData = texture_get_private_data,
    .FreePrivateData = texture_free_private_data,
    .SetPriority = texture_set_priority,
    .GetPriority = texture_get_priority,
    .PreLoad = texture_preload,
    .GetType = texture_get_type,
    .SetLOD = texture_set_lod,
    .GetLOD = texture_get_lod,
    .GetLevelCount = texture_get_level_count,
    .SetAutoGenFilterType = texture_set_auto_gen_filter_type,
    .GetAutoGenFilterType = texture_get_auto_gen_filter_type,
    .GenerateMipSubLevels = texture_generate_mip_sublevels,
    .GetLevelDesc = texture_get_level_desc,
    .GetSurfaceLevel = texture_get_surface_level,
    .LockRect = texture_lock_rect,
    .UnlockRect = texture_unlock_rect,
    .AddDirtyRect = texture_add_dirty_rect
};

static IDirect3DVertexDeclaration9Vtbl g_decl_vtbl = {
    .QueryInterface = decl_query_interface,
    .AddRef = decl_add_ref,
    .Release = decl_release,
    .GetDevice = decl_get_device,
    .GetDeclaration = decl_get_declaration
};

static IDirect3DSurface9Vtbl g_surface_vtbl = {
    .QueryInterface = surface_query_interface,
    .AddRef = surface_add_ref,
    .Release = surface_release,
    .GetDevice = surface_get_device,
    .SetPrivateData = surface_set_private_data,
    .GetPrivateData = surface_get_private_data,
    .FreePrivateData = surface_free_private_data,
    .SetPriority = surface_set_priority,
    .GetPriority = surface_get_priority,
    .PreLoad = surface_preload,
    .GetType = surface_get_type,
    .GetContainer = surface_get_container,
    .GetDesc = surface_get_desc,
    .LockRect = surface_lock_rect,
    .UnlockRect = surface_unlock_rect,
    .GetDC = surface_get_dc,
    .ReleaseDC = surface_release_dc
};

IDirect3D9 *WINAPI Direct3DCreate9(UINT sdk_version)
{
    D9Direct3D *d3d;
    BOOL transport_ready;
    char line[96];

    wsprintfA(line, "Direct3DCreate9(sdk_version=%lu, expected=%lu)",
            (unsigned long)sdk_version, (unsigned long)D3D_SDK_VERSION);
    d9wg_log(line);
    if (sdk_version != D3D_SDK_VERSION) {
        d9wg_log("Direct3DCreate9: sdk_version mismatch, returning NULL");
        return NULL;
    }
    EnterCriticalSection(&g_transport_lock);
    transport_ready = open_transport_locked();
    LeaveCriticalSection(&g_transport_lock);
    if (!transport_ready)
        return NULL;

    d3d = (D9Direct3D *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*d3d));
    if (!d3d)
        return NULL;
    d3d->iface.lpVtbl = &g_d3d_vtbl;
    d3d->refcount = 1;
    emit_hello_once();
    return &d3d->iface;
}

/*
 * Secondary d3d9.dll exports. A title that statically imports any of these
 * fails to LOAD against a DLL that omits them -- Direct3DCreate9 is never
 * reached, and the failure surfaces as a generic "unable to initialize
 * DirectX" with no diagnostic. The D3D8 path hit exactly this with Warcraft
 * III's ValidateVertexShader/ValidatePixelShader imports; D3DPERF_* (PIX
 * instrumentation hooks) and DebugSetMute are the D3D9-side equivalent risk,
 * commonly pulled in by profiling-instrumented engine builds even when the
 * game never calls them at runtime. All are harmless no-ops here.
 */
void WINAPI DebugSetMute(void)
{
}

int WINAPI D3DPERF_BeginEvent(D3DCOLOR color, const WCHAR *name)
{
    (void)color; (void)name;
    return 0;
}

int WINAPI D3DPERF_EndEvent(void)
{
    return 0;
}

void WINAPI D3DPERF_SetMarker(D3DCOLOR color, const WCHAR *name)
{
    (void)color; (void)name;
}

void WINAPI D3DPERF_SetRegion(D3DCOLOR color, const WCHAR *name)
{
    (void)color; (void)name;
}

WINBOOL WINAPI D3DPERF_QueryRepeatFrame(void)
{
    return FALSE;
}

void WINAPI D3DPERF_SetOptions(DWORD options)
{
    (void)options;
}

DWORD WINAPI D3DPERF_GetStatus(void)
{
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
        g_module_instance = instance;
        initialize_session_id(instance);
        InitializeCriticalSection(&g_transport_lock);
        /* Unconditional and independent of the \\.\v86gl transport: proves
         * the DLL was mapped into this process at all, even if the app
         * never goes on to call Direct3DCreate9 (e.g. because it picked a
         * different renderer). The previous trace only fired *after*
         * Direct3DCreate9 ran, which could never distinguish "never loaded"
         * from "loaded but never used". */
        {
            char exe[MAX_PATH];
            char line[MAX_PATH + 64];
            DWORD n = GetModuleFileNameA(NULL, exe, sizeof(exe));
            if (!n || n >= sizeof(exe))
                lstrcpynA(exe, "<unknown>", sizeof(exe));
            wsprintfA(line, "DllMain: DLL_PROCESS_ATTACH pid=%lu exe=%s",
                    (unsigned long)GetCurrentProcessId(), exe);
            d9wg_log(line);
        }
    } else if (reason == DLL_PROCESS_DETACH) {
        EnterCriticalSection(&g_transport_lock);
        if (g_command_count)
            submit_batch_locked(FALSE);
        close_transport_locked();
        LeaveCriticalSection(&g_transport_lock);
        DeleteCriticalSection(&g_transport_lock);
    }
    return TRUE;
}






