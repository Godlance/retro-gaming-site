#ifndef V8FT_SHARES_H
#define V8FT_SHARES_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>

#define V8FT_MAX_SHARES 8
#define V8FT_MAX_SHARE_ID_BYTES 32
#define V8FT_MAX_SHARE_LABEL_BYTES 96

#define V8FT_SHARE_READ_ONLY 0
#define V8FT_SHARE_READ_WRITE 1

typedef struct V8FTShare {
    char id[V8FT_MAX_SHARE_ID_BYTES + 1];
    char label[V8FT_MAX_SHARE_LABEL_BYTES + 1];
    WCHAR root[MAX_PATH];
    uint32_t max_file_bytes;
    uint8_t configured_access;
    uint8_t access;
    uint8_t write_blocked;
} V8FTShare;

int v8ft_shares_load(const WCHAR *config_path, V8FTShare *shares, int capacity);
const V8FTShare *v8ft_share_find(const V8FTShare *shares, int count,
                                 const uint8_t *id, uint16_t id_length);

#endif
