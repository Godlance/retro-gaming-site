/*
 * App-local Direct3D 8 frontend for Windows XP guests running in v86.
 *
 * This DLL deliberately does not load WineD3D or opengl32.dll.  It keeps D3D8
 * COM/state/resource semantics in the guest, batches high-level commands in
 * the existing v86gl.sys DMA arena, and sends one D8WG stream to WebGPU.
 *
 * The first milestone implements the capability/CreateDevice path plus
 * Clear/Present and the XYZRHW|DIFFUSE vertex-buffer triangle path.  Methods
 * outside that advertised subset return D3DERR_INVALIDCALL rather than
 * silently pretending that rendering succeeded.
 */

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <d3d8.h>
#include <stdint.h>
#include "../winproxy/v86gl_ioctl.h"
#include "d3d8_protocol.h"

#define D8WG_LOG_PREFIX "[d3d8-webgpu] "
#define D8WG_MAX_RENDER_STATES 256u
#define D8WG_MAX_TEXTURE_STAGES 8u
#define D8WG_MAX_TEXTURE_STAGE_STATES 32u
#define D8WG_MAX_STREAMS 16u
#define D8WG_VGL2_RECORD_HEADER_BYTES 8u
#define D8WG_HANDLE_GENERATION_ONE (1u << 20)

typedef struct D8Direct3D D8Direct3D;
typedef struct D8Device D8Device;
typedef struct D8VertexBuffer D8VertexBuffer;

typedef struct D8StreamBinding {
    D8VertexBuffer *buffer;
    UINT stride;
} D8StreamBinding;

struct D8Direct3D {
    IDirect3D8 iface;
    LONG refcount;
};

struct D8Device {
    IDirect3DDevice8 iface;
    LONG refcount;
    D8Direct3D *parent;
    uint32_t handle;
    D3DDEVICE_CREATION_PARAMETERS creation;
    D3DPRESENT_PARAMETERS present;
    D3DDISPLAYMODE display_mode;
    D3DVIEWPORT8 viewport;
    DWORD render_states[D8WG_MAX_RENDER_STATES];
    DWORD texture_stage_states[D8WG_MAX_TEXTURE_STAGES]
                                      [D8WG_MAX_TEXTURE_STAGE_STATES];
    D8StreamBinding streams[D8WG_MAX_STREAMS];
    DWORD vertex_shader;
    BOOL in_scene;
};

struct D8VertexBuffer {
    IDirect3DVertexBuffer8 iface;
    LONG refcount;
    D8Device *device;
    uint32_t handle;
    BYTE *shadow;
    UINT length;
    DWORD usage;
    DWORD fvf;
    D3DPOOL pool;
    DWORD priority;
    UINT lock_offset;
    UINT lock_size;
    BOOL locked;
};

static HANDLE g_transport = INVALID_HANDLE_VALUE;
static uint8_t *g_dma_buffer;
static uint32_t g_dma_capacity;
static uint32_t g_batch_bytes;
static uint32_t g_command_count;
static uint32_t g_frame_id = 1;
static uint32_t g_sequence = 1;
static uint32_t g_next_handle = 1;
static BOOL g_transport_failed;
static BOOL g_hello_emitted;
static CRITICAL_SECTION g_transport_lock;

static IDirect3D8Vtbl g_d3d_vtbl;
static IDirect3DDevice8Vtbl g_device_vtbl;
static IDirect3DVertexBuffer8Vtbl g_vb_vtbl;

static D8Direct3D *d3d_from_iface(IDirect3D8 *iface)
{
    return (D8Direct3D *)iface;
}

static D8Device *device_from_iface(IDirect3DDevice8 *iface)
{
    return (D8Device *)iface;
}

static D8VertexBuffer *vb_from_iface(IDirect3DVertexBuffer8 *iface)
{
    return (D8VertexBuffer *)iface;
}

static void d8wg_log(const char *text)
{
    OutputDebugStringA(D8WG_LOG_PREFIX);
    OutputDebugStringA(text);
    OutputDebugStringA("\r\n");
}

static uint32_t allocate_handle(void)
{
    uint32_t index = (uint32_t)InterlockedIncrement((LONG *)&g_next_handle);
    index &= 0x000FFFFFu;
    if (!index)
        index = (uint32_t)InterlockedIncrement((LONG *)&g_next_handle)
                & 0x000FFFFFu;
    return D8WG_HANDLE_GENERATION_ONE | index;
}

static uint8_t *batch_base(void)
{
    return g_dma_buffer + sizeof(V86GLDMADesc)
            + D8WG_VGL2_RECORD_HEADER_BYTES;
}

static uint32_t batch_capacity(void)
{
    if (g_dma_capacity <= sizeof(V86GLDMADesc)
            + D8WG_VGL2_RECORD_HEADER_BYTES)
        return 0;
    return g_dma_capacity - (uint32_t)sizeof(V86GLDMADesc)
            - D8WG_VGL2_RECORD_HEADER_BYTES;
}

static void reset_batch_locked(void)
{
    D8WGBatchHeader *header;

    g_batch_bytes = sizeof(D8WGBatchHeader);
    g_command_count = 0;
    if (!g_dma_buffer || batch_capacity() < sizeof(D8WGBatchHeader))
        return;

    header = (D8WGBatchHeader *)batch_base();
    ZeroMemory(header, sizeof(*header));
    header->magic = D8WG_MAGIC;
    header->version_major = D8WG_VERSION_MAJOR;
    header->version_minor = D8WG_VERSION_MINOR;
    header->frame_id = g_frame_id;
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
        d8wg_log("could not open \\.\\v86gl");
        return FALSE;
    }

    ZeroMemory(&mapping, sizeof(mapping));
    if (!DeviceIoControl(g_transport, V86GL_IOCTL_MAP_BUFFER,
            NULL, 0, &mapping, sizeof(mapping), &returned, NULL)
            || returned != sizeof(mapping)
            || !mapping.user_address
            || mapping.buffer_bytes < sizeof(V86GLDMADesc)
                    + D8WG_VGL2_RECORD_HEADER_BYTES
                    + sizeof(D8WGBatchHeader)
                    + sizeof(D8WGCommandHeader)) {
        d8wg_log("v86gl MAP_BUFFER failed");
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
    D8WGBatchHeader *batch;
    V86GLSubmit submit;
    uint8_t *outer;
    uint32_t outer_bytes;
    DWORD returned = 0;

    if (!open_transport_locked())
        return FALSE;
    if (g_command_count == 0)
        return TRUE;

    batch = (D8WGBatchHeader *)batch_base();
    batch->frame_id = g_frame_id;
    batch->flags = present ? D8WG_BATCH_FLAG_PRESENT : 0;
    batch->command_count = g_command_count;
    batch->command_bytes = g_batch_bytes - sizeof(*batch);
    batch->upload_offset = 0;
    batch->upload_bytes = 0;

    outer = g_dma_buffer + sizeof(V86GLDMADesc);
    outer[0] = (uint8_t)(V86GL_CTRL_D3D8_BATCH & 0xFFu);
    outer[1] = (uint8_t)(V86GL_CTRL_D3D8_BATCH >> 8);
    outer[2] = 0xFF;
    outer[3] = 0xFF;
    outer[4] = (uint8_t)(g_batch_bytes & 0xFFu);
    outer[5] = (uint8_t)((g_batch_bytes >> 8) & 0xFFu);
    outer[6] = (uint8_t)((g_batch_bytes >> 16) & 0xFFu);
    outer[7] = (uint8_t)((g_batch_bytes >> 24) & 0xFFu);

    outer_bytes = D8WG_VGL2_RECORD_HEADER_BYTES + g_batch_bytes;
    descriptor = (V86GLDMADesc *)g_dma_buffer;
    descriptor->magic = V86GL_MAGIC;
    descriptor->version = V86GL_VERSION;
    /* WebGPU Present is an inner command.  Do not ask the GL bridge to swap. */
    descriptor->flags = 0;
    descriptor->frame_id = g_frame_id;
    descriptor->command_count = 1;
    descriptor->command_bytes = outer_bytes;
    descriptor->reserved0 = D8WG_MAGIC;
    descriptor->reserved1 = 0;

    submit.descriptor_bytes = (uint32_t)sizeof(*descriptor) + outer_bytes;
    submit.flags = 0;
    if (!DeviceIoControl(g_transport, V86GL_IOCTL_SUBMIT,
            &submit, sizeof(submit), NULL, 0, &returned, NULL)) {
        d8wg_log("D8WG batch submit failed");
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
        uint32_t extra_bytes, D8WGCommandHeader **command_out,
        uint8_t **payload_out, uint8_t **extra_out)
{
    uint32_t raw_size;
    uint32_t record_size;
    D8WGCommandHeader *command;

    if (!open_transport_locked())
        return FALSE;
    if (payload_bytes > 0xFFFFFFFFu - sizeof(*command) - extra_bytes)
        return FALSE;
    raw_size = (uint32_t)sizeof(*command) + payload_bytes + extra_bytes;
    record_size = D8WG_ALIGN8(raw_size);
    if (record_size > batch_capacity() - sizeof(D8WGBatchHeader))
        return FALSE;
    if (g_batch_bytes + record_size > batch_capacity()
            && !submit_batch_locked(FALSE))
        return FALSE;

    command = (D8WGCommandHeader *)(batch_base() + g_batch_bytes);
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
        const void *data, uint32_t byte_count)
{
    D8WGUpdateBuffer update;
    D8WGCommandHeader *command;
    uint8_t *payload;
    uint8_t *blob;
    BOOL result;

    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D8WG_OP_UPDATE_BUFFER,
            sizeof(update), byte_count, &command, &payload, &blob);
    if (result) {
        update.resource_handle = handle;
        update.destination_offset = destination_offset;
        update.byte_count = byte_count;
        update.data_offset = (uint32_t)((uint8_t *)blob - batch_base());
        CopyMemory(payload, &update, sizeof(update));
        if (byte_count)
            CopyMemory(blob, data, byte_count);
        (void)command;
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static BOOL emit_present_and_flush(uint32_t device_handle)
{
    D8WGPresent present;
    uint8_t *payload;
    BOOL result;

    present.device_handle = device_handle;
    present.reserved = 0;
    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D8WG_OP_PRESENT, sizeof(present), 0,
            NULL, &payload, NULL);
    if (result) {
        CopyMemory(payload, &present, sizeof(present));
        result = submit_batch_locked(TRUE);
    }
    LeaveCriticalSection(&g_transport_lock);
    return result;
}

static void emit_hello_once(void)
{
    D8WGHello hello;

    if (InterlockedCompareExchange((LONG *)&g_hello_emitted, TRUE, FALSE))
        return;
    hello.guest_pointer_bits = 32;
    hello.feature_bits = 0;
    emit_command(D8WG_OP_HELLO, &hello, sizeof(hello));
}

static void fill_display_mode(D3DDISPLAYMODE *mode, UINT width, UINT height,
        D3DFORMAT format)
{
    mode->Width = width;
    mode->Height = height;
    mode->RefreshRate = 60;
    mode->Format = format;
}

static void fill_caps(D3DCAPS8 *caps)
{
    ZeroMemory(caps, sizeof(*caps));
    caps->DeviceType = D3DDEVTYPE_HAL;
    caps->AdapterOrdinal = D3DADAPTER_DEFAULT;
    caps->Caps2 = D3DCAPS2_CANRENDERWINDOWED;
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
            | D3DPMISCCAPS_COLORWRITEENABLE;
    caps->RasterCaps = D3DPRASTERCAPS_DITHER | D3DPRASTERCAPS_ZTEST;
    caps->ZCmpCaps = 0xFFu;
    caps->SrcBlendCaps = 0x1FFFu;
    caps->DestBlendCaps = 0x1FFFu;
    caps->AlphaCmpCaps = 0xFFu;
    caps->ShadeCaps = D3DPSHADECAPS_COLORGOURAUDRGB
            | D3DPSHADECAPS_ALPHAGOURAUDBLEND;
    caps->TextureCaps = D3DPTEXTURECAPS_ALPHA
            | D3DPTEXTURECAPS_MIPMAP
            | D3DPTEXTURECAPS_PERSPECTIVE;
    caps->TextureFilterCaps = D3DPTFILTERCAPS_MINFPOINT
            | D3DPTFILTERCAPS_MINFLINEAR
            | D3DPTFILTERCAPS_MAGFPOINT
            | D3DPTFILTERCAPS_MAGFLINEAR
            | D3DPTFILTERCAPS_MIPFPOINT
            | D3DPTFILTERCAPS_MIPFLINEAR;
    caps->CubeTextureFilterCaps = caps->TextureFilterCaps;
    caps->VolumeTextureFilterCaps = caps->TextureFilterCaps;
    caps->TextureAddressCaps = D3DPTADDRESSCAPS_WRAP
            | D3DPTADDRESSCAPS_MIRROR
            | D3DPTADDRESSCAPS_CLAMP;
    caps->VolumeTextureAddressCaps = caps->TextureAddressCaps;
    caps->MaxTextureWidth = 4096;
    caps->MaxTextureHeight = 4096;
    caps->MaxVolumeExtent = 256;
    caps->MaxTextureRepeat = 8192;
    caps->MaxTextureAspectRatio = 4096;
    caps->MaxAnisotropy = 1;
    caps->MaxVertexW = 1.0e10f;
    caps->MaxPrimitiveCount = 0xFFFFFu;
    caps->MaxVertexIndex = 0xFFFFFFu;
    caps->MaxStreams = D8WG_MAX_STREAMS;
    caps->MaxStreamStride = 255;
    caps->VertexShaderVersion = 0;
    caps->MaxVertexShaderConst = 96;
    caps->PixelShaderVersion = 0;
    caps->MaxPixelShaderValue = 8.0f;
    caps->MaxTextureBlendStages = D8WG_MAX_TEXTURE_STAGES;
    caps->MaxSimultaneousTextures = D8WG_MAX_TEXTURE_STAGES;
}

static HRESULT WINAPI d3d_query_interface(IDirect3D8 *iface, REFIID iid,
        void **object)
{
    (void)iid;
    if (!object)
        return E_POINTER;
    *object = iface;
    IDirect3D8_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI d3d_add_ref(IDirect3D8 *iface)
{
    return (ULONG)InterlockedIncrement(&d3d_from_iface(iface)->refcount);
}

static ULONG WINAPI d3d_release(IDirect3D8 *iface)
{
    D8Direct3D *d3d = d3d_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&d3d->refcount);
    if (!refs)
        HeapFree(GetProcessHeap(), 0, d3d);
    return refs;
}

static HRESULT WINAPI d3d_register_software_device(IDirect3D8 *iface,
        void *initialize)
{
    (void)iface;
    (void)initialize;
    return D3DERR_INVALIDCALL;
}

static UINT WINAPI d3d_get_adapter_count(IDirect3D8 *iface)
{
    (void)iface;
    return 1;
}

static HRESULT WINAPI d3d_get_adapter_identifier(IDirect3D8 *iface,
        UINT adapter, DWORD flags, D3DADAPTER_IDENTIFIER8 *identifier)
{
    (void)iface;
    (void)flags;
    if (adapter || !identifier)
        return D3DERR_INVALIDCALL;
    ZeroMemory(identifier, sizeof(*identifier));
    lstrcpynA(identifier->Driver, "d3d8-webgpu", sizeof(identifier->Driver));
    lstrcpynA(identifier->Description,
            "v86 Direct3D 8 WebGPU Adapter", sizeof(identifier->Description));
    identifier->VendorId = 0x1234;
    identifier->DeviceId = 0x5686;
    identifier->SubSysId = 0x56861234;
    identifier->Revision = 1;
    identifier->WHQLLevel = 0;
    return D3D_OK;
}

static UINT WINAPI d3d_get_adapter_mode_count(IDirect3D8 *iface, UINT adapter)
{
    (void)iface;
    return adapter ? 0 : 6;
}

static HRESULT WINAPI d3d_enum_adapter_modes(IDirect3D8 *iface, UINT adapter,
        UINT index, D3DDISPLAYMODE *mode)
{
    static const struct {
        UINT width;
        UINT height;
        D3DFORMAT format;
    } modes[] = {
        { 640, 480, D3DFMT_R5G6B5 },
        { 640, 480, D3DFMT_X8R8G8B8 },
        { 800, 600, D3DFMT_R5G6B5 },
        { 800, 600, D3DFMT_X8R8G8B8 },
        { 1024, 768, D3DFMT_R5G6B5 },
        { 1024, 768, D3DFMT_X8R8G8B8 }
    };
    (void)iface;
    if (adapter || !mode || index >= sizeof(modes) / sizeof(modes[0]))
        return D3DERR_INVALIDCALL;
    fill_display_mode(mode, modes[index].width, modes[index].height,
            modes[index].format);
    return D3D_OK;
}

static HRESULT WINAPI d3d_get_adapter_display_mode(IDirect3D8 *iface,
        UINT adapter, D3DDISPLAYMODE *mode)
{
    (void)iface;
    if (adapter || !mode)
        return D3DERR_INVALIDCALL;
    fill_display_mode(mode, 1024, 768, D3DFMT_X8R8G8B8);
    return D3D_OK;
}

static HRESULT WINAPI d3d_check_device_type(IDirect3D8 *iface, UINT adapter,
        D3DDEVTYPE type, D3DFORMAT display_format,
        D3DFORMAT backbuffer_format, WINBOOL windowed)
{
    (void)iface;
    (void)display_format;
    (void)backbuffer_format;
    (void)windowed;
    return !adapter && type == D3DDEVTYPE_HAL ? D3D_OK
            : D3DERR_NOTAVAILABLE;
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
    case D3DFMT_DXT1:
    case D3DFMT_DXT3:
    case D3DFMT_DXT5:
        return TRUE;
    default:
        return FALSE;
    }
}

static HRESULT WINAPI d3d_check_device_format(IDirect3D8 *iface,
        UINT adapter, D3DDEVTYPE type, D3DFORMAT adapter_format,
        DWORD usage, D3DRESOURCETYPE resource_type, D3DFORMAT format)
{
    (void)iface;
    (void)adapter_format;
    (void)usage;
    if (adapter || type != D3DDEVTYPE_HAL)
        return D3DERR_NOTAVAILABLE;
    if (resource_type == D3DRTYPE_TEXTURE && supported_texture_format(format))
        return D3D_OK;
    return D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_check_multisample(IDirect3D8 *iface, UINT adapter,
        D3DDEVTYPE type, D3DFORMAT format, WINBOOL windowed,
        D3DMULTISAMPLE_TYPE multisample)
{
    (void)iface;
    (void)format;
    (void)windowed;
    return !adapter && type == D3DDEVTYPE_HAL
            && multisample == D3DMULTISAMPLE_NONE
            ? D3D_OK : D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_check_depth_stencil(IDirect3D8 *iface,
        UINT adapter, D3DDEVTYPE type, D3DFORMAT adapter_format,
        D3DFORMAT render_format, D3DFORMAT depth_format)
{
    (void)iface;
    (void)adapter_format;
    (void)render_format;
    if (adapter || type != D3DDEVTYPE_HAL)
        return D3DERR_NOTAVAILABLE;
    return depth_format == D3DFMT_D16 || depth_format == D3DFMT_D24S8
            ? D3D_OK : D3DERR_NOTAVAILABLE;
}

static HRESULT WINAPI d3d_get_device_caps(IDirect3D8 *iface, UINT adapter,
        D3DDEVTYPE type, D3DCAPS8 *caps)
{
    (void)iface;
    if (adapter || type != D3DDEVTYPE_HAL || !caps)
        return D3DERR_INVALIDCALL;
    fill_caps(caps);
    return D3D_OK;
}

static HMONITOR WINAPI d3d_get_adapter_monitor(IDirect3D8 *iface,
        UINT adapter)
{
    (void)iface;
    if (adapter)
        return NULL;
    return MonitorFromWindow(NULL, MONITOR_DEFAULTTOPRIMARY);
}

static void device_init_states(D8Device *device)
{
    UINT stage;
    ZeroMemory(device->render_states, sizeof(device->render_states));
    ZeroMemory(device->texture_stage_states,
            sizeof(device->texture_stage_states));
    device->render_states[D3DRS_ZENABLE] = D3DZB_TRUE;
    device->render_states[D3DRS_ZWRITEENABLE] = TRUE;
    device->render_states[D3DRS_CULLMODE] = D3DCULL_CCW;
    device->render_states[D3DRS_LIGHTING] = TRUE;
    device->render_states[D3DRS_SHADEMODE] = D3DSHADE_GOURAUD;
    for (stage = 0; stage < D8WG_MAX_TEXTURE_STAGES; ++stage) {
        device->texture_stage_states[stage][D3DTSS_COLOROP] =
                stage == 0 ? D3DTOP_MODULATE : D3DTOP_DISABLE;
        device->texture_stage_states[stage][D3DTSS_COLORARG1] = D3DTA_TEXTURE;
        device->texture_stage_states[stage][D3DTSS_COLORARG2] = D3DTA_CURRENT;
        device->texture_stage_states[stage][D3DTSS_ALPHAOP] =
                stage == 0 ? D3DTOP_SELECTARG1 : D3DTOP_DISABLE;
        device->texture_stage_states[stage][D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
        device->texture_stage_states[stage][D3DTSS_ALPHAARG2] = D3DTA_CURRENT;
    }
}

static HRESULT WINAPI d3d_create_device(IDirect3D8 *iface, UINT adapter,
        D3DDEVTYPE type, HWND focus_window, DWORD behavior,
        D3DPRESENT_PARAMETERS *parameters, IDirect3DDevice8 **device_out)
{
    D8Direct3D *d3d = d3d_from_iface(iface);
    D8Device *device;
    D8WGCreateDevice command;
    HWND window;
    RECT client;
    POINT origin;

    if (adapter || type != D3DDEVTYPE_HAL || !parameters || !device_out)
        return D3DERR_INVALIDCALL;
    if (parameters->MultiSampleType != D3DMULTISAMPLE_NONE)
        return D3DERR_NOTAVAILABLE;

    device = (D8Device *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*device));
    if (!device)
        return E_OUTOFMEMORY;
    device->iface.lpVtbl = &g_device_vtbl;
    device->refcount = 1;
    device->parent = d3d;
    IDirect3D8_AddRef(iface);
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
    if (!command.width)
        command.width = 640;
    if (!command.height)
        command.height = 480;
    command.backbuffer_format = device->display_mode.Format;
    command.windowed = parameters->Windowed;
    command.behavior_flags = behavior;
    if (!emit_command(D8WG_OP_CREATE_DEVICE, &command, sizeof(command))) {
        IDirect3D8_Release(iface);
        HeapFree(GetProcessHeap(), 0, device);
        return D3DERR_DRIVERINTERNALERROR;
    }

    *device_out = &device->iface;
    return D3D_OK;
}

static HRESULT WINAPI device_query_interface(IDirect3DDevice8 *iface,
        REFIID iid, void **object)
{
    (void)iid;
    if (!object)
        return E_POINTER;
    *object = iface;
    IDirect3DDevice8_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI device_add_ref(IDirect3DDevice8 *iface)
{
    return (ULONG)InterlockedIncrement(&device_from_iface(iface)->refcount);
}

static ULONG WINAPI device_release(IDirect3DDevice8 *iface)
{
    D8Device *device = device_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&device->refcount);
    if (!refs) {
        D8WGDestroyResource destroy;
        destroy.resource_handle = device->handle;
        destroy.resource_kind = 0;
        emit_command(D8WG_OP_DESTROY_RESOURCE, &destroy, sizeof(destroy));
        IDirect3D8_Release(&device->parent->iface);
        HeapFree(GetProcessHeap(), 0, device);
    }
    return refs;
}

static HRESULT WINAPI device_test_cooperative_level(IDirect3DDevice8 *iface)
{
    (void)iface;
    return D3D_OK;
}

static UINT WINAPI device_get_available_texture_mem(IDirect3DDevice8 *iface)
{
    (void)iface;
    return 128u * 1024u * 1024u;
}

static HRESULT WINAPI device_discard_bytes(IDirect3DDevice8 *iface, DWORD bytes)
{
    (void)iface;
    (void)bytes;
    return D3D_OK;
}

static HRESULT WINAPI device_get_direct3d(IDirect3DDevice8 *iface,
        IDirect3D8 **d3d_out)
{
    D8Device *device = device_from_iface(iface);
    if (!d3d_out)
        return D3DERR_INVALIDCALL;
    *d3d_out = &device->parent->iface;
    IDirect3D8_AddRef(*d3d_out);
    return D3D_OK;
}

static HRESULT WINAPI device_get_caps(IDirect3DDevice8 *iface, D3DCAPS8 *caps)
{
    (void)iface;
    if (!caps)
        return D3DERR_INVALIDCALL;
    fill_caps(caps);
    return D3D_OK;
}

static HRESULT WINAPI device_get_display_mode(IDirect3DDevice8 *iface,
        D3DDISPLAYMODE *mode)
{
    if (!mode)
        return D3DERR_INVALIDCALL;
    *mode = device_from_iface(iface)->display_mode;
    return D3D_OK;
}

static HRESULT WINAPI device_get_creation_parameters(IDirect3DDevice8 *iface,
        D3DDEVICE_CREATION_PARAMETERS *parameters)
{
    if (!parameters)
        return D3DERR_INVALIDCALL;
    *parameters = device_from_iface(iface)->creation;
    return D3D_OK;
}

static HRESULT WINAPI device_reset(IDirect3DDevice8 *iface,
        D3DPRESENT_PARAMETERS *parameters)
{
    D8Device *device = device_from_iface(iface);
    D8WGCreateDevice reset;
    RECT client;
    POINT origin;
    HWND window;

    if (!parameters || parameters->MultiSampleType != D3DMULTISAMPLE_NONE)
        return D3DERR_INVALIDCALL;
    device->present = *parameters;
    window = parameters->hDeviceWindow ? parameters->hDeviceWindow
            : device->creation.hFocusWindow;
    SetRect(&client, 0, 0, 640, 480);
    origin.x = origin.y = 0;
    if (window) {
        GetClientRect(window, &client);
        ClientToScreen(window, &origin);
    }
    ZeroMemory(&reset, sizeof(reset));
    reset.device_handle = device->handle;
    reset.hwnd = (uint32_t)(uintptr_t)window;
    reset.x = origin.x;
    reset.y = origin.y;
    reset.width = parameters->BackBufferWidth
            ? parameters->BackBufferWidth : (uint32_t)(client.right - client.left);
    reset.height = parameters->BackBufferHeight
            ? parameters->BackBufferHeight : (uint32_t)(client.bottom - client.top);
    reset.backbuffer_format = parameters->BackBufferFormat;
    reset.windowed = parameters->Windowed;
    reset.behavior_flags = device->creation.BehaviorFlags;
    device->viewport.X = device->viewport.Y = 0;
    device->viewport.Width = reset.width;
    device->viewport.Height = reset.height;
    return emit_command(D8WG_OP_RESET, &reset, sizeof(reset))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_present(IDirect3DDevice8 *iface,
        const RECT *source, const RECT *destination, HWND override_window,
        const RGNDATA *dirty_region)
{
    (void)source;
    (void)destination;
    (void)override_window;
    (void)dirty_region;
    return emit_present_and_flush(device_from_iface(iface)->handle)
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_begin_scene(IDirect3DDevice8 *iface)
{
    D8Device *device = device_from_iface(iface);
    D8WGDeviceOnly command;
    if (device->in_scene)
        return D3DERR_INVALIDCALL;
    device->in_scene = TRUE;
    command.device_handle = device->handle;
    command.reserved = 0;
    return emit_command(D8WG_OP_BEGIN_SCENE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_end_scene(IDirect3DDevice8 *iface)
{
    D8Device *device = device_from_iface(iface);
    D8WGDeviceOnly command;
    if (!device->in_scene)
        return D3DERR_INVALIDCALL;
    device->in_scene = FALSE;
    command.device_handle = device->handle;
    command.reserved = 0;
    return emit_command(D8WG_OP_END_SCENE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_clear(IDirect3DDevice8 *iface, DWORD rect_count,
        const D3DRECT *rects, DWORD flags, D3DCOLOR color, float depth,
        DWORD stencil)
{
    D8Device *device = device_from_iface(iface);
    D8WGClear command;
    D8WGCommandHeader *header;
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
    command.depth = depth;
    command.stencil = stencil;
    command.rect_count = rect_count;

    EnterCriticalSection(&g_transport_lock);
    result = reserve_command_locked(D8WG_OP_CLEAR, sizeof(command), rect_bytes,
            &header, &payload, &rect_data);
    if (result) {
        CopyMemory(payload, &command, sizeof(command));
        if (rect_bytes)
            CopyMemory(rect_data, rects, rect_bytes);
        (void)header;
    }
    LeaveCriticalSection(&g_transport_lock);
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_set_viewport(IDirect3DDevice8 *iface,
        const D3DVIEWPORT8 *viewport)
{
    if (!viewport || !viewport->Width || !viewport->Height)
        return D3DERR_INVALIDCALL;
    device_from_iface(iface)->viewport = *viewport;
    return D3D_OK;
}

static HRESULT WINAPI device_get_viewport(IDirect3DDevice8 *iface,
        D3DVIEWPORT8 *viewport)
{
    if (!viewport)
        return D3DERR_INVALIDCALL;
    *viewport = device_from_iface(iface)->viewport;
    return D3D_OK;
}

static HRESULT WINAPI device_set_render_state(IDirect3DDevice8 *iface,
        D3DRENDERSTATETYPE state, DWORD value)
{
    D8Device *device = device_from_iface(iface);
    D8WGSetRenderState command;
    if ((UINT)state >= D8WG_MAX_RENDER_STATES)
        return D3DERR_INVALIDCALL;
    if (device->render_states[state] == value)
        return D3D_OK;
    device->render_states[state] = value;
    command.device_handle = device->handle;
    command.state = state;
    command.value = value;
    command.reserved = 0;
    return emit_command(D8WG_OP_SET_RENDER_STATE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_render_state(IDirect3DDevice8 *iface,
        D3DRENDERSTATETYPE state, DWORD *value)
{
    if (!value || (UINT)state >= D8WG_MAX_RENDER_STATES)
        return D3DERR_INVALIDCALL;
    *value = device_from_iface(iface)->render_states[state];
    return D3D_OK;
}

static HRESULT WINAPI device_set_texture_stage_state(IDirect3DDevice8 *iface,
        DWORD stage, D3DTEXTURESTAGESTATETYPE state, DWORD value)
{
    D8Device *device = device_from_iface(iface);
    D8WGSetTextureStageState command;
    if (stage >= D8WG_MAX_TEXTURE_STAGES
            || (UINT)state >= D8WG_MAX_TEXTURE_STAGE_STATES)
        return D3DERR_INVALIDCALL;
    if (device->texture_stage_states[stage][state] == value)
        return D3D_OK;
    device->texture_stage_states[stage][state] = value;
    command.device_handle = device->handle;
    command.stage = stage;
    command.state = state;
    command.value = value;
    return emit_command(D8WG_OP_SET_TEXTURE_STAGE_STATE,
            &command, sizeof(command)) ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_texture_stage_state(IDirect3DDevice8 *iface,
        DWORD stage, D3DTEXTURESTAGESTATETYPE state, DWORD *value)
{
    if (!value || stage >= D8WG_MAX_TEXTURE_STAGES
            || (UINT)state >= D8WG_MAX_TEXTURE_STAGE_STATES)
        return D3DERR_INVALIDCALL;
    *value = device_from_iface(iface)->texture_stage_states[stage][state];
    return D3D_OK;
}

static HRESULT WINAPI device_create_vertex_buffer(IDirect3DDevice8 *iface,
        UINT length, DWORD usage, DWORD fvf, D3DPOOL pool,
        IDirect3DVertexBuffer8 **buffer_out)
{
    D8Device *device = device_from_iface(iface);
    D8VertexBuffer *buffer;
    D8WGCreateBuffer command;
    if (!length || !buffer_out)
        return D3DERR_INVALIDCALL;
    buffer = (D8VertexBuffer *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
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
    IDirect3DDevice8_AddRef(iface);
    buffer->handle = allocate_handle();
    buffer->length = length;
    buffer->usage = usage;
    buffer->fvf = fvf;
    buffer->pool = pool;

    command.device_handle = device->handle;
    command.resource_handle = buffer->handle;
    command.resource_kind = D8WG_RESOURCE_BUFFER_VERTEX;
    command.byte_count = length;
    command.usage = usage;
    command.fvf = fvf;
    command.pool = pool;
    command.reserved = 0;
    if (!emit_command(D8WG_OP_CREATE_BUFFER, &command, sizeof(command))) {
        IDirect3DDevice8_Release(iface);
        HeapFree(GetProcessHeap(), 0, buffer->shadow);
        HeapFree(GetProcessHeap(), 0, buffer);
        return D3DERR_DRIVERINTERNALERROR;
    }
    *buffer_out = &buffer->iface;
    return D3D_OK;
}

static HRESULT WINAPI device_set_stream_source(IDirect3DDevice8 *iface,
        UINT stream, IDirect3DVertexBuffer8 *buffer_iface, UINT stride)
{
    D8Device *device = device_from_iface(iface);
    D8VertexBuffer *buffer = buffer_iface ? vb_from_iface(buffer_iface) : NULL;
    D8WGSetStreamSource command;
    if (stream >= D8WG_MAX_STREAMS)
        return D3DERR_INVALIDCALL;
    if (buffer && buffer->device != device)
        return D3DERR_INVALIDCALL;
    if (device->streams[stream].buffer == buffer
            && device->streams[stream].stride == stride)
        return D3D_OK;
    if (buffer)
        IDirect3DVertexBuffer8_AddRef(buffer_iface);
    if (device->streams[stream].buffer)
        IDirect3DVertexBuffer8_Release(
                &device->streams[stream].buffer->iface);
    device->streams[stream].buffer = buffer;
    device->streams[stream].stride = stride;
    command.device_handle = device->handle;
    command.stream = stream;
    command.buffer_handle = buffer ? buffer->handle : 0;
    command.stride = stride;
    return emit_command(D8WG_OP_SET_STREAM_SOURCE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_stream_source(IDirect3DDevice8 *iface,
        UINT stream, IDirect3DVertexBuffer8 **buffer_out, UINT *stride_out)
{
    D8Device *device = device_from_iface(iface);
    if (stream >= D8WG_MAX_STREAMS || !buffer_out || !stride_out)
        return D3DERR_INVALIDCALL;
    *stride_out = device->streams[stream].stride;
    *buffer_out = device->streams[stream].buffer
            ? &device->streams[stream].buffer->iface : NULL;
    if (*buffer_out)
        IDirect3DVertexBuffer8_AddRef(*buffer_out);
    return D3D_OK;
}

static HRESULT WINAPI device_set_vertex_shader(IDirect3DDevice8 *iface,
        DWORD handle)
{
    D8Device *device = device_from_iface(iface);
    D8WGSetVertexFormat command;
    /* Milestone 1 supports FVF tokens. D3D8 shader handles always have bit 0. */
    if (handle & 1u)
        return D3DERR_INVALIDCALL;
    if (device->vertex_shader == handle)
        return D3D_OK;
    device->vertex_shader = handle;
    command.device_handle = device->handle;
    command.fvf = handle;
    return emit_command(D8WG_OP_SET_VERTEX_FORMAT, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_get_vertex_shader(IDirect3DDevice8 *iface,
        DWORD *handle)
{
    if (!handle)
        return D3DERR_INVALIDCALL;
    *handle = device_from_iface(iface)->vertex_shader;
    return D3D_OK;
}

static HRESULT WINAPI device_draw_primitive(IDirect3DDevice8 *iface,
        D3DPRIMITIVETYPE primitive_type, UINT start_vertex,
        UINT primitive_count)
{
    D8Device *device = device_from_iface(iface);
    D8WGDrawPrimitive command;
    if (!device->streams[0].buffer || !device->streams[0].stride
            || !device->vertex_shader || !primitive_count)
        return D3DERR_INVALIDCALL;
    command.device_handle = device->handle;
    command.primitive_type = primitive_type;
    command.start_vertex = start_vertex;
    command.primitive_count = primitive_count;
    return emit_command(D8WG_OP_DRAW_PRIMITIVE, &command, sizeof(command))
            ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI device_validate(IDirect3DDevice8 *iface, DWORD *passes)
{
    (void)iface;
    if (!passes)
        return D3DERR_INVALIDCALL;
    *passes = 1;
    return D3D_OK;
}

static HRESULT WINAPI vb_query_interface(IDirect3DVertexBuffer8 *iface,
        REFIID iid, void **object)
{
    (void)iid;
    if (!object)
        return E_POINTER;
    *object = iface;
    IDirect3DVertexBuffer8_AddRef(iface);
    return S_OK;
}

static ULONG WINAPI vb_add_ref(IDirect3DVertexBuffer8 *iface)
{
    return (ULONG)InterlockedIncrement(&vb_from_iface(iface)->refcount);
}

static ULONG WINAPI vb_release(IDirect3DVertexBuffer8 *iface)
{
    D8VertexBuffer *buffer = vb_from_iface(iface);
    ULONG refs = (ULONG)InterlockedDecrement(&buffer->refcount);
    if (!refs) {
        D8WGDestroyResource destroy;
        destroy.resource_handle = buffer->handle;
        destroy.resource_kind = D8WG_RESOURCE_BUFFER_VERTEX;
        emit_command(D8WG_OP_DESTROY_RESOURCE, &destroy, sizeof(destroy));
        HeapFree(GetProcessHeap(), 0, buffer->shadow);
        IDirect3DDevice8_Release(&buffer->device->iface);
        HeapFree(GetProcessHeap(), 0, buffer);
    }
    return refs;
}

static HRESULT WINAPI vb_get_device(IDirect3DVertexBuffer8 *iface,
        IDirect3DDevice8 **device_out)
{
    D8VertexBuffer *buffer = vb_from_iface(iface);
    if (!device_out)
        return D3DERR_INVALIDCALL;
    *device_out = &buffer->device->iface;
    IDirect3DDevice8_AddRef(*device_out);
    return D3D_OK;
}

static HRESULT WINAPI vb_set_private_data(IDirect3DVertexBuffer8 *iface,
        REFGUID guid, const void *data, DWORD size, DWORD flags)
{
    (void)iface; (void)guid; (void)data; (void)size; (void)flags;
    return D3DERR_INVALIDCALL;
}

static HRESULT WINAPI vb_get_private_data(IDirect3DVertexBuffer8 *iface,
        REFGUID guid, void *data, DWORD *size)
{
    (void)iface; (void)guid; (void)data; (void)size;
    return D3DERR_NOTFOUND;
}

static HRESULT WINAPI vb_free_private_data(IDirect3DVertexBuffer8 *iface,
        REFGUID guid)
{
    (void)iface; (void)guid;
    return D3DERR_NOTFOUND;
}

static DWORD WINAPI vb_set_priority(IDirect3DVertexBuffer8 *iface,
        DWORD priority)
{
    D8VertexBuffer *buffer = vb_from_iface(iface);
    DWORD old = buffer->priority;
    buffer->priority = priority;
    return old;
}

static DWORD WINAPI vb_get_priority(IDirect3DVertexBuffer8 *iface)
{
    return vb_from_iface(iface)->priority;
}

static void WINAPI vb_preload(IDirect3DVertexBuffer8 *iface)
{
    (void)iface;
}

static D3DRESOURCETYPE WINAPI vb_get_type(IDirect3DVertexBuffer8 *iface)
{
    (void)iface;
    return D3DRTYPE_VERTEXBUFFER;
}

static HRESULT WINAPI vb_lock(IDirect3DVertexBuffer8 *iface, UINT offset,
        UINT size, BYTE **data_out, DWORD flags)
{
    D8VertexBuffer *buffer = vb_from_iface(iface);
    (void)flags;
    if (!data_out || buffer->locked || offset > buffer->length)
        return D3DERR_INVALIDCALL;
    if (!size)
        size = buffer->length - offset;
    if (size > buffer->length - offset)
        return D3DERR_INVALIDCALL;
    buffer->locked = TRUE;
    buffer->lock_offset = offset;
    buffer->lock_size = size;
    *data_out = buffer->shadow + offset;
    return D3D_OK;
}

static HRESULT WINAPI vb_unlock(IDirect3DVertexBuffer8 *iface)
{
    D8VertexBuffer *buffer = vb_from_iface(iface);
    BOOL result;
    if (!buffer->locked)
        return D3DERR_INVALIDCALL;
    result = emit_buffer_update(buffer->handle, buffer->lock_offset,
            buffer->shadow + buffer->lock_offset, buffer->lock_size);
    buffer->locked = FALSE;
    buffer->lock_offset = 0;
    buffer->lock_size = 0;
    return result ? D3D_OK : D3DERR_DRIVERINTERNALERROR;
}

static HRESULT WINAPI vb_get_desc(IDirect3DVertexBuffer8 *iface,
        D3DVERTEXBUFFER_DESC *desc)
{
    D8VertexBuffer *buffer = vb_from_iface(iface);
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

/* Typed unsupported methods keep stdcall stack cleanup correct on 32-bit XP. */
#define DEV_STUB0(name) \
    static HRESULT WINAPI device_##name(IDirect3DDevice8 *iface) \
    { (void)iface; return D3DERR_INVALIDCALL; }
#define DEV_STUB(name, ...) \
    static HRESULT WINAPI device_##name(IDirect3DDevice8 *iface, __VA_ARGS__)

DEV_STUB(set_cursor_properties, UINT x, UINT y, IDirect3DSurface8 *surface)
{ (void)iface; (void)x; (void)y; (void)surface; return D3DERR_INVALIDCALL; }
static void WINAPI device_set_cursor_position(IDirect3DDevice8 *iface,
        UINT x, UINT y, DWORD flags)
{ (void)iface; (void)x; (void)y; (void)flags; }
static WINBOOL WINAPI device_show_cursor(IDirect3DDevice8 *iface, WINBOOL show)
{ (void)iface; (void)show; return FALSE; }
DEV_STUB(create_swapchain, D3DPRESENT_PARAMETERS *p, IDirect3DSwapChain8 **s)
{ (void)iface; (void)p; (void)s; return D3DERR_INVALIDCALL; }
DEV_STUB(get_backbuffer, UINT n, D3DBACKBUFFER_TYPE type, IDirect3DSurface8 **s)
{ (void)iface; (void)n; (void)type; (void)s; return D3DERR_INVALIDCALL; }
DEV_STUB(get_raster_status, D3DRASTER_STATUS *s)
{ (void)iface; (void)s; return D3DERR_INVALIDCALL; }
static void WINAPI device_set_gamma(IDirect3DDevice8 *iface, DWORD flags,
        const D3DGAMMARAMP *ramp)
{ (void)iface; (void)flags; (void)ramp; }
static void WINAPI device_get_gamma(IDirect3DDevice8 *iface, D3DGAMMARAMP *ramp)
{ (void)iface; if (ramp) ZeroMemory(ramp, sizeof(*ramp)); }
DEV_STUB(create_texture, UINT w, UINT h, UINT levels, DWORD usage,
        D3DFORMAT format, D3DPOOL pool, IDirect3DTexture8 **out)
{ (void)iface;(void)w;(void)h;(void)levels;(void)usage;(void)format;(void)pool;(void)out; return D3DERR_INVALIDCALL; }
DEV_STUB(create_volume_texture, UINT w, UINT h, UINT d, UINT levels, DWORD usage,
        D3DFORMAT format, D3DPOOL pool, IDirect3DVolumeTexture8 **out)
{ (void)iface;(void)w;(void)h;(void)d;(void)levels;(void)usage;(void)format;(void)pool;(void)out; return D3DERR_INVALIDCALL; }
DEV_STUB(create_cube_texture, UINT edge, UINT levels, DWORD usage,
        D3DFORMAT format, D3DPOOL pool, IDirect3DCubeTexture8 **out)
{ (void)iface;(void)edge;(void)levels;(void)usage;(void)format;(void)pool;(void)out; return D3DERR_INVALIDCALL; }
DEV_STUB(create_index_buffer, UINT length, DWORD usage, D3DFORMAT format,
        D3DPOOL pool, IDirect3DIndexBuffer8 **out)
{ (void)iface;(void)length;(void)usage;(void)format;(void)pool;(void)out; return D3DERR_INVALIDCALL; }
DEV_STUB(create_render_target, UINT w, UINT h, D3DFORMAT format,
        D3DMULTISAMPLE_TYPE ms, WINBOOL lockable, IDirect3DSurface8 **out)
{ (void)iface;(void)w;(void)h;(void)format;(void)ms;(void)lockable;(void)out; return D3DERR_INVALIDCALL; }
DEV_STUB(create_depth_surface, UINT w, UINT h, D3DFORMAT format,
        D3DMULTISAMPLE_TYPE ms, IDirect3DSurface8 **out)
{ (void)iface;(void)w;(void)h;(void)format;(void)ms;(void)out; return D3DERR_INVALIDCALL; }
DEV_STUB(create_image_surface, UINT w, UINT h, D3DFORMAT format,
        IDirect3DSurface8 **out)
{ (void)iface;(void)w;(void)h;(void)format;(void)out; return D3DERR_INVALIDCALL; }
DEV_STUB(copy_rects, IDirect3DSurface8 *src, const RECT *rects, UINT count,
        IDirect3DSurface8 *dst, const POINT *points)
{ (void)iface;(void)src;(void)rects;(void)count;(void)dst;(void)points; return D3DERR_INVALIDCALL; }
DEV_STUB(update_texture, IDirect3DBaseTexture8 *src, IDirect3DBaseTexture8 *dst)
{ (void)iface;(void)src;(void)dst; return D3DERR_INVALIDCALL; }
DEV_STUB(get_front_buffer, IDirect3DSurface8 *dst)
{ (void)iface;(void)dst; return D3DERR_INVALIDCALL; }
DEV_STUB(set_render_target, IDirect3DSurface8 *rt, IDirect3DSurface8 *ds)
{ (void)iface;(void)rt;(void)ds; return D3DERR_INVALIDCALL; }
DEV_STUB(get_render_target, IDirect3DSurface8 **rt)
{ (void)iface;(void)rt; return D3DERR_INVALIDCALL; }
DEV_STUB(get_depth_surface, IDirect3DSurface8 **ds)
{ (void)iface;(void)ds; return D3DERR_INVALIDCALL; }
DEV_STUB(set_transform, D3DTRANSFORMSTATETYPE state, const D3DMATRIX *m)
{ (void)iface;(void)state;(void)m; return D3DERR_INVALIDCALL; }
DEV_STUB(get_transform, D3DTRANSFORMSTATETYPE state, D3DMATRIX *m)
{ (void)iface;(void)state;(void)m; return D3DERR_INVALIDCALL; }
DEV_STUB(multiply_transform, D3DTRANSFORMSTATETYPE state, const D3DMATRIX *m)
{ (void)iface;(void)state;(void)m; return D3DERR_INVALIDCALL; }
DEV_STUB(set_material, const D3DMATERIAL8 *m)
{ (void)iface;(void)m; return D3DERR_INVALIDCALL; }
DEV_STUB(get_material, D3DMATERIAL8 *m)
{ (void)iface;(void)m; return D3DERR_INVALIDCALL; }
DEV_STUB(set_light, DWORD index, const D3DLIGHT8 *light)
{ (void)iface;(void)index;(void)light; return D3DERR_INVALIDCALL; }
DEV_STUB(get_light, DWORD index, D3DLIGHT8 *light)
{ (void)iface;(void)index;(void)light; return D3DERR_INVALIDCALL; }
DEV_STUB(light_enable, DWORD index, WINBOOL enable)
{ (void)iface;(void)index;(void)enable; return D3DERR_INVALIDCALL; }
DEV_STUB(get_light_enable, DWORD index, WINBOOL *enable)
{ (void)iface;(void)index;(void)enable; return D3DERR_INVALIDCALL; }
DEV_STUB(set_clip_plane, DWORD index, const float *plane)
{ (void)iface;(void)index;(void)plane; return D3DERR_INVALIDCALL; }
DEV_STUB(get_clip_plane, DWORD index, float *plane)
{ (void)iface;(void)index;(void)plane; return D3DERR_INVALIDCALL; }
DEV_STUB0(begin_state_block)
DEV_STUB(end_state_block, DWORD *token)
{ (void)iface;(void)token; return D3DERR_INVALIDCALL; }
DEV_STUB(apply_state_block, DWORD token)
{ (void)iface;(void)token; return D3DERR_INVALIDCALL; }
DEV_STUB(capture_state_block, DWORD token)
{ (void)iface;(void)token; return D3DERR_INVALIDCALL; }
DEV_STUB(delete_state_block, DWORD token)
{ (void)iface;(void)token; return D3DERR_INVALIDCALL; }
DEV_STUB(create_state_block, D3DSTATEBLOCKTYPE type, DWORD *token)
{ (void)iface;(void)type;(void)token; return D3DERR_INVALIDCALL; }
DEV_STUB(set_clip_status, const D3DCLIPSTATUS8 *status)
{ (void)iface;(void)status; return D3DERR_INVALIDCALL; }
DEV_STUB(get_clip_status, D3DCLIPSTATUS8 *status)
{ (void)iface;(void)status; return D3DERR_INVALIDCALL; }
DEV_STUB(get_texture, DWORD stage, IDirect3DBaseTexture8 **texture)
{ (void)iface;(void)stage;if(texture)*texture=NULL; return D3D_OK; }
DEV_STUB(set_texture, DWORD stage, IDirect3DBaseTexture8 *texture)
{ (void)iface;(void)stage;(void)texture; return texture ? D3DERR_INVALIDCALL : D3D_OK; }
DEV_STUB(get_info, DWORD id, void *info, DWORD size)
{ (void)iface;(void)id;(void)info;(void)size; return D3DERR_NOTAVAILABLE; }
DEV_STUB(set_palette, UINT index, const PALETTEENTRY *entries)
{ (void)iface;(void)index;(void)entries; return D3DERR_INVALIDCALL; }
DEV_STUB(get_palette, UINT index, PALETTEENTRY *entries)
{ (void)iface;(void)index;(void)entries; return D3DERR_INVALIDCALL; }
DEV_STUB(set_current_palette, UINT index)
{ (void)iface;(void)index; return D3DERR_INVALIDCALL; }
DEV_STUB(get_current_palette, UINT *index)
{ (void)iface;(void)index; return D3DERR_INVALIDCALL; }
DEV_STUB(draw_indexed, D3DPRIMITIVETYPE type, UINT min, UINT vertices,
        UINT start, UINT count)
{ (void)iface;(void)type;(void)min;(void)vertices;(void)start;(void)count; return D3DERR_INVALIDCALL; }
DEV_STUB(draw_up, D3DPRIMITIVETYPE type, UINT count, const void *data, UINT stride)
{ (void)iface;(void)type;(void)count;(void)data;(void)stride; return D3DERR_INVALIDCALL; }
DEV_STUB(draw_indexed_up, D3DPRIMITIVETYPE type, UINT min, UINT vertices,
        UINT count, const void *indices, D3DFORMAT format, const void *data,
        UINT stride)
{ (void)iface;(void)type;(void)min;(void)vertices;(void)count;(void)indices;(void)format;(void)data;(void)stride; return D3DERR_INVALIDCALL; }
DEV_STUB(process_vertices, UINT src, UINT dst, UINT count,
        IDirect3DVertexBuffer8 *buffer, DWORD flags)
{ (void)iface;(void)src;(void)dst;(void)count;(void)buffer;(void)flags; return D3DERR_INVALIDCALL; }
DEV_STUB(create_vertex_shader, const DWORD *decl, const DWORD *code,
        DWORD *shader, DWORD usage)
{ (void)iface;(void)decl;(void)code;(void)shader;(void)usage; return D3DERR_INVALIDCALL; }
DEV_STUB(delete_vertex_shader, DWORD shader)
{ (void)iface;(void)shader; return D3DERR_INVALIDCALL; }
DEV_STUB(set_vs_constant, DWORD reg, const void *data, DWORD count)
{ (void)iface;(void)reg;(void)data;(void)count; return D3DERR_INVALIDCALL; }
DEV_STUB(get_vs_constant, DWORD reg, void *data, DWORD count)
{ (void)iface;(void)reg;(void)data;(void)count; return D3DERR_INVALIDCALL; }
DEV_STUB(get_vs_decl, DWORD shader, void *data, DWORD *size)
{ (void)iface;(void)shader;(void)data;(void)size; return D3DERR_INVALIDCALL; }
DEV_STUB(get_vs_function, DWORD shader, void *data, DWORD *size)
{ (void)iface;(void)shader;(void)data;(void)size; return D3DERR_INVALIDCALL; }
DEV_STUB(set_indices, IDirect3DIndexBuffer8 *buffer, UINT base)
{ (void)iface;(void)buffer;(void)base; return D3DERR_INVALIDCALL; }
DEV_STUB(get_indices, IDirect3DIndexBuffer8 **buffer, UINT *base)
{ (void)iface;(void)buffer;(void)base; return D3DERR_INVALIDCALL; }
DEV_STUB(create_pixel_shader, const DWORD *code, DWORD *shader)
{ (void)iface;(void)code;(void)shader; return D3DERR_INVALIDCALL; }
DEV_STUB(set_pixel_shader, DWORD shader)
{ (void)iface;(void)shader; return shader ? D3DERR_INVALIDCALL : D3D_OK; }
DEV_STUB(get_pixel_shader, DWORD *shader)
{ (void)iface;if(shader)*shader=0; return shader ? D3D_OK : D3DERR_INVALIDCALL; }
DEV_STUB(delete_pixel_shader, DWORD shader)
{ (void)iface;(void)shader; return D3DERR_INVALIDCALL; }
DEV_STUB(set_ps_constant, DWORD reg, const void *data, DWORD count)
{ (void)iface;(void)reg;(void)data;(void)count; return D3DERR_INVALIDCALL; }
DEV_STUB(get_ps_constant, DWORD reg, void *data, DWORD count)
{ (void)iface;(void)reg;(void)data;(void)count; return D3DERR_INVALIDCALL; }
DEV_STUB(get_ps_function, DWORD shader, void *data, DWORD *size)
{ (void)iface;(void)shader;(void)data;(void)size; return D3DERR_INVALIDCALL; }
DEV_STUB(draw_rect_patch, UINT handle, const float *segments,
        const D3DRECTPATCH_INFO *info)
{ (void)iface;(void)handle;(void)segments;(void)info; return D3DERR_INVALIDCALL; }
DEV_STUB(draw_tri_patch, UINT handle, const float *segments,
        const D3DTRIPATCH_INFO *info)
{ (void)iface;(void)handle;(void)segments;(void)info; return D3DERR_INVALIDCALL; }
DEV_STUB(delete_patch, UINT handle)
{ (void)iface;(void)handle; return D3DERR_INVALIDCALL; }

static IDirect3D8Vtbl g_d3d_vtbl = {
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
    .GetDeviceCaps = d3d_get_device_caps,
    .GetAdapterMonitor = d3d_get_adapter_monitor,
    .CreateDevice = d3d_create_device
};

static IDirect3DDevice8Vtbl g_device_vtbl = {
    .QueryInterface = device_query_interface,
    .AddRef = device_add_ref,
    .Release = device_release,
    .TestCooperativeLevel = device_test_cooperative_level,
    .GetAvailableTextureMem = device_get_available_texture_mem,
    .ResourceManagerDiscardBytes = device_discard_bytes,
    .GetDirect3D = device_get_direct3d,
    .GetDeviceCaps = device_get_caps,
    .GetDisplayMode = device_get_display_mode,
    .GetCreationParameters = device_get_creation_parameters,
    .SetCursorProperties = device_set_cursor_properties,
    .SetCursorPosition = device_set_cursor_position,
    .ShowCursor = device_show_cursor,
    .CreateAdditionalSwapChain = device_create_swapchain,
    .Reset = device_reset,
    .Present = device_present,
    .GetBackBuffer = device_get_backbuffer,
    .GetRasterStatus = device_get_raster_status,
    .SetGammaRamp = device_set_gamma,
    .GetGammaRamp = device_get_gamma,
    .CreateTexture = device_create_texture,
    .CreateVolumeTexture = device_create_volume_texture,
    .CreateCubeTexture = device_create_cube_texture,
    .CreateVertexBuffer = device_create_vertex_buffer,
    .CreateIndexBuffer = device_create_index_buffer,
    .CreateRenderTarget = device_create_render_target,
    .CreateDepthStencilSurface = device_create_depth_surface,
    .CreateImageSurface = device_create_image_surface,
    .CopyRects = device_copy_rects,
    .UpdateTexture = device_update_texture,
    .GetFrontBuffer = device_get_front_buffer,
    .SetRenderTarget = device_set_render_target,
    .GetRenderTarget = device_get_render_target,
    .GetDepthStencilSurface = device_get_depth_surface,
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
    .BeginStateBlock = device_begin_state_block,
    .EndStateBlock = device_end_state_block,
    .ApplyStateBlock = device_apply_state_block,
    .CaptureStateBlock = device_capture_state_block,
    .DeleteStateBlock = device_delete_state_block,
    .CreateStateBlock = device_create_state_block,
    .SetClipStatus = device_set_clip_status,
    .GetClipStatus = device_get_clip_status,
    .GetTexture = device_get_texture,
    .SetTexture = device_set_texture,
    .GetTextureStageState = device_get_texture_stage_state,
    .SetTextureStageState = device_set_texture_stage_state,
    .ValidateDevice = device_validate,
    .GetInfo = device_get_info,
    .SetPaletteEntries = device_set_palette,
    .GetPaletteEntries = device_get_palette,
    .SetCurrentTexturePalette = device_set_current_palette,
    .GetCurrentTexturePalette = device_get_current_palette,
    .DrawPrimitive = device_draw_primitive,
    .DrawIndexedPrimitive = device_draw_indexed,
    .DrawPrimitiveUP = device_draw_up,
    .DrawIndexedPrimitiveUP = device_draw_indexed_up,
    .ProcessVertices = device_process_vertices,
    .CreateVertexShader = device_create_vertex_shader,
    .SetVertexShader = device_set_vertex_shader,
    .GetVertexShader = device_get_vertex_shader,
    .DeleteVertexShader = device_delete_vertex_shader,
    .SetVertexShaderConstant = device_set_vs_constant,
    .GetVertexShaderConstant = device_get_vs_constant,
    .GetVertexShaderDeclaration = device_get_vs_decl,
    .GetVertexShaderFunction = device_get_vs_function,
    .SetStreamSource = device_set_stream_source,
    .GetStreamSource = device_get_stream_source,
    .SetIndices = device_set_indices,
    .GetIndices = device_get_indices,
    .CreatePixelShader = device_create_pixel_shader,
    .SetPixelShader = device_set_pixel_shader,
    .GetPixelShader = device_get_pixel_shader,
    .DeletePixelShader = device_delete_pixel_shader,
    .SetPixelShaderConstant = device_set_ps_constant,
    .GetPixelShaderConstant = device_get_ps_constant,
    .GetPixelShaderFunction = device_get_ps_function,
    .DrawRectPatch = device_draw_rect_patch,
    .DrawTriPatch = device_draw_tri_patch,
    .DeletePatch = device_delete_patch
};

static IDirect3DVertexBuffer8Vtbl g_vb_vtbl = {
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

IDirect3D8 *WINAPI Direct3DCreate8(UINT sdk_version)
{
    D8Direct3D *d3d;
    BOOL transport_ready;

    if (sdk_version != D3D_SDK_VERSION)
        return NULL;
    EnterCriticalSection(&g_transport_lock);
    transport_ready = open_transport_locked();
    LeaveCriticalSection(&g_transport_lock);
    if (!transport_ready)
        return NULL;

    d3d = (D8Direct3D *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            sizeof(*d3d));
    if (!d3d)
        return NULL;
    d3d->iface.lpVtbl = &g_d3d_vtbl;
    d3d->refcount = 1;
    emit_hello_once();
    return &d3d->iface;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
        InitializeCriticalSection(&g_transport_lock);
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
