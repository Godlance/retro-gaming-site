#ifndef V8FT_PUT_H
#define V8FT_PUT_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include "v8ft_shares.h"

#define V8FT_PUT_MAX_REQUEST_BYTES (128u * 1024u * 1024u)
#define V8FT_PUT_MAX_SESSION_WRITE_BYTES (256u * 1024u * 1024u)
#define V8FT_PUT_MAX_REQUEST_FILES 64
#define V8FT_PUT_CHUNK_BYTES (32768u - 8u)
#define V8FT_PUT_IDLE_TIMEOUT_MS 120000u

typedef struct V8FTPutReady {
    uint16_t file_count;
    uint32_t total_bytes;
    uint32_t session_write_bytes;
} V8FTPutReady;

typedef struct V8FTPutAck {
    uint16_t file_index;
    uint32_t next_offset;
    uint32_t session_write_bytes;
} V8FTPutAck;

typedef struct V8FTPutResult {
    uint32_t error_code;
    uint16_t file_count;
    uint32_t total_bytes;
    uint32_t session_write_bytes;
} V8FTPutResult;

void v8ft_put_initialize(V8FTShare *shares, int share_count,
                         const WCHAR *executable_path, const WCHAR *config_path);
void v8ft_put_new_session(void);
int v8ft_put_begin(uint32_t request_id, const uint8_t *payload,
                   uint32_t payload_length, V8FTPutReady *ready);
int v8ft_put_chunk(uint32_t request_id, uint32_t sequence,
                   const uint8_t *payload, uint32_t payload_length,
                   V8FTPutAck *ack);
int v8ft_put_commit(uint32_t request_id, uint32_t sequence,
                    V8FTPutResult *result);
int v8ft_put_cancel(uint32_t request_id, V8FTPutResult *result);
int v8ft_put_replay_result(uint32_t request_id, V8FTPutResult *result);
int v8ft_put_active(void);
uint32_t v8ft_put_request_id(void);
uint32_t v8ft_put_expected_sequence(void);
int v8ft_put_expire(V8FTPutResult *result);
uint32_t v8ft_put_session_write_bytes(void);

#ifdef V8FT_PUT_TESTING
void v8ft_put_test_fail_move_after(int successful_moves, DWORD error);
void v8ft_put_test_force_idle(void);
void v8ft_put_test_set_session_write_bytes(uint32_t value);
#endif

#endif
