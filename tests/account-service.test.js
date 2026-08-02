"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    ACCOUNT_INSERT_SQL,
    AccountExistsError,
    RegistrationInputError,
    createAccountService,
    hashCosmicPassword,
    validateRegistration
} = require("../server/account-service");

const VALID_REGISTRATION = Object.freeze({
    username: "Mapler83",
    password: "safe-password-83",
    confirmPassword: "safe-password-83"
});

test("validateRegistration normalizes a Cosmic-compatible username", function() {
    assert.deepEqual(validateRegistration({
        username: "  Mapler83  ",
        password: "safe-password-83",
        confirmPassword: "safe-password-83"
    }), {
        username: "Mapler83",
        password: "safe-password-83"
    });
});

test("validateRegistration rejects invalid names, passwords, and confirmation", function() {
    assert.throws(function() {
        validateRegistration({ username: "a!", password: "abcdef", confirmPassword: "abcdef" });
    }, RegistrationInputError);
    assert.throws(function() {
        validateRegistration({ username: "Mapler83", password: "abc def", confirmPassword: "abc def" });
    }, RegistrationInputError);
    assert.throws(function() {
        validateRegistration({ username: "Mapler83", password: "abcdef", confirmPassword: "abcdefg" });
    }, RegistrationInputError);
});

test("account service inserts only the official Cosmic registration columns", async function() {
    const calls = [];
    const pool = {
        async execute(sql, parameters) {
            calls.push([sql, parameters]);
            return [{ insertId: 42 }];
        }
    };
    const service = createAccountService(pool, {
        hasher: async function(password) {
            assert.equal(password, VALID_REGISTRATION.password);
            return "$2a$12$test-hash";
        }
    });

    assert.deepEqual(await service.register(VALID_REGISTRATION), { username: "Mapler83" });
    assert.deepEqual(calls, [[ACCOUNT_INSERT_SQL, [
        "Mapler83",
        "$2a$12$test-hash",
        "2005-05-11",
        "2005-05-11 00:00:00"
    ]]]);
});

test("account service converts the MariaDB unique-key error into a public conflict", async function() {
    const service = createAccountService({
        async execute() {
            const error = new Error("duplicate");
            error.code = "ER_DUP_ENTRY";
            throw error;
        }
    }, { hasher: async function() { return "hash"; } });

    await assert.rejects(service.register(VALID_REGISTRATION), AccountExistsError);
});

test("SHA-512 compatibility mode matches Cosmic's lowercase hex encoding", async function() {
    const hash = await hashCosmicPassword("maple", "sha512");
    assert.equal(hash.length, 128);
    assert.match(hash, /^[0-9a-f]{128}$/);
});

test("bcrypt compatibility mode uses Cosmic's cost 12", async function() {
    const hash = await hashCosmicPassword("maple", "bcrypt");
    assert.match(hash, /^\$2[aby]\$12\$/);
    assert.equal(await require("bcryptjs").compare("maple", hash), true);
});
