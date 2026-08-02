"use strict";

const crypto = require("node:crypto");

const ACCOUNT_INSERT_SQL =
    "INSERT INTO accounts (`name`, `password`, `birthday`, `tempban`) VALUES (?, ?, ?, ?)";
const DEFAULT_BIRTHDAY = "2005-05-11";
const DEFAULT_TEMPBAN = "2005-05-11 00:00:00";

class RegistrationInputError extends Error {
    constructor(message) {
        super(message);
        this.name = "RegistrationInputError";
        this.statusCode = 400;
        this.publicCode = "invalid_registration";
    }
}

class AccountExistsError extends Error {
    constructor() {
        super("That username is already registered.");
        this.name = "AccountExistsError";
        this.statusCode = 409;
        this.publicCode = "account_exists";
    }
}

function validateRegistration(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new RegistrationInputError("Enter a username and password.");
    }

    const username = typeof payload.username === "string" ? payload.username.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    const confirmation = typeof payload.confirmPassword === "string" ? payload.confirmPassword : "";

    if (!/^[A-Za-z0-9]{4,13}$/.test(username)) {
        throw new RegistrationInputError("Username must be 4–13 letters or numbers.");
    }
    if (password.length < 6 || password.length > 32 || !/^[\x21-\x7e]+$/.test(password)) {
        throw new RegistrationInputError("Password must be 6–32 visible ASCII characters with no spaces.");
    }
    if (password !== confirmation) {
        throw new RegistrationInputError("The two passwords do not match.");
    }
    return { username: username, password: password };
}

async function hashCosmicPassword(password, algorithm) {
    if (algorithm === "sha512") {
        return crypto.createHash("sha512").update(password, "utf8").digest("hex");
    }
    if (algorithm !== "bcrypt") {
        throw new Error("COSMIC_PASSWORD_ALGORITHM must be bcrypt or sha512");
    }
    // Load only for the bcrypt path so schema/validation tests do not need to
    // initialize the relatively expensive password implementation.
    const bcrypt = require("bcryptjs");
    return bcrypt.hash(password, 12);
}

function createAccountService(pool, options) {
    if (!pool || typeof pool.execute !== "function") {
        throw new TypeError("A MariaDB/MySQL pool with execute() is required");
    }

    const settings = options || {};
    const algorithm = (settings.passwordAlgorithm || "bcrypt").toLowerCase();
    const hasher = settings.hasher || function(password) {
        return hashCosmicPassword(password, algorithm);
    };

    return Object.freeze({
        async register(payload) {
            const account = validateRegistration(payload);
            const passwordHash = await hasher(account.password);

            try {
                await pool.execute(ACCOUNT_INSERT_SQL, [
                    account.username,
                    passwordHash,
                    DEFAULT_BIRTHDAY,
                    DEFAULT_TEMPBAN
                ]);
            } catch (error) {
                if (error && (error.code === "ER_DUP_ENTRY" || error.errno === 1062)) {
                    throw new AccountExistsError();
                }
                throw error;
            }

            return { username: account.username };
        }
    });
}

module.exports = {
    ACCOUNT_INSERT_SQL,
    AccountExistsError,
    RegistrationInputError,
    createAccountService,
    hashCosmicPassword,
    validateRegistration
};
