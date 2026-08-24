"use strict";

// The bridge's OpenGL routing.
//
// A bare GL record stream -- no VGL2 envelope, which is how the OpenGL path has
// always framed itself -- must reach gl_executor.js directly,
// and the D3D8/D3D9 envelopes must keep reaching their own executors untouched.
// The reason to test the negative is that all three arrive through one
// v86gl-pci-frame listener, so a routing mistake sends a D3D batch into the GL
// decoder and produces a wall of "no handler" rather than anything legible.

const assert = require("node:assert/strict");

require("../v86_network_bridge.js");

const { GLStream, GL } = require("./gl_stream_builder.js");

const listeners = Object.create(null);
const style = () => ({ setProperty(name, value) { this[name] = value; } });
const screenCanvas = {
    width: 1024, height: 768,
    getBoundingClientRect() { return { left: 0, top: 0, width: 1024, height: 768 }; },
};
const d3dCanvas = { width: 1, height: 1, style: style() };
const canvas = {
    width: 64, height: 64, style: style(),
    parentElement: {
        getElementsByTagName() { return [screenCanvas, canvas, d3dCanvas]; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 1024, height: 768 }; },
    },
};

const glBatches = [];
const d3d9Batches = [];
let glOptions = null;
let presented = 0;
const guestMemory = new Uint8Array(1 << 16);

const bridge = globalThis.installV86GLNetworkBridge({
    add_listener(name, callback) { listeners[name] = callback; },
    write_memory(blob, address) { guestMemory.set(blob, address); },
}, canvas, {
    d3dCanvas,
    glCanvas: d3dCanvas,
    installGLWebGPUExecutor(installedCanvas, options) {
        assert.equal(installedCanvas, d3dCanvas,
            "OpenGL shares the D3D canvas rather than keeping its own");
        glOptions = options;
        return {
            submit(bytes, metadata) {
                glBatches.push({ bytes: Buffer.from(bytes), metadata });
            },
            onSwapBuffers() { ++presented; },
        };
    },
    installD3D9WebGPUExecutor() {
        return {
            submit(bytes, metadata) {
                d3d9Batches.push({ bytes: Buffer.from(bytes), metadata });
            },
        };
    },
});

assert.ok(bridge.glExecutor, "the executor is installed at bridge creation");
assert.ok(glOptions && typeof glOptions.writeGuestMemory === "function",
    "the executor is given a way to answer a readback after the batch returns");

/* ---- a bare GL stream reaches the GL executor ---- */

const stream = new GLStream()
    .makeCurrent(1, 0, 0, 320, 240)
    .call("CLEAR_COLOR", 0.5, 0.25, 0.125, 1)
    .call("CLEAR", GL.COLOR_BUFFER_BIT);
const glBytes = stream.bytes();

listeners["v86gl-pci-frame"]({
    bytes: glBytes, frameId: 1, submitCount: 1, commandCount: 3, flags: 0,
    batchAddr: 0x1000,
});
assert.equal(glBatches.length, 1, "the bare GL stream routed to the executor");
assert.deepEqual(glBatches[0].bytes, Buffer.from(glBytes));
assert.equal(glBatches[0].metadata.batchAddress, 0x1000,
    "the batch's guest address travels with it, for the readback write-back");
assert.equal(presented, 0, "no present flag, no present");

listeners["v86gl-pci-frame"]({
    bytes: glBytes, frameId: 2, submitCount: 2, commandCount: 3, flags: 1,
    batchAddr: 0x1000,
});
assert.equal(glBatches.length, 2);
assert.equal(presented, 1, "the descriptor's present flag swaps buffers");

/* ---- a D3D9 envelope still goes to the D3D9 executor ---- */

const d3d9Batch = Buffer.alloc(8 + 16);
d3d9Batch.writeUInt16LE(0xFFE1, 0);          // V86GL_CTRL_D3D9_BATCH
d3d9Batch.writeUInt16LE(0xFFFF, 2);          // extended record
d3d9Batch.writeUInt32LE(16, 4);              // payload bytes
listeners["v86gl-pci-frame"]({
    bytes: new Uint8Array(d3d9Batch), frameId: 3, submitCount: 3,
    commandCount: 1, flags: 0, descAddr: 0x2000,
});
assert.equal(d3d9Batches.length, 1, "the D3D9 envelope is not swallowed by GL");
assert.equal(glBatches.length, 2, "and it did not also reach the GL executor");

assert.equal("glBackend" in bridge, false,
    "the removed GL4ES fallback cannot be selected at runtime");

console.log("v86_network_bridge_gl_route_test: ok");
