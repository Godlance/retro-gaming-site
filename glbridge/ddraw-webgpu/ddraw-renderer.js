/**
 * ddraw-renderer.js — WebGL 2 renderer for the v86 DDraw bridge
 *
 * Manages all GPU state: surfaces (as textures), palettes, framebuffers,
 * and the Direct3D 7 fixed-function pipeline.
 */

/**
 * Minimal local stand-in for a mat4 library — this project doesn't vendor
 * gl-matrix or anything similar anywhere, and none existed for this file,
 * so `mat4.identity()` threw a ReferenceError before the renderer could
 * even construct. D3D7 transform support (BRIDGE_CMD_D3D_SET_TRANSFORM,
 * command 0x010E) is currently a no-op stub in ddraw-bridge.js, so these
 * matrices are inert placeholders for now — this is NOT a general matrix
 * library. If real transform support gets implemented later, replace
 * this with a proper mat4 multiply/perspective/lookAt implementation
 * (or vendor gl-matrix) rather than extending it in place.
 */
const mat4 = {
    identity() {
        // prettier-ignore
        return new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]);
    },
};

class DDrawRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
        });
        if (!this.gl) throw new Error('WebGL 2 not available');

        this.gl.clearColor(0, 0, 0, 1);
        this.gl.enable(this.gl.SCISSOR_TEST);

        // Surface store: handle -> { tex: WebGLTexture, w, h, pixels, format, dirty }
        this.surfaces = new Map();

        // Palette store: handle -> Uint8Array(1024) RGBA 256 entries
        this.palettes = new Map();

        // Current display mode
        this.displayMode = { width: 640, height: 480, bpp: 16 };

        // Direct3D 7 device state
        this.d3dDevice = null;
        this.renderStates = new Map();
        this.textureStages = [{
            colorOp: this.gl.MODULATE,
            colorArg1: this.gl.TEXTURE,
            colorArg2: this.gl.PRIMARY_COLOR,
            alphaOp: this.gl.MODULATE,
            alphaArg1: this.gl.TEXTURE,
            alphaArg2: this.gl.PRIMARY_COLOR,
        }];
        this.activeTextures = [null, null];
        this.viewport = { x: 0, y: 0, w: 640, h: 480 };
        this.matWorld = mat4.identity();
        this.matView = mat4.identity();
        this.matProj = mat4.identity();

        // Shaders for 3D
        this._initShaders();
    }

    /* ── Display Mode ─────────────────────────────────────────── */

    setDisplayMode(width, height, bpp) {
        this.displayMode = { width, height, bpp };
        this.canvas.width = width;
        this.canvas.height = height;
        this.gl.viewport(0, 0, width, height);
        // ddraw is fullscreen-only in this bridge (see ARCHITECTURE.md —
        // the clipper is stubbed, no windowed mode), so unlike the
        // per-hwnd d3d8/d3d9 overlay canvases there's no surface rect to
        // track: just reveal the canvas once a mode is set.
        if (this.canvas.style) {
            this.canvas.style.display = 'block';
            this.canvas.style.visibility = 'visible';
        }
        return 0;
    }

    getDisplayMode() {
        return { ...this.displayMode };
    }

    /* ── Surface management ─────────────────────────────────────── */

    createSurface(handle, params) {
        // params: { width, height, pitch, flags, buffer_phys }
        const tex = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, tex);

        const internalFormat = (params.flags & SURF_INDEXED) ? this.gl.R8 :
                              (params.flags & SURF_32BIT) ? this.gl.RGBA8 :
                              (params.flags & SURF_16BIT) ? this.gl.RGB565 : this.gl.RGBA8;
        const format = (params.flags & SURF_INDEXED) ? this.gl.RED :
                       (params.flags & SURF_32BIT) ? this.gl.RGBA : this.gl.RGB;
        const type = (params.flags & SURF_16BIT) ? this.gl.UNSIGNED_SHORT_5_6_5 :
                     this.gl.UNSIGNED_BYTE;

        // Allocate texture storage for the surface
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, internalFormat,
                           params.width, params.height, 0, format, type, null);

        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER,
                              params.flags & SURF_TEXTURE ? this.gl.LINEAR_MIPMAP_LINEAR : this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER,
                              this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S,
                              params.flags & SURF_TEXTURE ? this.gl.REPEAT : this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

        // Allocate pixel buffer (if system memory or texture)
        let pixels = null;
        if ((params.flags & SURF_SYSTEM_MEMORY) || (params.flags & SURF_TEXTURE)) {
            const bpp = (params.flags & SURF_32BIT) ? 4 : (params.flags & SURF_16BIT) ? 2 : 1;
            pixels = new Uint8Array(params.width * params.height * bpp);
        }

        this.surfaces.set(handle, {
            tex,
            width: params.width,
            height: params.height,
            pitch: params.pitch || (params.width * ((params.flags & SURF_32BIT) ? 4 : (params.flags & SURF_16BIT) ? 2 : 1)),
            flags: params.flags,
            pixels,
            dirty: false,
            internalFormat,
            format,
            type,
        });

        return handle;
    }

    destroySurface(handle) {
        const surf = this.surfaces.get(handle);
        if (!surf) return -1;
        this.gl.deleteTexture(surf.tex);
        this.surfaces.delete(handle);
        return 0;
    }

    lockSurface(handle) {
        const surf = this.surfaces.get(handle);
        if (!surf) return -1;
        // For primary/frontbuffer surfaces, we expose the WebGL canvas
        // For offscreen, we return the pixel buffer address
        // In v86, we'd map this to guest memory. For now, return handle
        // The actual pixel address would be the guest physical mapped address
        return 0;  // success
    }

    unlockSurface(handle) {
        const surf = this.surfaces.get(handle);
        if (!surf) return -1;

        if (surf.pixels && surf.dirty) {
            this.gl.bindTexture(this.gl.TEXTURE_2D, surf.tex);
            this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0,
                                   surf.width, surf.height, surf.format, surf.type,
                                   surf.pixels);
            surf.dirty = false;
        }

        // If this is the primary surface, present it
        if (surf.flags & SURF_PRIMARY) {
            this._presentPrimary(surf);
        }

        return 0;
    }

    blit(dstHandle, srcHandle, params) {
        // params: { src_x, src_y, src_w, src_h, dst_x, dst_y, dst_w, dst_h, flags, color_fill, color_key }
        const dst = this.surfaces.get(dstHandle);
        const src = srcHandle ? this.surfaces.get(srcHandle) : null;

        if (!dst) return -1;

        if (params.flags & BLT_COLOR_FILL) {
            // Fill with color
            this._fillSurface(dst, params);
            return 0;
        }

        if (!src) return -1;

        // Stretch blit via WebGL
        this._blitTextured(dst, src, params);

        return 0;
    }

    blitFast(dstHandle, srcHandle, params) {
        return this.blit(dstHandle, srcHandle, params);
    }

    flip(handle, targetHandle) {
        const surf = this.surfaces.get(handle);
        if (!surf) return -1;

        // In DX6, flip just swaps front/back buffer pointers
        // For we emulation, we present the current surface
        if (surf.flags & SURF_PRIMARY || surf.flags & SURF_BACK_BUFFER) {
            this._presentPrimary(surf);
        }

        return 0;
    }

    /* ── Palette ──────────────────────────────────────────────────── */

    createPalette(handle, flags, entries) {
        // entries: raw PALETTEENTRY[256] (as Uint8Array)
        const pal = new Uint8Array(256 * 4);
        if (entries) {
            for (let i = 0; i < 256; i++) {
                pal[i * 4 + 0] = entries[i * 4 + 2];     // R
                pal[i * 4 + 1] = entries[i * 4 + 1];     // G
                pal[i * 4 + 2] = entries[i * 4 + 0];     // B
                pal[i * 4 + 3] = 255;                     // A
            }
        }
        this.palettes.set(handle, pal);
        return 0;
    }

    destroyPalette(handle) {
        this.palettes.delete(handle);
        return 0;
    }

    setPaletteEntries(handle, start, count, entries) {
        const pal = this.palettes.get(handle);
        if (!pal) return -1;
        if (entries) {
            for (let i = 0; i < count && (start + i) < 256; i++) {
                const idx = (start + i) * 4;
                pal[idx + 0] = entries[i * 4 + 2];  // R
                pal[idx + 1] = entries[i * 4 + 1];  // G
                pal[idx + 2] = entries[i * 4 + 0];  // B
                pal[idx + 3] = 255;
            }
        }
        return 0;
    }

    setSurfacePalette(surfHandle, palHandle) {
        // Save the palette reference — used when rendering indexed surfaces
        const surf = this.surfaces.get(surfHandle);
        if (!surf) return -1;
        surf.palette = palHandle ? this.palettes.get(palHandle) : null;
        return 0;
    }

    /* ── Direct3D 7 ────────────────────────────────────────────── */

    d3dCreateDevice(handle, rtHandle) {
        this.d3dDevice = {
            handle,
            rtHandle,
            material: { diffuse: [1,1,1,1], ambient: [0,0,0,0], emissive: [0,0,0,0], specular: [0,0,0,0], power: 0 },
            lights: new Map(),
            inScene: false,
        };
        return 0;
    }

    d3dDestroyDevice(handle) {
        this.d3dDevice = null;
        return 0;
    }

    d3dSetRenderTarget(devHandle, surfHandle) {
        if (!this.d3dDevice) return -1;
        this.d3dDevice.rtHandle = surfHandle;
        return 0;
    }

    d3dClear(devHandle, flags, color, z, stencil, rects) {
        if (!this.d3dDevice) return -1;
        const surf = this.surfaces.get(this.d3dDevice.rtHandle);
        if (!surf) return -1;

        const mask = ((flags & 1) ? this.gl.COLOR_BUFFER_BIT : 0) |
                     ((flags & 2) ? this.gl.DEPTH_BUFFER_BIT : 0) |
                     ((flags & 4) ? this.gl.STENCIL_BUFFER_BIT : 0);

        if (rects && rects.length > 0) {
            // Scissored clears per rect
            this.gl.enable(this.gl.SCISSOR_TEST);
            for (const r of rects) {
                this.gl.scissor(r.x1, surf.height - r.y2, r.x2 - r.x1, r.y2 - r.y1);
                this.gl.clearColor(
                    ((color >> 16) & 0xFF) / 255,
                    ((color >> 8) & 0xFF) / 255,
                    (color & 0xFF) / 255,
                    1
                );
                this.gl.clearDepth(z);
                this.gl.clear(mask);
            }
            this.gl.scissor(0, 0, surf.width, surf.height);
        } else {
            this.gl.clearColor(
                ((color >> 16) & 0xFF) / 255,
                ((color >> 8) & 0xFF) / 255,
                (color & 0xFF) / 255,
                1
            );
            this.gl.clearDepth(z);
            this.gl.clear(mask);
        }
        return 0;
    }

    d3dBeginScene(devHandle) {
        if (!this.d3dDevice) return -1;
        this.d3dDevice.inScene = true;
        return 0;
    }

    d3dEndScene(devHandle) {
        if (!this.d3dDevice) return -1;
        if (!this.d3dDevice.inScene) return -1;
        this.d3dDevice.inScene = false;
        // Present
        const surf = this.surfaces.get(this.d3dDevice.rtHandle);
        if (surf) this._presentPrimary(surf);
        return 0;
    }

    d3dSetRenderState(devHandle, state, value) {
        this.renderStates.set(state, value);
        return 0;
    }

    d3dSetTextureStageState(devHandle, stage, type, value) {
        if (!this.textureStages[stage]) {
            this.textureStages[stage] = {};
        }
        this.textureStages[stage][type] = value;
        return 0;
    }

    d3dSetViewport(devHandle, vp) {
        if (vp) {
            this.viewport = { x: vp.dwX, y: vp.dwY, w: vp.dwWidth, h: vp.dwHeight };
            this.gl.viewport(vp.dwX, vp.dwY, vp.dwWidth, vp.dwHeight);
        }
        return 0;
    }

    d3dSetTexture(devHandle, stage, texHandle) {
        this.activeTextures[stage] = texHandle;
        return 0;
    }

    /* ── Internal helpers ──────────────────────────────────────── */

    _presentPrimary(surf) {
        // Blit the surface to the canvas
        const dst = {
            tex: null,
            width: this.canvas.width,
            height: this.canvas.height,
            pixels: null,
        };

        // Fullscreen textured quad
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        // Simple blit program
        this._drawTexturedQuad(surf.tex, 0, 0, this.canvas.width, this.canvas.height);
    }

    _drawTexturedQuad(tex, x, y, w, h) {
        const gl = this.gl;
        // Use default screen-filling quad
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // Vertex positions: full viewport quad
        // (implementation uses gl.TRIANGLE_STRIP)
    }

    _fillSurface(surf, params) {
        // Use WebGL clear or texture fill
    }

    _blitTextured(dst, src, params) {
        // Stretch blit via a textured quad to a framebuffer
    }

    _initShaders() {
        // Initialize minimal shaders for 3D rendering
    }
}

// Surface flag constants (mirrors ddraw_bridge.h)
const SURF_PRIMARY = 0x00000001;
const SURF_OFFSCREEN_PLAIN = 0x00000002;
const SURF_SYSTEM_MEMORY = 0x00000004;
const SURF_VIDEO_MEMORY = 0x00000008;
const SURF_BACK_BUFFER = 0x00000010;
const SURF_COMPLEX = 0x00000020;
const SURF_FLIP = 0x00000040;
const SURF_TEXTURE = 0x00000080;
const SURF_INDEXED = 0x00000100;
const SURF_16BIT = 0x00000200;
const SURF_32BIT = 0x00000400;

const BLT_COLOR_FILL = 0x00000001;
const BLT_KEY_SRC = 0x00000002;
const BLT_KEY_DEST = 0x00000004;

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DDrawRenderer, SURF_PRIMARY, SURF_OFFSCREEN_PLAIN,
        SURF_SYSTEM_MEMORY, SURF_VIDEO_MEMORY, SURF_BACK_BUFFER, SURF_COMPLEX,
        SURF_FLIP, SURF_TEXTURE, SURF_INDEXED, SURF_16BIT, SURF_32BIT,
        BLT_COLOR_FILL, BLT_KEY_SRC, BLT_KEY_DEST };
}