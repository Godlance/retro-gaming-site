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
const OP_UPDATE_SURFACE = 8;
const OP_CREATE_BUFFER = 0x100;
const OP_UPDATE_BUFFER = 0x101;
const OP_DESTROY_RESOURCE = 0x103;
const OP_SET_RENDER_STATE = 0x200;
const OP_SET_STREAM_SOURCE = 0x208;
const OP_SET_INDICES = 0x209;
const OP_SET_VERTEX_FORMAT = 0x20A;
const OP_DRAW_PRIMITIVE = 0x300;
const OP_DRAW_INDEXED_PRIMITIVE = 0x301;
const OP_DRAW_PRIMITIVE_UP = 0x302;
const OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303;

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

function surfacePayload(deviceHandle, x, y, width, height) {
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(deviceHandle, 0);
    payload.writeUInt32LE(0x1234, 4);
    payload.writeInt32LE(x, 8);
    payload.writeInt32LE(y, 12);
    payload.writeUInt32LE(width, 16);
    payload.writeUInt32LE(height, 20);
    return payload;
}

function batch(commandSpecs, frameId) {
    let commandBytes = 0;
    for (const spec of commandSpecs) {
        const blobBytes = (spec.blobs || []).reduce(
            (total, blob) => total + blob.data.length, 0);
        spec.size = (16 + spec.payload.length +
            (spec.blob ? spec.blob.length : 0) + blobBytes + 7) & ~7;
        spec.offset = 32 + commandBytes;
        commandBytes += spec.size;
    }
    const result = Buffer.alloc(32 + commandBytes);
    result.writeUInt32LE(D8WG_MAGIC, 0);
    result.writeUInt16LE(1, 4);
    result.writeUInt16LE(2, 6);
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
        let blobOffset = offset + 16 + spec.payload.length +
            (spec.blob ? spec.blob.length : 0);
        for (const blob of spec.blobs || []) {
            result.writeUInt32LE(blobOffset,
                offset + 16 + blob.offsetField);
            blob.data.copy(result, blobOffset);
            blobOffset += blob.data.length;
        }
    }
    return result;
}

function command(opcode, payload, blob) {
    return { opcode, payload, blob };
}

function commandWithBlobs(opcode, payload, blobs) {
    return { opcode, payload, blobs };
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
        setIndexBuffer(value, format) {
            this.calls.push(["setIndexBuffer", value, format]);
            calls.push(["setIndexBuffer", value, format]);
        }
        draw(...args) { this.calls.push(["draw", ...args]); calls.push(["draw", ...args]); }
        drawIndexed(...args) {
            this.calls.push(["drawIndexed", ...args]);
            calls.push(["drawIndexed", ...args]);
        }
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
        copyBufferToBuffer(...args) {
            calls.push(["copyBufferToBuffer", ...args]);
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
    const destroys = [];
    const canvas = {
        width: 1,
        height: 1,
        getContext(name) { assert.equal(name, "webgpu"); return fake.context; },
    };
    const executor = new D3D8WebGPUExecutor(canvas, {
        gpu: fake.gpu,
        onSurface(surface, reason) { surfaces.push({ surface, reason }); },
        onPresent(surface, stats) { presents.push({ surface, stats }); },
        onDestroy(surface, reason) { destroys.push({ surface, reason }); },
    });

    const deviceHandle = 0x00100002;
    const bufferHandle = 0x00100003;
    const indexBufferHandle = 0x00100004;
    const vertices = Buffer.alloc(80);
    const vertexView = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    const values = [
        [320, 60, 0.5, 1, 0xFFFF0000],
        [560, 420, 0.5, 1, 0xFF00FF00],
        [80, 420, 0.5, 1, 0xFF0000FF],
        [80, 60, 0.5, 1, 0xFFFFFF00],
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

    const indices = Buffer.alloc(12);
    [0, 1, 2, 0, 2, 3].forEach((value, index) =>
        indices.writeUInt16LE(value, index * 2));
    const createIndexBuffer = Buffer.alloc(32);
    createIndexBuffer.writeUInt32LE(deviceHandle, 0);
    createIndexBuffer.writeUInt32LE(indexBufferHandle, 4);
    createIndexBuffer.writeUInt32LE(2, 8);
    createIndexBuffer.writeUInt32LE(indices.length, 12);
    createIndexBuffer.writeUInt32LE(0, 16);
    createIndexBuffer.writeUInt32LE(101, 20);
    createIndexBuffer.writeUInt32LE(0, 24);
    const updateIndices = Buffer.alloc(16);
    updateIndices.writeUInt32LE(indexBufferHandle, 0);
    updateIndices.writeUInt32LE(0, 4);
    updateIndices.writeUInt32LE(indices.length, 8);
    const updateColour = Buffer.alloc(16);
    updateColour.writeUInt32LE(bufferHandle, 0);
    updateColour.writeUInt32LE(16, 4);
    updateColour.writeUInt32LE(4, 8);
    const replacementColour = Buffer.alloc(4);
    replacementColour.writeUInt32LE(0xFFFFFFFF, 0);

    const firstBatch = batch([
        command(OP_HELLO, u32Payload(32, 0)),
        command(OP_CREATE_DEVICE, createDevicePayload(deviceHandle, 640, 480)),
        command(OP_CREATE_BUFFER, createBuffer),
        command(OP_UPDATE_BUFFER, update, vertices),
        command(OP_CREATE_BUFFER, createIndexBuffer),
        command(OP_UPDATE_BUFFER, updateIndices, indices),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 22, 1, 0)),
        command(OP_SET_STREAM_SOURCE, u32Payload(deviceHandle, 0, bufferHandle, 20)),
        command(OP_SET_INDICES, u32Payload(deviceHandle, indexBufferHandle, 0, 0)),
        command(OP_SET_VERTEX_FORMAT, u32Payload(deviceHandle, 0x44)),
        command(OP_CLEAR, u32Payload(deviceHandle, 1, 0xFF000000, 0x3F800000, 0, 0)),
        command(OP_BEGIN_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_DRAW_PRIMITIVE, u32Payload(deviceHandle, 4, 0, 1)),
        command(OP_UPDATE_BUFFER, updateColour, replacementColour),
        command(OP_DRAW_INDEXED_PRIMITIVE,
            u32Payload(deviceHandle, 4, 0, 4, 0, 2)),
        command(OP_END_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_PRESENT, surfacePayload(deviceHandle, 11, 22, 640, 480)),
    ], 1);

    await executor.submit(firstBatch, { submitCount: 1 });
    assert.equal(executor.failed, null);
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 480);
    assert.equal(surfaces.length, 1);
    assert.equal(presents.length, 1);
    assert.equal(executor.getStats().drawCalls, 2);
    assert.equal(executor.getStats().indexedDrawCalls, 1);
    assert.equal(executor.getStats().pipelineCreations, 1);
    assert.equal(executor.getStats().uploadBytes,
        vertices.length + indices.length + replacementColour.length);
    assert.equal(fake.calls.filter(call => call[0] === "submit").length, 1);
    assert.deepEqual(fake.calls.find(call => call[0] === "draw").slice(1),
        [3, 1, 0, 0]);
    assert.deepEqual(fake.calls.find(call => call[0] === "drawIndexed").slice(1),
        [6, 1, 0, 0, 0]);
    assert.equal(fake.calls.filter(call =>
        call[0] === "copyBufferToBuffer").length, 1,
    "mid-frame updates must preserve draw/upload ordering in one encoder");

    const index32Handle = 0x00100005;
    const indices32 = Buffer.alloc(24);
    [0, 0, 0, 0, 1, 2].forEach((value, index) =>
        indices32.writeUInt32LE(value, index * 4));
    const createIndex32 = Buffer.alloc(32);
    createIndex32.writeUInt32LE(deviceHandle, 0);
    createIndex32.writeUInt32LE(index32Handle, 4);
    createIndex32.writeUInt32LE(2, 8);
    createIndex32.writeUInt32LE(indices32.length, 12);
    createIndex32.writeUInt32LE(0, 16);
    createIndex32.writeUInt32LE(102, 20);
    const updateIndex32 = Buffer.alloc(16);
    updateIndex32.writeUInt32LE(index32Handle, 0);
    updateIndex32.writeUInt32LE(indices32.length, 8);
    const secondBatch = batch([
        command(OP_CREATE_BUFFER, createIndex32),
        command(OP_UPDATE_BUFFER, updateIndex32, indices32),
        command(OP_UPDATE_SURFACE,
            surfacePayload(deviceHandle, 33, 44, 800, 600)),
        command(OP_CLEAR, u32Payload(deviceHandle, 1, 0xFF102030, 0x3F800000, 0, 0)),
        command(OP_BEGIN_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_SET_INDICES, u32Payload(deviceHandle, index32Handle, 1, 0)),
        command(OP_DRAW_INDEXED_PRIMITIVE,
            u32Payload(deviceHandle, 4, 0, 3, 3, 1)),
        command(OP_END_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_PRESENT, surfacePayload(deviceHandle, 33, 44, 800, 600)),
    ], 2);
    await executor.submit(secondBatch, { submitCount: 2 });
    assert.equal(executor.getStats().pipelineCreations, 1,
        "stable draws must reuse the WebGPU pipeline");
    assert.equal(executor.getStats().presents, 2);
    assert.equal(fake.calls.filter(call => call[0] === "submit").length, 2);
    assert.deepEqual(fake.calls.filter(call => call[0] === "drawIndexed")[1]
        .slice(1), [3, 1, 3, 1, 0]);
    assert.ok(fake.calls.some(call => call[0] === "setIndexBuffer" &&
        call[2] === "uint32"), "INDEX32 must bind with WebGPU uint32 format");
    assert.equal(surfaces.length, 2,
        "an unchanged Present must not emit a duplicate surface callback");
    assert.equal(surfaces[1].reason, "move");
    assert.equal(surfaces[1].surface.x, 33);
    assert.equal(surfaces[1].surface.y, 44);
    assert.equal(surfaces[1].surface.displayWidth, 800);
    assert.equal(surfaces[1].surface.displayHeight, 600);
    assert.equal(executor.devices.get(deviceHandle).surface.width, 640,
        "window resizing must not change the D3D backbuffer dimensions");
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 480);

    const upPayload = u32Payload(deviceHandle, 6, 2, 20, 4,
        vertices.length, 0, 0);
    const indexedFan = Buffer.alloc(8);
    [0, 1, 2, 3].forEach((value, index) =>
        indexedFan.writeUInt16LE(value, index * 2));
    const indexedUpPayload = u32Payload(deviceHandle, 6, 0, 4, 2,
        101, 20, 4, indexedFan.length, vertices.length, 0, 0);
    const upBatch = batch([
        command(OP_CLEAR, u32Payload(deviceHandle, 1, 0xFF000000,
            0x3F800000, 0, 0)),
        command(OP_BEGIN_SCENE, u32Payload(deviceHandle, 0)),
        commandWithBlobs(OP_DRAW_PRIMITIVE_UP, upPayload,
            [{ offsetField: 24, data: vertices }]),
        commandWithBlobs(OP_DRAW_INDEXED_PRIMITIVE_UP, indexedUpPayload, [
            { offsetField: 40, data: indexedFan },
            { offsetField: 44, data: vertices },
        ]),
        command(OP_END_SCENE, u32Payload(deviceHandle, 0)),
        command(OP_PRESENT, surfacePayload(deviceHandle, 33, 44, 800, 600)),
    ], 3);
    await executor.submit(upBatch, { submitCount: 3 });
    assert.equal(executor.failed, null);
    assert.equal(executor.getStats().drawCalls, 5);
    assert.equal(executor.getStats().indexedDrawCalls, 3);
    assert.equal(executor.getStats().upDrawCalls, 2);
    assert.equal(executor.getStats().fanConversions, 2);
    assert.equal(executor.getStats().transientBufferCreations, 5);
    assert.equal(executor.getStats().transientUploadBytes,
        vertices.length * 2 + 12 + 12 + replacementColour.length);
    assert.equal(executor.getStats().presents, 3);
    assert.equal(fake.calls.filter(call => call[0] === "submit").length, 3);
    assert.equal(executor.devices.get(deviceHandle).streams[0].handle, 0,
        "UP draws must clear stream zero state");
    assert.equal(executor.devices.get(deviceHandle).indices.handle, 0,
        "indexed UP draws must clear index-buffer state");

    const bad = Buffer.from(secondBatch);
    bad.writeUInt32LE(bad.length, 20);
    assert.throws(() => executor.executeBatch(bad, {}), /truncated/);

    const wrongMinor = Buffer.from(secondBatch);
    wrongMinor.writeUInt16LE(0, 6);
    assert.throws(() => executor.executeBatch(wrongMinor, {}),
        /unsupported D8WG minor version/);

    const badUpPayload = u32Payload(deviceHandle, 4, 1, 20, 3, 60,
        0xFFFFFFF0, 0);
    const badUpBatch = batch([
        command(OP_DRAW_PRIMITIVE_UP, badUpPayload),
    ], 4);
    assert.throws(() => executor.executeBatch(badUpBatch, {}),
        /outside its D8WG batch/);

    const shortIndexed = batch([
        command(OP_DRAW_INDEXED_PRIMITIVE, u32Payload(deviceHandle, 4, 0)),
    ], 5);
    assert.throws(() => executor.executeBatch(shortIndexed, {}),
        /short DRAW_INDEXED_PRIMITIVE/);

    const staleHandleBatch = batch([
        command(OP_DESTROY_RESOURCE, u32Payload(index32Handle, 2)),
        command(OP_SET_STREAM_SOURCE,
            u32Payload(deviceHandle, 0, bufferHandle, 20)),
        command(OP_SET_INDICES,
            u32Payload(deviceHandle, index32Handle, 0, 0)),
        command(OP_DRAW_INDEXED_PRIMITIVE,
            u32Payload(deviceHandle, 4, 0, 3, 0, 1)),
    ], 6);
    assert.throws(() => executor.executeBatch(staleHandleBatch, {}),
        /unknown index buffer/);

    const destroyDeviceBatch = batch([
        command(OP_DESTROY_RESOURCE, u32Payload(deviceHandle, 0)),
    ], 7);
    executor.executeBatch(destroyDeviceBatch, {});
    assert.equal(executor.devices.has(deviceHandle), false);
    assert.equal(destroys.length, 1);
    assert.equal(destroys[0].reason, "device");
    assert.equal(destroys[0].surface.x, 33);

    console.log("d3d8_webgpu_executor_test: ok");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
