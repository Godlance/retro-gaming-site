// D8WG high-level Direct3D 8 command executor.
//
// The guest DLL keeps COM objects, shadow state, Lock/Unlock memory and batching
// inside Windows XP. This host owns only WebGPU resources and immutable cache
// objects. It intentionally starts with the Maple-relevant pre-transformed
// vertex path instead of translating through WineD3D/OpenGL/gl4es.

(function(global) {
    "use strict";

    const D8WG_MAGIC = 0x47573844; // "D8WG"
    const D8WG_VERSION_MAJOR = 1;
    const D8WG_BATCH_HEADER_BYTES = 32;
    const D8WG_COMMAND_HEADER_BYTES = 16;

    const OP_HELLO = 1;
    const OP_CREATE_DEVICE = 2;
    const OP_RESET = 3;
    const OP_PRESENT = 4;
    const OP_CLEAR = 5;
    const OP_BEGIN_SCENE = 6;
    const OP_END_SCENE = 7;
    const OP_CREATE_BUFFER = 0x100;
    const OP_UPDATE_BUFFER = 0x101;
    const OP_DESTROY_RESOURCE = 0x103;
    const OP_SET_RENDER_STATE = 0x200;
    const OP_SET_TEXTURE_STAGE_STATE = 0x201;
    const OP_SET_STREAM_SOURCE = 0x208;
    const OP_SET_VERTEX_FORMAT = 0x20A;
    const OP_DRAW_PRIMITIVE = 0x300;

    const RESOURCE_BUFFER_VERTEX = 1;
    const D3DCLEAR_TARGET = 0x1;
    const D3DFVF_POSITION_MASK = 0x00E;
    const D3DFVF_XYZRHW = 0x004;
    const D3DFVF_DIFFUSE = 0x040;
    const MILESTONE_FVF = D3DFVF_XYZRHW | D3DFVF_DIFFUSE;

    const D3DRS_SRCBLEND = 19;
    const D3DRS_DESTBLEND = 20;
    const D3DRS_CULLMODE = 22;
    const D3DRS_ALPHABLENDENABLE = 27;
    const D3DCULL_NONE = 1;
    const D3DCULL_CCW = 3;

    const BUFFER_USAGE_COPY_DST = 0x08;
    const BUFFER_USAGE_VERTEX = 0x20;
    const BUFFER_USAGE_UNIFORM = 0x40;

    function u16(bytes, offset) {
        return bytes[offset] | bytes[offset + 1] << 8;
    }

    function u32(bytes, offset) {
        return (bytes[offset] | bytes[offset + 1] << 8 |
            bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
    }

    function i32(bytes, offset) {
        return u32(bytes, offset) | 0;
    }

    function f32(bytes, offset) {
        return new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
            .getFloat32(0, true);
    }

    function align4(value) {
        return (value + 3) & ~3;
    }

    function d3dColor(value) {
        return {
            r: ((value >>> 16) & 0xFF) / 255,
            g: ((value >>> 8) & 0xFF) / 255,
            b: (value & 0xFF) / 255,
            a: ((value >>> 24) & 0xFF) / 255,
        };
    }

    function primitiveInfo(type, primitiveCount) {
        switch (type >>> 0) {
        case 1: return { topology: "point-list", vertices: primitiveCount };
        case 2: return { topology: "line-list", vertices: primitiveCount * 2 };
        case 3: return { topology: "line-strip", vertices: primitiveCount + 1 };
        case 4: return { topology: "triangle-list", vertices: primitiveCount * 3 };
        case 5: return { topology: "triangle-strip", vertices: primitiveCount + 2 };
        // WebGPU has no triangle-fan topology. A later milestone converts it
        // into a generated index buffer instead of reporting false success.
        case 6: return null;
        default: return null;
        }
    }

    function freshDeviceState(handle, surface) {
        const renderStates = new Uint32Array(256);
        const textureStageStates = Array.from({ length: 8 },
            () => new Uint32Array(32));
        renderStates[7] = 1; // D3DRS_ZENABLE = D3DZB_TRUE
        renderStates[14] = 1; // D3DRS_ZWRITEENABLE
        renderStates[D3DRS_CULLMODE] = D3DCULL_CCW;
        renderStates[137] = 1; // D3DRS_LIGHTING
        renderStates[9] = 2; // D3DRS_SHADEMODE = GOURAUD
        textureStageStates[0][1] = 4; // COLOROP = MODULATE
        textureStageStates[0][2] = 2; // COLORARG1 = TEXTURE
        textureStageStates[0][3] = 1; // COLORARG2 = CURRENT
        textureStageStates[0][4] = 2; // ALPHAOP = SELECTARG1
        textureStageStates[0][5] = 2; // ALPHAARG1 = TEXTURE
        for (let stage = 1; stage < 8; stage++) {
            textureStageStates[stage][1] = 1; // DISABLE
            textureStageStates[stage][4] = 1;
        }
        return {
            handle,
            surface,
            renderStates,
            textureStageStates,
            streams: Array.from({ length: 16 }, () => ({ handle: 0, stride: 0 })),
            fvf: 0,
            inScene: false,
            uniformBuffer: null,
            bindGroups: new Map(),
        };
    }

    const FIXED_XYZRHW_DIFFUSE_WGSL = `
struct SurfaceUniforms {
    size: vec2<f32>,
    inverse_size: vec2<f32>,
};

@group(0) @binding(0) var<uniform> surface: SurfaceUniforms;

struct VSInput {
    @location(0) position: vec4<f32>,
    @location(1) color_bgra: vec4<f32>,
};

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VSInput) -> VSOutput {
    var output: VSOutput;
    // D3D8 XYZRHW uses screen-space pixel centres and a [0, 1] depth range.
    let pixel = input.position.xy - vec2<f32>(0.5, 0.5);
    output.position = vec4<f32>(
        pixel.x * surface.inverse_size.x * 2.0 - 1.0,
        1.0 - pixel.y * surface.inverse_size.y * 2.0,
        clamp(input.position.z, 0.0, 1.0),
        1.0
    );
    // D3DCOLOR is AARRGGBB as a DWORD, hence BGRA bytes in little endian.
    output.color = input.color_bgra.bgra;
    return output;
}

@fragment
fn fs_main(input: VSOutput) -> @location(0) vec4<f32> {
    return input.color;
}
`;

    class D3D8WebGPUExecutor {
        constructor(canvas, options) {
            if (!canvas) {
                throw new Error("D3D8 WebGPU canvas is required");
            }
            this.canvas = canvas;
            this.options = options || {};
            this.gpu = this.options.gpu ||
                (global.navigator && global.navigator.gpu);
            this.adapter = this.options.adapter || null;
            this.device = this.options.device || null;
            this.context = this.options.context || null;
            this.format = this.options.format || null;
            this.devices = new Map();
            this.resources = new Map();
            this.pipelineCache = new Map();
            this.shaderModule = null;
            this.frame = null;
            this.readyPromise = null;
            this.work = Promise.resolve();
            this.failed = null;
            this.warned = new Set();
            this.stats = {
                batches: 0,
                commands: 0,
                presents: 0,
                drawCalls: 0,
                uploadBytes: 0,
                pipelineCreations: 0,
                malformedBatches: 0,
                unsupportedCommands: 0,
            };
        }

        warnOnce(key, message, details) {
            if (this.warned.has(key)) return;
            this.warned.add(key);
            console.warn("[d3d8-webgpu] " + message, details || "");
        }

        initialize() {
            if (this.readyPromise) return this.readyPromise;
            this.readyPromise = (async () => {
                if (!this.device) {
                    if (!this.gpu || typeof this.gpu.requestAdapter !== "function") {
                        throw new Error("WebGPU is unavailable");
                    }
                    this.adapter = this.adapter || await this.gpu.requestAdapter({
                        powerPreference: "high-performance",
                    });
                    if (!this.adapter) throw new Error("WebGPU adapter request failed");
                    this.device = await this.adapter.requestDevice();
                }
                this.context = this.context || this.canvas.getContext("webgpu");
                if (!this.context) throw new Error("could not acquire a WebGPU canvas context");
                this.format = this.format || (this.gpu &&
                    typeof this.gpu.getPreferredCanvasFormat === "function" ?
                    this.gpu.getPreferredCanvasFormat() : "bgra8unorm");
                this.configureContext();
                this.shaderModule = this.device.createShaderModule({
                    label: "D3D8 XYZRHW diffuse",
                    code: FIXED_XYZRHW_DIFFUSE_WGSL,
                });
                if (this.device.lost && typeof this.device.lost.then === "function") {
                    this.device.lost.then(info => {
                        this.failed = new Error("WebGPU device lost: " +
                            (info && info.message || "unknown reason"));
                        console.error("[d3d8-webgpu] device lost", info);
                    });
                }
                return this;
            })().catch(error => {
                this.failed = error;
                console.error("[d3d8-webgpu] initialization failed", error);
                throw error;
            });
            return this.readyPromise;
        }

        configureContext() {
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: "opaque",
            });
        }

        submit(bytes, metadata) {
            const owned = bytes instanceof Uint8Array ? bytes.slice() :
                new Uint8Array(bytes || []);
            this.work = this.work.then(() => this.initialize())
                .then(() => this.executeBatch(owned, metadata || {}))
                .catch(error => {
                    this.failed = error;
                    console.error("[d3d8-webgpu] batch failed", error, metadata || {});
                });
            return this.work;
        }

        idle() {
            return this.work;
        }

        parseSurface(bytes, offset) {
            const width = Math.max(1, u32(bytes, offset + 16));
            const height = Math.max(1, u32(bytes, offset + 20));
            return {
                hwnd: u32(bytes, offset + 4),
                x: i32(bytes, offset + 8),
                y: i32(bytes, offset + 12),
                width,
                height,
                format: u32(bytes, offset + 24),
                windowed: !!u32(bytes, offset + 28),
                behaviorFlags: u32(bytes, offset + 32),
            };
        }

        createSurfaceUniform(state) {
            if (state.uniformBuffer) state.uniformBuffer.destroy();
            state.uniformBuffer = this.device.createBuffer({
                label: "D3D8 surface uniforms " + state.handle.toString(16),
                size: 16,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.updateSurfaceUniform(state);
            state.bindGroups.clear();
        }

        updateSurfaceUniform(state) {
            const width = Math.max(1, state.surface.width);
            const height = Math.max(1, state.surface.height);
            this.device.queue.writeBuffer(state.uniformBuffer, 0,
                new Float32Array([width, height, 1 / width, 1 / height]));
        }

        createOrResetDevice(bytes, payloadOffset, reset) {
            const handle = u32(bytes, payloadOffset);
            const surface = this.parseSurface(bytes, payloadOffset);
            let state = this.devices.get(handle);
            if (!state || !reset) {
                if (state && state.uniformBuffer) state.uniformBuffer.destroy();
                state = freshDeviceState(handle, surface);
                this.devices.set(handle, state);
            } else {
                state.surface = surface;
                state.inScene = false;
            }
            this.canvas.width = surface.width;
            this.canvas.height = surface.height;
            this.configureContext();
            this.createSurfaceUniform(state);
            if (typeof this.options.onSurface === "function") {
                this.options.onSurface(surface, reset ? "reset" : "create");
            }
        }

        endPass() {
            if (this.frame && this.frame.pass) {
                this.frame.pass.end();
                this.frame.pass = null;
            }
        }

        ensureFrame(state, clearValue) {
            if (this.frame && this.frame.deviceHandle !== state.handle) {
                this.finishFrame(false);
            }
            if (!this.frame) {
                const encoder = this.device.createCommandEncoder({
                    label: "D3D8 frame",
                });
                const view = this.context.getCurrentTexture().createView();
                this.frame = {
                    deviceHandle: state.handle,
                    state,
                    encoder,
                    view,
                    pass: null,
                    fresh: true,
                };
            }
            if (clearValue !== undefined) {
                this.endPass();
            }
            if (!this.frame.pass) {
                const shouldClear = clearValue !== undefined || this.frame.fresh;
                this.frame.pass = this.frame.encoder.beginRenderPass({
                    label: "D3D8 color pass",
                    colorAttachments: [{
                        view: this.frame.view,
                        clearValue: clearValue || { r: 0, g: 0, b: 0, a: 1 },
                        loadOp: shouldClear ? "clear" : "load",
                        storeOp: "store",
                    }],
                });
                this.frame.fresh = false;
            }
            return this.frame.pass;
        }

        finishFrame(notify) {
            if (!this.frame) return false;
            const state = this.frame.state;
            this.endPass();
            this.device.queue.submit([this.frame.encoder.finish()]);
            this.frame = null;
            if (notify) {
                this.stats.presents++;
                if (typeof this.options.onPresent === "function") {
                    this.options.onPresent(state.surface, this.getStats());
                }
            }
            return true;
        }

        destroyResource(handle) {
            const resource = this.resources.get(handle);
            if (resource) {
                if (resource.gpuBuffer) resource.gpuBuffer.destroy();
                this.resources.delete(handle);
            }
            const state = this.devices.get(handle);
            if (state) {
                if (state.uniformBuffer) state.uniformBuffer.destroy();
                this.devices.delete(handle);
            }
        }

        pipelineFor(state, topology, stride) {
            const cull = state.renderStates[D3DRS_CULLMODE] >>> 0;
            const blend = state.renderStates[D3DRS_ALPHABLENDENABLE] >>> 0;
            const key = [this.format, topology, state.fvf >>> 0, stride >>> 0,
                cull, blend,
                state.renderStates[D3DRS_SRCBLEND] >>> 0,
                state.renderStates[D3DRS_DESTBLEND] >>> 0].join(":");
            let pipeline = this.pipelineCache.get(key);
            if (pipeline) return pipeline;
            if (blend) {
                this.warnOnce("blend-" + key,
                    "alpha blending is not in the first WebGPU milestone");
                return null;
            }
            pipeline = this.device.createRenderPipeline({
                label: "D3D8 fixed pipeline " + key,
                layout: "auto",
                vertex: {
                    module: this.shaderModule,
                    entryPoint: "vs_main",
                    buffers: [{
                        arrayStride: stride,
                        stepMode: "vertex",
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x4" },
                            { shaderLocation: 1, offset: 16, format: "unorm8x4" },
                        ],
                    }],
                },
                fragment: {
                    module: this.shaderModule,
                    entryPoint: "fs_main",
                    targets: [{ format: this.format }],
                },
                primitive: {
                    topology,
                    cullMode: cull === D3DCULL_NONE ? "none" : "back",
                    // The screen-space Y conversion flips winding.
                    frontFace: cull === D3DCULL_CCW ? "cw" : "ccw",
                },
            });
            this.pipelineCache.set(key, pipeline);
            this.stats.pipelineCreations++;
            return pipeline;
        }

        bindGroupFor(state, pipeline) {
            let group = state.bindGroups.get(pipeline);
            if (group) return group;
            group = this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: state.uniformBuffer } }],
            });
            state.bindGroups.set(pipeline, group);
            return group;
        }

        drawPrimitive(bytes, payloadOffset) {
            const state = this.devices.get(u32(bytes, payloadOffset));
            if (!state) throw new Error("draw references an unknown D3D8 device");
            const primitive = primitiveInfo(u32(bytes, payloadOffset + 4),
                u32(bytes, payloadOffset + 12));
            if (!primitive) {
                this.warnOnce("primitive-" + u32(bytes, payloadOffset + 4),
                    "unsupported primitive topology", u32(bytes, payloadOffset + 4));
                this.stats.unsupportedCommands++;
                return;
            }
            if ((state.fvf & D3DFVF_POSITION_MASK) !== D3DFVF_XYZRHW ||
                (state.fvf & D3DFVF_DIFFUSE) === 0 || state.fvf !== MILESTONE_FVF) {
                this.warnOnce("fvf-" + state.fvf,
                    "unsupported FVF in first WebGPU milestone",
                    "0x" + state.fvf.toString(16));
                this.stats.unsupportedCommands++;
                return;
            }
            const stream = state.streams[0];
            const resource = this.resources.get(stream.handle);
            if (!resource || resource.kind !== RESOURCE_BUFFER_VERTEX) {
                throw new Error("draw references an unknown vertex buffer");
            }
            if (stream.stride < 20) {
                throw new Error("XYZRHW|DIFFUSE stride is smaller than 20 bytes");
            }
            const pipeline = this.pipelineFor(state, primitive.topology, stream.stride);
            if (!pipeline) return;
            const pass = this.ensureFrame(state);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.bindGroupFor(state, pipeline));
            pass.setVertexBuffer(0, resource.gpuBuffer);
            pass.draw(primitive.vertices, 1, u32(bytes, payloadOffset + 8), 0);
            this.stats.drawCalls++;
        }

        executeCommand(bytes, commandOffset, opcode, payloadOffset,
                commandEnd) {
            switch (opcode) {
            case OP_HELLO:
                if (u32(bytes, payloadOffset) !== 32) {
                    throw new Error("only a 32-bit D8WG guest is supported");
                }
                break;
            case OP_CREATE_DEVICE:
                if (commandEnd - payloadOffset < 36) throw new Error("short CREATE_DEVICE");
                this.createOrResetDevice(bytes, payloadOffset, false);
                break;
            case OP_RESET:
                if (commandEnd - payloadOffset < 36) throw new Error("short RESET");
                this.createOrResetDevice(bytes, payloadOffset, true);
                break;
            case OP_PRESENT: {
                const state = this.devices.get(u32(bytes, payloadOffset));
                if (!state) throw new Error("PRESENT references an unknown device");
                this.ensureFrame(state);
                this.finishFrame(true);
                break;
            }
            case OP_CLEAR: {
                if (commandEnd - payloadOffset < 24) throw new Error("short CLEAR");
                const state = this.devices.get(u32(bytes, payloadOffset));
                if (!state) throw new Error("CLEAR references an unknown device");
                const flags = u32(bytes, payloadOffset + 4);
                const rectCount = u32(bytes, payloadOffset + 20);
                if (rectCount) {
                    this.warnOnce("clear-rects",
                        "rectangular Clear currently falls back to a full-target clear",
                        { rectCount });
                }
                if (flags & D3DCLEAR_TARGET) {
                    this.ensureFrame(state, d3dColor(u32(bytes, payloadOffset + 8)));
                } else {
                    this.warnOnce("depth-clear",
                        "depth/stencil-only Clear is not in the first WebGPU milestone",
                        { depth: f32(bytes, payloadOffset + 12),
                          stencil: u32(bytes, payloadOffset + 16) });
                }
                break;
            }
            case OP_BEGIN_SCENE:
            case OP_END_SCENE: {
                const state = this.devices.get(u32(bytes, payloadOffset));
                if (!state) throw new Error("scene command references an unknown device");
                state.inScene = opcode === OP_BEGIN_SCENE;
                break;
            }
            case OP_CREATE_BUFFER: {
                if (commandEnd - payloadOffset < 32) throw new Error("short CREATE_BUFFER");
                const handle = u32(bytes, payloadOffset + 4);
                const kind = u32(bytes, payloadOffset + 8);
                const byteCount = u32(bytes, payloadOffset + 12);
                if (kind !== RESOURCE_BUFFER_VERTEX) {
                    throw new Error("unknown D8WG buffer kind " + kind);
                }
                this.destroyResource(handle);
                this.resources.set(handle, {
                    handle,
                    kind,
                    byteCount,
                    fvf: u32(bytes, payloadOffset + 20),
                    shadow: new Uint8Array(align4(byteCount)),
                    gpuBuffer: this.device.createBuffer({
                        label: "D3D8 vertex buffer " + handle.toString(16),
                        size: Math.max(4, align4(byteCount)),
                        usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
                    }),
                });
                break;
            }
            case OP_UPDATE_BUFFER: {
                if (commandEnd - payloadOffset < 16) throw new Error("short UPDATE_BUFFER");
                const resource = this.resources.get(u32(bytes, payloadOffset));
                if (!resource) throw new Error("UPDATE_BUFFER references an unknown resource");
                const destination = u32(bytes, payloadOffset + 4);
                const byteCount = u32(bytes, payloadOffset + 8);
                const dataOffset = u32(bytes, payloadOffset + 12);
                if (dataOffset > bytes.length || byteCount > bytes.length - dataOffset ||
                    destination > resource.byteCount ||
                    byteCount > resource.byteCount - destination) {
                    throw new Error("UPDATE_BUFFER range is outside its batch/resource");
                }
                resource.shadow.set(
                    bytes.subarray(dataOffset, dataOffset + byteCount), destination);
                const alignedStart = destination & ~3;
                const alignedEnd = align4(destination + byteCount);
                const source = resource.shadow.subarray(alignedStart, alignedEnd);
                this.device.queue.writeBuffer(resource.gpuBuffer,
                    alignedStart, source);
                this.stats.uploadBytes += byteCount;
                break;
            }
            case OP_DESTROY_RESOURCE:
                this.destroyResource(u32(bytes, payloadOffset));
                break;
            case OP_SET_RENDER_STATE: {
                const state = this.devices.get(u32(bytes, payloadOffset));
                const index = u32(bytes, payloadOffset + 4);
                if (!state || index >= state.renderStates.length) {
                    throw new Error("invalid SET_RENDER_STATE");
                }
                state.renderStates[index] = u32(bytes, payloadOffset + 8);
                break;
            }
            case OP_SET_TEXTURE_STAGE_STATE: {
                const state = this.devices.get(u32(bytes, payloadOffset));
                const stage = u32(bytes, payloadOffset + 4);
                const index = u32(bytes, payloadOffset + 8);
                if (!state || stage >= 8 || index >= 32) {
                    throw new Error("invalid SET_TEXTURE_STAGE_STATE");
                }
                state.textureStageStates[stage][index] = u32(bytes, payloadOffset + 12);
                break;
            }
            case OP_SET_STREAM_SOURCE: {
                const state = this.devices.get(u32(bytes, payloadOffset));
                const stream = u32(bytes, payloadOffset + 4);
                if (!state || stream >= state.streams.length) {
                    throw new Error("invalid SET_STREAM_SOURCE");
                }
                state.streams[stream] = {
                    handle: u32(bytes, payloadOffset + 8),
                    stride: u32(bytes, payloadOffset + 12),
                };
                break;
            }
            case OP_SET_VERTEX_FORMAT: {
                const state = this.devices.get(u32(bytes, payloadOffset));
                if (!state) throw new Error("invalid SET_VERTEX_FORMAT");
                state.fvf = u32(bytes, payloadOffset + 4);
                break;
            }
            case OP_DRAW_PRIMITIVE:
                this.drawPrimitive(bytes, payloadOffset);
                break;
            default:
                this.warnOnce("opcode-" + opcode,
                    "unsupported D8WG opcode", "0x" + opcode.toString(16));
                this.stats.unsupportedCommands++;
                break;
            }
            void commandOffset;
        }

        executeBatch(bytes, metadata) {
            if (bytes.length < D8WG_BATCH_HEADER_BYTES) {
                this.stats.malformedBatches++;
                throw new Error("D8WG batch header is truncated");
            }
            if (u32(bytes, 0) !== D8WG_MAGIC) {
                this.stats.malformedBatches++;
                throw new Error("D8WG magic mismatch");
            }
            if (u16(bytes, 4) !== D8WG_VERSION_MAJOR) {
                this.stats.malformedBatches++;
                throw new Error("unsupported D8WG major version " + u16(bytes, 4));
            }
            const expectedCount = u32(bytes, 16);
            const commandBytes = u32(bytes, 20);
            if (commandBytes > bytes.length - D8WG_BATCH_HEADER_BYTES) {
                this.stats.malformedBatches++;
                throw new Error("D8WG command region is truncated");
            }
            const end = D8WG_BATCH_HEADER_BYTES + commandBytes;
            let offset = D8WG_BATCH_HEADER_BYTES;
            let decoded = 0;
            while (offset < end) {
                if (end - offset < D8WG_COMMAND_HEADER_BYTES) {
                    throw new Error("D8WG command header is truncated");
                }
                const opcode = u16(bytes, offset);
                const size = u32(bytes, offset + 4);
                if (size < D8WG_COMMAND_HEADER_BYTES || (size & 7) || size > end - offset) {
                    throw new Error("invalid D8WG command size " + size);
                }
                this.executeCommand(bytes, offset, opcode,
                    offset + D8WG_COMMAND_HEADER_BYTES, offset + size);
                offset += size;
                decoded++;
            }
            if (decoded !== expectedCount) {
                throw new Error("D8WG command count mismatch: expected " +
                    expectedCount + ", decoded " + decoded);
            }
            this.stats.batches++;
            this.stats.commands += decoded;
            if (this.options.trace) {
                console.info("[d3d8-webgpu] batch", {
                    frameId: u32(bytes, 8),
                    flags: u32(bytes, 12),
                    commandCount: decoded,
                    commandBytes,
                    pci: metadata,
                });
            }
            return decoded;
        }

        getStats() {
            return { ...this.stats, pipelinesCached: this.pipelineCache.size };
        }
    }

    global.D3D8WebGPUExecutor = D3D8WebGPUExecutor;
    global.installD3D8WebGPUExecutor = function(canvas, options) {
        return new D3D8WebGPUExecutor(canvas, options);
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            D3D8WebGPUExecutor,
            D8WG_MAGIC,
            D8WG_VERSION_MAJOR,
            D8WG_BATCH_HEADER_BYTES,
            D8WG_COMMAND_HEADER_BYTES,
        };
    }
})(typeof window !== "undefined" ? window : globalThis);
