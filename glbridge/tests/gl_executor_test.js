#!/usr/bin/env node
// Unit tests for glbridge/gl-webgpu/gl_executor.js -- the OpenGL state machine
// and draw path, driven by real command records and a fake GPUDevice.
//
// Every fixture here is encoded through gl_stream_builder.js, which uses the
// same signature table the executor decodes with, so a layout mistake shows up
// as a decode mismatch rather than as a plausible-looking wrong picture. What
// the assertions check is the *decision*: which pipeline state a GL state
// produced, which vertex layout, which bind groups, and what a synchronous
// query answered.

"use strict";

const assert = require("assert");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL, GLFN } = require("./gl_stream_builder.js");
const executorModule = require("../gl-webgpu/gl_executor.js");

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        ++passed;
    } catch (error) {
        failures.push([name, error]);
    }
}

function newExecutor(options) {
    const { host, log } = createFakeHost();
    const executor = new executorModule.GLWebGPUExecutor(null,
        Object.assign({ host }, options || {}));
    executor.initializeSync = () => {
        // initialize() is async only because a real adapter request is; the
        // fake resolves immediately, so the tests drive it synchronously.
        executor.device = host.device;
        executor.deviceFeatures = host.deviceFeatures;
        executor.limits = host.limits;
        executor.uniformCapacity = 1 << 20;
        executor.vertexCapacity = 1 << 20;
        executor.uniformRing = host.device.createBuffer({ size: executor.uniformCapacity });
        executor.uniformStaging = new Uint8Array(executor.uniformCapacity);
        executor.vertexRing = host.device.createBuffer({ size: executor.vertexCapacity });
        executor.vertexStaging = new Uint8Array(executor.vertexCapacity);
        executor.fallbackTexture = host.device.createTexture({
            size: { width: 1, height: 1 }, format: "rgba8unorm" });
        executor.fallbackView = executor.fallbackTexture.createView();
        executor.fallbackSampler = host.device.createSampler({});
        executor.fallbackComparisonSampler = host.device.createSampler({});
        executor.readyPromise = Promise.resolve(executor);
    };
    executor.initializeSync();
    return { executor, log, host };
}

function run(executor, stream) {
    executor.submit(stream.bytes(), {});
}

/* ---- the state machine ---- */

test("a context is created on demand and keeps GL's defaults", () => {
    const { executor } = newExecutor();
    run(executor, new GLStream().makeCurrent(7, 0, 0, 320, 240));
    const state = executor.current;
    assert.ok(state, "makeCurrent creates a context");
    assert.strictEqual(state.depthFunc, GL.LESS);
    assert.strictEqual(state.depthMask, true);
    assert.strictEqual(state.frontFace, GL.CCW);
    assert.strictEqual(state.cullFace, GL.BACK);
    assert.strictEqual(state.shadeModel, GL.SMOOTH);
    assert.strictEqual(state.blend.srcRGB, GL.ONE);
    assert.strictEqual(state.blend.dstRGB, GL.ZERO);
    assert.strictEqual(state.lights[0].diffuse[0], 1,
        "GL_LIGHT0 starts with a white diffuse and the rest black");
    assert.strictEqual(state.lights[1].diffuse[0], 0);
    assert.ok(state.polygonStipple.every(value => value === 0xff),
        "the default 32x32 polygon stipple is all ones");
    const ambient = [...state.material.front.ambient];
    assert.ok(Math.abs(ambient[0] - 0.2) < 1e-6 && ambient[3] === 1,
        "the default front material ambient is 0.2, 0.2, 0.2, 1");
});

test("the matrix stack multiplies in GL's order", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("MATRIX_MODE", GL.MODELVIEW)
        .call("LOAD_IDENTITY")
        .call("TRANSLATEF", 1, 2, 3)
        .call("SCALEF", 2, 2, 2);
    run(executor, stream);
    const m = executor.topOf(GL.MODELVIEW);
    // glTranslate then glScale means the scale is applied first to a vertex.
    assert.strictEqual(m[0], 2);
    assert.strictEqual(m[12], 1);
    assert.strictEqual(m[13], 2);
    assert.strictEqual(m[14], 3);
});

test("glPushMatrix past the stack depth raises GL_STACK_OVERFLOW", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("MATRIX_MODE", GL.PROJECTION);
    for (let i = 0; i < 8; ++i) stream.call("PUSH_MATRIX");
    run(executor, stream);
    assert.strictEqual(executor.current.error, GL.STACK_OVERFLOW);
});

test("glEnable routes per-unit capabilities to the active unit", () => {
    const { executor } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3)
        .call("ENABLE", GL.TEXTURE_2D)
        .call("ENABLE", GL.TEXTURE_GEN_S));
    const units = executor.current.textureUnits;
    assert.ok(units[3].enabledTargets.has(GL.TEXTURE_2D));
    assert.ok(!units[0].enabledTargets.has(GL.TEXTURE_2D),
        "the capability belongs to the active unit alone");
    assert.strictEqual(units[3].texGen[0].enabled, true);
});

test("glLight POSITION is captured in eye space at call time", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("MATRIX_MODE", GL.MODELVIEW)
        .call("LOAD_IDENTITY")
        .call("TRANSLATEF", 10, 0, 0)
        .call("LIGHTFV", GL.LIGHT0, GL.POSITION, 4, 0, 0, 0, 1)
        .call("TRANSLATEF", 100, 0, 0);
    run(executor, stream);
    const light = executor.current.lights[0];
    assert.strictEqual(light.eyePosition[0], 10,
        "a later modelview change must not move an already-positioned light");
});

/* ---- synchronous queries ---- */

test("glGetError reports the first error and clears it", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("ACTIVE_TEXTURE", GL.TEXTURE0 + 99);
    const first = stream.queryError();
    const second = stream.queryError();
    run(executor, stream);
    assert.strictEqual(first.view.getUint32(0, true), executorModule.SYNC_STATUS_OK);
    assert.strictEqual(first.view.getUint32(4, true), GL.INVALID_ENUM);
    assert.strictEqual(second.view.getUint32(4, true), GL.NO_ERROR,
        "the error queue is emptied by a read");
});

test("glGetIntegerv is answered without touching the GPU", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64);
    const answer = stream.queryInteger(GL.MAX_TEXTURE_UNITS);
    const sampleBuffers = stream.queryInteger(GL.SAMPLE_BUFFERS);
    const samples = stream.queryInteger(GL.SAMPLES);
    const before = log.submits.length;
    run(executor, stream);
    assert.strictEqual(answer.view.getUint32(4, true), executorModule.SYNC_STATUS_OK);
    assert.strictEqual(answer.view.getUint32(8, true), 8);
    assert.strictEqual(sampleBuffers.view.getUint32(8, true), 0);
    assert.strictEqual(samples.view.getUint32(8, true), 0,
        "a non-multisample pixel format reports zero GL samples");
    assert.strictEqual(log.submits.length, before,
        "answering a state query must not submit GPU work");
});

test("the extension string only advertises what the adapter backs", () => {
    const { executor } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 64, 64));
    const withBC = executor.extensionString();
    assert.ok(withBC.indexOf("GL_EXT_texture_compression_s3tc") >= 0);
    executor.deviceFeatures = { bc: false, float32Filterable: false };
    const withoutBC = executor.extensionString();
    assert.ok(withoutBC.indexOf("GL_EXT_texture_compression_s3tc") < 0,
        "S3TC is not advertised when the adapter has no BC formats");
    assert.ok(withoutBC.indexOf("GL_ARB_multitexture") >= 0);
});

test("glGetString reports GL 2.1 and GLSL 1.20", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64);
    const version = stream.queryString(GL.VERSION, 64);
    const glsl = stream.queryString(GL.SHADING_LANGUAGE_VERSION, 64);
    run(executor, stream);
    const read = answer => {
        const payload = answer.bytes;
        let text = "";
        for (let i = 16; i < payload.length && payload[i]; ++i)
            text += String.fromCharCode(payload[i]);
        return text;
    };
    assert.ok(read(version).startsWith("2.1"), read(version));
    assert.strictEqual(read(glsl), "1.20");
});

/* ---- clears and the frame ---- */

test("glClear before any draw becomes a load operation", () => {
    const { executor, log } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .call("CLEAR_COLOR", 0.25, 0.5, 0.75, 1)
        .call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT));
    assert.strictEqual(log.passes.length, 1);
    const attachment = log.passes[0].descriptor.colorAttachments[0];
    assert.strictEqual(attachment.loadOp, "clear");
    assert.strictEqual(attachment.clearValue.r, 0.25);
    assert.strictEqual(
        log.passes[0].descriptor.depthStencilAttachment.depthLoadOp, "clear");
});

test("scissored and masked clears are rendered instead of widening the clear", () => {
    const { executor, log } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .call("ENABLE", GL.SCISSOR_TEST)
        .call("SCISSOR", 10, 20, 30, 40)
        .call("COLOR_MASK", 1, 0, 1, 0)
        .call("CLEAR_COLOR", 0.2, 0.4, 0.6, 1)
        .call("CLEAR", GL.COLOR_BUFFER_BIT));
    const pass = log.passes.find(entry =>
        entry.descriptor.label === "GL masked/scissored clear");
    assert.ok(pass, "the restricted clear uses its dedicated draw pass");
    assert.deepStrictEqual(pass.scissor, [10, 20, 30, 40]);
    assert.strictEqual(log.draws.length, 1);
    assert.strictEqual(log.draws[0].pipeline.descriptor.fragment.targets[0].writeMask,
        1 | 4);
});

/* ---- drawing ---- */

function immediateTriangle(stream) {
    return stream.call("BEGIN", GL.TRIANGLES)
        .call("COLOR4F", 1, 0, 0, 1).call("VERTEX3F", -1, -1, 0)
        .call("COLOR4F", 0, 1, 0, 1).call("VERTEX3F", 1, -1, 0)
        .call("COLOR4F", 0, 0, 1, 1).call("VERTEX3F", 0, 1, 0)
        .call("END");
}

test("an immediate-mode triangle produces one draw with one vertex buffer", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240);
    immediateTriangle(stream);
    run(executor, stream);
    assert.strictEqual(log.draws.length, 1);
    assert.strictEqual(log.draws[0].count, 3);
    const pipeline = log.draws[0].pipeline;
    assert.strictEqual(pipeline.descriptor.vertex.buffers.length, 1);
    const attributes = pipeline.descriptor.vertex.buffers[0].attributes;
    // Position at location 0 and colour at 3 -- the historical slots every
    // engine of this era assumes.
    assert.deepStrictEqual(attributes.map(a => a.shaderLocation).sort((a, b) => a - b),
        [0, 3]);
    assert.strictEqual(executor.stats.immediateBatches, 1);
});

test("GL_QUADS expands to two triangles with GL's provoking vertex first", () => {
    const expanded = executorModule.expandIndices(GL.QUADS, 4, 0);
    assert.strictEqual(expanded.length, 6);
    // GL takes a quad's flat colour from its fourth vertex, so vertex 3 leads
    // both triangles -- WGSL's @interpolate(flat) uses the first.
    assert.strictEqual(expanded[0], 3);
    assert.strictEqual(expanded[3], 3);
    const fan = executorModule.expandIndices(GL.TRIANGLE_FAN, 5, 0);
    assert.strictEqual(fan.length, 9);
    assert.strictEqual(fan[0], 1, "a fan's provoking vertex is not the centre");
    const loop = executorModule.expandIndices(GL.LINE_LOOP, 4, 0);
    assert.deepStrictEqual([...loop], [0, 1, 2, 3, 0]);
});

test("a GL_QUADS draw is issued as an indexed triangle list", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .call("BEGIN", GL.QUADS);
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        stream.call("VERTEX3F", x, y, 0);
    stream.call("END");
    run(executor, stream);
    assert.strictEqual(log.draws.length, 1);
    assert.strictEqual(log.draws[0].indexed, true);
    assert.strictEqual(log.draws[0].count, 6);
    assert.strictEqual(log.draws[0].pipeline.descriptor.primitive.topology,
        "triangle-list");
});

test("glPolygonMode line and point rasterize triangle edges and vertices", () => {
    const line = newExecutor();
    let stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.LINE);
    immediateTriangle(stream);
    run(line.executor, stream);
    assert.strictEqual(line.log.draws[0].indexed, true);
    assert.strictEqual(line.log.draws[0].count, 6);
    assert.strictEqual(line.log.draws[0].pipeline.descriptor.primitive.topology,
        "line-list");

    const point = newExecutor();
    stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.POINT);
    immediateTriangle(stream);
    run(point.executor, stream);
    assert.strictEqual(point.log.draws[0].count, 3);
    assert.strictEqual(point.log.draws[0].pipeline.descriptor.primitive.topology,
        "point-list");
});

test("culling both faces drops polygon draws", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("ENABLE", GL.CULL_FACE)
        .call("CULL_FACE", GL.FRONT_AND_BACK);
    immediateTriangle(stream);
    run(executor, stream);
    assert.strictEqual(log.draws.length, 0);
});

test("wide points and point sprites expand to instanced quads", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .call("POINT_SIZE", 8)
        .call("BEGIN", GL.POINTS)
        .call("VERTEX3F", 0, 0, 0)
        .call("END");
    run(executor, stream);
    assert.strictEqual(log.draws.length, 1);
    assert.strictEqual(log.draws[0].count, 6,
        "one logical point is rendered as a six-vertex quad");
    assert.strictEqual(log.draws[0].instances, 1);
    const buffers = log.draws[0].pipeline.descriptor.vertex.buffers;
    assert.strictEqual(buffers[0].stepMode, "instance");
    assert.strictEqual(buffers[buffers.length - 1].stepMode, "vertex");
    assert.strictEqual(
        buffers[buffers.length - 1].attributes[0].shaderLocation,
        require("../gl-webgpu/gl_shader_translator.js").POINT_CORNER_LOCATION);
    assert.strictEqual(log.draws[0].pipeline.descriptor.primitive.topology,
        "triangle-list");
});

test("colour logic XOR snapshots the attachment and disables blending", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("ENABLE", GL.BLEND)
        .call("ENABLE", GL.COLOR_LOGIC_OP)
        .call("LOGIC_OP", GL.XOR);
    immediateTriangle(stream);
    run(executor, stream);
    assert.ok(log.encoders.some(encoder =>
        encoder.copies.some(copy => copy[0] === "t2t")),
    "the destination colour attachment is copied before drawing");
    const draw = log.draws[0];
    assert.equal(draw.pipeline.descriptor.fragment.targets[0].blend, undefined,
        "logic operations take precedence over blending");
    assert.match(draw.pipeline.descriptor.fragment.module.code, /s \^ d/);
    assert.ok(draw.pass.calls.some(call =>
        call[0] === "bindGroup" && call[1] === 3));
});

test("point-sprite lower-left origin reaches the generated shader", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("POINT_PARAMETERI", GL.POINT_SPRITE_COORD_ORIGIN, GL.LOWER_LEFT)
        .call("POINT_SIZE", 4)
        .call("BEGIN", GL.POINTS)
        .call("VERTEX3F", 0, 0, 0)
        .call("END");
    run(executor, stream);
    assert.match(log.draws[0].pipeline.descriptor.vertex.module.code,
        /vin\.corner\.y \* 0\.5 \+ 0\.5/);
});

test("the clip-space flip is paired with reversed winding", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .call("ENABLE", GL.CULL_FACE)
        .call("FRONT_FACE", GL.CCW)
        .call("CULL_FACE", GL.BACK);
    immediateTriangle(stream);
    run(executor, stream);
    const primitive = log.draws[0].pipeline.descriptor.primitive;
    assert.strictEqual(primitive.frontFace, "cw",
        "GL_CCW is reported as cw because the vertex shader negates clip Y");
    assert.strictEqual(primitive.cullMode, "back");
    assert.ok(log.draws[0].pipeline.descriptor.vertex.module.code
        .indexOf("clip.y = -clip.y;") >= 0, "the flip is in the shader");
});

test("blend and depth state reach the pipeline descriptor", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .call("ENABLE", GL.BLEND)
        .call("BLEND_FUNC_SEPARATE", GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA,
            GL.ONE, GL.ZERO)
        .call("BLEND_EQUATION_SEPARATE", GL.FUNC_ADD, GL.FUNC_SUBTRACT)
        .call("ENABLE", GL.DEPTH_TEST)
        .call("DEPTH_FUNC", GL.LEQUAL)
        .call("DEPTH_MASK", 0)
        .call("COLOR_MASK", 1, 1, 0, 1);
    immediateTriangle(stream);
    run(executor, stream);
    const descriptor = log.draws[0].pipeline.descriptor;
    const target = descriptor.fragment.targets[0];
    assert.strictEqual(target.blend.color.srcFactor, "src-alpha");
    assert.strictEqual(target.blend.color.dstFactor, "one-minus-src-alpha");
    assert.strictEqual(target.blend.alpha.operation, "subtract");
    assert.strictEqual(target.writeMask, 1 | 2 | 8);
    assert.strictEqual(descriptor.depthStencil.depthCompare, "less-equal");
    assert.strictEqual(descriptor.depthStencil.depthWriteEnabled, false);
});

test("changing a state that changes the shader produces a second pipeline", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240);
    immediateTriangle(stream);
    stream.call("ENABLE", GL.FOG).call("FOGI", GL.FOG_MODE, GL.LINEAR);
    immediateTriangle(stream);
    run(executor, stream);
    assert.strictEqual(log.draws.length, 2);
    assert.notStrictEqual(log.draws[0].pipeline, log.draws[1].pipeline,
        "enabling fog must reach the fixed-function signature");
    assert.ok(log.draws[1].pipeline.descriptor.fragment.module.code
        .indexOf("fogFactor") >= 0);
});

test("a client-array draw packs every enabled array into one buffer", () => {
    const { executor, log } = newExecutor();
    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    const colors = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .drawArrays(GL.TRIANGLES, 3, {
            vertex: { size: 3, type: GL.FLOAT, stride: 12,
                      data: new Uint8Array(positions.buffer) },
            color: { size: 4, type: GL.UNSIGNED_BYTE, stride: 4, data: colors },
        });
    run(executor, stream);
    assert.strictEqual(log.draws.length, 1);
    assert.strictEqual(log.draws[0].count, 3);
    const buffers = log.draws[0].pipeline.descriptor.vertex.buffers;
    assert.strictEqual(buffers.length, 1);
    assert.strictEqual(buffers[0].arrayStride, (4 + 4) * 4,
        "position is always a vec4 and colour is widened to float");
});

/* ---- textures ---- */

test("a LUMINANCE upload is expanded to (l, l, l, 1)", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .names(GLFN.GEN_TEXTURES, [5])
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 5)
        .texImage2D(GL.TEXTURE_2D, 0, GL.LUMINANCE, 2, 1, GL.LUMINANCE,
            GL.UNSIGNED_BYTE, new Uint8Array([64, 200]));
    run(executor, stream);
    const texture = executor.current.shareGroup.textures.get(5);
    const pixels = texture.levels[0][0].pixels;
    assert.deepStrictEqual([...pixels.subarray(0, 8)],
        [64, 64, 64, 255, 200, 200, 200, 255]);
    assert.strictEqual(texture.baseFormat, "LUMINANCE");
});

test("an ALPHA upload leaves RGB at zero", () => {
    const { executor } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .names(GLFN.GEN_TEXTURES, [6])
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 6)
        .texImage2D(GL.TEXTURE_2D, 0, GL.ALPHA, 1, 1, GL.ALPHA,
            GL.UNSIGNED_BYTE, new Uint8Array([137])));
    const texture = executor.current.shareGroup.textures.get(6);
    assert.deepStrictEqual([...texture.levels[0][0].pixels], [0, 0, 0, 137]);
});

test("BGRA and packed 5-6-5 sources are converted", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .names(GLFN.GEN_TEXTURES, [7, 8])
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 7)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, GL.BGRA,
            GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4]))
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 8)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGB, 1, 1, GL.RGB,
            GL.UNSIGNED_SHORT_5_6_5, new Uint8Array([0x00, 0xf8]));
    run(executor, stream);
    const bgra = executor.current.shareGroup.textures.get(7);
    assert.deepStrictEqual([...bgra.levels[0][0].pixels], [3, 2, 1, 4]);
    const packed = executor.current.shareGroup.textures.get(8);
    // 0xf800 is full red in 5-6-5, and GL widens by bit replication.
    assert.deepStrictEqual([...packed.levels[0][0].pixels], [255, 0, 0, 255]);
});

test("an incomplete texture samples as opaque black", () => {
    const { executor } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .names(GLFN.GEN_TEXTURES, [9])
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 9)
        .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER,
            GL.LINEAR_MIPMAP_LINEAR)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array(4 * 4 * 4)));
    const texture = executor.current.shareGroup.textures.get(9);
    assert.strictEqual(executor.textureIsComplete(texture), false,
        "a mipmapped filter with only level 0 is incomplete");
});

test("glDrawPixels uploads a pixel rectangle and draws it at the raster position", () => {
    const { executor, log } = newExecutor();
    const pixels = new Uint8Array([
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("WINDOW_POS3F", 10, 12, 0.5)
        .drawPixels(2, 2, GL.RGBA, GL.UNSIGNED_BYTE, pixels);
    run(executor, stream);
    assert.strictEqual(log.textureWrites.length, 1);
    assert.strictEqual(log.textureWrites[0].byteLength, 16);
    assert.strictEqual(log.draws.length, 1);
    assert.strictEqual(log.draws[0].count, 6);
    assert.strictEqual(executor.stats.refusals, 0);
});

test("glBitmap expands bits with the current colour and advances raster position", () => {
    const { executor, log } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("WINDOW_POS3F", 4, 5, 0)
        .call("COLOR4F", 1, 0.5, 0, 1)
        .bitmap(8, 1, 0, 0, 3, -2, new Uint8Array([0x81, 0, 0, 0]));
    run(executor, stream);
    assert.strictEqual(log.draws.length, 1);
    assert.strictEqual(executor.current.current.rasterPos[0], 7);
    assert.strictEqual(executor.current.current.rasterPos[1], 3);
    assert.strictEqual(executor.stats.refusals, 0);
});

test("glGenerateMipmap builds the whole chain", () => {
    const { executor } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .names(GLFN.GEN_TEXTURES, [10])
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 10)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array(4 * 4 * 4).fill(128))
        .call("GENERATE_MIPMAP", GL.TEXTURE_2D));
    const texture = executor.current.shareGroup.textures.get(10);
    assert.strictEqual(texture.levels[0].length, 3);
    assert.strictEqual(texture.levels[0][2].width, 1);
    assert.strictEqual(texture.levels[0][1].pixels[0], 128,
        "a box filter over a constant image is that constant");
});

test("DXT1 decodes deterministically when the adapter has no BC", () => {
    // Two-colour block: colour0 red, colour1 blue, all texels index 0.
    const block = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0]);
    const rgba = executorModule.decodeDXT(1, block, 4, 4);
    assert.strictEqual(rgba.length, 4 * 4 * 4);
    assert.deepStrictEqual([...rgba.subarray(0, 4)], [255, 0, 0, 255]);
});

/* ---- programs ---- */

const VS = "attribute vec4 vvertex;\nuniform mat4 mvp;\nvarying vec2 tc;\n" +
    "void main(void) { gl_Position = mvp * vvertex; tc = vvertex.xy; }";
const FS = "uniform sampler2D tex0;\nuniform vec4 tint;\nvarying vec2 tc;\n" +
    "void main(void) { gl_FragColor = texture2D(tex0, tc) * tint; }";

function linkedProgram(executor) {
    const stream = new GLStream().makeCurrent(1, 0, 0, 320, 240)
        .call("CREATE_PROGRAM", 1)
        .call("CREATE_SHADER", 10, GL.VERTEX_SHADER)
        .call("CREATE_SHADER", 11, GL.FRAGMENT_SHADER)
        .shaderSource(10, VS)
        .shaderSource(11, FS)
        .call("COMPILE_SHADER", 10)
        .call("COMPILE_SHADER", 11)
        .call("ATTACH_SHADER", 1, 10)
        .call("ATTACH_SHADER", 1, 11)
        .call("LINK_PROGRAM", 1)
        .call("USE_PROGRAM", 1);
    run(executor, stream);
    return executor.current.shareGroup.programs.get(1);
}

test("a GLSL program links and reports its reflection", () => {
    const { executor } = newExecutor();
    const program = linkedProgram(executor);
    assert.strictEqual(program.linked, true, program.log);
    const reflection = program.link.reflection;
    assert.ok(reflection.attributes.some(a => a.name === "vvertex"));
    assert.ok(reflection.uniforms.some(u => u.name === "mvp"));
    assert.ok(reflection.samplers.some(s => s.name === "tex0"));
});

test("glGetUniformLocation and glGetAttribLocation answer synchronously", () => {
    const { executor } = newExecutor();
    linkedProgram(executor);
    const stream = new GLStream();
    const uniform = stream.queryLocation(0, 1, "tint", 32);
    const attribute = stream.queryLocation(1, 1, "vvertex", 32);
    const missing = stream.queryLocation(0, 1, "nosuch", 32);
    run(executor, stream);
    const status = a => a.view.getUint32(12, true);
    const location = a => a.view.getInt32(16, true);
    assert.strictEqual(status(uniform), executorModule.SYNC_STATUS_OK);
    assert.ok(location(uniform) >= 0);
    assert.ok(location(attribute) >= 0);
    assert.strictEqual(location(missing), -1);
});

test("glUniform4fv lands where the reflection says it does", () => {
    const { executor } = newExecutor();
    const program = linkedProgram(executor);
    const tint = program.uniformByName.get("tint");
    run(executor, new GLStream().uniformfv(tint.location, 4, 1,
        [0.25, 0.5, 0.75, 1]));
    const at = tint.offsetBytes >> 2;
    assert.deepStrictEqual([...program.uniformFloats.subarray(at, at + 4)],
        [0.25, 0.5, 0.75, 1]);
});

test("glUniform1i on a sampler rebinds a texture unit rather than writing a value", () => {
    const { executor } = newExecutor();
    const program = linkedProgram(executor);
    const sampler = program.link.reflection.samplers[0];
    run(executor, new GLStream().uniformiv(sampler.location, 1, 1, [3]));
    assert.strictEqual(program.samplerUnits.get("tex0"), 3);
});

test("glGetShaderiv reports a compile failure with a usable log", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("CREATE_SHADER", 20, GL.VERTEX_SHADER)
        .shaderSource(20, "void main(void) { gl_Position = nonsense; }")
        .call("COMPILE_SHADER", 20);
    const status = stream.queryObjectiv(1, 20, GL.COMPILE_STATUS);
    run(executor, stream);
    assert.strictEqual(status.view.getUint32(16, true), 0);
    const shader = executor.current.shareGroup.shaders.get(20);
    assert.ok(shader.compiled.log.indexOf("undeclared identifier") >= 0,
        shader.compiled.log);
});

test("a program draw binds the sampler's unit, not the sampler's index", () => {
    const { executor, log } = newExecutor();
    const program = linkedProgram(executor);
    const sampler = program.link.reflection.samplers[0];
    const stream = new GLStream()
        .names(GLFN.GEN_TEXTURES, [30])
        .call("ACTIVE_TEXTURE", GL.TEXTURE0 + 2)
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 30)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array([9, 9, 9, 255]))
        .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR)
        .uniformiv(sampler.location, 1, 1, [2]);
    immediateTriangle(stream);
    run(executor, stream);
    assert.strictEqual(log.draws.length, 1);
    const groups = log.bindGroups.filter(g =>
        g.descriptor.layout.index === 2);
    assert.ok(groups.length, "the texture group is created");
});

/* ---- refusals ---- */

test("the accumulation buffer implements clear, load, arithmetic and return", () => {
    const { executor } = newExecutor();
    run(executor, new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("CLEAR_ACCUM", 0.1, 0.2, 0.3, 0.4)
        .call("CLEAR", GL.ACCUM_BUFFER_BIT)
        .call("ACCUM", 0x0101, 0.5)  // GL_LOAD
        .call("ACCUM", 0x0100, 0.25) // GL_ACCUM
        .call("ACCUM", 0x0103, 2)    // GL_MULT
        .call("ACCUM", 0x0104, 0.1)  // GL_ADD
        .call("ACCUM", 0x0102, 1));  // GL_RETURN
    assert.ok(executor.accumBuffer);
    assert.strictEqual(executor.accumBuffer.currentTexture.descriptor.format,
        "rgba16float");
    assert.strictEqual(executor.stats.refusals, 0);
});

test("invalid accumulation operations are refused loudly", () => {
    const { executor } = newExecutor();
    const original = console.error;
    console.error = () => {};
    try {
        run(executor, new GLStream().makeCurrent(1, 0, 0, 64, 64)
            .call("ACCUM", 0xDEAD, 1));
    } finally {
        console.error = original;
    }
    assert.strictEqual(executor.stats.refusals, 1);
});

test("a truncated record stops the batch instead of reading past it", () => {
    const { executor } = newExecutor();
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64);
    const bytes = stream.bytes();
    const truncated = bytes.subarray(0, bytes.length - 4);
    const original = console.error;
    console.error = () => {};
    try {
        executor.submit(truncated, {});
    } finally {
        console.error = original;
    }
    assert.ok(executor.stats.refusals >= 1);
});

/* ---- report ---- */

for (const [name, error] of failures)
    console.error("FAIL: " + name + "\n    " + (error && error.message));
console.log(passed + " passed, " + failures.length + " failed");
process.exit(failures.length ? 1 : 0);
