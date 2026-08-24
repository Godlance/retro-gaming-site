/**
 * ddraw-bridge.js — v86 Device Plugin for DDraw bridge
 *
 * Registers as a real v86 ISA I/O device at port 0xDE00, via the CPU's
 * port-IO dispatcher (cpu.io.register_read/register_write) — NOT the
 * named pub/sub event bus (emulator.bus.register("name", cb)), which is
 * a different mechanism used for string-keyed events like
 * "v86gl-pci-frame". A raw numeric port has no equivalent there.
 *
 * When the guest does OUT 0xDE00, we read the ring buffer from guest
 * physical memory at 0x500 and dispatch commands to the WebGL renderer.
 *
 * Integration:
 *   const bridge = new DDrawBridge(emulator.bus, emulator, canvas);
 *   bridge.attach();   // safe to call before the CPU exists — it will
 *                       // retry automatically on the "emulator-loaded"
 *                       // event if cpu.io isn't ready yet.
 */
class DDrawBridge {
    /**
     * @param {Object} bus          — v86's named event bus (emulator.bus).
     *                                 Kept for API compatibility / future
     *                                 use; port I/O itself does not go
     *                                 through it.
     * @param {Object} v86           — v86 emulator instance (for memory
     *                                 access and cpu.io lookup)
     * @param {HTMLCanvasElement} canvas — WebGL canvas
     */
    constructor(bus, v86, canvas) {
        this.bus = bus;
        this.v86 = v86;
        this.renderer = new DDrawRenderer(canvas);

        // Ring buffer read head (from guest memory)
        this.lastTail = 0;
        this._attached = false;
    }

    /**
     * Look up the CPU's I/O port dispatcher. Returns null until the
     * emulator has finished constructing its CPU (not guaranteed to
     * exist synchronously right after `new V86(...)`).
     */
    _getIO() {
        const runtime = this.v86 && this.v86.v86;
        const cpu = runtime && runtime.cpu;
        return (cpu && cpu.io) || null;
    }

    /**
     * Attach to v86's I/O port 0xDE00 via the real cpu.io API. If the
     * CPU isn't constructed yet, defers and retries once on
     * "emulator-loaded" (mirrors how v86_network_bridge.js waits for
     * cpu.devices.v86gl_pci to become available).
     * Returns true if attached immediately, false if deferred.
     */
    attach() {
        if (this._attached) {
            return true;
        }

        const io = this._getIO();
        if (!io) {
            if (!this._attachRetryQueued && this.v86 && typeof this.v86.add_listener === 'function') {
                this._attachRetryQueued = true;
                this.v86.add_listener('emulator-loaded', () => this.attach());
            }
            return false;
        }

        const onDoorbell = () => this._processRingBuffer();
        const onStatusRead = () => 0x01;  // bit 0: renderer ready

        // The guest driver only ever issues a 32-bit `outl`, but register
        // all three widths so a narrower access still rings the doorbell.
        io.register_write(0xDE00, this, onDoorbell, onDoorbell, onDoorbell);
        io.register_read(0xDE00, this, onStatusRead, onStatusRead, onStatusRead);

        this._attached = true;
        console.log('[DDrawBridge] Attached to port 0xDE00 via cpu.io');
        return true;
    }

    /**
     * Read guest physical memory via v86's memory view
     */
    _guestMem(physAddr, size) {
        return this.v86.read_memory(physAddr, size);
    }

    /**
     * Read uint32 from guest physical memory (little-endian)
     */
    _guestU32(addr) {
        const buf = this._guestMem(addr, 4);
        return buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
    }

    /**
     * Write uint32 to guest physical memory (for status return)
     *
     * emulator.write_memory(a, b) forwards straight to v86's
     * cpu.write_blob(a, b), whose real signature is write_blob(blob,
     * offset) — buffer first, address second (confirmed against
     * libv86.js: write_blob calls `this.mem8.set(a, b)`, i.e. `a` is the
     * source array and `b` the offset). So the buffer must be passed
     * before the address, not after.
     */
    _guestSetU32(addr, value) {
        const buf = new Uint8Array(4);
        buf[0] = value & 0xFF;
        buf[1] = (value >> 8) & 0xFF;
        buf[2] = (value >> 16) & 0xFF;
        buf[3] = (value >>> 24) & 0xFF;
        this.v86.write_memory(buf, addr);
    }

    /**
     * Process all pending commands in the ring buffer
     */
    _processRingBuffer() {
        const ringBase = 0x500;
        const slotSize = 64;
        const maxSlots = 1024;

        let head = this._guestU32(ringBase + 0);  // guest write index
        let tail = this._guestU32(ringBase + 4);  // last processed index

        if (head === tail) return;  // nothing new

        let count = 0;
        let currentTail = tail;

        while (currentTail !== head && count < 128) {
            const slotIndex = currentTail & (maxSlots - 1);
            const slotAddr = ringBase + 8 + slotIndex * slotSize;

            const cmdBuf = this._guestMem(slotAddr, slotSize);
            const slot = this._parseSlot(cmdBuf);

            try {
                const status = this._dispatch(slot);
                this._guestSetU32(slotAddr + 28, status);  // status field at offset 0x1C
            } catch (err) {
                console.error(`[DDrawBridge] Command ${slot.type} error:`, err);
                this._guestSetU32(slotAddr + 28, -1);
            }

            currentTail++;
            count++;
        }

        // Write back updated tail
        this._guestSetU32(ringBase + 4, currentTail);
        this.lastTail = currentTail;
    }

    /**
     * Parse a 64-byte command slot from raw bytes
     */
    _parseSlot(buf) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        return {
            type: dv.getUint16(0, true),
            pad: dv.getUint16(2, true),
            surface: dv.getUint32(4, true),
            param1: dv.getInt32(8, true),
            param2: dv.getInt32(12, true),
            param3: dv.getInt32(16, true),
            param4: dv.getInt32(20, true),
            param5: dv.getInt32(24, true),
            status: dv.getInt32(28, true),
            payload: new Uint8Array(buf.buffer, buf.byteOffset + 32, 32),
        };
    }

    /**
     * Dispatch parsed command to the renderer
     */
    _dispatch(slot) {
        switch (slot.type) {
            /* ── Display Mode ── */
            case 0x0010: return this.renderer.setDisplayMode(slot.param1, slot.param2, slot.param3);
            case 0x0011: {
                const dm = this.renderer.getDisplayMode();
                slot.param1 = dm.width;
                slot.param2 = dm.height;
                slot.param3 = dm.bpp;
                return 0;
            }
            case 0x0012: return this.renderer.setDisplayMode(640, 480, 16);
            case 0x0013: return 0;  // SetCooperativeLevel — always succeed

            /* ── Surface Management ── */
            case 0x0001: {
                const params = this._parseCreateSurface(slot.payload);
                return this.renderer.createSurface(slot.surface, params);
            }
            case 0x0002: return this.renderer.destroySurface(slot.surface);
            case 0x0003: return this.renderer.lockSurface(slot.surface);
            case 0x0004: return this.renderer.unlockSurface(slot.surface);
            case 0x0005: {
                const bp = this._parseBltParams(slot.payload);
                return this.renderer.blit(slot.surface, slot.param1, bp);
            }
            case 0x0006: {
                const bp = this._parseBltParams(slot.payload);
                return this.renderer.blitFast(slot.surface, slot.param1, bp);
            }
            case 0x0007: return this.renderer.flip(slot.surface, slot.param1);
            case 0x0008: return this.renderer.setColorKey?.(slot.surface, slot.param1, slot.param2) ?? 0;
            case 0x0009: {
                // Fill: use blit with color fill
                const bp = { flags: BLT_COLOR_FILL, color_fill: (slot.param2 >>> 0) };
                return this.renderer.blit(slot.surface, 0, bp);
            }

            /* ── Palette ── */
            case 0x0020: return this.renderer.createPalette(slot.surface, slot.param1, slot.payload);
            case 0x0021: return this.renderer.destroyPalette(slot.surface);
            case 0x0022: return this.renderer.setSurfacePalette(slot.surface, slot.param1);
            case 0x0023: return this.renderer.setPaletteEntries(slot.surface, slot.param1, slot.param2, slot.payload);
            case 0x0024: return 0;  // GetPaletteEntries stub

            /* ── Clipper ── (stub) */
            case 0x0030: return 0;
            case 0x0031: return 0;
            case 0x0032: return 0;

            /* ── Direct3D 7 ── */
            case 0x0100: return this.renderer.d3dCreateDevice(slot.surface, slot.param1);
            case 0x0101: return this.renderer.d3dDestroyDevice(slot.surface);
            case 0x0102: return this.renderer.d3dSetRenderTarget(slot.surface, slot.param1);
            case 0x0103: {
                // Clear
                const rects = null;  // would parse from payload
                const zVal = new Float32Array([slot.param3])[0];
                return this.renderer.d3dClear(slot.surface, slot.param1, slot.param2, zVal, slot.param4, rects);
            }
            case 0x0104: return this.renderer.d3dBeginScene(slot.surface);
            case 0x0105: return this.renderer.d3dEndScene(slot.surface);
            case 0x0106: return 0;  // DrawIndexedPrimitive (would need vertex data from guest mem)
            case 0x0107: return 0;
            case 0x0108: return 0;  // SetMaterial
            case 0x0109: return 0;  // SetLight
            case 0x010A: return this.renderer.d3dSetTexture(slot.surface, slot.param1, slot.param2);
            case 0x010B: return this.renderer.d3dSetRenderState(slot.surface, slot.param1, slot.param2);
            case 0x010C: return this.renderer.d3dSetTextureStageState(slot.surface, slot.param1, slot.param2, slot.param3);
            case 0x010D: return this.renderer.d3dSetViewport(slot.surface, null);
            case 0x010E: return 0;  // SetTransform

            /* ── Misc ── */
            case 0x0200: return 0;  // WaitForVSync — return immediately (we're vsync'd by browser)
            case 0x0201: return 0;  // GetCaps
            case 0x0202: {
                slot.param1 = 32 * 1024 * 1024;  // 32 MB total
                slot.param2 = 24 * 1024 * 1024;  // 24 MB free
                return 0;
            }
            case 0x0203: return 0;  // Flush

            default:
                console.warn(`[DDrawBridge] Unknown command: 0x${slot.type.toString(16)}`);
                return -1;
        }
    }

    _parseCreateSurface(payload) {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        return {
            width: dv.getInt32(0, true),
            height: dv.getInt32(4, true),
            pitch: dv.getInt32(8, true),
            flags: dv.getUint32(12, true),
            buffer_phys: dv.getUint32(16, true),
            mipmap_levels: dv.getUint32(20, true),
        };
    }

    _parseBltParams(payload) {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        return {
            src_x: dv.getInt32(0, true),
            src_y: dv.getInt32(4, true),
            src_w: dv.getInt32(8, true),
            src_h: dv.getInt32(12, true),
            dst_x: dv.getInt32(16, true),
            dst_y: dv.getInt32(20, true),
            dst_w: dv.getInt32(24, true),
            dst_h: dv.getInt32(28, true),
            flags: dv.getUint32(32, true),
            color_fill: dv.getUint32(36, true),
            color_key: dv.getUint32(40, true),
        };
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DDrawBridge };
}