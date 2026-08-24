#!/usr/bin/env node
// Direct3D 1-6 uses twelve positional COM vtables. Pin every slot to the SDK
// declaration and verify that QI/create paths initialize every interface view.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

function findHeader() {
    try {
        const root = execSync("i686-w64-mingw32-gcc -print-sysroot",
            { encoding: "utf8" }).trim();
        const candidate = path.join(root, "i686-w64-mingw32", "include",
            "d3d.h");
        return fs.existsSync(candidate) ? candidate : null;
    } catch (error) { return null; }
}

const headerPath = process.env.D3D_HEADER || findHeader();
if (!headerPath || !fs.existsSync(headerPath)) {
    console.log("SKIP: no d3d.h (set D3D_HEADER or install mingw-w64)");
    process.exit(0);
}

const header = fs.readFileSync(headerPath, "utf8");
const source = fs.readFileSync(path.resolve(__dirname,
    "../ddrawproxy/d3d_legacy_proxy.inc"), "utf8");
const ddraw = fs.readFileSync(path.resolve(__dirname,
    "../ddrawproxy/ddraw_proxy.c"), "utf8");

function methods(name) {
    const start = header.indexOf("DECLARE_INTERFACE_(" + name + ",");
    assert.ok(start >= 0, name + " missing from d3d.h");
    const end = header.indexOf("\n};", start);
    return [...header.slice(start, end).matchAll(
        /STDMETHOD_?\(\s*(?:[A-Za-z0-9_ *]+,\s*)?([A-Za-z0-9_]+)\s*\)\s*\(\s*THIS/g
    )].map(match => match[1]);
}

function entries(variable) {
    const match = source.match(new RegExp(
        "static [A-Za-z0-9_]+ " + variable + " = \\{([\\s\\S]*?)\\n\\};"));
    assert.ok(match, variable + " has no initializer");
    return match[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",")
        .map(value => value.trim()).filter(Boolean);
}

const tables = [
    ["g_d3d3_vtbl", "IDirect3D3", "d3d3_"],
    ["g_d3d2_vtbl", "IDirect3D2", "d3d2_"],
    ["g_d3d1_vtbl", "IDirect3D", "d3d1_"],
    ["g_d3d3_device_vtbl", "IDirect3DDevice3", "d3d3_device_"],
    ["g_d3d2_device_vtbl", "IDirect3DDevice2", "d3d2_device_"],
    ["g_d3d1_device_vtbl", "IDirect3DDevice", "d3d1_device_"],
    ["g_d3d_vb_vtbl", "IDirect3DVertexBuffer", "d3d_vb_"],
    ["g_d3d_texture2_vtbl", "IDirect3DTexture2", "d3d_texture2_"],
    ["g_d3d_texture1_vtbl", "IDirect3DTexture", "d3d_texture1_"],
    ["g_d3d_material3_vtbl", "IDirect3DMaterial3", "d3d_material_"],
    ["g_d3d_material2_vtbl", "IDirect3DMaterial2", "d3d_material2_"],
    ["g_d3d_material1_vtbl", "IDirect3DMaterial", "d3d_material1_"],
    ["g_d3d_light_vtbl", "IDirect3DLight", "d3d_light_"],
    ["g_d3d_viewport3_vtbl", "IDirect3DViewport3", "d3d_viewport_"],
    ["g_d3d_viewport2_vtbl", "IDirect3DViewport2", "d3d_viewport2_"],
    ["g_d3d_viewport1_vtbl", "IDirect3DViewport", "d3d_viewport1_"],
    ["g_d3d_execute_buffer_vtbl", "IDirect3DExecuteBuffer",
        "d3d_execute_buffer_"],
];

let checked = 0;
for (const [variable, iface, prefix] of tables) {
    const declared = methods(iface);
    const actual = entries(variable);
    assert.equal(actual.length, declared.length,
        `${variable}: ${actual.length} slots, SDK declares ${declared.length}`);
    for (let slot = 0; slot < declared.length; ++slot) {
        let expected = prefix + declared[slot];
        if (variable === "g_d3d_material3_vtbl" &&
                declared[slot] === "GetHandle")
            expected = "d3d_material3_GetHandle";
        assert.equal(actual[slot], expected,
            `${variable} slot ${slot} must be ${iface}::${declared[slot]}`);
        ++checked;
    }
}

for (const iid of ["IID_IDirect3D3", "IID_IDirect3D2", "IID_IDirect3D"])
    assert.ok(ddraw.includes("guid_equal(iid, &" + iid + ")"),
        "DirectDraw QI does not expose " + iid);
for (const assignment of ["object->d3d3_vtbl = &g_d3d3_vtbl",
        "object->d3d2_vtbl = &g_d3d2_vtbl",
        "object->d3d1_vtbl = &g_d3d1_vtbl",
        "surface->texture2_vtbl = &g_d3d_texture2_vtbl",
        "surface->texture1_vtbl = &g_d3d_texture1_vtbl"])
    assert.ok(ddraw.includes(assignment), "missing object initialization: " + assignment);

for (const opcode of ["D3DOP_POINT", "D3DOP_LINE", "D3DOP_TRIANGLE",
        "D3DOP_MATRIXLOAD", "D3DOP_MATRIXMULTIPLY", "D3DOP_STATETRANSFORM",
        "D3DOP_STATELIGHT", "D3DOP_STATERENDER", "D3DOP_PROCESSVERTICES",
        "D3DOP_TEXTURELOAD", "D3DOP_EXIT", "D3DOP_BRANCHFORWARD",
        "D3DOP_SPAN", "D3DOP_SETSTATUS"])
    assert.ok(source.includes("case " + opcode + ":"),
        "execute-buffer interpreter omits " + opcode);

console.log(`${checked} Direct3D 1-6 vtable slots match the SDK declaration`);
