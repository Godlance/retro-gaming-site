#!/usr/bin/env node
// Direct3D 7 COM vtables are positional ABI. Check all 66 slots against the
// SDK declaration, and pin the QueryInterface path that makes them reachable.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

function findHeader(name) {
    let root;
    try {
        root = execSync("i686-w64-mingw32-gcc -print-sysroot",
            { encoding: "utf8" }).trim();
    } catch (error) { return null; }
    const candidate = path.join(root, "i686-w64-mingw32", "include", name);
    return fs.existsSync(candidate) ? candidate : null;
}

const headerPath = process.env.D3D_HEADER || findHeader("d3d.h");
if (!headerPath || !fs.existsSync(headerPath)) {
    console.log("SKIP: no d3d.h (set D3D_HEADER or install mingw-w64)");
    process.exit(0);
}

const header = fs.readFileSync(headerPath, "utf8");
const implementation = fs.readFileSync(path.resolve(__dirname,
    "../ddrawproxy/d3d7_proxy.inc"), "utf8");
const ddrawSource = fs.readFileSync(path.resolve(__dirname,
    "../ddrawproxy/ddraw_proxy.c"), "utf8");

function methods(name) {
    const start = header.indexOf("DECLARE_INTERFACE_(" + name + ",");
    assert.ok(start >= 0, name + " is not declared in d3d.h");
    const end = header.indexOf("\n};", start);
    const result = [];
    for (const match of header.slice(start, end).matchAll(
            /STDMETHOD_?\(\s*(?:[A-Za-z0-9_ *]+,\s*)?([A-Za-z0-9_]+)\s*\)\s*\(\s*THIS/g))
        result.push(match[1]);
    return result;
}

function entries(variable) {
    const match = implementation.match(new RegExp(
        "static [A-Za-z0-9_]+ " + variable + " = \\{([\\s\\S]*?)\\n\\};"));
    assert.ok(match, variable + " has no initializer");
    return match[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",")
        .map(value => value.trim()).filter(Boolean);
}

const vtables = [
    ["g_d3d7_vtbl", "IDirect3D7", "d3d7_"],
    ["g_d3d7_device_vtbl", "IDirect3DDevice7", "d3d7_device_"],
    ["g_d3d7_vb_vtbl", "IDirect3DVertexBuffer7", "d3d7_vb_"],
];
let checked = 0;
for (const [variable, iface, prefix] of vtables) {
    const declared = methods(iface);
    const actual = entries(variable);
    assert.equal(actual.length, declared.length,
        variable + " has " + actual.length + " slots, SDK declares " +
        declared.length);
    for (let slot = 0; slot < declared.length; ++slot) {
        assert.equal(actual[slot], prefix + declared[slot],
            variable + " slot " + slot + " must be " + iface + "::" +
            declared[slot]);
        ++checked;
    }
}

assert.match(ddrawSource,
    /guid_equal\(iid,\s*&IID_IDirect3D7\)[\s\S]*?\*out\s*=\s*&object->d3d7_vtbl/,
    "IDirectDraw7::QueryInterface does not expose the IDirect3D7 view");
assert.ok(ddrawSource.includes("object->d3d7_vtbl = &g_d3d7_vtbl"),
    "created DirectDraw objects do not receive the Direct3D7 vtable");
assert.match(implementation,
    /d3d7_QueryInterface[\s\S]*?return ddraw_QueryInterface\(/,
    "IDirect3D7 does not delegate QI to its canonical DirectDraw identity");
assert.ok(implementation.includes("D9WG_OP_DRAW_PRIMITIVE_UP"));
assert.ok(implementation.includes("D9WG_OP_DRAW_INDEXED_PRIMITIVE_UP"));
assert.ok(implementation.includes("D9WG_OP_SET_RENDER_TARGET"));

console.log(checked + " Direct3D 7 vtable slots match the SDK declaration");
