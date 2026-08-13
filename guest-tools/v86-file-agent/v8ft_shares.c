#include "v8ft_shares.h"
#include "v8ft_pathsafe.h"

#define V8FT_DEFAULT_MAX_FILE_BYTES (64u * 1024u * 1024u)
#define V8FT_HARD_MAX_FILE_BYTES (256u * 1024u * 1024u)

static int wide_length(const WCHAR *text)
{
    int length = 0;
    while(text[length]) length++;
    return length;
}

static int ascii_length(const char *text)
{
    int length = 0;
    while(text[length]) length++;
    return length;
}

static int wide_equal_ascii_ci(const WCHAR *left, const char *right)
{
    int index = 0;
    while(left[index] && right[index]) {
        WCHAR value = left[index];
        char expected = right[index];
        if(value >= L'a' && value <= L'z') value -= 32;
        if(expected >= 'a' && expected <= 'z') expected -= 32;
        if(value != (WCHAR)(uint8_t)expected) return 0;
        index++;
    }
    return !left[index] && !right[index];
}

static int section_prefix(const WCHAR *section)
{
    static const WCHAR prefix[] = L"share.";
    int index;
    for(index = 0; index < 6; index++) {
        WCHAR value = section[index];
        if(value >= L'A' && value <= L'Z') value += 32;
        if(value != prefix[index]) return 0;
    }
    return section[6] != 0;
}

static int copy_share_id(char output[V8FT_MAX_SHARE_ID_BYTES + 1],
                         const WCHAR *input)
{
    int index = 0;
    while(input[index]) {
        WCHAR value = input[index];
        if(index >= V8FT_MAX_SHARE_ID_BYTES ||
           !((value >= L'a' && value <= L'z') || (value >= L'A' && value <= L'Z') ||
             (value >= L'0' && value <= L'9') || value == L'_' || value == L'-')) return 0;
        output[index] = (char)value;
        index++;
    }
    output[index] = 0;
    return index != 0;
}

static uint32_t parse_u32(const WCHAR *text, uint32_t fallback)
{
    uint32_t value = 0;
    int index = 0;
    if(!text[0]) return fallback;
    while(text[index]) {
        uint32_t digit;
        if(text[index] < L'0' || text[index] > L'9') return fallback;
        digit = (uint32_t)(text[index] - L'0');
        if(value > (0xFFFFFFFFu - digit) / 10u) return fallback;
        value = value * 10u + digit;
        index++;
    }
    if(!value || value > V8FT_HARD_MAX_FILE_BYTES) return fallback;
    return value;
}

static int id_exists(const V8FTShare *shares, int count, const char *id)
{
    int share_index;
    for(share_index = 0; share_index < count; share_index++) {
        int index = 0;
        while(shares[share_index].id[index] && id[index] &&
              shares[share_index].id[index] == id[index]) index++;
        if(!shares[share_index].id[index] && !id[index]) return 1;
    }
    return 0;
}

static int add_share(V8FTShare *shares, int count, int capacity, const char *id,
                     const WCHAR *root, const WCHAR *label, uint8_t configured_access,
                     uint32_t max_file_bytes)
{
    V8FTShare *share;
    uint16_t label_length = 0;
    int id_length;
    int index;
    if(count >= capacity || id_exists(shares, count, id)) return count;
    share = &shares[count];
    id_length = ascii_length(id);
    if(!id_length || id_length > V8FT_MAX_SHARE_ID_BYTES) return count;
    for(index = 0; index <= id_length; index++) share->id[index] = id[index];
    if(!v8ft_normalize_share_root(root, share->root)) return count;
    if(!v8ft_utf16_to_utf8((const uint16_t *)label, (uint16_t)wide_length(label),
                            (uint8_t *)share->label, V8FT_MAX_SHARE_LABEL_BYTES,
                            &label_length)) return count;
    share->label[label_length] = 0;
    share->configured_access = configured_access;
    share->access = configured_access;
    share->write_blocked = 0;
    share->max_file_bytes = max_file_bytes;
    return count + 1;
}

static int load_configured(const WCHAR *config_path, V8FTShare *shares, int capacity)
{
    static WCHAR sections[2048];
    DWORD length = GetPrivateProfileSectionNamesW(sections,
                                                   sizeof(sections) / sizeof(sections[0]),
                                                   config_path);
    DWORD offset = 0;
    int count = 0;
    if(!length || length >= sizeof(sections) / sizeof(sections[0]) - 2) return 0;
    while(offset < length && sections[offset]) {
        const WCHAR *section = sections + offset;
        WCHAR root[MAX_PATH];
        WCHAR label[128];
        WCHAR access[8];
        WCHAR max_file[32];
        char id[V8FT_MAX_SHARE_ID_BYTES + 1];
        uint8_t configured_access;
        uint32_t limit;
        if(section_prefix(section) && copy_share_id(id, section + 6)) {
            GetPrivateProfileStringW(section, L"root", L"", root, MAX_PATH, config_path);
            GetPrivateProfileStringW(section, L"label", section + 6, label,
                                     sizeof(label) / sizeof(label[0]), config_path);
            GetPrivateProfileStringW(section, L"access", L"ro", access,
                                     sizeof(access) / sizeof(access[0]), config_path);
            GetPrivateProfileStringW(section, L"max_file_bytes", L"67108864", max_file,
                                     sizeof(max_file) / sizeof(max_file[0]), config_path);
            configured_access = wide_equal_ascii_ci(access, "rw") ?
                V8FT_SHARE_READ_WRITE : V8FT_SHARE_READ_ONLY;
            limit = parse_u32(max_file, V8FT_DEFAULT_MAX_FILE_BYTES);
            count = add_share(shares, count, capacity, id, root, label,
                              configured_access, limit);
        }
        offset += (DWORD)wide_length(section) + 1;
    }
    return count;
}

int v8ft_shares_load(const WCHAR *config_path, V8FTShare *shares, int capacity)
{
    int count;
    if(!shares || capacity <= 0) return 0;
    count = load_configured(config_path, shares, capacity);
    if(count) return count;
    count = add_share(shares, count, capacity, "system", L"C:\\",
                      L"System Drive (C:)", V8FT_SHARE_READ_ONLY,
                      V8FT_DEFAULT_MAX_FILE_BYTES);
    count = add_share(shares, count, capacity, "games", L"D:\\",
                      L"Games Drive (D:)", V8FT_SHARE_READ_ONLY,
                      V8FT_DEFAULT_MAX_FILE_BYTES);
    count = add_share(shares, count, capacity, "desktop", L"%USERPROFILE%\\Desktop",
                      L"Desktop", V8FT_SHARE_READ_WRITE,
                      V8FT_DEFAULT_MAX_FILE_BYTES);
    return count;
}

const V8FTShare *v8ft_share_find(const V8FTShare *shares, int count,
                                 const uint8_t *id, uint16_t id_length)
{
    int share_index;
    if(!shares || !id || !id_length || id_length > V8FT_MAX_SHARE_ID_BYTES) return NULL;
    for(share_index = 0; share_index < count; share_index++) {
        uint16_t index = 0;
        while(index < id_length && shares[share_index].id[index] &&
              (uint8_t)shares[share_index].id[index] == id[index]) index++;
        if(index == id_length && !shares[share_index].id[index]) return &shares[share_index];
    }
    return NULL;
}
