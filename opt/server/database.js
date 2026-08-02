"use strict";

const mysql = require("mysql2/promise");

function requiredEnvironment(name, environment) {
    const value = environment[name];
    if (!value || !value.trim()) {
        throw new Error(name + " is required");
    }
    return value;
}

function createDatabasePool(environment) {
    const env = environment || process.env;
    const port = Number.parseInt(env.COSMIC_DB_PORT || "3306", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("COSMIC_DB_PORT must be a valid TCP port");
    }

    const options = {
        host: env.COSMIC_DB_HOST || "23.105.212.77",
        port: port,
        database: env.COSMIC_DB_NAME || "cosmic",
        user: requiredEnvironment("COSMIC_DB_USER", env),
        password: requiredEnvironment("COSMIC_DB_PASSWORD", env),
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 20,
        connectTimeout: 10000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        charset: "utf8mb4"
    };

    if ((env.COSMIC_DB_SSL || "").toLowerCase() === "true") {
        options.ssl = { minVersion: "TLSv1.2", rejectUnauthorized: true };
    }

    return mysql.createPool(options);
}

module.exports = { createDatabasePool };
