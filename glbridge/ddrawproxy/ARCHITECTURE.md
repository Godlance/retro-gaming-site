# v86 DirectDraw Bridge — Architecture

## Overview

A drop-in `ddraw.dll` for Windows 9x/2000 running inside v86 that translates
DirectDraw/Direct3D 7 calls into commands dispatched to JavaScript/WebGL.

## Communication Flow

```
┌─────────────────────┐       ┌─────────────────────┐
│  Emulated Windows   │       │  Browser (JS Host)  │
│                     │       │                     │
│  Game (DX6 era)     │       │  v86 Core           │
│      │              │       │     │               │
│      ▼              │       │     ▼               │
│  ddraw.dll          │       │  ddraw-bridge.js    │
│      │              │       │      │              │
│      ▼              │       │      ▼              │
│  Ring Buffer        │──────→│  Command Parser     │
│  (guest memory)     │ reads │      │              │
│      │              │   ↑   │      ▼              │
│      ▼              │   │   │  ddraw-renderer.js  │
│  OUT 0xDE00, eax    │───┘   │  (WebGL)            │
│  (IO port trigger)  │       │      │              │
└─────────────────────┘       │      ▼              │
                               │  WebGL Canvas      │
                               └─────────────────────┘
```

## Transport: Ring Buffer + I/O Port

Two mechanisms, both live at addresses far from anything Windows 9x uses:

| Component | Address | Size | Purpose |
|-----------|---------|------|---------|
| **Ring** | `0x500` (real mode) / phys 0x500 | 64 KB | Circular command buffer |
| **Port** | `0xDE00` | 4 bytes | Signal doorbell |

### Ring Buffer Layout (at physical address 0x500)

```
┌───────────────────┐  ← 0x500
│ HEAD (uint32)     │   Write index (guest advances)
├───────────────────┤  ← 0x504
│ TAIL (uint32)     │   Read index (host advances)
├───────────────────┤  ← 0x508
│ COMMAND_SLOT[0]   │   64-byte command struct
├───────────────────┤  ← 0x548
│ COMMAND_SLOT[1]   │
├───────────────────┤  ← ...
│ ... up to 1023     │
└───────────────────┘  ← 0x10000 (64 KB)
```

### Command Structure (64 bytes)

```
Offset  Size  Field
0x00    4     type     — BRIDGE_CMD_xxx enum
0x04    4     surface  — surface handle (cookie)
0x08    4     param1   — varies
0x0C    4     param2   — varies
0x10    4     param3   — varies
0x14    4     param4   — varies
0x18    4     param5   — varies
0x1C    4     status   — return/error code
0x20    32    payload  — arbitrary data for large params
0x40    (64 total)
```

### Doorbell Protocol

1. Guest writes command into ring slot at HEAD
2. Advances HEAD (modulo ring size)
3. `OUT 0xDE00, 1` — tells host there's work
4. Host reads from TAIL to HEAD, processes each command
5. Advances TAIL after processing
6. If buffer was almost full, host signals guest via another port

## Surface Management

Surfaces are allocated in guest memory as raw framebuffers. The host side
mirrors them as WebGL textures.

- **Primary surface**: maps to the WebGL canvas directly
- **Offscreen surfaces**: plain guest memory → WebGL texture
- **System memory surfaces**: left in guest RAM, no WebGL mirror (slow path)

## Direct3D 7 support (minimal)

DX6-era games use D3D sparingly — most rendering goes through DDraw blits.
The D3D7 device is implemented as a wrapper that:
- Emits triangle lists as command buffers
- Host translates to WebGL draw calls
- Supports: D3DTOP_MODULATE, D3DTOP_SELECTARG1, alpha test, zbuffer

## Key Design Decisions

1. **No thread synchronization** — Windows 9x is cooperative multitasking;
   ddraw runs on the same thread as the game's render loop.

2. **Surface handles are simple uint32 cookies** — allocated monotonically,
   no reuse to avoid stale pointers.

3. **Palette is implemented on host** — 256-entry RGB tables cached as
   1D WebGL textures for indexed surface support.

4. **No gamma control** — DX6 games almost never use it; stub with success.

5. **Clipper is stubbed** — no hardware cursor or clipping regions in v86
   VGA emulation that would need it.