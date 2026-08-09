# Direct3D 9.0c to WebGPU architecture

## Goal

Extend the working D3D8-to-WebGPU path with a second, independent guest
frontend that targets Direct3D 9.0c / Shader Model 3.0, so that KartRider
(跑跑卡丁车), Warcraft III and World of Warcraft can run against the same
`v86gl.sys` transport instead of WineD3D/OpenGL/gl4es:

```text
game.exe
  -> app-local d3d9.dll (COM + vertex-declaration/shader shadow state)
  -> VGL2 DMA transport envelope / D9WG high-level command stream
  -> d3d9_executor.js (resource/state tables + shader-bytecode pipeline + pipeline cache)
  -> WebGPU / WGSL
```

D3D9 is not a superset wrapper around the D3D8 path: real vertex/pixel
shaders with control flow, `IDirect3DVertexDeclaration9`, cube/volume
textures, multiple render targets and independent sampler state are
different enough that D3D9 gets its own protocol, its own guest DLL and its
own host executor. Where the two paths do the same job in the same way (PCI
submit framing, checkpoint/save-state shape, WebGPU device/canvas
management, pipeline/bind-group/sampler LRU caches), that code should be
factored into a shared module both executors import, rather than
copy-pasted or, worse, reverse-engineered a second time.

## Why D9WG is a second command stream nested in VGL2, not a D8WG extension

The same reasoning that put D8WG behind one VGL2 function code applies again:
changing the outer 32-byte VGL2 descriptor means touching the XP driver, the
v86 PCI device, save-state format and the browser bridge in lockstep. D9WG
reuses that mechanism through a second, sibling function code:

```text
V86GLDMADesc
  command_count = 1
  command_stream:
    [fn=0xFFE1][extended payload size]
      D9WGBatchHeader
      D9WGCommandHeader + payload + padding
      ...
```

`0xFFE0` (`V86GL_CTRL_D3D8_BATCH`) is untouched. `0xFFE1`
(`V86GL_CTRL_D3D9_BATCH`) is new. Both share the 16 MiB contiguous DMA arena,
the PCI BAR and the `v86gl-pci-frame` event, but a game process loads exactly
one of `d3d8.dll` or `d3d9.dll` (deployment profiles remain mutually
exclusive, matching the existing D3D8/OpenGL-proxy exclusion rule), so only
one function code is ever in flight per session.

D9WG is versioned the same way D8WG is: magic `D9WG` (`0x47573944`),
independent major/minor, a 64-bit per-process session id in every batch, and
a resource-handle namespace that is disjoint per kind (buffers, textures,
vertex declarations, vertex shaders, pixel shaders, queries, state blocks)
so a single host resource table can hold all of them without collision.

## Why D3D9 needs a real shader compiler, not a hand-written opcode table

The D3D8 path's shader-model-1.x translator is a straight-line, per-opcode
WGSL emitter because SM1.x bytecode has no control flow. SM2.0/3.0 bytecode
has `if`/`else`/`endif`, `rep`/`endrep`, `loop`/`endloop`, `call`/`callnz`,
`ret`, predicated instructions, relative constant addressing and a much
larger register/opcode set — enough that hand-writing a second translator by
extending the SM1.x one is not realistic engineering.

The recommended path is: compile a small, purpose-built subset of
`vkd3d-shader` (Wine project, LGPL-2.1+, already implements SM1–3 bytecode
parsing and a SPIR-V backend) to WebAssembly, and feed its SPIR-V output into
Tint (Chromium/Dawn project, BSD-3-Clause) compiled to WebAssembly for the
SPIR-V-to-WGSL leg. This is a build-time/first-use compile step: the guest
DLL transmits raw bytecode once per distinct shader (content-hashed), the
host compiles and caches the resulting WGSL and `GPUShaderModule` keyed by
that hash, and every later reference to the same shader is a cache hit. This
must never re-run on the per-draw hot path.

See the implementation plan (`d3d9-webgpu-implementation-plan.zh-CN.md`,
section 9) for the full translation pipeline, constant-register layout and
license/attribution obligations that come with embedding vkd3d-shader and
Tint.

## Target games and honest scoping

The three target games are not equally hard:

- **KartRider**: mostly fixed-function-shaped rendering with a small number
  of SM2.0 effects (water, reflections). Best first end-to-end target.
- **Warcraft III** (classic, pre-Reforged): predominantly fixed function
  plus simple SM1.1-equivalent terrain/unit shaders already close to what
  the D3D8 path's SM1.x translator proves out; the real new surface area is
  vertex declarations, multitexture terrain blending and cube/volume assets
  used by some effects.
- **World of Warcraft**: full SM2.0/3.0 usage, vertex skinning in the vertex
  shader, terrain texture splatting, dynamic MRT-based effects, occlusion
  queries, environment/cube maps, and a live, patch-updated content set with
  an effectively unbounded number of distinct shaders. This is the long tail
  and should be the last milestone, scoped first to login/character-select
  (mostly 2D UI + a single 3D model preview), then terrain, then full world
  rendering, then particle/post-process effects.

D3DX9 (`d3dx9_xx.dll`) is a separate, large dependency (texture
decode/mipmap generation, sprite/font helpers, and in the worst case runtime
HLSL compilation via `D3DXCompileShader`). Phase 0 for every game must
capture whether it links D3DX9 and, if so, which entry points it actually
calls, before committing to a milestone scope; runtime HLSL source
compilation is out of scope for the initial plan and is called out as a
standalone risk.

## Compatibility phases (see the implementation plan for detail)

1. M1: protocol/transport skeleton, `IDirect3D9`/`IDirect3DDevice9`
   lifecycle, vertex declarations, `Draw*`, fixed-function-equivalent
   shaders — enough for KartRider's menu and a static track.
2. M2: SM2.0/3.0 bytecode-to-WGSL pipeline online, cached and validated
   against real WebGPU compilation — KartRider becomes playable.
3. M3: Warcraft III fixed-function core, multitexture terrain blending,
   cube/volume texture support — Warcraft III single-player campaign
   playable.
4. M4: independent sampler state, multiple render targets, occlusion
   queries, `StretchRect`/`GetRenderTargetData` — WoW login/character
   select.
5. M5: terrain splatting, skinned characters, environment maps — WoW world
   rendering.
6. M6: particle systems, post-process passes, performance hardening. The host
   core landed on 2026-08-09: point lists expand to instanced quads, shader
   translation runs in a Worker with a bounded IndexedDB LRU, and draw
   constants use a persistent uniform ring plus dynamic offsets. Final M6
   status still requires the target-game manual effects/performance pass.

Each unsupported method continues the D3D8 path's rule: return
`D3DERR_INVALIDCALL` rather than silently drop rendering work.

## Performance contract

Same measurement discipline as the D3D8 path, with one addition specific to
D3D9: track **first-use shader-compile latency** (bytecode hash miss →
vkd3d-shader → SPIR-V → Tint → WGSL → `createShaderModule`) separately from
per-frame steady-state cost, because WoW's shader variety means cache warm-up
is a real, user-visible cost that the D3D8 path never had to budget for.

`D3D9Executor.getStats()` therefore reports cache hit/miss and compile-latency
p50/p95/p99, cached WGSL bytes, Worker and persistent-cache outcomes, uniform
ring reuse/overflow, bind-group cache behaviour, MRT attachment distribution,
and the current frame's pipeline/bind-group/submit/pass counts. The M6 steady
state regression drives 150 draws after two warm-up frames and pins the result
to zero pipeline/bind-group/buffer creation, one render pass, one queue submit,
and no GPU readback.

## Relationship to the D3D8 path

`d3d8.dll`/`d3d8_executor.js` and `d3d9.dll`/`d3d9_executor.js` are separate
deployment artifacts. Do not merge them into one DLL or one executor module;
do factor out the WebGPU-device/canvas lifecycle, checkpoint format
versioning helpers, and generic LRU cache implementations they can share, so
D3D9 does not re-derive infrastructure the D3D8 path already got right.

## Audio

Unchanged from the D3D8 plan: DirectSound stays on the independent
`dsound.dll` → SharedArrayBuffer → AudioWorklet path, decoupled from either
graphics batch stream.
