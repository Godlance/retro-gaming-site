# DirectDraw and Direct3D 1-7 to WebGPU architecture

## Goal

Add a third guest frontend, `ddraw.dll`, so that the DirectDraw-era half of
the site's library renders through WebGPU instead of through the emulated
CPU's software blitter:

```text
game.exe
  -> app-local ddraw.dll (DirectDraw 1-7 + Direct3D 1-7 COM, surface shadow
     memory, legacy-to-D3D9 state translation)
  -> VGL2 DMA transport envelope / D9WG command stream (0xFFE1)
  -> d3d9_executor.js + ddraw_ops.js (one resource table, one WebGPU device)
  -> WebGPU / WGSL
```

Of the 32 disk images under `game/`, roughly twenty are DirectDraw-era titles:
Age of Empires II, Red Alert 2 and Yuri's Revenge, StarCraft, the Infinity
Engine set (Baldur's Gate II, Icewind Dale I/II, Planescape: Torment), Heroes
of Might and Magic III, Fallout 2, Civilization II, Theme Hospital, SimCity
3000, RollerCoaster Tycoon 2, Railroad Tycoon II, Commandos, Metal Slug,
Diablo and Diablo II, Dino Crisis, Resident Evil 2, Thief, Need for Speed 3,
Half-Life and Counter-Strike, Hitman: Codename 47, Road Rash.

Today every one of those either renders through Microsoft's software
DirectDraw into the VGA framebuffer -- every sprite blit executed by v86's
interpreted x86 -- or does not run at all when it insists on a Direct3D HAL
that the guest has no driver for. Both halves of that are what this frontend
removes.

## One DLL covers DirectDraw *and* Direct3D 1-7

`d3d.h`'s interfaces are not reachable except through `ddraw.dll`:
`IDirect3D7` comes from `IDirectDraw7::QueryInterface`, a device is created
against an `IDirectDrawSurface7` render target, the Z buffer is a surface
attached with `AddAttachedSurface`, and every texture is a surface with
`DDSCAPS_TEXTURE`. There is no seam between the 2D and 3D halves to split a
DLL along, which is why the real ddraw.dll, Wine's, and d7vk all keep them
together. So do we.

This is also why the 3D half cannot be deferred behind the 2D half in the
*design* even though it is deferred in the *schedule*: the surface object has
to be built once, correctly, as something that can be a blit destination, a
texture, a render target and a lockable pointer at the same time.

## The frontend is an app-local DLL, not a DirectDraw HAL driver

The architecturally "correct" place to accelerate DirectDraw on real Windows
is a display driver exporting the DirectDraw DDI (`DdBlt`, `DdFlip`,
`D3dDrawPrimitives2`), because that accelerates every application at once and
keeps GDI interoperability intact. We do not do this. `v86gl.sys` is a
transport driver, not a display driver; a DirectDraw HAL would have to be a
full XP display miniport, would put every guest repaint on the WebGPU path
including the desktop, and would fail in a way that leaves the guest with no
picture at all rather than one game with no picture.

App-local replacement is the same mechanism the D3D8 and D3D9 frontends
already use, is what DDrawCompat and dgVoodoo2 do for exactly these titles,
and keeps the blast radius at one process. `ddraw.dll` is not in the XP
`KnownDLLs` list, so the loader honours the app directory copy -- M0 verifies
this in the actual guest image rather than trusting the claim.

The one case it does not cover is `CoCreateInstance(CLSID_DirectDraw)`, which
resolves through the registry to `system32\ddraw.dll` and never looks in the
application directory. Titles that create DirectDraw that way are out of scope
until a per-image COM registration step exists; the common
`DirectDrawCreate`/`DirectDrawCreateEx` entry points are what the library's
games use.

## D9WG is extended, not duplicated

DirectDraw does not get a protocol of its own. A D3D7 device renders into a
DirectDraw surface, and the same surface is then blitted by DirectDraw and
sampled as a texture by Direct3D, sometimes within one frame. Two protocols
means two resource tables, and every one of those interactions becomes a
cross-table copy that only exists because of how the host was factored.

So `ddraw.dll` emits **D9WG** on `V86GL_CTRL_D3D9_BATCH` (`0xFFE1`), exactly as
`d3d8.dll` does, and protocol 1.7 adds a small DirectDraw opcode group at
`0x500`. Surfaces are ordinary D9WG textures created with the existing
`CREATE_TEXTURE_2D`, updated with `UPDATE_TEXTURE`, and destroyed with
`DESTROY_RESOURCE`. The host code for the new opcodes lives in
`d3d9-webgpu/ddraw_ops.js`, a handler mixin merged into the executor
prototype, so it shares the device, the resource table, the frame/pass builder
and the pipeline caches without growing `d3d9_executor.js` by another module's
worth of unrelated code.

## What the header numbers actually say

The D3D8 frontend was retargeted onto D9WG because D3D8 is nearly a semantic
subset of D3D9. Direct3D 7 is a *cleaner* subset than D3D8 was, and the
evidence is mechanical -- these are diffs of `d3dtypes.h` against
`d3d9types.h`:

| Constant family | Result |
| --- | --- |
| Render states | 53 names shared, **every one at the same number**; no name means two different numbers. 65 legacy-only states, 32 of which are the `STIPPLEPATTERN00..31` block |
| Texture stage states | 19 shared names, all identical values; the 10 legacy-only ones are exactly the sampler states D3D9 moved to `SetSamplerState` |
| `D3DTOP_*`, `D3DTA_*`, `D3DPT_*` | identical, no exceptions |
| `D3DTRANSFORMSTATE_*` | 11 shared identical; only `WORLD`/`WORLD1..3` move, onto `D3DTS_WORLDMATRIX(0..3)` |
| FVF bits | 28 shared identical; `POSITION_MASK` and `RESERVED2` widened in D3D9, and D3D7's `RESERVED1` bit (`0x20`) is D3D9's `PSIZE` |
| `D3DLIGHT7`, `D3DMATERIAL7`, `D3DVIEWPORT7` | byte-for-byte identical to their D3D9 counterparts |

Three of the legacy-only render states -- `FOGTABLESTART`, `FOGTABLEEND`,
`FOGTABLEDENSITY` at 36/37/38 -- occupy the numbers D3D9 gave `FOGSTART`,
`FOGEND` and `FOGDENSITY`, and mean the same thing, so they pass through
correctly by accident of history rather than by translation.

Above all, **Direct3D 7 has no programmable shaders**. The single hardest part
of the D3D9 path, the bytecode-to-WGSL compiler, has no counterpart here. What
D3D7 needs from the host is the fixed-function pipeline, eight texture stages,
lighting, fog and multitexture blending -- all of which `d3d9_executor.js`
already implements and 3DMark06 and MapleStory already exercise.

The translation work is therefore concentrated in two places, neither of them
the host: the *legacy object model* (execute buffers, viewport objects,
material objects, texture handles, `Begin`/`Vertex`/`End`) which folds into
D9WG state guest-side, and the *DirectDraw 2D surface semantics* which is
what the new opcodes are for.

## Where DirectDraw genuinely does not fit, and the five opcodes that follow

Everything DirectDraw does maps onto existing D9WG commands except five
things, each of which is a real semantic gap rather than a convenience:

1. **Colour-keyed blits.** The transparency mechanism of every 2D sprite
   engine of the era. `StretchRect` has no notion of a source colour key, and
   the key has to be compared against the source's *original* format value,
   not a filtered RGBA sample. → `DD_BLT` plus `DD_SET_COLOR_KEY`.

   The key is a value in the surface's own format -- five bits of red in
   RGB565 -- while the GPU compares the eight-bit texels the host produced on
   upload, so both sides must widen a narrow channel by the identical rule.
   They use the executor's existing one, `(v * 255 / max) | 0`, rather than the
   high-bit replication DirectDraw hardware used: the two differ by one at
   ordinary values (24 of 31 widens to 197 or 198), which is enough to make a
   keyed sprite blit as a solid rectangle. The rule is a choice; agreeing is
   not, and a test compiles the guest's function and compares it against the
   host's for every value of every width.
2. **Mirrored and colour-filled blits.** `DDBLTFX_MIRRORLEFTRIGHT`/`UPDOWN`
   and ROP fills, folded into the same `DD_BLT`.
3. **Per-surface palettes.** D3D9 palettes are device state; DirectDraw
   attaches a palette to each surface, and two P8 surfaces with different
   palettes are routine. → `DD_SET_SURFACE_PALETTE`.
4. **Display mode and cooperative level.** The exclusive-fullscreen mode the
   game asks for determines the canvas geometry and what `GetDisplayMode`
   must answer. → `DD_SET_DISPLAY_MODE`.
5. **Overlays.** `UpdateOverlay` composites a surface at scanout with its own
   colour key, which is how the era's video playback reaches the screen. →
   `DD_UPDATE_OVERLAY`, scheduled last and approximated as a present-time
   composite.

Flipping is deliberately **not** in that list. A flip chain is rotated
guest-side and the new front buffer is blitted into the swap-chain image
before `PRESENT`, which costs one full-screen GPU copy per frame and saves the
host an entire lifecycle concept. Clippers are likewise resolved guest-side
into per-rectangle blits, because `GetClipList` already hands the guest the
rectangle list the hardware would have used.

## Palettized surfaces are indexed on the GPU

The existing D3D9 path expands a P8 texture to RGBA on the CPU and re-expands
it whenever the palette changes. That is the wrong trade for DirectDraw and
the reason is correctness, not speed: a DirectDraw game blits P8 into P8 all
frame long, and a surface holds *indices*, so a later palette change has to
change the appearance of pixels that were blitted earlier. An RGBA copy cannot
be re-indexed, so a CPU-expanded destination would freeze at the palette that
was current when the sprite landed.

DirectDraw P8 surfaces are therefore stored as `r8uint` and resolved through a
256-entry palette buffer at sample and present time. Palette animation -- the
water in Age of Empires II, the fades in the Infinity Engine -- then costs a
1 KiB buffer write instead of a full-surface CPU repaint, and colour keying
compares indices, which is what the API says it compares.

## Deployment

A game directory contains exactly one of `d3d8.dll`, `d3d9.dll`,
`opengl32.dll` or `ddraw.dll`. The profiles stay mutually exclusive for the
same reason they always have: one DMA arena, one overlay canvas, one owner.

The transport is `v86gl.sys`, a WDM driver, so the target guest is Windows XP.
Several of these titles also ran on Windows 98, but the Windows 98 images have
no transport driver and are out of scope.

See `ddraw-d3d7-webgpu-implementation-plan.zh-CN.md` for the protocol
increment, the per-interface work breakdown, the milestone schedule and the
list of documented deviations.
