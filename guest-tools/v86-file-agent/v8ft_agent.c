#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0501
#include <windows.h>
#include <stdint.h>
#include "v8ft_protocol.h"
#include "v8ft_shares.h"
#include "v8ft_pathsafe.h"
#include "v8ft_put.h"

#define V8FT_AGENT_MAJOR 1
#define V8FT_AGENT_MINOR 2
#define V8FT_AGENT_FEATURES (V8FT_FEATURE_ECHO | V8FT_FEATURE_SHARES | \
                             V8FT_FEATURE_LIST | V8FT_FEATURE_GET | \
                             V8FT_FEATURE_PUT | V8FT_FEATURE_CANCEL)
#define V8FT_BUILD_ID "v8ft-agent-1.2-phase3-20260811"
#define V8FT_MAX_REQUEST_BYTES V8FT_PUT_MAX_REQUEST_BYTES
#define V8FT_MAX_REQUEST_FILES V8FT_PUT_MAX_REQUEST_FILES
#define V8FT_MAX_DIR_ENTRIES_PER_PAGE 128
#define V8FT_GET_CHUNK_BYTES (V8FT_MAX_PAYLOAD_BYTES - 8)
#define V8FT_MAX_RELATIVE_UTF8_BYTES (MAX_PATH * 3)

typedef struct V8FTGetFile {
    WCHAR absolute_path[MAX_PATH];
    uint8_t relative_path[V8FT_MAX_RELATIVE_UTF8_BYTES];
    uint16_t relative_length;
    uint32_t size_bytes;
    uint32_t crc32;
} V8FTGetFile;

typedef struct V8FTGetState {
    int active;
    uint32_t request_id;
    uint32_t next_sequence;
    uint16_t file_count;
    uint16_t current_file;
    uint32_t current_offset;
    uint32_t outstanding_next_offset;
    uint32_t total_bytes;
    HANDLE file;
    V8FTGetFile files[V8FT_MAX_REQUEST_FILES];
} V8FTGetState;

static V8FTParser g_parser;
static uint8_t g_read_buffer[4096];
static uint8_t g_response[V8FT_MAX_PAYLOAD_BYTES];
static uint8_t g_session_nonce[16];
static uint32_t g_negotiated_features;
static uint32_t g_cursor_id;
static int g_session_ready;
static V8FTShare g_shares[V8FT_MAX_SHARES];
static int g_share_count;
static WCHAR g_executable_path[MAX_PATH];
static WCHAR g_config_path[MAX_PATH];
static V8FTGetState g_get;

static DWORD ascii_length(const char *text)
{
    DWORD length = 0;
    while(text[length]) length++;
    return length;
}

static uint16_t wide_length(const WCHAR *text)
{
    uint16_t length = 0;
    while(text[length]) length++;
    return length;
}

static void bytes_copy(void *target_value, const void *source_value, DWORD length)
{
    uint8_t *target = (uint8_t *)target_value;
    const uint8_t *source = (const uint8_t *)source_value;
    DWORD index;
    for(index = 0; index < length; index++) target[index] = source[index];
}

static void bytes_zero(void *target_value, DWORD length)
{
    uint8_t *target = (uint8_t *)target_value;
    DWORD index;
    for(index = 0; index < length; index++) target[index] = 0;
}

static void console_write_handle(HANDLE output, const char *text)
{
    DWORD ignored;
    WriteFile(output, text, ascii_length(text), &ignored, NULL);
}

static void console_write(const char *text)
{
    console_write_handle(GetStdHandle(STD_OUTPUT_HANDLE), text);
}

static void console_write_error(const char *text, DWORD error)
{
    char number[16];
    DWORD digits = 0;
    DWORD ignored;
    HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
    console_write_handle(output, text);
    do {
        number[digits++] = (char)('0' + error % 10);
        error /= 10;
    } while(error && digits < sizeof(number));
    while(digits) {
        char digit = number[--digits];
        WriteFile(output, &digit, 1, &ignored, NULL);
    }
    console_write_handle(output, "\r\n");
}

static int serial_write_all(HANDLE serial, const uint8_t *bytes, DWORD length)
{
    while(length) {
        DWORD written = 0;
        if(!WriteFile(serial, bytes, length, &written, NULL) || !written) return 0;
        bytes += written;
        length -= written;
    }
    return 1;
}

static int send_frame(HANDLE serial, uint8_t type, uint8_t flags,
                      uint32_t request_id, uint32_t sequence,
                      const uint8_t *payload, uint32_t payload_length)
{
    uint8_t header[V8FT_HEADER_BYTES];
    V8FTFrame frame;
    bytes_zero(&frame, sizeof(frame));
    frame.version_major = V8FT_VERSION_MAJOR;
    frame.version_minor = V8FT_VERSION_MINOR;
    frame.type = type;
    frame.flags = flags;
    frame.request_id = request_id;
    frame.sequence = sequence;
    frame.payload_length = payload_length;
    frame.payload = payload;
    if(!v8ft_encode_header(header, &frame)) return 0;
    if(!serial_write_all(serial, header, sizeof(header))) return 0;
    return !payload_length || serial_write_all(serial, payload, payload_length);
}

static int send_error(HANDLE serial, const V8FTFrame *request, uint32_t error_code)
{
    uint8_t payload[4];
    v8ft_write_u32(payload, error_code);
    return send_frame(serial, V8FT_MSG_ERROR, V8FT_FLAG_RESPONSE,
                      request->request_id, request->sequence, payload, sizeof(payload));
}

static HANDLE open_serial(const char *port_name)
{
    char device_path[16];
    DWORD name_length = ascii_length(port_name);
    DCB dcb;
    COMMTIMEOUTS timeouts;
    HANDLE serial;

    if(name_length < 4 || name_length > 5) {
        SetLastError(ERROR_INVALID_NAME);
        return INVALID_HANDLE_VALUE;
    }
    bytes_copy(device_path, "\\\\.\\", 4);
    bytes_copy(device_path + 4, port_name, name_length + 1);
    serial = CreateFileA(device_path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if(serial == INVALID_HANDLE_VALUE) return serial;

    bytes_zero(&dcb, sizeof(dcb));
    dcb.DCBlength = sizeof(dcb);
    if(!GetCommState(serial, &dcb)) goto fail;
    dcb.BaudRate = CBR_115200;
    dcb.ByteSize = 8;
    dcb.Parity = NOPARITY;
    dcb.StopBits = ONESTOPBIT;
    dcb.fBinary = TRUE;
    dcb.fParity = FALSE;
    dcb.fOutxCtsFlow = FALSE;
    dcb.fOutxDsrFlow = FALSE;
    dcb.fDtrControl = DTR_CONTROL_ENABLE;
    dcb.fDsrSensitivity = FALSE;
    dcb.fOutX = FALSE;
    dcb.fInX = FALSE;
    dcb.fRtsControl = RTS_CONTROL_ENABLE;
    if(!SetCommState(serial, &dcb)) goto fail;
    SetupComm(serial, 64 * 1024, 64 * 1024);
    PurgeComm(serial, PURGE_RXCLEAR | PURGE_TXCLEAR);

    bytes_zero(&timeouts, sizeof(timeouts));
    timeouts.ReadIntervalTimeout = 25;
    timeouts.ReadTotalTimeoutConstant = 50;
    timeouts.WriteTotalTimeoutConstant = 5000;
    if(!SetCommTimeouts(serial, &timeouts)) goto fail;
    return serial;

fail:
    CloseHandle(serial);
    return INVALID_HANDLE_VALUE;
}

static void clear_get(void)
{
    if(g_get.file != INVALID_HANDLE_VALUE && g_get.file != NULL) CloseHandle(g_get.file);
    bytes_zero(&g_get, sizeof(g_get));
    g_get.file = INVALID_HANDLE_VALUE;
}

static int read_string16(const uint8_t *payload, uint32_t payload_length,
                         uint32_t *offset, const uint8_t **value,
                         uint16_t *value_length)
{
    uint16_t length;
    if(*offset + 2 > payload_length) return 0;
    length = v8ft_read_u16(payload + *offset);
    *offset += 2;
    if(*offset + length > payload_length) return 0;
    *value = payload + *offset;
    *value_length = length;
    *offset += length;
    return 1;
}

static uint32_t max_share_file_bytes(void)
{
    uint32_t maximum = 0;
    int index;
    for(index = 0; index < g_share_count; index++) {
        if(g_shares[index].max_file_bytes > maximum) maximum = g_shares[index].max_file_bytes;
    }
    return maximum;
}

static int handle_hello(HANDLE serial, const V8FTFrame *request)
{
    uint32_t requested_features;
    uint32_t negotiated_features;
    uint32_t build_length = ascii_length(V8FT_BUILD_ID);

    if(request->request_id != 0 || request->sequence != 0 || request->flags != 0 ||
       request->payload_length != 20) {
        return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    }
    clear_get();
    v8ft_put_new_session();
    requested_features = v8ft_read_u32(request->payload + 16);
    negotiated_features = requested_features & V8FT_AGENT_FEATURES;
    if(!g_share_count) negotiated_features &= V8FT_FEATURE_ECHO;
    bytes_copy(g_session_nonce, request->payload, 16);
    g_negotiated_features = negotiated_features;
    g_cursor_id = v8ft_crc32(g_session_nonce, sizeof(g_session_nonce));
    if(!g_cursor_id) g_cursor_id = 1;
    g_session_ready = 1;

    bytes_zero(g_response, 46 + build_length);
    bytes_copy(g_response, g_session_nonce, 16);
    v8ft_write_u32(g_response + 16, negotiated_features);
    v8ft_write_u32(g_response + 20, V8FT_MAX_PAYLOAD_BYTES);
    v8ft_write_u32(g_response + 24,
                   negotiated_features & (V8FT_FEATURE_GET | V8FT_FEATURE_PUT) ?
                   max_share_file_bytes() : 0);
    v8ft_write_u32(g_response + 28,
                   negotiated_features & (V8FT_FEATURE_GET | V8FT_FEATURE_PUT) ?
                   V8FT_MAX_REQUEST_BYTES : 0);
    v8ft_write_u32(g_response + 32,
                   negotiated_features & V8FT_FEATURE_PUT ?
                   V8FT_PUT_MAX_SESSION_WRITE_BYTES : 0);
    v8ft_write_u16(g_response + 36,
                   negotiated_features & (V8FT_FEATURE_GET | V8FT_FEATURE_PUT) ?
                   V8FT_MAX_REQUEST_FILES : 0);
    v8ft_write_u16(g_response + 38,
                   negotiated_features & V8FT_FEATURE_LIST ?
                   V8FT_MAX_DIR_ENTRIES_PER_PAGE : 0);
    v8ft_write_u16(g_response + 40, V8FT_AGENT_MAJOR);
    v8ft_write_u16(g_response + 42, V8FT_AGENT_MINOR);
    v8ft_write_u16(g_response + 44, (uint16_t)build_length);
    bytes_copy(g_response + 46, V8FT_BUILD_ID, build_length);
    return send_frame(serial, V8FT_MSG_HELLO_ACK, V8FT_FLAG_RESPONSE,
                      0, 0, g_response, 46 + build_length);
}

static int handle_shares(HANDLE serial, const V8FTFrame *request)
{
    uint32_t offset = 2;
    int share_index;
    if(!(g_negotiated_features & V8FT_FEATURE_SHARES)) {
        return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
    }
    if(request->payload_length) return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    v8ft_write_u16(g_response, (uint16_t)g_share_count);
    for(share_index = 0; share_index < g_share_count; share_index++) {
        const V8FTShare *share = &g_shares[share_index];
        uint16_t id_length = (uint16_t)ascii_length(share->id);
        uint16_t label_length = (uint16_t)ascii_length(share->label);
        if(offset + 2 + id_length + 2 + label_length + 6 > V8FT_MAX_PAYLOAD_BYTES) {
            return send_error(serial, request, V8FT_ERROR_IO);
        }
        v8ft_write_u16(g_response + offset, id_length);
        offset += 2;
        bytes_copy(g_response + offset, share->id, id_length);
        offset += id_length;
        v8ft_write_u16(g_response + offset, label_length);
        offset += 2;
        bytes_copy(g_response + offset, share->label, label_length);
        offset += label_length;
        g_response[offset++] = share->access;
        g_response[offset++] = 0;
        v8ft_write_u32(g_response + offset, share->max_file_bytes);
        offset += 4;
    }
    return send_frame(serial, V8FT_MSG_SHARES_REPLY, V8FT_FLAG_RESPONSE,
                      request->request_id, 0, g_response, offset);
}

static int is_dot_entry(const WCHAR *name)
{
    return name[0] == L'.' && (!name[1] || (name[1] == L'.' && !name[2]));
}

static void write_u64_parts(uint8_t *target, uint32_t low, uint32_t high)
{
    v8ft_write_u32(target, low);
    v8ft_write_u32(target + 4, high);
}

static int send_dir_entry(HANDLE serial, const V8FTFrame *request, uint32_t sequence,
                          const WIN32_FIND_DATAW *data)
{
    uint16_t name_length;
    uint16_t wide_name_length = wide_length(data->cFileName);
    uint8_t flags = 0;
    if(!v8ft_utf16_to_utf8((const uint16_t *)data->cFileName, wide_name_length,
                            g_response + 20, V8FT_MAX_PAYLOAD_BYTES - 20,
                            &name_length)) return 1;
    if(data->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) flags |= 1;
    if(data->dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) flags |= 2;
    g_response[0] = flags;
    g_response[1] = 0;
    v8ft_write_u16(g_response + 2, name_length);
    if(flags & 1) write_u64_parts(g_response + 4, 0, 0);
    else write_u64_parts(g_response + 4, data->nFileSizeLow, data->nFileSizeHigh);
    write_u64_parts(g_response + 12, data->ftLastWriteTime.dwLowDateTime,
                    data->ftLastWriteTime.dwHighDateTime);
    return send_frame(serial, V8FT_MSG_LIST_DIR_ENTRY, V8FT_FLAG_RESPONSE,
                      request->request_id, sequence, g_response, 20 + name_length);
}

static int handle_list(HANDLE serial, const V8FTFrame *request)
{
    uint32_t payload_offset = 0;
    const uint8_t *share_id;
    const uint8_t *relative;
    uint16_t share_id_length;
    uint16_t relative_length;
    uint32_t cursor_id;
    uint32_t cursor_offset;
    uint16_t page_size;
    const V8FTShare *share;
    WCHAR directory[MAX_PATH];
    WCHAR search[MAX_PATH];
    uint16_t directory_length;
    WIN32_FIND_DATAW data;
    HANDLE find;
    uint32_t visible_index = 0;
    uint32_t sent = 0;
    int has_more = 0;
    int path_error;

    if(!(g_negotiated_features & V8FT_FEATURE_LIST)) {
        return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
    }
    if(!read_string16(request->payload, request->payload_length, &payload_offset,
                      &share_id, &share_id_length) ||
       !read_string16(request->payload, request->payload_length, &payload_offset,
                      &relative, &relative_length) ||
       payload_offset + 12 != request->payload_length) {
        return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    }
    cursor_id = v8ft_read_u32(request->payload + payload_offset);
    cursor_offset = v8ft_read_u32(request->payload + payload_offset + 4);
    page_size = v8ft_read_u16(request->payload + payload_offset + 8);
    if(v8ft_read_u16(request->payload + payload_offset + 10) != 0 || !page_size ||
       page_size > V8FT_MAX_DIR_ENTRIES_PER_PAGE ||
       ((!cursor_id) != (!cursor_offset))) {
        return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    }
    if(cursor_id && cursor_id != g_cursor_id) {
        return send_error(serial, request, V8FT_ERROR_STALE_CURSOR);
    }
    share = v8ft_share_find(g_shares, g_share_count, share_id, share_id_length);
    if(!share) return send_error(serial, request, V8FT_ERROR_UNKNOWN_SHARE);
    path_error = v8ft_path_resolve(share, relative, relative_length, 1,
                                   V8FT_PATH_EXPECT_DIRECTORY, g_executable_path,
                                   g_config_path, directory);
    if(path_error != V8FT_ERROR_OK) return send_error(serial, request, path_error);
    directory_length = wide_length(directory);
    if(directory_length + 2 >= MAX_PATH) {
        return send_error(serial, request, V8FT_ERROR_PATH_TOO_LONG);
    }
    bytes_copy(search, directory, directory_length * sizeof(WCHAR));
    if(directory_length && search[directory_length - 1] != L'\\') search[directory_length++] = L'\\';
    search[directory_length++] = L'*';
    search[directory_length] = 0;
    find = FindFirstFileW(search, &data);
    if(find == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if(error != ERROR_FILE_NOT_FOUND) return send_error(serial, request, V8FT_ERROR_IO);
    } else {
        do {
            uint8_t encoded_name[V8FT_MAX_RELATIVE_UTF8_BYTES];
            uint16_t encoded_length;
            uint16_t checked[MAX_PATH];
            uint16_t checked_length;
            if(is_dot_entry(data.cFileName)) continue;
            if(!v8ft_utf16_to_utf8((const uint16_t *)data.cFileName,
                                    wide_length(data.cFileName), encoded_name,
                                    sizeof(encoded_name), &encoded_length)) continue;
            if(v8ft_validate_relative_utf8(encoded_name, encoded_length, 0, checked,
                                            MAX_PATH, &checked_length) != V8FT_ERROR_OK) continue;
            if(visible_index++ < cursor_offset) continue;
            if(sent >= page_size) {
                has_more = 1;
                break;
            }
            if(!send_dir_entry(serial, request, sent, &data)) {
                FindClose(find);
                return 0;
            }
            sent++;
        } while(FindNextFileW(find, &data));
        if(!has_more && GetLastError() != ERROR_NO_MORE_FILES) {
            FindClose(find);
            return send_error(serial, request, V8FT_ERROR_IO);
        }
        FindClose(find);
    }
    if(has_more) {
        v8ft_write_u32(g_response, g_cursor_id);
        v8ft_write_u32(g_response + 4, cursor_offset + sent);
    } else bytes_zero(g_response, 8);
    return send_frame(serial, V8FT_MSG_LIST_DIR_END,
                      V8FT_FLAG_RESPONSE | V8FT_FLAG_END,
                      request->request_id, sent, g_response, 8);
}

static int file_error_code(DWORD error)
{
    if(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return V8FT_ERROR_NOT_FOUND;
    if(error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION) {
        return V8FT_ERROR_SHARING_VIOLATION;
    }
    return V8FT_ERROR_IO;
}

static int calculate_file_crc(const WCHAR *path, uint32_t expected_limit,
                              uint32_t *size_bytes, uint32_t *crc)
{
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    DWORD high = 0;
    DWORD low;
    uint32_t state = 0xFFFFFFFFu;
    if(file == INVALID_HANDLE_VALUE) return file_error_code(GetLastError());
    low = GetFileSize(file, &high);
    if(low == INVALID_FILE_SIZE && GetLastError() != ERROR_SUCCESS) {
        int error = file_error_code(GetLastError());
        CloseHandle(file);
        return error;
    }
    if(high || low > expected_limit) {
        CloseHandle(file);
        return V8FT_ERROR_FILE_TOO_LARGE;
    }
    for(;;) {
        DWORD received = 0;
        if(!ReadFile(file, g_response, sizeof(g_response), &received, NULL)) {
            int error = file_error_code(GetLastError());
            CloseHandle(file);
            return error;
        }
        if(!received) break;
        state = v8ft_crc32_update(state, g_response, received);
    }
    CloseHandle(file);
    *size_bytes = low;
    *crc = state ^ 0xFFFFFFFFu;
    return V8FT_ERROR_OK;
}

static int send_get_end(HANDLE serial)
{
    v8ft_write_u16(g_response, g_get.file_count);
    v8ft_write_u16(g_response + 2, 0);
    v8ft_write_u32(g_response + 4, g_get.total_bytes);
    if(!send_frame(serial, V8FT_MSG_GET_END, V8FT_FLAG_RESPONSE | V8FT_FLAG_END,
                   g_get.request_id, g_get.next_sequence, g_response, 8)) return 0;
    clear_get();
    return 1;
}

static int send_next_get_chunk(HANDLE serial, int *operation_error)
{
    while(g_get.current_file < g_get.file_count) {
        V8FTGetFile *entry = &g_get.files[g_get.current_file];
        DWORD remaining;
        DWORD requested;
        DWORD received = 0;
        if(g_get.current_offset == entry->size_bytes) {
            if(g_get.file != INVALID_HANDLE_VALUE) {
                CloseHandle(g_get.file);
                g_get.file = INVALID_HANDLE_VALUE;
            }
            g_get.current_file++;
            g_get.current_offset = 0;
            continue;
        }
        if(g_get.file == INVALID_HANDLE_VALUE) {
            g_get.file = CreateFileW(entry->absolute_path, GENERIC_READ, FILE_SHARE_READ,
                                     NULL, OPEN_EXISTING,
                                     FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
            if(g_get.file == INVALID_HANDLE_VALUE) {
                *operation_error = file_error_code(GetLastError());
                return 1;
            }
        }
        remaining = entry->size_bytes - g_get.current_offset;
        requested = remaining > V8FT_GET_CHUNK_BYTES ? V8FT_GET_CHUNK_BYTES : remaining;
        if(!ReadFile(g_get.file, g_response + 8, requested, &received, NULL)) {
            *operation_error = file_error_code(GetLastError());
            return 1;
        }
        if(!received) {
            *operation_error = V8FT_ERROR_IO;
            return 1;
        }
        v8ft_write_u16(g_response, g_get.current_file);
        v8ft_write_u16(g_response + 2, 0);
        v8ft_write_u32(g_response + 4, g_get.current_offset);
        g_get.outstanding_next_offset = g_get.current_offset + received;
        return send_frame(serial, V8FT_MSG_GET_CHUNK, V8FT_FLAG_RESPONSE,
                          g_get.request_id, g_get.next_sequence,
                          g_response, 8 + received);
    }
    return send_get_end(serial);
}

static int handle_get_request(HANDLE serial, const V8FTFrame *request)
{
    uint32_t payload_offset = 0;
    const uint8_t *share_id;
    uint16_t share_id_length;
    const V8FTShare *share;
    uint16_t count;
    uint16_t file_index;
    uint32_t manifest_length = 2;
    int operation_error = V8FT_ERROR_OK;

    if(!(g_negotiated_features & V8FT_FEATURE_GET)) {
        return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
    }
    if(g_get.active || v8ft_put_active()) return send_error(serial, request, V8FT_ERROR_BUSY);
    if(!read_string16(request->payload, request->payload_length, &payload_offset,
                      &share_id, &share_id_length) ||
       payload_offset + 2 > request->payload_length) {
        return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    }
    share = v8ft_share_find(g_shares, g_share_count, share_id, share_id_length);
    if(!share) return send_error(serial, request, V8FT_ERROR_UNKNOWN_SHARE);
    count = v8ft_read_u16(request->payload + payload_offset);
    payload_offset += 2;
    if(!count || count > V8FT_MAX_REQUEST_FILES) {
        return send_error(serial, request, V8FT_ERROR_REQUEST_TOO_LARGE);
    }
    clear_get();
    g_get.request_id = request->request_id;
    g_get.file_count = count;
    g_get.next_sequence = 1;
    for(file_index = 0; file_index < count; file_index++) {
        const uint8_t *relative;
        uint16_t relative_length;
        V8FTGetFile *entry = &g_get.files[file_index];
        int path_error;
        if(!read_string16(request->payload, request->payload_length, &payload_offset,
                          &relative, &relative_length) ||
           !relative_length || relative_length > V8FT_MAX_RELATIVE_UTF8_BYTES) {
            operation_error = V8FT_ERROR_BAD_REQUEST;
            break;
        }
        path_error = v8ft_path_resolve(share, relative, relative_length, 0,
                                       V8FT_PATH_EXPECT_FILE, g_executable_path,
                                       g_config_path, entry->absolute_path);
        if(path_error != V8FT_ERROR_OK) {
            operation_error = path_error;
            break;
        }
        bytes_copy(entry->relative_path, relative, relative_length);
        entry->relative_length = relative_length;
        operation_error = calculate_file_crc(entry->absolute_path, share->max_file_bytes,
                                              &entry->size_bytes, &entry->crc32);
        if(operation_error != V8FT_ERROR_OK) break;
        if(g_get.total_bytes > V8FT_MAX_REQUEST_BYTES - entry->size_bytes) {
            operation_error = V8FT_ERROR_REQUEST_TOO_LARGE;
            break;
        }
        g_get.total_bytes += entry->size_bytes;
        manifest_length += 2 + relative_length + 8;
        if(manifest_length > V8FT_MAX_PAYLOAD_BYTES) {
            operation_error = V8FT_ERROR_REQUEST_TOO_LARGE;
            break;
        }
    }
    if(payload_offset != request->payload_length && operation_error == V8FT_ERROR_OK) {
        operation_error = V8FT_ERROR_BAD_REQUEST;
    }
    if(operation_error != V8FT_ERROR_OK) {
        clear_get();
        return send_error(serial, request, operation_error);
    }

    v8ft_write_u16(g_response, count);
    payload_offset = 2;
    for(file_index = 0; file_index < count; file_index++) {
        V8FTGetFile *entry = &g_get.files[file_index];
        v8ft_write_u16(g_response + payload_offset, entry->relative_length);
        payload_offset += 2;
        bytes_copy(g_response + payload_offset, entry->relative_path, entry->relative_length);
        payload_offset += entry->relative_length;
        v8ft_write_u32(g_response + payload_offset, entry->size_bytes);
        v8ft_write_u32(g_response + payload_offset + 4, entry->crc32);
        payload_offset += 8;
    }
    g_get.active = 1;
    if(!send_frame(serial, V8FT_MSG_GET_BEGIN, V8FT_FLAG_RESPONSE,
                   request->request_id, 0, g_response, payload_offset)) {
        clear_get();
        return 0;
    }
    if(!send_next_get_chunk(serial, &operation_error)) {
        clear_get();
        return 0;
    }
    if(operation_error != V8FT_ERROR_OK) {
        clear_get();
        return send_error(serial, request, operation_error);
    }
    return 1;
}

static int handle_get_ack(HANDLE serial, const V8FTFrame *request)
{
    uint16_t file_index;
    uint32_t next_offset;
    int operation_error = V8FT_ERROR_OK;
    if(!g_get.active || request->request_id != g_get.request_id) {
        return send_error(serial, request, V8FT_ERROR_OUT_OF_ORDER);
    }
    if(request->payload_length != 8 || v8ft_read_u16(request->payload + 2) != 0 ||
       request->sequence != g_get.next_sequence) {
        return send_error(serial, request, V8FT_ERROR_OUT_OF_ORDER);
    }
    file_index = v8ft_read_u16(request->payload);
    next_offset = v8ft_read_u32(request->payload + 4);
    if(file_index != g_get.current_file ||
       next_offset != g_get.outstanding_next_offset) {
        return send_error(serial, request, V8FT_ERROR_OUT_OF_ORDER);
    }
    g_get.current_offset = next_offset;
    g_get.next_sequence++;
    if(!send_next_get_chunk(serial, &operation_error)) {
        clear_get();
        return 0;
    }
    if(operation_error != V8FT_ERROR_OK) {
        clear_get();
        return send_error(serial, request, operation_error);
    }
    return 1;
}

static int send_put_result(HANDLE serial, uint32_t request_id, uint32_t sequence,
                           const V8FTPutResult *result)
{
    v8ft_write_u32(g_response, result->error_code);
    v8ft_write_u16(g_response + 4, result->file_count);
    v8ft_write_u16(g_response + 6, 0);
    v8ft_write_u32(g_response + 8, result->total_bytes);
    v8ft_write_u32(g_response + 12, result->session_write_bytes);
    return send_frame(serial, V8FT_MSG_PUT_RESULT,
                      V8FT_FLAG_RESPONSE | V8FT_FLAG_END,
                      request_id, sequence, g_response, 16);
}

static int handle_put_begin(HANDLE serial, const V8FTFrame *request)
{
    V8FTPutReady ready;
    int error;
    if(!(g_negotiated_features & V8FT_FEATURE_PUT)) {
        return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
    }
    if(g_get.active) return send_error(serial, request, V8FT_ERROR_BUSY);
    error = v8ft_put_begin(request->request_id, request->payload,
                           request->payload_length, &ready);
    if(error != V8FT_ERROR_OK) return send_error(serial, request, error);
    v8ft_write_u16(g_response, ready.file_count);
    v8ft_write_u16(g_response + 2, 0);
    v8ft_write_u32(g_response + 4, ready.total_bytes);
    v8ft_write_u32(g_response + 8, ready.session_write_bytes);
    return send_frame(serial, V8FT_MSG_PUT_READY, V8FT_FLAG_RESPONSE,
                      request->request_id, 0, g_response, 12);
}

static int handle_put_chunk(HANDLE serial, const V8FTFrame *request)
{
    V8FTPutAck ack;
    int error;
    if(!(g_negotiated_features & V8FT_FEATURE_PUT)) {
        return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
    }
    error = v8ft_put_chunk(request->request_id, request->sequence,
                               request->payload, request->payload_length, &ack);
    if(error != V8FT_ERROR_OK) return send_error(serial, request, error);
    v8ft_write_u16(g_response, ack.file_index);
    v8ft_write_u16(g_response + 2, 0);
    v8ft_write_u32(g_response + 4, ack.next_offset);
    v8ft_write_u32(g_response + 8, ack.session_write_bytes);
    return send_frame(serial, V8FT_MSG_PUT_ACK, V8FT_FLAG_RESPONSE,
                      request->request_id, request->sequence, g_response, 12);
}

static int handle_put_commit(HANDLE serial, const V8FTFrame *request)
{
    V8FTPutResult result;
    int error;
    if(!(g_negotiated_features & V8FT_FEATURE_PUT)) {
        return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
    }
    if(request->payload_length) return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    if(v8ft_put_replay_result(request->request_id, &result)) {
        return send_put_result(serial, request->request_id, request->sequence, &result);
    }
    error = v8ft_put_commit(request->request_id, request->sequence, &result);
    if(error != V8FT_ERROR_OK) return send_error(serial, request, error);
    return send_put_result(serial, request->request_id, request->sequence, &result);
}

static int handle_cancel(HANDLE serial, const V8FTFrame *request)
{
    V8FTPutResult result;
    int error;
    if(!(g_negotiated_features & V8FT_FEATURE_CANCEL)) {
        return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
    }
    if(request->payload_length || request->sequence != 0) {
        return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    }
    if(g_get.active && request->request_id == g_get.request_id) {
        clear_get();
        return send_error(serial, request, V8FT_ERROR_CANCELLED);
    }
    error = v8ft_put_cancel(request->request_id, &result);
    if(error != V8FT_ERROR_OK) return send_error(serial, request, error);
    return send_put_result(serial, request->request_id, 0, &result);
}

static int handle_frame(HANDLE serial, const V8FTFrame *request)
{
    if(request->type == V8FT_MSG_HELLO) return handle_hello(serial, request);
    if(!g_session_ready) return send_error(serial, request, V8FT_ERROR_AGENT_NOT_READY);
    if(request->request_id == 0 ||
       (request->flags != 0 &&
        !(request->type == V8FT_MSG_PUT_CHUNK && request->flags == V8FT_FLAG_RETRY))) {
        return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    }
    if(request->type == V8FT_MSG_GET_ACK) return handle_get_ack(serial, request);
    if(request->type == V8FT_MSG_PUT_CHUNK) return handle_put_chunk(serial, request);
    if(request->type == V8FT_MSG_PUT_COMMIT) return handle_put_commit(serial, request);
    if(request->type == V8FT_MSG_CANCEL) return handle_cancel(serial, request);
    if(request->sequence != 0) return send_error(serial, request, V8FT_ERROR_BAD_REQUEST);
    if(g_get.active || v8ft_put_active()) return send_error(serial, request, V8FT_ERROR_BUSY);
    if(request->type == V8FT_MSG_PING) {
        return send_frame(serial, V8FT_MSG_PONG, V8FT_FLAG_RESPONSE,
                          request->request_id, request->sequence,
                          request->payload, request->payload_length);
    }
    if(request->type == V8FT_MSG_ECHO) {
        if(!(g_negotiated_features & V8FT_FEATURE_ECHO)) {
            return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
        }
        return send_frame(serial, V8FT_MSG_ECHO_REPLY, V8FT_FLAG_RESPONSE,
                          request->request_id, request->sequence,
                          request->payload, request->payload_length);
    }
    if(request->type == V8FT_MSG_SHARES_REQUEST) return handle_shares(serial, request);
    if(request->type == V8FT_MSG_LIST_DIR_REQUEST) return handle_list(serial, request);
    if(request->type == V8FT_MSG_GET_REQUEST) return handle_get_request(serial, request);
    if(request->type == V8FT_MSG_PUT_BEGIN) return handle_put_begin(serial, request);
    return send_error(serial, request, V8FT_ERROR_UNSUPPORTED_FEATURE);
}

static int run_agent(HANDLE serial)
{
    v8ft_parser_init(&g_parser);
    for(;;) {
        DWORD received = 0;
        DWORD index;
        if(!ReadFile(serial, g_read_buffer, sizeof(g_read_buffer), &received, NULL)) return 0;
        for(index = 0; index < received; index++) {
            V8FTFrame frame;
            enum V8FTParseError parse_error;
            int result = v8ft_parser_push(&g_parser, g_read_buffer[index], &frame, &parse_error);
            if(result == V8FT_PARSE_FRAME && !handle_frame(serial, &frame)) return 0;
            /* Invalid frames are untrusted: discard/resync without replying. */
        }
        {
            V8FTPutResult timeout_result;
            uint32_t timeout_request_id = v8ft_put_request_id();
            if(v8ft_put_expire(&timeout_result) &&
               !send_put_result(serial, timeout_request_id, 0, &timeout_result)) return 0;
        }
    }
}

static void initialize_paths(void)
{
    DWORD length = GetModuleFileNameW(NULL, g_executable_path, MAX_PATH);
    DWORD index;
    if(!length || length >= MAX_PATH) {
        g_executable_path[0] = 0;
        g_config_path[0] = 0;
        return;
    }
    bytes_copy(g_config_path, g_executable_path, (length + 1) * sizeof(WCHAR));
    index = length;
    while(index && g_config_path[index - 1] != L'\\' && g_config_path[index - 1] != L'/') index--;
    if(index + 9 >= MAX_PATH) {
        g_config_path[0] = 0;
        return;
    }
    bytes_copy(g_config_path + index, L"V8FT.INI", 10 * sizeof(WCHAR));
}

void WINAPI WinMainCRTStartup(void)
{
    char configured_port[8];
    char selected_port[8] = { 'C', 'O', 'M', '1', 0 };
    DWORD port_length;
    DWORD last_error = ERROR_FILE_NOT_FOUND;
    HANDLE serial = INVALID_HANDLE_VALUE;
    int port_index;

    clear_get();
    initialize_paths();
    g_share_count = v8ft_shares_load(g_config_path, g_shares, V8FT_MAX_SHARES);
    v8ft_put_initialize(g_shares, g_share_count, g_executable_path, g_config_path);
    port_length = GetEnvironmentVariableA("V86FT_COM", configured_port, sizeof(configured_port));
    console_write("V8FT v1 Phase 3 agent " V8FT_BUILD_ID "\r\nScanning Windows COM1-COM9 devices\r\n");
    if(port_length && port_length < sizeof(configured_port)) {
        serial = open_serial(configured_port);
        last_error = GetLastError();
        if(serial != INVALID_HANDLE_VALUE) bytes_copy(selected_port, configured_port, port_length + 1);
    } else {
        for(port_index = 1; port_index <= 9; port_index++) {
            selected_port[3] = (char)('0' + port_index);
            serial = open_serial(selected_port);
            if(serial != INVALID_HANDLE_VALUE) break;
            last_error = GetLastError();
        }
    }
    if(serial == INVALID_HANDLE_VALUE) {
        console_write_error("No usable Windows COM device; last Win32 error ", last_error);
        ExitProcess(1);
    }
    console_write("Opened ");
    console_write(selected_port);
    console_write("\r\nReady for V8FT HELLO (Phase 3 transactional PUT)\r\n");
    if(!run_agent(serial)) {
        console_write_error("V8FT agent stopped; Win32 error ", GetLastError());
        clear_get();
        CloseHandle(serial);
        ExitProcess(1);
    }
    clear_get();
    CloseHandle(serial);
    ExitProcess(0);
}
