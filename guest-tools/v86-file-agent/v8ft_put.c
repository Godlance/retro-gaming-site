#include "v8ft_put.h"
#include "v8ft_protocol.h"
#include "v8ft_pathsafe.h"

#define V8FT_MAX_RELATIVE_UTF8_BYTES (MAX_PATH * 3)
#define V8FT_JOURNAL_STATE_PREPARED 1
#define V8FT_JOURNAL_STATE_COMMITTED 2
#define V8FT_FILE_STAGE_UNTOUCHED 0
#define V8FT_FILE_STAGE_BACKUP_INTENT 1
#define V8FT_FILE_STAGE_BACKED_UP 2
#define V8FT_FILE_STAGE_INSTALL_INTENT 3
#define V8FT_FILE_STAGE_INSTALLED 4

typedef struct V8FTPutFile {
    WCHAR absolute_path[MAX_PATH];
    uint8_t relative_path[V8FT_MAX_RELATIVE_UTF8_BYTES];
    uint16_t relative_length;
    uint32_t size_bytes;
    uint32_t crc32;
    uint8_t original_exists;
    uint8_t journal_stage;
} V8FTPutFile;

typedef struct V8FTPutState {
    int active;
    int commit_started;
    uint32_t request_id;
    uint32_t expected_sequence;
    uint16_t file_count;
    uint16_t current_file;
    uint32_t current_offset;
    uint32_t current_crc_state;
    uint32_t total_bytes;
    uint32_t last_activity;
    int last_chunk_valid;
    uint32_t last_sequence;
    uint16_t last_file_index;
    uint32_t last_offset;
    uint32_t last_length;
    uint32_t last_crc32;
    uint32_t last_next_offset;
    HANDLE incoming_file;
    V8FTShare *share;
    WCHAR transaction_path[MAX_PATH];
    WCHAR incoming_path[MAX_PATH];
    WCHAR backup_path[MAX_PATH];
    WCHAR journal_path[MAX_PATH];
    V8FTPutFile files[V8FT_PUT_MAX_REQUEST_FILES];
} V8FTPutState;

static V8FTShare *g_shares;
static int g_share_count;
static const WCHAR *g_executable_path;
static const WCHAR *g_config_path;
static V8FTPutState g_put;
static uint32_t g_session_write_bytes;
static uint8_t g_journal_buffer[65536];
static V8FTPutResult g_last_result;
static uint32_t g_last_result_request_id;
static int g_last_result_valid;

#ifdef V8FT_PUT_TESTING
static int g_test_moves_before_failure = -1;
static DWORD g_test_move_error = ERROR_DISK_FULL;

void v8ft_put_test_fail_move_after(int successful_moves, DWORD error)
{
    g_test_moves_before_failure = successful_moves;
    g_test_move_error = error;
}

void v8ft_put_test_force_idle(void)
{
    g_put.last_activity = GetTickCount() - V8FT_PUT_IDLE_TIMEOUT_MS;
}

void v8ft_put_test_set_session_write_bytes(uint32_t value)
{
    g_session_write_bytes = value;
}
#endif

static int move_file(const WCHAR *source, const WCHAR *target)
{
#ifdef V8FT_PUT_TESTING
    if(g_test_moves_before_failure == 0) {
        g_test_moves_before_failure = -1;
        SetLastError(g_test_move_error);
        return 0;
    }
    if(g_test_moves_before_failure > 0) g_test_moves_before_failure--;
#endif
    return MoveFileW(source, target);
}

static void bytes_copy(void *target_value, const void *source_value, uint32_t length)
{
    uint8_t *target = (uint8_t *)target_value;
    const uint8_t *source = (const uint8_t *)source_value;
    uint32_t index;
    for(index = 0; index < length; index++) target[index] = source[index];
}

static void bytes_zero(void *target_value, uint32_t length)
{
    uint8_t *target = (uint8_t *)target_value;
    uint32_t index;
    for(index = 0; index < length; index++) target[index] = 0;
}

static uint16_t wide_length(const WCHAR *text)
{
    uint16_t length = 0;
    while(text[length]) length++;
    return length;
}

static int wide_equal_ci(const WCHAR *left, const WCHAR *right)
{
    int left_length = wide_length(left);
    int right_length = wide_length(right);
    if(left_length != right_length) return 0;
    return CompareStringW(LOCALE_INVARIANT, NORM_IGNORECASE, left, left_length,
                          right, right_length) == CSTR_EQUAL;
}

static int join_path(WCHAR output[MAX_PATH], const WCHAR *root, const WCHAR *leaf)
{
    uint16_t root_length = wide_length(root);
    uint16_t leaf_length = wide_length(leaf);
    uint16_t offset = root_length;
    if((uint32_t)root_length + leaf_length + 2 >= MAX_PATH) return 0;
    bytes_copy(output, root, root_length * sizeof(WCHAR));
    if(offset && output[offset - 1] != L'\\') output[offset++] = L'\\';
    bytes_copy(output + offset, leaf, (leaf_length + 1) * sizeof(WCHAR));
    return 1;
}

static void hex8(WCHAR output[9], uint32_t value)
{
    static const WCHAR digits[] = L"0123456789ABCDEF";
    int index;
    for(index = 7; index >= 0; index--) {
        output[index] = digits[value & 15u];
        value >>= 4;
    }
    output[8] = 0;
}

static void index_name(WCHAR output[10], WCHAR prefix, uint16_t index,
                       const WCHAR *extension)
{
    static const WCHAR digits[] = L"0123456789ABCDEF";
    output[0] = prefix;
    output[1] = digits[(index >> 12) & 15];
    output[2] = digits[(index >> 8) & 15];
    output[3] = digits[(index >> 4) & 15];
    output[4] = digits[index & 15];
    output[5] = L'.';
    output[6] = extension[0];
    output[7] = extension[1];
    output[8] = extension[2];
    output[9] = 0;
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

static int ensure_directory(const WCHAR *path)
{
    DWORD attributes = GetFileAttributesW(path);
    if(attributes != INVALID_FILE_ATTRIBUTES) {
        return (attributes & FILE_ATTRIBUTE_DIRECTORY) &&
            !(attributes & FILE_ATTRIBUTE_REPARSE_POINT);
    }
    if(!CreateDirectoryW(path, NULL)) return 0;
    attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_DIRECTORY) &&
        !(attributes & FILE_ATTRIBUTE_REPARSE_POINT);
}

static int delete_flat_directory(const WCHAR *path)
{
    WCHAR search[MAX_PATH];
    WCHAR child[MAX_PATH];
    WIN32_FIND_DATAW data;
    HANDLE find;
    if(!join_path(search, path, L"*")) return 0;
    find = FindFirstFileW(search, &data);
    if(find != INVALID_HANDLE_VALUE) {
        do {
            if(data.cFileName[0] == L'.' && (!data.cFileName[1] ||
               (data.cFileName[1] == L'.' && !data.cFileName[2]))) continue;
            if(!join_path(child, path, data.cFileName) ||
               (data.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
                                          FILE_ATTRIBUTE_REPARSE_POINT)) ||
               !DeleteFileW(child)) {
                FindClose(find);
                return 0;
            }
        } while(FindNextFileW(find, &data));
        FindClose(find);
    }
    if(!RemoveDirectoryW(path) && GetLastError() != ERROR_PATH_NOT_FOUND &&
       GetLastError() != ERROR_FILE_NOT_FOUND) return 0;
    return 1;
}

static int cleanup_transaction(const WCHAR *transaction_path)
{
    WCHAR path[MAX_PATH];
    int ok = 1;
    if(join_path(path, transaction_path, L"incoming") &&
       GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES && !delete_flat_directory(path)) ok = 0;
    if(join_path(path, transaction_path, L"backup") &&
       GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES && !delete_flat_directory(path)) ok = 0;
    if(join_path(path, transaction_path, L"transaction.log")) DeleteFileW(path);
    if(!RemoveDirectoryW(transaction_path) && GetLastError() != ERROR_PATH_NOT_FOUND &&
       GetLastError() != ERROR_FILE_NOT_FOUND) ok = 0;
    return ok;
}

static int file_error(DWORD error)
{
    if(error == ERROR_DISK_FULL || error == ERROR_HANDLE_DISK_FULL) return V8FT_ERROR_DISK_FULL;
    if(error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION) {
        return V8FT_ERROR_SHARING_VIOLATION;
    }
    if(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return V8FT_ERROR_NOT_FOUND;
    return V8FT_ERROR_IO;
}

static int target_exclusive_check(const WCHAR *path, int *exists)
{
    DWORD attributes = GetFileAttributesW(path);
    HANDLE file;
    if(attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD error = GetLastError();
        if(error == ERROR_FILE_NOT_FOUND) {
            *exists = 0;
            return V8FT_ERROR_OK;
        }
        return file_error(error);
    }
    if(attributes & FILE_ATTRIBUTE_DIRECTORY) return V8FT_ERROR_IS_A_DIRECTORY;
    if(attributes & FILE_ATTRIBUTE_REPARSE_POINT) return V8FT_ERROR_REPARSE_POINT;
    file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if(file == INVALID_HANDLE_VALUE) return file_error(GetLastError());
    CloseHandle(file);
    *exists = 1;
    return V8FT_ERROR_OK;
}

static int make_file_path(WCHAR output[MAX_PATH], const WCHAR *directory,
                          WCHAR prefix, uint16_t index, const WCHAR *extension)
{
    WCHAR name[10];
    index_name(name, prefix, index, extension);
    return join_path(output, directory, name);
}

static void close_incoming(void)
{
    if(g_put.incoming_file != INVALID_HANDLE_VALUE && g_put.incoming_file != NULL) {
        CloseHandle(g_put.incoming_file);
    }
    g_put.incoming_file = INVALID_HANDLE_VALUE;
}

static void clear_active(int cleanup)
{
    close_incoming();
    if(cleanup && g_put.transaction_path[0]) cleanup_transaction(g_put.transaction_path);
    bytes_zero(&g_put, sizeof(g_put));
    g_put.incoming_file = INVALID_HANDLE_VALUE;
}

static void fill_result(V8FTPutResult *result, uint32_t error_code,
                        uint16_t file_count, uint32_t total_bytes)
{
    result->error_code = error_code;
    result->file_count = file_count;
    result->total_bytes = total_bytes;
    result->session_write_bytes = g_session_write_bytes;
}

static void remember_result(uint32_t request_id, const V8FTPutResult *result)
{
    g_last_result_request_id = request_id;
    g_last_result = *result;
    g_last_result_valid = 1;
}

static int write_journal(uint16_t state)
{
    uint32_t offset = 12;
    uint16_t index;
    HANDLE file;
    DWORD written = 0;
    g_journal_buffer[0] = 'V';
    g_journal_buffer[1] = '8';
    g_journal_buffer[2] = 'T';
    g_journal_buffer[3] = 'J';
    v8ft_write_u16(g_journal_buffer + 4, 1);
    v8ft_write_u16(g_journal_buffer + 6, state);
    v8ft_write_u16(g_journal_buffer + 8, g_put.file_count);
    v8ft_write_u16(g_journal_buffer + 10, 0);
    for(index = 0; index < g_put.file_count; index++) {
        V8FTPutFile *entry = &g_put.files[index];
        if(offset + 4 + entry->relative_length > sizeof(g_journal_buffer)) return 0;
        g_journal_buffer[offset++] = entry->original_exists;
        g_journal_buffer[offset++] = entry->journal_stage;
        v8ft_write_u16(g_journal_buffer + offset, entry->relative_length);
        offset += 2;
        bytes_copy(g_journal_buffer + offset, entry->relative_path, entry->relative_length);
        offset += entry->relative_length;
    }
    file = CreateFileW(g_put.journal_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if(file == INVALID_HANDLE_VALUE) return 0;
    if(!WriteFile(file, g_journal_buffer, offset, &written, NULL) || written != offset ||
       !FlushFileBuffers(file)) {
        CloseHandle(file);
        return 0;
    }
    CloseHandle(file);
    return 1;
}

static int rollback_current(void)
{
    int ok = 1;
    uint16_t index;
    WCHAR backup[MAX_PATH];
    for(index = 0; index < g_put.file_count; index++) {
        V8FTPutFile *entry = &g_put.files[index];
        DWORD backup_attributes;
        DWORD target_attributes = GetFileAttributesW(entry->absolute_path);
        if(!make_file_path(backup, g_put.backup_path, L'B', index, L"BAK")) return 0;
        backup_attributes = GetFileAttributesW(backup);
        if(entry->original_exists) {
            if(entry->journal_stage == V8FT_FILE_STAGE_UNTOUCHED) {
                if(backup_attributes != INVALID_FILE_ATTRIBUTES ||
                   target_attributes == INVALID_FILE_ATTRIBUTES) ok = 0;
            } else if(entry->journal_stage == V8FT_FILE_STAGE_BACKUP_INTENT) {
                if(backup_attributes != INVALID_FILE_ATTRIBUTES &&
                   target_attributes == INVALID_FILE_ATTRIBUTES) {
                    if(!move_file(backup, entry->absolute_path)) ok = 0;
                } else if(backup_attributes != INVALID_FILE_ATTRIBUTES ||
                          target_attributes == INVALID_FILE_ATTRIBUTES) ok = 0;
            } else if(backup_attributes != INVALID_FILE_ATTRIBUTES) {
                if(target_attributes != INVALID_FILE_ATTRIBUTES &&
                   !DeleteFileW(entry->absolute_path)) ok = 0;
                if(!move_file(backup, entry->absolute_path)) ok = 0;
            } else ok = 0;
        } else if(entry->journal_stage >= V8FT_FILE_STAGE_INSTALL_INTENT) {
            WCHAR incoming[MAX_PATH];
            DWORD incoming_attributes;
            if(!make_file_path(incoming, g_put.incoming_path, L'I', index, L"BIN")) return 0;
            incoming_attributes = GetFileAttributesW(incoming);
            if(incoming_attributes == INVALID_FILE_ATTRIBUTES &&
               target_attributes != INVALID_FILE_ATTRIBUTES) {
                if(!DeleteFileW(entry->absolute_path)) ok = 0;
            } else if(entry->journal_stage == V8FT_FILE_STAGE_INSTALLED ||
                      incoming_attributes == INVALID_FILE_ATTRIBUTES ||
                      target_attributes != INVALID_FILE_ATTRIBUTES) ok = 0;
        } else if(target_attributes != INVALID_FILE_ATTRIBUTES) {
            ok = 0;
        }
    }
    return ok;
}

static int prepare_staging(uint32_t request_id, const V8FTShare *share)
{
    WCHAR base[MAX_PATH];
    WCHAR request_name[9];
    DWORD attributes;
    if(!join_path(base, share->root, L".v86-transfer") || !ensure_directory(base)) return 0;
    hex8(request_name, request_id);
    if(!join_path(g_put.transaction_path, base, request_name)) return 0;
    attributes = GetFileAttributesW(g_put.transaction_path);
    if(attributes != INVALID_FILE_ATTRIBUTES) {
        if(!(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
           (attributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
           !cleanup_transaction(g_put.transaction_path)) return 0;
    }
    if(!CreateDirectoryW(g_put.transaction_path, NULL)) return 0;
    if(!join_path(g_put.incoming_path, g_put.transaction_path, L"incoming") ||
       !CreateDirectoryW(g_put.incoming_path, NULL) ||
       !join_path(g_put.backup_path, g_put.transaction_path, L"backup") ||
       !CreateDirectoryW(g_put.backup_path, NULL) ||
       !join_path(g_put.journal_path, g_put.transaction_path, L"transaction.log")) return 0;
    return 1;
}

static int create_zero_file(uint16_t index)
{
    WCHAR path[MAX_PATH];
    HANDLE file;
    if(!make_file_path(path, g_put.incoming_path, L'I', index, L"BIN")) return 0;
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if(file == INVALID_HANDLE_VALUE) return 0;
    if(!FlushFileBuffers(file)) {
        CloseHandle(file);
        return 0;
    }
    CloseHandle(file);
    return 1;
}

void v8ft_put_initialize(V8FTShare *shares, int share_count,
                         const WCHAR *executable_path, const WCHAR *config_path)
{
    g_shares = shares;
    g_share_count = share_count;
    g_executable_path = executable_path;
    g_config_path = config_path;
    clear_active(0);
}

/* Recovery is conservative: corrupt journals leave that share write-blocked. */
static __attribute__((noinline)) int recover_transaction(V8FTShare *share,
                                                          const WCHAR *transaction_path)
{
    WCHAR journal[MAX_PATH];
    HANDLE file;
    DWORD size;
    DWORD received = 0;
    uint16_t state;
    uint16_t count;
    uint32_t offset = 12;
    uint16_t index;
    if(!join_path(journal, transaction_path, L"transaction.log")) return 0;
    file = CreateFileW(journal, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if(file == INVALID_HANDLE_VALUE) return cleanup_transaction(transaction_path);
    size = GetFileSize(file, NULL);
    if(size == INVALID_FILE_SIZE || size > sizeof(g_journal_buffer) || size < 12 ||
       !ReadFile(file, g_journal_buffer, size, &received, NULL) || received != size) {
        CloseHandle(file);
        return 0;
    }
    CloseHandle(file);
    if(g_journal_buffer[0] != 'V' || g_journal_buffer[1] != '8' ||
       g_journal_buffer[2] != 'T' || g_journal_buffer[3] != 'J' ||
       v8ft_read_u16(g_journal_buffer + 4) != 1 ||
       v8ft_read_u16(g_journal_buffer + 10) != 0) return 0;
    state = v8ft_read_u16(g_journal_buffer + 6);
    count = v8ft_read_u16(g_journal_buffer + 8);
    if(!count || count > V8FT_PUT_MAX_REQUEST_FILES) return 0;
    if(state == V8FT_JOURNAL_STATE_COMMITTED) return cleanup_transaction(transaction_path);
    if(state != V8FT_JOURNAL_STATE_PREPARED) return 0;
    for(index = 0; index < count; index++) {
        const uint8_t *relative;
        uint16_t relative_length;
        uint8_t original_exists;
        uint8_t file_stage;
        WCHAR target[MAX_PATH];
        WCHAR backup_dir[MAX_PATH];
        WCHAR incoming_dir[MAX_PATH];
        WCHAR backup[MAX_PATH];
        WCHAR incoming[MAX_PATH];
        DWORD backup_attributes;
        DWORD target_attributes;
        if(offset + 4 > size) return 0;
        original_exists = g_journal_buffer[offset];
        file_stage = g_journal_buffer[offset + 1];
        if(original_exists > 1 || file_stage > V8FT_FILE_STAGE_INSTALLED) return 0;
        relative_length = v8ft_read_u16(g_journal_buffer + offset + 2);
        offset += 4;
        if(offset + relative_length > size) return 0;
        relative = g_journal_buffer + offset;
        offset += relative_length;
        if(v8ft_path_resolve(share, relative, relative_length, 0,
                             V8FT_PATH_EXPECT_FILE_WRITE, g_executable_path,
                             g_config_path, target) != V8FT_ERROR_OK ||
           !join_path(backup_dir, transaction_path, L"backup") ||
           !join_path(incoming_dir, transaction_path, L"incoming") ||
           !make_file_path(backup, backup_dir, L'B', index, L"BAK") ||
           !make_file_path(incoming, incoming_dir, L'I', index, L"BIN")) return 0;
        backup_attributes = GetFileAttributesW(backup);
        target_attributes = GetFileAttributesW(target);
        if(original_exists) {
            if(file_stage == V8FT_FILE_STAGE_UNTOUCHED) {
                if(backup_attributes != INVALID_FILE_ATTRIBUTES ||
                   target_attributes == INVALID_FILE_ATTRIBUTES) return 0;
            } else if(file_stage == V8FT_FILE_STAGE_BACKUP_INTENT) {
                if(backup_attributes != INVALID_FILE_ATTRIBUTES &&
                   target_attributes == INVALID_FILE_ATTRIBUTES) {
                    if(!move_file(backup, target)) return 0;
                } else if(backup_attributes != INVALID_FILE_ATTRIBUTES ||
                          target_attributes == INVALID_FILE_ATTRIBUTES) return 0;
            } else if(backup_attributes != INVALID_FILE_ATTRIBUTES) {
                if(target_attributes != INVALID_FILE_ATTRIBUTES && !DeleteFileW(target)) return 0;
                if(!move_file(backup, target)) return 0;
            } else return 0;
        } else if(file_stage >= V8FT_FILE_STAGE_INSTALL_INTENT) {
            DWORD incoming_attributes = GetFileAttributesW(incoming);
            if(incoming_attributes == INVALID_FILE_ATTRIBUTES &&
               target_attributes != INVALID_FILE_ATTRIBUTES) {
                if(!DeleteFileW(target)) return 0;
            } else if(file_stage == V8FT_FILE_STAGE_INSTALLED ||
                      incoming_attributes == INVALID_FILE_ATTRIBUTES ||
                      target_attributes != INVALID_FILE_ATTRIBUTES) return 0;
        } else if(target_attributes != INVALID_FILE_ATTRIBUTES) return 0;
    }
    if(offset != size) return 0;
    return cleanup_transaction(transaction_path);
}

static void recover_share(V8FTShare *share)
{
    WCHAR base[MAX_PATH];
    WCHAR search[MAX_PATH];
    WCHAR transaction[MAX_PATH];
    WIN32_FIND_DATAW data;
    HANDLE find;
    if(share->access != V8FT_SHARE_READ_WRITE) return;
    if(!join_path(base, share->root, L".v86-transfer")) {
        share->write_blocked = 1;
        return;
    }
    if(GetFileAttributesW(base) == INVALID_FILE_ATTRIBUTES) return;
    if(!join_path(search, base, L"*")) {
        share->write_blocked = 1;
        return;
    }
    find = FindFirstFileW(search, &data);
    if(find == INVALID_HANDLE_VALUE) return;
    do {
        if(data.cFileName[0] == L'.' && (!data.cFileName[1] ||
           (data.cFileName[1] == L'.' && !data.cFileName[2]))) continue;
        if(!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
           (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
           !join_path(transaction, base, data.cFileName) ||
           !recover_transaction(share, transaction)) share->write_blocked = 1;
    } while(FindNextFileW(find, &data));
    FindClose(find);
}

void v8ft_put_new_session(void)
{
    int index;
    if(g_put.active) clear_active(1);
    g_last_result_valid = 0;
    for(index = 0; index < g_share_count; index++) {
        int previous;
        int duplicate = 0;
        int representative = -1;
        int match;
        for(previous = 0; previous < index; previous++) {
            if(wide_equal_ci(g_shares[index].root, g_shares[previous].root)) duplicate = 1;
        }
        if(duplicate) continue;
        for(match = index; match < g_share_count; match++) {
            if(wide_equal_ci(g_shares[index].root, g_shares[match].root) &&
               g_shares[match].access == V8FT_SHARE_READ_WRITE) {
                representative = match;
                break;
            }
        }
        if(representative >= 0) recover_share(&g_shares[representative]);
        for(match = index; match < g_share_count; match++) {
            if(wide_equal_ci(g_shares[index].root, g_shares[match].root)) {
                g_shares[match].write_blocked = representative >= 0 ?
                    g_shares[representative].write_blocked : 0;
            }
        }
    }
}

int v8ft_put_begin(uint32_t request_id, const uint8_t *payload,
                   uint32_t payload_length, V8FTPutReady *ready)
{
    uint32_t offset = 0;
    const uint8_t *share_id;
    uint16_t share_id_length;
    uint16_t file_count;
    uint16_t index;
    V8FTShare *share;
    if(g_put.active) return V8FT_ERROR_BUSY;
    if(!read_string16(payload, payload_length, &offset, &share_id, &share_id_length) ||
       offset + 2 > payload_length) return V8FT_ERROR_BAD_REQUEST;
    share = (V8FTShare *)v8ft_share_find(g_shares, g_share_count, share_id, share_id_length);
    if(!share) return V8FT_ERROR_UNKNOWN_SHARE;
    if(share->access != V8FT_SHARE_READ_WRITE) return V8FT_ERROR_READ_ONLY_SHARE;
    if(share->write_blocked) return V8FT_ERROR_ROLLBACK_FAILED;
    file_count = v8ft_read_u16(payload + offset);
    offset += 2;
    if(!file_count || file_count > V8FT_PUT_MAX_REQUEST_FILES) return V8FT_ERROR_REQUEST_TOO_LARGE;
    clear_active(0);
    g_put.request_id = request_id;
    g_put.share = share;
    g_put.file_count = file_count;
    g_put.expected_sequence = 1;
    g_put.current_crc_state = 0xFFFFFFFFu;
    for(index = 0; index < file_count; index++) {
        const uint8_t *relative;
        uint16_t relative_length;
        V8FTPutFile *entry = &g_put.files[index];
        int error;
        int exists;
        int previous;
        if(!read_string16(payload, payload_length, &offset, &relative, &relative_length) ||
           !relative_length || relative_length > V8FT_MAX_RELATIVE_UTF8_BYTES ||
           offset + 8 > payload_length) {
            clear_active(0);
            return V8FT_ERROR_BAD_REQUEST;
        }
        entry->size_bytes = v8ft_read_u32(payload + offset);
        entry->crc32 = v8ft_read_u32(payload + offset + 4);
        offset += 8;
        if(entry->size_bytes > share->max_file_bytes) {
            clear_active(0);
            return V8FT_ERROR_FILE_TOO_LARGE;
        }
        if(!entry->size_bytes && entry->crc32 != 0) {
            clear_active(0);
            return V8FT_ERROR_CRC_MISMATCH;
        }
        if(g_put.total_bytes > V8FT_PUT_MAX_REQUEST_BYTES - entry->size_bytes) {
            clear_active(0);
            return V8FT_ERROR_REQUEST_TOO_LARGE;
        }
        error = v8ft_path_resolve(share, relative, relative_length, 0,
                                  V8FT_PATH_EXPECT_FILE_WRITE, g_executable_path,
                                  g_config_path, entry->absolute_path);
        if(error != V8FT_ERROR_OK) {
            clear_active(0);
            return error;
        }
        for(previous = 0; previous < index; previous++) {
            if(wide_equal_ci(entry->absolute_path, g_put.files[previous].absolute_path)) {
                clear_active(0);
                return V8FT_ERROR_BAD_REQUEST;
            }
        }
        error = target_exclusive_check(entry->absolute_path, &exists);
        if(error != V8FT_ERROR_OK) {
            clear_active(0);
            return error;
        }
        bytes_copy(entry->relative_path, relative, relative_length);
        entry->relative_length = relative_length;
        g_put.total_bytes += entry->size_bytes;
    }
    if(offset != payload_length) {
        clear_active(0);
        return V8FT_ERROR_BAD_REQUEST;
    }
    if(g_session_write_bytes > V8FT_PUT_MAX_SESSION_WRITE_BYTES - g_put.total_bytes) {
        clear_active(0);
        return V8FT_ERROR_SESSION_QUOTA_EXCEEDED;
    }
    if(!prepare_staging(request_id, share)) {
        clear_active(1);
        return file_error(GetLastError());
    }
    for(index = 0; index < file_count; index++) {
        if(!g_put.files[index].size_bytes && !create_zero_file(index)) {
            int error = file_error(GetLastError());
            clear_active(1);
            return error;
        }
    }
    while(g_put.current_file < file_count && !g_put.files[g_put.current_file].size_bytes) {
        g_put.current_file++;
    }
    g_put.active = 1;
    g_put.last_activity = GetTickCount();
    ready->file_count = file_count;
    ready->total_bytes = g_put.total_bytes;
    ready->session_write_bytes = g_session_write_bytes;
    return V8FT_ERROR_OK;
}

static int abort_active(int error)
{
    clear_active(1);
    return error;
}

int v8ft_put_chunk(uint32_t request_id, uint32_t sequence,
                   const uint8_t *payload, uint32_t payload_length,
                   V8FTPutAck *ack)
{
    uint16_t file_index;
    uint32_t offset;
    const uint8_t *data;
    uint32_t data_length;
    uint32_t chunk_crc;
    DWORD written = 0;
    int write_ok;
    V8FTPutFile *entry;
    WCHAR incoming[MAX_PATH];
    if(!g_put.active || request_id != g_put.request_id) return V8FT_ERROR_OUT_OF_ORDER;
    if(payload_length <= 8 || payload_length > V8FT_MAX_PAYLOAD_BYTES ||
       v8ft_read_u16(payload + 2) != 0) return abort_active(V8FT_ERROR_BAD_REQUEST);
    file_index = v8ft_read_u16(payload);
    offset = v8ft_read_u32(payload + 4);
    data = payload + 8;
    data_length = payload_length - 8;
    chunk_crc = v8ft_crc32(data, data_length);
    if(g_put.last_chunk_valid && sequence == g_put.last_sequence) {
        if(file_index == g_put.last_file_index && offset == g_put.last_offset &&
           data_length == g_put.last_length && chunk_crc == g_put.last_crc32) {
            ack->file_index = file_index;
            ack->next_offset = g_put.last_next_offset;
            ack->session_write_bytes = g_session_write_bytes;
            g_put.last_activity = GetTickCount();
            return V8FT_ERROR_OK;
        }
        return abort_active(V8FT_ERROR_CRC_MISMATCH);
    }
    if(sequence != g_put.expected_sequence || file_index != g_put.current_file ||
       file_index >= g_put.file_count || offset != g_put.current_offset) {
        return abort_active(V8FT_ERROR_OUT_OF_ORDER);
    }
    entry = &g_put.files[file_index];
    if(data_length > entry->size_bytes - offset || data_length > V8FT_PUT_CHUNK_BYTES) {
        return abort_active(V8FT_ERROR_REQUEST_TOO_LARGE);
    }
    if(g_put.incoming_file == INVALID_HANDLE_VALUE) {
        if(!make_file_path(incoming, g_put.incoming_path, L'I', file_index, L"BIN")) {
            return abort_active(V8FT_ERROR_PATH_TOO_LONG);
        }
        g_put.incoming_file = CreateFileW(incoming, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                                          FILE_ATTRIBUTE_NORMAL, NULL);
        if(g_put.incoming_file == INVALID_HANDLE_VALUE) return abort_active(file_error(GetLastError()));
    }
    write_ok = WriteFile(g_put.incoming_file, data, data_length, &written, NULL);
    if(written > data_length) written = data_length;
    g_session_write_bytes += written;
    if(!write_ok || written != data_length || !FlushFileBuffers(g_put.incoming_file)) {
        return abort_active(file_error(GetLastError()));
    }
    g_put.current_crc_state = v8ft_crc32_update(g_put.current_crc_state, data, data_length);
    g_put.current_offset += data_length;
    g_put.last_chunk_valid = 1;
    g_put.last_sequence = sequence;
    g_put.last_file_index = file_index;
    g_put.last_offset = offset;
    g_put.last_length = data_length;
    g_put.last_crc32 = chunk_crc;
    g_put.last_next_offset = g_put.current_offset;
    if(g_put.current_offset == entry->size_bytes) {
        close_incoming();
        if((g_put.current_crc_state ^ 0xFFFFFFFFu) != entry->crc32) {
            return abort_active(V8FT_ERROR_CRC_MISMATCH);
        }
        g_put.current_file++;
        while(g_put.current_file < g_put.file_count &&
              !g_put.files[g_put.current_file].size_bytes) g_put.current_file++;
        g_put.current_offset = 0;
        g_put.current_crc_state = 0xFFFFFFFFu;
    }
    g_put.expected_sequence++;
    g_put.last_activity = GetTickCount();
    ack->file_index = file_index;
    ack->next_offset = g_put.last_next_offset;
    ack->session_write_bytes = g_session_write_bytes;
    return V8FT_ERROR_OK;
}

int v8ft_put_commit(uint32_t request_id, uint32_t sequence,
                    V8FTPutResult *result)
{
    uint16_t index;
    int error = V8FT_ERROR_OK;
    if(!g_put.active || request_id != g_put.request_id ||
       sequence != g_put.expected_sequence || g_put.current_file != g_put.file_count) {
        return V8FT_ERROR_OUT_OF_ORDER;
    }
    g_put.commit_started = 1;
    for(index = 0; index < g_put.file_count; index++) {
        int exists = 0;
        error = target_exclusive_check(g_put.files[index].absolute_path, &exists);
        if(error != V8FT_ERROR_OK) break;
        g_put.files[index].original_exists = (uint8_t)exists;
    }
    if(error == V8FT_ERROR_OK && !write_journal(V8FT_JOURNAL_STATE_PREPARED)) {
        error = file_error(GetLastError());
    }
    if(error == V8FT_ERROR_OK) {
        for(index = 0; index < g_put.file_count; index++) {
            WCHAR backup[MAX_PATH];
            if(!g_put.files[index].original_exists) continue;
            g_put.files[index].journal_stage = V8FT_FILE_STAGE_BACKUP_INTENT;
            if(!write_journal(V8FT_JOURNAL_STATE_PREPARED) ||
               !make_file_path(backup, g_put.backup_path, L'B', index, L"BAK") ||
               !move_file(g_put.files[index].absolute_path, backup)) {
                error = file_error(GetLastError());
                break;
            }
            g_put.files[index].journal_stage = V8FT_FILE_STAGE_BACKED_UP;
            if(!write_journal(V8FT_JOURNAL_STATE_PREPARED)) {
                error = file_error(GetLastError());
                break;
            }
        }
    }
    if(error == V8FT_ERROR_OK) {
        for(index = 0; index < g_put.file_count; index++) {
            WCHAR incoming[MAX_PATH];
            g_put.files[index].journal_stage = V8FT_FILE_STAGE_INSTALL_INTENT;
            if(!write_journal(V8FT_JOURNAL_STATE_PREPARED) ||
               !make_file_path(incoming, g_put.incoming_path, L'I', index, L"BIN") ||
               !move_file(incoming, g_put.files[index].absolute_path)) {
                error = file_error(GetLastError());
                break;
            }
            g_put.files[index].journal_stage = V8FT_FILE_STAGE_INSTALLED;
            if(!write_journal(V8FT_JOURNAL_STATE_PREPARED)) {
                error = file_error(GetLastError());
                break;
            }
        }
    }
    if(error == V8FT_ERROR_OK && !write_journal(V8FT_JOURNAL_STATE_COMMITTED)) {
        error = file_error(GetLastError());
    }
    if(error != V8FT_ERROR_OK && !rollback_current()) error = V8FT_ERROR_ROLLBACK_FAILED;
    fill_result(result, error, error == V8FT_ERROR_OK ? g_put.file_count : 0,
                error == V8FT_ERROR_OK ? g_put.total_bytes : 0);
    remember_result(request_id, result);
    if(error == V8FT_ERROR_ROLLBACK_FAILED) {
        g_put.share->write_blocked = 1;
        clear_active(0);
    } else clear_active(1);
    return V8FT_ERROR_OK;
}

int v8ft_put_cancel(uint32_t request_id, V8FTPutResult *result)
{
    if(g_last_result_valid && request_id == g_last_result_request_id) {
        *result = g_last_result;
        return V8FT_ERROR_OK;
    }
    if(!g_put.active || request_id != g_put.request_id) return V8FT_ERROR_OUT_OF_ORDER;
    if(g_put.commit_started) return V8FT_ERROR_BUSY;
    fill_result(result, V8FT_ERROR_CANCELLED, 0, 0);
    remember_result(request_id, result);
    clear_active(1);
    return V8FT_ERROR_OK;
}

int v8ft_put_replay_result(uint32_t request_id, V8FTPutResult *result)
{
    if(!g_last_result_valid || request_id != g_last_result_request_id) return 0;
    *result = g_last_result;
    return 1;
}

int v8ft_put_active(void) { return g_put.active; }
uint32_t v8ft_put_request_id(void) { return g_put.request_id; }
uint32_t v8ft_put_expected_sequence(void) { return g_put.expected_sequence; }
uint32_t v8ft_put_session_write_bytes(void) { return g_session_write_bytes; }

int v8ft_put_expire(V8FTPutResult *result)
{
    uint32_t now;
    if(!g_put.active || g_put.commit_started) return 0;
    now = GetTickCount();
    if(now - g_put.last_activity < V8FT_PUT_IDLE_TIMEOUT_MS) return 0;
    fill_result(result, V8FT_ERROR_TIMEOUT, 0, 0);
    remember_result(g_put.request_id, result);
    clear_active(1);
    return 1;
}
