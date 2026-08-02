"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../server/app");

async function withServer(app, callback) {
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const origin = "http://127.0.0.1:" + address.port;
    try {
        await callback(origin);
    } finally {
        server.close();
        await once(server, "close");
    }
}

test("registration endpoint creates an account without returning a password", async function() {
    const requests = [];
    const app = createApp({
        accountService: {
            async register(payload) {
                requests.push(payload);
                return { username: payload.username };
            }
        },
        rateLimit: { limit: 10 }
    });

    await withServer(app, async function(origin) {
        const response = await fetch(origin + "/api/maplestory/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Origin": origin },
            body: JSON.stringify(VALID_PAYLOAD)
        });
        const body = await response.json();

        assert.equal(response.status, 201);
        assert.equal(body.ok, true);
        assert.equal(body.username, "Mapler83");
        assert.equal("password" in body, false);
        assert.deepEqual(requests, [VALID_PAYLOAD]);
    });
});

test("registration endpoint rejects a foreign browser origin", async function() {
    const app = createApp({
        accountService: { async register() { throw new Error("must not run"); } }
    });

    await withServer(app, async function(origin) {
        const response = await fetch(origin + "/api/maplestory/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Origin": "https://attacker.example" },
            body: JSON.stringify(VALID_PAYLOAD)
        });
        assert.equal(response.status, 403);
    });
});

test("registration endpoint rate-limits repeated attempts", async function() {
    const app = createApp({
        accountService: { async register(payload) { return { username: payload.username }; } },
        rateLimit: { limit: 1, windowMs: 60000 }
    });

    await withServer(app, async function(origin) {
        const request = function() {
            return fetch(origin + "/api/maplestory/accounts", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Origin": origin },
                body: JSON.stringify(VALID_PAYLOAD)
            });
        };
        assert.equal((await request()).status, 201);
        assert.equal((await request()).status, 429);
    });
});

const VALID_PAYLOAD = Object.freeze({
    username: "Mapler83",
    password: "safe-password-83",
    confirmPassword: "safe-password-83"
});
