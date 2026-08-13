#include "v8ft_pathsafe.h"

static uint16_t fold_ascii(uint16_t value)
{
    if(value >= (uint16_t)'a' && value <= (uint16_t)'z') return value - 32;
    return value;
}

static int equal_ascii_ci(const uint16_t *left, uint16_t left_length,
                          const char *right)
{
    uint16_t index = 0;
    while(right[index]) index++;
    if(index != left_length) return 0;
    for(index = 0; index < left_length; index++) {
        if(fold_ascii(left[index]) != fold_ascii((uint8_t)right[index])) return 0;
    }
    return 1;
}

static int segment_is_device(const uint16_t *segment, uint16_t length)
{
    uint16_t base_length = 0;
    while(base_length < length && segment[base_length] != (uint16_t)'.') base_length++;
    if(equal_ascii_ci(segment, base_length, "CON") ||
       equal_ascii_ci(segment, base_length, "PRN") ||
       equal_ascii_ci(segment, base_length, "AUX") ||
       equal_ascii_ci(segment, base_length, "NUL")) return 1;
    if(base_length == 4 &&
       (fold_ascii(segment[0]) == (uint16_t)'C' || fold_ascii(segment[0]) == (uint16_t)'L') &&
       fold_ascii(segment[1]) == (uint16_t)(segment[0] == (uint16_t)'c' || segment[0] == (uint16_t)'C' ? 'O' : 'P') &&
       fold_ascii(segment[2]) == (uint16_t)(segment[0] == (uint16_t)'c' || segment[0] == (uint16_t)'C' ? 'M' : 'T') &&
       segment[3] >= (uint16_t)'1' && segment[3] <= (uint16_t)'9') return 1;
    return 0;
}

static int validate_segment(const uint16_t *segment, uint16_t length)
{
    uint16_t index;
    if(!length) return V8FT_ERROR_INVALID_PATH;
    if(length == 1 && segment[0] == (uint16_t)'.') return V8FT_ERROR_INVALID_PATH;
    if(length == 2 && segment[0] == (uint16_t)'.' && segment[1] == (uint16_t)'.') {
        return V8FT_ERROR_INVALID_PATH;
    }
    if(segment[length - 1] == (uint16_t)' ' || segment[length - 1] == (uint16_t)'.') {
        return V8FT_ERROR_INVALID_NAME;
    }
    for(index = 0; index < length; index++) {
        uint16_t value = segment[index];
        if(value < 0x20 || value == (uint16_t)'\\' || value == (uint16_t)'/' ||
           value == (uint16_t)':' || value == (uint16_t)'*' || value == (uint16_t)'?' ||
           value == (uint16_t)'"' || value == (uint16_t)'<' || value == (uint16_t)'>' ||
           value == (uint16_t)'|') return V8FT_ERROR_INVALID_NAME;
    }
    if(segment_is_device(segment, length)) return V8FT_ERROR_INVALID_NAME;
    if(equal_ascii_ci(segment, length, ".v86-transfer")) return V8FT_ERROR_INVALID_PATH;
    return V8FT_ERROR_OK;
}

static int decode_scalar(const uint8_t *input, uint16_t length, uint16_t *index,
                         uint32_t *scalar)
{
    uint32_t value;
    uint8_t first;
    if(*index >= length) return 0;
    first = input[(*index)++];
    if(first < 0x80) {
        *scalar = first;
        return 1;
    }
    if(first >= 0xC2 && first <= 0xDF) {
        if(*index >= length || (input[*index] & 0xC0) != 0x80) return 0;
        value = ((uint32_t)(first & 0x1F) << 6) | (input[(*index)++] & 0x3F);
    } else if(first >= 0xE0 && first <= 0xEF) {
        uint8_t second;
        if((uint16_t)(*index + 1) >= length) return 0;
        second = input[(*index)++];
        if((second & 0xC0) != 0x80 || (input[*index] & 0xC0) != 0x80) return 0;
        if((first == 0xE0 && second < 0xA0) || (first == 0xED && second >= 0xA0)) return 0;
        value = ((uint32_t)(first & 0x0F) << 12) |
            ((uint32_t)(second & 0x3F) << 6) | (input[(*index)++] & 0x3F);
    } else if(first >= 0xF0 && first <= 0xF4) {
        uint8_t second;
        uint8_t third;
        uint8_t fourth;
        if((uint16_t)(*index + 2) >= length) return 0;
        second = input[(*index)++];
        if((second & 0xC0) != 0x80 || (input[*index] & 0xC0) != 0x80 ||
           (input[*index + 1] & 0xC0) != 0x80) return 0;
        if((first == 0xF0 && second < 0x90) || (first == 0xF4 && second >= 0x90)) return 0;
        third = input[(*index)++];
        fourth = input[(*index)++];
        value = ((uint32_t)(first & 7) << 18) | ((uint32_t)(second & 0x3F) << 12) |
            ((uint32_t)(third & 0x3F) << 6) | (fourth & 0x3F);
    } else return 0;
    *scalar = value;
    return 1;
}

int v8ft_validate_relative_utf8(const uint8_t *input, uint16_t input_length,
                                 int allow_empty, uint16_t *output,
                                 uint16_t output_capacity, uint16_t *output_length)
{
    uint16_t input_offset = 0;
    uint16_t output_offset = 0;
    uint16_t segment_start = 0;
    uint16_t segment_count = 1;
    int error;
    if(!input || !output || !output_length || !output_capacity) return V8FT_ERROR_BAD_REQUEST;
    if(!input_length) {
        if(!allow_empty) return V8FT_ERROR_INVALID_PATH;
        output[0] = 0;
        *output_length = 0;
        return V8FT_ERROR_OK;
    }
    if(input[0] == (uint8_t)'/' || input[input_length - 1] == (uint8_t)'/') {
        return V8FT_ERROR_INVALID_PATH;
    }
    while(input_offset < input_length) {
        uint32_t scalar;
        if(input[input_offset] == (uint8_t)'/') {
            error = validate_segment(output + segment_start, output_offset - segment_start);
            if(error != V8FT_ERROR_OK) return error;
            if(++segment_count > V8FT_MAX_PATH_SEGMENTS) return V8FT_ERROR_PATH_TOO_LONG;
            if(output_offset + 1 >= output_capacity) return V8FT_ERROR_PATH_TOO_LONG;
            output[output_offset++] = (uint16_t)'\\';
            segment_start = output_offset;
            input_offset++;
            continue;
        }
        if(!decode_scalar(input, input_length, &input_offset, &scalar)) return V8FT_ERROR_INVALID_NAME;
        if(scalar <= 0xFFFF) {
            if(output_offset + 1 >= output_capacity) return V8FT_ERROR_PATH_TOO_LONG;
            output[output_offset++] = (uint16_t)scalar;
        } else {
            scalar -= 0x10000;
            if(output_offset + 2 >= output_capacity) return V8FT_ERROR_PATH_TOO_LONG;
            output[output_offset++] = (uint16_t)(0xD800 | (scalar >> 10));
            output[output_offset++] = (uint16_t)(0xDC00 | (scalar & 0x3FF));
        }
    }
    error = validate_segment(output + segment_start, output_offset - segment_start);
    if(error != V8FT_ERROR_OK) return error;
    output[output_offset] = 0;
    *output_length = output_offset;
    return V8FT_ERROR_OK;
}

int v8ft_utf16_to_utf8(const uint16_t *input, uint16_t input_length,
                        uint8_t *output, uint16_t output_capacity,
                        uint16_t *output_length)
{
    uint16_t input_offset = 0;
    uint16_t output_offset = 0;
    if(!input || !output || !output_length) return 0;
    while(input_offset < input_length) {
        uint32_t scalar = input[input_offset++];
        if(scalar >= 0xD800 && scalar <= 0xDBFF) {
            uint32_t low;
            if(input_offset >= input_length) return 0;
            low = input[input_offset++];
            if(low < 0xDC00 || low > 0xDFFF) return 0;
            scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00);
        } else if(scalar >= 0xDC00 && scalar <= 0xDFFF) return 0;
        if(scalar < 0x80) {
            if(output_offset + 1 > output_capacity) return 0;
            output[output_offset++] = (uint8_t)scalar;
        } else if(scalar < 0x800) {
            if(output_offset + 2 > output_capacity) return 0;
            output[output_offset++] = (uint8_t)(0xC0 | (scalar >> 6));
            output[output_offset++] = (uint8_t)(0x80 | (scalar & 0x3F));
        } else if(scalar < 0x10000) {
            if(output_offset + 3 > output_capacity) return 0;
            output[output_offset++] = (uint8_t)(0xE0 | (scalar >> 12));
            output[output_offset++] = (uint8_t)(0x80 | ((scalar >> 6) & 0x3F));
            output[output_offset++] = (uint8_t)(0x80 | (scalar & 0x3F));
        } else {
            if(output_offset + 4 > output_capacity) return 0;
            output[output_offset++] = (uint8_t)(0xF0 | (scalar >> 18));
            output[output_offset++] = (uint8_t)(0x80 | ((scalar >> 12) & 0x3F));
            output[output_offset++] = (uint8_t)(0x80 | ((scalar >> 6) & 0x3F));
            output[output_offset++] = (uint8_t)(0x80 | (scalar & 0x3F));
        }
    }
    *output_length = output_offset;
    return 1;
}

int v8ft_path_prefix_contains(const uint16_t *root, uint16_t root_length,
                               const uint16_t *path, uint16_t path_length)
{
    uint16_t index;
    if(root_length > path_length) return 0;
    for(index = 0; index < root_length; index++) {
        if(fold_ascii(root[index]) != fold_ascii(path[index])) return 0;
    }
    if(root_length == path_length) return 1;
    if(root_length && (root[root_length - 1] == (uint16_t)'\\' ||
                       root[root_length - 1] == (uint16_t)'/')) return 1;
    return path[root_length] == (uint16_t)'\\' || path[root_length] == (uint16_t)'/';
}

#ifdef _WIN32

static uint16_t wide_length(const WCHAR *text)
{
    uint16_t length = 0;
    while(text[length]) length++;
    return length;
}

static void wide_copy(WCHAR *target, const WCHAR *source, uint16_t length)
{
    uint16_t index;
    for(index = 0; index < length; index++) target[index] = source[index];
}

static int wide_equal_ci(const WCHAR *left, const WCHAR *right)
{
    int left_length = wide_length(left);
    int right_length = wide_length(right);
    if(left_length != right_length) return 0;
    return CompareStringW(LOCALE_INVARIANT, NORM_IGNORECASE, left, left_length,
                          right, right_length) == CSTR_EQUAL;
}

int v8ft_normalize_share_root(const WCHAR *configured_root,
                               WCHAR output[MAX_PATH])
{
    WCHAR expanded[MAX_PATH];
    WCHAR full[MAX_PATH];
    WCHAR long_path[MAX_PATH];
    DWORD length;
    DWORD attributes;
    if(!configured_root || !configured_root[0]) return 0;
    length = ExpandEnvironmentStringsW(configured_root, expanded, MAX_PATH);
    if(!length || length >= MAX_PATH) return 0;
    length = GetFullPathNameW(expanded, MAX_PATH, full, NULL);
    if(!length || length >= MAX_PATH) return 0;
    length = GetLongPathNameW(full, long_path, MAX_PATH);
    if(!length || length >= MAX_PATH) return 0;
    attributes = GetFileAttributesW(long_path);
    if(attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
       (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
    while(length > 3 && (long_path[length - 1] == L'\\' || long_path[length - 1] == L'/')) {
        long_path[--length] = 0;
    }
    wide_copy(output, long_path, (uint16_t)(length + 1));
    return 1;
}

static int path_error_from_win32(DWORD error)
{
    if(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return V8FT_ERROR_NOT_FOUND;
    return V8FT_ERROR_IO;
}

int v8ft_path_resolve(const V8FTShare *share, const uint8_t *relative,
                       uint16_t relative_length, int allow_empty,
                       int expected_type, const WCHAR *blocked_executable,
                       const WCHAR *blocked_config, WCHAR output[MAX_PATH])
{
    uint16_t relative_wide[MAX_PATH];
    uint16_t relative_wide_length;
    uint16_t root_length;
    uint16_t candidate_length;
    WCHAR candidate[MAX_PATH];
    WCHAR scan[MAX_PATH];
    DWORD full_length;
    uint16_t index;
    int error = v8ft_validate_relative_utf8(relative, relative_length, allow_empty,
                                             relative_wide, MAX_PATH,
                                             &relative_wide_length);
    if(error != V8FT_ERROR_OK) return error;
    root_length = wide_length(share->root);
    candidate_length = root_length;
    if(relative_wide_length) {
        if(candidate_length && share->root[candidate_length - 1] != L'\\') {
            if(candidate_length + 1 >= MAX_PATH) return V8FT_ERROR_PATH_TOO_LONG;
            candidate[candidate_length++] = L'\\';
        }
        if((uint32_t)candidate_length + relative_wide_length >= MAX_PATH) {
            return V8FT_ERROR_PATH_TOO_LONG;
        }
    }
    wide_copy(candidate, share->root, root_length);
    if(relative_wide_length) wide_copy(candidate + candidate_length, (WCHAR *)relative_wide,
                                        relative_wide_length);
    candidate_length += relative_wide_length;
    candidate[candidate_length] = 0;
    full_length = GetFullPathNameW(candidate, MAX_PATH, output, NULL);
    if(!full_length || full_length >= MAX_PATH) return V8FT_ERROR_PATH_TOO_LONG;
    if(!v8ft_path_prefix_contains((const uint16_t *)share->root, root_length,
                                  (const uint16_t *)output, (uint16_t)full_length)) {
        return V8FT_ERROR_PATH_ESCAPE;
    }
    if((blocked_executable && wide_equal_ci(output, blocked_executable)) ||
       (blocked_config && blocked_config[0] && wide_equal_ci(output, blocked_config))) {
        return V8FT_ERROR_INVALID_PATH;
    }

    wide_copy(scan, output, (uint16_t)(full_length + 1));
    if(!relative_wide_length) {
        DWORD attributes = GetFileAttributesW(scan);
        if(attributes == INVALID_FILE_ATTRIBUTES) return path_error_from_win32(GetLastError());
        if(attributes & FILE_ATTRIBUTE_REPARSE_POINT) return V8FT_ERROR_REPARSE_POINT;
        if(expected_type == V8FT_PATH_EXPECT_DIRECTORY && !(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
            return V8FT_ERROR_NOT_A_DIRECTORY;
        }
        if(expected_type == V8FT_PATH_EXPECT_FILE && (attributes & FILE_ATTRIBUTE_DIRECTORY)) {
            return V8FT_ERROR_IS_A_DIRECTORY;
        }
        return V8FT_ERROR_OK;
    }

    for(index = root_length; index <= full_length; index++) {
        if(index == full_length || scan[index] == L'\\' || scan[index] == L'/') {
            WCHAR saved;
            DWORD attributes;
            if(index == root_length) continue;
            saved = scan[index];
            scan[index] = 0;
            attributes = GetFileAttributesW(scan);
            scan[index] = saved;
            if(attributes == INVALID_FILE_ATTRIBUTES) {
                DWORD win32_error = GetLastError();
                if(index == full_length && expected_type == V8FT_PATH_EXPECT_FILE_WRITE &&
                   win32_error == ERROR_FILE_NOT_FOUND) return V8FT_ERROR_OK;
                return path_error_from_win32(win32_error);
            }
            if(attributes & FILE_ATTRIBUTE_REPARSE_POINT) return V8FT_ERROR_REPARSE_POINT;
            if(index < full_length && !(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
                return V8FT_ERROR_NOT_A_DIRECTORY;
            }
            if(index == full_length) {
                if(expected_type == V8FT_PATH_EXPECT_DIRECTORY &&
                   !(attributes & FILE_ATTRIBUTE_DIRECTORY)) return V8FT_ERROR_NOT_A_DIRECTORY;
                if(expected_type == V8FT_PATH_EXPECT_FILE &&
                   (attributes & FILE_ATTRIBUTE_DIRECTORY)) return V8FT_ERROR_IS_A_DIRECTORY;
                if(expected_type == V8FT_PATH_EXPECT_FILE_WRITE &&
                   (attributes & FILE_ATTRIBUTE_DIRECTORY)) return V8FT_ERROR_IS_A_DIRECTORY;
            }
        }
    }
    return V8FT_ERROR_OK;
}

#endif
