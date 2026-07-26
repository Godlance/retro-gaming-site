"use strict";

const assert = require("node:assert/strict");

require("../v86_network_bridge.js");

const GLFN_BIND_TEXTURE = 28;
const GLFN_TEX_IMAGE_2D = 29;
const GLFN_DRAW_ARRAYS_DIRECT = 206;
const GLFN_BIND_FRAMEBUFFER = 167;
const GLFN_FRAMEBUFFER_TEXTURE = 168;
const GLFN_FRAMEBUFFER_RENDERBUFFER = 169;
const GLFN_BIND_RENDERBUFFER = 172;
const GLFN_RENDERBUFFER_STORAGE = 173;
const GLFN_BLIT_FRAMEBUFFER = 217;

const GL_FRAMEBUFFER = 0x8D40;
const GL_DRAW_FRAMEBUFFER = 0x8CA9;
const GL_RENDERBUFFER = 0x8D41;
const GL_COLOR_ATTACHMENT0 = 0x8CE0;
const GL_DEPTH_ATTACHMENT = 0x8D00;
const GL_TEXTURE_2D = 0x0DE1;
const GL_RGB8 = 0x8051;
const GL_RGBA8 = 0x8058;
const GL_BGRA = 0x80E1;
const GL_UNSIGNED_INT_8_8_8_8_REV = 0x8367;

function u32Payload(...values) {
    const payload = Buffer.alloc(values.length * 4);
    values.forEach((value, index) =>
        payload.writeUInt32LE(value >>> 0, index * 4));
    return payload;
}

function framebufferTexturePayload(target, attachment, texture) {
    return u32Payload(
        target, attachment, GL_TEXTURE_2D, texture, 0, 0);
}

function texImage2DPayload(
        target, level, internalformat, width, height,
        border, format, type) {
    return u32Payload(
        target, level, internalformat, width, height,
        border, format, type, 0);
}

function blitPayload() {
    return u32Payload(
        0, 0, 640, 480,
        0, 480, 640, 0,
        0x4000, 0x2600);
}

const calls = [];
const backend = {
    HEAPU8: new Uint8Array(4096),
    _malloc() { return 256; },
    _free() {},
    _v86glResize() {},
    _v86gl_glBindFramebufferMapped(target, framebuffer) {
        calls.push(["bind", target, framebuffer]);
    },
    _v86gl_glBindTexture(target, texture) {
        calls.push(["bindTexture", target, texture]);
    },
    _v86gl_glTexImage2D(
            target, level, internalformat, width, height,
            border, format, type, pixels) {
        calls.push([
            "texImage2D", target, level, internalformat, width, height,
            border, format, type, pixels,
        ]);
    },
    _v86gl_glBindRenderbufferMapped(target, renderbuffer) {
        calls.push(["bindRenderbuffer", target, renderbuffer]);
    },
    _v86gl_glRenderbufferStorageMapped(
            target, internalformat, width, height) {
        calls.push([
            "renderbufferStorage", target, internalformat, width, height,
        ]);
    },
    _v86gl_glFramebufferTextureMapped(
            target, attachment, textarget, texture, level, zoffset) {
        calls.push([
            "texture", target, attachment, textarget,
            texture, level, zoffset,
        ]);
    },
    _v86gl_glFramebufferRenderbufferMapped(
            target, attachment, renderbufferTarget, renderbuffer) {
        calls.push([
            "renderbuffer", target, attachment,
            renderbufferTarget, renderbuffer,
        ]);
    },
    _v86gl_glDrawArraysDirect(mode, first, count) {
        calls.push(["draw", mode, first, count]);
    },
    _v86gl_glBlitFramebuffer(...args) {
        calls.push(["blit", ...args]);
    },
};

const canvas = {
    width: 640,
    height: 480,
    style: {},
    parentElement: { getElementsByTagName() { return [canvas]; } },
};
const bridge = globalThis.installV86GLNetworkBridge(
    { add_listener() {} }, canvas, { gl4es: backend });
const renderer = bridge.renderer;

renderer.glCall(
    GLFN_BIND_TEXTURE, u32Payload(GL_TEXTURE_2D, 22));
renderer.glCall(
    GLFN_TEX_IMAGE_2D,
    texImage2DPayload(
        GL_TEXTURE_2D, 0, GL_RGB8, 640, 480, 0,
        GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV));
renderer.glCall(
    GLFN_BIND_RENDERBUFFER, u32Payload(GL_RENDERBUFFER, 33));
renderer.glCall(
    GLFN_RENDERBUFFER_STORAGE,
    u32Payload(GL_RENDERBUFFER, GL_RGBA8, 640, 480));

renderer.glCall(
    GLFN_BIND_FRAMEBUFFER, u32Payload(GL_FRAMEBUFFER, 8));
renderer.glCall(
    GLFN_FRAMEBUFFER_TEXTURE,
    framebufferTexturePayload(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, 22));
renderer.glCall(
    GLFN_FRAMEBUFFER_RENDERBUFFER,
    u32Payload(
        GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT,
        GL_RENDERBUFFER, 33));
renderer.glCall(
    GLFN_DRAW_ARRAYS_DIRECT, u32Payload(0x0004, 0, 3));

renderer.glCall(
    GLFN_BIND_FRAMEBUFFER, u32Payload(GL_FRAMEBUFFER, 9));
renderer.glCall(
    GLFN_FRAMEBUFFER_TEXTURE,
    framebufferTexturePayload(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, 44));
renderer.glCall(
    GLFN_BIND_FRAMEBUFFER, u32Payload(GL_DRAW_FRAMEBUFFER, 0));
renderer.glCall(GLFN_BLIT_FRAMEBUFFER, blitPayload());

assert.equal(renderer.lastDrawFramebuffer, 8);
assert.deepEqual(
    renderer.framebufferBufferState(8).attachments["0x8ce0"],
    {
        kind: "texture",
        object: 22,
        textarget: "0xde1",
        level: 0,
        zoffset: 0,
        allocation: {
            target: "0xde1",
            level: 0,
            internalformat: "0x8051",
            width: 640,
            height: 480,
            border: 0,
            format: "0x80e1",
            type: "0x8367",
            dataSize: 0,
        },
    });
assert.deepEqual(
    renderer.framebufferBufferState(8).attachments["0x8d00"],
    {
        kind: "renderbuffer",
        object: 33,
        renderbufferTarget: "0x8d41",
        allocation: {
            target: "0x8d41",
            internalformat: "0x8058",
            width: 640,
            height: 480,
        },
    });
assert.deepEqual(
    renderer.framebufferBufferState(9).attachments["0x8ce0"],
    {
        kind: "texture",
        object: 44,
        textarget: "0xde1",
        level: 0,
        zoffset: 0,
        allocation: null,
    });
assert.equal(
    renderer.framebufferHistory.some(event =>
        event.kind === "attachment" &&
        event.framebuffers.includes(8) &&
        event.attachmentKind === "texture" &&
        event.object === 22),
    true);
assert.equal(calls.at(-1)[0], "blit");

console.log("v86_network_bridge_fbo_trace_test: ok");
