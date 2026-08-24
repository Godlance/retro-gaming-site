/* Windows XP / Direct3D 1 execute-buffer smoke test. No CRT required. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define CINTERFACE
#include <windows.h>
#include <ddraw.h>
#include <d3d.h>

static void identity(D3DMATRIX *matrix)
{
    ZeroMemory(matrix, sizeof(*matrix));
    matrix->_11 = matrix->_22 = matrix->_33 = matrix->_44 = 1.0f;
}

static BYTE *append_instruction(BYTE *cursor, BYTE opcode, BYTE size,
        WORD count, const void *records)
{
    D3DINSTRUCTION *instruction = (D3DINSTRUCTION *)cursor;
    DWORD bytes = (DWORD)size * count;
    instruction->bOpcode = opcode;
    instruction->bSize = size;
    instruction->wCount = count;
    cursor += sizeof(*instruction);
    if (bytes) CopyMemory(cursor, records, bytes);
    return cursor + bytes;
}

void WINAPI WinMainCRTStartup(void)
{
    IDirectDraw *ddraw = NULL;
    IDirectDrawSurface *surface = NULL;
    IDirect3D *d3d = NULL;
    IDirect3D2 *d3d2 = NULL;
    IDirect3D3 *d3d3 = NULL;
    IDirect3DDevice *device = NULL;
    IDirect3DDevice2 *device2 = NULL;
    IDirect3DDevice3 *device3 = NULL;
    IDirect3DViewport *viewport = NULL;
    IDirect3DMaterial *material = NULL;
    IDirect3DExecuteBuffer *execute_buffer = NULL;
    DDSURFACEDESC surface_desc;
    D3DVIEWPORT viewport_data;
    D3DMATERIAL material_data;
    D3DMATERIALHANDLE material_handle;
    D3DEXECUTEBUFFERDESC buffer_desc;
    D3DEXECUTEDATA execute_data;
    D3DVERTEX *vertices;
    BYTE *memory;
    BYTE *instruction_start;
    BYTE *cursor;
    D3DMATRIXHANDLE world_handle, view_handle, projection_handle;
    D3DMATRIX matrix;
    D3DSTATE transform_states[3];
    D3DSTATE material_state;
    D3DPROCESSVERTICES process;
    D3DTRIANGLE triangle;
    HRESULT result;
    D3DTLVERTEX immediate[3];
    DWORD exit_code = 1;

    result = DirectDrawCreate(NULL, &ddraw, NULL);
    if (FAILED(result)) goto done;
    if (FAILED(IDirectDraw_SetCooperativeLevel(ddraw, GetDesktopWindow(),
            DDSCL_NORMAL))) goto done;
    if (FAILED(IDirectDraw_QueryInterface(ddraw, &IID_IDirect3D,
            (void **)&d3d))) goto done;
    /* These queries pin the shared DirectX 2 and 5/6 factory views too. */
    if (FAILED(IDirect3D_QueryInterface(d3d, &IID_IDirect3D2,
            (void **)&d3d2))) goto done;
    if (FAILED(IDirect3D_QueryInterface(d3d, &IID_IDirect3D3,
            (void **)&d3d3))) goto done;

    ZeroMemory(&surface_desc, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.dwWidth = 320;
    surface_desc.dwHeight = 240;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN |
            DDSCAPS_3DDEVICE | DDSCAPS_VIDEOMEMORY;
    if (FAILED(IDirectDraw_CreateSurface(ddraw, &surface_desc, &surface,
            NULL))) goto done;
    if (FAILED(IDirectDrawSurface_QueryInterface(surface,
            &IID_IDirect3DHALDevice, (void **)&device))) goto done;
    if (FAILED(IDirect3DDevice_QueryInterface(device, &IID_IDirect3DDevice2,
            (void **)&device2))) goto done;
    if (FAILED(IDirect3DDevice_QueryInterface(device, &IID_IDirect3DDevice3,
            (void **)&device3))) goto done;

    if (FAILED(IDirect3D_CreateViewport(d3d, &viewport, NULL))) goto done;
    if (FAILED(IDirect3DDevice_AddViewport(device, viewport))) goto done;
    ZeroMemory(&viewport_data, sizeof(viewport_data));
    viewport_data.dwSize = sizeof(viewport_data);
    viewport_data.dwWidth = 320;
    viewport_data.dwHeight = 240;
    viewport_data.dvScaleX = 160.0f;
    viewport_data.dvScaleY = 120.0f;
    viewport_data.dvMaxX = 320.0f;
    viewport_data.dvMaxY = 240.0f;
    viewport_data.dvMinZ = 0.0f;
    viewport_data.dvMaxZ = 1.0f;
    if (FAILED(IDirect3DViewport_SetViewport(viewport, &viewport_data)))
        goto done;

    if (FAILED(IDirect3D_CreateMaterial(d3d, &material, NULL))) goto done;
    ZeroMemory(&material_data, sizeof(material_data));
    material_data.dwSize = sizeof(material_data);
    material_data.diffuse.r = 0.2f;
    material_data.diffuse.g = 0.8f;
    material_data.diffuse.b = 1.0f;
    material_data.diffuse.a = 1.0f;
    material_data.ambient = material_data.diffuse;
    if (FAILED(IDirect3DMaterial_SetMaterial(material, &material_data)))
        goto done;
    if (FAILED(IDirect3DMaterial_GetHandle(material, device,
            &material_handle))) goto done;

    if (FAILED(IDirect3DDevice_CreateMatrix(device, &world_handle))) goto done;
    if (FAILED(IDirect3DDevice_CreateMatrix(device, &view_handle))) goto done;
    if (FAILED(IDirect3DDevice_CreateMatrix(device, &projection_handle)))
        goto done;
    identity(&matrix);
    if (FAILED(IDirect3DDevice_SetMatrix(device, world_handle, &matrix)) ||
            FAILED(IDirect3DDevice_SetMatrix(device, view_handle, &matrix)) ||
            FAILED(IDirect3DDevice_SetMatrix(device, projection_handle,
            &matrix))) goto done;

    ZeroMemory(&buffer_desc, sizeof(buffer_desc));
    buffer_desc.dwSize = sizeof(buffer_desc);
    buffer_desc.dwFlags = D3DDEB_BUFSIZE | D3DDEB_CAPS;
    buffer_desc.dwCaps = D3DDEBCAPS_SYSTEMMEMORY;
    buffer_desc.dwBufferSize = 2048;
    if (FAILED(IDirect3DDevice_CreateExecuteBuffer(device, &buffer_desc,
            &execute_buffer, NULL))) goto done;
    ZeroMemory(&buffer_desc, sizeof(buffer_desc));
    buffer_desc.dwSize = sizeof(buffer_desc);
    if (FAILED(IDirect3DExecuteBuffer_Lock(execute_buffer, &buffer_desc)))
        goto done;
    memory = (BYTE *)buffer_desc.lpData;
    vertices = (D3DVERTEX *)memory;
    ZeroMemory(vertices, sizeof(*vertices) * 3);
    vertices[0].x = -0.7f; vertices[0].y = -0.7f; vertices[0].z = 0.5f;
    vertices[1].x =  0.0f; vertices[1].y =  0.7f; vertices[1].z = 0.5f;
    vertices[2].x =  0.7f; vertices[2].y = -0.7f; vertices[2].z = 0.5f;
    vertices[0].nz = vertices[1].nz = vertices[2].nz = -1.0f;

    instruction_start = memory + 256;
    cursor = instruction_start;
    ZeroMemory(transform_states, sizeof(transform_states));
    transform_states[0].dtstTransformStateType = D3DTRANSFORMSTATE_WORLD;
    transform_states[0].dwArg[0] = world_handle;
    transform_states[1].dtstTransformStateType = D3DTRANSFORMSTATE_VIEW;
    transform_states[1].dwArg[0] = view_handle;
    transform_states[2].dtstTransformStateType = D3DTRANSFORMSTATE_PROJECTION;
    transform_states[2].dwArg[0] = projection_handle;
    cursor = append_instruction(cursor, D3DOP_STATETRANSFORM,
            sizeof(D3DSTATE), 3, transform_states);
    ZeroMemory(&material_state, sizeof(material_state));
    material_state.dlstLightStateType = D3DLIGHTSTATE_MATERIAL;
    material_state.dwArg[0] = material_handle;
    cursor = append_instruction(cursor, D3DOP_STATELIGHT,
            sizeof(material_state), 1, &material_state);
    ZeroMemory(&process, sizeof(process));
    process.dwFlags = D3DPROCESSVERTICES_TRANSFORMLIGHT |
            D3DPROCESSVERTICES_UPDATEEXTENTS;
    process.dwCount = 3;
    cursor = append_instruction(cursor, D3DOP_PROCESSVERTICES,
            sizeof(process), 1, &process);
    ZeroMemory(&triangle, sizeof(triangle));
    triangle.v1 = 0; triangle.v2 = 1; triangle.v3 = 2;
    triangle.wFlags = D3DTRIFLAG_EDGEENABLETRIANGLE;
    cursor = append_instruction(cursor, D3DOP_TRIANGLE,
            sizeof(triangle), 1, &triangle);
    cursor = append_instruction(cursor, D3DOP_EXIT, 0, 0, NULL);
    if (FAILED(IDirect3DExecuteBuffer_Unlock(execute_buffer))) goto done;

    ZeroMemory(&execute_data, sizeof(execute_data));
    execute_data.dwSize = sizeof(execute_data);
    execute_data.dwVertexOffset = 0;
    execute_data.dwVertexCount = 3;
    execute_data.dwInstructionOffset = 256;
    execute_data.dwInstructionLength = (DWORD)(cursor - instruction_start);
    execute_data.dwHVertexOffset = 1024;
    if (FAILED(IDirect3DExecuteBuffer_SetExecuteData(execute_buffer,
            &execute_data))) goto done;
    if (FAILED(IDirect3DExecuteBuffer_Validate(execute_buffer, NULL, NULL,
            NULL, 0))) goto done;
    if (FAILED(IDirect3DDevice_BeginScene(device))) goto done;
    result = IDirect3DDevice_Execute(device, execute_buffer, viewport,
            D3DEXECUTE_UNCLIPPED);
    IDirect3DDevice_EndScene(device);
    if (FAILED(result)) goto done;

    /* Exercise both draw-era device views after the execute-buffer pass. */
    ZeroMemory(immediate, sizeof(immediate));
    immediate[0].sx = 30.0f; immediate[0].sy = 210.0f;
    immediate[1].sx = 160.0f; immediate[1].sy = 30.0f;
    immediate[2].sx = 290.0f; immediate[2].sy = 210.0f;
    immediate[0].sz = immediate[1].sz = immediate[2].sz = 0.25f;
    immediate[0].rhw = immediate[1].rhw = immediate[2].rhw = 1.0f;
    immediate[0].color = 0xffff0000u;
    immediate[1].color = 0xff00ff00u;
    immediate[2].color = 0xff0000ffu;
    if (FAILED(IDirect3DDevice3_DrawPrimitive(device3, D3DPT_TRIANGLELIST,
            D3DFVF_TLVERTEX, immediate, 3, 0))) goto done;
    if (FAILED(IDirect3DDevice2_DrawPrimitive(device2, D3DPT_TRIANGLELIST,
            D3DVT_TLVERTEX, immediate, 3, 0))) goto done;
    exit_code = 0;

done:
    if (execute_buffer) IDirect3DExecuteBuffer_Release(execute_buffer);
    if (material) IDirect3DMaterial_Release(material);
    if (viewport) IDirect3DViewport_Release(viewport);
    if (device) IDirect3DDevice_Release(device);
    if (device3) IDirect3DDevice3_Release(device3);
    if (device2) IDirect3DDevice2_Release(device2);
    if (surface) IDirectDrawSurface_Release(surface);
    if (d3d3) IDirect3D3_Release(d3d3);
    if (d3d2) IDirect3D2_Release(d3d2);
    if (d3d) IDirect3D_Release(d3d);
    if (ddraw) IDirectDraw_Release(ddraw);
    ExitProcess(exit_code);
}
