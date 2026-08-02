"use strict";

const path = require("node:path");
const express = require("express");
const { RegistrationInputError, AccountExistsError } = require("./account-service");

function createRegistrationRateLimiter(options) {
    const settings = options || {};
    const windowMs = settings.windowMs || 10 * 60 * 1000;
    const limit = settings.limit || 5;
    const now = settings.now || Date.now;
    const attempts = new Map();

    return function registrationRateLimiter(request, response, next) {
        const key = request.ip || request.socket.remoteAddress || "unknown";
        const currentTime = now();
        let entry = attempts.get(key);
        if (!entry || entry.resetAt <= currentTime) {
            entry = { count: 0, resetAt: currentTime + windowMs };
            attempts.set(key, entry);
        }
        entry.count += 1;
        response.set("RateLimit-Limit", String(limit));
        response.set("RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
        response.set("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

        if (entry.count > limit) {
            response.set("Retry-After", String(Math.ceil((entry.resetAt - currentTime) / 1000)));
            response.status(429).json({
                ok: false,
                code: "rate_limited",
                message: "Too many registration attempts. Please try again later."
            });
            return;
        }
        next();
    };
}

function hasAllowedOrigin(request, publicOrigin) {
    const origin = request.get("origin");
    if (!origin) return true;

    const expected = publicOrigin || request.protocol + "://" + request.get("host");
    try {
        return new URL(origin).origin === new URL(expected).origin;
    } catch (error) {
        return false;
    }
}

function createApp(options) {
    const settings = options || {};
    if (!settings.accountService || typeof settings.accountService.register !== "function") {
        throw new TypeError("accountService.register() is required");
    }

    const app = express();
    app.disable("x-powered-by");
    if (settings.trustProxy !== undefined) app.set("trust proxy", settings.trustProxy);

    app.use(function securityHeaders(request, response, next) {
        response.set("X-Content-Type-Options", "nosniff");
        response.set("Referrer-Policy", "same-origin");
        response.set("X-Frame-Options", "SAMEORIGIN");
        next();
    });

    app.get("/api/health", function(request, response) {
        response.json({ ok: true });
    });

    app.post(
        "/api/maplestory/accounts",
        createRegistrationRateLimiter(settings.rateLimit),
        express.json({ limit: "8kb", strict: true }),
        async function registerAccount(request, response) {
            if (!hasAllowedOrigin(request, settings.publicOrigin)) {
                response.status(403).json({
                    ok: false,
                    code: "origin_rejected",
                    message: "Registration must be submitted from this website."
                });
                return;
            }

            try {
                const result = await settings.accountService.register(request.body);
                response.status(201).json({
                    ok: true,
                    username: result.username,
                    message: "Account created. You can now sign in from MapleStory."
                });
            } catch (error) {
                if (error instanceof RegistrationInputError || error instanceof AccountExistsError) {
                    response.status(error.statusCode).json({
                        ok: false,
                        code: error.publicCode,
                        message: error.message
                    });
                    return;
                }
                console.error("MapleStory registration failed:", error);
                response.status(503).json({
                    ok: false,
                    code: "registration_unavailable",
                    message: "Registration is temporarily unavailable. Please try again later."
                });
            }
        }
    );

    // Backend source and tests live beside the static site in this repository,
    // but are never public assets.
    ["/server", "/tests"].forEach(function(prefix) {
        app.use(prefix, function(request, response) { response.sendStatus(404); });
    });
    ["/server.js", "/package.json", "/package-lock.json"].forEach(function(filePath) {
        app.get(filePath, function(request, response) { response.sendStatus(404); });
    });

    app.use(express.static(settings.publicDirectory || path.resolve(__dirname, ".."), {
        dotfiles: "ignore",
        index: "index.html",
        setHeaders(response, filePath) {
            if (/\.(?:img|iso|zst)$/i.test(filePath)) {
                response.setHeader("Cache-Control", "public, max-age=86400");
            }
        }
    }));

    app.use(function invalidJson(error, request, response, next) {
        if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
            response.status(400).json({
                ok: false,
                code: "invalid_json",
                message: "The registration request is not valid JSON."
            });
            return;
        }
        next(error);
    });

    return app;
}

module.exports = { createApp, createRegistrationRateLimiter, hasAllowedOrigin };
