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
    const D8WG_VERSION_MINOR = 2;
    const D8WG_BATCH_HEADER_BYTES = 32;
    const D8WG_COMMAND_HEADER_BYTES = 16;

    const OP_HELLO = 1;
    const OP_CREATE_DEVICE = 2;
    const OP_RESET = 3;
    const OP_PRESENT = 4;
    const OP_CLEAR = 5;
    const OP_BEGIN_SCENE = 6;
    const OP_END_SCENE = 7;
    const OP_UPDATE_SURFACE = 8;
    const OP_CREATE_BUFFER = 0x100;
    const OP_UPDATE_BUFFER = 0x101;
    const OP_DESTROY_RESOURCE = 0x103;
    const OP_SET_RENDER_STATE = 0x200;
    const OP_SET_TEXTURE_STAGE_STATE = 0x201;
    const OP_SET_STREAM_SOURCE = 0x208;
    const OP_SET_INDICES = 0x209;
    const OP_SET_VERTEX_FORMAT = 0x20A;
    const OP_DRAW_PRIMITIVE = 0x300;
    const OP_DRAW_INDEXED_PRIMITIVE = 0x301;
    const OP_DRAW_PRIMITIVE_UP = 0x302;
    const OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303;

    const RESOURCE_BUFFER_VERTEX = 1;
    const RESOURCE_BUFFER_INDEX = 2;
    const D3DFMT_INDEX16 = 101;
    const D3DFMT_INDEX32 = 102;
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

    const BUFFER_USAGE_COPY_SRC = 0x04;
    const BUFFER_USAGE_COPY_DST = 0x08;
    const BUFFER_USAGE_INDEX = 0x10;
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
        case 6: return {
            topology: "triangle-list",
            vertices: primitiveCount + 2,
            fan: true,
            convertedIndices: primitiveCount * 3,
        };
        default: return null;
        }
    }

    function indexFormatInfo(format) {
        if ((format >>> 0) === D3DFMT_INDEX16) {
            return { webgpu: "uint16", bytes: 2, ArrayType: Uint16Array };
        }
        if ((format >>> 0) === D3DFMT_INDEX32) {
            return { webgpu: "uint32", bytes: 4, ArrayType: Uint32Array };
        }
        return null;
    }

    function checkedDataRange(bytes, offset, byteCount, label) {
        if (offset > bytes.length || byteCount > bytes.length - offset) {
            throw new Error(label + " range is outside its D8WG batch");
        }
        return bytes.subarray(offset, offset + byteCount);
    }

    function padded4(data) {
        if ((data.byteLength & 3) === 0) return data;
        const result = new Uint8Array(align4(data.byteLength));
        result.set(data);
        return result;
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
            indices: { handle: 0, baseVertex: 0 },
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
                indexedDrawCalls: 0,
                upDrawCalls: 0,
                fanConversions: 0,
                uploadBytes: 0,
                transientUploadBytes: 0,
                transientBufferCreations: 0,
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
                displayWidth: width,
                displayHeight: height,
                visible: true,
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

        updateSurface(bytes, payloadOffset, state, reason) {
            const width = u32(bytes, payloadOffset + 16);
            const height = u32(bytes, payloadOffset + 20);
            const visible = width !== 0 && height !== 0;
            const hwnd = u32(bytes, payloadOffset + 4);
            const x = i32(bytes, payloadOffset + 8);
            const y = i32(bytes, payloadOffset + 12);
            const changed = state.surface.hwnd !== hwnd ||
                state.surface.x !== x || state.surface.y !== y ||
                state.surface.visible !== visible ||
                (visible && (state.surface.displayWidth !== width ||
                    state.surface.displayHeight !== height));
            state.surface = {
                ...state.surface,
                hwnd,
                x,
                y,
                displayWidth: visible ? width : state.surface.displayWidth,
                displayHeight: visible ? height : state.surface.displayHeight,
                visible,
            };
            if (changed && typeof this.options.onSurface === "function") {
                this.options.onSurface(state.surface, visible ? reason : "hide");
            }
            return visible;
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
                    transientBuffers: [],
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
            const transientBuffers = this.frame.transientBuffers;
            this.endPass();
            this.device.queue.submit([this.frame.encoder.finish()]);
            this.frame = null;
            if (transientBuffers.length) {
                const destroy = () => {
                    for (const buffer of transientBuffers) buffer.destroy();
                };
                if (typeof this.device.queue.onSubmittedWorkDone === "function") {
                    this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
                } else {
                    destroy();
                }
            }
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
                if (this.frame && this.frame.deviceHandle === handle) {
                    const transientBuffers = this.frame.transientBuffers;
                    this.endPass();
                    this.frame = null;
                    for (const buffer of transientBuffers) buffer.destroy();
                }
                if (state.uniformBuffer) state.uniformBuffer.destroy();
                this.devices.delete(handle);
                if (typeof this.options.onDestroy === "function") {
                    this.options.onDestroy(state.surface, "device");
                }
            }
        }

        pipelineFor(state, topology, stride, indexFormat) {
            const cull = state.renderStates[D3DRS_CULLMODE] >>> 0;
            const blend = state.renderStates[D3DRS_ALPHABLENDENABLE] >>> 0;
            const stripIndexFormat = topology.endsWith("-strip") ?
                indexFormat : undefined;
            const key = [this.format, topology, stripIndexFormat || "none",
                state.fvf >>> 0, stride >>> 0,
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
                    ...(stripIndexFormat ?
                        { stripIndexFormat } : {}),
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

        validateGeometryState(state, stride) {
            if ((state.fvf & D3DFVF_POSITION_MASK) !== D3DFVF_XYZRHW ||
                (state.fvf & D3DFVF_DIFFUSE) === 0 || state.fvf !== MILESTONE_FVF) {
                this.warnOnce("fvf-" + state.fvf,
                    "unsupported FVF in the WebGPU geometry milestone",
                    "0x" + state.fvf.toString(16));
                this.stats.unsupportedCommands++;
                return false;
            }
            if (stride < 20) {
                throw new Error("XYZRHW|DIFFUSE stride is smaller than 20 bytes");
            }
            return true;
        }

        createTransientBuffer(data, usage, label) {
            if (!this.frame) throw new Error("transient buffer created outside a frame");
            const upload = padded4(data);
            const buffer = this.device.createBuffer({
                label,
                size: Math.max(4, upload.byteLength),
                usage: usage | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, upload);
            this.frame.transientBuffers.push(buffer);
            this.stats.transientUploadBytes += data.byteLength;
            this.stats.transientBufferCreations++;
            return buffer;
        }

        sequentialFanIndices(vertexCount) {
            const use32 = vertexCount > 0xFFFF;
            const values = use32 ? new Uint32Array((vertexCount - 2) * 3) :
                new Uint16Array((vertexCount - 2) * 3);
            let output = 0;
            for (let vertex = 1; vertex + 1 < vertexCount; vertex++) {
                values[output++] = 0;
                values[output++] = vertex;
                values[output++] = vertex + 1;
            }
            this.stats.fanConversions++;
            return { data: new Uint8Array(values.buffer),
                format: use32 ? "uint32" : "uint16", count: values.length };
        }

        convertFanIndices(source, formatInfo, indexCount) {
            const values = new formatInfo.ArrayType((indexCount - 2) * 3);
            const view = new DataView(source.buffer, source.byteOffset,
                source.byteLength);
            const read = formatInfo.bytes === 2 ?
                offset => view.getUint16(offset, true) :
                offset => view.getUint32(offset, true);
            const centre = read(0);
            let output = 0;
            for (let index = 1; index + 1 < indexCount; index++) {
                values[output++] = centre;
                values[output++] = read(index * formatInfo.bytes);
                values[output++] = read((index + 1) * formatInfo.bytes);
            }
            this.stats.fanConversions++;
            return { data: new Uint8Array(values.buffer),
                format: formatInfo.webgpu, count: values.length };
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
            const stream = state.streams[0];
            const resource = this.resources.get(stream.handle);
            if (!resource || resource.kind !== RESOURCE_BUFFER_VERTEX) {
                throw new Error("draw references an unknown vertex buffer");
            }
            if (!this.validateGeometryState(state, stream.stride)) return;
            const startVertex = u32(bytes, payloadOffset + 8);
            const availableVertices = Math.floor(resource.byteCount / stream.stride);
            if (startVertex > availableVertices ||
                primitive.vertices > availableVertices - startVertex) {
                throw new Error("draw vertex range exceeds its buffer");
            }
            const pipeline = this.pipelineFor(state, primitive.topology,
                stream.stride);
            if (!pipeline) return;
            const pass = this.ensureFrame(state);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.bindGroupFor(state, pipeline));
            pass.setVertexBuffer(0, resource.gpuBuffer);
            if (primitive.fan) {
                const fan = this.sequentialFanIndices(primitive.vertices);
                const indexBuffer = this.createTransientBuffer(fan.data,
                    BUFFER_USAGE_INDEX, "D3D8 triangle fan indices");
                pass.setIndexBuffer(indexBuffer, fan.format);
                pass.drawIndexed(fan.count, 1, 0, startVertex, 0);
            } else {
                pass.draw(primitive.vertices, 1, startVertex, 0);
            }
            this.stats.drawCalls++;
        }

        drawIndexedPrimitive(bytes, payloadOffset) {
            const state = this.devices.get(u32(bytes, payloadOffset));
            if (!state) throw new Error("indexed draw references an unknown device");
            const primitive = primitiveInfo(u32(bytes, payloadOffset + 4),
                u32(bytes, payloadOffset + 20));
            if (!primitive) throw new Error("invalid indexed primitive topology");
            const stream = state.streams[0];
            const vertexResource = this.resources.get(stream.handle);
            if (!vertexResource || vertexResource.kind !== RESOURCE_BUFFER_VERTEX) {
                throw new Error("indexed draw references an unknown vertex buffer");
            }
            const indexResource = this.resources.get(state.indices.handle);
            if (!indexResource || indexResource.kind !== RESOURCE_BUFFER_INDEX) {
                throw new Error("indexed draw references an unknown index buffer");
            }
            const formatInfo = indexFormatInfo(indexResource.format);
            if (!formatInfo) throw new Error("indexed draw uses an invalid index format");
            if (!this.validateGeometryState(state, stream.stride)) return;
            const startIndex = u32(bytes, payloadOffset + 16);
            const availableIndices = Math.floor(indexResource.byteCount /
                formatInfo.bytes);
            if (startIndex > availableIndices ||
                primitive.vertices > availableIndices - startIndex) {
                throw new Error("indexed draw range exceeds its index buffer");
            }
            const minVertex = u32(bytes, payloadOffset + 8);
            const vertexCount = u32(bytes, payloadOffset + 12);
            const availableVertices = Math.floor(vertexResource.byteCount /
                stream.stride);
            if (state.indices.baseVertex > 0x7FFFFFFF ||
                state.indices.baseVertex + minVertex > availableVertices ||
                vertexCount > availableVertices -
                    (state.indices.baseVertex + minVertex)) {
                throw new Error("indexed draw range exceeds its vertex buffer");
            }
            const pipeline = this.pipelineFor(state, primitive.topology,
                stream.stride, primitive.fan ? undefined : formatInfo.webgpu);
            if (!pipeline) return;
            const pass = this.ensureFrame(state);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.bindGroupFor(state, pipeline));
            pass.setVertexBuffer(0, vertexResource.gpuBuffer);
            if (primitive.fan) {
                const sourceOffset = startIndex * formatInfo.bytes;
                const sourceBytes = primitive.vertices * formatInfo.bytes;
                if (sourceOffset > indexResource.byteCount ||
                    sourceBytes > indexResource.byteCount - sourceOffset) {
                    throw new Error("triangle fan index range exceeds its buffer");
                }
                const fan = this.convertFanIndices(indexResource.shadow.subarray(
                    sourceOffset, sourceOffset + sourceBytes), formatInfo,
                    primitive.vertices);
                const indexBuffer = this.createTransientBuffer(fan.data,
                    BUFFER_USAGE_INDEX, "D3D8 converted indexed fan");
                pass.setIndexBuffer(indexBuffer, fan.format);
                pass.drawIndexed(fan.count, 1, 0, state.indices.baseVertex, 0);
            } else {
                pass.setIndexBuffer(indexResource.gpuBuffer, formatInfo.webgpu);
                pass.drawIndexed(primitive.vertices, 1, startIndex,
                    state.indices.baseVertex, 0);
            }
            this.stats.drawCalls++;
            this.stats.indexedDrawCalls++;
        }

        drawPrimitiveUP(bytes, payloadOffset) {
            const state = this.devices.get(u32(bytes, payloadOffset));
            if (!state) throw new Error("UP draw references an unknown device");
            const primitive = primitiveInfo(u32(bytes, payloadOffset + 4),
                u32(bytes, payloadOffset + 8));
            if (!primitive) throw new Error("invalid UP primitive topology");
            const stride = u32(bytes, payloadOffset + 12);
            const vertexCount = u32(bytes, payloadOffset + 16);
            const vertexBytes = u32(bytes, payloadOffset + 20);
            if (!stride || vertexCount !== primitive.vertices ||
                vertexCount > Math.floor(0xFFFFFFFF / stride) ||
                vertexCount * stride !== vertexBytes) {
                throw new Error("DRAW_PRIMITIVE_UP size metadata mismatch");
            }
            if (!this.validateGeometryState(state, stride)) return;
            const data = checkedDataRange(bytes, u32(bytes, payloadOffset + 24),
                vertexBytes, "DRAW_PRIMITIVE_UP vertex data");
            const pipeline = this.pipelineFor(state, primitive.topology, stride);
            if (!pipeline) return;
            const pass = this.ensureFrame(state);
            const vertexBuffer = this.createTransientBuffer(data,
                BUFFER_USAGE_VERTEX, "D3D8 DrawPrimitiveUP vertices");
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.bindGroupFor(state, pipeline));
            pass.setVertexBuffer(0, vertexBuffer);
            if (primitive.fan) {
                const fan = this.sequentialFanIndices(vertexCount);
                const indexBuffer = this.createTransientBuffer(fan.data,
                    BUFFER_USAGE_INDEX, "D3D8 UP triangle fan indices");
                pass.setIndexBuffer(indexBuffer, fan.format);
                pass.drawIndexed(fan.count, 1, 0, 0, 0);
            } else {
                pass.draw(vertexCount, 1, 0, 0);
            }
            this.stats.drawCalls++;
            this.stats.upDrawCalls++;
            state.streams[0] = { handle: 0, stride: 0 };
        }

        drawIndexedPrimitiveUP(bytes, payloadOffset) {
            const state = this.devices.get(u32(bytes, payloadOffset));
            if (!state) throw new Error("indexed UP draw references an unknown device");
            const primitive = primitiveInfo(u32(bytes, payloadOffset + 4),
                u32(bytes, payloadOffset + 16));
            if (!primitive) throw new Error("invalid indexed UP topology");
            const formatInfo = indexFormatInfo(u32(bytes, payloadOffset + 20));
            if (!formatInfo) throw new Error("invalid indexed UP format");
            const stride = u32(bytes, payloadOffset + 24);
            const indexCount = u32(bytes, payloadOffset + 28);
            const indexBytes = u32(bytes, payloadOffset + 32);
            const vertexBytes = u32(bytes, payloadOffset + 36);
            if (!stride || indexCount !== primitive.vertices ||
                indexCount > Math.floor(0xFFFFFFFF / formatInfo.bytes) ||
                indexCount * formatInfo.bytes !== indexBytes ||
                vertexBytes % stride !== 0) {
                throw new Error("DRAW_INDEXED_PRIMITIVE_UP size metadata mismatch");
            }
            const minVertex = u32(bytes, payloadOffset + 8);
            const vertexCount = u32(bytes, payloadOffset + 12);
            if (minVertex > 0xFFFFFFFF - vertexCount ||
                minVertex + vertexCount > Math.floor(0xFFFFFFFF / stride) ||
                (minVertex + vertexCount) * stride !== vertexBytes) {
                throw new Error("DRAW_INDEXED_PRIMITIVE_UP vertex range mismatch");
            }
            if (!this.validateGeometryState(state, stride)) return;
            let indexData = checkedDataRange(bytes,
                u32(bytes, payloadOffset + 40), indexBytes,
                "DRAW_INDEXED_PRIMITIVE_UP index data");
            const vertexData = checkedDataRange(bytes,
                u32(bytes, payloadOffset + 44), vertexBytes,
                "DRAW_INDEXED_PRIMITIVE_UP vertex data");
            const pipeline = this.pipelineFor(state, primitive.topology, stride,
                primitive.fan ? undefined : formatInfo.webgpu);
            if (!pipeline) return;
            const pass = this.ensureFrame(state);
            const vertexBuffer = this.createTransientBuffer(vertexData,
                BUFFER_USAGE_VERTEX, "D3D8 DrawIndexedPrimitiveUP vertices");
            let drawIndexCount = indexCount;
            let webgpuFormat = formatInfo.webgpu;
            if (primitive.fan) {
                const fan = this.convertFanIndices(indexData, formatInfo, indexCount);
                indexData = fan.data;
                drawIndexCount = fan.count;
                webgpuFormat = fan.format;
            }
            const indexBuffer = this.createTransientBuffer(indexData,
                BUFFER_USAGE_INDEX, "D3D8 DrawIndexedPrimitiveUP indices");
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.bindGroupFor(state, pipeline));
            pass.setVertexBuffer(0, vertexBuffer);
            pass.setIndexBuffer(indexBuffer, webgpuFormat);
            pass.drawIndexed(drawIndexCount, 1, 0, 0, 0);
            this.stats.drawCalls++;
            this.stats.indexedDrawCalls++;
            this.stats.upDrawCalls++;
            state.streams[0] = { handle: 0, stride: 0 };
            state.indices = { handle: 0, baseVertex: 0 };
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
            case OP_UPDATE_SURFACE: {
                if (commandEnd - payloadOffset < 24) {
                    throw new Error("short UPDATE_SURFACE");
                }
                const state = this.devices.get(u32(bytes, payloadOffset));
                if (!state) {
                    throw new Error("UPDATE_SURFACE references an unknown device");
                }
                this.updateSurface(bytes, payloadOffset, state, "move");
                break;
            }
            case OP_PRESENT: {
                if (commandEnd - payloadOffset < 24) throw new Error("short PRESENT");
                const state = this.devices.get(u32(bytes, payloadOffset));
                if (!state) throw new Error("PRESENT references an unknown device");
                this.updateSurface(bytes, payloadOffset, state, "present");
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
                if (kind !== RESOURCE_BUFFER_VERTEX &&
                    kind !== RESOURCE_BUFFER_INDEX) {
                    throw new Error("unknown D8WG buffer kind " + kind);
                }
                const format = u32(bytes, payloadOffset + 20);
                if (kind === RESOURCE_BUFFER_INDEX && !indexFormatInfo(format)) {
                    throw new Error("invalid D8WG index buffer format " + format);
                }
                this.destroyResource(handle);
                this.resources.set(handle, {
                    handle,
                    kind,
                    byteCount,
                    fvf: kind === RESOURCE_BUFFER_VERTEX ? format : 0,
                    format: kind === RESOURCE_BUFFER_INDEX ? format : 0,
                    shadow: new Uint8Array(align4(byteCount)),
                    gpuBuffer: this.device.createBuffer({
                        label: "D3D8 " + (kind === RESOURCE_BUFFER_VERTEX ?
                            "vertex" : "index") + " buffer " + handle.toString(16),
                        size: Math.max(4, align4(byteCount)),
                        usage: (kind === RESOURCE_BUFFER_VERTEX ?
                            BUFFER_USAGE_VERTEX : BUFFER_USAGE_INDEX) |
                            BUFFER_USAGE_COPY_DST,
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
                if (source.byteLength && this.frame) {
                    this.endPass();
                    const staging = this.createTransientBuffer(source,
                        BUFFER_USAGE_COPY_SRC,
                        "D3D8 ordered buffer upload staging");
                    this.frame.encoder.copyBufferToBuffer(staging, 0,
                        resource.gpuBuffer, alignedStart, source.byteLength);
                } else if (source.byteLength) {
                    this.device.queue.writeBuffer(resource.gpuBuffer,
                        alignedStart, source);
                }
                this.stats.uploadBytes += byteCount;
                break;
            }
            case OP_DESTROY_RESOURCE:
                if (commandEnd - payloadOffset < 8) {
                    throw new Error("short DESTROY_RESOURCE");
                }
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
            case OP_SET_INDICES: {
                if (commandEnd - payloadOffset < 16) throw new Error("short SET_INDICES");
                const state = this.devices.get(u32(bytes, payloadOffset));
                if (!state) throw new Error("invalid SET_INDICES device");
                state.indices = {
                    handle: u32(bytes, payloadOffset + 4),
                    baseVertex: u32(bytes, payloadOffset + 8),
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
                if (commandEnd - payloadOffset < 16) throw new Error("short DRAW_PRIMITIVE");
                this.drawPrimitive(bytes, payloadOffset);
                break;
            case OP_DRAW_INDEXED_PRIMITIVE:
                if (commandEnd - payloadOffset < 24) {
                    throw new Error("short DRAW_INDEXED_PRIMITIVE");
                }
                this.drawIndexedPrimitive(bytes, payloadOffset);
                break;
            case OP_DRAW_PRIMITIVE_UP:
                if (commandEnd - payloadOffset < 32) {
                    throw new Error("short DRAW_PRIMITIVE_UP");
                }
                this.drawPrimitiveUP(bytes, payloadOffset);
                break;
            case OP_DRAW_INDEXED_PRIMITIVE_UP:
                if (commandEnd - payloadOffset < 48) {
                    throw new Error("short DRAW_INDEXED_PRIMITIVE_UP");
                }
                this.drawIndexedPrimitiveUP(bytes, payloadOffset);
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
            if (u16(bytes, 6) !== D8WG_VERSION_MINOR) {
                this.stats.malformedBatches++;
                throw new Error("unsupported D8WG minor version " + u16(bytes, 6));
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
            D8WG_VERSION_MINOR,
            D8WG_BATCH_HEADER_BYTES,
            D8WG_COMMAND_HEADER_BYTES,
        };
    }
})(typeof window !== "undefined" ? window : globalThis);
