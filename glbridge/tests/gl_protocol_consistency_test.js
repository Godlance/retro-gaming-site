#!/usr/bin/env node
// Checks the host's view of the OpenGL wire format against the guest that
// produces it.
//
// gl_wire.js and gl_constants.js are generated from openglproxy/opengl32_proxy.c,
// and a single wrong field decodes every later argument at the wrong offset --
// with a symptom that looks like anything at all. Regenerating is cheap;
// noticing that someone edited the guest and not the table is what this file
// is for.

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const wire = require("../gl-webgpu/gl_wire.js");
const constants = require("../gl-webgpu/gl_constants.js");

const proxyPath = path.join(__dirname, "..", "openglproxy", "opengl32_proxy.c");
const source = fs.readFileSync(proxyPath, "utf8");

let passed = 0;
const failures = [];
function test(name, fn) {
    try { fn(); ++passed; } catch (error) { failures.push([name, error]); }
}

test("every guest opcode has the same number in gl_constants.js", () => {
    const block = /enum \{\s*\n(\s*GLFN_VIEWPORT[\s\S]*?)\n\};/.exec(source);
    assert.ok(block, "the GLFN enum is still where the generator expects it");
    const entries = [...block[1].matchAll(/(GLFN_[A-Z0-9_]+)\s*=\s*(\d+)/g)];
    assert.strictEqual(entries.length, 217,
        "the guest exports 217 opcodes; a new one needs the table regenerated");
    for (const [, name, value] of entries) {
        const key = name.slice(5);
        assert.strictEqual(constants.GLFN[key], parseInt(value, 10),
            name + " disagrees with the guest");
    }
    assert.strictEqual(Object.keys(constants.GLFN).length, entries.length,
        "the table has an opcode the guest does not");
});

test("the control record codes match the guest", () => {
    for (const [name, value] of [["MAKE_CURRENT", 0xFFF0],
            ["RELEASE_CURRENT", 0xFFF1], ["DESTROY_CONTEXT", 0xFFF2]]) {
        assert.strictEqual(constants.CTRL[name], value);
        assert.ok(source.indexOf("V86GL_CTRL_" + name + " 0x" +
            value.toString(16).toUpperCase() + "u") >= 0,
            "the guest still defines V86GL_CTRL_" + name);
    }
});

test("every GL enum the host adds agrees with the guest where both define it", () => {
    assert.deepStrictEqual(constants.GL_CONFLICTS, [],
        "a registry value disagrees with the guest's own #define");
});

test("GL enum values match the guest's #define", () => {
    const defines = [...source.matchAll(
        /^#define\s+(GL_[A-Z0-9_]+)\s+(0x[0-9A-Fa-f]+|\d+)\s*$/gm)];
    assert.ok(defines.length > 500, "the guest still defines the GL enums");
    for (const [, name, value] of defines) {
        const key = name.slice(3);
        const expected = value.startsWith("0x") ?
            parseInt(value, 16) : parseInt(value, 10);
        if (constants.GL[key] === undefined) continue;   // not all are needed
        assert.strictEqual(constants.GL[key], expected, name);
    }
});

test("every declarative signature is a contiguous argument list", () => {
    for (const [name, [glName, types]] of Object.entries(wire.SIGNATURES)) {
        assert.ok(/^[iufd]*$/.test(types),
            name + " has an unknown argument code: " + types);
        assert.ok(glName.length, name + " has no GL name");
        assert.strictEqual(wire.payloadBytes(types),
            [...types].reduce((n, t) => n + (t === "d" ? 8 : 4), 0));
    }
});

test("decodeArgs refuses a payload that is one byte short", () => {
    const types = "iiii";
    const buffer = new Uint8Array(15);
    const view = new DataView(buffer.buffer);
    const out = new Float64Array(8);
    assert.strictEqual(wire.decodeArgs(types, view, 0, 15, out), -1);
    const full = new Uint8Array(16);
    assert.strictEqual(
        wire.decodeArgs(types, new DataView(full.buffer), 0, 16, out), 4);
});

test("the response region matches the D9WG layout the D3D path uses", () => {
    const executor = require("../gl-webgpu/gl_executor.js");
    // Both paths carve the same tail out of v86gl.sys's arena so that guest
    // memory looks the same whichever DLL is loaded (plan 6.2).
    assert.strictEqual(executor.GLWG_RESPONSE_REGION_BYTES, 4 * 1024 * 1024);
    assert.strictEqual(executor.GLWG_QUERY_REGION_BYTES, 16 * 1024);
    assert.strictEqual(executor.GLWG_READBACK_REGION_OFFSET, 16 * 1024);
    assert.strictEqual(executor.GLWG_HEARTBEAT_OFFSET,
        executor.GLWG_RESPONSE_REGION_BYTES - 16);
    const protocol = fs.readFileSync(
        path.join(__dirname, "..", "d3d9proxy", "d3d9_protocol.h"), "utf8");
    assert.ok(protocol.indexOf("D9WG_RESPONSE_REGION_BYTES (4u * 1024u * 1024u)") >= 0,
        "the D3D9 path still reserves the same four MiB");
});

test("the executor has a handler for every opcode it claims to implement", () => {
    const executor = require("../gl-webgpu/gl_executor.js");
    const table = executor.buildHandlerTable();
    // buildHandlerTable() alone covers the state opcodes; the installers add
    // the rest, and the executor's constructor calls all of them.
    const { createFakeHost } = require("./gl_fake_gpu.js");
    const { host } = createFakeHost();
    const live = new executor.GLWebGPUExecutor(null, { host });
    let implemented = 0;
    const missing = [];
    for (const [name, opcode] of Object.entries(constants.GLFN)) {
        if (live.handlers[opcode]) ++implemented;
        else missing.push(name);
    }
    void table;
    assert.deepStrictEqual(missing, [],
        "every opcode the guest can send needs a handler or an explicit refusal");
    assert.strictEqual(implemented, 217);
});

for (const [name, error] of failures)
    console.error("FAIL: " + name + "\n    " + (error && error.message));
console.log(passed + " passed, " + failures.length + " failed");
process.exit(failures.length ? 1 : 0);
