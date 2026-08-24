// Wire-format decoding for the OpenGL command stream.
//
// Generated from the payload layouts in openglproxy/opengl32_proxy.c by way of
// the decoder v86_network_bridge.js has used since the gl4es path shipped.
// 140 of the 217 opcodes are a flat argument list, so they are described
// declaratively here rather than hand-decoded 140 times; the rest carry
// variable-length data and get explicit decoders in gl_executor.js.
//
// A one-field mistake in this table decodes every later argument at the wrong
// offset, and the symptom is arbitrary, so gl_protocol_consistency_test.js
// checks the table against the guest header rather than trusting it.

(function(global) {
    "use strict";

    // Each entry: [glName, argument types in order].
    //   i = signed 32-bit, u = unsigned 32-bit, f = 32-bit float,
    //   d = 64-bit float (GL's double-precision entry points)
    const SIGNATURES = {
        ACCUM: ["Accum", "uf"],
        ACTIVE_TEXTURE: ["ActiveTexture", "u"],
        ALPHA_FUNC: ["AlphaFunc", "uf"],
        ATTACH_SHADER: ["AttachShaderMapped", "uu"],
        BEGIN: ["Begin", "u"],
        BEGIN_QUERY: ["BeginQueryMapped", "uu"],
        BIND_BUFFER: ["BindBufferMapped", "uu"],
        BIND_FRAMEBUFFER: ["BindFramebufferMapped", "uu"],
        BIND_PROGRAM_ARB: ["BindProgramARBMapped", "uu"],
        BIND_RENDERBUFFER: ["BindRenderbufferMapped", "uu"],
        BIND_TEXTURE: ["BindTexture", "uu"],
        BLEND_COLOR: ["BlendColor", "ffff"],
        BLEND_EQUATION: ["BlendEquation", "u"],
        BLEND_EQUATION_SEPARATE: ["BlendEquationSeparate", "uu"],
        BLEND_FUNC: ["BlendFunc", "uu"],
        BLEND_FUNC_SEPARATE: ["BlendFuncSeparate", "uuuu"],
        BLIT_FRAMEBUFFER: ["BlitFramebuffer", "iiiiiiiiuu"],
        CLEAR: ["Clear", "u"],
        CLEAR_ACCUM: ["ClearAccum", "ffff"],
        CLEAR_COLOR: ["ClearColor", "ffff"],
        CLEAR_DEPTH: ["ClearDepth", "d"],
        CLEAR_STENCIL: ["ClearStencil", "i"],
        CLIENT_ACTIVE_TEXTURE: ["ClientActiveTexture", "u"],
        CLIP_PLANE: ["ClipPlane4d", "udddd"],
        COLOR4F: ["Color4f", "ffff"],
        COLOR_MASK: ["ColorMask", "uuuu"],
        COLOR_MATERIAL: ["ColorMaterial", "uu"],
        COMPILE_SHADER: ["CompileShaderMapped", "u"],
        COPY_PIXELS: ["CopyPixels", "iiiiu"],
        COPY_TEX_IMAGE_1D: ["CopyTexImage1D", "uiuiiii"],
        COPY_TEX_IMAGE_2D: ["CopyTexImage2D", "uiuiiiii"],
        COPY_TEX_SUB_IMAGE_1D: ["CopyTexSubImage1D", "uiiiii"],
        COPY_TEX_SUB_IMAGE_2D: ["CopyTexSubImage2D", "uiiiiiii"],
        COPY_TEX_SUB_IMAGE_3D: ["CopyTexSubImage3D", "uiiiiiiii"],
        CREATE_PROGRAM: ["CreateProgramMapped", "u"],
        CREATE_SHADER: ["CreateShaderMapped", "uu"],
        CULL_FACE: ["CullFace", "u"],
        DELETE_PROGRAM: ["DeleteProgramMapped", "u"],
        DELETE_SHADER: ["DeleteShaderMapped", "u"],
        DEPTH_FUNC: ["DepthFunc", "u"],
        DEPTH_MASK: ["DepthMask", "u"],
        DEPTH_RANGE: ["DepthRange", "dd"],
        DETACH_SHADER: ["DetachShaderMapped", "uu"],
        DISABLE: ["Disable", "u"],
        DISABLE_CLIENT_STATE: ["DisableClientState", "u"],
        DISABLE_VERTEX_ATTRIB_ARRAY: ["DisableVertexAttribArrayMapped", "u"],
        DRAW_ARRAYS_DIRECT: ["DrawArraysDirect", "uii"],
        DRAW_BUFFER: ["DrawBuffer", "u"],
        ENABLE: ["Enable", "u"],
        ENABLE_CLIENT_STATE: ["EnableClientState", "u"],
        ENABLE_VERTEX_ATTRIB_ARRAY: ["EnableVertexAttribArrayMapped", "u"],
        END: ["End", ""],
        END_QUERY: ["EndQueryMapped", "u"],
        FINISH: ["Finish", ""],
        FLUSH: ["Flush", ""],
        FOGF: ["Fogf", "uf"],
        FOGFV: ["Fogfv4", "uuffff"],
        FOGI: ["Fogi", "ui"],
        FOG_COORDF: ["FogCoordf", "f"],
        FRAMEBUFFER_RENDERBUFFER: ["FramebufferRenderbufferMapped", "uuuu"],
        FRAMEBUFFER_TEXTURE: ["FramebufferTextureMapped", "uuuuii"],
        FRONT_FACE: ["FrontFace", "u"],
        FRUSTUM: ["Frustum", "dddddd"],
        GENERATE_MIPMAP: ["GenerateMipmap", "u"],
        HINT: ["Hint", "uu"],
        INVALIDATE_PROGRAM_LOCATIONS: ["InvalidateProgramLocations", "u"],
        LIGHTF: ["Lightf", "uuf"],
        LIGHTFV: ["Lightfv4", "uuuffff"],
        LIGHTI: ["Lighti", "uui"],
        LIGHTIV: ["Lightiv4", "uuuiiii"],
        LIGHT_MODELF: ["LightModelf", "uf"],
        LIGHT_MODELFV: ["LightModelfv4", "uuffff"],
        LIGHT_MODELI: ["LightModeli", "ui"],
        LIGHT_MODELIV: ["LightModeliv4", "uuiiii"],
        LINE_STIPPLE: ["LineStipple", "iu"],
        LINE_WIDTH: ["LineWidth", "f"],
        LINK_PROGRAM: ["LinkProgramMapped", "u"],
        LOAD_IDENTITY: ["LoadIdentity", ""],
        LOGIC_OP: ["LogicOp", "u"],
        MATERIALF: ["Materialf", "uuf"],
        MATERIALFV: ["Materialfv4", "uuuffff"],
        MATERIALI: ["Materiali", "uui"],
        MATERIALIV: ["Materialiv4", "uuuiiii"],
        MATRIX_MODE: ["MatrixMode", "u"],
        MULTI_TEX_COORD4F: ["MultiTexCoord4f", "uffff"],
        NORMAL3F: ["Normal3f", "fff"],
        ORTHO: ["Ortho", "dddddd"],
        PIXEL_STOREI: ["PixelStorei", "ui"],
        PIXEL_TRANSFERF: ["PixelTransferf", "uf"],
        PIXEL_TRANSFERI: ["PixelTransferi", "ui"],
        PIXEL_ZOOM: ["PixelZoom", "ff"],
        POINT_PARAMETERF: ["PointParameterf", "uf"],
        POINT_PARAMETERFV: ["PointParameterfv3", "ufff"],
        POINT_PARAMETERI: ["PointParameteri", "ui"],
        POINT_SIZE: ["PointSize", "f"],
        POLYGON_MODE: ["PolygonMode", "uu"],
        POLYGON_OFFSET: ["PolygonOffset", "ff"],
        POP_ATTRIB: ["PopAttrib", ""],
        POP_CLIENT_ATTRIB: ["PopClientAttrib", ""],
        POP_MATRIX: ["PopMatrix", ""],
        PUSH_ATTRIB: ["PushAttrib", "u"],
        PUSH_CLIENT_ATTRIB: ["PushClientAttrib", "u"],
        PUSH_MATRIX: ["PushMatrix", ""],
        RASTER_POS4F: ["RasterPos4f", "ffff"],
        READ_BUFFER: ["ReadBuffer", "u"],
        RENDERBUFFER_STORAGE: ["RenderbufferStorageMapped", "uuii"],
        ROTATEF: ["Rotatef", "ffff"],
        SAMPLE_COVERAGE: ["SampleCoverage", "fu"],
        SCALEF: ["Scalef", "fff"],
        SCISSOR: ["Scissor", "iiii"],
        SECONDARY_COLOR3F: ["SecondaryColor3f", "fff"],
        SHADE_MODEL: ["ShadeModel", "u"],
        STENCIL_FUNC: ["StencilFunc", "uiu"],
        STENCIL_FUNC_SEPARATE: ["StencilFuncSeparate", "uuiu"],
        STENCIL_MASK: ["StencilMask", "u"],
        STENCIL_MASK_SEPARATE: ["StencilMaskSeparate", "uu"],
        STENCIL_OP: ["StencilOp", "uuu"],
        STENCIL_OP_SEPARATE: ["StencilOpSeparate", "uuuu"],
        TEX_COORD2F: ["TexCoord2f", "ff"],
        TEX_COORD4F: ["TexCoord4f", "ffff"],
        TEX_ENVF: ["TexEnvf", "uuf"],
        TEX_ENVFV: ["TexEnvfv4", "uuuffff"],
        TEX_ENVI: ["TexEnvi", "uui"],
        TEX_ENVIV: ["TexEnviv4", "uuuiiii"],
        TEX_GENF: ["TexGenf", "uuf"],
        TEX_GENFV: ["TexGenfv4", "uuuffff"],
        TEX_GENI: ["TexGeni", "uui"],
        TEX_GENIV: ["TexGeniv4", "uuuiiii"],
        TEX_PARAMETERF: ["TexParameterf", "uuf"],
        TEX_PARAMETERFV: ["TexParameterfv4", "uuuffff"],
        TEX_PARAMETERI: ["TexParameteri", "uui"],
        TEX_PARAMETERIV: ["TexParameteriv4", "uuuiiii"],
        TRANSLATEF: ["Translatef", "fff"],
        USE_PROGRAM: ["UseProgramMapped", "u"],
        VALIDATE_PROGRAM: ["ValidateProgramMapped", "u"],
        VERTEX3F: ["Vertex3f", "fff"],
        VERTEX4F: ["Vertex4f", "ffff"],
        VERTEX_ATTRIB4F: ["VertexAttrib4fMapped", "uffff"],
        VIEWPORT: ["Viewport", "iiii"],
        WINDOW_POS3F: ["WindowPos3f", "fff"],
    };

    const BYTES = { i: 4, u: 4, f: 4, d: 8 };

    function payloadBytes(types) {
        let n = 0;
        for (const t of types) n += BYTES[t];
        return n;
    }

    /* Decodes one flat argument list into `out`, returning the count. The
     * caller supplies the array so a hot draw path does not allocate. */
    function decodeArgs(types, view, offset, length, out) {
        let cursor = offset;
        const end = offset + length;
        for (let i = 0; i < types.length; ++i) {
            const t = types[i];
            const size = BYTES[t];
            if (cursor + size > end) return -1;
            switch (t) {
            case "i": out[i] = view.getInt32(cursor, true); break;
            case "u": out[i] = view.getUint32(cursor, true); break;
            case "f": out[i] = view.getFloat32(cursor, true); break;
            default: out[i] = view.getFloat64(cursor, true); break;
            }
            cursor += size;
        }
        return types.length;
    }

    const api = { SIGNATURES, BYTES, payloadBytes, decodeArgs };
    global.GLWireFormat = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
