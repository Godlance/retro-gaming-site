"use strict";

(function(root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.V8FTProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    const MAGIC = new Uint8Array([0x56, 0x38, 0x46, 0x54]); // V8FT
    const VERSION_MAJOR = 1;
    const VERSION_MINOR = 0;
    const HEADER_BYTES = 32;
    const MAX_PAYLOAD_BYTES = 32768;
    const VALID_FLAGS = 0x07;

    const Flags = Object.freeze({
        RESPONSE: 0x01,
        END: 0x02,
        RETRY: 0x04,
    });

    const MessageType = Object.freeze({
        HELLO: 0x01,
        HELLO_ACK: 0x02,
        PING: 0x03,
        PONG: 0x04,
        ECHO: 0x05,
        ECHO_REPLY: 0x06,
        SHARES_REQUEST: 0x10,
        SHARES_REPLY: 0x11,
        LIST_DIR_REQUEST: 0x20,
        LIST_DIR_ENTRY: 0x21,
        LIST_DIR_END: 0x22,
        PUT_BEGIN: 0x30,
        PUT_READY: 0x31,
        PUT_CHUNK: 0x32,
        PUT_ACK: 0x33,
        PUT_COMMIT: 0x34,
        PUT_RESULT: 0x35,
        GET_REQUEST: 0x40,
        GET_BEGIN: 0x41,
        GET_CHUNK: 0x42,
        GET_ACK: 0x43,
        GET_END: 0x44,
        CANCEL: 0x70,
        ERROR: 0x7F,
    });

    const Feature = Object.freeze({
        ECHO: 1 << 0,
        SHARES: 1 << 1,
        LIST: 1 << 2,
        GET: 1 << 3,
        PUT: 1 << 4,
        CANCEL: 1 << 5,
    });

    const ErrorCode = Object.freeze({
        OK: 0,
        UNSUPPORTED_VERSION: 1,
        AGENT_NOT_READY: 2,
        UNKNOWN_SHARE: 3,
        READ_ONLY_SHARE: 4,
        INVALID_PATH: 5,
        PATH_ESCAPE: 6,
        PATH_TOO_LONG: 7,
        INVALID_NAME: 8,
        INVALID_EXTENSION: 9,
        NOT_FOUND: 10,
        NOT_A_DIRECTORY: 11,
        IS_A_DIRECTORY: 12,
        REPARSE_POINT: 13,
        SHARING_VIOLATION: 14,
        FILE_TOO_LARGE: 15,
        REQUEST_TOO_LARGE: 16,
        SESSION_QUOTA_EXCEEDED: 17,
        DISK_FULL: 18,
        CRC_MISMATCH: 19,
        OUT_OF_ORDER: 20,
        STALE_CURSOR: 21,
        BUSY: 22,
        IO_ERROR: 23,
        ROLLBACK_FAILED: 24,
        CANCELLED: 25,
        TIMEOUT: 26,
        BAD_REQUEST: 27,
        UNSUPPORTED_FEATURE: 28,
    });

    const ShareAccess = Object.freeze({
        READ_ONLY: 0,
        READ_WRITE: 1,
    });

    const ListEntryFlags = Object.freeze({
        DIRECTORY: 1 << 0,
        REPARSE_POINT: 1 << 1,
    });

    let crcTable = null;

    function getCrcTable() {
        if (crcTable) return crcTable;
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let value = i;
            for (let bit = 0; bit < 8; bit++) {
                value = value & 1 ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
            }
            crcTable[i] = value >>> 0;
        }
        return crcTable;
    }

    function crc32Update(state, bytes, start, end) {
        const table = getCrcTable();
        const from = start === undefined ? 0 : start;
        const to = end === undefined ? bytes.length : end;
        let value = state >>> 0;
        for (let i = from; i < to; i++) {
            value = (value >>> 8) ^ table[(value ^ bytes[i]) & 0xFF];
        }
        return value >>> 0;
    }

    function crc32(bytes) {
        const input = asBytes(bytes, "CRC input");
        if (!input.length) return 0;
        return (crc32Update(0xFFFFFFFF, input) ^ 0xFFFFFFFF) >>> 0;
    }

    function encodeFrame(fields) {
        if (!fields || typeof fields !== "object") throw new TypeError("frame fields are required");
        const payload = fields.payload === undefined ? new Uint8Array(0) : asBytes(fields.payload, "payload");
        const type = u8(fields.type, "type");
        const flags = fields.flags === undefined ? 0 : u8(fields.flags, "flags");
        if (flags & ~VALID_FLAGS) throw new RangeError("unknown V8FT v1 flags");
        if (payload.length > MAX_PAYLOAD_BYTES) {
            throw new RangeError("V8FT payload exceeds " + MAX_PAYLOAD_BYTES + " bytes");
        }

        const frame = new Uint8Array(HEADER_BYTES + payload.length);
        frame.set(MAGIC, 0);
        const view = new DataView(frame.buffer);
        view.setUint8(4, fields.versionMajor === undefined ? VERSION_MAJOR : u8(fields.versionMajor, "versionMajor"));
        view.setUint8(5, fields.versionMinor === undefined ? VERSION_MINOR : u8(fields.versionMinor, "versionMinor"));
        view.setUint8(6, type);
        view.setUint8(7, flags);
        view.setUint32(8, u32(fields.requestId === undefined ? 0 : fields.requestId, "requestId"), true);
        view.setUint32(12, u32(fields.sequence === undefined ? 0 : fields.sequence, "sequence"), true);
        view.setUint32(16, payload.length, true);
        view.setUint32(20, crc32(payload), true);
        view.setUint32(24, 0, true);
        view.setUint32(28, crc32(frame.subarray(0, 28)), true);
        frame.set(payload, HEADER_BYTES);
        return frame;
    }

    class FrameParser {
        constructor(onFrame, onError) {
            if (typeof onFrame !== "function") throw new TypeError("onFrame callback is required");
            this.onFrame = onFrame;
            this.onError = typeof onError === "function" ? onError : function() {};
            this.header = new Uint8Array(HEADER_BYTES);
            this.reset();
        }

        reset() {
            this.discardedBytes = 0;
            this.restartSync();
        }

        restartSync(replay) {
            this.state = "sync";
            this.magicMatched = 0;
            this.headerOffset = 0;
            this.payload = null;
            this.payloadOffset = 0;
            this.current = null;
            if (replay) {
                for (let i = 0; i < replay.length; i++) this.pushByte(replay[i]);
            }
        }

        push(bytes) {
            const input = asBytes(bytes, "parser input");
            for (let i = 0; i < input.length; i++) this.pushByte(input[i]);
        }

        pushByte(byte) {
            const value = byte & 0xFF;
            if (this.state === "payload") {
                this.payload[this.payloadOffset++] = value;
                if (this.payloadOffset === this.payload.length) this.finishPayload();
                return;
            }
            if (this.state === "header") {
                this.header[this.headerOffset++] = value;
                if (this.headerOffset === HEADER_BYTES) this.finishHeader();
                return;
            }
            this.pushSyncByte(value);
        }

        pushSyncByte(value) {
            if (value === MAGIC[this.magicMatched]) {
                this.header[this.magicMatched++] = value;
                if (this.magicMatched === MAGIC.length) {
                    this.state = "header";
                    this.headerOffset = MAGIC.length;
                }
                return;
            }
            this.discardedBytes++;
            this.magicMatched = value === MAGIC[0] ? 1 : 0;
            if (this.magicMatched) this.header[0] = value;
        }

        finishHeader() {
            const replay = this.header.slice(1);
            const view = new DataView(this.header.buffer, this.header.byteOffset, HEADER_BYTES);
            const versionMajor = view.getUint8(4);
            const versionMinor = view.getUint8(5);
            const type = view.getUint8(6);
            const flags = view.getUint8(7);
            const requestId = view.getUint32(8, true);
            const sequence = view.getUint32(12, true);
            const payloadLength = view.getUint32(16, true);
            const payloadCrc32 = view.getUint32(20, true);
            const reserved = view.getUint32(24, true);
            const headerCrc32 = view.getUint32(28, true);
            const actualHeaderCrc32 = crc32(this.header.subarray(0, 28));

            let kind = null;
            if (actualHeaderCrc32 !== headerCrc32) kind = "header-crc";
            else if (versionMajor !== VERSION_MAJOR) kind = "unsupported-version";
            else if (flags & ~VALID_FLAGS) kind = "invalid-flags";
            else if (reserved !== 0) kind = "reserved-nonzero";
            else if (payloadLength > MAX_PAYLOAD_BYTES) kind = "payload-too-large";

            if (kind) {
                this.onError({
                    kind,
                    versionMajor,
                    versionMinor,
                    type,
                    flags,
                    requestId,
                    sequence,
                    payloadLength,
                    expectedHeaderCrc32: headerCrc32,
                    actualHeaderCrc32,
                });
                this.restartSync(replay);
                return;
            }

            this.current = {
                versionMajor,
                versionMinor,
                type,
                flags,
                requestId,
                sequence,
                payloadLength,
                payloadCrc32,
            };
            this.payload = new Uint8Array(payloadLength);
            this.payloadOffset = 0;
            this.state = "payload";
            if (!payloadLength) this.finishPayload();
        }

        finishPayload() {
            const frame = this.current;
            const payload = this.payload;
            const actualPayloadCrc32 = crc32(payload);
            if (actualPayloadCrc32 !== frame.payloadCrc32) {
                this.onError({
                    kind: "payload-crc",
                    requestId: frame.requestId,
                    sequence: frame.sequence,
                    expectedPayloadCrc32: frame.payloadCrc32,
                    actualPayloadCrc32,
                });
            } else {
                this.onFrame(Object.assign({}, frame, { payload }));
            }
            this.restartSync();
        }
    }

    class ByteRing {
        constructor(capacity) {
            if (!Number.isInteger(capacity) || capacity < 1) {
                throw new RangeError("ring capacity must be a positive integer");
            }
            this.bytes = new Uint8Array(capacity);
            this.readIndex = 0;
            this.writeIndex = 0;
            this.length = 0;
            this.overflowed = false;
        }

        push(value) {
            if (this.length === this.bytes.length) {
                this.overflowed = true;
                return false;
            }
            this.bytes[this.writeIndex] = value & 0xFF;
            this.writeIndex = (this.writeIndex + 1) % this.bytes.length;
            this.length++;
            return true;
        }

        shift() {
            if (!this.length) return -1;
            const value = this.bytes[this.readIndex];
            this.readIndex = (this.readIndex + 1) % this.bytes.length;
            this.length--;
            return value;
        }

        clear() {
            this.readIndex = 0;
            this.writeIndex = 0;
            this.length = 0;
            this.overflowed = false;
        }
    }

    function encodeHello(nonce, requestedFeatures) {
        const nonceBytes = fixedBytes(nonce, 16, "session nonce");
        const payload = new Uint8Array(20);
        payload.set(nonceBytes, 0);
        new DataView(payload.buffer).setUint32(16, u32(requestedFeatures || 0, "requestedFeatures"), true);
        return payload;
    }

    function decodeHello(payload) {
        const bytes = fixedBytes(payload, 20, "HELLO payload");
        return {
            nonce: bytes.slice(0, 16),
            requestedFeatures: readU32(bytes, 16),
        };
    }

    function encodeHelloAck(fields) {
        const buildBytes = new TextEncoder().encode(fields.buildId || "");
        if (buildBytes.length > 0xFFFF || 46 + buildBytes.length > MAX_PAYLOAD_BYTES) {
            throw new RangeError("HELLO_ACK build ID is too long");
        }
        const payload = new Uint8Array(46 + buildBytes.length);
        const view = new DataView(payload.buffer);
        payload.set(fixedBytes(fields.nonce, 16, "session nonce"), 0);
        view.setUint32(16, u32(fields.features || 0, "features"), true);
        view.setUint32(20, u32(fields.maxPayloadBytes, "maxPayloadBytes"), true);
        view.setUint32(24, u32(fields.maxFileBytes || 0, "maxFileBytes"), true);
        view.setUint32(28, u32(fields.maxRequestBytes || 0, "maxRequestBytes"), true);
        view.setUint32(32, u32(fields.maxSessionWriteBytes || 0, "maxSessionWriteBytes"), true);
        view.setUint16(36, u16(fields.maxRequestFiles || 0, "maxRequestFiles"), true);
        view.setUint16(38, u16(fields.maxDirEntriesPerPage || 0, "maxDirEntriesPerPage"), true);
        view.setUint16(40, u16(fields.agentMajor, "agentMajor"), true);
        view.setUint16(42, u16(fields.agentMinor, "agentMinor"), true);
        view.setUint16(44, buildBytes.length, true);
        payload.set(buildBytes, 46);
        return payload;
    }

    function decodeHelloAck(payload) {
        const bytes = asBytes(payload, "HELLO_ACK payload");
        if (bytes.length < 46) throw new RangeError("HELLO_ACK payload is truncated");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const buildLength = view.getUint16(44, true);
        if (46 + buildLength !== bytes.length) throw new RangeError("HELLO_ACK build ID length mismatch");
        return {
            nonce: bytes.slice(0, 16),
            features: view.getUint32(16, true),
            maxPayloadBytes: view.getUint32(20, true),
            maxFileBytes: view.getUint32(24, true),
            maxRequestBytes: view.getUint32(28, true),
            maxSessionWriteBytes: view.getUint32(32, true),
            maxRequestFiles: view.getUint16(36, true),
            maxDirEntriesPerPage: view.getUint16(38, true),
            agentMajor: view.getUint16(40, true),
            agentMinor: view.getUint16(42, true),
            buildId: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(46)),
        };
    }

    function encodeError(errorCode) {
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint32(0, u32(errorCode, "errorCode"), true);
        return payload;
    }

    function decodeError(payload) {
        const bytes = fixedBytes(payload, 4, "ERROR payload");
        return readU32(bytes, 0);
    }

    function encodeSharesReply(shares) {
        if (!Array.isArray(shares) || shares.length > 0xFFFF) {
            throw new RangeError("shares must be an array with at most 65535 entries");
        }
        const entries = shares.map((share, index) => {
            const id = encodeAsciiString(share.id, "share[" + index + "].id");
            const label = encodeUtf8String(share.label, "share[" + index + "].label");
            return { id, label, access: u8(share.access, "share access"),
                maxFileBytes: u32(share.maxFileBytes || 0, "share maxFileBytes") };
        });
        let length = 2;
        for (const entry of entries) length += 2 + entry.id.length + 2 + entry.label.length + 6;
        ensurePayloadLength(length, "SHARES_REPLY");
        const payload = new Uint8Array(length);
        const view = new DataView(payload.buffer);
        let offset = 0;
        view.setUint16(offset, entries.length, true);
        offset += 2;
        for (const entry of entries) {
            offset = writeString16(payload, view, offset, entry.id);
            offset = writeString16(payload, view, offset, entry.label);
            view.setUint8(offset++, entry.access);
            view.setUint8(offset++, 0);
            view.setUint32(offset, entry.maxFileBytes, true);
            offset += 4;
        }
        return payload;
    }

    function decodeSharesReply(payload) {
        const reader = new PayloadReader(payload, "SHARES_REPLY");
        const count = reader.u16();
        const shares = [];
        for (let index = 0; index < count; index++) {
            const id = reader.ascii16("share ID");
            const label = reader.utf8String16("share label");
            const access = reader.u8();
            const reserved = reader.u8();
            const maxFileBytes = reader.u32();
            if (reserved !== 0 || (access !== ShareAccess.READ_ONLY && access !== ShareAccess.READ_WRITE)) {
                throw new RangeError("SHARES_REPLY contains invalid access metadata");
            }
            shares.push({ id, label, access, readOnly: access === ShareAccess.READ_ONLY, maxFileBytes });
        }
        reader.finish();
        return shares;
    }

    function encodeListDirRequest(fields) {
        const shareId = encodeAsciiString(fields && fields.shareId, "shareId");
        const path = encodeRelativePath(fields && fields.path || "");
        const cursor = fields && fields.cursor || null;
        const cursorId = cursor ? u32(cursor.id, "cursor.id") : 0;
        const cursorOffset = cursor ? u32(cursor.offset, "cursor.offset") : 0;
        const pageSize = u16(fields && fields.pageSize, "pageSize");
        if (!pageSize) throw new RangeError("pageSize must be greater than zero");
        const payload = new Uint8Array(2 + shareId.length + 2 + path.length + 12);
        const view = new DataView(payload.buffer);
        let offset = writeString16(payload, view, 0, shareId);
        offset = writeString16(payload, view, offset, path);
        view.setUint32(offset, cursorId, true);
        view.setUint32(offset + 4, cursorOffset, true);
        view.setUint16(offset + 8, pageSize, true);
        view.setUint16(offset + 10, 0, true);
        return payload;
    }

    function decodeListDirRequest(payload) {
        const reader = new PayloadReader(payload, "LIST_DIR_REQUEST");
        const result = {
            shareId: reader.ascii16("share ID"),
            path: reader.relativePath16(),
            cursor: { id: reader.u32(), offset: reader.u32() },
            pageSize: reader.u16(),
        };
        if (reader.u16() !== 0 || !result.pageSize ||
            ((!result.cursor.id) !== (!result.cursor.offset))) {
            throw new RangeError("LIST_DIR_REQUEST contains invalid paging metadata");
        }
        reader.finish();
        return result;
    }

    function encodeListDirEntry(entry) {
        const name = encodeUtf8String(entry && entry.name, "directory entry name");
        const flags = u8(entry && entry.flags || 0, "directory entry flags");
        const size = toU64(entry && entry.sizeBytes || 0, "directory entry size");
        const mtime = toU64(entry && entry.mtimeFiletime || 0, "directory entry mtime");
        const payload = new Uint8Array(20 + name.length);
        const view = new DataView(payload.buffer);
        view.setUint8(0, flags);
        view.setUint8(1, 0);
        view.setUint16(2, name.length, true);
        writeU64(view, 4, size);
        writeU64(view, 12, mtime);
        payload.set(name, 20);
        return payload;
    }

    function decodeListDirEntry(payload) {
        const reader = new PayloadReader(payload, "LIST_DIR_ENTRY");
        const flags = reader.u8();
        if (reader.u8() !== 0) throw new RangeError("LIST_DIR_ENTRY reserved byte is nonzero");
        const nameLength = reader.u16();
        const sizeBytes = reader.u64();
        const mtimeFiletime = reader.u64();
        const name = reader.utf8String(nameLength, "directory entry name");
        reader.finish();
        return {
            name,
            flags,
            isDirectory: !!(flags & ListEntryFlags.DIRECTORY),
            isReparsePoint: !!(flags & ListEntryFlags.REPARSE_POINT),
            sizeBytes,
            mtimeFiletime,
        };
    }

    function encodeListDirEnd(cursor) {
        const payload = new Uint8Array(8);
        const view = new DataView(payload.buffer);
        if (cursor) {
            view.setUint32(0, u32(cursor.id, "cursor.id"), true);
            view.setUint32(4, u32(cursor.offset, "cursor.offset"), true);
        }
        return payload;
    }

    function decodeListDirEnd(payload) {
        const bytes = fixedBytes(payload, 8, "LIST_DIR_END payload");
        const id = readU32(bytes, 0);
        const offset = readU32(bytes, 4);
        if ((!id) !== (!offset)) throw new RangeError("LIST_DIR_END cursor is malformed");
        return id ? { id, offset } : null;
    }

    function encodeGetRequest(fields) {
        const shareId = encodeAsciiString(fields && fields.shareId, "shareId");
        const paths = fields && fields.paths;
        if (!Array.isArray(paths) || !paths.length || paths.length > 0xFFFF) {
            throw new RangeError("GET paths must contain 1..65535 entries");
        }
        const encodedPaths = paths.map(path => encodeRelativePath(path, false));
        let length = 2 + shareId.length + 2;
        for (const path of encodedPaths) length += 2 + path.length;
        ensurePayloadLength(length, "GET_REQUEST");
        const payload = new Uint8Array(length);
        const view = new DataView(payload.buffer);
        let offset = writeString16(payload, view, 0, shareId);
        view.setUint16(offset, encodedPaths.length, true);
        offset += 2;
        for (const path of encodedPaths) offset = writeString16(payload, view, offset, path);
        return payload;
    }

    function decodeGetRequest(payload) {
        const reader = new PayloadReader(payload, "GET_REQUEST");
        const shareId = reader.ascii16("share ID");
        const count = reader.u16();
        if (!count) throw new RangeError("GET_REQUEST has no paths");
        const paths = [];
        for (let index = 0; index < count; index++) paths.push(reader.relativePath16(false));
        reader.finish();
        return { shareId, paths };
    }

    function encodeGetBegin(files) {
        if (!Array.isArray(files) || !files.length || files.length > 0xFFFF) {
            throw new RangeError("GET_BEGIN files must contain 1..65535 entries");
        }
        const entries = files.map((file, index) => ({
            path: encodeRelativePath(file.path, false),
            sizeBytes: u32(file.sizeBytes, "file[" + index + "].sizeBytes"),
            crc32: u32(file.crc32, "file[" + index + "].crc32"),
        }));
        let length = 2;
        for (const entry of entries) length += 2 + entry.path.length + 8;
        ensurePayloadLength(length, "GET_BEGIN");
        const payload = new Uint8Array(length);
        const view = new DataView(payload.buffer);
        view.setUint16(0, entries.length, true);
        let offset = 2;
        for (const entry of entries) {
            offset = writeString16(payload, view, offset, entry.path);
            view.setUint32(offset, entry.sizeBytes, true);
            view.setUint32(offset + 4, entry.crc32, true);
            offset += 8;
        }
        return payload;
    }

    function decodeGetBegin(payload) {
        const reader = new PayloadReader(payload, "GET_BEGIN");
        const count = reader.u16();
        if (!count) throw new RangeError("GET_BEGIN has no files");
        const files = [];
        for (let index = 0; index < count; index++) {
            files.push({
                path: reader.relativePath16(false),
                sizeBytes: reader.u32(),
                crc32: reader.u32(),
            });
        }
        reader.finish();
        return files;
    }

    function encodeGetChunk(fields) {
        const data = asBytes(fields && fields.data, "GET chunk data");
        ensurePayloadLength(8 + data.length, "GET_CHUNK");
        const payload = new Uint8Array(8 + data.length);
        const view = new DataView(payload.buffer);
        view.setUint16(0, u16(fields.fileIndex, "fileIndex"), true);
        view.setUint16(2, 0, true);
        view.setUint32(4, u32(fields.offset, "offset"), true);
        payload.set(data, 8);
        return payload;
    }

    function decodeGetChunk(payload) {
        const bytes = asBytes(payload, "GET_CHUNK payload");
        if (bytes.length < 8) throw new RangeError("GET_CHUNK payload is truncated");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint16(2, true) !== 0) throw new RangeError("GET_CHUNK reserved field is nonzero");
        return {
            fileIndex: view.getUint16(0, true),
            offset: view.getUint32(4, true),
            data: bytes.slice(8),
        };
    }

    function encodeGetAck(fileIndex, nextOffset) {
        const payload = new Uint8Array(8);
        const view = new DataView(payload.buffer);
        view.setUint16(0, u16(fileIndex, "fileIndex"), true);
        view.setUint16(2, 0, true);
        view.setUint32(4, u32(nextOffset, "nextOffset"), true);
        return payload;
    }

    function decodeGetAck(payload) {
        const bytes = fixedBytes(payload, 8, "GET_ACK payload");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint16(2, true) !== 0) throw new RangeError("GET_ACK reserved field is nonzero");
        return { fileIndex: view.getUint16(0, true), nextOffset: view.getUint32(4, true) };
    }

    function encodeGetEnd(fileCount, totalBytes) {
        const payload = new Uint8Array(8);
        const view = new DataView(payload.buffer);
        view.setUint16(0, u16(fileCount, "fileCount"), true);
        view.setUint16(2, 0, true);
        view.setUint32(4, u32(totalBytes, "totalBytes"), true);
        return payload;
    }

    function decodeGetEnd(payload) {
        const bytes = fixedBytes(payload, 8, "GET_END payload");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint16(2, true) !== 0) throw new RangeError("GET_END reserved field is nonzero");
        return { fileCount: view.getUint16(0, true), totalBytes: view.getUint32(4, true) };
    }

    function encodePutBegin(fields) {
        const shareId = encodeAsciiString(fields && fields.shareId, "shareId");
        const files = fields && fields.files;
        if (!Array.isArray(files) || !files.length || files.length > 0xFFFF) {
            throw new RangeError("PUT files must contain 1..65535 entries");
        }
        const entries = files.map((file, index) => ({
            path: encodeRelativePath(file.path, false),
            sizeBytes: u32(file.sizeBytes, "file[" + index + "].sizeBytes"),
            crc32: u32(file.crc32, "file[" + index + "].crc32"),
        }));
        let length = 2 + shareId.length + 2;
        for (const entry of entries) length += 2 + entry.path.length + 8;
        ensurePayloadLength(length, "PUT_BEGIN");
        const payload = new Uint8Array(length);
        const view = new DataView(payload.buffer);
        let offset = writeString16(payload, view, 0, shareId);
        view.setUint16(offset, entries.length, true);
        offset += 2;
        for (const entry of entries) {
            offset = writeString16(payload, view, offset, entry.path);
            view.setUint32(offset, entry.sizeBytes, true);
            view.setUint32(offset + 4, entry.crc32, true);
            offset += 8;
        }
        return payload;
    }

    function decodePutBegin(payload) {
        const reader = new PayloadReader(payload, "PUT_BEGIN");
        const shareId = reader.ascii16("share ID");
        const count = reader.u16();
        if (!count) throw new RangeError("PUT_BEGIN has no files");
        const files = [];
        for (let index = 0; index < count; index++) {
            files.push({
                path: reader.relativePath16(false),
                sizeBytes: reader.u32(),
                crc32: reader.u32(),
            });
        }
        reader.finish();
        return { shareId, files };
    }

    function encodePutReady(fields) {
        const payload = new Uint8Array(12);
        const view = new DataView(payload.buffer);
        view.setUint16(0, u16(fields.fileCount, "fileCount"), true);
        view.setUint16(2, 0, true);
        view.setUint32(4, u32(fields.totalBytes, "totalBytes"), true);
        view.setUint32(8, u32(fields.sessionWriteBytes || 0, "sessionWriteBytes"), true);
        return payload;
    }

    function decodePutReady(payload) {
        const bytes = fixedBytes(payload, 12, "PUT_READY payload");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint16(2, true) !== 0) throw new RangeError("PUT_READY reserved field is nonzero");
        return {
            fileCount: view.getUint16(0, true),
            totalBytes: view.getUint32(4, true),
            sessionWriteBytes: view.getUint32(8, true),
        };
    }

    function encodePutChunk(fields) {
        return encodeGetChunk(fields);
    }

    function decodePutChunk(payload) {
        return decodeGetChunk(payload);
    }

    function encodePutAck(fileIndex, nextOffset, sessionWriteBytes) {
        const payload = new Uint8Array(12);
        const view = new DataView(payload.buffer);
        view.setUint16(0, u16(fileIndex, "fileIndex"), true);
        view.setUint16(2, 0, true);
        view.setUint32(4, u32(nextOffset, "nextOffset"), true);
        view.setUint32(8, u32(sessionWriteBytes || 0, "sessionWriteBytes"), true);
        return payload;
    }

    function decodePutAck(payload) {
        const bytes = fixedBytes(payload, 12, "PUT_ACK payload");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint16(2, true) !== 0) throw new RangeError("PUT_ACK reserved field is nonzero");
        return {
            fileIndex: view.getUint16(0, true),
            nextOffset: view.getUint32(4, true),
            sessionWriteBytes: view.getUint32(8, true),
        };
    }

    function encodePutResult(fields) {
        const payload = new Uint8Array(16);
        const view = new DataView(payload.buffer);
        view.setUint32(0, u32(fields.errorCode || 0, "errorCode"), true);
        view.setUint16(4, u16(fields.fileCount || 0, "fileCount"), true);
        view.setUint16(6, 0, true);
        view.setUint32(8, u32(fields.totalBytes || 0, "totalBytes"), true);
        view.setUint32(12, u32(fields.sessionWriteBytes || 0, "sessionWriteBytes"), true);
        return payload;
    }

    function decodePutResult(payload) {
        const bytes = fixedBytes(payload, 16, "PUT_RESULT payload");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint16(6, true) !== 0) throw new RangeError("PUT_RESULT reserved field is nonzero");
        return {
            errorCode: view.getUint32(0, true),
            fileCount: view.getUint16(4, true),
            totalBytes: view.getUint32(8, true),
            sessionWriteBytes: view.getUint32(12, true),
        };
    }

    function encodeCancel() { return new Uint8Array(0); }

    function decodeCancel(payload) {
        fixedBytes(payload, 0, "CANCEL payload");
        return true;
    }

    function readU32(bytes, offset) {
        const input = asBytes(bytes, "input");
        if (!Number.isInteger(offset) || offset < 0 || offset + 4 > input.length) {
            throw new RangeError("missing uint32 field");
        }
        return new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(offset, true);
    }

    class PayloadReader {
        constructor(payload, name) {
            this.bytes = asBytes(payload, name + " payload");
            this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
            this.offset = 0;
            this.name = name;
        }

        need(length) {
            if (this.offset + length > this.bytes.length) throw new RangeError(this.name + " payload is truncated");
        }

        u8() { this.need(1); return this.view.getUint8(this.offset++); }
        u16() { this.need(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
        u32() { this.need(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
        u64() {
            this.need(8);
            const low = BigInt(this.view.getUint32(this.offset, true));
            const high = BigInt(this.view.getUint32(this.offset + 4, true));
            this.offset += 8;
            return low | high << 32n;
        }
        bytesOf(length) { this.need(length); const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value; }
        utf8String(length, name) { return decodeUtf8(this.bytesOf(length), name); }
        utf8String16(name) { return this.utf8String(this.u16(), name); }
        ascii16(name) {
            const bytes = this.bytesOf(this.u16());
            for (const byte of bytes) if (byte < 0x21 || byte > 0x7E) throw new RangeError(name + " is not printable ASCII");
            return String.fromCharCode.apply(null, bytes);
        }
        relativePath16(allowEmpty) {
            const value = this.utf8String16("relative path");
            validateRelativePath(value, allowEmpty !== false);
            return value;
        }
        finish() { if (this.offset !== this.bytes.length) throw new RangeError(this.name + " payload has trailing bytes"); }
    }

    function encodeAsciiString(value, name) {
        if (typeof value !== "string" || !value.length) throw new TypeError(name + " must be a non-empty string");
        const bytes = new Uint8Array(value.length);
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code < 0x21 || code > 0x7E) throw new RangeError(name + " must be printable ASCII");
            bytes[index] = code;
        }
        if (bytes.length > 0xFFFF) throw new RangeError(name + " is too long");
        return bytes;
    }

    function encodeUtf8String(value, name) {
        if (typeof value !== "string") throw new TypeError(name + " must be a string");
        const bytes = new TextEncoder().encode(value);
        if (bytes.length > 0xFFFF) throw new RangeError(name + " is too long");
        return bytes;
    }

    function decodeUtf8(bytes, name) {
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch (error) { throw new RangeError(name + " is not valid UTF-8"); }
    }

    function encodeRelativePath(value, allowEmpty) {
        validateRelativePath(value, allowEmpty !== false);
        return encodeUtf8String(value, "relative path");
    }

    function validateRelativePath(value, allowEmpty) {
        if (typeof value !== "string") throw new TypeError("relative path must be a string");
        if (!value.length) {
            if (allowEmpty) return value;
            throw new RangeError("relative path must not be empty");
        }
        if (value[0] === "/" || value.includes("\\") || value.includes(":")) {
            throw new RangeError("relative path must use non-leading '/' separators");
        }
        const segments = value.split("/");
        if (segments.length > 32) throw new RangeError("relative path has too many segments");
        for (const segment of segments) {
            if (!segment || segment === "." || segment === "..") throw new RangeError("relative path has an invalid segment");
            if (/[\\/:*?"<>|\x00-\x1f]/.test(segment) || /[ .]$/.test(segment)) {
                throw new RangeError("relative path has an invalid name");
            }
            const base = segment.split(".", 1)[0].toUpperCase();
            if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
                throw new RangeError("relative path uses a Windows device name");
            }
            if (segment.toLowerCase() === ".v86-transfer") throw new RangeError("relative path targets reserved staging");
        }
        return value;
    }

    function writeString16(payload, view, offset, bytes) {
        view.setUint16(offset, bytes.length, true);
        payload.set(bytes, offset + 2);
        return offset + 2 + bytes.length;
    }

    function ensurePayloadLength(length, name) {
        if (length > MAX_PAYLOAD_BYTES) throw new RangeError(name + " exceeds V8FT payload limit");
    }

    function toU64(value, name) {
        const result = typeof value === "bigint" ? value : BigInt(value);
        if (result < 0n || result > 0xFFFFFFFFFFFFFFFFn) throw new RangeError(name + " must be uint64");
        return result;
    }

    function writeU64(view, offset, value) {
        view.setUint32(offset, Number(value & 0xFFFFFFFFn), true);
        view.setUint32(offset + 4, Number(value >> 32n), true);
    }

    function patternByte(offset) {
        return (((offset * 131) >>> 0) ^ (offset >>> 8) ^ 0xA5) & 0xFF;
    }

    function fillPattern(target, absoluteOffset) {
        const bytes = asBytes(target, "pattern target");
        for (let i = 0; i < bytes.length; i++) bytes[i] = patternByte(absoluteOffset + i);
        return bytes;
    }

    function asBytes(value, name) {
        if (!(value instanceof Uint8Array)) throw new TypeError(name + " must be a Uint8Array");
        return value;
    }

    function fixedBytes(value, length, name) {
        const bytes = asBytes(value, name);
        if (bytes.length !== length) throw new RangeError(name + " must contain " + length + " bytes");
        return bytes;
    }

    function u8(value, name) {
        if (!Number.isInteger(value) || value < 0 || value > 0xFF) throw new RangeError(name + " must be uint8");
        return value;
    }

    function u16(value, name) {
        if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) throw new RangeError(name + " must be uint16");
        return value;
    }

    function u32(value, name) {
        if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) throw new RangeError(name + " must be uint32");
        return value >>> 0;
    }

    return {
        MAGIC,
        VERSION_MAJOR,
        VERSION_MINOR,
        HEADER_BYTES,
        MAX_PAYLOAD_BYTES,
        VALID_FLAGS,
        Flags,
        MessageType,
        Feature,
        ErrorCode,
        ShareAccess,
        ListEntryFlags,
        ByteRing,
        FrameParser,
        crc32,
        crc32Update,
        encodeFrame,
        encodeHello,
        decodeHello,
        encodeHelloAck,
        decodeHelloAck,
        encodeError,
        decodeError,
        encodeSharesReply,
        decodeSharesReply,
        encodeListDirRequest,
        decodeListDirRequest,
        encodeListDirEntry,
        decodeListDirEntry,
        encodeListDirEnd,
        decodeListDirEnd,
        encodeGetRequest,
        decodeGetRequest,
        encodeGetBegin,
        decodeGetBegin,
        encodeGetChunk,
        decodeGetChunk,
        encodeGetAck,
        decodeGetAck,
        encodeGetEnd,
        decodeGetEnd,
        encodePutBegin,
        decodePutBegin,
        encodePutReady,
        decodePutReady,
        encodePutChunk,
        decodePutChunk,
        encodePutAck,
        decodePutAck,
        encodePutResult,
        decodePutResult,
        encodeCancel,
        decodeCancel,
        validateRelativePath,
        readU32,
        patternByte,
        fillPattern,
    };
});
