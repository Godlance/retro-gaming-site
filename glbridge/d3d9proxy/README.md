# Direct D3D9 to WebGPU guest frontend (M1: protocol skeleton)

This app-local `d3d9.dll` bypasses WineD3D, `opengl32.dll`, gl4es, and
WebGL, the same way `../d3d8proxy/d3d8.dll` does for D3D8. It emits D9WG
commands into the existing `v86gl.sys` 16 MiB DMA arena. The VGL2 descriptor
is only the transport envelope; command `0xFFE1` carries a versioned D9WG
batch decoded by `../d3d9-webgpu/d3d9_executor.js`. D9WG is an independent
protocol from D8WG (own opcode numbering, own resource handle namespace,
own payload shapes) — see `d3d9_protocol.h` and
`docs/d3d9-webgpu-implementation-plan.zh-CN.md` section 6.

This is milestone M1 (protocol skeleton and transport layer), not a
general-purpose D3D9 implementation. Implemented:

- `IDirect3D9`/`IDirect3DDevice9` COM lifecycle, adapter enumeration, caps
  (honestly reporting `VertexShaderVersion`/`PixelShaderVersion` as `(0,0)` —
  no programmable shader support yet), and `CreateDevice`;
- `Reset`, `Present`, `Clear`, `BeginScene`, `EndScene`;
- vertex/index buffer create/`Lock`/`Unlock` with dirty-range upload;
- 2D textures: create, `LockRect`/`UnlockRect` with subrect upload,
  `A8R8G8B8`/`X8R8G8B8`/`R5G6B5`/`X1R5G5B5`/`A1R5G5B5`/`A4R4G4B4`/`L8`/`A8`/
  DXT1/DXT3/DXT5 (format table only — DXT is not yet exercised by an M1
  acceptance test);
- vertex declarations (`CreateVertexDeclaration`/`SetVertexDeclaration`):
  `POSITION`/`POSITIONT`/`NORMAL`/`COLOR`/`TEXCOORD`/`PSIZE` usages, default
  method, `FLOAT1`-`FLOAT4`/`D3DCOLOR` types, up to 4 streams;
  `SetFVF`/`GetFVF` as a compatibility path that expands the FVF bits into
  the same element shape (`XYZ`/`XYZRHW`, `NORMAL`, `DIFFUSE`, `SPECULAR`,
  up to 8 default-size 2D `TEXn`) and sends it to the host the same way
  `CreateVertexDeclaration` does — the host never decodes raw FVF bits
  (see plan section 4.3);
- `SetStreamSource`, `SetIndices`, `SetTransform`, `SetViewport`,
  `SetRenderState`, `SetTextureStageState`, `SetTexture`;
- `DrawPrimitive`, `DrawIndexedPrimitive`, `DrawPrimitiveUP`,
  `DrawIndexedPrimitiveUP` for the fixed-function `XYZ`/`XYZRHW` path (no
  programmable vertex/pixel shaders, no per-vertex lighting — `SetMaterial`/
  `SetLight`/`LightEnable` are not implemented yet, matching a milestone
  whose fixed pipeline never applies D3D lighting to pretransformed
  geometry in the first place);
- a 64-bit per-process session namespace carried by every D9WG batch and
  verified by `HELLO`, and epoch-changing `Reset` with managed buffer/
  texture/vertex-declaration shadow reconstruction, reusing the exact
  transport/batching/handle-allocation strategy already validated by the
  D3D8 path.

Everything else — programmable shaders (`CreateVertexShader`/
`CreatePixelShader`/shader constants), independent sampler state, MRT/
render targets/depth-stencil surfaces, clip planes, state blocks, queries,
cube/volume textures, patches, `StretchRect`/`ColorFill`/readback — returns
`D3DERR_INVALIDCALL` (or the closest matching real error) rather than
pretending to have executed something this milestone does not implement.
`d3d9_protocol.h` already reserves the opcodes those need (frozen at v0.1
so archived traces stay decodable across milestones), but the guest never
emits them yet. `SetVertexShader(NULL)`/`SetPixelShader(NULL)` are accepted
as a real no-op (defensive fixed-function init is common even in games that
never intend to use shaders); any non-NULL shader object can never exist
in M1 since `CreateVertexShader`/`CreatePixelShader` always fail.

Build an XP-compatible DLL without a C runtime dependency:

```sh
./glbridge/d3d9proxy/build.sh /private/tmp/d3d9.dll
```

The build enforces `-Wall -Wextra -Werror` and asserts the output imports
only `KERNEL32.dll`/`USER32.dll`/`GDI32.dll` — no MSVCRT/UCRT dependency,
matching the D3D8 path's XP-compatibility requirement.

`Direct3DCreate9` is exported alongside `DebugSetMute` and the `D3DPERF_*`
PIX-instrumentation hooks (`BeginEvent`/`EndEvent`/`SetMarker`/`SetRegion`/
`QueryRepeatFrame`/`SetOptions`/`GetStatus`) as harmless no-ops. The D3D8
path hit exactly this class of problem with Warcraft III's
`ValidateVertexShader`/`ValidatePixelShader` static imports — a title that
imports a symbol this DLL does not export fails to *load*, so
`Direct3DCreate9` is never even reached, and the failure surfaces as a
generic "unable to initialize DirectX."

Install the resulting DLL beside the target executable. Use a separate game
deployment profile from `d3d8.dll` and the custom `opengl32.dll` proxy: all
three frontends share one mapped DMA arena and a game directory may load
only one of them (see plan section 4.6/20).

Host-side executor: `../d3d9-webgpu/d3d9_executor.js` (M1 skeleton — batch
decode, resource table, WebGPU device lifecycle, and the fixed-function
`XYZ`/`XYZRHW` draw path with no programmable shaders).
