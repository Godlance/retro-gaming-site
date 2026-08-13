#ifndef V8FT_PROTOCOL_H
#define V8FT_PROTOCOL_H

#include <stdint.h>

#define V8FT_VERSION_MAJOR 1
#define V8FT_VERSION_MINOR 0
#define V8FT_HEADER_BYTES 32
#define V8FT_MAX_PAYLOAD_BYTES 32768
#define V8FT_VALID_FLAGS 0x07

#define V8FT_FLAG_RESPONSE 0x01
#define V8FT_FLAG_END 0x02
#define V8FT_FLAG_RETRY 0x04

enum V8FTMessageType {
    V8FT_MSG_HELLO = 0x01,
    V8FT_MSG_HELLO_ACK = 0x02,
    V8FT_MSG_PING = 0x03,
    V8FT_MSG_PONG = 0x04,
    V8FT_MSG_ECHO = 0x05,
    V8FT_MSG_ECHO_REPLY = 0x06,
    V8FT_MSG_SHARES_REQUEST = 0x10,
    V8FT_MSG_SHARES_REPLY = 0x11,
    V8FT_MSG_LIST_DIR_REQUEST = 0x20,
    V8FT_MSG_LIST_DIR_ENTRY = 0x21,
    V8FT_MSG_LIST_DIR_END = 0x22,
    V8FT_MSG_PUT_BEGIN = 0x30,
    V8FT_MSG_PUT_READY = 0x31,
    V8FT_MSG_PUT_CHUNK = 0x32,
    V8FT_MSG_PUT_ACK = 0x33,
    V8FT_MSG_PUT_COMMIT = 0x34,
    V8FT_MSG_PUT_RESULT = 0x35,
    V8FT_MSG_GET_REQUEST = 0x40,
    V8FT_MSG_GET_BEGIN = 0x41,
    V8FT_MSG_GET_CHUNK = 0x42,
    V8FT_MSG_GET_ACK = 0x43,
    V8FT_MSG_GET_END = 0x44,
    V8FT_MSG_CANCEL = 0x70,
    V8FT_MSG_ERROR = 0x7F
};

enum V8FTFeature {
    V8FT_FEATURE_ECHO = 1u << 0,
    V8FT_FEATURE_SHARES = 1u << 1,
    V8FT_FEATURE_LIST = 1u << 2,
    V8FT_FEATURE_GET = 1u << 3,
    V8FT_FEATURE_PUT = 1u << 4,
    V8FT_FEATURE_CANCEL = 1u << 5
};

enum V8FTErrorCode {
    V8FT_ERROR_OK = 0,
    V8FT_ERROR_UNSUPPORTED_VERSION = 1,
    V8FT_ERROR_AGENT_NOT_READY = 2,
    V8FT_ERROR_UNKNOWN_SHARE = 3,
    V8FT_ERROR_READ_ONLY_SHARE = 4,
    V8FT_ERROR_INVALID_PATH = 5,
    V8FT_ERROR_PATH_ESCAPE = 6,
    V8FT_ERROR_PATH_TOO_LONG = 7,
    V8FT_ERROR_INVALID_NAME = 8,
    V8FT_ERROR_INVALID_EXTENSION = 9,
    V8FT_ERROR_NOT_FOUND = 10,
    V8FT_ERROR_NOT_A_DIRECTORY = 11,
    V8FT_ERROR_IS_A_DIRECTORY = 12,
    V8FT_ERROR_REPARSE_POINT = 13,
    V8FT_ERROR_SHARING_VIOLATION = 14,
    V8FT_ERROR_FILE_TOO_LARGE = 15,
    V8FT_ERROR_REQUEST_TOO_LARGE = 16,
    V8FT_ERROR_SESSION_QUOTA_EXCEEDED = 17,
    V8FT_ERROR_DISK_FULL = 18,
    V8FT_ERROR_CRC_MISMATCH = 19,
    V8FT_ERROR_OUT_OF_ORDER = 20,
    V8FT_ERROR_STALE_CURSOR = 21,
    V8FT_ERROR_BUSY = 22,
    V8FT_ERROR_IO = 23,
    V8FT_ERROR_ROLLBACK_FAILED = 24,
    V8FT_ERROR_CANCELLED = 25,
    V8FT_ERROR_TIMEOUT = 26,
    V8FT_ERROR_BAD_REQUEST = 27,
    V8FT_ERROR_UNSUPPORTED_FEATURE = 28
};

enum V8FTParseResult {
    V8FT_PARSE_NONE = 0,
    V8FT_PARSE_FRAME = 1,
    V8FT_PARSE_ERROR = -1
};

enum V8FTParseError {
    V8FT_PARSE_ERROR_NONE = 0,
    V8FT_PARSE_ERROR_HEADER_CRC = 1,
    V8FT_PARSE_ERROR_VERSION = 2,
    V8FT_PARSE_ERROR_FLAGS = 3,
    V8FT_PARSE_ERROR_RESERVED = 4,
    V8FT_PARSE_ERROR_PAYLOAD_TOO_LARGE = 5,
    V8FT_PARSE_ERROR_PAYLOAD_CRC = 6
};

typedef struct V8FTFrame {
    uint8_t version_major;
    uint8_t version_minor;
    uint8_t type;
    uint8_t flags;
    uint32_t request_id;
    uint32_t sequence;
    uint32_t payload_length;
    uint32_t payload_crc32;
    const uint8_t *payload;
} V8FTFrame;

typedef struct V8FTParser {
    uint8_t state;
    uint8_t magic_matched;
    uint8_t header[V8FT_HEADER_BYTES];
    uint32_t header_offset;
    uint8_t payload[V8FT_MAX_PAYLOAD_BYTES];
    uint32_t payload_offset;
    uint32_t discarded_bytes;
    V8FTFrame current;
} V8FTParser;

uint16_t v8ft_read_u16(const uint8_t *bytes);
uint32_t v8ft_read_u32(const uint8_t *bytes);
void v8ft_write_u16(uint8_t *bytes, uint16_t value);
void v8ft_write_u32(uint8_t *bytes, uint32_t value);
uint32_t v8ft_crc32_update(uint32_t state, const uint8_t *bytes, uint32_t length);
uint32_t v8ft_crc32(const uint8_t *bytes, uint32_t length);
int v8ft_encode_header(uint8_t header[V8FT_HEADER_BYTES], const V8FTFrame *frame);
void v8ft_parser_init(V8FTParser *parser);
int v8ft_parser_push(V8FTParser *parser, uint8_t value, V8FTFrame *frame,
                     enum V8FTParseError *error);

#endif
