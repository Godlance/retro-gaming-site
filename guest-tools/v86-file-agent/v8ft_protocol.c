#include "v8ft_protocol.h"

#define V8FT_STATE_SYNC 0
#define V8FT_STATE_HEADER 1
#define V8FT_STATE_PAYLOAD 2

static const uint8_t v8ft_magic[4] = { 'V', '8', 'F', 'T' };
static uint32_t v8ft_crc_table[256];
static int v8ft_crc_table_ready;

static void v8ft_copy(uint8_t *target, const uint8_t *source, uint32_t length)
{
    uint32_t index;
    for(index = 0; index < length; index++) target[index] = source[index];
}

static void v8ft_crc_init(void)
{
    uint32_t index;
    if(v8ft_crc_table_ready) return;
    for(index = 0; index < 256; index++) {
        uint32_t value = index;
        int bit;
        for(bit = 0; bit < 8; bit++) {
            value = (value & 1u) ? (value >> 1) ^ 0xEDB88320u : value >> 1;
        }
        v8ft_crc_table[index] = value;
    }
    v8ft_crc_table_ready = 1;
}

uint16_t v8ft_read_u16(const uint8_t *bytes)
{
    return (uint16_t)(bytes[0] | ((uint16_t)bytes[1] << 8));
}

uint32_t v8ft_read_u32(const uint8_t *bytes)
{
    return (uint32_t)bytes[0] |
        ((uint32_t)bytes[1] << 8) |
        ((uint32_t)bytes[2] << 16) |
        ((uint32_t)bytes[3] << 24);
}

void v8ft_write_u16(uint8_t *bytes, uint16_t value)
{
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
}

void v8ft_write_u32(uint8_t *bytes, uint32_t value)
{
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
    bytes[2] = (uint8_t)(value >> 16);
    bytes[3] = (uint8_t)(value >> 24);
}

uint32_t v8ft_crc32_update(uint32_t state, const uint8_t *bytes, uint32_t length)
{
    uint32_t index;
    v8ft_crc_init();
    for(index = 0; index < length; index++) {
        state = (state >> 8) ^ v8ft_crc_table[(state ^ bytes[index]) & 0xFFu];
    }
    return state;
}

uint32_t v8ft_crc32(const uint8_t *bytes, uint32_t length)
{
    return v8ft_crc32_update(0xFFFFFFFFu, bytes, length) ^ 0xFFFFFFFFu;
}

int v8ft_encode_header(uint8_t header[V8FT_HEADER_BYTES], const V8FTFrame *frame)
{
    if(!header || !frame || frame->payload_length > V8FT_MAX_PAYLOAD_BYTES ||
       (frame->flags & ~V8FT_VALID_FLAGS)) return 0;
    v8ft_copy(header, v8ft_magic, 4);
    header[4] = frame->version_major;
    header[5] = frame->version_minor;
    header[6] = frame->type;
    header[7] = frame->flags;
    v8ft_write_u32(header + 8, frame->request_id);
    v8ft_write_u32(header + 12, frame->sequence);
    v8ft_write_u32(header + 16, frame->payload_length);
    v8ft_write_u32(header + 20, v8ft_crc32(frame->payload, frame->payload_length));
    v8ft_write_u32(header + 24, 0);
    v8ft_write_u32(header + 28, v8ft_crc32(header, 28));
    return 1;
}

static void v8ft_parser_restart(V8FTParser *parser)
{
    parser->state = V8FT_STATE_SYNC;
    parser->magic_matched = 0;
    parser->header_offset = 0;
    parser->payload_offset = 0;
    parser->current.payload = parser->payload;
}

void v8ft_parser_init(V8FTParser *parser)
{
    uint32_t index;
    uint8_t *bytes = (uint8_t *)parser;
    for(index = 0; index < (uint32_t)sizeof(*parser); index++) bytes[index] = 0;
    parser->current.payload = parser->payload;
    v8ft_parser_restart(parser);
}

static void v8ft_sync_byte(V8FTParser *parser, uint8_t value)
{
    if(value == v8ft_magic[parser->magic_matched]) {
        parser->header[parser->magic_matched++] = value;
        if(parser->magic_matched == 4) {
            parser->state = V8FT_STATE_HEADER;
            parser->header_offset = 4;
        }
        return;
    }
    parser->discarded_bytes++;
    parser->magic_matched = value == v8ft_magic[0] ? 1 : 0;
    if(parser->magic_matched) parser->header[0] = value;
}

static void v8ft_replay_invalid_header(V8FTParser *parser)
{
    uint8_t replay[V8FT_HEADER_BYTES - 1];
    uint32_t index;
    v8ft_copy(replay, parser->header + 1, V8FT_HEADER_BYTES - 1);
    v8ft_parser_restart(parser);
    for(index = 0; index < V8FT_HEADER_BYTES - 1; index++) {
        if(parser->state == V8FT_STATE_SYNC) v8ft_sync_byte(parser, replay[index]);
        else parser->header[parser->header_offset++] = replay[index];
    }
}

static int v8ft_finish_header(V8FTParser *parser, V8FTFrame *frame,
                               enum V8FTParseError *error)
{
    uint32_t expected_header_crc = v8ft_read_u32(parser->header + 28);
    uint32_t actual_header_crc = v8ft_crc32(parser->header, 28);
    enum V8FTParseError failure = V8FT_PARSE_ERROR_NONE;

    parser->current.version_major = parser->header[4];
    parser->current.version_minor = parser->header[5];
    parser->current.type = parser->header[6];
    parser->current.flags = parser->header[7];
    parser->current.request_id = v8ft_read_u32(parser->header + 8);
    parser->current.sequence = v8ft_read_u32(parser->header + 12);
    parser->current.payload_length = v8ft_read_u32(parser->header + 16);
    parser->current.payload_crc32 = v8ft_read_u32(parser->header + 20);
    parser->current.payload = parser->payload;

    if(expected_header_crc != actual_header_crc) failure = V8FT_PARSE_ERROR_HEADER_CRC;
    else if(parser->current.version_major != V8FT_VERSION_MAJOR) failure = V8FT_PARSE_ERROR_VERSION;
    else if(parser->current.flags & ~V8FT_VALID_FLAGS) failure = V8FT_PARSE_ERROR_FLAGS;
    else if(v8ft_read_u32(parser->header + 24) != 0) failure = V8FT_PARSE_ERROR_RESERVED;
    else if(parser->current.payload_length > V8FT_MAX_PAYLOAD_BYTES) failure = V8FT_PARSE_ERROR_PAYLOAD_TOO_LARGE;

    if(failure != V8FT_PARSE_ERROR_NONE) {
        if(error) *error = failure;
        v8ft_replay_invalid_header(parser);
        return V8FT_PARSE_ERROR;
    }

    parser->payload_offset = 0;
    parser->state = V8FT_STATE_PAYLOAD;
    if(parser->current.payload_length == 0) {
        if(parser->current.payload_crc32 != 0) {
            if(error) *error = V8FT_PARSE_ERROR_PAYLOAD_CRC;
            v8ft_parser_restart(parser);
            return V8FT_PARSE_ERROR;
        }
        *frame = parser->current;
        frame->payload = parser->payload;
        v8ft_parser_restart(parser);
        return V8FT_PARSE_FRAME;
    }
    return V8FT_PARSE_NONE;
}

int v8ft_parser_push(V8FTParser *parser, uint8_t value, V8FTFrame *frame,
                     enum V8FTParseError *error)
{
    if(error) *error = V8FT_PARSE_ERROR_NONE;
    if(parser->state == V8FT_STATE_SYNC) {
        v8ft_sync_byte(parser, value);
        return V8FT_PARSE_NONE;
    }
    if(parser->state == V8FT_STATE_HEADER) {
        parser->header[parser->header_offset++] = value;
        if(parser->header_offset == V8FT_HEADER_BYTES) {
            return v8ft_finish_header(parser, frame, error);
        }
        return V8FT_PARSE_NONE;
    }

    parser->payload[parser->payload_offset++] = value;
    if(parser->payload_offset == parser->current.payload_length) {
        uint32_t actual_crc = v8ft_crc32(parser->payload, parser->current.payload_length);
        if(actual_crc != parser->current.payload_crc32) {
            if(error) *error = V8FT_PARSE_ERROR_PAYLOAD_CRC;
            v8ft_parser_restart(parser);
            return V8FT_PARSE_ERROR;
        }
        *frame = parser->current;
        frame->payload = parser->payload;
        v8ft_parser_restart(parser);
        return V8FT_PARSE_FRAME;
    }
    return V8FT_PARSE_NONE;
}
