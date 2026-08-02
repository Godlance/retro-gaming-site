"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    ENTER_SCANCODES,
    OPEN_WINDOWS_RUN_SCANCODES,
    runWindowsCommand
} = require("../guest-automation");

test("runWindowsCommand opens Win+R, types one command, and presses Enter", async function() {
    const events = [];
    const emulator = {
        async keyboard_send_scancodes(codes, delay) {
            events.push(["scancodes", codes, delay]);
        },
        async keyboard_send_text(text, delay) {
            events.push(["text", text, delay]);
        }
    };
    const waits = [];

    await runWindowsCommand(emulator, 'cmd.exe /c "D:\\restore-network.bat"', {
        wait: async function(milliseconds) { waits.push(milliseconds); },
        desktopDelay: 10,
        runDialogDelay: 20,
        commandStartDelay: 30,
        keyDelay: 2,
        textDelay: 3
    });

    assert.deepEqual(waits, [10, 20, 30]);
    assert.deepEqual(events, [
        ["scancodes", Array.from(OPEN_WINDOWS_RUN_SCANCODES), 2],
        ["text", 'cmd.exe /c "D:\\restore-network.bat"', 3],
        ["scancodes", Array.from(ENTER_SCANCODES), 2]
    ]);
});

test("runWindowsCommand rejects missing keyboard APIs and multiline commands", async function() {
    await assert.rejects(runWindowsCommand({}, "echo test", { wait: async function() {} }), TypeError);
    await assert.rejects(
        runWindowsCommand({
            keyboard_send_scancodes() {},
            keyboard_send_text() {}
        }, "first\nsecond", { wait: async function() {} }),
        TypeError
    );
});
