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
    result.writeUInt16LE(3, 6);
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
    class FakeTexture {
        constructor(descriptor) { this.descriptor = descriptor; this.destroyed = false; }
        createView(descriptor) {
            const view = { texture: this, descriptor: descriptor || {} };
            calls.push(["createTextureView", view]);
            return view;
        }
        destroy() { this.destroyed = true; calls.push(["destroyTexture"]); }
    }
    class FakePass {
        constructor(descriptor) { this.descriptor = descriptor; this.calls = []; }
        setPipeline(value) { this.calls.push(["setPipeline", value]); }
        setBindGroup(index, value) { this.calls.push(["setBindGroup", index, value]); }
        setVertexBuffer(...args) { this.calls.push(["setVertexBuffer", ...args]); }
        setIndexBuffer(...args) {
            this.calls.push(["setIndexBuffer", ...args]);
            calls.push(["setIndexBuffer", ...args]);
        }
        setScissorRect(...args) { this.calls.push(["setScissorRect", ...args]); calls.push(["setScissorRect", ...args]); }
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
        copyBufferToTexture(...args) {
            calls.push(["copyBufferToTexture", ...args]);
        }
        finish() { calls.push(["finish"]); return { passes: this.passes }; }
    }
    const queue = {
        writeBuffer(buffer, offset, data) {
            calls.push(["writeBuffer", buffer, offset, Buffer.from(
                data.buffer, data.byteOffset, data.byteLength)]);
        },
        writeTexture(...args) { calls.push(["writeTexture", ...args]); },
        submit(commandBuffers) { calls.push(["submit", commandBuffers]); },
    };
    const device = {
        queue,
        lost: new Promise(() => {}),
        createShaderModule(descriptor) { calls.push(["shader", descriptor]); return descriptor; },
        createBuffer(descriptor) { calls.push(["createBuffer", descriptor]); return new FakeBuffer(descriptor); },
        createTexture(descriptor) { calls.push(["createTexture", descriptor]); return new FakeTexture(descriptor); },
        createSampler(descriptor) {
            const sampler = { descriptor };
            calls.push(["createSampler", descriptor]);
            return sampler;
        },
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
    createBuffer.writeUInt32LE(0x200, 16); // D3DUSAGE_DYNAMIC
    createBuffer.writeUInt32LE(0x44, 20);
    createBuffer.writeUInt32LE(0, 24);

    const update = Buffer.alloc(24);
    update.writeUInt32LE(bufferHandle, 0);
    update.writeUInt32LE(0, 4);
    update.writeUInt32LE(vertices.length, 8);
    update.writeUInt32LE(0x2000, 16); // D3DLOCK_DISCARD

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
    const updateIndices = Buffer.alloc(24);
    updateIndices.writeUInt32LE(indexBufferHandle, 0);
    updateIndices.writeUInt32LE(0, 4);
    updateIndices.writeUInt32LE(indices.length, 8);
    const updateColour = Buffer.alloc(24);
    updateColour.writeUInt32LE(bufferHandle, 0);
    updateColour.writeUInt32LE(16, 4);
    updateColour.writeUInt32LE(4, 8);
    updateColour.writeUInt32LE(0x1000, 16); // D3DLOCK_NOOVERWRITE
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
    assert.equal(executor.getStats().bufferOrphans, 1,
        "D3DLOCK_DISCARD must orphan the prior GPU buffer");
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
    const updateIndex32 = Buffer.alloc(24);
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
    assert.equal(executor.getStats().transientBufferCreations, 0,
        "small ordered and DrawUP uploads must reuse the transient ring");
    assert.equal(executor.getStats().transientUploadBytes,
        vertices.length * 2 + 12 + 12 + replacementColour.length);
    assert.equal(executor.getStats().presents, 3);
    assert.equal(fake.calls.filter(call => call[0] === "submit").length, 3);
    assert.equal(executor.devices.get(deviceHandle).streams[0].handle, 0,
        "UP draws must clear stream zero state");
    assert.equal(executor.devices.get(deviceHandle).indices.handle, 0,
        "indexed UP draws must clear index-buffer state");

    const textureHandle = 0x00100006;
    const dxtTextureHandle = 0x00100007;
    const dxt3TextureHandle = 0x00100008;
    const dxt5TextureHandle = 0x00100009;
    const rgbaTexture = Buffer.alloc(4 * 4 * 4);
    for (let pixel = 0; pixel < 16; pixel++) {
        rgbaTexture[pixel * 4] = pixel * 8;
        rgbaTexture[pixel * 4 + 1] = 255 - pixel * 8;
        rgbaTexture[pixel * 4 + 2] = 64 + pixel * 4;
        rgbaTexture[pixel * 4 + 3] = pixel === 0 ? 0 : 255;
    }
    const dxtTexture = Buffer.from([
        0x00, 0xF8, 0xE0, 0x07, 0, 0, 0, 0,
    ]);
    const dxt3Texture = Buffer.from([
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0x00, 0xF8, 0xE0, 0x07, 0, 0, 0, 0,
    ]);
    const dxt5Texture = Buffer.from([
        0xFF, 0x00, 0, 0, 0, 0, 0, 0,
        0x00, 0xF8, 0xE0, 0x07, 0, 0, 0, 0,
    ]);
    const createTexture = u32Payload(deviceHandle, textureHandle,
        4, 4, 1, 21, 0, 1);
    const updateTexture = u32Payload(textureHandle, 0, 0, 0,
        4, 4, 16, rgbaTexture.length, 0, 0);
    const createDXT = u32Payload(deviceHandle, dxtTextureHandle,
        4, 4, 1, 0x31545844, 0, 1);
    const updateDXT = u32Payload(dxtTextureHandle, 0, 0, 0,
        4, 4, 8, dxtTexture.length, 0, 0);
    const createDXT3 = u32Payload(deviceHandle, dxt3TextureHandle,
        4, 4, 1, 0x33545844, 0, 1);
    const updateDXT3 = u32Payload(dxt3TextureHandle, 0, 0, 0,
        4, 4, 16, dxt3Texture.length, 0, 0);
    const createDXT5 = u32Payload(deviceHandle, dxt5TextureHandle,
        4, 4, 1, 0x35545844, 0, 1);
    const updateDXT5 = u32Payload(dxt5TextureHandle, 0, 0, 0,
        4, 4, 16, dxt5Texture.length, 0, 0);
    const conversionCases = [
        { format: 22, source: Buffer.from([3, 2, 1, 0]),
          expected: [1, 2, 3, 255] },
        { format: 23, source: Buffer.from([0x00, 0xF8]),
          expected: [255, 0, 0, 255] },
        { format: 24, source: Buffer.from([0x00, 0x7C]),
          expected: [255, 0, 0, 255] },
        { format: 25, source: Buffer.from([0x00, 0xFC]),
          expected: [255, 0, 0, 255] },
        { format: 26, source: Buffer.from([0x23, 0xF1]),
          expected: [17, 34, 51, 255] },
        { format: 50, source: Buffer.from([128]),
          expected: [128, 128, 128, 255] },
        { format: 28, source: Buffer.from([64]),
          expected: [255, 255, 255, 64] },
    ];
    const conversionCommands = conversionCases.flatMap((item, index) => {
        const handle = 0x0010000A + index;
        return [
            command(OP_CREATE_TEXTURE, u32Payload(deviceHandle, handle,
                1, 1, 1, item.format, 0, 1)),
            commandWithBlobs(OP_UPDATE_TEXTURE, u32Payload(handle, 0, 0, 0,
                1, 1, item.source.length, item.source.length, 0, 0),
                [{ offsetField: 32, data: item.source }]),
        ];
    });

    const texturedVertices = Buffer.alloc(3 * 40);
    const texturedView = new DataView(texturedVertices.buffer,
        texturedVertices.byteOffset, texturedVertices.byteLength);
    [[10, 20, 0, 0], [310, 20, 1, 0], [10, 220, 0, 1]]
        .forEach((vertex, index) => {
            const offset = index * 40;
            texturedView.setFloat32(offset, vertex[0], true);
            texturedView.setFloat32(offset + 4, vertex[1], true);
            texturedView.setFloat32(offset + 8, 0.5, true);
            texturedView.setFloat32(offset + 12, 1, true);
            texturedView.setUint32(offset + 16, 0xFFFFFFFF, true);
            texturedView.setUint32(offset + 20, 0xFF101010, true);
            texturedView.setFloat32(offset + 24, vertex[2], true);
            texturedView.setFloat32(offset + 28, vertex[3], true);
            texturedView.setFloat32(offset + 32, vertex[2] * 2, true);
            texturedView.setFloat32(offset + 36, vertex[3] * 2, true);
        });
    const partialTexture = rgbaTexture.subarray(0, 16);
    const partialUpdate = u32Payload(textureHandle, 0, 0, 0,
        2, 2, 8, partialTexture.length, 0, 0);
    const stage3Batch = batch([
        command(OP_CREATE_TEXTURE, createTexture),
        commandWithBlobs(OP_UPDATE_TEXTURE, updateTexture,
            [{ offsetField: 32, data: rgbaTexture }]),
        command(OP_CREATE_TEXTURE, createDXT),
        commandWithBlobs(OP_UPDATE_TEXTURE, updateDXT,
            [{ offsetField: 32, data: dxtTexture }]),
        command(OP_CREATE_TEXTURE, createDXT3),
        commandWithBlobs(OP_UPDATE_TEXTURE, updateDXT3,
            [{ offsetField: 32, data: dxt3Texture }]),
        command(OP_CREATE_TEXTURE, createDXT5),
        commandWithBlobs(OP_UPDATE_TEXTURE, updateDXT5,
            [{ offsetField: 32, data: dxt5Texture }]),
        ...conversionCommands,
        command(OP_SET_TEXTURE, u32Payload(deviceHandle, 0, textureHandle, 0)),
        command(OP_SET_TEXTURE, u32Payload(deviceHandle, 1, dxtTextureHandle, 0)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 0, 13, 3)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 0, 14, 3)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 0, 16, 2)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 0, 17, 2)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 0, 18, 2)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 1, 1, 4)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 1, 2, 2)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 1, 3, 1)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 1, 4, 2)),
        command(OP_SET_TEXTURE_STAGE_STATE, u32Payload(deviceHandle, 1, 5, 2)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 15, 1, 0)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 24, 1, 0)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 25, 5, 0)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 27, 1, 0)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 19, 5, 0)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 20, 6, 0)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 29, 1, 0)),
        command(OP_SET_VIEWPORT, u32Payload(deviceHandle, 10, 20,
            300, 200, 0, 0x3F800000, 0)),
        command(OP_SET_VERTEX_FORMAT, u32Payload(deviceHandle, 0x2C4)),
        command(OP_CLEAR, u32Payload(deviceHandle, 1, 0xFF000000,
            0x3F800000, 0, 0)),
        commandWithBlobs(OP_DRAW_PRIMITIVE_UP,
            u32Payload(deviceHandle, 4, 1, 40, 3,
                texturedVertices.length, 0, 0),
            [{ offsetField: 24, data: texturedVertices }]),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 24, 128, 0)),
        command(OP_SET_RENDER_STATE, u32Payload(deviceHandle, 60,
            0x80402010, 0)),
        commandWithBlobs(OP_DRAW_PRIMITIVE_UP,
            u32Payload(deviceHandle, 4, 1, 40, 3,
                texturedVertices.length, 0, 0),
            [{ offsetField: 24, data: texturedVertices }]),
        commandWithBlobs(OP_UPDATE_TEXTURE, partialUpdate,
            [{ offsetField: 32, data: partialTexture }]),
        command(OP_PRESENT, surfacePayload(deviceHandle, 33, 44, 800, 600)),
    ], 4);
    await executor.submit(stage3Batch, { submitCount: 4 });
    assert.equal(executor.failed, null);
    assert.equal(executor.getStats().pipelineCreations, 2);
    assert.equal(executor.getStats().drawCalls, 7);
    assert.equal(fake.calls.filter(call => call[0] === "createTexture").length, 12,
        "fallback, uncompressed formats, and DXT1/3/5 must be GPU resources");
    const textureWrites = fake.calls.filter(call => call[0] === "writeTexture");
    for (const write of textureWrites.slice(2, 5)) {
        assert.equal(write[2].byteLength, 64,
            "a 4x4 DXT block must decode to 64 RGBA bytes");
        assert.deepEqual(Array.from(write[2].subarray(0, 4)),
            [255, 0, 0, 255]);
    }
    conversionCases.forEach((item, index) => assert.deepEqual(
        Array.from(textureWrites[5 + index][2].subarray(0, 4)), item.expected,
        "format " + item.format + " conversion drifted"));
    assert.equal(fake.calls.filter(call => call[0] === "copyBufferToTexture").length, 1,
        "mid-frame LockRect uploads must stay ordered in the frame encoder");
    assert.ok(fake.calls.some(call => call[0] === "setScissorRect" &&
        call.slice(1).join(",") === "10,20,300,200"));
    const stage3Pipeline = fake.calls.filter(call => call[0] === "createPipeline")
        .at(-1)[1];
    assert.equal(stage3Pipeline.vertex.buffers[0].attributes.length, 5,
        "XYZRHW/DIFFUSE/SPECULAR/TEX2 must expose five vertex attributes");
    assert.ok(stage3Pipeline.fragment.targets[0].blend,
        "alpha blending must be represented in the WebGPU pipeline");
    assert.match(fake.calls.filter(call => call[0] === "shader").at(-1)[1].code,
        /discard;/, "alpha test must be compiled into the fixed-function shader");

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
        command(OP_SET_VERTEX_FORMAT, u32Payload(deviceHandle, 0x44)),
        command(OP_DRAW_PRIMITIVE_UP, badUpPayload),
    ], 5);
    assert.throws(() => executor.executeBatch(badUpBatch, {}),
        /outside its D8WG batch/);

    const shortIndexed = batch([
        command(OP_DRAW_INDEXED_PRIMITIVE, u32Payload(deviceHandle, 4, 0)),
    ], 6);
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
    ], 7);
    assert.throws(() => executor.executeBatch(staleHandleBatch, {}),
        /unknown index buffer/);

    const destroyDeviceBatch = batch([
        command(OP_DESTROY_RESOURCE, u32Payload(deviceHandle, 0)),
    ], 8);
    executor.executeBatch(destroyDeviceBatch, {});
    assert.equal(executor.devices.has(deviceHandle), false);
    assert.equal(executor.resources.size, 0,
        "destroying a device must release all of its host GPU resources");
    assert.equal(destroys.length, 1);
    assert.equal(destroys[0].reason, "device");
    assert.equal(destroys[0].surface.x, 33);

    console.log("d3d8_webgpu_executor_test: ok");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
