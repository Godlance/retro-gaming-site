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
    assert.match(library, /maplestory:\s*\["MapleStory v83"/);
});

test("MapleStory registration is linked below the emulator", function() {
    const page = read("game.html");
    const app = read("app.js");

    assert.ok(page.indexOf('class="emulator-panel"') < page.indexOf('id="game_account_panel"'));
    assert.match(page, /href="register\.html"/);
    assert.match(app, /gameId !== "maplestory"/);
});
