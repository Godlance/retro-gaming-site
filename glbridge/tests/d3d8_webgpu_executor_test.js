"use strict";

const assert = require("node:assert/strict");
const {
    D3D8WebGPUExecutor,
    D8WG_MAGIC,
} = require("../d3d8-webgpu/d3d8_executor.js");

const OP_HELLO = 1;
const OP_CREATE_DEVICE = 2;
const OP_PRESENT = 4;
const OP_CLEAR = 5;
const OP_BEGIN_SCENE = 6;
const OP_END_SCENE = 7;
const OP_CREATE_BUFFER = 0x100;
const OP_UPDATE_BUFFER = 0x101;
const OP_SET_RENDER_STATE = 0x200;
const OP_SET_STREAM_SOURCE = 0x208;
const OP_SET_VERTEX_FORMAT = 0x20A;
const OP_DRAW_PRIMITIVE = 0x300;

function u32Payload(...values) {
    const payload = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => payload.writeUInt32LE(value >>> 0, index * 4));
    return payload;
}

function createDevicePayload(deviceHandle, width, height) {
    const payload = Buffer.alloc(36);
    payload.writeUInt32LE(deviceHandle, 0);
    payload.writeUInt32LE(0x1234, 4);
    payload.writeInt32LE(11, 8);
    payload.writeInt32LE(22, 12);
    payload.writeUInt32LE(width, 16);
    payload.writeUInt32LE(height, 20);
    payload.writeUInt32LE(22, 24); // D3DFMT_X8R8G8B8
    payload.writeUInt32LE(1, 28);
    payload.writeUInt32LE(0x20, 32);
    return payload;
}

function batch(commandSpecs, frameId) {
    let commandBytes = 0;
    for (const spec of commandSpecs) {
        spec.size = (16 + spec.payload.length + (spec.blob ? spec.blob.length : 0) + 7) & ~7;
        spec.offset = 32 + commandBytes;
        commandBytes += spec.size;
    }
    const result = Buffer.alloc(32 + commandBytes);
    result.writeUInt32LE(D8WG_MAGIC, 0);
    result.writeUInt16LE(1, 4);
    result.writeUInt16LE(0, 6);
    result.writeUInt32LE(frameId, 8);
    result.writeUInt32LE(1, 12);
    result.writeUInt32LE(commandSpecs.length, 16);
    result.writeUInt32LE(commandBytes, 20);

    let sequence = 1;
    for (const spec of commandSpecs) {
        const offset = spec.offset;
        result.writeUInt16LE(spec.opcode, offset);
        result.writeUInt16LE(0, offset + 2);
        result.writeUInt32LE(spec.size, offset + 4);
        result.writeUInt32LE(sequence++, offset + 8);
        spec.payload.copy(result, offset + 16);
        if (spec.blob) {
            const blobOffset = offset + 16 + spec.payload.length;
            result.writeUInt32LE(blobOffset, offset + 16 + 12);
            spec.blob.copy(result, blobOffset);
        }
    }
    return result;
}

function command(opcode, payload, blob) {
    return { opcode, payload, blob };
}

function makeFakeWebGPU() {
    const calls = [];
    class FakeBuffer {
        constructor(descriptor) { this.descriptor = descriptor; this.destroyed = false; }
        destroy() { this.destroyed = true; calls.push(["destroyBuffer"]); }
    }
    class FakePass {
        constructor(descriptor) { this.descriptor = descriptor; this.calls = []; }
        setPipeline(value) { this.calls.push(["setPipeline", value]); }
        setBindGroup(index, value) { this.calls.push(["setBindGroup", index, value]); }
        setVertexBuffer(index, value) { this.calls.push(["setVertexBuffer", index, value]); }
        draw(...args) { this.calls.push(["draw", ...args]); calls.push(["draw", ...args]); }
        end() { this.calls.push(["end"]); calls.push(["endPass"]); }
    }
    class FakeEncoder {
        constructor() { this.passes = []; }
        beginRenderPass(descriptor) {
            const pass = new FakePass(descriptor);
            this.passes.push(pass);
            calls.push(["beginRenderPass", descriptor]);
            return pass;
        }
        finish() { calls.push(["finish"]); return { passes: this.passes }; }
    }
    const queue = {
        writeBuffer(buffer, offset, data) {
            calls.push(["writeBuffer", buffer, offset, Buffer.from(
                data.buffer, data.byteOffset, data.byteLength)]);
        },
        submit(commandBuffers) { calls.push(["submit", commandBuffers]); },
    };
    const device = {
        queue,
        lost: new Promise(() => {}),
        createShaderModule(descriptor) { calls.push(["shader", descriptor]); return descriptor; },
        createBuffer(descriptor) { calls.push(["createBuffer", descriptor]); return new FakeBuffer(descriptor); },
        createCommandEncoder() { calls.push(["createEncoder"]); return new FakeEncoder(); },
        createRenderPipeline(descriptor) {
            calls.push(["createPipeline", descriptor]);
            return { descriptor, getBindGroupLayout() { return { index: 0 }; } };
        },
        createBindGroup(descriptor) { calls.push(["createBindGroup", descriptor]); return descriptor; },
    };
    const context = {
        configure(descriptor) { calls.push(["configure", descriptor]); },
        getCurrentTexture() {
            calls.push(["getCurrentTexture"]);
            return { createView() { return { textureView: true }; } };
        },
    };
    const gpu = {
        async requestAdapter() { return { async requestDevice() { return device; } }; },
        getPreferredCanvasFormat() { return "bgra8unorm"; },
    };
    return { calls, device, context, gpu };
}

async function main() {
    const fake = makeFakeWebGPU();
    const surfaces = [];
    const presents = [];
    const canvas = {
        width: 1,
        height: 1,
        getContext(name) { assert.equal(name, "webgpu"); return fake.context; },
    };
    const executor = new D3D8WebGPUExecutor(canvas, {
        gpu: fake.gpu,
        onSurface(surface) { surfaces.push(surface); },
        onPresent(surface, stats) { presents.push({ surface, stats }); },
    });

    const deviceHandle = 0x00100002;
    const bufferHandle = 0x00100003;
    const vertices = Buffer.alloc(60);
    const vertexView = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    const values = [
        [320, 60, 0.5, 1, 0xFFFF0000],
        [560, 420, 0.5, 1, 0xFF00FF00],
        [80, 420, 0.5, 1, 0xFF0000FF],
    ];
    values.forEach((vertex, index) => {
        const base = index * 20;
        vertexView.setFloat32(base, vertex[0], true);
        vertexView.setFloat32(base + 4, vertex[1], true);
        vertexView.setFloat32(base + 8, vertex[2], true);
        vertexView.setFloat32(base + 12, vertex[3], true);
        vertexView.setUint32(base + 16, vertex[4], true);
    });

    const createBuffer = Buffer.alloc(32);
    createBuffer.writeUInt32LE(deviceHandle, 0);
    createBuffer.writeUInt32LE(bufferHandle, 4);
    createBuffer.writeUInt32LE(1, 8);
    createBuffer.writeUInt32LE(vertices.length, 12);
    createBuffer.writeUInt32LE(0, 16);
    createBuffer.writeUInt32LE(0x44, 20);
    createBuffer.writeUInt32LE(0, 24);

    const update = Buffer.alloc(16);
    update.writeUInt32LE(bufferHandle, 0);
    update.writeUInt32LE(0, 4);
    update.writeUInt32LE(vertices.length, 8);

    const firstBatch = batch([
        command(OP_HELLO, u32Payload(32, 0)),
        command(OP_CREATE_DEVICE, createDevicePayload(deviceHandle, 640, 480)),
        command(OP_CREATE_BUFFER, createBuffer),
        command(OP_UPDATE_BUFFER, update, vertices),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 22, 1, 0)),
        command(OP_SET_STREAM_SOURCE, u32Payload(deviceHandle, 0, bufferHandle, 20)),
        command(OP_SET_VERTEX_FORMAT, u32Payload(deviceHandle, 0x44)),
        command(OP_CLEAR, u32Payload(deviceHandle, 1, 0xFF000000, 0x3F800000, 0, 0)),
        command(OP_BEGIN_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_DRAW_PRIMITIVE, u32Payload(deviceHandle, 4, 0, 1)),
        command(OP_END_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_PRESENT, u32Payload(deviceHandle, 0)),
    ], 1);

    await executor.submit(firstBatch, { submitCount: 1 });
    assert.equal(executor.failed, null);
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 480);
    assert.equal(surfaces.length, 1);
    assert.equal(presents.length, 1);
    assert.equal(executor.getStats().drawCalls, 1);
    assert.equal(executor.getStats().pipelineCreations, 1);
    assert.equal(executor.getStats().uploadBytes, vertices.length);
    assert.equal(fake.calls.filter(call => call[0] === "submit").length, 1);
    assert.deepEqual(fake.calls.find(call => call[0] === "draw").slice(1),
        [3, 1, 0, 0]);

    const secondBatch = batch([
        command(OP_CLEAR, u32Payload(deviceHandle, 1, 0xFF102030, 0x3F800000, 0, 0)),
        command(OP_BEGIN_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_DRAW_PRIMITIVE, u32Payload(deviceHandle, 4, 0, 1)),
        command(OP_END_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_PRESENT, u32Payload(deviceHandle, 0)),
    ], 2);
    await executor.submit(secondBatch, { submitCount: 2 });
    assert.equal(executor.getStats().pipelineCreations, 1,
        "stable draws must reuse the WebGPU pipeline");
    assert.equal(executor.getStats().presents, 2);
    assert.equal(fake.calls.filter(call => call[0] === "submit").length, 2);

    const bad = Buffer.from(secondBatch);
    bad.writeUInt32LE(bad.length, 20);
    assert.throws(() => executor.executeBatch(bad, {}), /truncated/);

    console.log("d3d8_webgpu_executor_test: ok");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

