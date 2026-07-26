"use strict";

const assert = require("node:assert/strict");

const originalInfo = console.info;
const originalError = console.error;
const originalWarn = console.warn;
const infoLogs = [];
const errorLogs = [];
const warnLogs = [];
console.info = (...args) => infoLogs.push(args);
console.error = (...args) => errorLogs.push(args);
console.warn = (...args) => warnLogs.push(args);

require("../v86_network_bridge.js");

const V86GL_CTRL_TEST_TRACE = 0xFFF3;
const TRACE_CALLING = 1;
const TRACE_FAIL = 4;
const TRACE_TEXT = 5;

function tracePayload(phase, hr, text) {
    const bytes = Buffer.from(text, "utf8");
    const payload = Buffer.alloc(12 + bytes.length);
    payload.writeUInt32LE(phase, 0);
    payload.writeUInt32LE(hr >>> 0, 4);
    payload.writeUInt32LE(bytes.length, 8);
    bytes.copy(payload, 12);
    return payload;
}

function glRecord(fn, payload) {
    const record = Buffer.alloc(4 + payload.length);
    record.writeUInt16LE(fn, 0);
    record.writeUInt16LE(payload.length, 2);
    payload.copy(record, 4);
    return record;
}

try {
    const listeners = Object.create(null);
    const callbackTraces = [];
    const canvas = {
        width: 64,
        height: 64,
        style: {},
        parentElement: { getElementsByTagName() { return [canvas]; } },
    };
    const moduleObject = {
        HEAPU8: new Uint8Array(4096),
        _malloc() { return 256; },
        _free() {},
        _v86glResize() {},
    };
    const bridge = globalThis.installV86GLNetworkBridge({
        add_listener(name, callback) { listeners[name] = callback; },
    }, canvas, {
        gl4es: moduleObject,
        onGuestTestTrace(trace) { callbackTraces.push(trace); },
    });

    const hello = glRecord(V86GL_CTRL_TEST_TRACE,
        tracePayload(TRACE_TEXT, 0, "opengl32 proxy trace-v3-20260722"));
    const calling = glRecord(V86GL_CTRL_TEST_TRACE,
        tracePayload(TRACE_CALLING, 0, "20 DrawPrimitive"));
    const failed = glRecord(V86GL_CTRL_TEST_TRACE,
        tracePayload(TRACE_FAIL, 0x8876086C, "DrawPrimitive"));
    const batch = Buffer.concat([hello, calling, failed]);
    listeners["v86gl-pci-frame"]({
        bytes: batch,
        frameId: 7,
        submitCount: 2,
        commandCount: 3,
        flags: 0,
    });

    assert.equal(bridge.guestTestTraceHistory.length, 3);
    assert.equal(callbackTraces.length, 3);
    assert.equal(bridge.guestTestTraceHistory[0].phaseName, "TEXT");
    assert.equal(bridge.guestTestTraceHistory[0].text,
        "opengl32 proxy trace-v3-20260722");
    assert.deepEqual(bridge.guestTestTraceHistory[1], {
        phase: TRACE_CALLING,
        phaseName: "CALLING",
        hr: 0,
        hrSigned: 0,
        hrHex: "0x00000000",
        text: "20 DrawPrimitive",
        source: "pci frame=7 submit=2",
        frameId: 7,
    });
    assert.equal(bridge.lastGuestTestTrace.phaseName, "FAIL");
    assert.equal(bridge.lastGuestTestTrace.hr, 0x8876086C);
    assert.equal(bridge.lastGuestTestTrace.hrHex, "0x8876086C");
    assert.equal(bridge.lastGuestTestTrace.text, "DrawPrimitive");
    assert.ok(infoLogs.some(args => String(args[0]).includes(
        "[v86gl:guest-test] CALLING 0x00000000 20 DrawPrimitive")));
    assert.ok(errorLogs.some(args => String(args[0]).includes(
        "[v86gl:guest-test] FAIL 0x8876086C DrawPrimitive")));

    const previous = bridge.lastGuestTestTrace;
    const malformed = tracePayload(TRACE_CALLING, 0, "bad");
    malformed.writeUInt32LE(100, 8);
    listeners["v86gl-pci-frame"]({
        bytes: glRecord(V86GL_CTRL_TEST_TRACE, malformed),
        frameId: 8,
        submitCount: 3,
        commandCount: 1,
        flags: 0,
    });
    assert.equal(bridge.lastGuestTestTrace, previous,
        "a malformed checkpoint must not replace the last valid trace");
    assert.ok(warnLogs.some(args => String(args[0]).includes(
        "[v86gl:guest-test] truncated checkpoint text")));

    originalInfo("v86_network_bridge_guest_trace_test: ok");
} finally {
    console.info = originalInfo;
    console.error = originalError;
    console.warn = originalWarn;
}
