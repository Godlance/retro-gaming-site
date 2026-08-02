"use strict";

(function(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.RetroGuestAutomation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    const OPEN_WINDOWS_RUN_SCANCODES = Object.freeze([
        0xe0, 0x5b, // left Windows key down
        0x13, 0x93, // R down/up
        0xe0, 0xdb  // left Windows key up
    ]);
    const ENTER_SCANCODES = Object.freeze([0x1c, 0x9c]);

    function sleep(milliseconds) {
        return new Promise(function(resolve) {
            setTimeout(resolve, milliseconds);
        });
    }

    async function runWindowsCommand(emulator, command, options) {
        const settings = options || {};
        const wait = settings.wait || sleep;
        const keyDelay = settings.keyDelay === undefined ? 35 : settings.keyDelay;
        const textDelay = settings.textDelay === undefined ? 12 : settings.textDelay;

        if (!emulator || typeof emulator.keyboard_send_scancodes !== "function" ||
            typeof emulator.keyboard_send_text !== "function") {
            throw new TypeError("The emulator does not expose the v86 keyboard API");
        }
        if (typeof command !== "string" || !command.trim() || /[\r\n]/.test(command)) {
            throw new TypeError("Guest command must be a non-empty single line");
        }

        await wait(settings.desktopDelay === undefined ? 1200 : settings.desktopDelay);
        await emulator.keyboard_send_scancodes(Array.from(OPEN_WINDOWS_RUN_SCANCODES), keyDelay);
        await wait(settings.runDialogDelay === undefined ? 500 : settings.runDialogDelay);
        await emulator.keyboard_send_text(command, textDelay);
        await emulator.keyboard_send_scancodes(Array.from(ENTER_SCANCODES), keyDelay);
        await wait(settings.commandStartDelay === undefined ? 800 : settings.commandStartDelay);
    }

    return Object.freeze({
        runWindowsCommand: runWindowsCommand,
        OPEN_WINDOWS_RUN_SCANCODES: OPEN_WINDOWS_RUN_SCANCODES,
        ENTER_SCANCODES: ENTER_SCANCODES
    });
});
