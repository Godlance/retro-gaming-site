# Direct3D 8 to WebGPU architecture

## Goal

Replace the hot rendering path

```text
D3D8 -> WineD3D 1.7.52 -> opengl32 proxy -> PCI -> gl4es -> WebGL
```

with

```text
MapleStory.exe
  -> app-local d3d8.dll (COM + shadow state + batching)
  -> VGL2 DMA transport envelope / D8WG high-level command stream
  -> d3d8_executor.js (resource/state tables + pipeline cache)
  -> WebGPU / WGSL
```

The old OpenGL path remains available as a deployment fallback. The two paths
share `v86gl.sys`, the 16 MiB contiguous DMA arena, the PCI BAR and the
`v86gl-pci-frame` event, but not a rendering backend.

## Why D8WG is nested in VGL2

The current XP driver and v86 PCI device validate a 32-byte VGL2 descriptor.
Changing that outer ABI would require coordinated driver, emulator, save-state
and browser changes. Instead, VGL2 function `0xFFE0` contains one complete,
versioned D8WG batch. v86 still performs one synchronous guest-RAM read and
does not need to understand D3D8.

```text
V86GLDMADesc
  command_count = 1
  command_stream:
    [fn=0xFFE0][extended payload size]
      D8WGBatchHeader
      D8WGCommandHeader + payload + padding
      ...
```

The outer VGL2 `PRESENT` flag is deliberately clear. `D8WG_OP_PRESENT` is
executed by WebGPU, so the GL bridge must not swap its canvas.

## Implemented milestone (M1)

Guest:

- `IDirect3D8` adapter/mode/format/caps probes and `CreateDevice`;
- `IDirect3DDevice8` Clear/BeginScene/EndScene/Present;
- vertex-buffer COM object, guest shadow storage, Lock/Unlock dirty uploads;
- stream 0, FVF shadowing, render/TSS shadowing and repeated-state suppression;
- `D3DFVF_XYZRHW | D3DFVF_DIFFUSE` triangle-list draws;
- batching until Present or DMA capacity pressure.

Host:

- strict bounds/version/command-count validation;
- generation-shaped 32-bit resource handles and WebGPU resource table;
- one pre-transformed fixed-pipeline WGSL shader;
- pipeline and bind-group caches;
- aligned partial buffer updates through a host shadow buffer;
- a separate WebGPU overlay canvas, allowing the gl4es canvas to remain a
  fallback without trying to acquire two incompatible contexts on one canvas;
- counters for batches, commands, draws, uploads, presents and pipeline
  creation.

M1 is sufficient for `d3d8_clear_test.exe`, the capability-only
`d3d8_maple_gr2d_test.exe`, and the XYZRHW/Diffuse portion of
`d3d8_triangle_test.exe`. It is not yet a MapleStory-ready replacement.

## Compatibility phases

1. M2: index buffers, `Draw*UP`, viewport/scissor, depth/stencil, blend/alpha
   test and triangle-fan conversion.
2. M3: textures/surfaces, A8R8G8B8/X8R8G8B8/16-bit conversion, DXT1/3/5,
   sampler cache, texture stages 0/1 and dynamic buffers. This is the first
   MapleStory v0.83 FPS milestone.
3. M4: transforms, lighting, fog, material, render targets, mipmaps and the
   remaining fixed function path.
4. M5: state blocks, Reset/device-loss recovery, swap chains, readback and
   D3D8 shader models 1.x.

Each unsupported M1 method returns `D3DERR_INVALIDCALL`; it must not report
success while dropping rendering work.

## Performance contract

Measure at least:

- D3D8 calls and draws per frame;
- PCI submits and command bytes per frame;
- buffer/texture upload bytes per frame;
- host decode, WebGPU encoding and GPU queue time;
- pipeline and bind-group creations per frame;
- v86 CPU utilization.

The steady-state target is at most three PCI submits per frame, zero pipeline
creation per frame, and no GPU readback on the normal presentation path.

## BottleShip reference boundary

The design was checked against BottleShip commit
`a7c8543d75569d48890d48744897a0ffe3fb02f7`. The reusable ideas are D3D8
shadow state, immutable pipeline keys, resource separation, fixed-function
WGSL, caches and aggressive hot-setter batching. Its PE import interception,
HLE COM pointers, guest stack dispatch, Win32 window integration and flat
runtime memory model do not fit a full Windows XP guest and were not copied.

BottleShip is Apache-2.0. This implementation is original code based on the
observable architecture; if source is copied in later milestones, add the
required license and attribution notices at that time.

## Audio is a separate real-time path

D3D8 has no sound API and WebGPU cannot send PCM to speakers. A future direct
audio backend should be:

```text
dsound.dll -> independent audio/control batches -> SharedArrayBuffer
           -> AudioWorklet mixer -> Web Audio output
```

It must not flush on `Present`. SoundBlaster 16 should remain enabled until
DirectSound and any required `waveOut` calls have been verified for the game.
