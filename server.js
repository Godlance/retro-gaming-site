"use strict";

require("dotenv").config();

const { createAccountService } = require("./server/account-service");
const { createApp } = require("./server/app");
const { createDatabasePool } = require("./server/database");

async function main() {
    const port = Number.parseInt(process.env.PORT || "8080", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be a valid TCP port");
    }

    const pool = createDatabasePool(process.env);
    let trustProxy;
    if (process.env.TRUST_PROXY) {
        trustProxy = Number.parseInt(process.env.TRUST_PROXY, 10);
        if (!Number.isInteger(trustProxy) || trustProxy < 1) {
            throw new Error("TRUST_PROXY must be a positive number of trusted proxies");
        }
    }
    const accountService = createAccountService(pool, {
        passwordAlgorithm: process.env.COSMIC_PASSWORD_ALGORITHM || "bcrypt"
    });
    const app = createApp({
        accountService: accountService,
        publicOrigin: process.env.PUBLIC_ORIGIN,
        trustProxy: trustProxy
    });
    const server = app.listen(port, function() {
        console.log("Retro Gaming Site listening on port " + port);
    });

    async function shutdown(signal) {
        console.log(signal + " received; shutting down");
        server.close(async function() {
            await pool.end();
            process.exit(0);
        });
    }

    process.once("SIGINT", function() { void shutdown("SIGINT"); });
    process.once("SIGTERM", function() { void shutdown("SIGTERM"); });
}

main().catch(function(error) {
    console.error("Server startup failed:", error.message);
    process.exitCode = 1;
});
