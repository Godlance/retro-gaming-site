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
    const D8WG_VERSION_MINOR = 3;
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
    const OP_CREATE_TEXTURE = 0x110;
    const OP_UPDATE_TEXTURE = 0x111;
    const OP_SET_RENDER_STATE = 0x200;
    const OP_SET_TEXTURE_STAGE_STATE = 0x201;
    const OP_SET_TEXTURE = 0x202;
    const OP_SET_VIEWPORT = 0x203;
    const OP_SET_STREAM_SOURCE = 0x208;
    const OP_SET_INDICES = 0x209;
    const OP_SET_VERTEX_FORMAT = 0x20A;
    const OP_DRAW_PRIMITIVE = 0x300;
    const OP_DRAW_INDEXED_PRIMITIVE = 0x301;
    const OP_DRAW_PRIMITIVE_UP = 0x302;
    const OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303;

    const RESOURCE_BUFFER_VERTEX = 1;
    const RESOURCE_BUFFER_INDEX = 2;
    const RESOURCE_TEXTURE_2D = 3;
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
    const D3DFVF_POSITION_MASK = 0x00E;
    const D3DFVF_XYZRHW = 0x004;
    const D3DFVF_DIFFUSE = 0x040;
    const D3DFVF_SPECULAR = 0x080;
    const D3DFVF_TEXCOUNT_MASK = 0xF00;
    const D3DFVF_TEXCOUNT_SHIFT = 8;

    const D3DRS_ALPHATESTENABLE = 15;
    const D3DRS_SRCBLEND = 19;
    const D3DRS_DESTBLEND = 20;
    const D3DRS_CULLMODE = 22;
    const D3DRS_ALPHAREF = 24;
    const D3DRS_ALPHAFUNC = 25;
    const D3DRS_ALPHABLENDENABLE = 27;
    const D3DRS_SPECULARENABLE = 29;
    const D3DRS_TEXTUREFACTOR = 60;
    const D3DRS_COLORWRITEENABLE = 168;
    const D3DCULL_NONE = 1;
    const D3DCULL_CCW = 3;

    const D3DTSS_COLOROP = 1;
    const D3DTSS_COLORARG1 = 2;
    const D3DTSS_COLORARG2 = 3;
    const D3DTSS_ALPHAOP = 4;
    const D3DTSS_ALPHAARG1 = 5;
    const D3DTSS_ALPHAARG2 = 6;
    const D3DTSS_TEXCOORDINDEX = 11;
    const D3DTSS_ADDRESSU = 13;
    const D3DTSS_ADDRESSV = 14;
    const D3DTSS_MAGFILTER = 16;
    const D3DTSS_MINFILTER = 17;
    const D3DTSS_MIPFILTER = 18;
    const D3DTSS_MAXMIPLEVEL = 20;
    const D3DTSS_MAXANISOTROPY = 21;
    const D3DTSS_COLORARG0 = 26;
    const D3DTSS_ALPHAARG0 = 27;
    const D3DTSS_RESULTARG = 28;

    const D3DTOP_DISABLE = 1;
    const D3DTA_SELECTMASK = 0xF;
    const D3DTA_DIFFUSE = 0;
    const D3DTA_CURRENT = 1;
    const D3DTA_TEXTURE = 2;
    const D3DTA_TFACTOR = 3;
    const D3DTA_SPECULAR = 4;
    const D3DTA_TEMP = 5;
    const D3DTA_COMPLEMENT = 0x10;
    const D3DTA_ALPHAREPLICATE = 0x20;

    const BUFFER_USAGE_COPY_SRC = 0x04;
    const BUFFER_USAGE_COPY_DST = 0x08;
    const BUFFER_USAGE_INDEX = 0x10;
    const BUFFER_USAGE_VERTEX = 0x20;
    const BUFFER_USAGE_UNIFORM = 0x40;
    const TEXTURE_USAGE_COPY_DST = 0x02;
    const TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
    const TRANSIENT_BUFFER_BYTES = 16 * 1024 * 1024;
    const D3DLOCK_DISCARD = 0x2000;

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

    function textureFormatInfo(format) {
        switch (format >>> 0) {
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8:
            return { blockWidth: 1, blockHeight: 1, blockBytes: 4 };
        case D3DFMT_R5G6B5:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
            return { blockWidth: 1, blockHeight: 1, blockBytes: 2 };
        case D3DFMT_L8:
        case D3DFMT_A8:
            return { blockWidth: 1, blockHeight: 1, blockBytes: 1 };
        case D3DFMT_DXT1:
            return { blockWidth: 4, blockHeight: 4, blockBytes: 8, dxt: 1 };
        case D3DFMT_DXT3:
            return { blockWidth: 4, blockHeight: 4, blockBytes: 16, dxt: 3 };
        case D3DFMT_DXT5:
            return { blockWidth: 4, blockHeight: 4, blockBytes: 16, dxt: 5 };
        default:
            return null;
        }
    }

    function expand5(value) { return value * 255 / 31 | 0; }
    function expand6(value) { return value * 255 / 63 | 0; }

    function dxtColours(source, offset, allowTransparent) {
        const c0 = source[offset] | source[offset + 1] << 8;
        const c1 = source[offset + 2] | source[offset + 3] << 8;
        const first = [expand5(c0 >>> 11), expand6((c0 >>> 5) & 63),
            expand5(c0 & 31), 255];
        const second = [expand5(c1 >>> 11), expand6((c1 >>> 5) & 63),
            expand5(c1 & 31), 255];
        const colours = [first, second];
        if (allowTransparent && c0 <= c1) {
            colours.push(first.map((value, i) => i === 3 ? 255 :
                (value + second[i]) / 2 | 0));
            colours.push([0, 0, 0, 0]);
        } else {
            colours.push(first.map((value, i) => i === 3 ? 255 :
                (2 * value + second[i]) / 3 | 0));
            colours.push(first.map((value, i) => i === 3 ? 255 :
                (value + 2 * second[i]) / 3 | 0));
        }
        return colours;
    }

    function dxt5Alphas(source, offset) {
        const a0 = source[offset];
        const a1 = source[offset + 1];
        const values = [a0, a1];
        if (a0 > a1) {
            for (let i = 1; i <= 6; i++)
                values.push(((7 - i) * a0 + i * a1) / 7 | 0);
        } else {
            for (let i = 1; i <= 4; i++)
                values.push(((5 - i) * a0 + i * a1) / 5 | 0);
            values.push(0, 255);
        }
        return values;
    }

    function decodeDXT(format, source, width, height, rowPitch) {
        const info = textureFormatInfo(format);
        const output = new Uint8Array(width * height * 4);
        const blockColumns = Math.ceil(width / 4);
        const blockRows = Math.ceil(height / 4);
        for (let by = 0; by < blockRows; by++) {
            for (let bx = 0; bx < blockColumns; bx++) {
                const block = by * rowPitch + bx * info.blockBytes;
                const colourOffset = block + (info.dxt === 1 ? 0 : 8);
                const colours = dxtColours(source, colourOffset,
                    info.dxt === 1);
                const colourBits = u32(source, colourOffset + 4);
                const alphaValues = info.dxt === 5 ? dxt5Alphas(source, block) : null;
                for (let py = 0; py < 4; py++) {
                    for (let px = 0; px < 4; px++) {
                        const x = bx * 4 + px;
                        const y = by * 4 + py;
                        if (x >= width || y >= height) continue;
                        const pixel = py * 4 + px;
                        const colour = colours[(colourBits >>> (pixel * 2)) & 3];
                        const destination = (y * width + x) * 4;
                        output[destination] = colour[0];
                        output[destination + 1] = colour[1];
                        output[destination + 2] = colour[2];
                        if (info.dxt === 3) {
                            const packed = source[block + (pixel >>> 1)];
                            const nibble = pixel & 1 ? packed >>> 4 : packed & 15;
                            output[destination + 3] = nibble * 17;
                        } else if (info.dxt === 5) {
                            const bit = pixel * 3;
                            const byte = bit >>> 3;
                            const shift = bit & 7;
                            const packed = source[block + 2 + byte] |
                                (source[block + 3 + byte] || 0) << 8;
                            output[destination + 3] = alphaValues[(packed >>> shift) & 7];
                        } else {
                            output[destination + 3] = colour[3];
                        }
                    }
                }
            }
        }
        return output;
    }

    function decodeTextureUpload(format, source, width, height, rowPitch) {
        const info = textureFormatInfo(format);
        if (!info) throw new Error("unsupported D3D8 texture format " + format);
        if (info.dxt) return decodeDXT(format, source, width, height, rowPitch);
        const output = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const sourceOffset = y * rowPitch + x * info.blockBytes;
                const destination = (y * width + x) * 4;
                let r, g, b, a;
                if (format === D3DFMT_A8R8G8B8 || format === D3DFMT_X8R8G8B8) {
                    b = source[sourceOffset];
                    g = source[sourceOffset + 1];
                    r = source[sourceOffset + 2];
                    a = format === D3DFMT_A8R8G8B8 ? source[sourceOffset + 3] : 255;
                } else if (format === D3DFMT_L8) {
                    r = g = b = source[sourceOffset]; a = 255;
                } else if (format === D3DFMT_A8) {
                    r = g = b = 255; a = source[sourceOffset];
                } else {
                    const value = source[sourceOffset] | source[sourceOffset + 1] << 8;
                    if (format === D3DFMT_R5G6B5) {
                        r = expand5(value >>> 11); g = expand6((value >>> 5) & 63);
                        b = expand5(value & 31); a = 255;
                    } else if (format === D3DFMT_A4R4G4B4) {
                        a = (value >>> 12) * 17; r = ((value >>> 8) & 15) * 17;
                        g = ((value >>> 4) & 15) * 17; b = (value & 15) * 17;
                    } else {
                        a = format === D3DFMT_A1R5G5B5 && (value & 0x8000) ? 255 :
                            format === D3DFMT_X1R5G5B5 ? 255 : 0;
                        r = expand5((value >>> 10) & 31);
                        g = expand5((value >>> 5) & 31);
                        b = expand5(value & 31);
                    }
                }
                output[destination] = r;
                output[destination + 1] = g;
                output[destination + 2] = b;
                output[destination + 3] = a;
            }
        }
        return output;
    }

    function parseFVF(fvf, stride) {
        if ((fvf & D3DFVF_POSITION_MASK) !== D3DFVF_XYZRHW) return null;
        const attributes = [{ shaderLocation: 0, offset: 0, format: "float32x4" }];
        let offset = 16;
        const result = { attributes, diffuse: false, specular: false,
            texDims: [], minimumStride: 16 };
        if (fvf & D3DFVF_DIFFUSE) {
            attributes.push({ shaderLocation: 1, offset, format: "unorm8x4" });
            result.diffuse = true;
            offset += 4;
        }
        if (fvf & D3DFVF_SPECULAR) {
            attributes.push({ shaderLocation: 2, offset, format: "unorm8x4" });
            result.specular = true;
            offset += 4;
        }
        const textureCount = (fvf & D3DFVF_TEXCOUNT_MASK) >>>
            D3DFVF_TEXCOUNT_SHIFT;
        if (textureCount > 2) return null;
        for (let stage = 0; stage < textureCount; stage++) {
            const code = (fvf >>> (16 + stage * 2)) & 3;
            const dimensions = [2, 3, 4, 1][code];
            result.texDims.push(dimensions);
            attributes.push({ shaderLocation: 3 + stage, offset,
                format: dimensions === 1 ? "float32" : "float32x" + dimensions });
            offset += dimensions * 4;
        }
        result.minimumStride = offset;
        return stride >= offset ? result : null;
    }

    function textureArgument(argument, stage) {
        let expression;
        switch (argument & D3DTA_SELECTMASK) {
        case D3DTA_DIFFUSE: expression = "input.diffuse"; break;
        case D3DTA_CURRENT: expression = "current"; break;
        case D3DTA_TEXTURE: expression = "stage" + stage + "Texture"; break;
        case D3DTA_TFACTOR: expression = "textureFactor"; break;
        case D3DTA_SPECULAR: expression = "input.specular"; break;
        case D3DTA_TEMP: expression = "temporary"; break;
        default: expression = "current"; break;
        }
        if (argument & D3DTA_COMPLEMENT)
            expression = "(vec4<f32>(1.0) - " + expression + ")";
        if (argument & D3DTA_ALPHAREPLICATE)
            expression = "(" + expression + ").aaaa";
        return expression;
    }

    function textureOperation(operation, one, two, zero, stage) {
        const texture = "stage" + stage + "Texture";
        switch (operation >>> 0) {
        case 2: return one;
        case 3: return two;
        case 4: return "(" + one + " * " + two + ")";
        case 5: return "(" + one + " * " + two + " * 2.0)";
        case 6: return "(" + one + " * " + two + " * 4.0)";
        case 7: return "(" + one + " + " + two + ")";
        case 8: return "(" + one + " + " + two + " - vec4<f32>(0.5))";
        case 9: return "((" + one + " + " + two + " - vec4<f32>(0.5)) * 2.0)";
        case 10: return "(" + one + " - " + two + ")";
        case 11: return "(" + one + " + " + two + " * (vec4<f32>(1.0) - " + one + "))";
        case 12: return "mix(" + two + ", " + one + ", input.diffuse.aaaa)";
        case 13: return "mix(" + two + ", " + one + ", " + texture + ".aaaa)";
        case 14: return "mix(" + two + ", " + one + ", textureFactor.aaaa)";
        case 15: return "(" + one + " + " + two + " * (vec4<f32>(1.0) - " + texture + ".aaaa))";
        case 16: return "mix(" + two + ", " + one + ", current.aaaa)";
        case 18: return "vec4<f32>(" + one + ".rgb + " + one + ".aaa * " + two + ".rgb, " + one + ".a)";
        case 19: return "vec4<f32>(" + one + ".rgb * " + two + ".rgb + " + one + ".aaa, " + one + ".a)";
        case 20: return "vec4<f32>(" + one + ".rgb + (vec3<f32>(1.0) - " + one + ".aaa) * " + two + ".rgb, " + one + ".a)";
        case 21: return "vec4<f32>((vec3<f32>(1.0) - " + one + ".rgb) * " + two + ".rgb + " + one + ".aaa, " + one + ".a)";
        case 24: return "vec4<f32>(vec3<f32>(dot((" + one + ".rgb - vec3<f32>(0.5)) * 2.0, (" + two + ".rgb - vec3<f32>(0.5)) * 2.0)), 1.0)";
        case 25: return "(" + one + " * " + two + " + " + zero + ")";
        case 26: return "mix(" + two + ", " + one + ", " + zero + ")";
        default: return one;
        }
    }

    function alphaTestDiscard(func) {
        const alpha = "round(clamp(current.a, 0.0, 1.0) * 255.0)";
        const ref = "surface.alpha_ref";
        switch (func >>> 0) {
        case 1: return "true";
        case 2: return alpha + " >= " + ref;
        case 3: return alpha + " != " + ref;
        case 4: return alpha + " > " + ref;
        case 5: return alpha + " <= " + ref;
        case 6: return alpha + " == " + ref;
        case 7: return alpha + " < " + ref;
        case 8: return "false";
        default: return "false";
        }
    }

    function blendFactor(value) {
        return ({ 1: "zero", 2: "one", 3: "src", 4: "one-minus-src",
            5: "src-alpha", 6: "one-minus-src-alpha", 7: "dst-alpha",
            8: "one-minus-dst-alpha", 9: "dst", 10: "one-minus-dst",
            11: "src-alpha-saturated", 12: "src-alpha",
            13: "one-minus-src-alpha" })[value >>> 0] || "one";
    }

    function blendState(state) {
        let source = state.renderStates[D3DRS_SRCBLEND] >>> 0;
        let destination = state.renderStates[D3DRS_DESTBLEND] >>> 0;
        if (source === 12) {
            source = 5;
            destination = 6;
        } else if (source === 13) {
            source = 6;
            destination = 5;
        }
        return {
            color: { operation: "add", srcFactor: blendFactor(source),
                dstFactor: blendFactor(destination) },
            alpha: { operation: "add", srcFactor: blendFactor(source),
                dstFactor: blendFactor(destination) },
        };
    }

    function fixedFunctionShader(state, layout) {
        const inputs = ["    @location(0) position: vec4<f32>,"];
        if (layout.diffuse) inputs.push("    @location(1) diffuse_bgra: vec4<f32>,");
        if (layout.specular) inputs.push("    @location(2) specular_bgra: vec4<f32>,");
        for (let stage = 0; stage < layout.texDims.length; stage++) {
            const dimensions = layout.texDims[stage];
            inputs.push("    @location(" + (3 + stage) + ") tex" + stage +
                ": " + (dimensions === 1 ? "f32" : "vec" + dimensions + "<f32>") + ",");
        }
        const vertexAssignments = [
            "    output.diffuse = " + (layout.diffuse ? "input.diffuse_bgra.bgra;" : "vec4<f32>(1.0);"),
            "    output.specular = " + (layout.specular ? "input.specular_bgra.bgra;" : "vec4<f32>(0.0);"),
        ];
        for (let stage = 0; stage < 2; stage++) {
            const dimensions = layout.texDims[stage] || 0;
            vertexAssignments.push("    output.tex" + stage + " = " +
                (!dimensions ? "vec2<f32>(0.0);" : dimensions === 1 ?
                    "vec2<f32>(input.tex" + stage + ", 0.0);" :
                    "input.tex" + stage + ".xy;"));
        }
        const fragment = [
            "    let textureFactor = surface.texture_factor;",
            "    var current = input.diffuse;",
            "    var temporary = vec4<f32>(0.0);",
            "    let stage0Texture = textureSample(texture0, sampler0, input.tex" +
                ((state.textureStageStates[0][D3DTSS_TEXCOORDINDEX] & 0xFFFF) === 1 ? "1" : "0") + ");",
            "    let stage1Texture = textureSample(texture1, sampler1, input.tex" +
                ((state.textureStageStates[1][D3DTSS_TEXCOORDINDEX] & 0xFFFF) === 0 ? "0" : "1") + ");",
        ];
        for (let stage = 0; stage < 2; stage++) {
            const values = state.textureStageStates[stage];
            const colorOp = values[D3DTSS_COLOROP] >>> 0;
            if (colorOp === D3DTOP_DISABLE) break;
            const color1 = textureArgument(values[D3DTSS_COLORARG1], stage);
            const color2 = textureArgument(values[D3DTSS_COLORARG2], stage);
            const color0 = textureArgument(values[D3DTSS_COLORARG0], stage);
            const alphaOp = values[D3DTSS_ALPHAOP] >>> 0;
            const alpha1 = textureArgument(values[D3DTSS_ALPHAARG1], stage);
            const alpha2 = textureArgument(values[D3DTSS_ALPHAARG2], stage);
            const alpha0 = textureArgument(values[D3DTSS_ALPHAARG0], stage);
            fragment.push("    let stage" + stage + "Color = " +
                textureOperation(colorOp, color1, color2, color0, stage) + ";");
            fragment.push("    let stage" + stage + "Alpha = " +
                (alphaOp === D3DTOP_DISABLE ? "current" :
                    textureOperation(alphaOp, alpha1, alpha2, alpha0, stage)) + ";");
            const destination = (values[D3DTSS_RESULTARG] & D3DTA_SELECTMASK) ===
                D3DTA_TEMP ? "temporary" : "current";
            fragment.push("    " + destination + " = clamp(vec4<f32>(stage" +
                stage + "Color.rgb, stage" + stage + "Alpha.a), " +
                "vec4<f32>(0.0), vec4<f32>(1.0));");
        }
        if (state.renderStates[D3DRS_SPECULARENABLE])
            fragment.push("    current = vec4<f32>(clamp(current.rgb + input.specular.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), current.a);");
        if (state.renderStates[D3DRS_ALPHATESTENABLE])
            fragment.push("    if (" + alphaTestDiscard(
                state.renderStates[D3DRS_ALPHAFUNC]) + ") { discard; }");
        fragment.push("    return current;");
        return `
struct SurfaceUniforms {
    size: vec2<f32>, inverse_size: vec2<f32>,
    texture_factor: vec4<f32>, alpha_ref: f32,
    padding0: f32, padding1: f32, padding2: f32,
};
@group(0) @binding(0) var<uniform> surface: SurfaceUniforms;
@group(0) @binding(1) var texture0: texture_2d<f32>;
@group(0) @binding(2) var sampler0: sampler;
@group(0) @binding(3) var texture1: texture_2d<f32>;
@group(0) @binding(4) var sampler1: sampler;
struct VSInput {
${inputs.join("\n")}
};
struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) diffuse: vec4<f32>,
    @location(1) specular: vec4<f32>,
    @location(2) tex0: vec2<f32>,
    @location(3) tex1: vec2<f32>,
};
@vertex fn vs_main(input: VSInput) -> VSOutput {
    var output: VSOutput;
    let pixel = input.position.xy - vec2<f32>(0.5, 0.5);
    let rhw = select(1.0, input.position.w, abs(input.position.w) > 0.000001);
    let clipW = 1.0 / rhw;
    output.position = vec4<f32>((pixel.x * surface.inverse_size.x * 2.0 - 1.0) * clipW,
        (1.0 - pixel.y * surface.inverse_size.y * 2.0) * clipW,
        clamp(input.position.z, 0.0, 1.0) * clipW, clipW);
${vertexAssignments.join("\n")}
    return output;
}
@fragment fn fs_main(input: VSOutput) -> @location(0) vec4<f32> {
${fragment.join("\n")}
}
`;
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
        renderStates[D3DRS_ALPHAFUNC] = 8; // ALWAYS
        renderStates[D3DRS_SRCBLEND] = 2; // ONE
        renderStates[D3DRS_DESTBLEND] = 1; // ZERO
        renderStates[D3DRS_TEXTUREFACTOR] = 0xFFFFFFFF;
        renderStates[D3DRS_COLORWRITEENABLE] = 0xF;
        for (let stage = 0; stage < 8; stage++) {
            textureStageStates[stage][D3DTSS_COLOROP] =
                stage === 0 ? 4 : D3DTOP_DISABLE; // MODULATE
            textureStageStates[stage][D3DTSS_COLORARG1] = D3DTA_TEXTURE;
            textureStageStates[stage][D3DTSS_COLORARG2] = D3DTA_CURRENT;
            textureStageStates[stage][D3DTSS_ALPHAOP] =
                stage === 0 ? 2 : D3DTOP_DISABLE; // SELECTARG1
            textureStageStates[stage][D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
            textureStageStates[stage][D3DTSS_ALPHAARG2] = D3DTA_CURRENT;
            textureStageStates[stage][D3DTSS_TEXCOORDINDEX] = stage;
            textureStageStates[stage][D3DTSS_ADDRESSU] = 1; // WRAP
            textureStageStates[stage][D3DTSS_ADDRESSV] = 1;
            textureStageStates[stage][D3DTSS_MAGFILTER] = 1; // POINT
            textureStageStates[stage][D3DTSS_MINFILTER] = 1;
            textureStageStates[stage][D3DTSS_MIPFILTER] = 0;
            textureStageStates[stage][D3DTSS_MAXANISOTROPY] = 1;
            textureStageStates[stage][D3DTSS_RESULTARG] = D3DTA_CURRENT;
        }
        return {
            handle,
            surface,
            renderStates,
            textureStageStates,
            streams: Array.from({ length: 16 }, () => ({ handle: 0, stride: 0 })),
            indices: { handle: 0, baseVertex: 0 },
            textures: new Uint32Array(8),
            viewport: { x: 0, y: 0, width: surface.width,
                height: surface.height, minZ: 0, maxZ: 1 },
            fvf: 0,
            inScene: false,
            uniformVariants: new Map(),
            bindGroups: new Map(),
        };
    }

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
            this.samplerCache = new Map();
            this.maxPipelines = Math.max(32, this.options.maxPipelines || 512);
            this.maxSamplers = Math.max(8, this.options.maxSamplers || 64);
            this.maxUniformVariants = Math.max(16,
                this.options.maxUniformVariants || 256);
            this.maxBindGroups = Math.max(64,
                this.options.maxBindGroups || 1024);
            this.nextPipelineId = 1;
            this.fallbackTexture = null;
            this.fallbackView = null;
            this.transientBuffer = null;
            this.transientCapacity = Math.max(1024 * 1024,
                this.options.transientBufferBytes || TRANSIENT_BUFFER_BYTES);
            this.transientCursor = 0;
            this.frame = null;
            this.readyPromise = null;
            this.work = Promise.resolve();
            this.failed = null;
            this.warned = new Set();
            this.stats = {
                batches: 0,
                commands: 0,
                presents: 0,
                queueSubmits: 0,
                drawCalls: 0,
                indexedDrawCalls: 0,
                upDrawCalls: 0,
                fanConversions: 0,
                uploadBytes: 0,
                transientUploadBytes: 0,
                transientBufferCreations: 0,
                bufferOrphans: 0,
                pipelineCreations: 0,
                pipelineCacheEvictions: 0,
                uniformCacheEvictions: 0,
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
                this.fallbackTexture = this.device.createTexture({
                    label: "D3D8 fallback white texture",
                    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                    format: "rgba8unorm",
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                this.fallbackView = this.fallbackTexture.createView();
                this.device.queue.writeTexture({ texture: this.fallbackTexture },
                    new Uint8Array([255, 255, 255, 255]),
                    { bytesPerRow: 4, rowsPerImage: 1 },
                    { width: 1, height: 1, depthOrArrayLayers: 1 });
                this.transientBuffer = this.device.createBuffer({
                    label: "D3D8 transient upload ring",
                    size: this.transientCapacity,
                    usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_INDEX |
                        BUFFER_USAGE_COPY_SRC | BUFFER_USAGE_COPY_DST,
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
            for (const buffer of state.uniformVariants.values())
                buffer.destroy();
            state.uniformVariants.clear();
            state.bindGroups.clear();
        }

        uniformFor(state) {
            const factorValue = state.renderStates[D3DRS_TEXTUREFACTOR] >>> 0;
            const alphaReference = state.renderStates[D3DRS_ALPHAREF] & 255;
            const key = factorValue + ":" + alphaReference;
            let buffer = state.uniformVariants.get(key);
            if (buffer) {
                state.uniformVariants.delete(key);
                state.uniformVariants.set(key, buffer);
                return { buffer, key };
            }
            if (state.uniformVariants.size >= this.maxUniformVariants) {
                const oldestKey = state.uniformVariants.keys().next().value;
                const oldest = state.uniformVariants.get(oldestKey);
                state.uniformVariants.delete(oldestKey);
                state.bindGroups.clear();
                if (this.frame)
                    this.frame.transientBuffers.push(oldest);
                else
                    oldest.destroy();
                this.stats.uniformCacheEvictions++;
            }
            const width = Math.max(1, state.surface.width);
            const height = Math.max(1, state.surface.height);
            const factor = d3dColor(factorValue);
            buffer = this.device.createBuffer({
                label: "D3D8 fixed uniforms " + state.handle.toString(16) +
                    " " + key,
                size: 48,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, new Float32Array([
                width, height, 1 / width, 1 / height,
                factor.r, factor.g, factor.b, factor.a,
                alphaReference, 0, 0, 0,
            ]));
            state.uniformVariants.set(key, buffer);
            return { buffer, key };
        }

        createOrResetDevice(bytes, payloadOffset, reset) {
            const handle = u32(bytes, payloadOffset);
            const surface = this.parseSurface(bytes, payloadOffset);
            let state = this.devices.get(handle);
            if (!state || !reset) {
                if (state) {
                    for (const buffer of state.uniformVariants.values())
                        buffer.destroy();
                }
                state = freshDeviceState(handle, surface);
                this.devices.set(handle, state);
            } else {
                state.surface = surface;
                state.inScene = false;
                state.viewport = { x: 0, y: 0, width: surface.width,
                    height: surface.height, minZ: 0, maxZ: 1 };
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
                this.transientCursor = 0;
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
            this.stats.queueSubmits++;
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
                if (resource.gpuTexture) resource.gpuTexture.destroy();
                this.resources.delete(handle);
                if (resource.kind === RESOURCE_TEXTURE_2D) {
                    for (const device of this.devices.values())
                        device.bindGroups.clear();
                }
            }
            const state = this.devices.get(handle);
            if (state) {
                if (this.frame && this.frame.deviceHandle === handle) {
                    const transientBuffers = this.frame.transientBuffers;
                    this.endPass();
                    this.frame = null;
                    for (const buffer of transientBuffers) buffer.destroy();
                }
                for (const buffer of state.uniformVariants.values())
                    buffer.destroy();
                for (const [resourceHandle, child] of this.resources) {
                    if (child.deviceHandle !== handle) continue;
                    if (child.gpuBuffer) child.gpuBuffer.destroy();
                    if (child.gpuTexture) child.gpuTexture.destroy();
                    this.resources.delete(resourceHandle);
                }
                this.devices.delete(handle);
                if (typeof this.options.onDestroy === "function") {
                    this.options.onDestroy(state.surface, "device");
                }
            }
        }

        pipelineFor(state, topology, stride, indexFormat) {
            const vertexLayout = parseFVF(state.fvf >>> 0, stride >>> 0);
            if (!vertexLayout) return null;
            const cull = state.renderStates[D3DRS_CULLMODE] >>> 0;
            const blend = state.renderStates[D3DRS_ALPHABLENDENABLE] >>> 0;
            const stripIndexFormat = topology.endsWith("-strip") ?
                indexFormat : undefined;
            const stageKey = [];
            const shaderStates = [D3DTSS_COLOROP, D3DTSS_COLORARG1,
                D3DTSS_COLORARG2, D3DTSS_ALPHAOP, D3DTSS_ALPHAARG1,
                D3DTSS_ALPHAARG2, D3DTSS_TEXCOORDINDEX,
                D3DTSS_COLORARG0, D3DTSS_ALPHAARG0, D3DTSS_RESULTARG];
            for (let stage = 0; stage < 2; stage++) {
                for (const selector of shaderStates)
                    stageKey.push(state.textureStageStates[stage][selector] >>> 0);
            }
            const key = [this.format, topology, stripIndexFormat || "none",
                state.fvf >>> 0, stride >>> 0,
                cull, blend,
                state.renderStates[D3DRS_SRCBLEND] >>> 0,
                state.renderStates[D3DRS_DESTBLEND] >>> 0,
                state.renderStates[D3DRS_ALPHATESTENABLE] >>> 0,
                state.renderStates[D3DRS_ALPHAFUNC] >>> 0,
                state.renderStates[D3DRS_SPECULARENABLE] >>> 0,
                state.renderStates[D3DRS_COLORWRITEENABLE] >>> 0,
                ...stageKey].join(":");
            let pipeline = this.pipelineCache.get(key);
            if (pipeline) {
                this.pipelineCache.delete(key);
                this.pipelineCache.set(key, pipeline);
                return pipeline;
            }
            const shaderModule = this.device.createShaderModule({
                label: "D3D8 fixed-function shader " + this.nextPipelineId,
                code: fixedFunctionShader(state, vertexLayout),
            });
            pipeline = this.device.createRenderPipeline({
                label: "D3D8 fixed pipeline " + key,
                layout: "auto",
                vertex: {
                    module: shaderModule,
                    entryPoint: "vs_main",
                    buffers: [{
                        arrayStride: stride,
                        stepMode: "vertex",
                        attributes: vertexLayout.attributes,
                    }],
                },
                fragment: {
                    module: shaderModule,
                    entryPoint: "fs_main",
                    targets: [{
                        format: this.format,
                        ...(blend ? { blend: blendState(state) } : {}),
                        writeMask: state.renderStates[D3DRS_COLORWRITEENABLE] & 0xF,
                    }],
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
            pipeline._d8wgId = this.nextPipelineId++;
            if (this.pipelineCache.size >= this.maxPipelines) {
                this.pipelineCache.delete(this.pipelineCache.keys().next().value);
                this.stats.pipelineCacheEvictions++;
            }
            this.pipelineCache.set(key, pipeline);
            this.stats.pipelineCreations++;
            return pipeline;
        }

        samplerFor(state, stage) {
            const values = state.textureStageStates[stage];
            const address = value => value === 1 ? "repeat" :
                value === 2 ? "mirror-repeat" : "clamp-to-edge";
            const min = values[D3DTSS_MINFILTER] === 1 ? "nearest" : "linear";
            const mag = values[D3DTSS_MAGFILTER] === 1 ? "nearest" : "linear";
            const mip = values[D3DTSS_MIPFILTER] === 2 ? "linear" : "nearest";
            let anisotropy = Math.max(1,
                Math.min(16, values[D3DTSS_MAXANISOTROPY] || 1));
            if (min !== "linear" || mag !== "linear" || mip !== "linear")
                anisotropy = 1;
            const key = [address(values[D3DTSS_ADDRESSU]),
                address(values[D3DTSS_ADDRESSV]), min, mag, mip,
                values[D3DTSS_MIPFILTER] === 0 ? 0 : 32,
                anisotropy].join(":");
            let sampler = this.samplerCache.get(key);
            if (!sampler) {
                sampler = this.device.createSampler({
                    addressModeU: address(values[D3DTSS_ADDRESSU]),
                    addressModeV: address(values[D3DTSS_ADDRESSV]),
                    addressModeW: "clamp-to-edge",
                    minFilter: min,
                    magFilter: mag,
                    mipmapFilter: mip,
                    maxLod: values[D3DTSS_MIPFILTER] === 0 ? 0 : 32,
                    maxAnisotropy: anisotropy,
                });
                sampler._d8wgKey = key;
                if (this.samplerCache.size >= this.maxSamplers)
                    this.samplerCache.delete(this.samplerCache.keys().next().value);
                this.samplerCache.set(key, sampler);
            } else {
                this.samplerCache.delete(key);
                this.samplerCache.set(key, sampler);
            }
            return sampler;
        }

        textureViewFor(state, stage) {
            const resource = this.resources.get(state.textures[stage]);
            if (!resource || resource.kind !== RESOURCE_TEXTURE_2D)
                return { resource: null, view: this.fallbackView, key: "fallback" };
            const baseLevel = Math.min(resource.levelCount - 1,
                state.textureStageStates[stage][D3DTSS_MAXMIPLEVEL] >>> 0);
            let view = resource.views.get(baseLevel);
            if (!view) {
                view = resource.gpuTexture.createView({
                    baseMipLevel: baseLevel,
                    mipLevelCount: resource.levelCount - baseLevel,
                });
                resource.views.set(baseLevel, view);
            }
            return { resource, view, key: resource.handle + "@" + baseLevel };
        }

        bindGroupFor(state, pipeline) {
            const uniforms = this.uniformFor(state);
            const texture0 = this.textureViewFor(state, 0);
            const texture1 = this.textureViewFor(state, 1);
            const sampler0 = this.samplerFor(state, 0);
            const sampler1 = this.samplerFor(state, 1);
            const key = [pipeline._d8wgId, uniforms.key,
                texture0.key, sampler0._d8wgKey,
                texture1.key, sampler1._d8wgKey].join(":");
            let group = state.bindGroups.get(key);
            if (group) {
                state.bindGroups.delete(key);
                state.bindGroups.set(key, group);
                return group;
            }
            group = this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniforms.buffer } },
                    { binding: 1, resource: texture0.view },
                    { binding: 2, resource: sampler0 },
                    { binding: 3, resource: texture1.view },
                    { binding: 4, resource: sampler1 },
                ],
            });
            if (state.bindGroups.size >= this.maxBindGroups)
                state.bindGroups.delete(state.bindGroups.keys().next().value);
            state.bindGroups.set(key, group);
            return group;
        }

        validateGeometryState(state, stride) {
            const layout = parseFVF(state.fvf >>> 0, stride >>> 0);
            if (!layout) {
                this.warnOnce("fvf-" + state.fvf,
                    "unsupported FVF in the WebGPU Maple 2D path",
                    "0x" + state.fvf.toString(16));
                this.stats.unsupportedCommands++;
                return false;
            }
            return true;
        }

        createTransientBuffer(data, usage, label) {
            if (!this.frame) throw new Error("transient buffer created outside a frame");
            const upload = padded4(data);
            let buffer = this.transientBuffer;
            let offset = align4(this.transientCursor);
            if (upload.byteLength > this.transientCapacity - offset) {
                buffer = this.device.createBuffer({
                    label: label + " overflow",
                    size: Math.max(4, upload.byteLength),
                    usage: usage | BUFFER_USAGE_COPY_SRC | BUFFER_USAGE_COPY_DST,
                });
                offset = 0;
                this.frame.transientBuffers.push(buffer);
                this.stats.transientBufferCreations++;
            } else {
                this.transientCursor = offset + upload.byteLength;
            }
            this.device.queue.writeBuffer(buffer, offset, upload);
            this.stats.transientUploadBytes += data.byteLength;
            return { buffer, offset, size: upload.byteLength };
        }

        preparePass(state, pass) {
            const x = Math.min(state.surface.width, state.viewport.x >>> 0);
            const y = Math.min(state.surface.height, state.viewport.y >>> 0);
            const width = Math.min(state.viewport.width >>> 0,
                state.surface.width - x);
            const height = Math.min(state.viewport.height >>> 0,
                state.surface.height - y);
            if (!width || !height) return false;
            pass.setScissorRect(x, y, width, height);
            return true;
        }

        createTextureResource(bytes, payloadOffset, commandEnd) {
            if (commandEnd - payloadOffset < 32)
                throw new Error("short CREATE_TEXTURE");
            const deviceHandle = u32(bytes, payloadOffset);
            const handle = u32(bytes, payloadOffset + 4);
            const width = u32(bytes, payloadOffset + 8);
            const height = u32(bytes, payloadOffset + 12);
            const levelCount = u32(bytes, payloadOffset + 16);
            const format = u32(bytes, payloadOffset + 20);
            if (!this.devices.has(deviceHandle))
                throw new Error("CREATE_TEXTURE references an unknown device");
            if (!width || !height || !levelCount || !textureFormatInfo(format))
                throw new Error("invalid CREATE_TEXTURE dimensions/format");
            const maximumLevels = 1 + Math.floor(Math.log2(
                Math.max(width, height)));
            if (levelCount > maximumLevels)
                throw new Error("CREATE_TEXTURE has too many mip levels");
            this.destroyResource(handle);
            const gpuTexture = this.device.createTexture({
                label: "D3D8 texture " + handle.toString(16),
                size: { width, height, depthOrArrayLayers: 1 },
                mipLevelCount: levelCount,
                sampleCount: 1,
                dimension: "2d",
                format: "rgba8unorm",
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            this.resources.set(handle, {
                handle,
                deviceHandle,
                kind: RESOURCE_TEXTURE_2D,
                width,
                height,
                levelCount,
                format,
                usage: u32(bytes, payloadOffset + 24),
                pool: u32(bytes, payloadOffset + 28),
                gpuTexture,
                views: new Map([[0, gpuTexture.createView()]]),
            });
        }

        updateTextureResource(bytes, payloadOffset, commandEnd) {
            if (commandEnd - payloadOffset < 40)
                throw new Error("short UPDATE_TEXTURE");
            const resource = this.resources.get(u32(bytes, payloadOffset));
            if (!resource || resource.kind !== RESOURCE_TEXTURE_2D)
                throw new Error("UPDATE_TEXTURE references an unknown texture");
            const level = u32(bytes, payloadOffset + 4);
            const x = u32(bytes, payloadOffset + 8);
            const y = u32(bytes, payloadOffset + 12);
            const width = u32(bytes, payloadOffset + 16);
            const height = u32(bytes, payloadOffset + 20);
            const rowPitch = u32(bytes, payloadOffset + 24);
            const dataBytes = u32(bytes, payloadOffset + 28);
            const dataOffset = u32(bytes, payloadOffset + 32);
            if (level >= resource.levelCount || !width || !height)
                throw new Error("invalid UPDATE_TEXTURE mip/extent");
            const levelWidth = Math.max(1, resource.width >>> level);
            const levelHeight = Math.max(1, resource.height >>> level);
            if (x > levelWidth || width > levelWidth - x ||
                    y > levelHeight || height > levelHeight - y)
                throw new Error("UPDATE_TEXTURE rectangle exceeds its mip level");
            const format = textureFormatInfo(resource.format);
            const columns = Math.ceil(width / format.blockWidth);
            const rows = Math.ceil(height / format.blockHeight);
            const minimumRow = columns * format.blockBytes;
            const minimumBytes = rowPitch * (rows - 1) + minimumRow;
            if (rowPitch < minimumRow || dataBytes < minimumBytes)
                throw new Error("UPDATE_TEXTURE pitch/data is too small");
            if (format.dxt && ((x & 3) || (y & 3) ||
                    ((width & 3) && x + width !== levelWidth) ||
                    ((height & 3) && y + height !== levelHeight)))
                throw new Error("UPDATE_TEXTURE DXT rectangle is not block aligned");
            const source = checkedDataRange(bytes, dataOffset, dataBytes,
                "UPDATE_TEXTURE data");
            const rgba = decodeTextureUpload(resource.format, source,
                width, height, rowPitch);
            const destination = {
                texture: resource.gpuTexture,
                mipLevel: level,
                origin: { x, y, z: 0 },
            };
            const extent = { width, height, depthOrArrayLayers: 1 };
            if (this.frame) {
                this.endPass();
                const packedPitch = width * 4;
                const uploadPitch = (packedPitch + 255) & ~255;
                const padded = new Uint8Array(uploadPitch * height);
                for (let row = 0; row < height; row++)
                    padded.set(rgba.subarray(row * packedPitch,
                        (row + 1) * packedPitch), row * uploadPitch);
                const staging = this.createTransientBuffer(padded,
                    BUFFER_USAGE_COPY_SRC, "D3D8 ordered texture upload");
                this.frame.encoder.copyBufferToTexture({
                    buffer: staging.buffer,
                    offset: staging.offset,
                    bytesPerRow: uploadPitch,
                    rowsPerImage: height,
                }, destination, extent);
            } else {
                this.device.queue.writeTexture(destination, rgba, {
                    bytesPerRow: width * 4,
                    rowsPerImage: height,
                }, extent);
            }
            this.stats.uploadBytes += dataBytes;
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
            if (!this.preparePass(state, pass)) return;
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.bindGroupFor(state, pipeline));
            pass.setVertexBuffer(0, resource.gpuBuffer);
            if (primitive.fan) {
                const fan = this.sequentialFanIndices(primitive.vertices);
                const indexBuffer = this.createTransientBuffer(fan.data,
                    BUFFER_USAGE_INDEX, "D3D8 triangle fan indices");
                pass.setIndexBuffer(indexBuffer.buffer, fan.format,
                    indexBuffer.offset, indexBuffer.size);
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
            if (!this.preparePass(state, pass)) return;
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
                pass.setIndexBuffer(indexBuffer.buffer, fan.format,
                    indexBuffer.offset, indexBuffer.size);
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
            if (!this.preparePass(state, pass)) return;
            const vertexBuffer = this.createTransientBuffer(data,
                BUFFER_USAGE_VERTEX, "D3D8 DrawPrimitiveUP vertices");
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.bindGroupFor(state, pipeline));
            pass.setVertexBuffer(0, vertexBuffer.buffer, vertexBuffer.offset,
                vertexBuffer.size);
            if (primitive.fan) {
                const fan = this.sequentialFanIndices(vertexCount);
                const indexBuffer = this.createTransientBuffer(fan.data,
                    BUFFER_USAGE_INDEX, "D3D8 UP triangle fan indices");
                pass.setIndexBuffer(indexBuffer.buffer, fan.format,
                    indexBuffer.offset, indexBuffer.size);
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
            if (!this.preparePass(state, pass)) return;
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
            pass.setVertexBuffer(0, vertexBuffer.buffer, vertexBuffer.offset,
                vertexBuffer.size);
            pass.setIndexBuffer(indexBuffer.buffer, webgpuFormat,
                indexBuffer.offset, indexBuffer.size);
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
                        "depth/stencil-only Clear is deferred to fixed-function stage 4",
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
                    deviceHandle: u32(bytes, payloadOffset),
                    kind,
                    byteCount,
                    usage: u32(bytes, payloadOffset + 16),
                    pool: u32(bytes, payloadOffset + 24),
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
                if (commandEnd - payloadOffset < 24) throw new Error("short UPDATE_BUFFER");
                const resource = this.resources.get(u32(bytes, payloadOffset));
                if (!resource) throw new Error("UPDATE_BUFFER references an unknown resource");
                const destination = u32(bytes, payloadOffset + 4);
                const byteCount = u32(bytes, payloadOffset + 8);
                const dataOffset = u32(bytes, payloadOffset + 12);
                const lockFlags = u32(bytes, payloadOffset + 16);
                if (dataOffset > bytes.length || byteCount > bytes.length - dataOffset ||
                    destination > resource.byteCount ||
                    byteCount > resource.byteCount - destination) {
                    throw new Error("UPDATE_BUFFER range is outside its batch/resource");
                }
                if (lockFlags & D3DLOCK_DISCARD) {
                    const previous = resource.gpuBuffer;
                    resource.shadow.fill(0);
                    resource.gpuBuffer = this.device.createBuffer({
                        label: "D3D8 orphaned " +
                            (resource.kind === RESOURCE_BUFFER_VERTEX ?
                                "vertex" : "index") + " buffer " +
                            resource.handle.toString(16),
                        size: Math.max(4, align4(resource.byteCount)),
                        usage: (resource.kind === RESOURCE_BUFFER_VERTEX ?
                            BUFFER_USAGE_VERTEX : BUFFER_USAGE_INDEX) |
                            BUFFER_USAGE_COPY_DST,
                    });
                    if (this.frame)
                        this.frame.transientBuffers.push(previous);
                    else
                        previous.destroy();
                    this.stats.bufferOrphans++;
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
                    this.frame.encoder.copyBufferToBuffer(staging.buffer,
                        staging.offset,
                        resource.gpuBuffer, alignedStart, source.byteLength);
                } else if (source.byteLength) {
                    this.device.queue.writeBuffer(resource.gpuBuffer,
                        alignedStart, source);
                }
                this.stats.uploadBytes += byteCount;
                break;
            }
            case OP_CREATE_TEXTURE:
                this.createTextureResource(bytes, payloadOffset, commandEnd);
                break;
            case OP_UPDATE_TEXTURE:
                this.updateTextureResource(bytes, payloadOffset, commandEnd);
                break;
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
            case OP_SET_TEXTURE: {
                if (commandEnd - payloadOffset < 16)
                    throw new Error("short SET_TEXTURE");
                const state = this.devices.get(u32(bytes, payloadOffset));
                const stage = u32(bytes, payloadOffset + 4);
                const handle = u32(bytes, payloadOffset + 8);
                const resource = handle ? this.resources.get(handle) : null;
                if (!state || stage >= state.textures.length ||
                        (handle && (!resource ||
                            resource.kind !== RESOURCE_TEXTURE_2D ||
                            resource.deviceHandle !== state.handle)))
                    throw new Error("invalid SET_TEXTURE");
                state.textures[stage] = handle;
                break;
            }
            case OP_SET_VIEWPORT: {
                if (commandEnd - payloadOffset < 32)
                    throw new Error("short SET_VIEWPORT");
                const state = this.devices.get(u32(bytes, payloadOffset));
                const width = u32(bytes, payloadOffset + 12);
                const height = u32(bytes, payloadOffset + 16);
                const minZ = f32(bytes, payloadOffset + 20);
                const maxZ = f32(bytes, payloadOffset + 24);
                if (!state || !width || !height || !Number.isFinite(minZ) ||
                        !Number.isFinite(maxZ) || minZ > maxZ)
                    throw new Error("invalid SET_VIEWPORT");
                state.viewport = {
                    x: u32(bytes, payloadOffset + 4),
                    y: u32(bytes, payloadOffset + 8),
                    width,
                    height,
                    minZ,
                    maxZ,
                };
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
            let uniformsCached = 0;
            let bindGroupsCached = 0;
            for (const state of this.devices.values()) {
                uniformsCached += state.uniformVariants.size;
                bindGroupsCached += state.bindGroups.size;
            }
            return {
                ...this.stats,
                devicesLive: this.devices.size,
                resourcesLive: this.resources.size,
                pipelinesCached: this.pipelineCache.size,
                samplersCached: this.samplerCache.size,
                uniformsCached,
                bindGroupsCached,
            };
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
