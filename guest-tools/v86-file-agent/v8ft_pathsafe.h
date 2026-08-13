#ifndef V8FT_PATHSAFE_H
#define V8FT_PATHSAFE_H

#include <stdint.h>
#include "v8ft_protocol.h"

#define V8FT_MAX_PATH_SEGMENTS 32
#define V8FT_PATH_EXPECT_ANY 0
#define V8FT_PATH_EXPECT_DIRECTORY 1
#define V8FT_PATH_EXPECT_FILE 2
#define V8FT_PATH_EXPECT_FILE_WRITE 3

int v8ft_validate_relative_utf8(const uint8_t *input, uint16_t input_length,
                                 int allow_empty, uint16_t *output,
                                 uint16_t output_capacity, uint16_t *output_length);
int v8ft_utf16_to_utf8(const uint16_t *input, uint16_t input_length,
                        uint8_t *output, uint16_t output_capacity,
                        uint16_t *output_length);
int v8ft_path_prefix_contains(const uint16_t *root, uint16_t root_length,
                               const uint16_t *path, uint16_t path_length);

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "v8ft_shares.h"

int v8ft_normalize_share_root(const WCHAR *configured_root,
                               WCHAR output[MAX_PATH]);
int v8ft_path_resolve(const V8FTShare *share, const uint8_t *relative,
                       uint16_t relative_length, int allow_empty,
                       int expected_type, const WCHAR *blocked_executable,
                       const WCHAR *blocked_config, WCHAR output[MAX_PATH]);
#endif

#endif
