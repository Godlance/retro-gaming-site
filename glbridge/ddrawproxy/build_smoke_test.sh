#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:-/private/tmp/ddraw-d3d7-smoke}
compiler=${CC:-i686-w64-mingw32-gcc}
objdump=${OBJDUMP:-i686-w64-mingw32-objdump}

mkdir -p "$output_dir"
"$script_dir/build.sh" "$output_dir/ddraw.dll"
"$compiler" -std=gnu99 -Os -s -mwindows -nostdlib -Wall -Wextra -Werror \
    -Wl,--subsystem,windows:5.01 \
    -Wl,-e,_WinMainCRTStartup@0 \
    -o "$output_dir/ddraw_d3d7_triangle_test.exe" \
    "$script_dir/../sample/ddraw_d3d7_triangle_test.c" \
    -lddraw -ldxguid -luser32 -lkernel32

"$compiler" -std=gnu99 -Os -s -mwindows -nostdlib -Wall -Wextra -Werror \
    -Wl,--subsystem,windows:5.01 \
    -Wl,-e,_WinMainCRTStartup@0 \
    -o "$output_dir/ddraw_d3d1_execute_buffer_test.exe" \
    "$script_dir/../sample/ddraw_d3d1_execute_buffer_test.c" \
    -lddraw -ldxguid -luser32 -lkernel32

"$compiler" -std=gnu99 -Os -s -mwindows -nostdlib -Wall -Wextra -Werror \
    -Wl,--subsystem,windows:5.01 \
    -Wl,-e,_WinMainCRTStartup@0 \
    -o "$output_dir/ddraw_d3d7_advanced_texture_test.exe" \
    "$script_dir/../sample/ddraw_d3d7_advanced_texture_test.c" \
    -lddraw -ldxguid -luser32 -lkernel32

"$compiler" -std=gnu99 -Os -s -mwindows -nostdlib -Wall -Wextra -Werror \
    -Wl,--subsystem,windows:5.01 \
    -Wl,-e,_WinMainCRTStartup@0 \
    -o "$output_dir/ddraw_surface_advanced_test.exe" \
    "$script_dir/../sample/ddraw_surface_advanced_test.c" \
    -lddraw -ldxguid -luser32 -lkernel32

imports=$(
    "$objdump" -p "$output_dir/ddraw_d3d7_triangle_test.exe" \
        | sed -n 's/^[[:space:]]*DLL Name: //p'
)
if printf '%s\n' "$imports" | grep -Eiq \
        '(msvcrt|ucrt|libgcc|libstdc\+\+|api-ms-win-crt)'; then
    printf '%s\n' "Unexpected runtime import in smoke test:" >&2
    printf '%s\n' "$imports" >&2
    exit 1
fi

advanced_imports=$(
    "$objdump" -p "$output_dir/ddraw_d3d7_advanced_texture_test.exe" \
        | sed -n 's/^[[:space:]]*DLL Name: //p'
)
if printf '%s\n' "$advanced_imports" | grep -Eiq \
        '(msvcrt|ucrt|libgcc|libstdc\+\+|api-ms-win-crt)'; then
    printf '%s\n' "Unexpected runtime import in advanced smoke test:" >&2
    printf '%s\n' "$advanced_imports" >&2
    exit 1
fi

legacy_imports=$(
    "$objdump" -p "$output_dir/ddraw_d3d1_execute_buffer_test.exe" \
        | sed -n 's/^[[:space:]]*DLL Name: //p'
)
if printf '%s\n' "$legacy_imports" | grep -Eiq \
        '(msvcrt|ucrt|libgcc|libstdc\+\+|api-ms-win-crt)'; then
    printf '%s\n' "Unexpected runtime import in legacy smoke test:" >&2
    printf '%s\n' "$legacy_imports" >&2
    exit 1
fi

surface_imports=$(
    "$objdump" -p "$output_dir/ddraw_surface_advanced_test.exe" \
        | sed -n 's/^[[:space:]]*DLL Name: //p'
)
if printf '%s\n' "$surface_imports" | grep -Eiq \
        '(msvcrt|ucrt|libgcc|libstdc\+\+|api-ms-win-crt)'; then
    printf '%s\n' "Unexpected runtime import in surface smoke test:" >&2
    printf '%s\n' "$surface_imports" >&2
    exit 1
fi

printf '%s\n' "Built XP smoke-test bundle in $output_dir"
printf '%s\n' "$imports"
printf '%s\n' "$advanced_imports"
printf '%s\n' "$legacy_imports"
printf '%s\n' "$surface_imports"
