"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("Warcraft III is available in both game catalogs with its cover", function() {
    const app = read("app.js");
    const library = read("library.js");
    const assets = read("game-assets.js");

    assert.doesNotMatch(app, /restoredLegacyState/);
    assert.match(app, /'warcraft3'\s*:\s*\{/);
    assert.match(app, /disk:\s*R2_URL_2 \+ '\/game\/warcraft3\/warcraft3\.img\.zst'/);
    assert.match(library, /warcraft3:\s*\["Warcraft III",\s*"2002",\s*"Strategy",\s*"Windows XP"\]/);
    assert.match(assets, /warcraft3:\s*"images\/warcraft3\.jpg"/);
    assert.equal(fs.existsSync(path.join(ROOT, "images/warcraft3.jpg")), true);
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

test("Diablo II library links enable V8FT without the old save-tools hook", function() {
    const page = read("game.html");
    const app = read("app.js");
    const library = read("library.js");

    assert.match(library, /gameId === "diablo_2"/);
    assert.match(library, /query\.set\("v8ft", "1"\)/);
    assert.doesNotMatch(app, /D2 save tools|retro:game-action|save-files/);
    assert.doesNotMatch(page, /custom_controls/);
});
