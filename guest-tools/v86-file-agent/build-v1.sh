#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compiler=${V86FT_CC:-i686-w64-mingw32-gcc}

"$compiler" \
    -std=c99 -Wall -Wextra -Werror -Os -s -nostdlib -ffreestanding -fno-builtin \
    -D_WIN32_WINNT=0x0501 \
    -Wl,--subsystem,console:5.01 -Wl,-e,_WinMainCRTStartup@0 \
	-o "$script_dir/v8ft_agent.exe" \
	"$script_dir/v8ft_agent.c" \
	"$script_dir/v8ft_shares.c" \
	"$script_dir/v8ft_pathsafe.c" \
	"$script_dir/v8ft_put.c" \
	"$script_dir/v8ft_protocol.c" \
	-lkernel32

echo "Built $script_dir/v8ft_agent.exe"
