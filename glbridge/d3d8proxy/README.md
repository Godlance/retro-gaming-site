# Direct D3D8 to WebGPU guest frontend

This app-local `d3d8.dll` bypasses WineD3D, `opengl32.dll`, gl4es, and
WebGL. It emits high-level D3D8 commands into the existing `v86gl.sys` 16 MiB
DMA arena. The VGL2 descriptor is only the transport envelope; command
`0xFFE0` carries a versioned D8WG batch decoded by
`../d3d8-webgpu/d3d8_executor.js`.

Implemented geometry/lifecycle milestone (D8WG protocol v1.2):

- adapter enumeration, MapleStory v83 format probes, caps, and `CreateDevice`;
- `Clear`, `BeginScene`, `EndScene`, and `Present`;
- vertex/index-buffer `Lock`/`Unlock`, dirty-range upload, stream/index
  binding, and FVF shadowing;
- ordered mid-frame buffer updates through WebGPU staging copies, without a
  synchronous PCI round trip or an extra queue submission;
- `DrawPrimitive`, `DrawIndexedPrimitive`, `DrawPrimitiveUP`, and
  `DrawIndexedPrimitiveUP` for point/line/triangle list and strip topologies;
- CPU-side conversion of regular and indexed `D3DPT_TRIANGLEFAN` draws into
  WebGPU triangle-list index buffers;
- `D3DFMT_INDEX16` and `D3DFMT_INDEX32`;
- guest-side suppression of repeated render and texture-stage states;
- client-area position updates on Win32 move/size/show events, including apps
  that render only one frame;
- immediate device/window teardown notification so the host overlay is hidden
  when the program closes;
- one main PCI submit at `Present` (extra submits occur only when the DMA arena
  fills or when a window lifecycle event must reach the host immediately).

Texture objects, depth/stencil, state blocks, and programmable shaders are
intentionally not advertised as implemented yet. Unsupported calls return
`D3DERR_INVALIDCALL`. UP draws currently use short-lived per-frame WebGPU
buffers; the Maple Gr2D milestone will replace these allocations with a
bounded transient ring.

Build an XP-compatible DLL without a C runtime dependency:

```sh
./glbridge/d3d8proxy/build.sh /private/tmp/d3d8.dll
```

Build the XP geometry acceptance test without a C runtime dependency:

```sh
i686-w64-mingw32-gcc -mwindows -std=gnu99 -Os -s -nostdlib \
  -Wall -Wextra -Werror \
  -Wl,--subsystem,windows:5.01 -Wl,-e,_WinMainCRTStartup@0 \
  -o /private/tmp/d3d8_geometry_test.exe \
  glbridge/sample/d3d8_geometry_test.c \
  -ld3d8 -lgdi32 -luser32 -lkernel32
```

Place the test beside the new `d3d8.dll`. A pass displays four coloured
panels and the title `D3D8 geometry PASS`.

The v1.2 guest DLL and host executor must be deployed together. The executor
rejects a different protocol minor version instead of silently skipping newer
geometry commands.

Install the resulting DLL beside the target executable. Use a separate game
deployment profile that does not contain the custom `opengl32.dll` proxy:
both frontends currently share one mapped DMA arena and cannot produce batches
concurrently. Keep WineD3D and the OpenGL proxy in a different profile for the
fallback; both backends must not own `d3d8.dll` in the same application
directory.
