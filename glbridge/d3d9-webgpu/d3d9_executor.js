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
// fixed-function XYZ/XYZRHW draw path with no programmable shaders.
//
// M2 adds shader model 2.0: CREATE/SET_{VERTEX,PIXEL}_SHADER translated to
// WGSL by d3d9_shader_pipeline.js, the float/int/bool constant register file
// packed into a uniform buffer (plan 9.7), independent sampler state driving
// a GPUSampler cache (plan 4.4/12), and multi-stream vertex declarations.
//
// The fixed-function and programmable paths are one path, not two. Both
// stages are always separate GPUShaderModules meeting over a fixed
// inter-stage varying contract (COLOR0/COLOR1 at locations 0-1, TEXCOORD0..7
// at 2-9, FOG at 10 -- see VARYING_* in d3d9_shader_pipeline.js), with the
// fixed-function stage synthesised into a module that obeys the same
// contract. That is what makes the mixed configurations D3D9 allows work at
// all: fixed-function T&L feeding a real pixel shader, or a vertex shader
// feeding the fixed-function texture pipeline, are both routine in games of
// this era and neither would link if each path had its own varying layout.
//
// Every other D9WG opcode already has a number reserved in d3d9_protocol.h
// for a later milestone, but the guest never emits it yet, so this executor
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

    const shaderPipeline = global.D3D9ShaderPipeline ||
        (typeof require === "function" ? require("./d3d9_shader_pipeline.js") : null);
    if (!shaderPipeline)
        throw new Error("d3d9_executor.js requires d3d9_shader_pipeline.js to " +
            "be loaded first");

    const D9WG_MAGIC = 0x47573944; // "D9WG"
    const D9WG_VERSION_MAJOR = 1;
    const D9WG_VERSION_MINOR = 0;
    const D9WG_BATCH_HEADER_BYTES = 32;
    const D9WG_COMMAND_HEADER_BYTES = 16;
    const D9WG_BATCH_FLAG_PRESENT = 1 << 0;
    const D9WG_FEATURE_SHADER_MODEL_2 = 1 << 0;

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
    const OP_CREATE_VERTEX_SHADER = 0x121;
    const OP_CREATE_PIXEL_SHADER = 0x122;
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
    const OP_SET_CURSOR_PROPERTIES = 0x21A;
    const OP_SET_CURSOR_POSITION = 0x21B;
    const OP_SHOW_CURSOR = 0x21C;
    const OP_WINDOW_STATE = 0x21D;
    const D9WG_WINDOW_IS_WINDOW = 1 << 0;
    const D9WG_WINDOW_VISIBLE = 1 << 1;
    const D9WG_WINDOW_ICONIC = 1 << 2;
    const D9WG_WINDOW_FOREGROUND = 1 << 3;
    const D9WG_WINDOW_FULLSCREEN = 1 << 4;
    const OP_SET_VERTEX_SHADER = 0x211;
    const OP_SET_PIXEL_SHADER = 0x212;
    const OP_SET_VERTEX_SHADER_CONSTANT_F = 0x213;
    const OP_SET_VERTEX_SHADER_CONSTANT_I = 0x214;
    const OP_SET_VERTEX_SHADER_CONSTANT_B = 0x215;
    const OP_SET_PIXEL_SHADER_CONSTANT_F = 0x216;
    const OP_SET_PIXEL_SHADER_CONSTANT_I = 0x217;
    const OP_SET_PIXEL_SHADER_CONSTANT_B = 0x218;
    const OP_DRAW_PRIMITIVE = 0x300;
    const OP_DRAW_INDEXED_PRIMITIVE = 0x301;
    const OP_DRAW_PRIMITIVE_UP = 0x302;
    const OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303;

    const RESOURCE_BUFFER_VERTEX = 1;
    const RESOURCE_BUFFER_INDEX = 2;
    const RESOURCE_TEXTURE_2D = 3;
    const RESOURCE_VERTEX_DECLARATION = 6;
    const RESOURCE_VERTEX_SHADER = 7;
    const RESOURCE_PIXEL_SHADER = 8;

    // Constant register file sizes, matching D9_MAX_* in d3d9_proxy.c.
    const MAX_VS_CONST_F = 256;
    const MAX_PS_CONST_F = 224;
    const MAX_CONST_I = 16;
    const MAX_CONST_B = 16;
    const MAX_SAMPLERS = 16;
    const MAX_STREAMS = 4;
    // WebGPU's minUniformBufferOffsetAlignment default. The vertex and pixel
    // constant regions share one buffer, so the pixel region starts here.
    const UNIFORM_OFFSET_ALIGNMENT = 256;

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
    const D3DRS_ALPHAREF = 24;
    const D3DRS_ALPHAFUNC = 25;
    const D3DRS_SRCBLEND = 19;
    const D3DRS_DESTBLEND = 20;
    const D3DRS_CULLMODE = 22;
    const D3DRS_ZFUNC = 23;
    const D3DRS_ALPHABLENDENABLE = 27;
    const D3DRS_COLORWRITEENABLE = 168;
    const D3DRS_BLENDOP = 171;
    // Fixed-function fog. fill_caps() in d3d9_proxy.c advertises
    // D3DPRASTERCAPS_FOGVERTEX/FOGTABLE/WFOG, so a game is entitled to expect
    // these to work; ignoring them left Warcraft III's fogged scenery drawn at
    // full texture colour with none of the atmospheric tint.
    const D3DRS_FOGENABLE = 28;
    const D3DRS_FOGCOLOR = 34;
    const D3DRS_FOGTABLEMODE = 35;
    const D3DRS_FOGSTART = 36;
    const D3DRS_FOGEND = 37;
    const D3DRS_FOGDENSITY = 38;
    const D3DRS_FOGVERTEXMODE = 140;
    const D3DRS_LIGHTING = 137;
    const D3DRS_AMBIENT = 139;
    // D3DFOGMODE
    const D3DFOG_NONE = 0, D3DFOG_EXP = 1, D3DFOG_EXP2 = 2, D3DFOG_LINEAR = 3;

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

    // D3DDECLUSAGE / D3DDECLTYPE, the subset d3d9_proxy.c's
    // declaration_element_supported() lets through.
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

    // D3DDECLTYPE -> [GPUVertexFormat, byte size]. D3DCOLOR is read as raw
    // little-endian BGRA bytes by unorm8x4, so anything consuming it has to
    // swizzle; both shader generators below do that at the point where the
    // attribute is copied into its register, never with a CPU pass over the
    // vertex data.
    const DECLTYPE_FORMATS = {
        [DECLTYPE_FLOAT1]: ["float32", 4],
        [DECLTYPE_FLOAT2]: ["float32x2", 8],
        [DECLTYPE_FLOAT3]: ["float32x3", 12],
        [DECLTYPE_FLOAT4]: ["float32x4", 16],
        [DECLTYPE_D3DCOLOR]: ["unorm8x4", 4],
        8: ["unorm8x4", 4],    // D3DDECLTYPE_UBYTE4N
        9: ["snorm16x2", 4],   // D3DDECLTYPE_SHORT2N
        10: ["snorm16x4", 8],  // D3DDECLTYPE_SHORT4N
        11: ["unorm16x2", 4],  // D3DDECLTYPE_USHORT2N
        12: ["unorm16x4", 8],  // D3DDECLTYPE_USHORT4N
        15: ["float16x2", 4],  // D3DDECLTYPE_FLOAT16_2
        16: ["float16x4", 8],  // D3DDECLTYPE_FLOAT16_4
    };

    // D3DSAMPLERSTATETYPE, and the enums its values come from.
    const D3DSAMP_ADDRESSU = 1;
    const D3DSAMP_ADDRESSV = 2;
    const D3DSAMP_ADDRESSW = 3;
    const D3DSAMP_MAGFILTER = 5;
    const D3DSAMP_MINFILTER = 6;
    const D3DSAMP_MIPFILTER = 7;
    const D3DSAMP_MAXANISOTROPY = 10;

    // D3DTEXTUREADDRESS -> GPUAddressMode. WebGPU has no BORDER mode and no
    // MIRRORONCE; both fall back to clamp-to-edge, which is the closest
    // available behaviour and is noted once per occurrence rather than
    // silently substituted.
    const ADDRESS_MODES = [
        undefined, "repeat", "mirror-repeat", "clamp-to-edge",
        "clamp-to-edge", "clamp-to-edge",
    ];
    // D3DTEXTUREFILTERTYPE -> GPUFilterMode. ANISOTROPIC becomes linear plus
    // a maxAnisotropy value; PYRAMIDALQUAD/GAUSSIANQUAD have no equivalent.
    const FILTER_MODES = [
        "nearest", "nearest", "linear", "linear",
        "linear", "linear", "linear",
    ];

    const D3DTS_VIEW = 2;
    const D3DTS_PROJECTION = 3;
    const D3DTS_WORLD = 256;
    const D3DTS_TEXTURE0 = 16;

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

    const TEXTURE_FORMAT_NAMES = {
        21: "A8R8G8B8", 22: "X8R8G8B8", 23: "R5G6B5", 24: "X1R5G5B5",
        25: "A1R5G5B5", 26: "A4R4G4B4", 28: "A8", 50: "L8",
        0x31545844: "DXT1", 0x33545844: "DXT3", 0x35545844: "DXT5",
    };

    // D3D9 stores FOGSTART/FOGEND/FOGDENSITY as float bits inside a DWORD.
    const FLOAT_BITS_BUFFER = new ArrayBuffer(4);
    const FLOAT_BITS_U32 = new Uint32Array(FLOAT_BITS_BUFFER);
    const FLOAT_BITS_F32 = new Float32Array(FLOAT_BITS_BUFFER);

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

    // The inter-stage contract shared with translated shaders. Both stages
    // always agree on it, whichever of the four VS/PS combinations a draw
    // uses (see the file header).
    const VARYING_COUNT = shaderPipeline.VARYING_COUNT;
    const VARYING_COLOR0 = shaderPipeline.VARYING_COLOR0;
    const VARYING_TEXCOORD0 = shaderPipeline.VARYING_TEXCOORD0;

    // Vertex attribute locations the fixed-function vertex stage consumes.
    // These are assigned by *semantic*, not by the element's position in the
    // declaration array. M1 assigned them by iteration order and hardcoded
    // position/colour/texcoord as locations 0/1/2 in the WGSL, which agreed
    // only for declarations that happened to list the elements in that
    // order; a declaration with TEXCOORD before COLOR silently fed the
    // texcoord bytes into the colour attribute.
    const FF_LOCATION_POSITION = 0;
    const FF_LOCATION_COLOR0 = 1;
    const FF_LOCATION_TEXCOORD0 = 2;

    // D3D9's alpha test has no fixed-function equivalent in WebGPU: it has to
    // become a `discard` in the fragment shader, which means the comparison
    // and the reference value are baked into the shader and therefore into
    // the pipeline key. Returns "" when no test is needed.
    //
    // This matters far beyond a subtle shading difference. UI atlases and
    // billboarded foliage lean on alpha test to cut fully transparent texels;
    // without it those texels are drawn opaque, which reads as wrong or
    // missing texture on exactly the panels and edges that should be cut out.
    //
    // D3DCMPFUNC values are 1..8; the expression below is the *discard*
    // condition, i.e. the negation of "the fragment passes".
    function alphaTestDiscard(alphaTest, alphaExpression) {
        if (!alphaTest || !alphaTest.enabled) return "";
        const reference = (alphaTest.reference / 255).toFixed(6);
        const condition = {
            1: "true",                                        // NEVER
            2: "!(" + alphaExpression + " < " + reference + ")",   // LESS
            3: "!(" + alphaExpression + " == " + reference + ")",  // EQUAL
            4: "!(" + alphaExpression + " <= " + reference + ")",  // LESSEQUAL
            5: "!(" + alphaExpression + " > " + reference + ")",   // GREATER
            6: "!(" + alphaExpression + " != " + reference + ")",  // NOTEQUAL
            7: "!(" + alphaExpression + " >= " + reference + ")",  // GREATEREQUAL
        }[alphaTest.func];
        if (!condition) return ""; // ALWAYS (8) and anything unknown: no test
        return "    if (" + condition + ") { discard; }\n";
    }

    function fixedFunctionLocationFor(element) {
        if (element.usage === DECLUSAGE_POSITION ||
                element.usage === DECLUSAGE_POSITIONT)
            return element.usageIndex === 0 ? FF_LOCATION_POSITION : -1;
        if (element.usage === DECLUSAGE_COLOR && element.usageIndex === 0)
            return FF_LOCATION_COLOR0;
        if (element.usage === DECLUSAGE_TEXCOORD && element.usageIndex === 0)
            return FF_LOCATION_TEXCOORD0;
        // NORMAL/PSIZE/specular/extra texcoords are accepted by the guest's
        // declaration validator (so lit vertex data does not have to be
        // reformatted) but the fixed-function stage does not read them.
        return -1;
    }

    // The WGSL declaration for a vertex attribute is always vec4<f32>: WebGPU
    // fills the components a narrower vertex format does not supply with
    // (_, 0, 0, 1), which is exactly D3D9's rule for a FLOAT3 POSITION or a
    // FLOAT2 texcoord. One declared type per location also keeps a shader
    // module independent of which declaration is bound with it.
    function vertexInputDeclaration(location) {
        return "@location(" + location + ") in" + location + ": vec4<f32>";
    }

    // Fixed-function vertex stage: position transform plus diffuse/texcoord
    // passthrough into the shared varying set. `signature` comes from
    // fixedFunctionVertexSignature().
    function buildFixedFunctionVertexShader(signature) {
        const parameters = [vertexInputDeclaration(FF_LOCATION_POSITION)];
        if (signature.hasColor) parameters.push(vertexInputDeclaration(FF_LOCATION_COLOR0));
        if (signature.hasTexCoord) parameters.push(vertexInputDeclaration(FF_LOCATION_TEXCOORD0));
        const varyings = [];
        for (let slot = 0; slot < VARYING_COUNT; ++slot)
            varyings.push("    @location(" + slot + ") varying" + slot + ": vec4<f32>,");
        // XYZRHW ("screen") vertices arrive already in viewport pixel space
        // and bypass the world/view/projection chain entirely.
        const positionBody = signature.positionType === "screen"
            ? `    let viewport = uniforms.viewport;
    let ndc_x = (in${FF_LOCATION_POSITION}.x / viewport.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (in${FF_LOCATION_POSITION}.y / viewport.y) * 2.0;
    result.position = vec4<f32>(ndc_x, ndc_y, in${FF_LOCATION_POSITION}.z, 1.0);`
            : `    result.position = uniforms.world_view_projection * in${FF_LOCATION_POSITION};`;
        // D3DTTFF_COUNT2: the 2D texture coordinate is transformed by the
        // D3DTS_TEXTURE0 matrix as a row vector (u, v, 1, 1), which is why a
        // game's scrolling matrix puts its offset in row 3 (_31/_32). The
        // matrix is uploaded unchanged for the same reason the WVP is: D3D's
        // row-major bytes read back as the transpose in WGSL, and that
        // transpose is exactly the column-vector form of the row-vector
        // multiply.
        // Fog distance is the clip-space w, which for a standard projection
        // is the eye-space depth -- that is exactly D3DPRASTERCAPS_WFOG, which
        // the guest already advertises. Only the RGB is fogged; alpha is left
        // alone, as D3D9 specifies.
        const fogFactor = {
            [D3DFOG_LINEAR]: "clamp((uniforms.fog_params.y - fog_distance) / " +
                "max(uniforms.fog_params.y - uniforms.fog_params.x, 1e-6), 0.0, 1.0)",
            [D3DFOG_EXP]: "clamp(exp(-(uniforms.fog_params.z * fog_distance)), 0.0, 1.0)",
            [D3DFOG_EXP2]: "clamp(exp(-((uniforms.fog_params.z * fog_distance) * " +
                "(uniforms.fog_params.z * fog_distance))), 0.0, 1.0)",
        }[signature.fogMode];
        const fogBody = fogFactor
            ? "    let fog_distance = abs(result.position.w);\n" +
              "    result.varying" + shaderPipeline.VARYING_FOG +
              " = vec4<f32>(" + fogFactor + ", 0.0, 0.0, 0.0);\n"
            : "";
        const texcoordExpression = signature.textureTransform
            ? `(uniforms.texture_transform * vec4<f32>(in${FF_LOCATION_TEXCOORD0}.xy, 1.0, 1.0))`
            : `in${FF_LOCATION_TEXCOORD0}`;
        return `struct D9FixedUniforms {
    world_view_projection: mat4x4<f32>,
    viewport: vec2<f32>,
    _pad: vec2<f32>,
    texture_transform: mat4x4<f32>,
    fog_color: vec4<f32>,
    fog_params: vec4<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: D9FixedUniforms;

struct D9VertexOutput {
    @builtin(position) position: vec4<f32>,
${varyings.join("\n")}
};

@vertex
fn d9_vs_main(${parameters.join(", ")}) -> D9VertexOutput {
    var result: D9VertexOutput;
${positionBody}
${varyings.map((_, slot) =>
        "    result.varying" + slot + " = vec4<f32>(0.0);").join("\n")}
    result.varying${VARYING_COLOR0} = ${signature.hasColor
        ? `in${FF_LOCATION_COLOR0}${signature.colorIsBGRA ? ".bgra" : ""}`
        : "vec4<f32>(1.0, 1.0, 1.0, 1.0)"};
    result.varying${VARYING_TEXCOORD0} = ${signature.hasTexCoord
        ? texcoordExpression : "vec4<f32>(0.0)"};
${fogBody}    return result;
}
`;
    }

    // Fixed-function pixel stage: diffuse modulated by stage 0's texture,
    // which is the only texture-stage combination M1 implemented and M2 does
    // not extend (the D3DTOP_* operation matrix is M3 work).
    // debugMode (null in normal operation) replaces the output with something
    // unambiguous, so "the screen is black" can be attributed to a specific
    // input rather than guessed at:
    //   "solid"   flat green  -- proves geometry coverage and that fragments land
    //   "color"   vertex colour only, texture ignored
    //   "texture" texture sample only, vertex colour ignored
    //   "uv"      texcoords as red/green -- shows whether UVs are sane
    function buildFixedFunctionPixelShader(signature, debugMode) {
        const hasTexture = signature.hasTexture;
        const color = "stage_in.varying" + VARYING_COLOR0;
        const texcoord = "stage_in.varying" + VARYING_TEXCOORD0 + ".xy";
        const sample = "textureSample(d9_tex0, d9_smp0, " + texcoord + ")";
        let value;
        if (debugMode === "solid") value = "vec4<f32>(0.0, 1.0, 0.0, 1.0)";
        else if (debugMode === "color") value = "vec4<f32>(" + color + ".rgb, 1.0)";
        else if (debugMode === "uv")
            value = hasTexture ? "vec4<f32>(" + texcoord + ", 0.0, 1.0)"
                : "vec4<f32>(0.0, 0.0, 1.0, 1.0)";
        else if (debugMode === "texture")
            value = hasTexture ? "vec4<f32>(" + sample + ".rgb, 1.0)"
                : "vec4<f32>(1.0, 0.0, 0.0, 1.0)";
        else
            value = hasTexture ? color + " * " + sample : color;
        // The fog colour lives in the pixel stage's own uniform (binding 1),
        // which the fixed-function path otherwise leaves unused.
        const fogBody = signature.fogMode
            ? "    let fogged = vec4<f32>(mix(fog.color.rgb, result.rgb,\n" +
              "        clamp(stage_in.varying" + shaderPipeline.VARYING_FOG +
              ".x, 0.0, 1.0)), result.a);\n"
            : "";
        const body = "let result = " + value + ";\n" +
            alphaTestDiscard(signature.alphaTest, "result.a") +
            fogBody +
            "    return " + (signature.fogMode ? "fogged" : "result") + ";";
        const varyings = [];
        for (let slot = 0; slot < VARYING_COUNT; ++slot)
            varyings.push("    @location(" + slot + ") varying" + slot + ": vec4<f32>,");
        return `${signature.fogMode ? "struct D9FixedPixel { color: vec4<f32> };" : ""}
${signature.fogMode ? "@group(0) @binding(1) var<uniform> fog: D9FixedPixel;" : ""}
${hasTexture ? "@group(0) @binding(2) var d9_tex0: texture_2d<f32>;" : ""}
${hasTexture ? "@group(0) @binding(3) var d9_smp0: sampler;" : ""}

struct D9PixelInput {
    @builtin(position) position: vec4<f32>,
${varyings.join("\n")}
};

@fragment
fn d9_ps_main(stage_in: D9PixelInput) -> @location(0) vec4<f32> {
    ${body}
}
`;
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
            // Bytecode hash -> {ok, wgsl, reflection}. Survives device loss:
            // WGSL text is not tied to a GPUDevice (plan 8.5), only the
            // GPUShaderModules in moduleCache are.
            this.shaderCache = new shaderPipeline.D3D9ShaderCache();
            this.moduleCache = new Map();  // wgsl -> GPUShaderModule
            this.samplerCache = new Map(); // sampler-state signature -> GPUSampler
            // D3D9 hardware cursor: bitmap, hotspot, position, visibility.
            this.cursor = { texture: null, view: null, width: 0, height: 0,
                hotspotX: 0, hotspotY: 0, x: 0, y: 0, visible: false,
                pipeline: null, sampler: null, uniform: null };
            this.fallbackTexture = null;
            this.fallbackView = null;
            this.frame = null;             // { ops, transientBuffers, serial }
            this.frameSerial = 0;
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
                // Clamps every sampler to the top mip level. If a texture
                // looks wrong because levels below 0 were never uploaded,
                // this makes it correct immediately -- which is the cheapest
                // way to confirm or rule out that cause.
                forceMipLevel0: false,
            };
            this.debug.dumpSmallTextures = o => this.dumpSmallTextures(o);
            this.debug.dumpPipelineStates = () => this.dumpPipelineStates();
            this.stats = {
                batches: 0, commands: 0, presents: 0, queueSubmits: 0,
                drawCalls: 0, indexedDrawCalls: 0, upDrawCalls: 0,
                pipelineCreations: 0, pipelineHits: 0,
                unsupportedCommands: 0, malformedBatches: 0,
                droppedDraws: 0,
                texturesCreated: 0, textureUploads: 0, textureBytesUploaded: 0,
                drawsWithTexture: 0, drawsWithFallbackTexture: 0,
                shadersTranslated: 0, shaderTranslationFailures: 0,
                shaderVariantsTranslated: 0,
                shaderModulesCreated: 0, shaderCompileErrors: 0,
                samplersCreated: 0, samplerHits: 0,
                // Flicker diagnostics. WebGPU does not preserve a canvas's
                // contents across Present, so a frame that draws without ever
                // clearing the colour target composites on top of an
                // undefined older swapchain buffer -- which looks like
                // alternating frames, i.e. flicker. Likewise a present that
                // produced no GPU work at all leaves whatever was composited
                // last on screen. Both are legal D3D9 behaviour, so they are
                // counted rather than warned about.
                framesWithoutColorClear: 0, framesWithNoOps: 0,
                // Dynamic buffers renamed because a draw already recorded in
                // the same frame reads their previous contents (see
                // applyBufferUpdate). Zero means the deferred-draw path never
                // had a write-after-record hazard to begin with.
                bufferRenames: 0, textureUpdateHazards: 0,
                bufferFullCopyRenames: 0, bufferNoOverwriteWrites: 0,
                emptySurfaceReports: 0, surfaceChanges: 0,
                guestFeatureBits: 0, guestShaderModel2: false,
                windowStateChanges: 0,
                cursorUploads: 0, cursorDraws: 0,
                drawsWithIncompleteMipChain: 0,
                lastDrawTexture: 0,
                drawsWithUnsupportedTextureOp: 0,
                drawsWithTexCoordIndex: 0, drawsWithTextureTransform: 0,
                drawsWithUnmappedBlend: 0, drawsWithUnappliedFog: 0,
                drawsWithUnappliedLighting: 0,
                programmableDraws: 0, drawsSkippedForBadShader: 0,
                constantUploadBytes: 0,
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
                samplerStates: new Map(), // sampler*64+state -> value, read by samplerFor()
                textureStageStates: new Map(),
                vertexShaderHandle: 0,
                pixelShaderHandle: 0,
                // The D3D9 constant register file. Device state, not shader
                // state: it survives SetVertexShader and Reset, so it lives
                // here and is packed into a uniform buffer per draw by
                // constantBufferFor(). Kept as flat typed arrays because the
                // packing step is a straight subarray copy.
                vsConstF: new Float32Array(MAX_VS_CONST_F * 4),
                vsConstI: new Int32Array(MAX_CONST_I * 4),
                vsConstB: new Uint32Array(MAX_CONST_B),
                psConstF: new Float32Array(MAX_PS_CONST_F * 4),
                psConstI: new Int32Array(MAX_CONST_I * 4),
                psConstB: new Uint32Array(MAX_CONST_B),
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
                [OP_CREATE_VERTEX_SHADER]: this.onCreateVertexShader,
                [OP_CREATE_PIXEL_SHADER]: this.onCreatePixelShader,
                [OP_SET_CURSOR_PROPERTIES]: this.onSetCursorProperties,
                [OP_SET_CURSOR_POSITION]: this.onSetCursorPosition,
                [OP_SHOW_CURSOR]: this.onShowCursor,
                [OP_WINDOW_STATE]: this.onWindowState,
                [OP_SET_VERTEX_SHADER]: this.onSetVertexShader,
                [OP_SET_PIXEL_SHADER]: this.onSetPixelShader,
                [OP_SET_VERTEX_SHADER_CONSTANT_F]: this.onSetVertexShaderConstantF,
                [OP_SET_VERTEX_SHADER_CONSTANT_I]: this.onSetVertexShaderConstantI,
                [OP_SET_VERTEX_SHADER_CONSTANT_B]: this.onSetVertexShaderConstantB,
                [OP_SET_PIXEL_SHADER_CONSTANT_F]: this.onSetPixelShaderConstantF,
                [OP_SET_PIXEL_SHADER_CONSTANT_I]: this.onSetPixelShaderConstantI,
                [OP_SET_PIXEL_SHADER_CONSTANT_B]: this.onSetPixelShaderConstantB,
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
            const featureBits = view.getUint32(offset + 4, true);
            this.stats.guestFeatureBits = featureBits;
            // The host executor reloads with the page; the guest DLL lives
            // inside the disk image. "New host, stale guest" is the normal
            // state after a milestone lands, and it looks exactly like "this
            // scene uses no shaders" -- both show shadersTranslated: 0. This
            // makes getStats() answer the question directly.
            this.stats.guestShaderModel2 =
                (featureBits & D9WG_FEATURE_SHADER_MODEL_2) !== 0;
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
            let width = view.getUint32(offset + 16, true);
            let height = view.getUint32(offset + 20, true);
            // The guest recomputes the client rect on every Present, and
            // GetClientRect is known to return an empty rect in fullscreen
            // (recorded as an open issue at M1). Letting a 0x0 report through
            // makes the host repeatedly resize/reposition the overlay canvas
            // between the real size and nothing, which reads on screen as
            // flicker. The last non-empty size is the better answer: a window
            // that genuinely has no client area has nothing to show anyway.
            if (!width || !height) {
                ++this.stats.emptySurfaceReports;
                width = state.surface.width || width;
                height = state.surface.height || height;
            }
            const changed = state.surface.hwnd !== hwnd || state.surface.x !== x ||
                state.surface.y !== y || state.surface.width !== width ||
                state.surface.height !== height;
            state.surface = { ...state.surface, hwnd, x, y, width, height, visible: true };
            if (changed) {
                ++this.stats.surfaceChanges;
                this.notifySurface(state, "present");
            }
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
            // `serial` identifies this frame for the write-after-record check in
            // applyBufferUpdate(); it must be unique per frame, never reused.
            this.frame = { ops: [], transientBuffers: [], serial: ++this.frameSerial };
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
            if (!frame.ops.length) ++this.stats.framesWithNoOps;
            else if (!frame.ops.some(op => op.kind === "clear" && op.clearsColor))
                ++this.stats.framesWithoutColorClear;
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
                        for (let slot = 0; slot < op.vertexBuffers.length; ++slot) {
                            const binding = op.vertexBuffers[slot];
                            pass.setVertexBuffer(slot, binding.buffer, binding.offset);
                        }
                        if (op.indexInfo) {
                            pass.setIndexBuffer(op.indexInfo.buffer, op.indexInfo.format,
                                    op.indexInfo.offset);
                            pass.drawIndexed(op.indexInfo.count, 1,
                                    op.indexInfo.firstIndex, op.indexInfo.baseVertex);
                        } else {
                            // StartVertex is already folded into each stream's
                            // setVertexBuffer offset (see boundStreams), so
                            // firstVertex stays 0 here.
                            pass.draw(op.vertexCount || 0);
                        }
                    }
                }
                if (pass) pass.end();
                this.drawCursor(encoder, targetView, swapTexture.width,
                        swapTexture.height);
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

        // v86gl.d3d9Executor.debug.dumpSmallTextures() -> data: URLs that can
        // be opened straight from the console. Only uncompressed top-level
        // images up to 64x64 are retained (see onUpdateTexture).
        dumpSmallTextures(options) {
            const settings = options || {};
            const out = [];
            for (const [handle, resource] of this.resources) {
                if (!resource.preview) continue;
                if (settings.handle !== undefined && handle !== settings.handle)
                    continue;
                const { width, height, rgba } = resource.preview;
                let url = null;
                let error = null;
                try {
                    // A plain <canvas>, not OffscreenCanvas: only the former
                    // has toDataURL. OffscreenCanvas offers convertToBlob,
                    // which is async and cannot be returned from here -- that
                    // mismatch is why the first version of this helper
                    // reported url: null for every texture.
                    if (typeof document === "undefined")
                        throw new Error("no document to render into");
                    const canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext("2d");
                    const image = context.createImageData(width, height);
                    image.data.set(rgba.subarray(0, width * height * 4));
                    context.putImageData(image, 0, 0);
                    url = canvas.toDataURL();
                } catch (failure) {
                    error = failure && failure.message ? failure.message
                        : String(failure);
                }
                const entry = { handle, format: resource.format,
                    formatName: TEXTURE_FORMAT_NAMES[resource.format] ||
                        ("0x" + (resource.format >>> 0).toString(16)),
                    size: width + "x" + height,
                    declaredLevels: resource.levelCount,
                    uploadedLevels: resource.uploadedLevels
                        ? [...resource.uploadedLevels].sort((a, b) => a - b) : null,
                    url, error };
                out.push(entry);
                // Rendering them inline is the point of the helper: a data URL
                // in a console row is unreadable, an actual picture answers
                // "is the texture data wrong?" at a glance.
                if (settings.log !== false && url) {
                    const scale = Math.max(1, Math.round(64 / Math.max(width, height)));
                    console.log("%c ", "font-size:0;padding:" +
                        (height * scale / 2) + "px " + (width * scale / 2) +
                        "px;background:url(" + url +
                        ") no-repeat center/contain;image-rendering:pixelated",
                        handle, entry.formatName, entry.size);
                }
            }
            return out;
        }

        // Every distinct pipeline state actually in use, with the raw D3D9
        // render-state values behind it. Reading the real mix beats guessing
        // which blend/depth/cull combination a scene is built from.
        dumpPipelineStates() {
            const out = [];
            for (const key of this.pipelineCache.keys()) {
                const parts = key.split("|");
                let state = null;
                try { state = JSON.parse(parts[6]); } catch (error) { /* key shape changed */ }
                out.push({ vertex: parts[0], fragment: parts[1],
                    topology: parts[4], state });
            }
            return out;
        }

        getStats() {
            // The live surface rect is included because it is what positions
            // the overlay canvas, and a wrong rect is invisible in the picture
            // itself: the frame still looks correct, it is just drawn where
            // the guest does not think the window is -- so clicks land on
            // whatever the guest really has at that pixel.
            const device = this.presentingDevice ||
                this.devices.values().next().value || null;
            // The fog parameters as this executor decoded them. "Everything
            // is washed out towards one colour" and "fog is not applied at
            // all" look nothing alike in these numbers, and guessing between
            // them from a screenshot has already cost a round.
            let fog = null;
            if (device) {
                const rs = device.renderStates;
                const asFloat = id => {
                    const raw = rs.get(id);
                    if (raw === undefined) return null;
                    FLOAT_BITS_U32[0] = raw >>> 0;
                    return FLOAT_BITS_F32[0];
                };
                const color = rs.get(D3DRS_FOGCOLOR) || 0;
                fog = {
                    enabled: (rs.get(D3DRS_FOGENABLE) || 0) !== 0,
                    tableMode: rs.get(D3DRS_FOGTABLEMODE) || 0,
                    vertexMode: rs.get(D3DRS_FOGVERTEXMODE) || 0,
                    color: "#" + (color & 0xffffff).toString(16).padStart(6, "0"),
                    // null means the game never set it and the D3D9 default
                    // (start 0, end 1) applies -- which fogs everything past
                    // one unit completely, so a null here with LINEAR mode is
                    // itself the explanation for a uniformly washed-out frame.
                    start: asFloat(D3DRS_FOGSTART),
                    end: asFloat(D3DRS_FOGEND),
                    density: asFloat(D3DRS_FOGDENSITY),
                };
            }
            return { ...this.stats, devicesLive: this.devices.size,
                resourcesLive: this.resources.size,
                surface: device ? { ...device.surface } : null,
                window: this.windowState ? { ...this.windowState } : null,
                fog };
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
            const lockFlags = view.getUint32(offset + 16, true);
            const resource = this.resources.get(handle);
            if (!resource || !byteCount) return;
            this.applyBufferUpdate(resource, destinationOffset, bytes, dataOffset,
                byteCount, lockFlags);
        }

        applyBufferUpdate(resource, destinationOffset, bytes, sourceOffset,
                byteCount, lockFlags) {
            lockFlags = lockFlags || 0;
            const shadow = resource.shadow;
            if (destinationOffset >= shadow.length) return;
            if (destinationOffset + byteCount > shadow.length)
                byteCount = shadow.length - destinationOffset;
            if (!byteCount) return;
            const source = new Uint8Array(bytes.buffer, bytes.byteOffset + sourceOffset, byteCount);
            shadow.set(source, destinationOffset);

            // Renaming (below) is what keeps deferred draws honest.
            //
            // Draws are not encoded when they arrive: they are recorded and
            // replayed at Present, because a swapchain texture is only valid
            // inside the task that acquired it (see ensureFrame). Buffer
            // writes, by contrast, take effect in queue order -- so every
            // writeBuffer issued during a frame lands *before* that frame's
            // single submit, and therefore before every draw in it.
            //
            // For the single most common dynamic-geometry idiom that is
            // catastrophic:
            //
            //     Lock(DISCARD); write batch A; DrawPrimitive
            //     Lock(DISCARD); write batch B; DrawPrimitive
            //     Present
            //
            // Both draws end up reading batch B. The first renders real
            // indices against the wrong vertices, which on screen is stray
            // geometry stretching across the frame, different every frame,
            // while static/managed resources look perfect.
            //
            // A real D3D9 driver answers this by *renaming*: DISCARD means
            // "I no longer care about the old contents", and the driver hands
            // back fresh storage while in-flight commands keep the old
            // allocation. Do the same here -- but only when this buffer has
            // actually been read by a draw already recorded in this frame, so
            // the ordinary "upload once, draw many" path allocates nothing.
            //
            // The lock flags decide *which* answer is needed, and getting this
            // distinction right is what keeps the cost sane. War3 renamed ~277
            // times per frame when every mid-frame write was treated the same:
            //
            //   NOOVERWRITE  the application has promised it is only writing
            //                bytes no issued draw reads -- that is precisely
            //                the guarantee this hazard needs, and it is how a
            //                game appends batch after batch into one buffer.
            //                Write in place; renaming here is pure waste.
            //   DISCARD      the old contents are dead, so the replacement
            //                only needs the bytes being written now. The rest
            //                is garbage the application has promised not to
            //                read, so there is nothing to copy forward.
            //   neither      a plain lock keeps the old contents readable, so
            //                the replacement has to carry the whole shadow.
            //                Rare, and the only case that costs a full upload.
            const D3DLOCK_NOOVERWRITE = 0x1000;
            const D3DLOCK_DISCARD = 0x2000;
            if (this.frame && resource.frameReferenced === this.frame.serial &&
                    !(lockFlags & D3DLOCK_NOOVERWRITE)) {
                const replacement = this.device.createBuffer({
                    label: "D3D9 renamed buffer",
                    size: resource.gpuBuffer.size,
                    usage: resource.kind === RESOURCE_BUFFER_INDEX
                        ? BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST
                        : BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
                });
                if (lockFlags & D3DLOCK_DISCARD) {
                    const start = destinationOffset & ~3;
                    const end = Math.min(shadow.length,
                        alignUp(destinationOffset + byteCount, 4));
                    if (end > start)
                        this.device.queue.writeBuffer(replacement, start,
                            shadow.buffer, shadow.byteOffset + start, end - start);
                } else {
                    this.device.queue.writeBuffer(replacement, 0, shadow.buffer,
                        shadow.byteOffset, shadow.length);
                    ++this.stats.bufferFullCopyRenames;
                }
                this.retireGPUObject(resource.gpuBuffer);
                resource.gpuBuffer = replacement;
                resource.frameReferenced = 0;
                ++this.stats.bufferRenames;
                return;
            }
            if (this.frame && resource.frameReferenced === this.frame.serial)
                ++this.stats.bufferNoOverwriteWrites;

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
            // Never destroy inline. A frame being recorded may already hold a
            // bind group referencing this texture's view or a pending draw
            // referencing this buffer, and none of it is submitted until
            // Present -- destroying now makes WebGPU reject the whole command
            // buffer ("Destroyed texture ... used in a submit"). Releasing a
            // texture in the same frame it was last drawn with is ordinary
            // application behaviour, not an edge case.
            this.retireGPUObject(resource.gpuBuffer);
            this.retireGPUObject(resource.gpuTexture);
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
            // No sampler is attached to the texture: since M2, sampling
            // parameters come from the device's per-stage sampler state
            // through samplerFor(), so the same texture bound to two stages
            // with different filtering behaves the way D3D9 says it should.
            this.resources.set(handle, {
                kind: RESOURCE_TEXTURE_2D, gpuTexture, format, width, height,
                levelCount: Math.max(1, levelCount),
                // A mip level the guest never uploads has undefined contents.
                // Sampling one is not "slightly blurry" -- it is whatever was
                // in that memory, which reads as a completely wrong texture.
                // M1 could not hit this the same way because it sampled with
                // one hardcoded sampler; M2 honours D3DSAMP_MIPFILTER, so a
                // game asking for mip filtering now reaches levels that were
                // never written.
                uploadedLevels: new Set(),
                view: gpuTexture.createView(),
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
            // Textures have the same write-after-record exposure as buffers,
            // but renaming one costs a full reallocation plus a re-upload of
            // every level, so this only counts occurrences for now. War3's
            // ratio (roughly one upload per two frames) says it is rare in
            // practice; a game that drives a dynamic texture per draw would
            // show up here first.
            if (this.frame && resource.frameReferenced === this.frame.serial)
                ++this.stats.textureUpdateHazards;
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
            if (resource.uploadedLevels) resource.uploadedLevels.add(level);
            // Retain a CPU copy of small top-level images. This is the one
            // piece of evidence that separates "the texture data we uploaded
            // is wrong" from "the data is right but we sample it wrong", and
            // guessing between those two has already cost several rounds.
            // Bounded to sprite-sized textures so it cannot grow without
            // limit -- cursors and UI glyphs are exactly this size.
            // 64x64 was too small a net: a game's cursor and UI glyphs
            // usually live in a larger atlas, so the one texture worth looking
            // at was the one never captured. 256x256 covers those at a bounded
            // total cost (previewBudget below).
            if (!compressed && level === 0 && width <= 256 && height <= 256 &&
                    x === 0 && y === 0) {
                const bytes = width * height * 4;
                if (!resource.preview) {
                    if (this.previewBudget === undefined)
                        this.previewBudget = 16 * 1024 * 1024;
                    if (this.previewBudget < bytes) return;
                    this.previewBudget -= bytes;
                }
                resource.preview = { width, height, rgba: payload.slice() };
            }
            // rowsPerImage counts *block* rows for a block-compressed format,
            // not pixel rows -- BCn blocks are 4x4, so a DXT upload that
            // passes the pixel height describes an image four times taller
            // than the data actually is.
            this.device.queue.writeTexture(
                { texture: resource.gpuTexture, mipLevel: level, origin: { x, y, z: 0 } },
                payload,
                { bytesPerRow, rowsPerImage: compressed ? Math.ceil(height / 4) : height },
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

        // What the fixed-function vertex stage needs to know about a decoded
        // D9WGVertexElement array. Returns null when the declaration carries
        // no position at all, which is the one thing the fixed-function stage
        // cannot work around.
        fixedFunctionVertexSignature(elements) {
            let positionType = null;
            let hasColor = false;
            let colorIsBGRA = false;
            let hasTexCoord = false;
            for (const element of elements) {
                if (element.usage === DECLUSAGE_POSITION && element.usageIndex === 0)
                    positionType = "world";
                else if (element.usage === DECLUSAGE_POSITIONT && element.usageIndex === 0)
                    positionType = "screen";
                else if (element.usage === DECLUSAGE_COLOR && element.usageIndex === 0) {
                    hasColor = true;
                    // Only a D3DCOLOR-typed diffuse arrives byte-swapped; a
                    // declaration is free to use FLOAT4 instead, and swizzling
                    // that would rotate the channels for no reason.
                    colorIsBGRA = element.type === DECLTYPE_D3DCOLOR;
                } else if (element.usage === DECLUSAGE_TEXCOORD && element.usageIndex === 0)
                    hasTexCoord = true;
            }
            if (!positionType) return null;
            return { positionType, hasColor, colorIsBGRA, hasTexCoord,
                textureTransform: false };
        }

        // Turns a declaration plus the currently bound streams into the
        // GPUVertexBufferLayout array a pipeline needs, using `locationFor` to
        // decide which shader input (if any) each element feeds. One function
        // serves both stages: the fixed-function stage passes its semantic
        // table, a translated shader passes a lookup over its own dcl'd
        // inputs. Elements no shader input consumes are simply left out --
        // they still occupy bytes in the vertex, but the stride comes from
        // SetStreamSource, never from summing the elements.
        vertexBufferLayoutsFor(elements, state, locationFor) {
            const perStream = new Map();
            for (const element of elements) {
                const location = locationFor(element);
                if (location < 0) continue;
                const format = DECLTYPE_FORMATS[element.type];
                if (!format) {
                    this.warnOnce("decltype-" + element.type,
                        "unsupported D3DDECLTYPE " + element.type +
                        "; the attribute is dropped from the vertex layout");
                    continue;
                }
                const stream = state.streams.get(element.stream);
                if (!stream || !stream.stride) continue;
                let entry = perStream.get(element.stream);
                if (!entry) {
                    entry = { stream: element.stream, arrayStride: stream.stride,
                        attributes: [] };
                    perStream.set(element.stream, entry);
                }
                entry.attributes.push({ shaderLocation: location,
                    offset: element.byteOffset, format: format[0] });
            }
            // Sorted so the slot a buffer binds to is a stable function of the
            // declaration, which keeps the pipeline cache key stable too.
            const layouts = Array.from(perStream.values())
                .sort((a, b) => a.stream - b.stream);
            for (const layout of layouts)
                layout.attributes.sort((a, b) => a.shaderLocation - b.shaderLocation);
            return layouts;
        }

        onCreateVertexDeclaration(bytes, view, offset, length) {
            const handle = view.getUint32(offset + 4, true);
            const count = view.getUint32(offset + 8, true);
            const elements = this.decodeVertexElements(bytes, view, offset + 16, count);
            this.resources.set(handle,
                { kind: RESOURCE_VERTEX_DECLARATION, elements });
        }

        onSetVertexDeclaration(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const declarationHandle = view.getUint32(offset + 4, true);
            const state = this.deviceState(deviceHandle);
            state.vertexDeclarationHandle = declarationHandle;
            state.fvfElements = null;
        }

        onSetFVF(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset, true);
            const count = view.getUint32(offset + 8, true);
            const state = this.deviceState(deviceHandle);
            state.fvfElements = this.decodeVertexElements(bytes, view, offset + 16, count);
            state.vertexDeclarationHandle = 0;
        }

        // The declaration in force, whether it arrived as a real
        // IDirect3DVertexDeclaration9 or as an FVF the guest expanded into the
        // same element shape (plan 4.3 -- the host has exactly one
        // vertex-layout code path).
        currentElements(state) {
            if (state.fvfElements) return state.fvfElements;
            const declaration = this.resources.get(state.vertexDeclarationHandle);
            return declaration ? declaration.elements : null;
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

        // ---- programmable shaders (M2) ----

        // Translation happens here, at CREATE time, and never on a draw path
        // (plan 4.2): a shader first used mid-frame would otherwise produce an
        // unattributable latency spike. A shader this build cannot translate
        // is stored with its error rather than dropped -- recordDraw() then
        // skips draws that bind it and counts them, which is the difference
        // between "this shader is unsupported" and "the game stopped drawing".
        onCreateShader(bytes, view, offset, kind) {
            const handle = view.getUint32(offset + 4, true);
            const tokenCount = view.getUint32(offset + 8, true);
            const codeOffset = view.getUint32(offset + 12, true);
            const hashLow = view.getUint32(offset + 16, true);
            const hashHigh = view.getUint32(offset + 20, true);
            if (codeOffset + tokenCount * 4 > bytes.byteLength) {
                ++this.stats.malformedBatches;
                throw new Error("D9WG shader bytecode overruns the batch");
            }
            // The DMA blob is not 4-byte aligned within `bytes` in general,
            // so copy rather than aliasing a Uint32Array onto it.
            const tokens = new Uint32Array(tokenCount);
            for (let i = 0; i < tokenCount; ++i)
                tokens[i] = view.getUint32(codeOffset + i * 4, true);
            const translated = this.shaderCache.compile(tokens, hashLow, hashHigh);
            if (translated.ok) ++this.stats.shadersTranslated;
            else {
                ++this.stats.shaderTranslationFailures;
                this.warnOnce("shader-translate-" + hashHigh + "-" + hashLow,
                    "cannot translate a " + (kind === RESOURCE_VERTEX_SHADER
                        ? "vertex" : "pixel") + " shader; draws that bind it " +
                    "will be skipped: " + translated.error);
            }
            this.resources.set(handle, {
                kind, tokens, hashLow, hashHigh,
                translated,
                // Variant key -> {translated, module}. A vertex shader needs
                // one variant per set of D3DCOLOR input locations; in practice
                // that is a single entry, because a given shader is used with
                // one vertex format.
                variants: new Map(),
            });
        }

        onCreateVertexShader(bytes, view, offset) {
            this.onCreateShader(bytes, view, offset, RESOURCE_VERTEX_SHADER);
        }

        onCreatePixelShader(bytes, view, offset) {
            this.onCreateShader(bytes, view, offset, RESOURCE_PIXEL_SHADER);
        }

        onSetVertexShader(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            state.vertexShaderHandle = view.getUint32(offset + 4, true);
        }

        onSetPixelShader(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            state.pixelShaderHandle = view.getUint32(offset + 4, true);
        }

        // Shared decode for all six SET_*_SHADER_CONSTANT_* opcodes: they use
        // one payload shape and differ only in the destination array and how
        // wide a register is on the wire (float4/int4 = 16 bytes, bool = 4).
        applyConstants(bytes, view, offset, target, componentsPerRegister, read) {
            const startRegister = view.getUint32(offset + 4, true);
            const vectorCount = view.getUint32(offset + 8, true);
            const dataOffset = view.getUint32(offset + 12, true);
            const stride = componentsPerRegister * 4;
            if (dataOffset + vectorCount * stride > bytes.byteLength) {
                ++this.stats.malformedBatches;
                throw new Error("D9WG shader constant data overruns the batch");
            }
            const capacity = target.length / componentsPerRegister;
            if (startRegister >= capacity) return;
            const count = Math.min(vectorCount, capacity - startRegister);
            for (let i = 0; i < count; ++i) {
                const base = dataOffset + i * stride;
                const destination = (startRegister + i) * componentsPerRegister;
                for (let c = 0; c < componentsPerRegister; ++c)
                    target[destination + c] = read(base + c * 4);
            }
        }

        onSetVertexShaderConstantF(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.vsConstF, 4,
                at => view.getFloat32(at, true));
        }

        onSetPixelShaderConstantF(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.psConstF, 4,
                at => view.getFloat32(at, true));
        }

        onSetVertexShaderConstantI(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.vsConstI, 4,
                at => view.getInt32(at, true));
        }

        onSetPixelShaderConstantI(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.psConstI, 4,
                at => view.getInt32(at, true));
        }

        onSetVertexShaderConstantB(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.vsConstB, 1,
                at => view.getUint32(at, true));
        }

        onSetPixelShaderConstantB(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.psConstB, 1,
                at => view.getUint32(at, true));
        }

        // ---- D3D9 hardware cursor ----
        //
        // A fullscreen D3D9 game draws its pointer through SetCursorProperties
        // rather than GDI, so it never reaches the VGA framebuffer the page
        // composites under this canvas -- and the page hides the browser
        // cursor. Without this the pointer is invisible even though input
        // still works, which makes the game effectively unplayable.
        onSetCursorProperties(bytes, view, offset) {
            const width = view.getUint32(offset + 12, true);
            const height = view.getUint32(offset + 16, true);
            const dataBytes = view.getUint32(offset + 20, true);
            const dataOffset = view.getUint32(offset + 24, true);
            if (!width || !height) return;
            if (dataOffset + dataBytes > bytes.byteLength) {
                ++this.stats.malformedBatches;
                throw new Error("D9WG cursor bitmap overruns the batch");
            }
            this.cursor.hotspotX = view.getUint32(offset + 4, true);
            this.cursor.hotspotY = view.getUint32(offset + 8, true);
            if (this.cursor.width !== width || this.cursor.height !== height ||
                    !this.cursor.texture) {
                this.retireGPUObject(this.cursor.texture);
                this.cursor.texture = this.device.createTexture({
                    label: "D3D9 hardware cursor",
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: "rgba8unorm",
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                this.cursor.view = this.cursor.texture.createView();
                this.cursor.width = width;
                this.cursor.height = height;
            }
            // The guest sends A8R8G8B8 at a tight width*4 stride; the same
            // BGRA-to-RGBA reorder every other texture upload does.
            const source = new Uint8Array(bytes.buffer,
                bytes.byteOffset + dataOffset, dataBytes);
            const rgba = new Uint8Array(width * height * 4);
            for (let row = 0; row < height; ++row)
                expandRowToRGBA8(D3DFMT_A8R8G8B8, source, row * width * 4,
                    width, rgba, row * width * 4);
            this.device.queue.writeTexture({ texture: this.cursor.texture },
                rgba, { bytesPerRow: width * 4, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 });
            ++this.stats.cursorUploads;
        }

        onSetCursorPosition(bytes, view, offset) {
            this.cursor.x = view.getInt32(offset + 4, true);
            this.cursor.y = view.getInt32(offset + 8, true);
        }

        onShowCursor(bytes, view, offset) {
            this.cursor.visible = view.getUint32(offset + 4, true) !== 0;
        }

        // Purely diagnostic; see D9WG_OP_WINDOW_STATE in d3d9_protocol.h for
        // why the guest's window-manager view has to be reported rather than
        // inferred from the rendering.
        onWindowState(bytes, view, offset) {
            const flags = view.getUint32(offset + 12, true);
            const state = {
                hwnd: view.getUint32(offset + 4, true),
                foregroundHwnd: view.getUint32(offset + 8, true),
                isWindow: (flags & D9WG_WINDOW_IS_WINDOW) !== 0,
                visible: (flags & D9WG_WINDOW_VISIBLE) !== 0,
                iconic: (flags & D9WG_WINDOW_ICONIC) !== 0,
                foreground: (flags & D9WG_WINDOW_FOREGROUND) !== 0,
                fullscreen: (flags & D9WG_WINDOW_FULLSCREEN) !== 0,
                windowX: view.getInt32(offset + 16, true),
                windowY: view.getInt32(offset + 20, true),
                windowWidth: view.getUint32(offset + 24, true),
                windowHeight: view.getUint32(offset + 28, true),
                clientWidth: view.getUint32(offset + 32, true),
                clientHeight: view.getUint32(offset + 36, true),
            };
            this.windowState = state;
            ++this.stats.windowStateChanges;
            if (!state.foreground)
                this.warnOnce("window-not-foreground",
                    "the game's window is not the guest's foreground window, " +
                    "so the guest will route clicks to whatever is on top of " +
                    "it -- the overlay still shows this game's frames either " +
                    "way", state);
            if (state.iconic || !state.visible)
                this.warnOnce("window-not-visible",
                    "the game's window is minimised or hidden in the guest; " +
                    "input will not reach it", state);
        }

        // A self-contained screen-space quad, built once. It deliberately does
        // not go through programFor()/pipelineFor(): the cursor is host-owned
        // compositing, not a guest draw, and giving it its own trivial
        // pipeline keeps it out of the caches keyed on guest state.
        ensureCursorPipeline() {
            if (this.cursor.pipeline) return this.cursor.pipeline;
            const module = this.device.createShaderModule({
                label: "D3D9 cursor",
                code: `
struct CursorRect { origin: vec2<f32>, size: vec2<f32> };
@group(0) @binding(0) var<uniform> rect: CursorRect;
@group(0) @binding(1) var cursor_texture: texture_2d<f32>;
@group(0) @binding(2) var cursor_sampler: sampler;

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VSOut {
    // Two triangles covering the cursor's rectangle, in normalised
    // back-buffer space supplied by the uniform.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let corner = corners[index];
    let position = rect.origin + corner * rect.size;
    var out: VSOut;
    out.position = vec4<f32>(position.x * 2.0 - 1.0,
        1.0 - position.y * 2.0, 0.0, 1.0);
    out.uv = corner;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(cursor_texture, cursor_sampler, in.uv);
}
`,
            });
            const bindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } },
                    { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: {} },
                    { binding: 2, visibility: SHADER_STAGE_FRAGMENT, sampler: {} },
                ],
            });
            this.cursor.bindGroupLayout = bindGroupLayout;
            this.cursor.sampler = this.device.createSampler({
                magFilter: "nearest", minFilter: "nearest",
                addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
            });
            this.cursor.uniform = this.device.createBuffer({
                label: "D3D9 cursor rect", size: 16,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.cursor.pipeline = this.device.createRenderPipeline({
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main", targets: [{
                    format: this.format,
                    // Straight alpha: a cursor bitmap's transparent texels
                    // must not paint over the frame.
                    blend: {
                        color: { srcFactor: "src-alpha",
                                 dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one",
                                 dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                }] },
                primitive: { topology: "triangle-list" },
            });
            return this.cursor.pipeline;
        }

        // Drawn last, in its own depth-less pass, so it sits on top of the
        // frame regardless of what the game left in the depth buffer.
        drawCursor(encoder, targetView, width, height) {
            const cursor = this.cursor;
            if (!cursor.visible || !cursor.view || !width || !height) return;
            const pipeline = this.ensureCursorPipeline();
            const originX = (cursor.x - cursor.hotspotX) / width;
            const originY = (cursor.y - cursor.hotspotY) / height;
            this.device.queue.writeBuffer(cursor.uniform, 0, new Float32Array([
                originX, originY, cursor.width / width, cursor.height / height,
            ]));
            const bindGroup = this.device.createBindGroup({
                layout: cursor.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: cursor.uniform } },
                    { binding: 1, resource: cursor.view },
                    { binding: 2, resource: cursor.sampler },
                ],
            });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(6);
            pass.end();
            ++this.stats.cursorDraws;
        }

        // GPUShaderModules are content-addressed by their WGSL text, so two
        // shaders that translate identically (or the same shader re-created
        // after a Reset) share one module. Compilation diagnostics are checked
        // asynchronously -- createShaderModule() never throws on bad WGSL, and
        // plan 9.6 requires the getCompilationInfo() check rather than
        // assuming successful translation implies valid output.
        moduleFor(wgsl, label) {
            let module = this.moduleCache.get(wgsl);
            if (module) return module;
            module = this.device.createShaderModule({ label, code: wgsl });
            ++this.stats.shaderModulesCreated;
            this.moduleCache.set(wgsl, module);
            if (typeof module.getCompilationInfo === "function") {
                module.getCompilationInfo().then(info => {
                    const errors = (info.messages || [])
                        .filter(message => message.type === "error");
                    if (!errors.length) return;
                    module._d9wgBroken = true;
                    this.stats.shaderCompileErrors += errors.length;
                    console.error("[d3d9-webgpu] WGSL compilation failed for " +
                        label, errors.map(e => e.lineNum + ":" + e.linePos +
                            " " + e.message), wgsl);
                }, () => {});
            }
            return module;
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

            // Every `|| fallback` below is a silent substitution: an
            // unmapped D3DBLEND value quietly became src-alpha, which renders
            // as something plausible-but-wrong rather than as an error. That
            // is the same blind spot as the stubs that returned
            // D3DERR_INVALIDCALL without a trace, so count and name it.
            //
            // D3DBLEND 12-15 (BOTHSRCALPHA, BOTHINVSRCALPHA, BLENDFACTOR,
            // INVBLENDFACTOR) have no direct WebGPU equivalent: the BOTH*
            // pair sets source and destination factors together, and the
            // BLENDFACTOR pair needs the pipeline's blend constant, which is
            // not plumbed through yet.
            const blendEnabled = get(D3DRS_ALPHABLENDENABLE, 0) !== 0;
            const rawSrc = get(D3DRS_SRCBLEND, 5);
            const rawDst = get(D3DRS_DESTBLEND, 6);
            const rawOp = get(D3DRS_BLENDOP, 1);
            const srcFactor = BLEND_FACTORS[rawSrc] || "src-alpha";
            const dstFactor = BLEND_FACTORS[rawDst] || "one-minus-src-alpha";
            const blendOp = BLEND_OPS[rawOp] || "add";
            if (blendEnabled && (!BLEND_FACTORS[rawSrc] || !BLEND_FACTORS[rawDst]
                    || !BLEND_OPS[rawOp])) {
                ++this.stats.drawsWithUnmappedBlend;
                this.warnOnce("unmapped-blend-" + rawSrc + "-" + rawDst + "-" + rawOp,
                    "a draw asks for a blend mode with no WebGPU equivalent; " +
                    "it silently falls back to src-alpha/inv-src-alpha, which " +
                    "renders as plausible-but-wrong compositing", {
                        D3DRS_SRCBLEND: rawSrc, mappedSrc: BLEND_FACTORS[rawSrc],
                        D3DRS_DESTBLEND: rawDst, mappedDst: BLEND_FACTORS[rawDst],
                        D3DRS_BLENDOP: rawOp, mappedOp: BLEND_OPS[rawOp],
                    });
            }

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

            // Alpha test is a shader construct here, not pipeline state, so
            // it travels with the rest of the immutable state and lands in
            // the fragment key rather than in the GPURenderPipeline itself.
            const alphaTest = {
                enabled: get(D3DRS_ALPHATESTENABLE, 0) !== 0,
                func: get(D3DRS_ALPHAFUNC, 8) & 0xF,
                reference: get(D3DRS_ALPHAREF, 0) & 0xFF,
            };

            return { depthEnabled, depthWrite, depthCompare, blendEnabled,
                srcFactor, dstFactor, blendOp, cullMode, writeMask,
                alphaTest, hasDepth: !!state.hasDepth };
        }

        // ---- independent sampler state (plan 4.4/12) ----
        //
        // D3D9 splits sampling parameters out of texture-stage state into
        // SetSamplerState, which maps almost one-to-one onto an immutable
        // GPUSampler. M1 recorded these values but sampled every texture with
        // one hardcoded linear/repeat sampler created alongside the texture;
        // they now drive a cache keyed by the parameter tuple, so a stage's
        // sampler follows the app's state rather than the texture it happens
        // to be bound to.
        samplerFor(state, stage) {
            const get = (id, fallback) => {
                const value = state.samplerStates.get(stage * 64 + id);
                return value === undefined ? fallback : value;
            };
            // D3D9 defaults: WRAP addressing, POINT min/mag, no mip filtering.
            const addressU = get(D3DSAMP_ADDRESSU, 1);
            const addressV = get(D3DSAMP_ADDRESSV, 1);
            const addressW = get(D3DSAMP_ADDRESSW, 1);
            const magFilter = get(D3DSAMP_MAGFILTER, 1);
            const minFilter = get(D3DSAMP_MINFILTER, 1);
            const mipFilter = get(D3DSAMP_MIPFILTER, 0);
            let maxAnisotropy = get(D3DSAMP_MAXANISOTROPY, 1) | 0;
            const key = [addressU, addressV, addressW, magFilter, minFilter,
                mipFilter, maxAnisotropy,
                this.debug.forceMipLevel0 ? "top" : ""].join(",");
            const cached = this.samplerCache.get(key);
            if (cached) { ++this.stats.samplerHits; return cached; }

            const descriptor = {
                addressModeU: ADDRESS_MODES[addressU] || "repeat",
                addressModeV: ADDRESS_MODES[addressV] || "repeat",
                addressModeW: ADDRESS_MODES[addressW] || "repeat",
                magFilter: FILTER_MODES[magFilter] || "nearest",
                minFilter: FILTER_MODES[minFilter] || "nearest",
                // D3DTEXF_NONE means "use only the top mip level", which is
                // what clamping the LOD range to 0 expresses in WebGPU.
                mipmapFilter: mipFilter === 2 ? "linear" : "nearest",
            };
            if (mipFilter === 0 || this.debug.forceMipLevel0) {
                descriptor.lodMinClamp = 0;
                descriptor.lodMaxClamp = 0;
            }
            // WebGPU only accepts maxAnisotropy > 1 when all three filters are
            // linear, so anisotropy is dropped rather than forcing filters the
            // app did not ask for.
            if (maxAnisotropy > 1 && descriptor.magFilter === "linear" &&
                    descriptor.minFilter === "linear" &&
                    descriptor.mipmapFilter === "linear" && mipFilter !== 0)
                descriptor.maxAnisotropy = Math.min(16, maxAnisotropy);
            if (addressU === 4 || addressV === 4 || addressW === 4)
                this.warnOnce("address-border", "D3DTADDRESS_BORDER has no " +
                    "WebGPU equivalent; clamping to edge instead");
            if (addressU === 5 || addressV === 5 || addressW === 5)
                this.warnOnce("address-mirroronce", "D3DTADDRESS_MIRRORONCE " +
                    "has no WebGPU equivalent; clamping to edge instead");
            const sampler = this.device.createSampler(descriptor);
            ++this.stats.samplersCreated;
            this.samplerCache.set(key, sampler);
            return sampler;
        }

        // ---- program resolution ----

        // Resolves the two stages into GPUShaderModules plus everything the
        // pipeline and bind group need. Returns {error} instead of throwing
        // for anything the caller should turn into a counted skipped draw.
        programFor(state, elements, pipelineState) {
            const alphaTest = pipelineState.alphaTest;
            const alphaTestKey = alphaTest.enabled
                ? "_a" + alphaTest.func + "_" + alphaTest.reference : "";
            const vsHandle = state.vertexShaderHandle;
            const psHandle = state.pixelShaderHandle;
            const vsResource = vsHandle ? this.resources.get(vsHandle) : null;
            const psResource = psHandle ? this.resources.get(psHandle) : null;
            if (vsHandle && !vsResource)
                return { error: "bound vertex shader handle is unknown to the host",
                    shaderError: true };
            if (psHandle && !psResource)
                return { error: "bound pixel shader handle is unknown to the host",
                    shaderError: true };

            let vertexModule, vertexKey, vertexReflection = null, locationFor;
            let fixedFunctionSignature = null;
            let fogMode = 0;
            const rs = state.renderStates;
            if (vsResource) {
                const inputLocations = new Map();
                if (!vsResource.translated.ok)
                    return { error: "vertex shader translation failed: " +
                        vsResource.translated.error, shaderError: true };
                for (const input of vsResource.translated.reflection.inputs)
                    inputLocations.set(input.usage * 16 + input.usageIndex, input.location);
                // Only the declaration knows which attributes are D3DCOLOR and
                // therefore arrive byte-swapped; see bgraInputLocations.
                const bgra = [];
                for (const element of elements) {
                    const location = inputLocations.get(
                        element.usage * 16 + element.usageIndex);
                    if (location !== undefined && element.type === DECLTYPE_D3DCOLOR)
                        bgra.push(location);
                }
                bgra.sort((a, b) => a - b);
                const variantKey = bgra.join(",");
                let variant = vsResource.variants.get(variantKey);
                if (!variant) {
                    variant = bgra.length
                        ? shaderPipeline.compileShader(vsResource.tokens,
                            { bgraInputLocations: bgra })
                        : vsResource.translated;
                    vsResource.variants.set(variantKey, variant);
                    if (bgra.length && variant.ok) ++this.stats.shaderVariantsTranslated;
                }
                if (!variant.ok)
                    return { error: "vertex shader translation failed: " + variant.error,
                        shaderError: true };
                vertexReflection = variant.reflection;
                vertexKey = "vs" + vsResource.hashHigh + "_" + vsResource.hashLow +
                    "_" + variantKey;
                vertexModule = this.moduleFor(variant.wgsl, "d3d9 " + vertexKey);
                locationFor = element => {
                    const location = inputLocations.get(
                        element.usage * 16 + element.usageIndex);
                    return location === undefined ? -1 : location;
                };
            } else {
                const signature = this.fixedFunctionVertexSignature(elements);
                if (!signature)
                    return { error: "declaration has no POSITION/POSITIONT element " +
                        "and no vertex shader is bound" };
                // D3DTTFF_DISABLE is 0; anything else transforms the
                // coordinate, so it has to bake into the shader and therefore
                // into the pipeline key.
                signature.textureTransform = signature.hasTexCoord &&
                    (state.textureStageStates.get(0 * 64 + 24) || 0) !== 0;
                // Table fog (D3DRS_FOGTABLEMODE) takes precedence over vertex
                // fog when both are set, which is what D3D9 does. Screen-space
                // XYZRHW geometry is excluded: it has no eye-space depth to
                // fog against.
                fogMode = 0;
                if ((rs.get(D3DRS_FOGENABLE) || 0) !== 0 &&
                        signature.positionType !== "screen") {
                    const table = rs.get(D3DRS_FOGTABLEMODE) || D3DFOG_NONE;
                    fogMode = table !== D3DFOG_NONE ? table
                        : (rs.get(D3DRS_FOGVERTEXMODE) || D3DFOG_NONE);
                }
                signature.fogMode = fogMode;
                // The other half of the caps promise fill_caps() makes:
                // D3DVTXPCAPS_DIRECTIONALLIGHTS/POSITIONALLIGHTS and
                // MaxActiveLights = 8. With D3DRS_LIGHTING on and no diffuse
                // element in the declaration, D3D9 derives the vertex colour
                // from the material and lights -- we emit plain white, which
                // is why an unlit scene comes out brighter and flatter than
                // it should.
                if ((rs.get(D3DRS_LIGHTING) || 0) !== 0 && !signature.hasColor) {
                    ++this.stats.drawsWithUnappliedLighting;
                    this.warnOnce("lighting",
                        "a draw has D3DRS_LIGHTING enabled and no diffuse " +
                        "vertex element, so D3D9 would light it from the " +
                        "material and lights; the fixed-function stage emits " +
                        "white instead (M3)", {
                            materialSet: !!state.material,
                            lightsEnabled: [...state.lightEnabled.entries()]
                                .filter(entry => entry[1]).map(entry => entry[0]),
                            ambient: state.renderStates.get(D3DRS_AMBIENT) || 0,
                        });
                }
                vertexKey = "ffvs_" + signature.positionType +
                    (signature.hasColor ? (signature.colorIsBGRA ? "_cb" : "_c") : "") +
                    (signature.hasTexCoord ? "_t" : "") +
                    (signature.textureTransform ? "_tt" : "") +
                    (fogMode ? "_f" + fogMode : "");
                vertexModule = this.moduleFor(
                    buildFixedFunctionVertexShader(signature), "d3d9 " + vertexKey);
                vertexReflection = null;
                locationFor = fixedFunctionLocationFor;
                fixedFunctionSignature = signature;
            }

            let fragmentModule, fragmentKey, pixelReflection = null;
            let samplerIndices;
            if (psResource) {
                if (!psResource.translated.ok)
                    return { error: "pixel shader translation failed: " +
                        psResource.translated.error, shaderError: true };
                let variant = psResource.translated;
                if (alphaTest.enabled) {
                    variant = psResource.variants.get(alphaTestKey);
                    if (!variant) {
                        variant = shaderPipeline.compileShader(psResource.tokens, {
                            alphaTestDiscard: alphaTestDiscard(alphaTest,
                                "result.color.a"),
                        });
                        psResource.variants.set(alphaTestKey, variant);
                        if (variant.ok) ++this.stats.shaderVariantsTranslated;
                    }
                    if (!variant.ok)
                        return { error: "pixel shader translation failed: " +
                            variant.error, shaderError: true };
                }
                pixelReflection = variant.reflection;
                for (const sampler of pixelReflection.samplers) {
                    if (sampler.type !== "2d")
                        return { error: "pixel shader samples a " + sampler.type +
                            " texture; cube/volume textures land in M3",
                            shaderError: true };
                }
                samplerIndices = pixelReflection.samplers.map(s => s.index);
                if ((rs.get(D3DRS_FOGENABLE) || 0) !== 0) {
                    ++this.stats.drawsWithUnappliedFog;
                    this.warnOnce("fog-programmable",
                        "fog is enabled on a draw with a translated pixel " +
                        "shader; the fixed-function fog blend is not applied " +
                        "there, so the fragment keeps its untinted colour");
                }
                fragmentKey = "ps" + psResource.hashHigh + "_" + psResource.hashLow +
                    alphaTestKey;
                fragmentModule = this.moduleFor(variant.wgsl, "d3d9 " + fragmentKey);
            } else {
                const textureBound = !!this.resources.get(state.textures.get(0));
                // With a fixed-function vertex stage, sampling is pointless
                // unless the declaration actually carries TEXCOORD0; with a
                // programmable one the varying is whatever the shader wrote,
                // so a bound texture alone is enough.
                const hasTexture = textureBound &&
                    (!fixedFunctionSignature || fixedFunctionSignature.hasTexCoord);
                if (fixedFunctionSignature && fixedFunctionSignature.hasTexCoord) {
                    if (textureBound) ++this.stats.drawsWithTexture;
                    else ++this.stats.drawsWithFallbackTexture;
                }
                // The fixed-function pixel stage is hardcoded to stage 0's
                // MODULATE(texture, diffuse) -- the full D3DTOP_* matrix is M3
                // work. Count the draws that asked for anything else, so
                // "the UI texture looks wrong" can be attributed to a missing
                // texture-stage operation rather than guessed at. Both
                // D3DTOP_MODULATE and an unset stage count as satisfied,
                // because MODULATE is the D3D9 default for stage 0.
                const stageState = (stage, id, fallback) => {
                    const value = state.textureStageStates.get(stage * 64 + id);
                    return value === undefined ? fallback : value;
                };
                const D3DTSS_COLOROP = 1, D3DTSS_COLORARG1 = 2, D3DTSS_COLORARG2 = 3;
                const D3DTOP_DISABLE = 1, D3DTOP_MODULATE = 4;
                const D3DTA_DIFFUSE = 0, D3DTA_CURRENT = 1, D3DTA_TEXTURE = 2;
                const colorOp = stageState(0, D3DTSS_COLOROP, D3DTOP_MODULATE);
                // On stage 0 D3DTA_CURRENT *is* the diffuse colour -- there is
                // no previous stage for it to carry a result from -- so the two
                // are the same argument. Treating them as distinct made every
                // textured War3 draw report an unimplemented operation it was
                // not actually asking for.
                const arg2 = stageState(0, D3DTSS_COLORARG2, D3DTA_DIFFUSE);
                const unsupportedStage0 = hasTexture && (
                    colorOp !== D3DTOP_MODULATE ||
                    stageState(0, D3DTSS_COLORARG1, D3DTA_TEXTURE) !== D3DTA_TEXTURE ||
                    (arg2 !== D3DTA_DIFFUSE && arg2 !== D3DTA_CURRENT));
                const stage1Active =
                    stageState(1, D3DTSS_COLOROP, D3DTOP_DISABLE) !== D3DTOP_DISABLE;

                // The previous version of this check only looked at the colour
                // operation, so it reported "nothing unsupported" while the
                // states that decide *where a stage samples from* went
                // unexamined. Those are exactly what makes a textured surface
                // come out flat: the texture is bound and sampled, just at the
                // wrong coordinates.
                //
                //   TEXCOORDINDEX          which texcoord set feeds the stage,
                //                          and the D3DTSS_TCI_* generation
                //                          modes (camera-space position /
                //                          normal / reflection) used for
                //                          environment and fog effects.
                //   TEXTURETRANSFORMFLAGS  whether the D3DTS_TEXTURE0 matrix
                //                          is applied to the coordinates.
                //
                // Neither is implemented; the fixed-function stage always
                // samples TEXCOORD0 untransformed.
                const D3DTSS_TEXCOORDINDEX = 11;
                const D3DTSS_TEXTURETRANSFORMFLAGS = 24;
                const D3DTS_TEXTURE0 = 16;
                const texCoordIndex = stageState(0, D3DTSS_TEXCOORDINDEX, 0);
                const transformFlags =
                    stageState(0, D3DTSS_TEXTURETRANSFORMFLAGS, 0);
                const textureMatrix = state.transforms.get(D3DTS_TEXTURE0);
                const matrixIsIdentity = !textureMatrix ||
                    textureMatrix.every((value, index) =>
                        value === IDENTITY4x4[index]);
                if (hasTexture && texCoordIndex !== 0) {
                    ++this.stats.drawsWithTexCoordIndex;
                    this.warnOnce("texcoordindex",
                        "a draw selects texture coordinates the fixed-function " +
                        "stage ignores (it always samples TEXCOORD0 " +
                        "untransformed), so the texture is sampled at the " +
                        "wrong coordinates and the surface comes out flat: " +
                        "stage0 TEXCOORDINDEX=0x" + texCoordIndex.toString(16));
                }
                // The stage-0 matrix is applied now, so this must only
                // report the forms that still are not: COUNT3/COUNT4 need the
                // third and fourth coordinate components, and
                // D3DTTFF_PROJECTED (0x100) divides by the last one. Leaving
                // the warning firing for the handled case would be worse than
                // not having it -- a diagnostic that cries wolf stops being
                // read.
                const D3DTTFF_PROJECTED = 0x100;
                const componentCount = transformFlags & 0xFF;
                if (hasTexture && !matrixIsIdentity &&
                        (componentCount > 2 || (transformFlags & D3DTTFF_PROJECTED))) {
                    ++this.stats.drawsWithTextureTransform;
                    this.warnOnce("texturetransform",
                        "a draw uses a texture coordinate transform form the " +
                        "fixed-function stage does not implement (only " +
                        "D3DTTFF_COUNT1/COUNT2 on stage 0 are applied): " +
                        "stage0 TEXTURETRANSFORMFLAGS=" + transformFlags);
                }
                if (unsupportedStage0 || stage1Active) {
                    ++this.stats.drawsWithUnsupportedTextureOp;
                    this.warnOnce("texture-stage-op",
                        "a draw wants a texture-stage operation the " +
                        "fixed-function stage does not implement yet (M3): " +
                        "stage0 COLOROP=" + colorOp + " ARG1=" +
                        stageState(0, D3DTSS_COLORARG1, D3DTA_TEXTURE) +
                        " ARG2=" + stageState(0, D3DTSS_COLORARG2, D3DTA_DIFFUSE) +
                        ", stage1 COLOROP=" +
                        stageState(1, D3DTSS_COLOROP, D3DTOP_DISABLE));
                }
                samplerIndices = hasTexture ? [0] : [];
                fragmentKey = "ffps" + (hasTexture ? "_t" : "") + alphaTestKey +
                    (fogMode ? "_f" + fogMode : "") +
                    (this.debug.shaderMode ? "_" + this.debug.shaderMode : "");
                fragmentModule = this.moduleFor(
                    buildFixedFunctionPixelShader({ hasTexture, alphaTest, fogMode },
                        this.debug.shaderMode),
                    "d3d9 " + fragmentKey);
            }
            if (vertexModule._d9wgBroken || fragmentModule._d9wgBroken)
                return { error: "a stage failed WGSL compilation (see the " +
                    "getCompilationInfo error logged at module creation)",
                    shaderError: true };

            const vertexBuffers = this.vertexBufferLayoutsFor(elements, state, locationFor);
            if (!vertexBuffers.length)
                return { error: "no vertex stream supplies any attribute the " +
                    "vertex stage reads" };
            return { vertexModule, fragmentModule, vertexKey, fragmentKey,
                vertexReflection, pixelReflection, samplerIndices, vertexBuffers,
                fixedFunctionSignature,
                // 16 bytes of fog colour when the fixed-function pixel stage
                // needs it; a translated shader brings its own register file.
                pixelUniformBytes: pixelReflection ? pixelReflection.uniformBytes
                    : (fogMode ? 16 : 0), fogMode };
        }

        pipelineFor(program, pipelineState, topology, stripIndexFormat) {
            const key = program.vertexKey + "|" + program.fragmentKey + "|" +
                JSON.stringify(program.vertexBuffers) + "|" + this.format + "|" +
                topology + "|" + (stripIndexFormat || "") + "|" +
                JSON.stringify(pipelineState) + "|" +
                program.samplerIndices.join(",");
            let pipeline = this.pipelineCache.get(key);
            if (pipeline) { ++this.stats.pipelineHits; return pipeline; }

            // Binding 0 is the vertex stage's constant buffer (or the
            // fixed-function transform block, which occupies the same slot),
            // binding 1 the pixel stage's; samplers take 2+2n / 3+2n, the
            // numbering d3d9_shader_pipeline.js emits.
            const bindGroupEntries = [
                { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } },
            ];
            if (program.pixelUniformBytes)
                bindGroupEntries.push({ binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                    buffer: { type: "uniform" } });
            for (const index of program.samplerIndices)
                bindGroupEntries.push(
                    { binding: 2 + index * 2, visibility: SHADER_STAGE_FRAGMENT, texture: {} },
                    { binding: 3 + index * 2, visibility: SHADER_STAGE_FRAGMENT, sampler: {} });
            const bindGroupLayout = this.device.createBindGroupLayout(
                { entries: bindGroupEntries });

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
            const primitive = { topology, cullMode: pipelineState.cullMode,
                frontFace: "cw" };
            // WebGPU needs to know the restart-index width up front for an
            // indexed strip draw; it must be absent for every other topology.
            if (stripIndexFormat) primitive.stripIndexFormat = stripIndexFormat;
            const descriptor = {
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: {
                    module: program.vertexModule, entryPoint: "d9_vs_main",
                    buffers: program.vertexBuffers.map(layout =>
                        ({ arrayStride: layout.arrayStride, attributes: layout.attributes })),
                },
                fragment: { module: program.fragmentModule, entryPoint: "d9_ps_main",
                    targets: [colorTarget] },
                primitive,
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

        // One uniform buffer per draw holding both stages' constants, the
        // pixel region starting at a 256-byte boundary so it can be bound
        // separately. A stage with no translated shader gets the
        // fixed-function transform block in the same slot instead.
        constantBufferFor(state, program) {
            // 144 = mat4 WVP (64) + vec2 viewport + vec2 pad (16) + mat4
            // texture transform (64).
            // 176 = mat4 WVP (64) + vec2 viewport + vec2 pad (16) + mat4
            // texture transform (64) + vec4 fog colour + vec4 fog params (32).
            const vertexBytes = program.vertexReflection
                ? program.vertexReflection.uniformBytes : 176;
            const pixelBytes = program.pixelUniformBytes || 0;
            const pixelOffset = pixelBytes
                ? alignUp(vertexBytes, UNIFORM_OFFSET_ALIGNMENT) : 0;
            const total = Math.max(16, vertexBytes, pixelOffset + pixelBytes);
            const backing = new ArrayBuffer(alignUp(total, 4));

            if (program.vertexReflection) {
                this.writeConstantRegisters(backing, 0, program.vertexReflection,
                    state.vsConstF, state.vsConstI, state.vsConstB);
            } else {
                // D3D stores matrices row-major for row-vector maths (v * M);
                // WGSL reads a uniform mat4x4 column-major and applies M * v.
                // Those two conventions cancel: the *same bytes* that describe
                // M to D3D describe M-transpose to WGSL, and M-transpose is
                // exactly the column-vector form of D3D's row-vector M. So the
                // raw World*View*Projection product is uploaded unchanged.
                const data = new Float32Array(backing, 0, 44);
                // XYZRHW vertices are already in viewport space, so the
                // transform chain is bypassed and the shader's screen-space
                // branch does the NDC conversion from the viewport size below.
                const screenSpace = program.fixedFunctionSignature &&
                    program.fixedFunctionSignature.positionType === "screen";
                data.set(screenSpace ? IDENTITY4x4 : this.wvp(state), 0);
                data[16] = state.viewport.width || 1;
                data[17] = state.viewport.height || 1;
                // Stage 0's texture matrix, uploaded unchanged (see the shader).
                data.set(state.transforms.get(D3DTS_TEXTURE0) || IDENTITY4x4, 20);
                if (program.fogMode) {
                    const rs = state.renderStates;
                    const fogColor = rs.get(D3DRS_FOGCOLOR) || 0;
                    data[36] = ((fogColor >>> 16) & 0xff) / 255;
                    data[37] = ((fogColor >>> 8) & 0xff) / 255;
                    data[38] = (fogColor & 0xff) / 255;
                    data[39] = 1;
                    // FOGSTART/FOGEND/FOGDENSITY are floats carried in a DWORD.
                    const asFloat = (id, fallback) => {
                        const raw = rs.get(id);
                        if (raw === undefined) return fallback;
                        FLOAT_BITS_U32[0] = raw >>> 0;
                        return FLOAT_BITS_F32[0];
                    };
                    data[40] = asFloat(D3DRS_FOGSTART, 0);
                    data[41] = asFloat(D3DRS_FOGEND, 1);
                    data[42] = asFloat(D3DRS_FOGDENSITY, 1);
                }
            }
            if (program.pixelReflection) {
                this.writeConstantRegisters(backing, pixelOffset,
                    program.pixelReflection, state.psConstF, state.psConstI,
                    state.psConstB);
            } else if (program.pixelUniformBytes) {
                const fogColor = state.renderStates.get(D3DRS_FOGCOLOR) || 0;
                new Float32Array(backing, pixelOffset, 4).set([
                    ((fogColor >>> 16) & 0xff) / 255,
                    ((fogColor >>> 8) & 0xff) / 255,
                    (fogColor & 0xff) / 255, 1,
                ]);
            }

            const buffer = this.device.createBuffer({
                size: backing.byteLength,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, backing);
            this.stats.constantUploadBytes += backing.byteLength;
            this.retireAfterSubmit(buffer);
            return { buffer, vertexBytes, pixelOffset, pixelBytes };
        }

        // Packs one stage's register file into the layout the translated WGSL
        // declares (plan 9.7): float4 c# registers, then int4 i#, then one
        // 32-bit slot per bool b#. `def`/`defi`/`defb` literals are written
        // last because a shader's own constant definitions take effect while
        // it is bound, over whatever the app last set for that register.
        writeConstantRegisters(backing, byteOffset, reflection, constF, constI, constB) {
            const floats = new Float32Array(backing, byteOffset,
                reflection.floatConstCount * 4);
            floats.set(constF.subarray(0, Math.min(constF.length, floats.length)));
            for (const item of reflection.floatDefaults) {
                if ((item.register + 1) * 4 > floats.length) continue;
                floats.set(item.values, item.register * 4);
            }
            const intOffset = byteOffset + reflection.floatRegionBytes;
            const ints = new Int32Array(backing, intOffset, reflection.intConstCount * 4);
            ints.set(constI.subarray(0, Math.min(constI.length, ints.length)));
            for (const item of reflection.intDefaults) {
                if ((item.register + 1) * 4 > ints.length) continue;
                ints.set(item.values, item.register * 4);
            }
            const boolOffset = intOffset + reflection.intRegionBytes;
            const bools = new Uint32Array(backing, boolOffset,
                reflection.boolVectorCount * 4);
            bools.set(constB.subarray(0, Math.min(constB.length, bools.length)));
            for (const item of reflection.boolDefaults) {
                if (item.register >= bools.length) continue;
                bools[item.register] = item.value ? 1 : 0;
            }
        }

        retireAfterSubmit(buffer) {
            const frame = this.ensureFrame();
            (frame.transientBuffers || (frame.transientBuffers = [])).push(buffer);
        }

        bindGroupFor(state, pipeline, program, constants) {
            const entries = [{ binding: 0, resource: { buffer: constants.buffer,
                offset: 0, size: Math.max(16, constants.vertexBytes) } }];
            if (program.pixelUniformBytes)
                entries.push({ binding: 1, resource: { buffer: constants.buffer,
                    offset: constants.pixelOffset,
                    size: Math.max(16, constants.pixelBytes) } });
            for (const index of program.samplerIndices) {
                const texture = this.resources.get(state.textures.get(index));
                if (texture && this.frame) texture.frameReferenced = this.frame.serial;
                if (texture && texture.uploadedLevels &&
                        texture.uploadedLevels.size < texture.levelCount) {
                    ++this.stats.drawsWithIncompleteMipChain;
                    this.warnOnce("incomplete-mips",
                        "a bound texture declares more mip levels than were " +
                        "ever uploaded; the missing levels contain undefined " +
                        "data, so sampling them shows the wrong image " +
                        "entirely. Try v86gl.d3d9Executor.debug.forceMipLevel0" +
                        " = true to confirm.", {
                            format: texture.format,
                            size: texture.width + "x" + texture.height,
                            declaredLevels: texture.levelCount,
                            uploadedLevels: [...texture.uploadedLevels].sort(
                                (a, b) => a - b),
                        });
                }
                // A shader can sample a stage the app left unbound; a 1x1
                // white texture keeps the draw legal and visually neutral
                // rather than dropping it.
                entries.push(
                    { binding: 2 + index * 2,
                      resource: texture ? texture.view : this.fallbackView },
                    { binding: 3 + index * 2,
                      resource: this.samplerFor(state, index) });
            }
            return this.device.createBindGroup(
                { layout: pipeline._bindGroupLayout, entries });
        }

        // Builds the pipeline/uniform buffer/bind group eagerly (none of
        // those are tied to the swapchain's current texture, so there is no
        // staleness concern in creating them now) but only *records* the
        // draw as a pending op -- see the comment on ensureFrame() for why
        // the actual pass.draw()/drawIndexed() call must wait until
        // finishFrame() replays it against a freshly-acquired texture.
        //
        // The stride each stream contributes is the one the application bound
        // via SetStreamSource (or that a Draw*UP command carried). It must
        // never be inferred from the vertex declaration: a declaration's
        // consumed elements are only part of the vertex, so a computed stride
        // is too small whenever the format carries anything the shader skips
        // (NORMAL, extra texcoords, padding) and every vertex after the first
        // would then be fetched from the wrong offset.
        recordDraw(state, elements, which, geometry) {
            const pipelineState = this.pipelineStateFor(state);
            const program = this.programFor(state, elements, pipelineState);
            if (program.error) {
                if (program.shaderError) ++this.stats.drawsSkippedForBadShader;
                this.noteDroppedDraw(which, state, [program.error]);
                return;
            }
            const pipeline = this.pipelineFor(program, pipelineState,
                geometry.topology, geometry.stripIndexFormat);
            const constants = this.constantBufferFor(state, program);
            const bindGroup = this.bindGroupFor(state, pipeline, program, constants);
            // Bind each stream the pipeline declared a layout for, in the same
            // order, so slot N in the pipeline is slot N here.
            const vertexBuffers = [];
            for (const layout of program.vertexBuffers) {
                const binding = geometry.streams.get(layout.stream);
                if (!binding) {
                    this.noteDroppedDraw(which, state,
                        ["stream " + layout.stream + " is referenced by the " +
                         "declaration but not bound"]);
                    return;
                }
                vertexBuffers.push({ buffer: binding.buffer, offset: binding.offset });
            }
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
            // Mark every buffer this draw reads as "observed at this frame's
            // contents". applyBufferUpdate() uses that to notice a write that
            // would retroactively change what an already-recorded draw sees.
            for (const layout of program.vertexBuffers) {
                const binding = geometry.streams.get(layout.stream);
                if (binding && binding.resource)
                    binding.resource.frameReferenced = frame.serial;
            }
            if (geometry.indexResource)
                geometry.indexResource.frameReferenced = frame.serial;
            frame.ops.push({
                kind: "draw", pipeline, bindGroup,
                viewport: { ...state.viewport },
                vertexBuffers, indexInfo: geometry.indexInfo,
                vertexCount: geometry.vertexCount,
            });
            // The pointer is almost always the final thing a frame draws, so
            // the texture bound by the last draw is the quickest way to name
            // the cursor's texture without hunting through the whole atlas set.
            if (program.samplerIndices.length)
                this.stats.lastDrawTexture =
                    state.textures.get(program.samplerIndices[0]) || 0;
            if (state.vertexShaderHandle || state.pixelShaderHandle)
                ++this.stats.programmableDraws;
            if (geometry.indexInfo) ++this.stats.indexedDrawCalls;
            else ++this.stats.drawCalls;
        }

        // Every draw path below can bail out for several different reasons,
        // and silently dropping them looks identical to "the app never drew"
        // from the outside -- exactly the blind spot that hid a stalled
        // renderer behind healthy-looking batch/present counters. Count every
        // drop and describe the first one in full.
        noteDroppedDraw(which, state, reasons) {
            ++this.stats.droppedDraws;
            const key = which + ":" + reasons.join(";");
            this.droppedDrawReasons = this.droppedDrawReasons || new Set();
            if (this.droppedDrawReasons.has(key)) return;
            this.droppedDrawReasons.add(key);
            const declaration = this.resources.get(state.vertexDeclarationHandle);
            console.warn("[d3d9-webgpu] " + which + " dropped: " +
                reasons.join("; "), {
                    reasons,
                    hasFvfElements: !!state.fvfElements,
                    vertexDeclarationHandle: state.vertexDeclarationHandle,
                    declarationResourceFound: !!declaration,
                    declarationElements: this.currentElements(state),
                    vertexShaderHandle: state.vertexShaderHandle,
                    pixelShaderHandle: state.pixelShaderHandle,
                    stream0: state.streams.get(0) || null,
                    indexBufferHandle: state.indexBufferHandle,
                    resourceCount: this.resources.size,
                });
        }

        // Collects the vertex buffers a draw will bind, keyed by stream. The
        // per-stream byte offset folds in both SetStreamSource's OffsetInBytes
        // and (for a non-indexed draw) StartVertex, because WebGPU takes the
        // first-vertex offset on setVertexBuffer rather than on draw().
        boundStreams(state, extraVertexOffset) {
            const streams = new Map();
            for (const [index, binding] of state.streams) {
                const resource = this.resources.get(binding.bufferHandle);
                if (!resource || !resource.gpuBuffer) continue;
                streams.set(index, { buffer: resource.gpuBuffer, resource,
                    offset: (binding.offsetInBytes || 0) +
                        (extraVertexOffset || 0) * (binding.stride || 0) });
            }
            return streams;
        }

        onDrawPrimitive(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const startVertex = view.getUint32(offset + 8, true);
            const primitiveCount = view.getUint32(offset + 12, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            if (!elements) {
                this.noteDroppedDraw("DrawPrimitive", state,
                    ["no vertex declaration (SetFVF/SetVertexDeclaration)"]);
                return;
            }
            const vertexCount = primitiveElementCount(primitiveType, primitiveCount);
            if (vertexCount === null) {
                this.noteDroppedDraw("DrawPrimitive", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            const streams = this.boundStreams(state, startVertex);
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                // WebGPU has no fan topology; synthesise the index buffer that
                // turns one into a triangle list.
                const indexBuffer = this.triangleFanIndexBuffer(vertexCount);
                if (!indexBuffer) {
                    this.noteDroppedDraw("DrawPrimitive", state,
                        ["triangle fan with too few vertices"]);
                    return;
                }
                this.recordDraw(state, elements, "DrawPrimitive", {
                    topology: "triangle-list", streams,
                    indexInfo: { buffer: indexBuffer, format: "uint32", offset: 0,
                        count: (vertexCount - 2) * 3, firstIndex: 0, baseVertex: 0 },
                });
                return;
            }
            this.recordDraw(state, elements, "DrawPrimitive", {
                topology: topologyFor(primitiveType), streams,
                indexInfo: null, vertexCount,
            });
        }

        onDrawIndexedPrimitive(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const baseVertexIndex = view.getInt32(offset + 8, true);
            const startIndex = view.getUint32(offset + 20, true);
            const primitiveCount = view.getUint32(offset + 24, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            const ib = this.resources.get(state.indexBufferHandle);
            if (!elements || !ib) {
                const reasons = [];
                if (!elements) reasons.push("no vertex declaration (SetFVF/SetVertexDeclaration)");
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
            const streams = this.boundStreams(state, 0);
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                // Re-index the fan through the buffer's CPU mirror; the GPU
                // copy is write-only from here.
                const converted = this.triangleFanFromIndices(ib, startIndex, indexCount);
                if (!converted) {
                    this.noteDroppedDraw("DrawIndexedPrimitive", state,
                        ["indexed triangle fan could not be converted"]);
                    return;
                }
                this.recordDraw(state, elements, "DrawIndexedPrimitive", {
                    topology: "triangle-list", streams,
                    indexInfo: { buffer: converted.buffer, format: "uint32",
                        offset: 0, count: converted.count, firstIndex: 0,
                        baseVertex: baseVertexIndex },
                });
                return;
            }
            const topology = topologyFor(primitiveType);
            this.recordDraw(state, elements, "DrawIndexedPrimitive", {
                topology, streams,
                stripIndexFormat: isStripTopology(topology) ? ib.indexFormat : undefined,
                indexResource: ib,
                indexInfo: { buffer: ib.gpuBuffer, format: ib.indexFormat, offset: 0,
                    count: indexCount, firstIndex: startIndex,
                    baseVertex: baseVertexIndex },
            });
        }

        onDrawPrimitiveUP(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const primitiveCount = view.getUint32(offset + 8, true);
            const stride = view.getUint32(offset + 12, true);
            const vertexBytes = view.getUint32(offset + 20, true);
            const dataOffset = view.getUint32(offset + 24, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            if (!elements) {
                this.noteDroppedDraw("DrawPrimitiveUP", state,
                    ["no vertex declaration (SetFVF/SetVertexDeclaration)"]);
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
            // Draw*UP feeds one implicit stream 0 whose stride the command
            // carries, not one bound through SetStreamSource.
            const streams = new Map([[0, { buffer, offset: 0 }]]);
            const geometry = { streams, indexInfo: null, vertexCount: elementCount,
                topology: topologyFor(primitiveType) };
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                const indexBuffer = this.triangleFanIndexBuffer(elementCount);
                if (!indexBuffer) {
                    this.noteDroppedDraw("DrawPrimitiveUP", state,
                        ["triangle fan with too few vertices"]);
                    return;
                }
                geometry.topology = "triangle-list";
                geometry.indexInfo = { buffer: indexBuffer, format: "uint32",
                    offset: 0, count: (elementCount - 2) * 3, firstIndex: 0,
                    baseVertex: 0 };
            }
            this.recordDrawWithStride(state, elements, "DrawPrimitiveUP",
                geometry, stride);
            ++this.stats.upDrawCalls;
        }

        onDrawIndexedPrimitiveUP(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const primitiveCount = view.getUint32(offset + 16, true);
            const indexFormatValue = view.getUint32(offset + 20, true);
            // M1 never read `stride` out of this payload but referenced it
            // when recording the draw, so every DrawIndexedPrimitiveUP threw
            // a ReferenceError and took the whole batch down with it (the
            // batch's catch handler discarded the frame). War3's main menu
            // happens not to use this entry point, which is why it stayed
            // hidden.
            const stride = view.getUint32(offset + 24, true);
            const indexBytes = view.getUint32(offset + 32, true);
            const vertexBytes = view.getUint32(offset + 36, true);
            const indexDataOffset = view.getUint32(offset + 40, true);
            const vertexDataOffset = view.getUint32(offset + 44, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            if (!elements) {
                this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                    ["no vertex declaration (SetFVF/SetVertexDeclaration)"]);
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
            const format = indexFormatValue === D3DFMT_INDEX32 ? "uint32" : "uint16";
            const topology = topologyFor(primitiveType);
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                    ["indexed triangle fans are not converted on the UP path"]);
                return;
            }
            this.recordDrawWithStride(state, elements, "DrawIndexedPrimitiveUP", {
                topology,
                streams: new Map([[0, { buffer: vertexBuffer, offset: 0 }]]),
                stripIndexFormat: isStripTopology(topology) ? format : undefined,
                indexInfo: { buffer: indexBuffer, format, offset: 0,
                    count: elementCount, firstIndex: 0, baseVertex: 0 },
            }, stride);
            ++this.stats.upDrawCalls;
        }

        // Draw*UP carries its own stride rather than having one bound through
        // SetStreamSource, so vertexBufferLayoutsFor() -- which reads
        // state.streams -- needs stream 0 temporarily standing in for it.
        recordDrawWithStride(state, elements, which, geometry, stride) {
            const saved = state.streams.get(0);
            state.streams.set(0, { bufferHandle: 0, stride, offsetInBytes: 0 });
            try {
                this.recordDraw(state, elements, which, geometry);
            } finally {
                if (saved) state.streams.set(0, saved);
                else state.streams.delete(0);
            }
        }

        // (0,1,2), (0,2,3), (0,3,4)... -- the triangle list a fan of
        // `vertexCount` vertices expands to.
        triangleFanIndexBuffer(vertexCount) {
            if (vertexCount < 3) return null;
            const triangles = vertexCount - 2;
            const indices = new Uint32Array(triangles * 3);
            for (let i = 0; i < triangles; ++i) {
                indices[i * 3] = 0;
                indices[i * 3 + 1] = i + 1;
                indices[i * 3 + 2] = i + 2;
            }
            const buffer = this.device.createBuffer({
                size: indices.byteLength,
                usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, indices);
            this.retireAfterSubmit(buffer);
            return buffer;
        }

        triangleFanFromIndices(indexResource, firstIndex, indexCount) {
            if (indexCount < 3 || !indexResource.shadow) return null;
            const wide = indexResource.indexFormat === "uint32";
            const source = wide
                ? new Uint32Array(indexResource.shadow.buffer,
                    indexResource.shadow.byteOffset, indexResource.shadow.length >> 2)
                : new Uint16Array(indexResource.shadow.buffer,
                    indexResource.shadow.byteOffset, indexResource.shadow.length >> 1);
            if (firstIndex + indexCount > source.length) return null;
            const triangles = indexCount - 2;
            const indices = new Uint32Array(triangles * 3);
            const hub = source[firstIndex];
            for (let i = 0; i < triangles; ++i) {
                indices[i * 3] = hub;
                indices[i * 3 + 1] = source[firstIndex + i + 1];
                indices[i * 3 + 2] = source[firstIndex + i + 2];
            }
            const buffer = this.device.createBuffer({
                size: indices.byteLength,
                usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, indices);
            this.retireAfterSubmit(buffer);
            return { buffer, count: indices.length };
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

    // D3DPRIMITIVETYPE -> GPUPrimitiveTopology. M1 hardcoded "triangle-list"
    // for every draw while still computing strip/fan element counts, so a
    // strip of N triangles was rasterised as floor((N+2)/3) unrelated
    // triangles -- geometry that is wrong rather than missing, and therefore
    // easy to mistake for a transform bug. TRIANGLEFAN has no WebGPU
    // topology at all and is converted to an indexed triangle list by the
    // callers instead.
    function topologyFor(type) {
        switch (type) {
        case D3DPT_POINTLIST: return "point-list";
        case D3DPT_LINELIST: return "line-list";
        case D3DPT_LINESTRIP: return "line-strip";
        case D3DPT_TRIANGLESTRIP: return "triangle-strip";
        default: return "triangle-list";
        }
    }

    function isStripTopology(topology) {
        return topology === "triangle-strip" || topology === "line-strip";
    }

    global.D3D9WebGPUExecutor = D3D9WebGPUExecutor;
    global.installD3D9WebGPUExecutor = function(canvas, options) {
        return new D3D9WebGPUExecutor(canvas, options);
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            D3D9WebGPUExecutor,
            V86GL_CTRL_D3D9_BATCH: 0xFFE1,
            // Exported so the WGSL validation test can run the synthesised
            // fixed-function stages through a real compiler alongside the
            // translated ones -- they meet over the same varying contract and
            // a mistake in either breaks the same pipelines.
            buildFixedFunctionVertexShader,
            buildFixedFunctionPixelShader,
        };
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
