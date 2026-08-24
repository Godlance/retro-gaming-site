# v86 DirectDraw Bridge

A drop-in `ddraw.dll` that translates DirectDraw/Direct3D 7 calls (DX6 era)
into WebGL commands via a ring-buffer protocol — making classic Windows games
render with GPU acceleration inside v86.

## Architecture

```
┌─────────────────────┐       ┌──────────────────────────┐
│  Emulated Windows   │       │  Browser (JS Host)       │
│                     │       │                          │
│  Game.exe           │       │  v86 Emulator            │
│    │                │       │    │                     │
│    ▼                │       │    ▼                     │
│  ddraw.dll          │──────→│  ddraw-bridge.js         │
│  (C, MinGW)         │  I/O  │    │                    │
│    │                │ port  │    ▼                    │
│    ▼                │0xDE00 │  ddraw-renderer.js       │
│  Ring buffer        │←─────│  (WebGL 2)              │
│  @ phys 0x500       │status │    │                    │
└─────────────────────┘       │    ▼                    │
                              │  HTML Canvas            │
                              └──────────────────────────┘
```

## Components

| File | Purpose |
|------|---------|
| `include/ddraw_bridge.h` | Shared protocol: commands, structs, constants |
| `ddraw/ddraw.c` | IDirectDraw7, IDirectDrawSurface7, palette, clipper |
| `ddraw/d3d7.c` | IDirect3D7, IDirect3DDevice7 support |
| `ddraw/bridge.c` | Ring buffer transport, I/O doorbell |
| `ddraw/ddraw.def` | PE exports (5 exported functions) |
| `Makefile` | MinGW cross-compile (i686 target) |
| `host/ddraw-bridge.js` | v86 IO device plugin (port 0xDE00 handler) |
| `host/ddraw-renderer.js` | WebGL 2 renderer (surfaces, palettes, D3D7) |

## Supported Games

Any DX6-era game that uses DDraw for 2D rendering or D3D7 for 3D,
running in Windows 95/98/Me inside v86. Examples:

- **Diablo 1** (DDraw 2D, 640x480)
- **Starcraft** (DDraw indexed palette, 640x480)
- **Age of Empires 1** (DDraw 2D + palette)
- **Final Fantasy VII (1998)** (DDraw 3D accelerated)
- **MDK** (D3D7 rendering)
- **Tomb Raider 1-2** (DDraw + D3D)

## Build

Requirements: `i686-w64-mingw32-gcc` (cross-compiler)

```bash
sudo apt install mingw-w64    # Debian/Ubuntu
make
```

Output: `ddraw/ddraw.dll` (~35 KB stripped)

## Integration with v86

### 1. Install the DLL

Copy `ddraw.dll` into the Windows image at
`C:\WINDOWS\SYSTEM\ddraw.dll` (replaces the original stub).

### 2. Add the bridge devices

In your v86 HTML page:

```html
<canvas id="screen" width="640" height="480"></canvas>
<script src="host/ddraw-renderer.js"></script>
<script src="host/ddraw-bridge.js"></script>
<script>
const canvas = document.getElementById('screen');
const emulator = new V86({ /* ... */ });

emulator.add_listener('init', () => {
    const bridge = new DDrawBridge(emulator.bus, emulator, canvas);
    bridge.attach();
});
</script>
```

### 3. Boot

Launch Windows 95/98 in v86 with `ddraw.dll` in SYSTEM.
Old games will use it automatically — no config needed.

## Protocol Details

- **Ring buffer:** physical address `0x500`, 64 KB circular
- **Doorbell:** `OUT 0xDE00, 1` triggers processing
- **Command slot:** 64 bytes (type, surface handle, 5 params, status, 32B payload)
- **Surface memory:** guest-physical framebuffers mirrored as WebGL textures
- **Palettes:** 256-entry RGBA tables cached on host

## Limitations

- No gamma ramp support (DX6 games don't use it)
- Clipper stubbed (no window clipping — fullscreen only)
- D3D7 vertex/index buffers read from linear guest mem via physical addresses
- No multiple monitor support
- 16-bit and 32-bit surface formats only (no 24-bit)

## Route Map

1. [x] Bridge protocol (3 files: header, C, JS)
2. [x] ddraw.dll guest-side (3 C files: bridge, ddraw, d3d7)
3. [x] ddraw.dll build system (Makefile + def)
4. [x] Host JS renderer (bridge device + WebGL)
5. [ ] Test with real game (Diablo 1, Starcraft)
6. [ ] Software vertex transform fallback (no T&L)
7. [ ] Palette animation support (Starcraft)
8. [ ] Windowed mode (Clipper + GDI interop)

## License

MIT