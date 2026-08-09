# Direct D3D9 to WebGPU guest frontend (M5 rendering path)

This app-local `d3d9.dll` bypasses WineD3D, `opengl32.dll`, gl4es, and
WebGL, the same way `../d3d8proxy/d3d8.dll` does for D3D8. It emits D9WG
commands into the existing `v86gl.sys` 16 MiB DMA arena. The VGL2 descriptor
is only the transport envelope; command `0xFFE1` carries a versioned D9WG
batch decoded by `../d3d9-webgpu/d3d9_executor.js`. D9WG is an independent
protocol from D8WG (own opcode numbering, own resource handle namespace,
own payload shapes) — see `d3d9_protocol.h` and
`docs/d3d9-webgpu-implementation-plan.zh-CN.md` section 6.

This implements the M1-M5 rendering path (protocol, SM2 translation,
fixed-function rendering, M4 resource operations, the M4.5 caps profile, and
M5 main-world primitives). It is still not a general-purpose D3D9
implementation. Implemented:

- `IDirect3D9`/`IDirect3DDevice9` COM lifecycle, adapter enumeration, caps
  (`VertexShaderVersion`/`PixelShaderVersion` now report `(2,0)`, with
  `VS20Caps`/`PS20Caps` describing what the host translator genuinely
  handles — see `fill_caps()` for why `PS20Caps.DynamicFlowControlDepth`
  stays 0), and `CreateDevice`;
- `Reset`, `Present`, `Clear`, `BeginScene`, `EndScene`;
- vertex/index buffer create/`Lock`/`Unlock` with dirty-range upload;
- 2D textures: create, `LockRect`/`UnlockRect` with subrect upload,
  `A8R8G8B8`/`X8R8G8B8`/`R5G6B5`/`X1R5G5B5`/`A1R5G5B5`/`A4R4G4B4`/`L8`/`A8`/
  DXT1/DXT3/DXT5;
- vertex declarations (`CreateVertexDeclaration`/`SetVertexDeclaration`):
  `POSITION`/`POSITIONT`/`NORMAL`/`COLOR`/`TEXCOORD`/`PSIZE`/`BLENDWEIGHT`/
  `BLENDINDICES`/`TANGENT`/`BINORMAL`/`FOG` usages, default method,
  `FLOAT1`-`FLOAT4`/`D3DCOLOR`/`UBYTE4`/`SHORT2`/`SHORT4`/`UBYTE4N`/
  `SHORT2N`/`SHORT4N`/`USHORT2N`/`USHORT4N`/`UDEC3`/`DEC3N`/`FLOAT16_2`/
  `FLOAT16_4` types, up to 4 streams;
  `SetFVF`/`GetFVF` as a compatibility path that expands the FVF bits into
  the same element shape (`XYZ`/`XYZRHW`, `NORMAL`, `DIFFUSE`, `SPECULAR`,
  up to 8 default-size 2D `TEXn`) and sends it to the host the same way
  `CreateVertexDeclaration` does — the host never decodes raw FVF bits
  (see plan section 4.3);
- `SetStreamSource`, `SetIndices`, `SetTransform`, `SetViewport`,
  `SetRenderState`, `SetTextureStageState`, `SetTexture`;
- `DrawPrimitive`, `DrawIndexedPrimitive`, `DrawPrimitiveUP`,
  `DrawIndexedPrimitiveUP`, for the fixed-function `XYZ`/`XYZRHW` path and
  for programmable shaders alike;
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
- exclusive-fullscreen behaviour a real D3D9 runtime provides and no part of
  this stack otherwise does: the display mode change, and *maintaining* the
  foreground for the device window rather than claiming it once at
  `CreateDevice`. See `maintain_fullscreen_foreground` for why one claim is not
  enough and why `SetForegroundWindow` needs help to work at all;
- a 64-bit per-process session namespace carried by every D9WG batch and
  verified by `HELLO`, and epoch-changing `Reset` with managed buffer/
  texture/cube-texture/vertex-declaration shadow reconstruction, reusing the
  exact transport/batching/handle-allocation strategy already validated by the
  D3D8 path;
- **M3:** `SetMaterial`/`SetLight`/`LightEnable` are now consumed by the host's
  fixed-function vertex stage rather than only recorded, and the whole
  `SetTextureStageState` surface drives a real multi-stage blending cascade.
  Both were caps promises `fill_caps()` had been making since M1
  (`MaxTextureBlendStages = 8`, `D3DVTXPCAPS_DIRECTIONALLIGHTS`,
  `MaxActiveLights = 8`, a large `TextureOpCaps` set) without keeping;
- **M3:** `IDirect3DCubeTexture9` (six faces per level, `LockRect`/`UnlockRect`
  per face). `GetCubeMapSurface` still fails honestly — the only thing an app
  does with a face surface is lock it, which `LockRect` covers directly, and
  handing back a surface whose `LockRect` wrote to face 0 would be worse;
- **M3:** `IDirect3DStateBlock9` — `CreateStateBlock(ALL/PIXELSTATE/
  VERTEXSTATE)`, `Apply`, `Capture`, and `BeginStateBlock`/`EndStateBlock`.
  Recording keeps an explicit Set-call mask (including same-value and
  write-then-revert calls), and captured textures, shaders, declarations and
  buffers retain their COM references until the block is released;
- **M3:** `SetScissorRect`/`GetScissorRect`, gated by
  `D3DRS_SCISSORTESTENABLE`;
- **M3 (brought forward from M4):** render targets and depth surfaces —
  `CreateRenderTarget`, `CreateDepthStencilSurface`,
  `D3DUSAGE_RENDERTARGET`/`D3DUSAGE_DEPTHSTENCIL` textures,
  `SetRenderTarget` for four MRT slots, `SetDepthStencilSurface` and both
  `Get*`, plus `StretchRect` and `ColorFill`. A 2005-era D3D9 title renders
  most of its frame into textures, so without these it has no picture at all.
  `StretchRect` handles the back buffer as source or destination (deferred to
  Present, because that is the only point where the swap chain has a view), and
  scales or converts format through a blit pass when a plain copy cannot express
  it;
- **M3:** `IDirect3DQuery9` for `OCCLUSION`/`EVENT`, answered inside the guest
  with a deliberately conservative result. The reasoning is in the comment
  above `IDirect3DQuery9`; the short version is that failing `CreateQuery`
  makes engines disable whole render branches and returning `S_FALSE` forever
  deadlocks the standard polling loop, so over-reporting visibility (which only
  costs frame time) is the least-wrong answer until the host→guest return
  channel of plan section 6.7 exists;
- **M3:** `D9WG_DUMP_SHADERS=1` writes every shader's raw token stream to
  `d3d9_dump\` beside this DLL, named by content hash, for offline replay
  through `../tests/d3d9_shader_corpus_test.js`. See the comment above
  `dump_shader_bytecode` for why a hand-written translator needs real-game
  bytecode more than it needs more hand-written tests;
- **M4:** rectangle-list `Clear`, partial `ColorFill`, scaled/converted
  `StretchRect`, and exact `GetRenderTargetData` for render-target contents
  whose complete value is known from `Clear`/`ColorFill`/known-source copy.
  Any GPU draw invalidates that CPU mirror, so arbitrary GPU-produced pixels
  still fail honestly instead of returning stale data;
- **M4.5:** `D9WG_CAPS_PROFILE=ffp` (aliases `m4.5` and `low`) exposes the
  supported fixed-function-only caps profile. `sm2`/`m5` selects the default
  shader-model-2 profile;
- **M5:** declaration-specific shader variants convert compact skinning inputs
  `UBYTE4`/`SHORT2`/`SHORT4`/`UDEC3`/`DEC3N`; sRGB reads and writes use
  compatible texture/target views; blend constants, separate-alpha blending,
  front/back stencil state, stencil reference, constant/slope depth bias, and
  per-draw scissor reset are all carried into WebGPU;
- **Warcraft III shadow fix:** projected texture division now preserves the
  sign of `q` in both fixed-function and shader-modifier paths. Clamping a
  negative `q` to positive epsilon made behind-projector UVs sample an opaque
  shadow-edge texel across whole terrain triangles, producing large black
  wedges. The shadow pass also receives its complete blend/stencil/depth state.
- **Warcraft III campaign state/cursor fix:** the guest state cache now starts
  from the real D3D9 render, texture-stage, and sampler defaults. This is
  correctness-critical because equal-value Set calls are suppressed: an
  all-zero cache discarded the first `ZENABLE=FALSE`/`ZWRITEENABLE=FALSE`
  transition and left scene depth active over UI, fog-of-war, and shadow
  overlays. Stage defaults now also preserve the first transition from stage
  1's `TEXCOORDINDEX=1` to War3's shared texcoord 0. Fixed-function BORDER
  addressing selects `D3DSAMP_BORDERCOLOR` in WGSL instead of stretching an
  opaque edge texel beyond projected shadow/fog masks. The GDI cursor capture
  fallback is now enabled by default because the browser cursor is hidden; set
  `D9WG_GDI_CURSOR=0` only for a title that intentionally draws its own cursor
  geometry.

Still unimplemented, each returning `D3DERR_INVALIDCALL` (or the closest
matching real error) rather than pretending: volume textures
(`CreateVolumeTexture`), user clip planes (`MaxUserClipPlanes` reports 0, so
nothing asks for them — WGSL has no clip-distance facility, see plan section
9.11), instancing (`SetStreamSourceFreq`), `ProcessVertices`, additional swap
chains, palettes, patches, `MultiplyTransform`, arbitrary GPU-produced
`GetRenderTargetData`, and `GetFrontBufferData` (plan section 2.2).
`d3d9_protocol.h` reserves the opcodes the first few would need, frozen at v0.1
so archived traces stay decodable across milestones.

Set `D9WG_CAPS_PROFILE=ffp` in the guest environment to make `GetDeviceCaps`
report the supported M4.5 fixed-function profile (`VertexShaderVersion`/
`PixelShaderVersion` = `(0,0)`); `D9WG_CAPS_PROFILE=sm2` is the default M5
profile. The legacy `D9WG_SHADER_MODEL=0` spelling remains accepted.

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
  WebGPU in a browser, including a translated `vs_2_0`/`ps_2_0` pair with an
  M5 compact vertex input, a lit two-stage cube-sampling draw rendered into a
  texture, partial Clear/ColorFill, and an sRGB back-buffer write.
  Run it against real WebGPU rather than trusting `naga` alone: `naga` and Tint
  disagree on real cases, and the M3 round found one only Tint catches (a bind
  group layout must declare `viewDimension`, because `naga` validates a module
  in isolation and never sees the module/layout pairing);
- `../tests/d3d9_shader_corpus_test.js` — replays a directory of `.d9sh` files
  dumped by `D9WG_DUMP_SHADERS=1` through the translator, grouping failures by
  message. Opt-in via `D9_SHADER_CORPUS`; it is a measurement, not a gate,
  unless `D9_CORPUS_STRICT=1`;
- `../sample/d3d9_shader_test.c` — the real DLL in the real XP guest
  (`./build_smoke_test.sh`).
