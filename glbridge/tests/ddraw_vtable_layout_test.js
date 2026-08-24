#!/usr/bin/env node
// Checks every COM vtable in ddraw_proxy.c against the method order the SDK
// header declares.
//
// A vtable is positional: slot 12 is whatever the header says slot 12 is, and
// the compiler cannot check it, because every entry has the same shape. Put
// `GetCaps` where `GetClipper` belongs and the DLL builds cleanly, loads
// cleanly, and then a game calls GetClipper and lands in GetCaps with a
// LPDIRECTDRAWCLIPPER* where a LPDDSCAPS2* should be. That is a crash with no
// explanation anywhere near the mistake, inside a VM, which is the worst place
// this project has to debug.
//
// Five interface versions times ~40 slots is 200 chances to make it, and this
// is the only check that exists. Needs the mingw headers; skipped without them.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

function findDDrawHeader() {
    const fromEnv = process.env.DDRAW_HEADER;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    let root;
    try {
        root = execSync("i686-w64-mingw32-gcc -print-sysroot", { encoding: "utf8" }).trim();
    } catch (error) { return null; }
    const candidate = path.join(root, "i686-w64-mingw32", "include", "ddraw.h");
    return fs.existsSync(candidate) ? candidate : null;
}

const headerPath = findDDrawHeader();
if (!headerPath) {
    console.log("SKIP: no ddraw.h (set DDRAW_HEADER or install mingw-w64)");
    process.exit(0);
}

const header = fs.readFileSync(headerPath, "utf8");
const source = fs.readFileSync(
    path.resolve(__dirname, "../ddrawproxy/ddraw_proxy.c"), "utf8");

// The methods an interface declares, in slot order.
function declaredMethods(name) {
    const start = header.indexOf("DECLARE_INTERFACE_(" + name + ",");
    assert.ok(start >= 0, name + " is not declared in ddraw.h");
    const end = header.indexOf("\n};", start);
    const body = header.slice(start, end);
    const methods = [];
    // Both spellings: STDMETHOD(Name) and STDMETHOD_(ReturnType,Name), the
    // second of which is how the three IUnknown slots are written.
    for (const match of body.matchAll(
            /STDMETHOD_?\(\s*(?:[A-Za-z0-9_ *]+,\s*)?([A-Za-z0-9_]+)\s*\)\s*\(\s*THIS/g))
        methods.push(match[1]);
    return methods;
}

// The initializer of one vtable object, in slot order.
function initialiserEntries(variable) {
    const match = source.match(
        new RegExp("static [A-Za-z0-9_]+ " + variable + " = \\{([\\s\\S]*?)\\n\\};"));
    assert.ok(match, variable + " has no initialiser in ddraw_proxy.c");
    return match[1]
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

const vtables = [
    { variable: "g_surface_vtbl", interface: "IDirectDrawSurface7", prefix: "surface_" },
    { variable: "g_surface_vtbl4", interface: "IDirectDrawSurface4", prefix: "surface4_" },
    { variable: "g_surface_vtbl3", interface: "IDirectDrawSurface3", prefix: "surface3_" },
    { variable: "g_surface_vtbl2", interface: "IDirectDrawSurface2", prefix: "surface2_" },
    { variable: "g_surface_vtbl1", interface: "IDirectDrawSurface", prefix: "surface1_" },
    { variable: "g_ddraw_vtbl", interface: "IDirectDraw7", prefix: "ddraw_" },
    { variable: "g_ddraw_vtbl4", interface: "IDirectDraw4", prefix: "ddraw4_" },
    { variable: "g_ddraw_vtbl3", interface: "IDirectDraw3", prefix: "ddraw3_" },
    { variable: "g_ddraw_vtbl2", interface: "IDirectDraw2", prefix: "ddraw2_" },
    { variable: "g_ddraw_vtbl1", interface: "IDirectDraw", prefix: "ddraw1_" },
    { variable: "g_palette_vtbl", interface: "IDirectDrawPalette", prefix: "palette_" },
    { variable: "g_clipper_vtbl", interface: "IDirectDrawClipper", prefix: "clipper_" },
];

const failures = [];
let slotsChecked = 0;

for (const vtable of vtables) {
    const declared = declaredMethods(vtable.interface);
    const entries = initialiserEntries(vtable.variable);
    if (entries.length !== declared.length) {
        failures.push(`${vtable.variable}: ${entries.length} entries against ` +
            `${declared.length} methods in ${vtable.interface} -- a short ` +
            `vtable leaves the tail slots null, and a long one writes past ` +
            `the struct`);
        continue;
    }
    for (let slot = 0; slot < declared.length; ++slot) {
        const expected = vtable.prefix + declared[slot];
        ++slotsChecked;
        if (entries[slot] !== expected)
            failures.push(`${vtable.variable} slot ${slot} ` +
                `(${vtable.interface}::${declared[slot]}) is ` +
                `${entries[slot]}, expected ${expected}`);
    }
}

// The version-recovery helper has to know every vtable, or a pointer from a
// version it does not recognise is silently treated as version 7 -- which
// reads the object at the wrong offset.
for (const variable of ["g_surface_vtbl4", "g_surface_vtbl3", "g_surface_vtbl2",
        "g_surface_vtbl1"])
    assert.ok(source.includes("&" + variable + ")"),
        "surface_from_any does not recognise " + variable);
for (const variable of ["g_ddraw_vtbl4", "g_ddraw_vtbl3", "g_ddraw_vtbl2",
        "g_ddraw_vtbl1"])
    assert.ok(source.includes("&" + variable + ")"),
        "object_from_any does not recognise " + variable);

// And every vtable an object can be asked for has to be stored on it, or
// QueryInterface hands back a pointer whose vtable slot is null.
for (const assignment of ["surface->vtbl4 = &g_surface_vtbl4",
        "surface->vtbl3 = &g_surface_vtbl3", "surface->vtbl2 = &g_surface_vtbl2",
        "surface->vtbl1 = &g_surface_vtbl1", "object->vtbl4 = &g_ddraw_vtbl4",
        "object->vtbl3 = &g_ddraw_vtbl3", "object->vtbl2 = &g_ddraw_vtbl2",
        "object->vtbl1 = &g_ddraw_vtbl1"])
    assert.ok(source.includes(assignment),
        "a created object never receives its vtable: " + assignment);

if (failures.length) {
    for (const failure of failures) console.error("FAIL " + failure);
    console.error(failures.length + " vtable slot(s) are wrong");
    process.exit(1);
}
console.log(slotsChecked + " vtable slots across " + vtables.length +
    " interfaces match the SDK's declaration order");
