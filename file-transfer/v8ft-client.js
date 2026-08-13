"use strict";

(function(root, factory) {
    const protocol = root && root.V8FTProtocol ||
        (typeof require === "function" ? require("./v8ft-protocol.js") : null);
    const api = factory(protocol);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) {
        root.V8FTSerialTransport = api.V8FTSerialTransport;
        root.V8FTClient = api.V8FTClient;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function(protocol) {
    if (!protocol) throw new Error("V8FT protocol is required");

    const T = protocol.MessageType;
    const F = protocol.Flags;
    const DEFAULT_TIMEOUT_MS = 5000;
    const DEFAULT_TRANSFER_TIMEOUT_MS = 30000;
    const DEFAULT_RING_BYTES = 1024 * 1024;
    // Phase 0's slower sustained host -> XP disk sample was 243.66 KiB/s.
    const DEFAULT_UPLOAD_RATE_BYTES_PER_SECOND = 240 * 1024;
    // Phase 0's slower sustained XP -> host sample was 642.22 KiB/s.
    const DEFAULT_DOWNLOAD_RATE_BYTES_PER_SECOND = 600 * 1024;
    const DEFAULT_CHUNK_TIMEOUT_MIN_MS = 3000;
    const DEFAULT_CHUNK_TIMEOUT_MAX_MS = 120000;
    const DEFAULT_CHUNK_RETRIES = 3;
    const DEFAULT_COMMIT_TIMEOUT_MS = 15000;
    const DEFAULT_REQUESTED_FEATURES = protocol.Feature.ECHO | protocol.Feature.SHARES |
        protocol.Feature.LIST | protocol.Feature.GET | protocol.Feature.PUT |
        protocol.Feature.CANCEL;

    class V8FTSerialTransport {
        constructor(emulator, onFrame, onProtocolError, onFailure, options) {
            if (!emulator || typeof emulator.serial_send_bytes !== "function" ||
                typeof emulator.add_listener !== "function") {
                throw new TypeError("an active v86 emulator with serial APIs is required");
            }
            this.emulator = emulator;
            this.onFrame = onFrame;
            this.onProtocolError = onProtocolError || function() {};
            this.onFailure = onFailure || function() {};
            this.ring = new protocol.ByteRing(options && options.ringBytes || DEFAULT_RING_BYTES);
            this.parser = new protocol.FrameParser(onFrame, error => this.onProtocolError(error));
            this.byteListener = byte => this.ring.push(byte);
            this.emulator.add_listener("serial0-output-byte", this.byteListener);
            this.drainTimer = setInterval(() => this.drain(), options && options.drainIntervalMs || 1);
        }

        send(fields) {
            this.emulator.serial_send_bytes(0, protocol.encodeFrame(fields));
        }

        sendPreamble(length) {
            this.emulator.serial_send_bytes(0, new Uint8Array(length));
        }

        drain() {
            if (this.ring.overflowed) {
                this.ring.clear();
                this.parser.reset();
                this.onFailure(new Error("V8FT serial receive ring overflowed"));
                return;
            }
            let value;
            while ((value = this.ring.shift()) !== -1) this.parser.pushByte(value);
        }

        reset() {
            this.ring.clear();
            this.parser.reset();
        }

        destroy() {
            clearInterval(this.drainTimer);
            if (this.emulator && typeof this.emulator.remove_listener === "function") {
                this.emulator.remove_listener("serial0-output-byte", this.byteListener);
            }
            this.emulator = null;
            this.ring.clear();
        }
    }

    class V8FTClient {
        constructor(emulator, options) {
            this.emulator = emulator;
            this.options = options || {};
            this.timeoutMs = this.options.timeoutMs || DEFAULT_TIMEOUT_MS;
            this.transferTimeoutMs = this.options.transferTimeoutMs || DEFAULT_TRANSFER_TIMEOUT_MS;
            this.requestedFeatures = this.options.requestedFeatures === undefined ?
                DEFAULT_REQUESTED_FEATURES : this.options.requestedFeatures >>> 0;
            this.nextRequestId = 1;
            this.sessionNonce = null;
            this.serverInfo = null;
            this.connected = false;
            this.activeOperation = null;
            this.activeTransfer = null;
            this.waiters = new Map();
            this.inbox = new Map();
            this.protocolErrors = [];
            const handlers = {
                onFrame: frame => this.handleFrame(frame),
                onProtocolError: error => this.handleProtocolError(error),
                onFailure: error => this.failAll(error),
            };
            this.transport = typeof this.options.transportFactory === "function" ?
                this.options.transportFactory(emulator, handlers, this.options) :
                new V8FTSerialTransport(emulator, handlers.onFrame,
                    handlers.onProtocolError, handlers.onFailure, this.options);
            requireTransport(this.transport);
        }

        connect() {
            return this.exclusive("connect", () => this.connectInternal());
        }

        ping(payload) {
            return this.exclusive("ping", async () => {
                await this.ensureConnected();
                const body = payload === undefined ? new Uint8Array(0) : requireBytes(payload);
                const requestId = this.allocateRequestId();
                this.transport.send({ type: T.PING, requestId, sequence: 0, payload: body });
                const reply = await this.nextFrame(requestId, [T.PONG], this.timeoutMs);
                this.validateResponse(reply, 0);
                if (!equalBytes(body, reply.payload)) throw new Error("V8FT PONG payload mismatch");
                return reply.payload;
            });
        }

        echo(payload) {
            return this.exclusive("echo", async () => {
                await this.ensureConnected();
                if (!(this.serverInfo.features & protocol.Feature.ECHO)) {
                    throw new Error("V8FT agent did not negotiate ECHO");
                }
                const body = requireBytes(payload);
                const requestId = this.allocateRequestId();
                this.transport.send({ type: T.ECHO, requestId, sequence: 0, payload: body });
                const reply = await this.nextFrame(requestId, [T.ECHO_REPLY], this.timeoutMs);
                this.validateResponse(reply, 0);
                if (!equalBytes(body, reply.payload)) throw new Error("V8FT ECHO payload mismatch");
                return reply.payload;
            });
        }

        shares() {
            return this.exclusive("shares", async () => {
                await this.requireFeature(protocol.Feature.SHARES, "SHARES");
                const requestId = this.allocateRequestId();
                this.transport.send({ type: T.SHARES_REQUEST, requestId, sequence: 0 });
                const reply = await this.nextFrame(requestId, [T.SHARES_REPLY], this.timeoutMs);
                this.validateResponse(reply, 0);
                return protocol.decodeSharesReply(reply.payload);
            });
        }

        listDirectory(shareId, path, options) {
            return this.exclusive("list", async () => {
                await this.requireFeature(protocol.Feature.LIST, "LIST");
                const settings = options || {};
                const pageSize = settings.pageSize || this.serverInfo.maxDirEntriesPerPage;
                if (!pageSize || pageSize > this.serverInfo.maxDirEntriesPerPage) {
                    throw new RangeError("directory page size exceeds the agent limit");
                }
                const requestId = this.allocateRequestId();
                this.transport.send({
                    type: T.LIST_DIR_REQUEST,
                    requestId,
                    sequence: 0,
                    payload: protocol.encodeListDirRequest({
                        shareId,
                        path: path || "",
                        cursor: settings.cursor || null,
                        pageSize,
                    }),
                });
                const entries = [];
                let sequence = 0;
                for (;;) {
                    const frame = await this.nextFrame(requestId,
                        [T.LIST_DIR_ENTRY, T.LIST_DIR_END], this.timeoutMs);
                    this.validateResponse(frame, sequence++);
                    if (frame.type === T.LIST_DIR_END) {
                        return { entries, nextCursor: protocol.decodeListDirEnd(frame.payload) };
                    }
                    entries.push(protocol.decodeListDirEntry(frame.payload));
                    if (entries.length > pageSize) throw new Error("V8FT agent exceeded requested directory page size");
                }
            });
        }

        getFiles(shareId, paths, options) {
            return this.exclusive("get", async () => {
                try {
                    await this.requireFeature(protocol.Feature.GET, "GET");
                    return await this.getFilesInternal(shareId, paths, options || {});
                } catch (error) {
                    this.connected = false;
                    throw error;
                }
            });
        }

        async getFile(shareId, path, options) {
            const result = await this.getFiles(shareId, [path], options);
            return result.files[0];
        }

        putFiles(shareId, files, options) {
            return this.exclusive("put", async () => {
                await this.requireFeature(protocol.Feature.PUT, "PUT");
                return this.putFilesInternal(shareId, files, options || {});
            });
        }

        putFile(shareId, path, source, options) {
            const entry = source instanceof Uint8Array ? { path, bytes: source } : { path, file: source };
            return this.putFiles(shareId, [entry], options);
        }

        cancelActiveTransfer() {
            const active = this.activeTransfer;
            if (!active) return Promise.resolve(false);
            if (!this.connected || !(this.serverInfo.features & protocol.Feature.CANCEL)) {
                return Promise.reject(new Error("V8FT agent did not negotiate CANCEL"));
            }
            if (!active.cancelSent) {
                active.cancelSent = true;
                if (active.started !== false) {
                    this.transport.send({
                        type: T.CANCEL,
                        requestId: active.requestId,
                        sequence: 0,
                        payload: protocol.encodeCancel(),
                    });
                }
            }
            return Promise.resolve(true);
        }

        cancelActive() {
            return this.cancelActiveTransfer();
        }

        async putFilesInternal(shareId, inputs, options) {
            const files = await normalizePutFiles(inputs);
            if (!files.length) throw new RangeError("PUT requires at least one file");
            if (files.length > this.serverInfo.maxRequestFiles) {
                throw new RangeError("PUT file count exceeds the agent limit");
            }
            let totalBytes = 0;
            for (const file of files) {
                protocol.validateRelativePath(file.path, false);
                if (file.sizeBytes > this.serverInfo.maxFileBytes) {
                    throw new RangeError("PUT file exceeds the agent limit: " + file.path);
                }
                totalBytes += file.sizeBytes;
                if (totalBytes > this.serverInfo.maxRequestBytes) {
                    throw new RangeError("PUT total bytes exceed the agent limit");
                }
            }
            const manifest = [];
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                const crc32 = await calculatePutFileCrc(file, options, index, totalBytes);
                manifest.push({
                    path: file.path,
                    sizeBytes: file.sizeBytes,
                    crc32,
                    index,
                });
            }
            const requestId = this.allocateRequestId();
            const active = { requestId, kind: "put", cancelSent: false, started: true };
            this.activeTransfer = active;
            let removeAbort = null;
            if (options.signal) {
                if (options.signal.aborted) active.cancelSent = true;
                const abort = () => { this.cancelActiveTransfer().catch(function() {}); };
                options.signal.addEventListener("abort", abort, { once: true });
                removeAbort = () => options.signal.removeEventListener("abort", abort);
            }
            try {
                this.transport.send({
                    type: T.PUT_BEGIN,
                    requestId,
                    sequence: 0,
                    payload: protocol.encodePutBegin({ shareId, files: manifest }),
                });
                if (active.cancelSent) this.transport.send({
                    type: T.CANCEL, requestId, sequence: 0, payload: protocol.encodeCancel(),
                });
                const readyFrame = await this.nextFrame(requestId,
                    [T.PUT_READY, T.PUT_RESULT], this.transferTimeoutMs);
                if (readyFrame.type === T.PUT_RESULT) {
                    return this.finishPutResult(readyFrame, requestId, files.length, totalBytes);
                }
                this.validateResponse(readyFrame, 0);
                const ready = protocol.decodePutReady(readyFrame.payload);
                if (ready.fileCount !== files.length || ready.totalBytes !== totalBytes) {
                    throw new Error("V8FT PUT_READY manifest totals mismatch");
                }

                let sequence = 1;
                let sentBytes = 0;
                let rate = positiveNumber(options.uploadRateBytesPerSecond,
                    DEFAULT_UPLOAD_RATE_BYTES_PER_SECOND);
                const maxChunk = Math.min(protocol.MAX_PAYLOAD_BYTES,
                    this.serverInfo.maxPayloadBytes) - 8;
                if (maxChunk < 1) throw new Error("V8FT agent payload limit cannot carry PUT data");
                for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
                    const file = files[fileIndex];
                    for (let offset = 0; offset < file.sizeBytes;) {
                        if (active.cancelSent) {
                            const canceled = await this.nextFrame(requestId, [T.PUT_RESULT],
                                this.transferTimeoutMs);
                            return this.finishPutResult(canceled, requestId, files.length, totalBytes);
                        }
                        const data = await readPutFile(file, offset,
                            Math.min(maxChunk, file.sizeBytes - offset));
                        const payload = protocol.encodePutChunk({ fileIndex, offset, data });
                        const started = monotonicNow();
                        const frame = await this.sendPutChunkWithRetry({
                            requestId, sequence, payload, dataBytes: data.length, rate, options,
                        });
                        if (frame.type === T.PUT_RESULT) {
                            return this.finishPutResult(frame, requestId, files.length, totalBytes);
                        }
                        this.validateResponse(frame, sequence);
                        const ack = protocol.decodePutAck(frame.payload);
                        if (ack.fileIndex !== fileIndex || ack.nextOffset !== offset + data.length) {
                            throw new Error("V8FT PUT_ACK offset mismatch");
                        }
                        const elapsedSeconds = Math.max(0.001, (monotonicNow() - started) / 1000);
                        rate = rate * 0.75 + data.length / elapsedSeconds * 0.25;
                        offset = ack.nextOffset;
                        sentBytes += data.length;
                        if (typeof options.onChunk === "function") {
                            await options.onChunk({
                                requestId, fileIndex, path: file.path, offset: offset - data.length,
                                bytes: data.length, sentBytes, totalBytes,
                                fileSentBytes: offset, fileSizeBytes: file.sizeBytes,
                                sessionWriteBytes: ack.sessionWriteBytes,
                                measuredRateBytesPerSecond: rate,
                            });
                        }
                        sequence++;
                        await yieldToEventLoop();
                    }
                }
                if (active.cancelSent) {
                    const canceled = await this.nextFrame(requestId, [T.PUT_RESULT],
                        this.transferTimeoutMs);
                    return this.finishPutResult(canceled, requestId, files.length, totalBytes);
                }
                this.transport.send({ type: T.PUT_COMMIT, requestId, sequence });
                const resultFrame = await this.nextFrame(requestId, [T.PUT_RESULT],
                    positiveNumber(options.commitTimeoutMs, DEFAULT_COMMIT_TIMEOUT_MS));
                this.validateResponse(resultFrame, sequence);
                return this.finishPutResult(resultFrame, requestId, files.length, totalBytes);
            } catch (error) {
                if (!error || !error.isV8FTPutResult) {
                    if (this.connected && this.serverInfo &&
                        (this.serverInfo.features & protocol.Feature.CANCEL) && !active.cancelSent) {
                        active.cancelSent = true;
                        this.transport.send({
                            type: T.CANCEL, requestId, sequence: 0,
                            payload: protocol.encodeCancel(),
                        });
                    }
                    // A fresh HELLO makes the guest clean/recover an uncertain transaction.
                    this.connected = false;
                }
                throw error;
            } finally {
                if (removeAbort) removeAbort();
                if (this.activeTransfer === active) this.activeTransfer = null;
            }
        }

        async sendPutChunkWithRetry(fields) {
            const retries = nonNegativeInteger(fields.options.maxChunkRetries,
                DEFAULT_CHUNK_RETRIES);
            const minTimeout = positiveNumber(fields.options.chunkTimeoutMinMs,
                DEFAULT_CHUNK_TIMEOUT_MIN_MS);
            const maxTimeout = positiveNumber(fields.options.chunkTimeoutMaxMs,
                DEFAULT_CHUNK_TIMEOUT_MAX_MS);
            const transferMs = fields.dataBytes / Math.max(1, fields.rate) * 3000;
            const timeout = Math.max(minTimeout, Math.min(maxTimeout, 3000 + transferMs));
            let lastError;
            for (let attempt = 0; attempt <= retries; attempt++) {
                this.transport.send({
                    type: T.PUT_CHUNK,
                    flags: attempt ? F.RETRY : 0,
                    requestId: fields.requestId,
                    sequence: fields.sequence,
                    payload: fields.payload,
                });
                try {
                    return await this.nextFrame(fields.requestId,
                        [T.PUT_ACK, T.PUT_RESULT], timeout);
                } catch (error) {
                    lastError = error;
                    if (!error || error.code !== "V8FT_TIMEOUT" || attempt === retries) throw error;
                }
            }
            throw lastError;
        }

        finishPutResult(frame, requestId, expectedFileCount, expectedTotalBytes) {
            if (!(frame.flags & F.RESPONSE) || !(frame.flags & F.END)) {
                throw new Error("V8FT PUT_RESULT flags are invalid");
            }
            const result = protocol.decodePutResult(frame.payload);
            result.requestId = requestId;
            if (result.errorCode !== protocol.ErrorCode.OK) {
                const error = new Error("V8FT PUT failed with agent error " + result.errorCode);
                error.code = result.errorCode;
                error.requestId = requestId;
                error.result = result;
                error.isV8FTPutResult = true;
                throw error;
            }
            if (result.fileCount !== expectedFileCount || result.totalBytes !== expectedTotalBytes) {
                throw new Error("V8FT PUT_RESULT totals mismatch");
            }
            return result;
        }

        async getFilesInternal(shareId, paths, options) {
            if (!Array.isArray(paths) || !paths.length) throw new RangeError("GET requires at least one path");
            if (paths.length > this.serverInfo.maxRequestFiles) {
                throw new RangeError("GET file count exceeds the agent limit");
            }
            const requestId = this.allocateRequestId();
            const active = { requestId, kind: "get", cancelSent: false, started: false };
            this.activeTransfer = active;
            let removeAbort = null;
            if (options.signal) {
                if (options.signal.aborted) active.cancelSent = true;
                const abort = () => { this.cancelActiveTransfer().catch(function() {}); };
                options.signal.addEventListener("abort", abort, { once: true });
                removeAbort = () => options.signal.removeEventListener("abort", abort);
            }
            try {
                this.transport.send({
                    type: T.GET_REQUEST,
                    requestId,
                    sequence: 0,
                    payload: protocol.encodeGetRequest({ shareId, paths }),
                });
                active.started = true;
                if (active.cancelSent) this.transport.send({
                    type: T.CANCEL, requestId, sequence: 0, payload: protocol.encodeCancel(),
                });
                const begin = await this.nextFrame(requestId, [T.GET_BEGIN], this.transferTimeoutMs);
                this.validateResponse(begin, 0);
                const manifest = protocol.decodeGetBegin(begin.payload);
                if (manifest.length !== paths.length) throw new Error("V8FT GET manifest count mismatch");
                let totalBytes = 0;
                const files = manifest.map((file, index) => {
                    if (file.path !== paths[index]) throw new Error("V8FT GET manifest path mismatch");
                    if (file.sizeBytes > this.serverInfo.maxFileBytes) {
                        throw new Error("V8FT GET manifest exceeds maxFileBytes");
                    }
                    totalBytes += file.sizeBytes;
                    return {
                        path: file.path,
                        sizeBytes: file.sizeBytes,
                        crc32: file.crc32,
                        bytes: options.collect === false ? null : new Uint8Array(file.sizeBytes),
                        receivedBytes: 0,
                        crcState: 0xFFFFFFFF,
                    };
                });
                if (totalBytes > this.serverInfo.maxRequestBytes) {
                    throw new Error("V8FT GET manifest exceeds maxRequestBytes");
                }

                let sequence = 1;
                let receivedTotalBytes = 0;
                let rate = positiveNumber(options.downloadRateBytesPerSecond,
                    DEFAULT_DOWNLOAD_RATE_BYTES_PER_SECOND);
                const maxChunk = Math.min(protocol.MAX_PAYLOAD_BYTES,
                    this.serverInfo.maxPayloadBytes) - 8;
                if (maxChunk < 1) throw new Error("V8FT agent payload limit cannot carry GET data");
                for (;;) {
                    const started = monotonicNow();
                    const frame = await this.nextFrame(requestId, [T.GET_CHUNK, T.GET_END],
                        adaptiveChunkTimeout(maxChunk, rate, options));
                    this.validateResponse(frame, sequence);
                    if (frame.type === T.GET_END) {
                        const end = protocol.decodeGetEnd(frame.payload);
                        if (end.fileCount !== files.length || end.totalBytes !== totalBytes) {
                            throw new Error("V8FT GET_END totals mismatch");
                        }
                        for (const file of files) {
                            if (file.receivedBytes !== file.sizeBytes ||
                                ((file.crcState ^ 0xFFFFFFFF) >>> 0) !== file.crc32) {
                                throw new Error("V8FT GET file length or CRC mismatch: " + file.path);
                            }
                            delete file.receivedBytes;
                            delete file.crcState;
                        }
                        return { files, totalBytes };
                    }

                    const chunk = protocol.decodeGetChunk(frame.payload);
                    const file = files[chunk.fileIndex];
                    if (!file || chunk.offset !== file.receivedBytes || !chunk.data.length ||
                        chunk.offset + chunk.data.length > file.sizeBytes) {
                        throw new Error("V8FT GET chunk is out of order");
                    }
                    if (file.bytes) file.bytes.set(chunk.data, chunk.offset);
                    file.crcState = protocol.crc32Update(file.crcState, chunk.data);
                    file.receivedBytes += chunk.data.length;
                    receivedTotalBytes += chunk.data.length;
                    const elapsedSeconds = Math.max(0.001, (monotonicNow() - started) / 1000);
                    rate = rate * 0.75 + chunk.data.length / elapsedSeconds * 0.25;
                    if (typeof options.onChunk === "function") {
                        await options.onChunk({
                            requestId,
                            fileIndex: chunk.fileIndex,
                            path: file.path,
                            offset: chunk.offset,
                            data: chunk.data,
                            receivedBytes: file.receivedBytes,
                            sizeBytes: file.sizeBytes,
                            receivedTotalBytes,
                            totalBytes,
                            measuredRateBytesPerSecond: rate,
                        });
                    }
                    await yieldToEventLoop();
                    if (active.cancelSent) {
                        // GET is stop-and-wait: after CANCEL, do not ACK the last
                        // chunk and wait for the agent's terminal CANCELLED error.
                        await this.nextFrame(requestId, [T.GET_END], this.transferTimeoutMs);
                    }
                    this.transport.send({
                        type: T.GET_ACK,
                        requestId,
                        sequence,
                        payload: protocol.encodeGetAck(chunk.fileIndex, file.receivedBytes),
                    });
                    sequence++;
                }
            } finally {
                if (removeAbort) removeAbort();
                if (this.activeTransfer === active) this.activeTransfer = null;
            }
        }

        async connectInternal() {
            this.connected = false;
            this.serverInfo = null;
            this.sessionNonce = randomNonce();
            this.inbox.clear();
            this.transport.reset();
            this.transport.sendPreamble(64);
            this.transport.send({
                type: T.HELLO,
                requestId: 0,
                sequence: 0,
                payload: protocol.encodeHello(this.sessionNonce, this.requestedFeatures),
            });

            const deadline = monotonicNow() + this.timeoutMs;
            for (;;) {
                const remaining = Math.max(1, deadline - monotonicNow());
                const reply = await this.nextFrame(0, [T.HELLO_ACK], remaining);
                if (!(reply.flags & F.RESPONSE) || reply.sequence !== 0) continue;
                let info;
                try {
                    info = protocol.decodeHelloAck(reply.payload);
                } catch (error) {
                    this.handleProtocolError({ kind: "invalid-hello-ack", message: error.message });
                    continue;
                }
                if (!equalBytes(info.nonce, this.sessionNonce)) continue;
                if (info.features & ~this.requestedFeatures) {
                    throw new Error("V8FT agent negotiated features the host did not request");
                }
                if (info.maxPayloadBytes < 1 || info.maxPayloadBytes > protocol.MAX_PAYLOAD_BYTES) {
                    throw new Error("V8FT agent advertised an invalid payload limit");
                }
                this.serverInfo = info;
                this.connected = true;
                return Object.assign({}, info, { nonce: info.nonce.slice() });
            }
        }

        ensureConnected() {
            return this.connected ? Promise.resolve(this.serverInfo) : this.connectInternal();
        }

        async requireFeature(feature, name) {
            await this.ensureConnected();
            if (!(this.serverInfo.features & feature)) {
                throw new Error("V8FT agent did not negotiate " + name);
            }
            return this.serverInfo;
        }

        resetAfterRestore() {
            this.connected = false;
            this.serverInfo = null;
            this.sessionNonce = null;
            this.transport.reset();
            this.activeTransfer = null;
            this.failAll(new Error("v86 state was restored during a V8FT request"));
        }

        uart0InputLength() {
            const input = this.emulator && this.emulator.v86 && this.emulator.v86.cpu &&
                this.emulator.v86.cpu.devices && this.emulator.v86.cpu.devices.uart0 &&
                this.emulator.v86.cpu.devices.uart0.input;
            return input && typeof input.length === "number" ? input.length : null;
        }

        clearUart0Input() {
            // v86 has no public API for dropping host->guest UART bytes. This is
            // the sole compatibility escape hatch and must be re-audited when
            // upgrading v86; callers treat a missing internal path as harmless.
            const uart0 = this.emulator && this.emulator.v86 && this.emulator.v86.cpu &&
                this.emulator.v86.cpu.devices && this.emulator.v86.cpu.devices.uart0;
            if (!uart0 || !uart0.input || typeof uart0.input.length !== "number") return false;
            uart0.input.length = 0;
            return true;
        }

        destroy() {
            this.failAll(new Error("V8FT client destroyed"));
            this.transport.destroy();
            this.connected = false;
            this.serverInfo = null;
            this.emulator = null;
        }

        validateResponse(frame, sequence) {
            if (!(frame.flags & F.RESPONSE)) throw new Error("V8FT response flag is missing");
            if (frame.sequence !== sequence) throw new Error("V8FT response sequence mismatch");
        }

        handleFrame(frame) {
            const waiter = this.waiters.get(frame.requestId);
            if (waiter) {
                this.waiters.delete(frame.requestId);
                clearTimeout(waiter.timer);
                if (frame.type === T.ERROR) waiter.reject(this.errorFromFrame(frame));
                else if (!waiter.types.includes(frame.type)) {
                    waiter.reject(new Error("unexpected V8FT message type 0x" + frame.type.toString(16)));
                } else waiter.resolve(frame);
                return;
            }
            const queue = this.inbox.get(frame.requestId) || [];
            if (queue.length >= 1024) {
                this.failAll(new Error("V8FT response inbox overflowed"));
                this.connected = false;
                return;
            }
            queue.push(frame);
            this.inbox.set(frame.requestId, queue);
        }

        handleProtocolError(error) {
            if (this.protocolErrors.length >= 32) this.protocolErrors.shift();
            this.protocolErrors.push(error);
            if (typeof this.options.onProtocolError === "function") this.options.onProtocolError(error);
        }

        nextFrame(requestId, types, timeoutMs) {
            const queue = this.inbox.get(requestId);
            if (queue && queue.length) {
                const frame = queue.shift();
                if (!queue.length) this.inbox.delete(requestId);
                if (frame.type === T.ERROR) return Promise.reject(this.errorFromFrame(frame));
                if (!types.includes(frame.type)) {
                    return Promise.reject(new Error("unexpected queued V8FT message type 0x" + frame.type.toString(16)));
                }
                return Promise.resolve(frame);
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.waiters.delete(requestId);
                    const error = new Error("V8FT request " + requestId + " timed out");
                    error.code = "V8FT_TIMEOUT";
                    reject(error);
                }, timeoutMs);
                this.waiters.set(requestId, { types, resolve, reject, timer });
            });
        }

        errorFromFrame(frame) {
            let code = protocol.ErrorCode.BAD_REQUEST;
            try {
                code = protocol.decodeError(frame.payload);
            } catch (error) {
                this.handleProtocolError({ kind: "invalid-error-payload", message: error.message });
            }
            const result = new Error("V8FT agent error " + code + " for request " + frame.requestId);
            result.code = code;
            result.requestId = frame.requestId;
            return result;
        }

        failAll(error) {
            for (const waiter of this.waiters.values()) {
                clearTimeout(waiter.timer);
                waiter.reject(error);
            }
            this.waiters.clear();
            this.inbox.clear();
        }

        allocateRequestId() {
            const value = this.nextRequestId++ >>> 0;
            if (!this.nextRequestId) this.nextRequestId = 1;
            return value || this.allocateRequestId();
        }

        exclusive(name, operation) {
            if (this.activeOperation) {
                return Promise.reject(new Error("V8FT " + this.activeOperation + " is already active"));
            }
            this.activeOperation = name;
            return Promise.resolve().then(operation).finally(() => {
                this.activeOperation = null;
            });
        }
    }

    function monotonicNow() {
        return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    }

    function randomNonce() {
        const nonce = new Uint8Array(16);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(nonce);
        else for (let i = 0; i < nonce.length; i++) nonce[i] = Math.floor(Math.random() * 256);
        return nonce;
    }

    function requireBytes(value) {
        if (!(value instanceof Uint8Array)) throw new TypeError("payload must be a Uint8Array");
        if (value.length > protocol.MAX_PAYLOAD_BYTES) throw new RangeError("payload exceeds V8FT limit");
        return value;
    }

    function equalBytes(left, right) {
        if (left.length !== right.length) return false;
        for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
        return true;
    }

    async function normalizePutFiles(inputs) {
        if (!Array.isArray(inputs)) throw new TypeError("PUT files must be an array");
        const result = [];
        for (const input of inputs) {
            if (!input || typeof input !== "object") throw new TypeError("PUT file entry is required");
            const source = input.file || input;
            const path = input.path || source.webkitRelativePath || source.name;
            const bytes = input.bytes;
            if (bytes instanceof Uint8Array) {
                result.push({ path, bytes, sizeBytes: bytes.length });
            } else {
                if (!source || !Number.isInteger(source.size) || source.size < 0 ||
                    typeof source.slice !== "function") {
                    throw new TypeError("PUT file bytes must be a Uint8Array or Blob/File");
                }
                result.push({ path, source, sizeBytes: source.size });
            }
        }
        return result;
    }

    async function calculatePutFileCrc(file, options, fileIndex, totalBytes) {
        if (!file.sizeBytes) return 0;
        const chunkBytes = positiveInteger(options.hashChunkBytes, 1024 * 1024);
        let state = 0xFFFFFFFF;
        for (let offset = 0; offset < file.sizeBytes;) {
            if (options.signal && options.signal.aborted) throw localCancelledError();
            const data = await readPutFile(file, offset,
                Math.min(chunkBytes, file.sizeBytes - offset));
            state = protocol.crc32Update(state, data);
            offset += data.length;
            if (typeof options.onHashChunk === "function") {
                await options.onHashChunk({
                    fileIndex, path: file.path, hashedBytes: offset,
                    fileSizeBytes: file.sizeBytes, totalBytes,
                });
            }
            await yieldToEventLoop();
        }
        return (state ^ 0xFFFFFFFF) >>> 0;
    }

    async function readPutFile(file, offset, length) {
        if (file.bytes) return file.bytes.subarray(offset, offset + length);
        const buffer = await file.source.slice(offset, offset + length).arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (bytes.length !== length) throw new Error("Blob/File slice returned an unexpected length");
        return bytes;
    }

    function yieldToEventLoop() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    function localCancelledError() {
        const error = new Error("V8FT transfer was cancelled before it reached the agent");
        error.code = protocol.ErrorCode.CANCELLED;
        return error;
    }

    function requireTransport(transport) {
        for (const method of ["send", "sendPreamble", "reset", "destroy"]) {
            if (!transport || typeof transport[method] !== "function") {
                throw new TypeError("V8FT transport must implement " + method + "()");
            }
        }
        return transport;
    }

    function positiveNumber(value, fallback) {
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    }

    function positiveInteger(value, fallback) {
        return Number.isSafeInteger(value) && value > 0 ? value : fallback;
    }

    function adaptiveChunkTimeout(chunkBytes, rate, options) {
        const minTimeout = positiveNumber(options.chunkTimeoutMinMs,
            DEFAULT_CHUNK_TIMEOUT_MIN_MS);
        const maxTimeout = positiveNumber(options.chunkTimeoutMaxMs,
            DEFAULT_CHUNK_TIMEOUT_MAX_MS);
        const transferMs = Math.max(0, chunkBytes) / Math.max(1, rate) * 3000;
        return Math.max(minTimeout, Math.min(maxTimeout, 3000 + transferMs));
    }

    function nonNegativeInteger(value, fallback) {
        return Number.isInteger(value) && value >= 0 ? value : fallback;
    }

    return { V8FTSerialTransport, V8FTClient };
});
