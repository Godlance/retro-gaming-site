"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("Warcraft III is replaced by the MapleStory disk in both game catalogs", function() {
    const app = read("app.js");
    const library = read("library.js");
    const assets = read("game-assets.js");

    assert.doesNotMatch(app, /restoredLegacyState/);
    assert.doesNotMatch(app, /'warcraft3'\s*:/);
    assert.doesNotMatch(library, /warcraft3\s*:/);
    assert.doesNotMatch(assets, /warcraft3\s*:/);
    assert.equal(fs.existsSync(path.join(ROOT, "images/warcraft3.jpeg")), false);
    assert.match(app, /disk:\s*'game\/maplestory\.img'/);
    assert.match(app, /networkRestoreCommand:\s*'cmd\.exe \/c "D:\\\\restore-network\.bat"'/);
    assert.match(library, /maplestory:\s*\["MapleStory v83"/);
});

test("MapleStory registration is linked below the emulator", function() {
    const page = read("game.html");
    const app = read("app.js");

    assert.ok(page.indexOf('class="emulator-panel"') < page.indexOf('id="game_account_panel"'));
    assert.match(page, /href="register\.html"/);
    assert.match(app, /gameId !== "maplestory"/);
    assert.ok(page.indexOf("guest-automation.js") < page.indexOf("app.js"));
});

test("network recovery runs only after the emulator and D3D8 state restore complete", function() {
    const app = read("app.js");
    const restoreState = app.indexOf("await activeEmulator.restore_state(stateData)");
    const finishD3D8Restore = app.indexOf("await activeBridge.finishStateRestore()");
    const resumeGuest = app.indexOf("await activeEmulator.run()", finishD3D8Restore);
    const recoverNetwork = app.indexOf("RetroGuestAutomation.runWindowsCommand", resumeGuest);

    assert.ok(restoreState >= 0);
    assert.ok(restoreState < finishD3D8Restore);
    assert.ok(finishD3D8Restore < resumeGuest);
    assert.ok(resumeGuest < recoverNetwork);
    assert.match(app, /preserve_mac_from_state_image:\s*true/);
});

test("the guest batch resets the adapter before renewing DHCP", function() {
    const batch = read("guest/restore-network.bat");
    const release = batch.indexOf("ipconfig /release");
    const disable = batch.indexOf("admin=DISABLED");
    const enable = batch.indexOf("admin=ENABLED");
    const renew = batch.indexOf("ipconfig /renew");

    assert.ok(release >= 0);
    assert.ok(release < disable);
    assert.ok(disable < enable);
    assert.ok(enable < renew);
});
