// D9WG high-level Direct3D 9 command executor -- M1 skeleton.
//
// The guest DLL (glbridge/d3d9proxy/d3d9_proxy.c) keeps COM objects, shadow
// state, Lock/Unlock memory and batching inside Windows XP. This host owns
// only WebGPU resources and immutable cache objects, mirroring the D3D8
// path's division of responsibility (see ../d3d8-webgpu/d3d8_executor.js)
// but as an independent protocol/implementation: D9WG has its own opcode
// numbering, resource handle namespace and payload shapes (d3d9_protocol.h).
//
// M1 scope: batch decode, a resource table for vertex/index buffers, 2D
// textures and vertex declarations, WebGPU device lifecycle, and the
// fixed-function XYZ/XYZRHW draw path with no programmable shaders. Every
// other D9WG opcode already has a number reserved in d3d9_protocol.h for a
// later milestone, but the guest never emits it yet in M1, so this executor
// does not need a handler for it -- unknown/future opcodes are skipped by
// their `size` field (see decodeCommand) rather than treated as an error,
// matching the parser-safety rule in the implementation plan's section 6.8.
//
// This skeleton deliberately does not yet have the D3D8 path's per-process
// session isolation (multiple concurrent XP sessions with colliding numeric
// handles). It tracks one flat device/resource table, which is sufficient
// for a single running game under v86 but should grow session isolation
// before this path is trusted the way the D3D8 executor now is.

(function(global) {
    "use strict";

    const D9WG_MAGIC = 0x47573944; // "D9WG"
    const D9WG_VERSION_MAJOR = 1;
    const D9WG_VERSION_MINOR = 0;
    const D9WG_BATCH_HEADER_BYTES = 32;
    const D9WG_COMMAND_HEADER_BYTES = 16;
    const D9WG_BATCH_FLAG_PRESENT = 1 << 0;

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
    const OP_CREATE_TEXTURE_2D = 0x110;
    const OP_UPDATE_TEXTURE = 0x113;
    const OP_CREATE_VERTEX_DECLARATION = 0x120;
    const OP_SET_RENDER_STATE = 0x200;
    const OP_SET_SAMPLER_STATE = 0x201;
    const OP_SET_TEXTURE_STAGE_STATE = 0x202;
    const OP_SET_TEXTURE = 0x203;
    const OP_SET_VIEWPORT = 0x204;
    const OP_SET_TRANSFORM = 0x206;
    const OP_SET_MATERIAL = 0x207;
    const OP_SET_LIGHT = 0x208;
    const OP_LIGHT_ENABLE = 0x209;
    const OP_SET_STREAM_SOURCE = 0x20A;
    const OP_SET_INDICES = 0x20C;
    const OP_SET_VERTEX_DECLARATION = 0x20D;
    const OP_SET_FVF = 0x20E;
    const OP_DRAW_PRIMITIVE = 0x300;
    const OP_DRAW_INDEXED_PRIMITIVE = 0x301;
    const OP_DRAW_PRIMITIVE_UP = 0x302;
    const OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303;

    const RESOURCE_BUFFER_VERTEX = 1;
    const RESOURCE_BUFFER_INDEX = 2;
    const RESOURCE_TEXTURE_2D = 3;
    const RESOURCE_VERTEX_DECLARATION = 6;

    const D3DFMT_A8R8G8B8 = 21;
    const D3DFMT_X8R8G8B8 = 22;
    const D3DFMT_R5G6B5 = 23;
    const D3DFMT_X1R5G5B5 = 24;
    const D3DFMT_A1R5G5B5 = 25;
    const D3DFMT_A4R4G4B4 = 26;
    const D3DFMT_A8 = 28;
    const D3DFMT_L8 = 50;
    const D3DFMT_DXT1 = 0x31545844;
    const D3DFMT_DXT3 = 0x33545844;
    const D3DFMT_DXT5 = 0x35545844;
    const D3DFMT_INDEX16 = 101;
    const D3DFMT_INDEX32 = 102;

    const D3DCLEAR_TARGET = 0x1;
    const D3DCLEAR_ZBUFFER = 0x2;
    const D3DCLEAR_STENCIL = 0x4;

    // D3DRENDERSTATETYPE values the M1 fixed-function pipeline now honours.
    // Everything else the guest sends is still recorded in the device's
    // renderStates map but has no effect yet.
    const D3DRS_ZENABLE = 7;
    const D3DRS_ZWRITEENABLE = 14;
    const D3DRS_ALPHATESTENABLE = 15;
    const D3DRS_SRCBLEND = 19;
    const D3DRS_DESTBLEND = 20;
    const D3DRS_CULLMODE = 22;
    const D3DRS_ZFUNC = 23;
    const D3DRS_ALPHABLENDENABLE = 27;
    const D3DRS_COLORWRITEENABLE = 168;
    const D3DRS_BLENDOP = 171;

    const D3DZB_FALSE = 0;
    const D3DCULL_NONE = 1;
    const D3DCULL_CW = 2;
    const D3DCULL_CCW = 3;

    // D3DCMPFUNC -> GPUCompareFunction
    const COMPARE_FUNCS = [
        undefined, "never", "less", "equal", "less-equal",
        "greater", "not-equal", "greater-equal", "always",
    ];

    // D3DBLEND -> GPUBlendFactor. D3D9 numbers these from 1; the entries left
    // undefined are the ones WebGPU has no direct equivalent for
    // (BOTHSRCALPHA/BOTHINVSRCALPHA are legacy two-sided factors, and the
    // BLENDFACTOR pair needs a pipeline-level constant we do not plumb yet).
    const BLEND_FACTORS = [
        undefined,
        "zero",                 // D3DBLEND_ZERO = 1
        "one",                  // D3DBLEND_ONE
        "src",                  // D3DBLEND_SRCCOLOR
        "one-minus-src",        // D3DBLEND_INVSRCCOLOR
        "src-alpha",            // D3DBLEND_SRCALPHA
        "one-minus-src-alpha",  // D3DBLEND_INVSRCALPHA
        "dst-alpha",            // D3DBLEND_DESTALPHA
        "one-minus-dst-alpha",  // D3DBLEND_INVDESTALPHA
        "dst",                  // D3DBLEND_DESTCOLOR
        "one-minus-dst",        // D3DBLEND_INVDESTCOLOR
        "src-alpha-saturated",  // D3DBLEND_SRCALPHASAT
    ];

    // D3DBLENDOP -> GPUBlendOperation
    const BLEND_OPS = [
        undefined, "add", "subtract", "reverse-subtract", "min", "max",
    ];

    // WebGPU's depth format for the auto depth-stencil surface. D3D9 apps ask
    // for D16/D24S8/D24X8/etc; all of them are satisfied with one real
    // depth24plus-stencil8 target rather than trying to match bit layouts the
    // guest can never observe (it cannot read the depth buffer back in M1).
    const DEPTH_FORMAT = "depth24plus-stencil8";
    const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

    // D3DDECLUSAGE / D3DDECLTYPE, only the M1-supported subset (see
    // d3d9_proxy.c's declaration_element_supported()).
    const DECLUSAGE_POSITION = 0;
    const DECLUSAGE_NORMAL = 3;
    const DECLUSAGE_PSIZE = 4;
    const DECLUSAGE_TEXCOORD = 5;
    const DECLUSAGE_POSITIONT = 9;
    const DECLUSAGE_COLOR = 10;
    const DECLTYPE_FLOAT1 = 0;
    const DECLTYPE_FLOAT2 = 1;
    const DECLTYPE_FLOAT3 = 2;
    const DECLTYPE_FLOAT4 = 3;
    const DECLTYPE_D3DCOLOR = 4;

    const D3DTS_VIEW = 2;
    const D3DTS_PROJECTION = 3;
    const D3DTS_WORLD = 256;

    // D3DPRIMITIVETYPE -> WebGPU topology, and element-count helpers mirror
    // d3d9_proxy.c's primitive_element_count() so guest/host agree on how
    // many vertices/indices a given primitive_count consumes. Only list/strip
    // forms map onto a single WebGPU draw call directly; FAN is converted to
    // a triangle list index buffer on upload, same discipline as the D3D8
    // path.
    const D3DPT_POINTLIST = 1;
    const D3DPT_LINELIST = 2;
    const D3DPT_LINESTRIP = 3;
    const D3DPT_TRIANGLELIST = 4;
    const D3DPT_TRIANGLESTRIP = 5;
    const D3DPT_TRIANGLEFAN = 6;

    const BUFFER_USAGE_VERTEX = 0x20;
    const BUFFER_USAGE_INDEX = 0x10;
    const BUFFER_USAGE_UNIFORM = 0x40;
    const BUFFER_USAGE_COPY_SRC = 0x4;
    const BUFFER_USAGE_COPY_DST = 0x8;
    const TEXTURE_USAGE_COPY_DST = 0x2;
    const SHADER_STAGE_VERTEX = 0x1;
    const SHADER_STAGE_FRAGMENT = 0x2;
    const TEXTURE_USAGE_TEXTURE_BINDING = 0x4;

    function alignUp(value, alignment) {
        return (value + alignment - 1) & ~(alignment - 1);
    }

    function formatToGPU(format) {
        switch (format) {
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_R5G6B5:
        case D3DFMT_L8:
        case D3DFMT_A8:
            // All of these are CPU-expanded to tightly-packed RGBA8 on
            // upload (see expandTexelsToRGBA8), matching the D3D8 path's
            // approach: WebGPU has no native 16-bit BGR/BGRA formats.
            return "rgba8unorm";
        case D3DFMT_DXT1:
            return "bc1-rgba-unorm";
        case D3DFMT_DXT3:
            return "bc2-rgba-unorm";
        case D3DFMT_DXT5:
            return "bc3-rgba-unorm";
        default:
            return null;
        }
    }

    // Expands one source row of `count` texels at `format` into RGBA8,
    // matching d3d9_proxy.c's texture_format_layout() block sizes (DXT
    // formats are passed through untouched -- WebGPU accepts BCn blocks
    // directly).
    function expandRowToRGBA8(format, source, sourceOffset, count, dest, destOffset) {
        for (let i = 0; i < count; ++i) {
            let r, g, b, a;
            switch (format) {
            case D3DFMT_A8R8G8B8:
            case D3DFMT_X8R8G8B8: {
                const value = source[sourceOffset + i * 4] |
                    (source[sourceOffset + i * 4 + 1] << 8) |
                    (source[sourceOffset + i * 4 + 2] << 16) |
                    (source[sourceOffset + i * 4 + 3] << 24);
                b = value & 0xff; g = (value >>> 8) & 0xff;
                r = (value >>> 16) & 0xff;
                a = format === D3DFMT_A8R8G8B8 ? (value >>> 24) & 0xff : 0xff;
                break;
            }
            case D3DFMT_R5G6B5: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 11) & 0x1f) * 255 / 31;
                g = ((value >>> 5) & 0x3f) * 255 / 63;
                b = (value & 0x1f) * 255 / 31;
                a = 0xff;
                break;
            }
            case D3DFMT_X1R5G5B5:
            case D3DFMT_A1R5G5B5: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 10) & 0x1f) * 255 / 31;
                g = ((value >>> 5) & 0x1f) * 255 / 31;
                b = (value & 0x1f) * 255 / 31;
                a = format === D3DFMT_A1R5G5B5 ?
                    ((value >>> 15) & 0x1) * 255 : 0xff;
                break;
            }
            case D3DFMT_A4R4G4B4: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 8) & 0xf) * 255 / 15;
                g = ((value >>> 4) & 0xf) * 255 / 15;
                b = (value & 0xf) * 255 / 15;
                a = ((value >>> 12) & 0xf) * 255 / 15;
                break;
            }
            case D3DFMT_L8:
                r = g = b = source[sourceOffset + i];
                a = 0xff;
                break;
            case D3DFMT_A8:
                r = g = b = 0xff;
                a = source[sourceOffset + i];
                break;
            default:
                r = g = b = a = 0;
                break;
            }
            dest[destOffset + i * 4] = r | 0;
            dest[destOffset + i * 4 + 1] = g | 0;
            dest[destOffset + i * 4 + 2] = b | 0;
            dest[destOffset + i * 4 + 3] = a | 0;
        }
    }

    // Row-major multiply: out[row][col] = sum_k a[row][k] * b[k][col]. This is
    // D3D's own convention, so multiply4x4(W, V) chains the way a row vector
    // would travel through them (v * W * V). See uniformBufferFor for why no
    // transpose is needed when handing the result to WGSL.
    function multiply4x4(a, b) {
        const out = new Float32Array(16);
        for (let row = 0; row < 4; ++row) {
            for (let col = 0; col < 4; ++col) {
                let sum = 0;
                for (let k = 0; k < 4; ++k)
                    sum += a[row * 4 + k] * b[k * 4 + col];
                out[row * 4 + col] = sum;
            }
        }
        return out;
    }

    const IDENTITY4x4 = new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);

    // Vertex declaration -> WGSL fixed-function shader. Only the subset
    // parse_vertex_declaration() in d3d9_proxy.c can ever produce: a single
    // position attribute (POSITION as FLOAT3, going through the world/view/
    // projection uniform, or POSITIONT as FLOAT4 screen-space XYZRHW),
    // optional D3DCOLOR diffuse, optional one FLOAT2 texcoord. NORMAL/PSIZE/
    // specular are accepted by the declaration parser (so lit vertex data
    // does not have to be reformatted before M2 adds lighting) but are not
    // consumed by this M1 shader.
    // debugMode (null in normal operation) replaces the fragment output with
    // something unambiguous, so "the screen is black" can be attributed to a
    // specific input rather than guessed at:
    //   "solid"   flat green  -- proves geometry coverage and that fragments land
    //   "color"   vertex colour only, texture ignored
    //   "texture" texture sample only, vertex colour ignored
    //   "uv"      texcoords as red/green -- shows whether UVs are sane
    function buildFixedFunctionShader(layout, debugMode) {
        const hasTexture = layout.hasTexCoord;
        const positionType = layout.positionType; // "screen" | "world"
        const vsPositionBody = positionType === "screen"
            ? `
                let viewport = uniforms.viewport;
                let ndc_x = (position.x / viewport.x) * 2.0 - 1.0;
                let ndc_y = 1.0 - (position.y / viewport.y) * 2.0;
                out.clip_position = vec4<f32>(ndc_x, ndc_y, position.z, 1.0);
            `
            : `
                out.clip_position = uniforms.world_view_projection *
                    vec4<f32>(position, 1.0);
            `;
        const positionAttribute = positionType === "screen"
            ? "@location(0) position: vec4<f32>,"
            : "@location(0) position: vec3<f32>,";
        const colorAttribute = layout.hasColor
            ? "@location(1) color: vec4<f32>,"
            : "";
        const texAttribute = hasTexture
            ? `@location(${layout.hasColor ? 2 : 1}) texcoord: vec2<f32>,`
            : "";
        let fragmentBody;
        if (debugMode === "solid") {
            fragmentBody = "return vec4<f32>(0.0, 1.0, 0.0, 1.0);";
        } else if (debugMode === "color") {
            fragmentBody = "return vec4<f32>(in.color.rgb, 1.0);";
        } else if (debugMode === "uv") {
            fragmentBody = hasTexture
                ? "return vec4<f32>(in.texcoord, 0.0, 1.0);"
                : "return vec4<f32>(0.0, 0.0, 1.0, 1.0);";
        } else if (debugMode === "texture") {
            fragmentBody = hasTexture
                ? "return vec4<f32>(textureSample(tex, tex_sampler, in.texcoord).rgb, 1.0);"
                : "return vec4<f32>(1.0, 0.0, 0.0, 1.0);";
        } else {
            fragmentBody = hasTexture
                ? "return in.color * textureSample(tex, tex_sampler, in.texcoord);"
                : "return in.color;";
        }
        const code = `
struct Uniforms {
    world_view_projection: mat4x4<f32>,
    viewport: vec2<f32>,
    _pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${hasTexture ? "@group(0) @binding(1) var tex_sampler: sampler;" : ""}
${hasTexture ? "@group(0) @binding(2) var tex: texture_2d<f32>;" : ""}

struct VSOut {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
    ${hasTexture ? "@location(1) texcoord: vec2<f32>," : ""}
};

@vertex
fn vs_main(
    ${positionAttribute}
    ${colorAttribute}
    ${texAttribute}
) -> VSOut {
    var out: VSOut;
    ${vsPositionBody}
    out.color = ${layout.hasColor ? "color.bgra" : "vec4<f32>(1.0, 1.0, 1.0, 1.0)"};
    ${hasTexture ? "out.texcoord = texcoord;" : ""}
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    ${fragmentBody}
}
`;
        return code;
    }

    class D3D9WebGPUExecutor {
        constructor(canvas, options) {
            if (!canvas) throw new Error("D3D9 WebGPU canvas is required");
            this.canvas = canvas;
            this.options = options || {};
            this.gpu = this.options.gpu ||
                (global.navigator && global.navigator.gpu);
            this.adapter = this.options.adapter || null;
            this.device = this.options.device || null;
            this.context = this.options.context || null;
            this.format = this.options.format || null;
            this.devices = new Map();      // device_handle -> device state
            this.resources = new Map();    // resource_handle -> resource state
            this.pipelineCache = new Map(); // layout signature -> GPURenderPipeline
            this.samplerCache = null;
            this.fallbackTexture = null;
            this.fallbackView = null;
            this.frame = null;             // { encoder, pass, targetView }
            this.readyPromise = null;
            this.work = Promise.resolve();
            this.failed = null;
            // Console-togglable diagnostics, e.g.
            //   v86gl.d3d9Executor.debug.forceClearColor = {r:1,g:0,b:1,a:1}
            // These exist to split "the canvas is not on screen" from "the
            // canvas is on screen but the drawn content is black", which the
            // stats alone cannot distinguish.
            this.debug = {
                forceClearColor: null,  // {r,g,b,a} overrides every Clear
                disableCull: false,     // force cullMode "none"
                disableDepthTest: false,// force depthCompare "always"
                shaderMode: null,       // "solid"|"color"|"texture"|"uv"
            };
            this.stats = {
                batches: 0, commands: 0, presents: 0, queueSubmits: 0,
                drawCalls: 0, indexedDrawCalls: 0, upDrawCalls: 0,
                pipelineCreations: 0, pipelineHits: 0,
                unsupportedCommands: 0, malformedBatches: 0,
                droppedDraws: 0,
                texturesCreated: 0, textureUploads: 0, textureBytesUploaded: 0,
                drawsWithTexture: 0, drawsWithFallbackTexture: 0,
            };
        }

        initialize() {
            if (this.readyPromise) return this.readyPromise;
            this.readyPromise = (async () => {
                if (!this.device) {
                    if (!this.gpu || typeof this.gpu.requestAdapter !== "function")
                        throw new Error("WebGPU is unavailable");
                    this.adapter = this.adapter ||
                        await this.gpu.requestAdapter({ powerPreference: "high-performance" });
                    if (!this.adapter) throw new Error("WebGPU adapter request failed");
                    this.device = await this.adapter.requestDevice();
                }
                this.context = this.context || this.canvas.getContext("webgpu");
                if (!this.context) throw new Error("could not acquire a WebGPU canvas context");
                this.format = this.format || (this.gpu &&
                    typeof this.gpu.getPreferredCanvasFormat === "function" ?
                    this.gpu.getPreferredCanvasFormat() : "bgra8unorm");
                this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
                this.fallbackTexture = this.device.createTexture({
                    label: "D3D9 fallback white texture",
                    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                    format: "rgba8unorm",
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                this.fallbackView = this.fallbackTexture.createView();
                this.device.queue.writeTexture({ texture: this.fallbackTexture },
                    new Uint8Array([255, 255, 255, 255]),
                    { bytesPerRow: 4, rowsPerImage: 1 },
                    { width: 1, height: 1, depthOrArrayLayers: 1 });
                this.fallbackSampler = this.device.createSampler({
                    magFilter: "linear", minFilter: "linear",
                    addressModeU: "repeat", addressModeV: "repeat",
                });
                if (this.device.lost && typeof this.device.lost.then === "function") {
                    this.device.lost.then(() => {
                        console.error("[d3d9-webgpu] WebGPU device lost; M1 does not " +
                            "yet implement recovery (see D3D8 path's recoverDevice for " +
                            "the shadow-state-driven reconstruction this needs before M2).");
                    });
                }
                return this;
            })().catch(error => {
                this.failed = error;
                console.error("[d3d9-webgpu] initialization failed", error);
                throw error;
            });
            return this.readyPromise;
        }

        submit(bytes, metadata) {
            const owned = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes || []);
            this.work = this.work.then(() => this.initialize())
                .then(() => this.executeBatch(owned, metadata || {}))
                .catch(error => {
                    this.failed = error;
                    console.error("[d3d9-webgpu] batch failed", error, metadata || {});
                    this.discardFrame();
                });
            return this.work;
        }

        idle() { return this.work; }

        // ---- batch decode ----

        executeBatch(bytes, metadata) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (bytes.byteLength < D9WG_BATCH_HEADER_BYTES) {
                ++this.stats.malformedBatches;
                throw new Error("D9WG batch shorter than its header");
            }
            const magic = view.getUint32(0, true);
            const versionMajor = view.getUint16(4, true);
            const versionMinor = view.getUint16(6, true);
            const commandCount = view.getUint32(16, true);
            const commandBytes = view.getUint32(20, true);
            if (magic !== D9WG_MAGIC) {
                ++this.stats.malformedBatches;
                throw new Error("D9WG batch has the wrong magic");
            }
            if (versionMajor !== D9WG_VERSION_MAJOR || versionMinor > D9WG_VERSION_MINOR) {
                ++this.stats.malformedBatches;
                throw new Error(`unsupported D9WG version ${versionMajor}.${versionMinor}`);
            }
            if (commandBytes > bytes.byteLength - D9WG_BATCH_HEADER_BYTES) {
                ++this.stats.malformedBatches;
                throw new Error("D9WG batch command_bytes overruns the record");
            }
            ++this.stats.batches;

            let offset = D9WG_BATCH_HEADER_BYTES;
            const end = D9WG_BATCH_HEADER_BYTES + commandBytes;
            let decoded = 0;
            while (offset + D9WG_COMMAND_HEADER_BYTES <= end) {
                const opcode = view.getUint16(offset, true);
                const size = view.getUint32(offset + 4, true);
                if (size < D9WG_COMMAND_HEADER_BYTES || offset + size > end) {
                    ++this.stats.malformedBatches;
                    throw new Error("D9WG command size is invalid");
                }
                const payloadOffset = offset + D9WG_COMMAND_HEADER_BYTES;
                const payloadBytes = size - D9WG_COMMAND_HEADER_BYTES;
                this.dispatchCommand(opcode, bytes, view, payloadOffset, payloadBytes);
                offset += size;
                ++decoded;
                ++this.stats.commands;
            }
            if (decoded !== commandCount) {
                ++this.stats.malformedBatches;
                throw new Error("D9WG command_count does not match the decoded stream");
            }

            const present = (view.getUint32(12, true) & D9WG_BATCH_FLAG_PRESENT) !== 0;
            if (present) this.finishFrame();
        }

        dispatchCommand(opcode, bytes, view, offset, length) {
            const handler = this.handlers[opcode];
            if (!handler) {
                // Per plan section 6.8: an unrecognized opcode is skipped by
                // its size (already advanced by the caller), never treated
                // as "executed" -- it simply never produces GPU state.
                ++this.stats.unsupportedCommands;
                return;
            }
            handler.call(this, bytes, view, offset, length);
        }

        // ---- device/resource state ----

        deviceState(handle) {
            let state = this.devices.get(handle);
            if (!state) {
                state = this.createDeviceState(handle);
                this.devices.set(handle, state);
            }
            return state;
        }

        createDeviceState(handle) {
            return {
                handle,
                surface: { hwnd: 0, x: 0, y: 0, width: 0, height: 0,
                    visible: true, sessionKey: null },
                viewport: { x: 0, y: 0, width: 1, height: 1 },
                transforms: new Map([
                    [D3DTS_VIEW, IDENTITY4x4], [D3DTS_PROJECTION, IDENTITY4x4],
                    [D3DTS_WORLD, IDENTITY4x4],
                ]),
                renderStates: new Map(),
                // Auto depth-stencil surface, created on CREATE_DEVICE/RESET
                // when the guest asked for one. hasDepth drives both the
                // render pass attachment and whether pipelines declare a
                // depthStencil block.
                hasDepth: false,
                depthTexture: null,
                depthView: null,
                samplerStates: new Map(), // sampler*64+state -> value; not yet consumed by pipelineFor (M2)
                textureStageStates: new Map(),
                material: null,          // set by SET_MATERIAL; not yet consumed (M2/M3 lighting)
                lights: new Map(),       // light index -> D3DLIGHT9-shaped object; not yet consumed
                lightEnabled: new Map(), // light index -> bool
                streams: new Map(),      // stream index -> { bufferHandle, stride }
                indexBufferHandle: 0,
                vertexDeclarationHandle: 0, // also used for the SET_FVF synthesized layout
                fvfLayout: null,         // set by SET_FVF, cleared by SET_VERTEX_DECLARATION
                textures: new Map(),     // stage -> resource handle
                inScene: false,
            };
        }

        // World * View * Projection in D3D's own row-vector order, so that
        // a vertex would be transformed as v * W * V * P. multiply4x4 is a
        // plain row-major multiply, which is exactly that chaining.
        wvp(state) {
            const world = state.transforms.get(D3DTS_WORLD) || IDENTITY4x4;
            const view_ = state.transforms.get(D3DTS_VIEW) || IDENTITY4x4;
            const projection = state.transforms.get(D3DTS_PROJECTION) || IDENTITY4x4;
            return multiply4x4(multiply4x4(world, view_), projection);
        }

        // ---- opcode handlers ----

        get handlers() {
            if (this._handlers) return this._handlers;
            this._handlers = {
                [OP_HELLO]: this.onHello,
                [OP_CREATE_DEVICE]: this.onCreateDevice,
                [OP_RESET]: this.onReset,
                [OP_PRESENT]: this.onPresent,
                [OP_CLEAR]: this.onClear,
                [OP_BEGIN_SCENE]: this.onBeginScene,
                [OP_END_SCENE]: this.onEndScene,
                [OP_CREATE_BUFFER]: this.onCreateBuffer,
                [OP_UPDATE_BUFFER]: this.onUpdateBuffer,
                [OP_DESTROY_RESOURCE]: this.onDestroyResource,
                [OP_CREATE_TEXTURE_2D]: this.onCreateTexture2D,
                [OP_UPDATE_TEXTURE]: this.onUpdateTexture,
                [OP_CREATE_VERTEX_DECLARATION]: this.onCreateVertexDeclaration,
                [OP_SET_RENDER_STATE]: this.onSetRenderState,
                [OP_SET_SAMPLER_STATE]: this.onSetSamplerState,
                [OP_SET_TEXTURE_STAGE_STATE]: this.onSetTextureStageState,
                [OP_SET_TEXTURE]: this.onSetTexture,
                [OP_SET_VIEWPORT]: this.onSetViewport,
                [OP_SET_TRANSFORM]: this.onSetTransform,
                [OP_SET_MATERIAL]: this.onSetMaterial,
                [OP_SET_LIGHT]: this.onSetLight,
                [OP_LIGHT_ENABLE]: this.onLightEnable,
                [OP_SET_STREAM_SOURCE]: this.onSetStreamSource,
                [OP_SET_INDICES]: this.onSetIndices,
                [OP_SET_VERTEX_DECLARATION]: this.onSetVertexDeclaration,
                [OP_SET_FVF]: this.onSetFVF,
                [OP_DRAW_PRIMITIVE]: this.onDrawPrimitive,
                [OP_DRAW_INDEXED_PRIMITIVE]: this.onDrawIndexedPrimitive,
                [OP_DRAW_PRIMITIVE_UP]: this.onDrawPrimitiveUP,
                [OP_DRAW_INDEXED_PRIMITIVE_UP]: this.onDrawIndexedPrimitiveUP,
            };
            return this._handlers;
        }

        onHello(bytes, view, offset) {
            // M1 does not yet reject a mismatched per-process session id
            // (that needs the D3D8 path's session-isolation machinery); the
            // fields are decoded so a future revision can add it without a
            // wire change.
            void view.getUint32(offset, true); // guest_pointer_bits
            void view.getUint32(offset + 4, true); // feature_bits
        }

        onCreateDevice(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            const hwnd = view.getUint32(offset + 4, true);
            const x = view.getInt32(offset + 8, true);
            const y = view.getInt32(offset + 12, true);
            const width = view.getUint32(offset + 16, true);
            const height = view.getUint32(offset + 20, true);
            const enableAutoDepth = view.getUint32(offset + 36, true);
            // A frame left un-presented by a previous device -- typically a
            // process that exited mid-frame -- must not bleed into this one.
            // Its recorded ops reference that device's depth target and
            // back-buffer size, which WebGPU rejects as soon as the sizes
            // differ ("depth stencil attachment size does not match ...").
            this.discardFrame();
            const state = this.deviceState(handle);
            state.viewport = { x: 0, y: 0, width, height };
            state.surface = { hwnd, x, y, width, height, visible: true, sessionKey: null };
            this.resizeCanvasIfNeeded(width, height);
            this.ensureDepthTarget(state, width, height, enableAutoDepth !== 0);
            this.notifySurface(state, "create");
        }

        onReset(bytes, view, offset) {
            const oldHandle = view.getUint32(offset, true);
            const newHandle = view.getUint32(offset + 4, true);
            const hwnd = view.getUint32(offset + 8, true);
            const x = view.getInt32(offset + 12, true);
            const y = view.getInt32(offset + 16, true);
            const width = view.getUint32(offset + 20, true);
            const height = view.getUint32(offset + 24, true);
            const enableAutoDepth = view.getUint32(offset + 40, true);
            const oldState = this.devices.get(oldHandle);
            if (oldState) this.retireGPUObject(oldState.depthTexture);
            this.devices.delete(oldHandle);
            const state = this.deviceState(newHandle);
            state.viewport = { x: 0, y: 0, width, height };
            state.surface = { hwnd, x, y, width, height, visible: true, sessionKey: null };
            this.resizeCanvasIfNeeded(width, height);
            this.ensureDepthTarget(state, width, height, enableAutoDepth !== 0);
            this.notifySurface(state, "reset");
        }

        resizeCanvasIfNeeded(width, height) {
            if (this.canvas.width !== width) this.canvas.width = width;
            if (this.canvas.height !== height) this.canvas.height = height;
        }

        // Creates (or drops) the device's auto depth-stencil target. D3D9
        // reports many depth formats but the guest can never read any of
        // them back in M1, so one depth24plus-stencil8 target satisfies all
        // of them; only whether a depth buffer exists at all is observable.
        ensureDepthTarget(state, width, height, enabled) {
            if (state.depthTexture) {
                // Never destroy it inline: the frame currently being recorded
                // may already have pinned this texture's view (see
                // recordDraw's frame.depthView) and will not submit until
                // Present, so an immediate destroy produces
                // "Destroyed texture ... used in a submit" -- a real crash
                // observed when a device was re-created or Reset mid-frame.
                this.retireGPUObject(state.depthTexture);
                state.depthTexture = null;
                state.depthView = null;
            }
            state.hasDepth = !!enabled;
            if (!enabled || !width || !height) return;
            state.depthTexture = this.device.createTexture({
                label: "D3D9 auto depth-stencil",
                size: { width, height, depthOrArrayLayers: 1 },
                format: DEPTH_FORMAT,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
            });
            state.depthView = state.depthTexture.createView();
            state.depthWidth = width;
            state.depthHeight = height;
        }

        // One line per distinct condition, so a per-frame problem cannot flood
        // the console while still being reported the first time it happens.
        warnOnce(key, message, details) {
            this.warned = this.warned || new Set();
            if (this.warned.has(key)) return;
            this.warned.add(key);
            console.warn("[d3d9-webgpu] " + message, details || "");
        }

        // Releases a GPU object that the in-flight frame may still reference.
        // If a frame is being recorded, the object rides along with that
        // frame's transient list and is destroyed only once the frame's
        // submit has completed; otherwise it waits on the queue directly.
        retireGPUObject(object) {
            if (!object || typeof object.destroy !== "function") return;
            if (this.frame) {
                this.frame.transientBuffers.push(object);
                return;
            }
            const destroy = () => object.destroy();
            if (this.device.queue
                    && typeof this.device.queue.onSubmittedWorkDone === "function")
                this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
            else
                destroy();
        }

        notifySurface(state, reason) {
            if (typeof this.options.onSurface === "function")
                this.options.onSurface(state.surface, reason);
        }

        onPresent(bytes, view, offset) {
            // The actual GPU submit happens in finishFrame(), called once
            // per executeBatch() when the outer D9WGBatchHeader carries
            // D9WG_BATCH_FLAG_PRESENT -- see the end of executeBatch(). The
            // guest recomputes the window's current screen position on
            // every Present (d3d9_proxy.c has no window-move subclassing in
            // M1), so this is the live source of truth for canvas placement
            // rather than a separate UPDATE_SURFACE event.
            const handle = view.getUint32(offset, true);
            const state = this.deviceState(handle);
            const hwnd = view.getUint32(offset + 4, true);
            const x = view.getInt32(offset + 8, true);
            const y = view.getInt32(offset + 12, true);
            const width = view.getUint32(offset + 16, true);
            const height = view.getUint32(offset + 20, true);
            const changed = state.surface.hwnd !== hwnd || state.surface.x !== x ||
                state.surface.y !== y || state.surface.width !== width ||
                state.surface.height !== height;
            state.surface = { ...state.surface, hwnd, x, y, width, height, visible: true };
            if (changed) this.notifySurface(state, "present");
            this.presentingDevice = state;
        }

        onBeginScene(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            this.deviceState(handle).inScene = true;
        }

        onEndScene(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            this.deviceState(handle).inScene = false;
        }

        // A "frame" here is pure JS bookkeeping -- a list of pending clear/
        // draw operations -- with no WebGPU objects created yet. This is
        // deliberate: a canvas's context.getCurrentTexture() is only valid
        // for the task that acquired it; once control returns to the
        // browser's event loop, that texture is liable to be presented and
        // invalidated out from under you ("Destroyed texture ... used in a
        // submit"). A single D3D9 frame's Clear/Draw/Present calls do not
        // reliably arrive in one task: d3d9_proxy.c flushes a partial batch
        // over PCI whenever the DMA ring fills up (reserve_command_locked's
        // intermediate submit_batch_locked(FALSE)), and each such PCI record
        // is delivered to this executor as a separate worker postMessage --
        // a separate macrotask. Acquiring the swapchain texture eagerly on
        // the first Clear of a frame and holding it until a much-later
        // Present-carrying submit is exactly the pattern that goes stale.
        // Recording lightweight ops now and only turning them into real
        // WebGPU calls inside finishFrame() -- acquired, recorded, and
        // submitted in one synchronous stretch -- avoids that regardless of
        // how many separate PCI submits contributed to the frame.
        ensureFrame() {
            if (this.frame) return this.frame;
            this.frame = { ops: [], transientBuffers: [] };
            return this.frame;
        }

        // If a command throws partway through a batch (see submit()'s catch
        // handler), this.frame may be left holding recorded-but-unreplayed
        // ops. Since no WebGPU render pass/encoder exists yet at this point
        // (those are only created in finishFrame(), at Present time), there
        // is nothing to end -- just drop the ops and free any transient
        // buffers already created for them so the next frame starts clean.
        discardFrame() {
            const frame = this.frame;
            if (!frame) return;
            this.frame = null;
            if (frame.transientBuffers && frame.transientBuffers.length) {
                for (const buffer of frame.transientBuffers) buffer.destroy();
            }
        }

        onClear(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const flags = view.getUint32(offset + 4, true);
            const color = view.getUint32(offset + 8, true);
            const depth = view.getFloat32(offset + 12, true);
            const stencil = view.getUint32(offset + 16, true);
            const state = this.deviceState(deviceHandle);
            const clearsColor = (flags & D3DCLEAR_TARGET) !== 0;
            // A depth/stencil clear is only meaningful if the device
            // actually has an auto depth-stencil surface.
            const clearsDepth = (flags & (D3DCLEAR_ZBUFFER | D3DCLEAR_STENCIL))
                !== 0 && state.hasDepth;
            if (!clearsColor && !clearsDepth) return;
            const a = ((color >>> 24) & 0xff) / 255;
            const r = ((color >>> 16) & 0xff) / 255;
            const g = ((color >>> 8) & 0xff) / 255;
            const b = (color & 0xff) / 255;
            const frame = this.ensureFrame();
            // Same frame-wide pinning as recordDraw: a Clear is usually the
            // first op of a frame, so it is normally what fixes the choice.
            if (frame.depthView === undefined) {
                frame.depthView = state.depthView || null;
                frame.depthWidth = state.depthWidth;
                frame.depthHeight = state.depthHeight;
            }
            frame.ops.push({
                kind: "clear",
                clearsColor: clearsColor || !!this.debug.forceClearColor,
                clearsDepth,
                color: this.debug.forceClearColor || { r, g, b, a },
                depth, stencil,
            });
        }

        // Replays every recorded clear/draw op against a freshly-acquired
        // swapchain texture, all synchronously, right before submit -- see
        // the comment on ensureFrame() for why acquisition cannot happen any
        // earlier than this. A "clear" op starts a new render pass (WebGPU
        // has no mid-pass re-clear); a "draw" op opens a loadOp:"load" pass
        // first if none is open yet (a draw with no preceding Clear in this
        // frame means "keep whatever the swapchain texture already has").
        finishFrame() {
            const frame = this.frame;
            if (!frame) return;
            this.frame = null;
            if (frame.ops.length) {
                const encoder = this.device.createCommandEncoder();
                const swapTexture = this.context.getCurrentTexture();
                // Belt and braces for the case above: if the depth target and
                // the back buffer ever disagree, dropping the frame loses one
                // frame, whereas submitting it makes WebGPU reject the whole
                // command buffer and every later frame with it.
                if (frame.depthView
                        && (frame.depthWidth !== swapTexture.width
                            || frame.depthHeight !== swapTexture.height)) {
                    this.warnOnce("depth-size-mismatch",
                        "dropping a frame whose depth target " +
                        frame.depthWidth + "x" + frame.depthHeight +
                        " does not match the back buffer " +
                        swapTexture.width + "x" + swapTexture.height);
                    frame.ops.length = 0;
                }
                const targetView = swapTexture.createView();
                // Every pass in the frame must agree on whether a depth
                // attachment exists, because the pipelines recorded into
                // those passes each baked that choice in at creation time.
                const depthView = frame.depthView || null;
                const beginPass = (clearColor, clearDepth) => {
                    const descriptor = {
                        colorAttachments: [{
                            view: targetView,
                            loadOp: clearColor ? "clear" : "load",
                            storeOp: "store",
                            ...(clearColor ? { clearValue: clearColor } : {}),
                        }],
                    };
                    if (depthView) {
                        descriptor.depthStencilAttachment = {
                            view: depthView,
                            depthLoadOp: clearDepth ? "clear" : "load",
                            depthStoreOp: "store",
                            stencilLoadOp: clearDepth ? "clear" : "load",
                            stencilStoreOp: "store",
                            ...(clearDepth ? {
                                depthClearValue: clearDepth.depth,
                                stencilClearValue: clearDepth.stencil,
                            } : {}),
                        };
                    }
                    return encoder.beginRenderPass(descriptor);
                };
                let pass = null;
                for (const op of frame.ops) {
                    if (op.kind === "clear") {
                        if (pass) pass.end();
                        // A Clear that only touches depth still has to keep
                        // the colour already drawn this frame, and vice
                        // versa -- hence the two independent load ops.
                        pass = beginPass(
                            op.clearsColor ? op.color : null,
                            op.clearsDepth
                                ? { depth: op.depth, stencil: op.stencil }
                                : null);
                    } else {
                        if (!pass) pass = beginPass(null, null);
                        pass.setPipeline(op.pipeline);
                        pass.setBindGroup(0, op.bindGroup);
                        pass.setViewport(op.viewport.x, op.viewport.y,
                                op.viewport.width, op.viewport.height, 0, 1);
                        pass.setVertexBuffer(0, op.vertexBuffer, op.vertexOffset);
                        if (op.indexInfo) {
                            pass.setIndexBuffer(op.indexInfo.buffer, op.indexInfo.format,
                                    op.indexInfo.offset);
                            pass.drawIndexed(op.indexInfo.count, 1,
                                    op.indexInfo.firstIndex, op.indexInfo.baseVertex);
                        } else {
                            pass.draw(op.vertexBuffer._d9wgCount || 0);
                        }
                    }
                }
                if (pass) pass.end();
                this.device.queue.submit([encoder.finish()]);
                ++this.stats.queueSubmits;
            }
            ++this.stats.presents;
            const transientBuffers = frame.transientBuffers;
            if (transientBuffers && transientBuffers.length) {
                const destroy = () => { for (const b of transientBuffers) b.destroy(); };
                if (this.device.queue && typeof this.device.queue.onSubmittedWorkDone === "function")
                    this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
                else
                    destroy();
            }
            if (this.presentingDevice && typeof this.options.onPresent === "function")
                this.options.onPresent(this.presentingDevice.surface, this.getStats());
            this.presentingDevice = null;
        }

        getStats() {
            return { ...this.stats, devicesLive: this.devices.size,
                resourcesLive: this.resources.size };
        }

        // ---- resources ----

        onCreateBuffer(bytes, view, offset) {
            const handle = view.getUint32(offset + 4, true);
            const kind = view.getUint32(offset + 8, true);
            const byteCount = view.getUint32(offset + 12, true);
            const format = view.getUint32(offset + 20, true); // index format, for INDEX kind
            const usage = kind === RESOURCE_BUFFER_INDEX
                ? BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST
                : BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST;
            const alignedSize = Math.max(4, alignUp(byteCount, 4));
            const gpuBuffer = this.device.createBuffer({
                size: alignedSize,
                usage,
            });
            this.resources.set(handle, {
                kind, gpuBuffer, byteCount,
                // CPU mirror of the buffer's full (aligned) content. D3D9's
                // Lock/Unlock byte ranges can start and end anywhere, but
                // WebGPU's writeBuffer requires both the destination offset
                // and the size to be a multiple of 4 -- a 16-bit index
                // buffer partially updated starting at an odd index is a
                // routine, common example that is neither. Applying the
                // update to this plain byte array first (no alignment
                // concerns) and re-uploading only the small 4-byte-aligned
                // super-range that covers it keeps every write legal without
                // ever guessing at or corrupting the untouched bytes on
                // either edge (see applyBufferUpdate()).
                shadow: new Uint8Array(alignedSize),
                indexFormat: format === D3DFMT_INDEX32 ? "uint32" : "uint16",
            });
        }

        onUpdateBuffer(bytes, view, offset, length) {
            const handle = view.getUint32(offset, true);
            const destinationOffset = view.getUint32(offset + 4, true);
            const byteCount = view.getUint32(offset + 8, true);
            const dataOffset = view.getUint32(offset + 12, true);
            const resource = this.resources.get(handle);
            if (!resource || !byteCount) return;
            this.applyBufferUpdate(resource, destinationOffset, bytes, dataOffset, byteCount);
        }

        applyBufferUpdate(resource, destinationOffset, bytes, sourceOffset, byteCount) {
            const shadow = resource.shadow;
            if (destinationOffset >= shadow.length) return;
            if (destinationOffset + byteCount > shadow.length)
                byteCount = shadow.length - destinationOffset;
            if (!byteCount) return;
            const source = new Uint8Array(bytes.buffer, bytes.byteOffset + sourceOffset, byteCount);
            shadow.set(source, destinationOffset);
            const alignedStart = destinationOffset & ~3;
            const alignedEnd = Math.min(shadow.length,
                alignUp(destinationOffset + byteCount, 4));
            if (alignedEnd <= alignedStart) return;
            this.device.queue.writeBuffer(resource.gpuBuffer, alignedStart,
                shadow.buffer, shadow.byteOffset + alignedStart, alignedEnd - alignedStart);
        }

        // WebGPU requires writeBuffer's size (and destination offset) to be a
        // multiple of 4 bytes; D3D9's Lock/Unlock byte ranges carry no such
        // guarantee (a 16-bit index buffer update is a common example that
        // is not). D9WG command records are always padded to an 8-byte
        // boundary (D9WG_ALIGN8 in d3d9_proxy.c), so up to 3 extra
        // zero-padding bytes past `byteCount` are always safely readable
        // from the same batch -- this rounds the write size up into that
        // slack rather than crashing the whole batch on an unaligned
        // Direct3D-legal update.
        writeBufferAligned(gpuBuffer, dstOffset, bytes, sourceOffset, byteCount) {
            if (!byteCount) return;
            if (dstOffset % 4 !== 0) {
                console.warn("[d3d9-webgpu] dropping a buffer update at a " +
                    "non-4-byte-aligned destination offset", { dstOffset, byteCount });
                return;
            }
            let writeCount = alignUp(byteCount, 4);
            const available = gpuBuffer.size - dstOffset;
            if (writeCount > available) writeCount = available - (available % 4);
            if (writeCount <= 0) return;
            this.device.queue.writeBuffer(gpuBuffer, dstOffset,
                new Uint8Array(bytes.buffer, bytes.byteOffset + sourceOffset, writeCount));
        }

        onDestroyResource(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            const kind = view.getUint32(offset + 4, true);
            if (kind === 0) {
                // Matches the D3D8 guest convention: DESTROY_RESOURCE with
                // resource_kind 0 targets the device handle itself, emitted
                // once from device_release() when the app's last reference
                // drops (see d3d9_proxy.c).
                const state = this.devices.get(handle);
                if (state) {
                    state.surface = { ...state.surface, visible: false };
                    if (typeof this.options.onDestroy === "function")
                        this.options.onDestroy(state.surface, "device");
                    this.retireGPUObject(state.depthTexture);
                    this.devices.delete(handle);
                }
                return;
            }
            const resource = this.resources.get(handle);
            if (!resource) return;
            if (resource.gpuBuffer) resource.gpuBuffer.destroy();
            if (resource.gpuTexture) resource.gpuTexture.destroy();
            this.resources.delete(handle);
        }

        onCreateTexture2D(bytes, view, offset) {
            const handle = view.getUint32(offset + 4, true);
            const width = view.getUint32(offset + 8, true);
            const height = view.getUint32(offset + 12, true);
            const levelCount = view.getUint32(offset + 16, true);
            const format = view.getUint32(offset + 20, true);
            const gpuFormat = formatToGPU(format);
            if (!gpuFormat) {
                console.warn("[d3d9-webgpu] unsupported texture format", format);
                return;
            }
            const gpuTexture = this.device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: gpuFormat,
                mipLevelCount: Math.max(1, levelCount),
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            ++this.stats.texturesCreated;
            this.resources.set(handle, {
                kind: RESOURCE_TEXTURE_2D, gpuTexture, format, width, height,
                view: gpuTexture.createView(),
                sampler: this.device.createSampler({
                    magFilter: "linear", minFilter: "linear",
                    addressModeU: "repeat", addressModeV: "repeat",
                }),
            });
        }

        onUpdateTexture(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            const level = view.getUint32(offset + 4, true);
            const x = view.getUint32(offset + 8, true);
            const y = view.getUint32(offset + 12, true);
            const width = view.getUint32(offset + 20, true);
            const height = view.getUint32(offset + 24, true);
            const rowPitch = view.getUint32(offset + 32, true);
            const dataBytes = view.getUint32(offset + 40, true);
            const dataOffset = view.getUint32(offset + 44, true);
            const resource = this.resources.get(handle);
            if (!resource || !resource.gpuTexture) return;
            const source = new Uint8Array(bytes.buffer, bytes.byteOffset + dataOffset, dataBytes);
            const compressed = resource.format === D3DFMT_DXT1 ||
                resource.format === D3DFMT_DXT3 || resource.format === D3DFMT_DXT5;
            let payload = source;
            let bytesPerRow = rowPitch;
            if (!compressed) {
                // Expand to tightly-packed RGBA8 (see formatToGPU()).
                const expanded = new Uint8Array(width * height * 4);
                const srcBytesPerTexel = rowPitch / width;
                for (let row = 0; row < height; ++row) {
                    expandRowToRGBA8(resource.format, source,
                        row * rowPitch, width, expanded, row * width * 4);
                }
                payload = expanded;
                bytesPerRow = width * 4;
            }
            ++this.stats.textureUploads;
            this.stats.textureBytesUploaded += payload.length;
            this.device.queue.writeTexture(
                { texture: resource.gpuTexture, mipLevel: level, origin: { x, y, z: 0 } },
                payload, { bytesPerRow, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 });
        }

        decodeVertexElements(bytes, view, offset, count) {
            const elements = [];
            for (let i = 0; i < count; ++i) {
                const base = offset + i * 8;
                elements.push({
                    stream: view.getUint16(base, true),
                    byteOffset: view.getUint16(base + 2, true),
                    type: view.getUint8(base + 4),
                    method: view.getUint8(base + 5),
                    usage: view.getUint8(base + 6),
                    usageIndex: view.getUint8(base + 7),
                });
            }
            return elements;
        }

        // Builds the small description buildFixedFunctionShader()/the vertex
        // buffer layout need from a decoded D9WGVertexElement array. Only
        // ever produces the shapes declaration_element_supported() in
        // d3d9_proxy.c allows through in the first place.
        vertexLayoutFrom(elements) {
            const attributes = [];
            let stride = 0;
            let positionType = null;
            let hasColor = false;
            let hasTexCoord = false;
            let location = 0;
            const perTypeFormat = {
                [DECLTYPE_FLOAT1]: ["float32", 4],
                [DECLTYPE_FLOAT2]: ["float32x2", 8],
                [DECLTYPE_FLOAT3]: ["float32x3", 12],
                [DECLTYPE_FLOAT4]: ["float32x4", 16],
                [DECLTYPE_D3DCOLOR]: ["unorm8x4", 4],
            };
            // D3DCOLOR is packed ARGB in memory; WebGPU's unorm8x4 reads the
            // raw little-endian bytes as-is, so the attribute lands in the
            // shader as vec4(b, g, r, a) rather than (r, g, b, a). The
            // fixed-function shader corrects this with a `.bgra` swizzle
            // (see buildFixedFunctionShader) instead of paying for a
            // per-vertex CPU swizzle pass on upload.
            for (const element of elements) {
                if (element.usage === DECLUSAGE_POSITION) {
                    positionType = "world";
                    attributes.push({ shaderLocation: location++, offset: element.byteOffset, format: "float32x3" });
                } else if (element.usage === DECLUSAGE_POSITIONT) {
                    positionType = "screen";
                    attributes.push({ shaderLocation: location++, offset: element.byteOffset, format: "float32x4" });
                } else if (element.usage === DECLUSAGE_COLOR && element.usageIndex === 0) {
                    hasColor = true;
                    attributes.push({ shaderLocation: location++, offset: element.byteOffset, format: "unorm8x4" });
                } else if (element.usage === DECLUSAGE_TEXCOORD && element.usageIndex === 0) {
                    hasTexCoord = true;
                    attributes.push({ shaderLocation: location++, offset: element.byteOffset, format: "float32x2" });
                }
                // NORMAL/PSIZE/SPECULAR/additional TEXCOORDn are accepted by
                // the guest's declaration validator but not wired into this
                // M1 shader; skip them here.
                // Only a lower bound on the real vertex size: elements this
                // layout skips still occupy bytes, and the declaration can
                // carry trailing padding. The authoritative stride is the one
                // the app passed to SetStreamSource -- see recordDraw.
                const info = perTypeFormat[element.type];
                if (info) stride = Math.max(stride, element.byteOffset + info[1]);
            }
            if (!positionType) return null;
            return { attributes, minStride: stride, positionType, hasColor,
                hasTexCoord };
        }

        onCreateVertexDeclaration(bytes, view, offset, length) {
            const handle = view.getUint32(offset + 4, true);
            const count = view.getUint32(offset + 8, true);
            const elements = this.decodeVertexElements(bytes, view, offset + 16, count);
            const layout = this.vertexLayoutFrom(elements);
            // `elements` is kept purely so a dropped draw can report the exact
            // declaration that failed to yield a usable layout (see
            // noteDroppedDraw); nothing on the render path reads it.
            this.resources.set(handle,
                { kind: RESOURCE_VERTEX_DECLARATION, layout, elements });
            if (!layout) {
                console.warn("[d3d9-webgpu] vertex declaration produced no usable "
                    + "layout (no POSITION/POSITIONT element recognised)", elements);
            }
        }

        onSetVertexDeclaration(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const declarationHandle = view.getUint32(offset + 4, true);
            const state = this.deviceState(deviceHandle);
            state.vertexDeclarationHandle = declarationHandle;
            state.fvfLayout = null;
        }

        onSetFVF(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset, true);
            const count = view.getUint32(offset + 8, true);
            const elements = this.decodeVertexElements(bytes, view, offset + 16, count);
            const state = this.deviceState(deviceHandle);
            state.fvfLayout = this.vertexLayoutFrom(elements);
            state.fvfElements = elements;
            state.vertexDeclarationHandle = 0;
            if (!state.fvfLayout) {
                console.warn("[d3d9-webgpu] SetFVF produced no usable layout "
                    + "(no POSITION/POSITIONT element recognised)", elements);
            }
        }

        currentLayout(state) {
            if (state.fvfLayout) return state.fvfLayout;
            const declaration = this.resources.get(state.vertexDeclarationHandle);
            return declaration ? declaration.layout : null;
        }

        onSetRenderState(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const stateId = view.getUint32(offset + 4, true);
            const value = view.getUint32(offset + 8, true);
            this.deviceState(deviceHandle).renderStates.set(stateId, value);
        }

        onSetTextureStageState(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const stage = view.getUint32(offset + 4, true);
            const stateId = view.getUint32(offset + 8, true);
            const value = view.getUint32(offset + 12, true);
            this.deviceState(deviceHandle).textureStageStates.set(stage * 64 + stateId, value);
        }

        onSetTexture(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const stage = view.getUint32(offset + 4, true);
            const textureHandle = view.getUint32(offset + 8, true);
            this.deviceState(deviceHandle).textures.set(stage, textureHandle);
        }

        // Stored to keep host state honest with the guest's D9WGSetSamplerState/
        // D9WGSetMaterial/D9WGSetLight/D9WGLightEnable emitters (d3d9_proxy.c),
        // but not yet read anywhere in pipelineFor()/recordDraw() -- M1's fixed
        // shader always uses one hardcoded default sampler and never applies
        // lighting math. Real consumption is M2 (sampler variants, 4.4/12) and
        // M2/M3 (lighting) work.
        onSetSamplerState(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const sampler = view.getUint32(offset + 4, true);
            const stateId = view.getUint32(offset + 8, true);
            const value = view.getUint32(offset + 12, true);
            this.deviceState(deviceHandle).samplerStates.set(sampler * 64 + stateId, value);
        }

        onSetMaterial(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const readVec4 = base => [
                view.getFloat32(base, true), view.getFloat32(base + 4, true),
                view.getFloat32(base + 8, true), view.getFloat32(base + 12, true),
            ];
            this.deviceState(deviceHandle).material = {
                diffuse: readVec4(offset + 4), ambient: readVec4(offset + 20),
                specular: readVec4(offset + 36), emissive: readVec4(offset + 52),
                power: view.getFloat32(offset + 68, true),
            };
        }

        onSetLight(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const index = view.getUint32(offset + 4, true);
            const readVec = (base, count) => {
                const out = [];
                for (let i = 0; i < count; ++i) out.push(view.getFloat32(base + i * 4, true));
                return out;
            };
            this.deviceState(deviceHandle).lights.set(index, {
                type: view.getUint32(offset + 8, true),
                diffuse: readVec(offset + 12, 4), specular: readVec(offset + 28, 4),
                ambient: readVec(offset + 44, 4), position: readVec(offset + 60, 3),
                direction: readVec(offset + 72, 3), range: view.getFloat32(offset + 84, true),
                falloff: view.getFloat32(offset + 88, true),
                attenuation: readVec(offset + 92, 3),
                theta: view.getFloat32(offset + 104, true), phi: view.getFloat32(offset + 108, true),
            });
        }

        onLightEnable(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const index = view.getUint32(offset + 4, true);
            const enable = view.getUint32(offset + 8, true) !== 0;
            this.deviceState(deviceHandle).lightEnabled.set(index, enable);
        }

        onSetViewport(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const state = this.deviceState(deviceHandle);
            state.viewport = {
                x: view.getUint32(offset + 4, true),
                y: view.getUint32(offset + 8, true),
                width: view.getUint32(offset + 12, true),
                height: view.getUint32(offset + 16, true),
            };
        }

        onSetTransform(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const transformState = view.getUint32(offset + 4, true);
            const matrix = new Float32Array(16);
            for (let i = 0; i < 16; ++i) matrix[i] = view.getFloat32(offset + 8 + i * 4, true);
            // Stored exactly as D3D sent it (row-major, row-vector
            // convention). No transpose here -- see uniformBufferFor for why
            // none is needed anywhere on this path.
            this.deviceState(deviceHandle).transforms.set(transformState, matrix);
        }

        onSetStreamSource(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const stream = view.getUint32(offset + 4, true);
            const bufferHandle = view.getUint32(offset + 8, true);
            const stride = view.getUint32(offset + 12, true);
            const offsetInBytes = view.getUint32(offset + 16, true);
            this.deviceState(deviceHandle).streams.set(stream,
                { bufferHandle, stride, offsetInBytes });
        }

        onSetIndices(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const bufferHandle = view.getUint32(offset + 4, true);
            this.deviceState(deviceHandle).indexBufferHandle = bufferHandle;
        }

        // ---- draw pipeline ----

        // Distils the render states a WebGPU render pipeline is allowed to
        // depend on into a small plain object. WebGPU bakes depth/blend/cull
        // into the immutable pipeline (unlike D3D9, where they are free-
        // floating device state), so this is also exactly the set that has
        // to participate in the pipeline cache key.
        pipelineStateFor(state) {
            const rs = state.renderStates;
            const get = (id, fallback) => {
                const value = rs.get(id);
                return value === undefined ? fallback : value;
            };

            // D3DRS_ZENABLE defaults to on whenever a depth buffer exists;
            // with no depth attachment there is nothing to test against.
            const depthEnabled = state.hasDepth
                && get(D3DRS_ZENABLE, 1) !== D3DZB_FALSE;
            const depthWrite = get(D3DRS_ZWRITEENABLE, 1) !== 0;
            const depthCompare = this.debug.disableDepthTest ? "always"
                : (COMPARE_FUNCS[get(D3DRS_ZFUNC, 4)] || "less-equal");

            const blendEnabled = get(D3DRS_ALPHABLENDENABLE, 0) !== 0;
            const srcFactor = BLEND_FACTORS[get(D3DRS_SRCBLEND, 5)] || "src-alpha";
            const dstFactor = BLEND_FACTORS[get(D3DRS_DESTBLEND, 6)] || "one-minus-src-alpha";
            const blendOp = BLEND_OPS[get(D3DRS_BLENDOP, 1)] || "add";

            // D3D9's front face is clockwise, so D3DCULL_CW means "cull the
            // front" and D3DCULL_CCW (its default) means "cull the back".
            const cullValue = get(D3DRS_CULLMODE, D3DCULL_CCW);
            let cullMode = "none";
            if (!this.debug.disableCull) {
                if (cullValue === D3DCULL_CW) cullMode = "front";
                else if (cullValue === D3DCULL_CCW) cullMode = "back";
            }

            // D3DCOLORWRITEENABLE's RED/GREEN/BLUE/ALPHA bits happen to be
            // 1/2/4/8, matching GPUColorWrite exactly.
            const writeMask = get(D3DRS_COLORWRITEENABLE, 0xF) & 0xF;

            return { depthEnabled, depthWrite, depthCompare, blendEnabled,
                srcFactor, dstFactor, blendOp, cullMode, writeMask,
                hasDepth: !!state.hasDepth };
        }

        pipelineFor(layout, pipelineState, arrayStride) {
            const key = JSON.stringify({
                stride: arrayStride, attributes: layout.attributes,
                positionType: layout.positionType, hasColor: layout.hasColor,
                hasTexCoord: layout.hasTexCoord, format: this.format,
                state: pipelineState, shaderMode: this.debug.shaderMode,
            });
            let pipeline = this.pipelineCache.get(key);
            if (pipeline) { ++this.stats.pipelineHits; return pipeline; }
            const module = this.device.createShaderModule({
                code: buildFixedFunctionShader(layout, this.debug.shaderMode) });
            const bindGroupEntries = [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } }];
            if (layout.hasTexCoord) {
                bindGroupEntries.push(
                    { binding: 1, visibility: SHADER_STAGE_FRAGMENT, sampler: {} },
                    { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: {} });
            }
            const bindGroupLayout = this.device.createBindGroupLayout({ entries: bindGroupEntries });
            const colorTarget = { format: this.format, writeMask: pipelineState.writeMask };
            if (pipelineState.blendEnabled) {
                colorTarget.blend = {
                    color: { srcFactor: pipelineState.srcFactor,
                             dstFactor: pipelineState.dstFactor,
                             operation: pipelineState.blendOp },
                    alpha: { srcFactor: pipelineState.srcFactor,
                             dstFactor: pipelineState.dstFactor,
                             operation: pipelineState.blendOp },
                };
            }
            const descriptor = {
                layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
                vertex: {
                    module, entryPoint: "vs_main",
                    buffers: [{ arrayStride, attributes: layout.attributes }],
                },
                fragment: { module, entryPoint: "fs_main", targets: [colorTarget] },
                primitive: { topology: "triangle-list", cullMode: pipelineState.cullMode,
                             frontFace: "cw" },
            };
            // The pipeline must declare a depthStencil state whenever the
            // pass it runs in has a depth attachment, even for a draw that
            // does no depth testing -- hence depthCompare "always" plus
            // depthWriteEnabled false rather than omitting the block.
            if (pipelineState.hasDepth) {
                descriptor.depthStencil = {
                    format: DEPTH_FORMAT,
                    depthWriteEnabled: pipelineState.depthEnabled
                        ? pipelineState.depthWrite : false,
                    depthCompare: pipelineState.depthEnabled
                        ? pipelineState.depthCompare : "always",
                };
            }
            pipeline = this.device.createRenderPipeline(descriptor);
            pipeline._bindGroupLayout = bindGroupLayout;
            ++this.stats.pipelineCreations;
            this.pipelineCache.set(key, pipeline);
            return pipeline;
        }

        uniformBufferFor(state, layout) {
            const data = new Float32Array(20); // mat4x4 (16) + vec2 viewport (2) + pad (2)
            // D3D stores matrices row-major for row-vector maths (v * M);
            // WGSL reads a uniform mat4x4 column-major and applies M * v.
            // Those two conventions cancel: the *same bytes* that describe M
            // to D3D describe M-transpose to WGSL, and M-transpose is exactly
            // the column-vector form of D3D's row-vector M. So the raw
            // World*View*Projection product is uploaded unchanged.
            //
            // The previous code transposed on store *and* again here, which
            // silently reversed the multiplication order -- it evaluated
            // W^T V^T P^T where the correct column-vector form is
            // P^T V^T W^T. That is invisible whenever View and Projection are
            // identity (the case the world-transform smoke test happened to
            // cover) and wrong for every real camera.
            data.set(layout.positionType === "screen" ? IDENTITY4x4 : this.wvp(state), 0);
            data[16] = state.viewport.width || 1;
            data[17] = state.viewport.height || 1;
            const buffer = this.device.createBuffer({
                size: data.byteLength, usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, data);
            this.retireAfterSubmit(buffer);
            return buffer;
        }

        retireAfterSubmit(buffer) {
            const frame = this.ensureFrame();
            (frame.transientBuffers || (frame.transientBuffers = [])).push(buffer);
        }

        bindGroupFor(pipeline, uniformBuffer, layout, textureResource) {
            const entries = [{ binding: 0, resource: { buffer: uniformBuffer } }];
            if (layout.hasTexCoord) {
                const sampler = textureResource ? textureResource.sampler : this.fallbackSampler;
                const view_ = textureResource ? textureResource.view : this.fallbackView;
                entries.push({ binding: 1, resource: sampler }, { binding: 2, resource: view_ });
            }
            return this.device.createBindGroup({ layout: pipeline._bindGroupLayout, entries });
        }

        // Builds the pipeline/uniform buffer/bind group eagerly (none of
        // those are tied to the swapchain's current texture, so there is no
        // staleness concern in creating them now) but only *records* the
        // draw as a pending op -- see the comment on ensureFrame() for why
        // the actual pass.draw()/drawIndexed() call must wait until
        // finishFrame() replays it against a freshly-acquired texture.
        // arrayStride is the stride the application actually bound (via
        // SetStreamSource, or carried in a Draw*UP command). It must never be
        // inferred from the vertex declaration: a declaration's recognised
        // elements are only part of the vertex, so a computed stride is too
        // small whenever the format carries anything this layout skips
        // (NORMAL, extra texcoords, padding) and every vertex after the first
        // would then be fetched from the wrong offset.
        recordDraw(state, layout, vertexBuffer, vertexOffset, indexInfo, arrayStride) {
            const stride = arrayStride || layout.minStride;
            const pipelineState = this.pipelineStateFor(state);
            const pipeline = this.pipelineFor(layout, pipelineState, stride);
            const uniformBuffer = this.uniformBufferFor(state, layout);
            const textureResource = layout.hasTexCoord ? this.resources.get(state.textures.get(0)) : null;
            if (layout.hasTexCoord) {
                if (textureResource) ++this.stats.drawsWithTexture;
                else ++this.stats.drawsWithFallbackTexture;
            }
            const bindGroup = this.bindGroupFor(pipeline, uniformBuffer, layout, textureResource);
            const frame = this.ensureFrame();
            // Pin the depth view the whole frame will use. Pipelines bake in
            // whether a depth attachment is present, so a frame cannot mix
            // depth and no-depth passes; the first draw that needs one
            // decides it for the frame.
            if (frame.depthView === undefined) {
                frame.depthView = state.depthView || null;
                frame.depthWidth = state.depthWidth;
                frame.depthHeight = state.depthHeight;
            }
            frame.ops.push({
                kind: "draw", pipeline, bindGroup,
                viewport: { ...state.viewport },
                vertexBuffer, vertexOffset, indexInfo,
            });
            if (indexInfo) ++this.stats.indexedDrawCalls;
            else ++this.stats.drawCalls;
        }

        // Every draw path below can bail out for several different reasons,
        // and silently dropping them looks identical to "the app never drew"
        // from the outside -- exactly the blind spot that hid a stalled
        // renderer behind healthy-looking batch/present counters. Count every
        // drop and describe the first one in full.
        noteDroppedDraw(which, state, reasons) {
            ++this.stats.droppedDraws;
            if (this.droppedDrawReported) return;
            this.droppedDrawReported = true;
            const declaration = this.resources.get(state.vertexDeclarationHandle);
            console.warn("[d3d9-webgpu] " + which + " dropped: " +
                reasons.join("; "), {
                    reasons,
                    hasFvfLayout: !!state.fvfLayout,
                    vertexDeclarationHandle: state.vertexDeclarationHandle,
                    declarationResourceFound: !!declaration,
                    declarationLayoutNull: declaration ? !declaration.layout : null,
                    declarationElementCount: declaration && declaration.elements
                        ? declaration.elements.length : null,
                    declarationElements: declaration ? declaration.elements : null,
                    stream0: state.streams.get(0) || null,
                    indexBufferHandle: state.indexBufferHandle,
                    resourceCount: this.resources.size,
                });
        }

        onDrawPrimitive(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const startVertex = view.getUint32(offset + 8, true);
            const primitiveCount = view.getUint32(offset + 12, true);
            const state = this.deviceState(deviceHandle);
            const layout = this.currentLayout(state);
            const stream = state.streams.get(0);
            const vb = stream && this.resources.get(stream.bufferHandle);
            if (!layout || !vb) {
                const reasons = [];
                if (!layout) reasons.push("no vertex layout (SetFVF/SetVertexDeclaration)");
                if (!stream) reasons.push("stream 0 not bound");
                else if (!vb) reasons.push("stream 0 vertex buffer resource missing");
                this.noteDroppedDraw("DrawPrimitive", state, reasons);
                return;
            }
            const vertexCount = primitiveElementCount(primitiveType, primitiveCount);
            if (vertexCount === null) {
                this.noteDroppedDraw("DrawPrimitive", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            const buffer = vb.gpuBuffer;
            buffer._d9wgCount = vertexCount;
            this.recordDraw(state, layout, buffer,
                (stream.offsetInBytes || 0) + startVertex * stream.stride, null,
                stream.stride);
        }

        onDrawIndexedPrimitive(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const baseVertexIndex = view.getInt32(offset + 8, true);
            const startIndex = view.getUint32(offset + 20, true);
            const primitiveCount = view.getUint32(offset + 24, true);
            const state = this.deviceState(deviceHandle);
            const layout = this.currentLayout(state);
            const stream = state.streams.get(0);
            const vb = stream && this.resources.get(stream.bufferHandle);
            const ib = this.resources.get(state.indexBufferHandle);
            if (!layout || !vb || !ib) {
                const reasons = [];
                if (!layout) reasons.push("no vertex layout (SetFVF/SetVertexDeclaration)");
                if (!stream) reasons.push("stream 0 not bound");
                else if (!vb) reasons.push("stream 0 vertex buffer resource missing");
                if (!ib) reasons.push("index buffer resource missing");
                this.noteDroppedDraw("DrawIndexedPrimitive", state, reasons);
                return;
            }
            const indexCount = primitiveElementCount(primitiveType, primitiveCount);
            if (indexCount === null) {
                this.noteDroppedDraw("DrawIndexedPrimitive", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            this.recordDraw(state, layout, vb.gpuBuffer,
                stream.offsetInBytes || 0, {
                    buffer: ib.gpuBuffer, format: ib.indexFormat, offset: 0,
                    count: indexCount, firstIndex: startIndex,
                    baseVertex: baseVertexIndex,
                }, stream.stride);
        }

        onDrawPrimitiveUP(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const primitiveCount = view.getUint32(offset + 8, true);
            const stride = view.getUint32(offset + 12, true);
            const vertexCount = view.getUint32(offset + 16, true);
            const vertexBytes = view.getUint32(offset + 20, true);
            const dataOffset = view.getUint32(offset + 24, true);
            const state = this.deviceState(deviceHandle);
            const layout = this.currentLayout(state);
            if (!layout) {
                this.noteDroppedDraw("DrawPrimitiveUP", state,
                    ["no vertex layout (SetFVF/SetVertexDeclaration)"]);
                return;
            }
            const elementCount = primitiveElementCount(primitiveType, primitiveCount);
            if (elementCount === null) {
                this.noteDroppedDraw("DrawPrimitiveUP", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            const buffer = this.device.createBuffer({
                size: Math.max(4, alignUp(vertexBytes, 4)),
                usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
            });
            this.writeBufferAligned(buffer, 0, bytes, dataOffset, vertexBytes);
            this.retireAfterSubmit(buffer);
            buffer._d9wgCount = elementCount;
            this.recordDraw(state, layout, buffer, 0, null, stride);
            ++this.stats.upDrawCalls;
        }

        onDrawIndexedPrimitiveUP(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const primitiveCount = view.getUint32(offset + 16, true);
            const indexFormatValue = view.getUint32(offset + 20, true);
            const indexCount = view.getUint32(offset + 28, true);
            const indexBytes = view.getUint32(offset + 32, true);
            const vertexBytes = view.getUint32(offset + 36, true);
            const indexDataOffset = view.getUint32(offset + 40, true);
            const vertexDataOffset = view.getUint32(offset + 44, true);
            const state = this.deviceState(deviceHandle);
            const layout = this.currentLayout(state);
            if (!layout) {
                this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                    ["no vertex layout (SetFVF/SetVertexDeclaration)"]);
                return;
            }
            const elementCount = primitiveElementCount(primitiveType, primitiveCount);
            if (elementCount === null) {
                this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            const vertexBuffer = this.device.createBuffer({
                size: Math.max(4, alignUp(vertexBytes, 4)),
                usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
            });
            const indexBuffer = this.device.createBuffer({
                size: Math.max(4, alignUp(indexBytes, 4)),
                usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST,
            });
            this.writeBufferAligned(vertexBuffer, 0, bytes, vertexDataOffset, vertexBytes);
            this.writeBufferAligned(indexBuffer, 0, bytes, indexDataOffset, indexBytes);
            this.retireAfterSubmit(vertexBuffer);
            this.retireAfterSubmit(indexBuffer);
            this.recordDraw(state, layout, vertexBuffer, 0, {
                buffer: indexBuffer, format: indexFormatValue === D3DFMT_INDEX32 ? "uint32" : "uint16",
                offset: 0, count: elementCount, firstIndex: 0, baseVertex: 0,
            }, stride);
            ++this.stats.upDrawCalls;
            ++this.stats.indexedDrawCalls;
        }
    }

    function primitiveElementCount(type, primitiveCount) {
        switch (type) {
        case D3DPT_POINTLIST: return primitiveCount;
        case D3DPT_LINELIST: return primitiveCount * 2;
        case D3DPT_LINESTRIP: return primitiveCount + 1;
        case D3DPT_TRIANGLELIST: return primitiveCount * 3;
        case D3DPT_TRIANGLESTRIP:
        case D3DPT_TRIANGLEFAN: return primitiveCount + 2;
        default: return null;
        }
    }

    global.D3D9WebGPUExecutor = D3D9WebGPUExecutor;
    global.installD3D9WebGPUExecutor = function(canvas, options) {
        return new D3D9WebGPUExecutor(canvas, options);
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            D3D9WebGPUExecutor,
            V86GL_CTRL_D3D9_BATCH: 0xFFE1,
        };
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
