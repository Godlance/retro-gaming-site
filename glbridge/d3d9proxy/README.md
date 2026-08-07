# Direct D3D9 to WebGPU guest frontend (M2: shader model 2.0)

This app-local `d3d9.dll` bypasses WineD3D, `opengl32.dll`, gl4es, and
WebGL, the same way `../d3d8proxy/d3d8.dll` does for D3D8. It emits D9WG
commands into the existing `v86gl.sys` 16 MiB DMA arena. The VGL2 descriptor
is only the transport envelope; command `0xFFE1` carries a versioned D9WG
batch decoded by `../d3d9-webgpu/d3d9_executor.js`. D9WG is an independent
protocol from D8WG (own opcode numbering, own resource handle namespace,
own payload shapes) — see `d3d9_protocol.h` and
`docs/d3d9-webgpu-implementation-plan.zh-CN.md` section 6.

This is milestone M2 (shader model 2.0 on top of M1's protocol skeleton and
transport layer), not a general-purpose D3D9 implementation. Implemented:

- `IDirect3D9`/`IDirect3DDevice9` COM lifecycle, adapter enumeration, caps
  (`VertexShaderVersion`/`PixelShaderVersion` now report `(2,0)`, with
  `VS20Caps`/`PS20Caps` describing what the host translator genuinely
  handles — see `fill_caps()` for why `PS20Caps.DynamicFlowControlDepth`
  stays 0), and `CreateDevice`;
- `Reset`, `Present`, `Clear`, `BeginScene`, `EndScene`;
- vertex/index buffer create/`Lock`/`Unlock` with dirty-range upload;
- 2D textures: create, `LockRect`/`UnlockRect` with subrect upload,
  `A8R8G8B8`/`X8R8G8B8`/`R5G6B5`/`X1R5G5B5`/`A1R5G5B5`/`A4R4G4B4`/`L8`/`A8`/
  DXT1/DXT3/DXT5 (format table only — DXT is not yet exercised by an M1
  acceptance test);
- vertex declarations (`CreateVertexDeclaration`/`SetVertexDeclaration`):
  `POSITION`/`POSITIONT`/`NORMAL`/`COLOR`/`TEXCOORD`/`PSIZE`/`BLENDWEIGHT`/
  `BLENDINDICES`/`TANGENT`/`BINORMAL`/`FOG` usages, default method,
  `FLOAT1`-`FLOAT4`/`D3DCOLOR`/`UBYTE4N`/`SHORT2N`/`SHORT4N`/`USHORT2N`/
  `USHORT4N`/`FLOAT16_2`/`FLOAT16_4` types, up to 4 streams;
  `SetFVF`/`GetFVF` as a compatibility path that expands the FVF bits into
  the same element shape (`XYZ`/`XYZRHW`, `NORMAL`, `DIFFUSE`, `SPECULAR`,
  up to 8 default-size 2D `TEXn`) and sends it to the host the same way
  `CreateVertexDeclaration` does — the host never decodes raw FVF bits
  (see plan section 4.3);
- `SetStreamSource`, `SetIndices`, `SetTransform`, `SetViewport`,
  `SetRenderState`, `SetTextureStageState`, `SetTexture`;
- `DrawPrimitive`, `DrawIndexedPrimitive`, `DrawPrimitiveUP`,
  `DrawIndexedPrimitiveUP`, for the fixed-function `XYZ`/`XYZRHW` path and
  for programmable shaders alike (no per-vertex lighting — `SetMaterial`/
  `SetLight`/`LightEnable` are recorded but not applied, which waits on M3);
- **M2:** `IDirect3DVertexShader9`/`IDirect3DPixelShader9`
  (`CreateVertexShader`/`CreatePixelShader`/`SetVertexShader`/
  `SetPixelShader`/`GetFunction`) for shader model 1.x–3.0 bytecode. The
  guest never interprets the bytecode: it walks the token stream to find the
  terminator, hashes it, keeps a shadow copy for `GetFunction` and Reset
  replay, and ships the raw stream. Translation to WGSL happens host-side in
  `../d3d9-webgpu/d3d9_shader_pipeline.js`;
- **M2:** all six `Set*ShaderConstant{F,I,B}` entry points and their `Get*`
  counterparts, backed by a device-side shadow of the whole register file.
  The shadow suppresses redundant sets and narrows a changed set to the
  dirty sub-range, so re-uploading a 32-register bone palette where one bone
  moved costs one `float4` on the wire;
- **M2:** `SetSamplerState` as real independent sampler state, feeding the
  host's `GPUSampler` cache rather than being recorded and ignored;
- a 64-bit per-process session namespace carried by every D9WG batch and
  verified by `HELLO`, and epoch-changing `Reset` with managed buffer/
  texture/vertex-declaration shadow reconstruction, reusing the exact
  transport/batching/handle-allocation strategy already validated by the
  D3D8 path.

Everything else — MRT/render targets/depth-stencil surfaces, clip planes,
state blocks, queries, cube/volume textures, patches, instancing
(`SetStreamSourceFreq`), `StretchRect`/`ColorFill`/readback — returns
`D3DERR_INVALIDCALL` (or the closest matching real error) rather than
pretending to have executed something this milestone does not implement.
`d3d9_protocol.h` already reserves the opcodes those need (frozen at v0.1
so archived traces stay decodable across milestones), but the guest never
emits them yet.

Set `D9WG_SHADER_MODEL=0` in the guest environment to make `GetDeviceCaps`
report the M1 fixed-function profile again (`VertexShaderVersion`/
`PixelShaderVersion` = `(0,0)`). That exists so a rendering regression can be
bisected against the known-good fixed-function path without rebuilding the
DLL — it is a diagnostic, not a supported configuration.

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

Host-side executor: `../d3d9-webgpu/d3d9_executor.js`, which requires
`../d3d9-webgpu/d3d9_shader_pipeline.js` to be loaded first (it resolves the
translator at load time, not lazily — see the `<script>` order in
`game.html`).

Tests:

- `../tests/d3d9_shader_pipeline_test.js` — bytecode → WGSL translation,
  driven by hand-assembled D3D9 tokens (`node`, no browser);
- `../tests/d3d9_shader_wgsl_validation_test.js` — runs the generated WGSL
  through `naga` when one is installed (`cargo install naga-cli`, or point
  `D9_NAGA` at the binary), so a syntax/type error surfaces in a second
  rather than as a black screen inside v86;
- `../tests/d3d9_webgpu_executor_test.js` — real D9WG batches against a fake
  WebGPU device that enforces bind-group/`writeBuffer` validation rules;
- `../tests/d3d9_webgpu_browser_test.html` — the same paths against real
  WebGPU in a browser, including a translated `vs_2_0`/`ps_2_0` pair;
- `../sample/d3d9_shader_test.c` — the real DLL in the real XP guest
  (`./build_smoke_test.sh`).
