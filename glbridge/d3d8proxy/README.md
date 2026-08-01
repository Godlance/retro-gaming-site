# Direct D3D8 to WebGPU guest frontend

This app-local `d3d8.dll` bypasses WineD3D, `opengl32.dll`, gl4es, and
WebGL. It emits high-level D3D8 commands into the existing `v86gl.sys` 16 MiB
DMA arena. The VGL2 descriptor is only the transport envelope; command
`0xFFE0` carries a versioned D8WG batch decoded by
`../d3d8-webgpu/d3d8_executor.js`.

Implemented milestone:

- adapter enumeration, MapleStory v83 format probes, caps, and `CreateDevice`;
- `Clear`, `BeginScene`, `EndScene`, and `Present`;
- vertex-buffer `Lock`/`Unlock`, dirty-range upload, stream 0, FVF shadowing;
- `D3DFVF_XYZRHW | D3DFVF_DIFFUSE` and `DrawPrimitive` triangle lists;
- guest-side suppression of repeated render and texture-stage states;
- one main PCI submit at `Present` (extra submits only when the DMA arena fills).

Texture objects, index buffers, UP draws, depth/stencil, state blocks, and
programmable shaders are intentionally not advertised as implemented yet.
Unsupported calls return `D3DERR_INVALIDCALL`.

Build an XP-compatible DLL without a C runtime dependency:

```sh
./glbridge/d3d8proxy/build.sh /private/tmp/d3d8.dll
```

Install the resulting DLL beside the target executable. Use a separate game
deployment profile that does not contain the custom `opengl32.dll` proxy:
both frontends currently share one mapped DMA arena and cannot produce batches
concurrently. Keep WineD3D and the OpenGL proxy in a different profile for the
fallback; both backends must not own `d3d8.dll` in the same application
directory.
