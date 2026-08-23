"use strict";

// The D3D8 guest frontend speaks D9WG (see d3d8proxy/d3d8_protocol.h for why),
// so what needs guarding is no longer "does d3d8_protocol.h agree with
// d3d8_executor.js" -- that pairing no longer exists. It is the translation
// boundary itself:
//
//   1. every opcode the D3D8 guest emits is one the D3D9 executor decodes,
//   2. every D9WG payload struct it fills exists in d3d9_protocol.h,
//   3. the D3D8 -> D3D9 mapping tables agree with the executor's own D3D9
//      constants, and
//   4. the render states the guest deliberately drops really are ones the
//      executor has no code for.
//
// (1) and (4) are the ones worth having. A guest that emits an opcode the host
// ignores, or drops a state the host would have honoured, produces a wrong
// picture and no error anywhere -- which is precisely the failure mode a
// translation layer invites.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

const guest = read("d3d8proxy/d3d8_proxy.c");
const bridge = read("d3d8proxy/d3d8_protocol.h");
const protocol = read("d3d9proxy/d3d9_protocol.h");
const executor = read("d3d9-webgpu/d3d9_executor.js");

// ---- the guest no longer owns a protocol of its own ----------------------

assert.match(bridge, /#include "\.\.\/d3d9proxy\/d3d9_protocol\.h"/,
    "the D3D8 bridge header must include the D9WG protocol it speaks");
assert.doesNotMatch(guest, /\bV86GL_CTRL_D3D8_BATCH\b/,
    "the D3D8 guest must submit on the D3D9 transport record");
assert.match(guest, /\bV86GL_CTRL_D3D9_BATCH\b/,
    "the D3D8 guest must submit on the D3D9 transport record");
assert.doesNotMatch(guest, /\bD8WG_OP_\w+/,
    "no D8WG opcode may survive in the D3D8 guest");

// ---- (1) every emitted opcode is decoded ---------------------------------

function protocolOpcodes() {
    const block = protocol.match(/enum D9WGOpcode \{([\s\S]*?)\n\};/);
    assert.ok(block, "d3d9_protocol.h must define enum D9WGOpcode");
    const values = new Map();
    for (const line of block[1].split("\n")) {
        const match = line.match(/^\s*(D9WG_OP_\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)/);
        if (match) values.set(match[1], Number.parseInt(match[2], 0));
    }
    return values;
}

const opcodeValues = protocolOpcodes();

// Opcodes named in the executor's dispatch table, resolved through its own
// `const OP_* = <n>` declarations rather than by trusting the names to match.
function executorDecodedOpcodes() {
    const table = executor.match(/this\._handlers = \{([\s\S]*?)\n {12}\};/);
    assert.ok(table, "d3d9_executor.js must build a _handlers dispatch table");
    const constants = new Map();
    for (const match of executor.matchAll(
            /const\s+(OP_\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)/g))
        constants.set(match[1], Number.parseInt(match[2], 0));
    const decoded = new Set();
    for (const match of table[1].matchAll(/\[(OP_\w+)\]/g)) {
        assert.ok(constants.has(match[1]),
            "dispatch table names undeclared " + match[1]);
        decoded.add(constants.get(match[1]));
    }
    return decoded;
}

const decoded = executorDecodedOpcodes();
const emitted = new Set();
for (const match of guest.matchAll(/\b(D9WG_OP_\w+)\b/g)) {
    assert.ok(opcodeValues.has(match[1]),
        "the D3D8 guest emits " + match[1] + ", which d3d9_protocol.h does " +
        "not define");
    emitted.add(match[1]);
}
assert.ok(emitted.size > 20,
    "expected the D3D8 guest to emit a substantial command set, saw " +
    emitted.size);
for (const name of [...emitted].sort()) {
    assert.ok(decoded.has(opcodeValues.get(name)),
        "the D3D8 guest emits " + name + " but d3d9_executor.js does not " +
        "decode it -- the command would be silently dropped");
}

// ---- (2) every payload struct it fills exists ----------------------------

const protocolStructs = new Set(
    [...protocol.matchAll(/typedef struct (D9WG\w+) \{/g)].map(m => m[1])
        .concat([...protocol.matchAll(/typedef D9WG\w+ (D9WG\w+);/g)]
            .map(m => m[1])));
for (const match of guest.matchAll(/\b(D9WG[A-Z]\w+)\b/g)) {
    assert.ok(protocolStructs.has(match[1]),
        "the D3D8 guest names " + match[1] + ", which is not a D9WG struct");
}

// ---- (3) the mapping tables agree with the executor's D3D9 constants -----

function bridgeNumber(name) {
    const match = bridge.match(new RegExp("#define\\s+" + name +
        "\\s+(0x[0-9A-Fa-f]+|\\d+)u?"));
    assert.ok(match, "d3d8_protocol.h must define " + name);
    return Number.parseInt(match[1], 0);
}

function executorNumber(name) {
    const match = executor.match(new RegExp("const\\s+" + name +
        "\\s*=\\s*(0x[0-9A-Fa-f]+|\\d+)"));
    assert.ok(match, "d3d9_executor.js must define " + name);
    return Number.parseInt(match[1], 0);
}

// D3D8 addressed samplers through SetTextureStageState; D3D9 split them out.
// If these drift, filtering and addressing silently land on the wrong state.
for (const [bridgeName, executorName] of [
    ["D3D9SAMP_ADDRESSU", "D3DSAMP_ADDRESSU"],
    ["D3D9SAMP_ADDRESSV", "D3DSAMP_ADDRESSV"],
    ["D3D9SAMP_ADDRESSW", "D3DSAMP_ADDRESSW"],
    ["D3D9SAMP_BORDERCOLOR", "D3DSAMP_BORDERCOLOR"],
    ["D3D9SAMP_MAGFILTER", "D3DSAMP_MAGFILTER"],
    ["D3D9SAMP_MINFILTER", "D3DSAMP_MINFILTER"],
    ["D3D9SAMP_MIPFILTER", "D3DSAMP_MIPFILTER"],
    ["D3D9SAMP_MAXANISOTROPY", "D3DSAMP_MAXANISOTROPY"],
]) {
    assert.equal(bridgeNumber(bridgeName), executorNumber(executorName),
        bridgeName + " must match the executor's " + executorName);
}

assert.equal(bridgeNumber("D3D9RS_DEPTHBIAS"),
    executorNumber("D3DRS_DEPTHBIAS"),
    "D3DRS_ZBIAS is translated to DEPTHBIAS; the target must match");

// The sampler split must be exhaustive in both directions: exactly the ten
// D3D8 stage states that became sampler states, and no others.
const samplerSplit = bridge.match(
    /d3d8_stage_state_to_sampler_state\(unsigned state\)\s*\{([\s\S]*?)\n\}/);
assert.ok(samplerSplit, "d3d8_protocol.h must define the sampler split");
const mappedStageStates = [...samplerSplit[1]
    .matchAll(/case (D3D8TSS_\w+): return (D3D9SAMP_\w+);/g)];
assert.equal(mappedStageStates.length, 10,
    "D3D8 moved exactly ten texture stage states into D3D9 sampler state");
assert.equal(new Set(mappedStageStates.map(m => m[2])).size, 10,
    "each D3D8 stage state must map to a distinct sampler state");

// ---- (4) dropped render states really are unimplemented ------------------

// The executor lists the render states it tracks; a state the guest drops must
// not appear there, or dropping it would be discarding something honoured.
const droppedStates = [...bridge.matchAll(/#define (D3D8RS_\w+) (\d+)u/g)]
    .map(m => ({ name: m[1], value: Number.parseInt(m[2], 10) }));
assert.ok(droppedStates.length >= 8,
    "expected the removed-render-state table to be present");

const dropSwitch = guest.match(
    /static BOOL emit_render_state\(D8Device \*device[\s\S]*?\n\}/);
assert.ok(dropSwitch, "the D3D8 guest must translate render states");
const droppedNames = new Set([...dropSwitch[0]
    .matchAll(/case (D3D8RS_\w+):\s*(?:\/\*[^\n]*\*\/\s*)?\n/g)].map(m => m[1]));
// ZBIAS is translated, not dropped, so it must not be in the fall-through set.
assert.ok(!droppedNames.has("D3D8RS_ZBIAS"),
    "D3DRS_ZBIAS is translated to DEPTHBIAS, not dropped");
assert.ok(droppedNames.size >= 7,
    "expected the deleted-in-D3D9 render states to be dropped explicitly");

const executorRenderStates = new Set(
    [...executor.matchAll(/const\s+(D3DRS_\w+)\s*=\s*(\d+)/g)]
        .map(m => Number.parseInt(m[2], 10)));
for (const name of droppedNames) {
    const entry = droppedStates.find(item => item.name === name);
    assert.ok(entry, name + " is dropped but not declared in d3d8_protocol.h");
    assert.ok(!executorRenderStates.has(entry.value),
        name + " (" + entry.value + ") is dropped by the D3D8 guest but the " +
        "executor tracks that render state number -- dropping it discards " +
        "behaviour the host implements");
}

console.log("d3d8_protocol_consistency_test: ok (" + emitted.size +
    " opcodes emitted, all decoded)");
