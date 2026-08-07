#!/usr/bin/env node
// Executor-level tests for glbridge/d3d9-webgpu/d3d9_executor.js against a
// fake WebGPU device.
//
// These drive real D9WG batches (built byte-for-byte the way d3d9_proxy.c
// emits them) through the executor and assert on the WebGPU calls that come
// out: which shader modules, which pipeline topology, which bind group
// entries, and what actually lands in the shader constant buffer. The fake
// device reproduces the two validation rules that bite hardest in practice --
// a bind group must supply exactly the bindings its layout declares, and
// writeBuffer offsets/sizes must be multiples of 4 -- so a wiring mistake
// fails here rather than as a silent black screen inside v86.

"use strict";

const assert = require("node:assert/strict");
const { D3D9WebGPUExecutor } = require("../d3d9-webgpu/d3d9_executor.js");
const shaderPipeline = require("../d3d9-webgpu/d3d9_shader_pipeline.js");

const OP = {
    HELLO: 1, CREATE_DEVICE: 2, RESET: 3, PRESENT: 4, CLEAR: 5,
    BEGIN_SCENE: 6, END_SCENE: 7,
    CREATE_BUFFER: 0x100, UPDATE_BUFFER: 0x101, DESTROY_RESOURCE: 0x103,
    CREATE_TEXTURE_2D: 0x110, UPDATE_TEXTURE: 0x113,
    CREATE_VERTEX_DECLARATION: 0x120,
    CREATE_VERTEX_SHADER: 0x121, CREATE_PIXEL_SHADER: 0x122,
    SET_RENDER_STATE: 0x200, SET_SAMPLER_STATE: 0x201,
    SET_TEXTURE: 0x203, SET_VIEWPORT: 0x204, SET_TRANSFORM: 0x206,
    SET_STREAM_SOURCE: 0x20A, SET_INDICES: 0x20C,
    SET_VERTEX_DECLARATION: 0x20D, SET_FVF: 0x20E,
    SET_VERTEX_SHADER: 0x211, SET_PIXEL_SHADER: 0x212,
    SET_VS_CONST_F: 0x213, SET_VS_CONST_I: 0x214, SET_VS_CONST_B: 0x215,
    SET_PS_CONST_F: 0x216, SET_PS_CONST_I: 0x217, SET_PS_CONST_B: 0x218,
    DRAW_PRIMITIVE: 0x300, DRAW_INDEXED_PRIMITIVE: 0x301,
    DRAW_PRIMITIVE_UP: 0x302, DRAW_INDEXED_PRIMITIVE_UP: 0x303,
};

const D9WG_MAGIC = 0x47573944;
const BATCH_FLAG_PRESENT = 1;
const DECLUSAGE = { POSITION: 0, NORMAL: 3, TEXCOORD: 5, POSITIONT: 9, COLOR: 10 };
const DECLTYPE = { FLOAT1: 0, FLOAT2: 1, FLOAT3: 2, FLOAT4: 3, D3DCOLOR: 4 };
const DEVICE = 0x00100002;

// ---- D9WG batch builder ----
//
// `blob` is the trailing variable-length payload some commands carry (shader
// bytecode, vertex data, constant values); the builder patches the recorded
// offset once the command's position in the batch is known, exactly as
// reserve_command_locked() does on the guest.

function command(opcode, payload, blob, blobOffsetField) {
    return { opcode, payload, blob: blob || null, blobOffsetField };
}

function buildBatch(commands, options = {}) {
    let commandBytes = 0;
    for (const item of commands) {
        const raw = 16 + item.payload.length + (item.blob ? item.blob.length : 0);
        item.size = (raw + 7) & ~7;
        item.offset = 32 + commandBytes;
        commandBytes += item.size;
    }
    const batch = Buffer.alloc(32 + commandBytes);
    batch.writeUInt32LE(D9WG_MAGIC, 0);
    batch.writeUInt16LE(1, 4);
    batch.writeUInt16LE(0, 6);
    batch.writeUInt32LE(options.frameId || 1, 8);
    batch.writeUInt32LE(options.present ? BATCH_FLAG_PRESENT : 0, 12);
    batch.writeUInt32LE(commands.length, 16);
    batch.writeUInt32LE(commandBytes, 20);
    let sequence = 1;
    for (const item of commands) {
        batch.writeUInt16LE(item.opcode, item.offset);
        batch.writeUInt32LE(item.size, item.offset + 4);
        batch.writeUInt32LE(sequence++, item.offset + 8);
        if (item.blob) {
            const blobOffset = item.offset + 16 + item.payload.length;
            item.payload.writeUInt32LE(blobOffset, item.blobOffsetField);
            item.blob.copy(batch, blobOffset);
        }
        item.payload.copy(batch, item.offset + 16);
    }
    return batch;
}

function u32(...values) {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, index * 4));
    return buffer;
}

function createDevicePayload(width, height, autoDepth = 1) {
    const payload = Buffer.alloc(44);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(0x1234, 4);
    payload.writeUInt32LE(width, 16);
    payload.writeUInt32LE(height, 20);
    payload.writeUInt32LE(22, 24);
    payload.writeUInt32LE(1, 28);
    payload.writeUInt32LE(autoDepth, 36);
    return payload;
}

function element(stream, offset, type, usage, usageIndex = 0) {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt16LE(stream, 0);
    buffer.writeUInt16LE(offset, 2);
    buffer.writeUInt8(type, 4);
    buffer.writeUInt8(0, 5);
    buffer.writeUInt8(usage, 6);
    buffer.writeUInt8(usageIndex, 7);
    return buffer;
}

function declarationPayload(handle, elements) {
    return Buffer.concat([u32(DEVICE, handle, elements.length, 0), ...elements]);
}

function fvfPayload(fvf, elements) {
    return Buffer.concat([u32(DEVICE, fvf, elements.length, 0), ...elements]);
}

function createBufferPayload(handle, kind, byteCount, format = 0) {
    return u32(DEVICE, handle, kind, byteCount, 0, format, 0, 0);
}

function setStreamSourcePayload(stream, handle, stride, offsetInBytes = 0) {
    return u32(DEVICE, stream, handle, stride, offsetInBytes, 0);
}

function drawPrimitivePayload(type, startVertex, primitiveCount) {
    return u32(DEVICE, type, startVertex, primitiveCount);
}

function drawIndexedPayload(type, baseVertex, startIndex, primitiveCount) {
    const payload = Buffer.alloc(28);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(type, 4);
    payload.writeInt32LE(baseVertex, 8);
    payload.writeUInt32LE(0, 12);
    payload.writeUInt32LE(0, 16);
    payload.writeUInt32LE(startIndex, 20);
    payload.writeUInt32LE(primitiveCount, 24);
    return payload;
}

function shaderCreatePayload(handle, tokens) {
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(handle, 4);
    payload.writeUInt32LE(tokens.length, 8);
    const hash = shaderPipeline.hashTokens(tokens);
    payload.writeUInt32LE(hash.low, 16);
    payload.writeUInt32LE(hash.high, 20);
    const blob = Buffer.alloc(tokens.length * 4);
    tokens.forEach((token, index) => blob.writeUInt32LE(token >>> 0, index * 4));
    return { payload, blob, blobOffsetField: 12 };
}

function constantPayload(startRegister, vectorCount, values, writer) {
    const payload = Buffer.alloc(16);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(startRegister, 4);
    payload.writeUInt32LE(vectorCount, 8);
    const stride = values.length / vectorCount;
    const blob = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => writer(blob, value, index * 4));
    void stride;
    return { payload, blob, blobOffsetField: 12 };
}

const floatConstants = (start, values) => constantPayload(start, values.length / 4,
    values, (buffer, value, at) => buffer.writeFloatLE(value, at));
const intConstants = (start, values) => constantPayload(start, values.length / 4,
    values, (buffer, value, at) => buffer.writeInt32LE(value, at));
const boolConstants = (start, values) => constantPayload(start, values.length,
    values, (buffer, value, at) => buffer.writeUInt32LE(value, at));

// ---- shader bytecode fixtures ----

const VS = (major, minor) => (0xfffe0000 | (major << 8) | minor) >>> 0;
const PS = (major, minor) => (0xffff0000 | (major << 8) | minor) >>> 0;
const END = 0x0000ffff;
const REG = shaderPipeline.REGISTER;
const SIO = shaderPipeline.OP;
const regTypeBits = type => (((type & 0x7) << 28) | ((type & 0x18) << 8)) >>> 0;
const instr = (opcode, length = 0) =>
    ((opcode & 0xffff) | ((length & 0xf) << 24)) >>> 0;
const dst = (type, index, mask = 0xf) =>
    (0x80000000 | (index & 0x7ff) | regTypeBits(type) | (mask << 16)) >>> 0;
const src = (type, index) =>
    (0x80000000 | (index & 0x7ff) | regTypeBits(type) | (0xe4 << 16)) >>> 0;
const dcl = (usage, usageIndex = 0, textureType = 0) =>
    (0x80000000 | usage | (usageIndex << 16) | (textureType << 27)) >>> 0;

// vs_2_0: dcl_position v0 / dcl_color0 v1 / m4x4 oPos, v0, c0 / mov oD0, v1
const VS_BYTECODE = [
    VS(2, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.INPUT, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.COLOR, 0), dst(REG.INPUT, 1),
    instr(SIO.M4x4, 3), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
    instr(SIO.MOV, 2), dst(REG.ATTROUT, 0), src(REG.INPUT, 1),
    END,
];

// ps_2_0: dcl_2d s0 / dcl t0 / texld r0, t0, s0 / mul oC0, r0, c1
const PS_BYTECODE = [
    PS(2, 0),
    instr(SIO.DCL, 2), dcl(0, 0, 2), dst(REG.SAMPLER, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
    instr(SIO.TEX, 3), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), src(REG.SAMPLER, 0),
    instr(SIO.MUL, 3), dst(REG.COLOROUT, 0), src(REG.TEMP, 0), src(REG.CONST, 1),
    END,
];

// A shader the translator refuses (ps_1_x bump environment mapping).
const PS_UNSUPPORTED = [
    PS(1, 1),
    instr(SIO.TEX), dst(REG.TEXTURE, 0),
    instr(SIO.TEXBEM), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
    END,
];

// ---- fake WebGPU ----

function makeFakeWebGPU() {
    const calls = [];
    const submittedWorkResolvers = [];
    class FakeBuffer {
        constructor(descriptor) { this.descriptor = descriptor; this.size = descriptor.size; }
        destroy() { this.destroyed = true; }
    }
    class FakeTexture {
        constructor(descriptor) { this.descriptor = descriptor; }
        createView() { return { texture: this }; }
        destroy() { this.destroyed = true; }
    }
    class FakePass {
        constructor(descriptor) { this.descriptor = descriptor; this.ops = []; }
        setPipeline(p) { this.ops.push(["pipeline", p]); }
        setBindGroup(i, g) { this.ops.push(["bindGroup", i, g]); }
        setViewport(...a) { this.ops.push(["viewport", ...a]); }
        setVertexBuffer(slot, buffer, offset) {
            this.ops.push(["vertexBuffer", slot, buffer, offset]);
        }
        setIndexBuffer(buffer, format, offset) {
            this.ops.push(["indexBuffer", buffer, format, offset]);
        }
        draw(...a) { this.ops.push(["draw", ...a]); }
        drawIndexed(...a) { this.ops.push(["drawIndexed", ...a]); }
        end() { this.ended = true; }
    }
    class FakeEncoder {
        constructor() { this.passes = []; }
        beginRenderPass(descriptor) {
            const pass = new FakePass(descriptor);
            this.passes.push(pass);
            calls.push(["beginRenderPass", descriptor, pass]);
            return pass;
        }
        finish() { return { encoder: this }; }
    }
    const queue = {
        writeBuffer(buffer, offset, data, dataOffset, size) {
            const length = size !== undefined ? size
                : (data.byteLength !== undefined ? data.byteLength : data.length);
            assert.equal(offset % 4, 0, "writeBuffer destination offset must be 4-aligned");
            assert.equal(length % 4, 0, "writeBuffer size must be a multiple of 4");
            // WebGPU copies the source at call time. Snapshotting here rather
            // than holding the caller's view matters: the executor writes
            // straight out of a buffer's CPU shadow, which keeps mutating, so
            // a live reference would make every recorded write appear to
            // contain the frame's final contents.
            const view = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            const start = ArrayBuffer.isView(data) ? (dataOffset || 0) * 1 : (dataOffset || 0);
            const snapshot = view.slice(start, start + length);
            calls.push(["writeBuffer", buffer, offset, data, dataOffset, size, snapshot]);
        },
        writeTexture(...a) { calls.push(["writeTexture", ...a]); },
        submit(buffers) { calls.push(["submit", buffers]); },
        onSubmittedWorkDone() {
            return new Promise(resolve => submittedWorkResolvers.push(resolve));
        },
    };
    const device = {
        queue,
        lost: new Promise(() => {}),
        createShaderModule(descriptor) {
            const module = { descriptor, code: descriptor.code,
                getCompilationInfo: async () => ({ messages: [] }) };
            calls.push(["createShaderModule", descriptor, module]);
            return module;
        },
        createBuffer(descriptor) {
            const buffer = new FakeBuffer(descriptor);
            calls.push(["createBuffer", descriptor, buffer]);
            return buffer;
        },
        createTexture(descriptor) {
            const texture = new FakeTexture(descriptor);
            calls.push(["createTexture", descriptor, texture]);
            return texture;
        },
        createSampler(descriptor) {
            const sampler = { descriptor };
            calls.push(["createSampler", descriptor, sampler]);
            return sampler;
        },
        createCommandEncoder() {
            const encoder = new FakeEncoder();
            calls.push(["createCommandEncoder", encoder]);
            return encoder;
        },
        createBindGroupLayout(descriptor) {
            const layout = { descriptor,
                bindings: new Set(descriptor.entries.map(e => e.binding)) };
            calls.push(["createBindGroupLayout", descriptor, layout]);
            return layout;
        },
        createPipelineLayout(descriptor) {
            calls.push(["createPipelineLayout", descriptor]);
            return { descriptor };
        },
        createRenderPipeline(descriptor) {
            const pipeline = { descriptor };
            calls.push(["createRenderPipeline", descriptor, pipeline]);
            return pipeline;
        },
        createBindGroup(descriptor) {
            const declared = descriptor.layout.bindings;
            const supplied = new Set(descriptor.entries.map(e => e.binding));
            for (const binding of supplied)
                assert.ok(declared.has(binding),
                    "bind group supplies binding " + binding +
                    " which its layout does not declare");
            for (const binding of declared)
                assert.ok(supplied.has(binding),
                    "bind group layout declares binding " + binding +
                    " but the bind group does not supply it");
            calls.push(["createBindGroup", descriptor]);
            return descriptor;
        },
    };
    const context = {
        configure(descriptor) { calls.push(["configure", descriptor]); },
        getCurrentTexture() {
            return { width: 640, height: 480, createView: () => ({ swapchain: true }) };
        },
    };
    const gpu = {
        async requestAdapter() { return { async requestDevice() { return device; } }; },
        getPreferredCanvasFormat() { return "bgra8unorm"; },
    };
    return { calls, device, context, gpu,
        completeSubmittedWork() {
            for (const resolve of submittedWorkResolvers.splice(0)) resolve();
        } };
}

function makeExecutor() {
    const fake = makeFakeWebGPU();
    const canvas = { width: 1, height: 1, getContext: () => fake.context };
    const executor = new D3D9WebGPUExecutor(canvas, { gpu: fake.gpu });
    return { fake, executor,
        find: name => fake.calls.filter(call => call[0] === name),
        last: name => {
            const matches = fake.calls.filter(call => call[0] === name);
            return matches[matches.length - 1];
        } };
}

// ---- harness ----

const failures = [];
let passed = 0;

async function test(name, body) {
    try {
        await body();
        ++passed;
    } catch (error) {
        failures.push({ name, error });
    }
}

// ---- tests ----

async function main() {

await test("fixed-function FVF triangle still renders (M1 regression guard)", async () => {
    const { executor, fake, find } = makeExecutor();
    const vertices = Buffer.alloc(3 * 16);
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    const create = shaderCreatePayload; void create;
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, vertices.length)),
        command(OP.SET_FVF, fvfPayload(0x142, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.drawCalls, 1, "the draw was not recorded");
    assert.equal(executor.stats.droppedDraws, 0);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-list");
    assert.equal(pipeline.vertex.entryPoint, "d9_vs_main");
    assert.equal(pipeline.fragment.entryPoint, "d9_ps_main");
    // Position at location 0, diffuse at location 1, both from stream 0.
    assert.equal(pipeline.vertex.buffers.length, 1);
    assert.equal(pipeline.vertex.buffers[0].arrayStride, 16);
    assert.deepEqual(pipeline.vertex.buffers[0].attributes, [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "unorm8x4" },
    ]);
    const passes = fake.calls.filter(c => c[0] === "beginRenderPass");
    assert.equal(passes.length, 1);
    assert.deepEqual(passes[0][2].ops.filter(op => op[0] === "draw"), [["draw", 3]]);
});

await test("fixed-function attribute locations follow semantics, not element order", async () => {
    // TEXCOORD declared before COLOR. M1 assigned locations by iteration
    // order while the WGSL hardcoded colour at location 1, so this
    // declaration fed texcoord bytes into the colour attribute.
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
        element(0, 20, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 24)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    const byLocation = new Map(pipeline.vertex.buffers[0].attributes
        .map(a => [a.shaderLocation, a]));
    assert.equal(byLocation.get(1).offset, 20, "COLOR0 must stay at location 1");
    assert.equal(byLocation.get(1).format, "unorm8x4");
    assert.equal(byLocation.get(2).offset, 12, "TEXCOORD0 must stay at location 2");
    assert.equal(byLocation.get(2).format, "float32x2");
});

await test("programmable vs+ps: modules, bindings and constants all line up", async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    const vs = shaderCreatePayload(0x40000001, VS_BYTECODE);
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    const vsConst = floatConstants(0, [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1,
    ]);
    const psConst = floatConstants(1, [0.25, 0.5, 0.75, 1]);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000001)),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_VS_CONST_F, vsConst.payload, vsConst.blob, vsConst.blobOffsetField),
        command(OP.SET_PS_CONST_F, psConst.payload, psConst.blob, psConst.blobOffsetField),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.shadersTranslated, 2);
    assert.equal(executor.stats.shaderTranslationFailures, 0);
    // One extra translation for the D3DCOLOR-corrected vertex variant.
    assert.equal(executor.stats.shaderVariantsTranslated, 1);
    assert.equal(executor.stats.droppedDraws, 0, "the programmable draw was dropped");
    assert.equal(executor.stats.programmableDraws, 1);

    // Vertex and fragment must come from two different modules.
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.notEqual(pipeline.vertex.module, pipeline.fragment.module);
    assert.ok(pipeline.vertex.module.code.includes("@vertex"));
    assert.ok(pipeline.fragment.module.code.includes("@fragment"));
    // The v1 COLOR0 input is D3DCOLOR, so the module must swizzle it.
    assert.ok(/vin1 = in1\.bgra;/.test(pipeline.vertex.module.code),
        "D3DCOLOR vertex input was not corrected to RGBA:\n" +
        pipeline.vertex.module.code);
    // Locations follow the shader's own v# register numbers.
    assert.deepEqual(pipeline.vertex.buffers[0].attributes, [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "unorm8x4" },
    ]);

    // Bind group layout: vertex constants at 0, pixel constants at 1,
    // sampler 0's texture/sampler pair at 2/3.
    const layout = find("createBindGroupLayout").pop()[1];
    assert.deepEqual(layout.entries.map(e => e.binding).sort((a, b) => a - b),
        [0, 1, 2, 3]);
    const bindGroup = find("createBindGroup").pop()[1];
    const entries = new Map(bindGroup.entries.map(e => [e.binding, e]));
    assert.ok(entries.get(0).resource.buffer, "vertex constants are not a buffer");
    assert.equal(entries.get(0).resource.offset, 0);
    assert.equal(entries.get(1).resource.offset % 256, 0,
        "the pixel constant region must start on a 256-byte boundary");

    // And the values themselves: c0..c3 for the vertex stage, c1 for the
    // pixel stage at its own offset.
    const write = find("writeBuffer").filter(
        call => call[1] === entries.get(0).resource.buffer).pop();
    const data = new DataView(write[3]);
    assert.equal(data.getFloat32(12 * 4, true), 5, "vs c3.x");
    assert.equal(data.getFloat32(13 * 4, true), 6, "vs c3.y");
    const pixelBase = entries.get(1).resource.offset;
    assert.equal(data.getFloat32(pixelBase + 16, true), 0.25, "ps c1.x");
    assert.equal(data.getFloat32(pixelBase + 28, true), 1, "ps c1.w");
});

await test("shader `def` literals override app-set constants for that register", async () => {
    const { executor, find } = makeExecutor();
    // ps_2_0 with `def c0, 0.5, 0.25, 0, 1` and mov oC0, c0.
    const bytecode = [
        PS(2, 0),
        instr(SIO.DEF, 5), dst(REG.CONST, 0),
        0x3f000000, 0x3e800000, 0x00000000, 0x3f800000,
        instr(SIO.MOV, 2), dst(REG.COLOROUT, 0), src(REG.CONST, 0),
        END,
    ];
    const ps = shaderCreatePayload(0x40000005, bytecode);
    const psConst = floatConstants(0, [9, 9, 9, 9]);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000005)),
        command(OP.SET_PS_CONST_F, psConst.payload, psConst.blob, psConst.blobOffsetField),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const bindGroup = find("createBindGroup").pop()[1];
    const pixelEntry = bindGroup.entries.find(e => e.binding === 1);
    const write = find("writeBuffer").filter(
        call => call[1] === pixelEntry.resource.buffer).pop();
    const data = new DataView(write[3]);
    const base = pixelEntry.resource.offset;
    assert.equal(data.getFloat32(base, true), 0.5,
        "def c0 must win over SetPixelShaderConstantF");
    assert.equal(data.getFloat32(base + 4, true), 0.25);
});

await test("int and bool constant registers land after the float region", async () => {
    const { executor, find } = makeExecutor();
    // vs_2_0 with rep i0 { add r0, r0, c0 } and if b0.
    const bytecode = [
        VS(2, 0),
        instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.INPUT, 0),
        instr(SIO.REP, 1), src(REG.CONSTINT, 0),
        instr(SIO.ADD, 3), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.CONST, 0),
        instr(SIO.ENDREP),
        instr(SIO.IF, 1), src(REG.CONSTBOOL, 0),
        instr(SIO.MOV, 2), dst(REG.TEMP, 0), src(REG.CONST, 1),
        instr(SIO.ENDIF),
        instr(SIO.MOV, 2), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ];
    const vs = shaderCreatePayload(0x40000007, bytecode);
    const ints = intConstants(0, [3, 0, 1, 0]);
    const bools = boolConstants(0, [1]);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000007)),
        command(OP.SET_VS_CONST_I, ints.payload, ints.blob, ints.blobOffsetField),
        command(OP.SET_VS_CONST_B, bools.payload, bools.blob, bools.blobOffsetField),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const bindGroup = find("createBindGroup").pop()[1];
    const write = find("writeBuffer").filter(
        call => call[1] === bindGroup.entries[0].resource.buffer).pop();
    const data = new DataView(write[3]);
    // The shader reads c0 and c1, so the float region is two vec4s (32 bytes),
    // then i0 (16 bytes), then the bool vector.
    assert.equal(data.getInt32(32, true), 3, "i0.x");
    assert.equal(data.getInt32(40, true), 1, "i0.z");
    assert.equal(data.getUint32(48, true), 1, "b0");
});

await test("a shader the translator refuses skips its draws and keeps the batch alive", async () => {
    const { executor } = makeExecutor();
    const ps = shaderCreatePayload(0x40000009, PS_UNSUPPORTED);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000009)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.failed, null, "the batch must not fail as a whole");
    assert.equal(executor.stats.shaderTranslationFailures, 1);
    assert.equal(executor.stats.droppedDraws, 1, "only the shader-bound draw is skipped");
    assert.equal(executor.stats.drawsSkippedForBadShader, 1,
        "the skip must be attributed to the shader, not to missing geometry");
    assert.equal(executor.stats.drawCalls, 1, "the fixed-function draw still ran");
});

await test("independent sampler state drives the GPUSampler, not the texture", async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const D3DSAMP_ADDRESSU = 1, D3DSAMP_ADDRESSV = 2;
    const D3DSAMP_MAGFILTER = 5, D3DSAMP_MINFILTER = 6, D3DSAMP_MIPFILTER = 7;
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_ADDRESSU, 3)), // CLAMP
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_ADDRESSV, 2)), // MIRROR
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MAGFILTER, 2)), // LINEAR
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MINFILTER, 2)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MIPFILTER, 2)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const samplers = find("createSampler");
    assert.equal(samplers.length, 1, "expected exactly one sampler to be created");
    assert.deepEqual({
        u: samplers[0][1].addressModeU, v: samplers[0][1].addressModeV,
        mag: samplers[0][1].magFilter, min: samplers[0][1].minFilter,
        mip: samplers[0][1].mipmapFilter,
    }, { u: "clamp-to-edge", v: "mirror-repeat", mag: "linear",
        min: "linear", mip: "linear" });
    assert.equal(executor.stats.samplersCreated, 1);
});

await test("a second draw with the same sampler state reuses the cached sampler", async () => {
    const { executor } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.samplersCreated, 1);
    assert.equal(executor.stats.samplerHits, 1);
});

await test("multi-stream declarations bind one vertex buffer per stream", async () => {
    const { executor, fake, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(1, 0, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
        element(1, 4, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x202, 1, 96)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(1, 0x202, 12, 32)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.vertex.buffers.length, 2, "expected two vertex buffer layouts");
    assert.deepEqual(pipeline.vertex.buffers[0].attributes,
        [{ shaderLocation: 0, offset: 0, format: "float32x3" }]);
    assert.equal(pipeline.vertex.buffers[1].arrayStride, 12);
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    const binds = pass.ops.filter(op => op[0] === "vertexBuffer");
    assert.equal(binds.length, 2);
    assert.equal(binds[1][3], 32, "stream 1's OffsetInBytes was lost");
});

await test("triangle strips use strip topology instead of being reinterpreted as a list", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(5, 0, 4)), // 4 tris
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-strip");
    assert.equal(pipeline.primitive.stripIndexFormat, undefined,
        "a non-indexed strip must not declare stripIndexFormat");
});

await test("indexed triangle strips declare the strip index format", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x202, 2, 64, 101)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_INDICES, u32(DEVICE, 0x202)),
        command(OP.DRAW_INDEXED_PRIMITIVE, drawIndexedPayload(5, 0, 0, 4)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-strip");
    assert.equal(pipeline.primitive.stripIndexFormat, "uint16");
});

await test("triangle fans become an indexed triangle list", async () => {
    const { executor, fake, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(6, 0, 3)), // fan, 3 tris
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-list");
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    const drawIndexed = pass.ops.filter(op => op[0] === "drawIndexed");
    assert.equal(drawIndexed.length, 1);
    assert.equal(drawIndexed[0][1], 9, "3 fan triangles == 9 list indices");
    // (0,1,2) (0,2,3) (0,3,4)
    const indexWrite = find("writeBuffer").find(
        call => call[3] instanceof Uint32Array && call[3].length === 9);
    assert.ok(indexWrite, "the generated fan index buffer was not uploaded");
    assert.deepEqual([...indexWrite[3]], [0, 1, 2, 0, 2, 3, 0, 3, 4]);
});

await test("DrawIndexedPrimitiveUP works (M1 threw a ReferenceError on every call)", async () => {
    const { executor, fake } = makeExecutor();
    const vertexBytes = 4 * 12;
    const indexBytes = 6 * 2;
    const blob = Buffer.alloc(indexBytes + vertexBytes);
    for (let i = 0; i < 6; ++i) blob.writeUInt16LE([0, 1, 2, 0, 2, 3][i], i * 2);
    const payload = Buffer.alloc(48);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(4, 4);       // D3DPT_TRIANGLELIST
    payload.writeUInt32LE(0, 8);       // min_vertex_index
    payload.writeUInt32LE(4, 12);      // vertex_count
    payload.writeUInt32LE(2, 16);      // primitive_count
    payload.writeUInt32LE(101, 20);    // D3DFMT_INDEX16
    payload.writeUInt32LE(12, 24);     // stride
    payload.writeUInt32LE(6, 28);      // index_count
    payload.writeUInt32LE(indexBytes, 32);
    payload.writeUInt32LE(vertexBytes, 36);
    // index_data_offset / vertex_data_offset are patched below.
    const built = buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.DRAW_INDEXED_PRIMITIVE_UP, payload, blob, 40),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true });
    // buildBatch patched index_data_offset (field 40); the vertex data sits
    // straight after the index data in the same blob, so field 44 is patched
    // here, in the assembled batch, to point past it.
    const blobOffset = payload.readUInt32LE(40);
    const commandOffset = built.indexOf(payload, 32);
    built.writeUInt32LE(blobOffset + indexBytes, commandOffset + 44);

    await executor.submit(built);
    await executor.idle();
    assert.equal(executor.failed, null,
        "DrawIndexedPrimitiveUP must not blow up the batch: " + executor.failed);
    assert.equal(executor.stats.upDrawCalls, 1);
    assert.equal(executor.stats.droppedDraws, 0);
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    assert.equal(pass.ops.filter(op => op[0] === "drawIndexed").length, 1);
});

await test("identical bytecode is translated once and shares one shader module", async () => {
    const { executor, find } = makeExecutor();
    const first = shaderCreatePayload(0x40000011, VS_BYTECODE);
    const second = shaderCreatePayload(0x40000013, VS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, first.payload, first.blob, first.blobOffsetField),
        command(OP.CREATE_VERTEX_SHADER, second.payload, second.blob, second.blobOffsetField),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.shaderCache.stats.compiles, 1);
    assert.equal(executor.shaderCache.stats.hits, 1);
    assert.equal(find("createShaderModule").length, 0,
        "modules are only created when a pipeline needs them");
});

await test("HELLO's feature bits report which guest DLL is loaded", async () => {
    const { executor } = makeExecutor();
    // guest_pointer_bits / feature_bits / session_id_low / session_id_high.
    await executor.submit(buildBatch([
        command(OP.HELLO, u32(32, 1 /* D9WG_FEATURE_SHADER_MODEL_2 */, 0, 0)),
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.guestShaderModel2, true);

    const stale = makeExecutor();
    await stale.executor.submit(buildBatch([
        command(OP.HELLO, u32(32, 0, 0, 0)),
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await stale.executor.idle();
    assert.equal(stale.executor.stats.guestShaderModel2, false,
        "a pre-M2 guest must be distinguishable from one that simply drew " +
        "no shaders");
});

await test("an empty client rect on Present keeps the last known surface size", async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const surfaceChangesAfterFirst = executor.stats.surfaceChanges;
    // Fullscreen War3 reports 0x0 here; letting that through would resize the
    // overlay canvas every other frame.
    await executor.submit(buildBatch([
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 0, 0)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.emptySurfaceReports, 1);
    assert.equal(executor.stats.surfaceChanges, surfaceChangesAfterFirst,
        "an empty rect must not count as a surface change");
    const state = executor.devices.get(DEVICE);
    assert.equal(state.surface.width, 640);
    assert.equal(state.surface.height, 480);
});

await test("frames that never clear the colour target are counted", async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        // A draw with no preceding Clear: WebGPU does not preserve the
        // canvas across Present, so this composites over an undefined buffer.
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.framesWithoutColorClear, 1);
    assert.equal(executor.stats.framesWithNoOps, 0);
});

await test("a dynamic buffer rewritten between draws does not corrupt the earlier draw", async () => {
    // The exact idiom that made War3's scene geometry explode: one shared
    // dynamic vertex buffer, refilled and drawn twice inside a single frame.
    // Draws are recorded and replayed at Present, while writeBuffer takes
    // effect in queue order -- so without renaming, both draws would read the
    // second batch of vertices.
    const { executor, fake, find } = makeExecutor();
    const batchA = Buffer.alloc(36, 0x11);
    const batchB = Buffer.alloc(36, 0x22);
    const updatePayload = (handle, byteCount) => {
        const payload = Buffer.alloc(24);
        payload.writeUInt32LE(handle, 0);
        payload.writeUInt32LE(0, 4);
        payload.writeUInt32LE(byteCount, 8);
        return payload;
    };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.UPDATE_BUFFER, updatePayload(0x201, 36), batchA, 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.UPDATE_BUFFER, updatePayload(0x201, 36), batchB, 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.drawCalls, 2);
    assert.equal(executor.stats.bufferRenames, 1,
        "the second write must rename, not overwrite what draw 1 reads");

    // The two draws must end up bound to two different GPUBuffers.
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    const bound = pass.ops.filter(op => op[0] === "vertexBuffer").map(op => op[2]);
    assert.equal(bound.length, 2);
    assert.notEqual(bound[0], bound[1],
        "both draws are reading the same buffer, so the first one renders " +
        "the second one's vertices");

    // And each buffer must hold the batch its draw was issued with.
    const contentsOf = buffer => {
        const write = find("writeBuffer").filter(call => call[1] === buffer).pop();
        assert.ok(write, "no upload for a bound vertex buffer");
        return write[6][0]; // the snapshot taken at writeBuffer time
    };
    assert.equal(contentsOf(bound[0]), 0x11, "draw 1 lost its vertex data");
    assert.equal(contentsOf(bound[1]), 0x22, "draw 2 got the wrong vertex data");
});

await test("a buffer rewritten with no draw in between is updated in place", async () => {
    // Renaming must stay off the ordinary path: upload once, draw many.
    const { executor } = makeExecutor();
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(0x201, 0);
    payload.writeUInt32LE(0, 4);
    payload.writeUInt32LE(36, 8);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x11), 12),
        command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x22), 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.bufferRenames, 0,
        "no draw observed the first contents, so nothing needed renaming");
});

await test("a buffer rewritten in a later frame is updated in place", async () => {
    const { executor } = makeExecutor();
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(0x201, 0);
    payload.writeUInt32LE(0, 4);
    payload.writeUInt32LE(36, 8);
    const frame = data => buildBatch([
        command(OP.UPDATE_BUFFER, payload, data, 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
    ]));
    await executor.submit(frame(Buffer.alloc(36, 0x11)));
    await executor.submit(frame(Buffer.alloc(36, 0x22)));
    await executor.idle();
    assert.equal(executor.stats.drawCalls, 2);
    assert.equal(executor.stats.bufferRenames, 0,
        "the previous frame was already submitted; its draws cannot be " +
        "affected by this frame's writes");
});

await test("alpha test becomes a discard in both fixed-function and translated shaders", async () => {
    const D3DRS_ALPHATESTENABLE = 15, D3DRS_ALPHAREF = 24, D3DRS_ALPHAFUNC = 25;
    const D3DCMP_GREATEREQUAL = 7;
    const { executor, find } = makeExecutor();
    const ps = shaderCreatePayload(0x40000021, PS_BYTECODE);
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHATESTENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHAFUNC, D3DCMP_GREATEREQUAL, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHAREF, 128, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        // Same draw with a translated pixel shader bound.
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000021)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);

    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2);
    for (const pipeline of pipelines) {
        const code = pipeline.fragment.module.code;
        assert.ok(code.includes("discard;"),
            "alpha test did not emit a discard:\n" + code);
        // GREATEREQUAL passes when a >= ref, so the discard is its negation.
        assert.ok(code.includes("0.501961"),
            "alpha reference 128 should normalise to ~0.501961:\n" + code);
    }
});

await test("turning alpha test off again returns to the untested shader", async () => {
    const D3DRS_ALPHATESTENABLE = 15;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHATESTENABLE, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHATESTENABLE, 0, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2, "the two states must not share a pipeline");
    // D3DCMP_ALWAYS is the default, so enabling alpha test without setting a
    // function is still a no-op -- the first draw must not gain a discard.
    assert.ok(!pipelines[0].fragment.module.code.includes("discard;"),
        "ALPHAFUNC defaults to ALWAYS, which tests nothing");
    assert.ok(!pipelines[1].fragment.module.code.includes("discard;"));
});

await test("the D3D9 hardware cursor is uploaded and composited over the frame", async () => {
    const { executor, fake, find } = makeExecutor();
    const size = 8;
    const bitmap = Buffer.alloc(size * size * 4, 0x80);
    const cursorProps = Buffer.alloc(32);
    cursorProps.writeUInt32LE(DEVICE, 0);
    cursorProps.writeUInt32LE(2, 4);   // hotspot x
    cursorProps.writeUInt32LE(3, 8);   // hotspot y
    cursorProps.writeUInt32LE(size, 12);
    cursorProps.writeUInt32LE(size, 16);
    cursorProps.writeUInt32LE(bitmap.length, 20);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(0x21A, cursorProps, bitmap, 24),
        command(0x21B, u32(DEVICE, 100, 50, 0)),   // SET_CURSOR_POSITION
        command(0x21C, u32(DEVICE, 1)),            // SHOW_CURSOR
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.cursorUploads, 1);
    assert.equal(executor.stats.cursorDraws, 1);
    // The cursor gets its own final pass, loading the frame underneath.
    const passes = fake.calls.filter(c => c[0] === "beginRenderPass");
    const cursorPass = passes[passes.length - 1];
    assert.equal(cursorPass[1].colorAttachments[0].loadOp, "load",
        "the cursor pass must not clear the frame it sits on");
    assert.equal(cursorPass[1].depthStencilAttachment, undefined,
        "the cursor must not be depth-tested against the game's scene");
    assert.deepEqual(cursorPass[2].ops.filter(op => op[0] === "draw"),
        [["draw", 6]]);

    // Position is placed by the hotspot, in normalised back-buffer space.
    const rectWrite = find("writeBuffer")
        .filter(call => call[6] && call[6].byteLength === 16).pop();
    const rect = new Float32Array(rectWrite[6].buffer, rectWrite[6].byteOffset, 4);
    assert.ok(Math.abs(rect[0] - (100 - 2) / 640) < 1e-6, "cursor origin x");
    assert.ok(Math.abs(rect[1] - (50 - 3) / 480) < 1e-6, "cursor origin y");
    assert.ok(Math.abs(rect[2] - size / 640) < 1e-6, "cursor width");
});

await test("a hidden cursor is not composited", async () => {
    const { executor } = makeExecutor();
    const size = 4;
    const bitmap = Buffer.alloc(size * size * 4, 0xff);
    const cursorProps = Buffer.alloc(32);
    cursorProps.writeUInt32LE(DEVICE, 0);
    cursorProps.writeUInt32LE(size, 12);
    cursorProps.writeUInt32LE(size, 16);
    cursorProps.writeUInt32LE(bitmap.length, 20);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(0x21A, cursorProps, bitmap, 24),
        command(0x21C, u32(DEVICE, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.submit(buildBatch([
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(0x21C, u32(DEVICE, 0)),  // ShowCursor(FALSE)
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.cursorUploads, 1);
    assert.equal(executor.stats.cursorDraws, 1, "only the visible frame draws it");
});

await test("the lock flags decide whether a mid-frame write has to rename", async () => {
    const D3DLOCK_NOOVERWRITE = 0x1000, D3DLOCK_DISCARD = 0x2000;
    const run = async lockFlags => {
        const { executor } = makeExecutor();
        const payload = Buffer.alloc(24);
        payload.writeUInt32LE(0x201, 0);
        payload.writeUInt32LE(0, 4);
        payload.writeUInt32LE(36, 8);
        payload.writeUInt32LE(lockFlags, 16);
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
            command(OP.SET_FVF, fvfPayload(0x2,
                [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
            command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
            command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x11), 12),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x22), 12),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
        return executor.stats;
    };

    // NOOVERWRITE is the application promising it is not touching bytes an
    // issued draw reads -- exactly the guarantee the hazard needs. Renaming
    // there is pure waste, and it is the idiom that made War3 rename ~277
    // times a frame.
    const noOverwrite = await run(D3DLOCK_NOOVERWRITE);
    assert.equal(noOverwrite.bufferRenames, 0);
    assert.equal(noOverwrite.bufferNoOverwriteWrites, 1);

    // DISCARD renames, but the replacement only carries the bytes being
    // written now: the rest is contents the application has abandoned.
    const discard = await run(D3DLOCK_DISCARD);
    assert.equal(discard.bufferRenames, 1);
    assert.equal(discard.bufferFullCopyRenames, 0);

    // A plain lock keeps the old contents readable, so the whole shadow has
    // to be copied forward. Correct, and the only case that costs that.
    const plain = await run(0);
    assert.equal(plain.bufferRenames, 1);
    assert.equal(plain.bufferFullCopyRenames, 1);
});

await test("window state reports a game whose window cannot receive input", async () => {
    const { executor } = makeExecutor();
    const windowState = (flags) => {
        const payload = Buffer.alloc(40);
        payload.writeUInt32LE(DEVICE, 0);
        payload.writeUInt32LE(0xa0180, 4);   // hwnd
        payload.writeUInt32LE(0xb1234, 8);   // foreground hwnd (someone else)
        payload.writeUInt32LE(flags, 12);
        payload.writeUInt32LE(800, 24);
        payload.writeUInt32LE(600, 28);
        return payload;
    };
    // IS_WINDOW | VISIBLE | FULLSCREEN, but not FOREGROUND.
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(0x21D, windowState(1 | 2 | 16)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const stats = executor.getStats();
    assert.equal(stats.windowStateChanges, 1);
    assert.equal(stats.window.isWindow, true);
    assert.equal(stats.window.fullscreen, true);
    assert.equal(stats.window.foreground, false,
        "a game that is not the foreground window is exactly the case this " +
        "report exists to make visible");
    assert.equal(stats.window.hwnd, 0xa0180);
    assert.notEqual(stats.window.foregroundHwnd, stats.window.hwnd);
});

await test("the stage-0 texture matrix transforms fixed-function texcoords", async () => {
    const D3DTSS_TEXTURETRANSFORMFLAGS = 24, D3DTTFF_COUNT2 = 2;
    const D3DTS_TEXTURE0 = 16;
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    // A scrolling matrix: D3D9 games put the offset in row 3 (_31/_32) for
    // COUNT2, because the coordinate enters as the row vector (u, v, 1, 1).
    const scroll = [1, 0, 0, 0, 0, 1, 0, 0, 0.25, 0.5, 1, 0, 0, 0, 0, 1];
    const transform = Buffer.alloc(72);
    transform.writeUInt32LE(DEVICE, 0);
    transform.writeUInt32LE(D3DTS_TEXTURE0, 4);
    scroll.forEach((value, index) => transform.writeFloatLE(value, 8 + index * 4));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_TRANSFORM, transform),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(0x202, u32(DEVICE, 0, D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_COUNT2)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);

    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2,
        "enabling the transform must not reuse the untransformed pipeline");
    assert.ok(!pipelines[0].vertex.module.code.includes("texture_transform *"),
        "the first draw has D3DTTFF_DISABLE and must pass texcoords through");
    assert.ok(pipelines[1].vertex.module.code.includes("texture_transform *"),
        "the second draw must apply the matrix:\n" + pipelines[1].vertex.module.code);
    // Entering as (u, v, 1, 1) is what puts the game's offset in row 3.
    assert.ok(pipelines[1].vertex.module.code.includes(".xy, 1.0, 1.0)"),
        "the coordinate must enter the matrix as (u, v, 1, 1)");

    // And the matrix has to actually reach the uniform, after the WVP,
    // viewport and padding.
    const bindGroup = find("createBindGroup").pop()[1];
    const write = find("writeBuffer")
        .filter(call => call[1] === bindGroup.entries[0].resource.buffer).pop();
    const data = new Float32Array(write[6].buffer, write[6].byteOffset, 36);
    assert.deepEqual([...data.slice(20, 36)], scroll);
});

await test("fixed-function fog tints the fragment towards D3DRS_FOGCOLOR", async () => {
    const D3DRS_FOGENABLE = 28, D3DRS_FOGCOLOR = 34, D3DRS_FOGTABLEMODE = 35;
    const D3DRS_FOGSTART = 36, D3DRS_FOGEND = 37;
    const D3DFOG_LINEAR = 3;
    const floatBitsOf = value => {
        const buffer = new ArrayBuffer(4);
        new Float32Array(buffer)[0] = value;
        return new Uint32Array(buffer)[0];
    };
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGTABLEMODE, D3DFOG_LINEAR, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGCOLOR, 0x00405060, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGSTART, floatBitsOf(10), 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGEND, floatBitsOf(200), 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);

    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2, "fog must not reuse the unfogged pipeline");
    assert.ok(!pipelines[0].fragment.module.code.includes("mix(fog.color"),
        "the pre-fog draw must not blend");
    assert.ok(pipelines[1].vertex.module.code.includes("fog_distance"),
        "the fog factor is computed in the vertex stage:\n" +
        pipelines[1].vertex.module.code);
    assert.ok(pipelines[1].fragment.module.code.includes("mix(fog.color"),
        "the pixel stage must blend towards the fog colour");

    // The fixed-function pixel stage has no register file, so binding 1 exists
    // only to carry the fog colour -- and it has to be declared and supplied.
    const layout = find("createBindGroupLayout").pop()[1];
    assert.ok(layout.entries.some(entry => entry.binding === 1),
        "the fog colour needs its own pixel-stage uniform binding");

    const bindGroup = find("createBindGroup").pop()[1];
    const pixelEntry = bindGroup.entries.find(entry => entry.binding === 1);
    const write = find("writeBuffer")
        .filter(call => call[1] === pixelEntry.resource.buffer).pop();
    const data = new Float32Array(write[6].buffer, write[6].byteOffset);
    const fog = data.subarray(pixelEntry.resource.offset / 4,
        pixelEntry.resource.offset / 4 + 3);
    assert.deepEqual([...fog].map(v => Math.round(v * 255)), [0x40, 0x50, 0x60],
        "D3DRS_FOGCOLOR is 0x00RRGGBB and must reach the shader as RGB");

    // FOGSTART/FOGEND are float bits inside a DWORD, not integers.
    const vertexData = new Float32Array(
        find("writeBuffer").filter(c => c[1] === bindGroup.entries[0].resource.buffer)
            .pop()[6].buffer);
    assert.equal(vertexData[40], 10, "FOGSTART decoded as float bits");
    assert.equal(vertexData[41], 200, "FOGEND decoded as float bits");
});

await test("a malformed batch is rejected rather than half-executed", async () => {
    const { executor } = makeExecutor();
    const batch = buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
    ]);
    batch.writeUInt32LE(0xffffffff, 20); // command_bytes past the record
    await executor.submit(batch);
    await executor.idle();
    assert.ok(executor.failed, "an overrunning command_bytes must fail the batch");
    assert.equal(executor.stats.malformedBatches, 1);
});

await test("shader bytecode that overruns the batch is rejected", async () => {
    const { executor } = makeExecutor();
    const vs = shaderCreatePayload(0x40000015, VS_BYTECODE);
    const batch = buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
    ]);
    // Claim far more tokens than the batch can hold.
    const commandOffset = batch.indexOf(vs.payload, 32);
    batch.writeUInt32LE(0x10000, commandOffset + 8);
    await executor.submit(batch);
    await executor.idle();
    assert.ok(executor.failed, "an overrunning token count must fail the batch");
});

// ---- report ----

if (failures.length) {
    for (const failure of failures) {
        console.error("FAIL " + failure.name);
        console.error("  " + (failure.error && failure.error.message));
        if (process.env.D9_TEST_STACK) console.error(failure.error);
    }
    console.error("\n" + failures.length + " failed, " + passed + " passed");
    process.exit(1);
}
console.log(passed + " executor tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
