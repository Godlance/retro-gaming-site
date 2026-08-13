"use strict";

(function(root, factory) {
    const clientApi = root && root.V8FTClient ? { V8FTClient: root.V8FTClient } :
        (typeof require === "function" ? require("./v8ft-client.js") : null);
    const coordinatorApi = root && root.V86OperationCoordinator ?
        { V86OperationCoordinator: root.V86OperationCoordinator } :
        (typeof require === "function" ? require("./operation-coordinator.js") : null);
    const api = factory(clientApi, coordinatorApi);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.V86FileTransferManager = api.V86FileTransferManager;
})(typeof globalThis !== "undefined" ? globalThis : this, function(clientApi, coordinatorApi) {
    if (!clientApi || !clientApi.V8FTClient) throw new Error("V8FT client is required");
    if (!coordinatorApi || !coordinatorApi.V86OperationCoordinator) {
        throw new Error("v86 operation coordinator is required");
    }

    class V86FileTransferManager {
        constructor(emulator, options) {
            if (!emulator) throw new TypeError("an active v86 emulator is required");
            this.emulator = emulator;
            this.options = options || {};
            this.coordinator = this.options.coordinator ||
                new coordinatorApi.V86OperationCoordinator();
            this.client = this.options.client ||
                new clientApi.V8FTClient(emulator, this.options.clientOptions || {});
            this.status = "offline";
            this.serverInfo = null;
            this.shareCache = null;
            this.directoryView = null;
            this.sessionWriteBytes = 0;
            this.listeners = new Set();
            this.queueTail = Promise.resolve();
            this.queueDepth = 0;
            this.generation = 1;
            this.destroyed = false;
            this.activeAbortController = null;
            this.activeOperationLease = null;
            this.warnedMissingUartInput = false;
        }

        snapshot() {
            return {
                status: this.status,
                operation: this.coordinator.state,
                queueDepth: this.queueDepth,
                connected: !!this.client.connected,
                serverInfo: this.serverInfo,
                shares: this.shareCache ? this.shareCache.slice() : null,
                directory: this.directoryView ? Object.assign({}, this.directoryView, {
                    entries: this.directoryView.entries.slice(),
                }) : null,
                sessionWriteBytes: this.sessionWriteBytes,
            };
        }

        subscribe(listener) {
            if (typeof listener !== "function") throw new TypeError("listener must be a function");
            this.listeners.add(listener);
            listener(this.snapshot());
            return () => this.listeners.delete(listener);
        }

        connect() {
            return this.enqueue("browsing", async () => {
                const info = await this.ensureConnectedInternal();
                await this.loadSharesInternal(false);
                return Object.assign({}, info, { shares: this.shareCache.slice() });
            });
        }

        shares(options) {
            const force = !!(options && options.refresh);
            return this.enqueue("browsing", async () => {
                await this.ensureConnectedInternal();
                return (await this.loadSharesInternal(force)).slice();
            });
        }

        listDirectory(shareId, path, options) {
            const settings = options || {};
            return this.enqueue("browsing", async () => {
                await this.ensureConnectedInternal();
                await this.loadSharesInternal(false);
                this.requireShare(shareId);
                const relativePath = path || "";
                const append = !!settings.append;
                const cursor = settings.cursor || (append && this.directoryView &&
                    this.directoryView.shareId === shareId &&
                    this.directoryView.path === relativePath ? this.directoryView.nextCursor : null);
                const page = await this.client.listDirectory(shareId, relativePath, {
                    cursor,
                    pageSize: settings.pageSize,
                });
                const previous = append && this.directoryView &&
                    this.directoryView.shareId === shareId &&
                    this.directoryView.path === relativePath ? this.directoryView.entries : [];
                this.directoryView = {
                    shareId,
                    path: relativePath,
                    entries: previous.concat(page.entries),
                    nextCursor: page.nextCursor,
                };
                this.emit();
                return Object.assign({}, this.directoryView, {
                    entries: this.directoryView.entries.slice(),
                });
            });
        }

        putFiles(shareId, files, options) {
            const settings = options || {};
            return this.enqueue("uploading", async () => {
                await this.ensureConnectedInternal();
                await this.loadSharesInternal(false);
                const share = this.requireShare(shareId);
                if (share.readOnly) {
                    const error = new Error("V8FT share is read-only: " + shareId);
                    error.code = 4;
                    throw error;
                }
                const controller = new AbortController();
                this.activeAbortController = controller;
                const removeExternalAbort = forwardAbort(settings.signal, controller);
                try {
                    const result = await this.client.putFiles(shareId, files,
                        Object.assign({}, settings, {
                            signal: controller.signal,
                            onChunk: event => this.forwardProgress("uploading", event, settings.onChunk),
                        }));
                    this.sessionWriteBytes = result.sessionWriteBytes;
                    this.directoryView = null;
                    this.emit();
                    return result;
                } finally {
                    removeExternalAbort();
                    if (this.activeAbortController === controller) this.activeAbortController = null;
                }
            });
        }

        putFile(shareId, path, source, options) {
            const entry = source instanceof Uint8Array ? { path, bytes: source } : { path, file: source };
            return this.putFiles(shareId, [entry], options);
        }

        getFiles(shareId, paths, options) {
            const settings = options || {};
            return this.enqueue("downloading", async () => {
                await this.ensureConnectedInternal();
                await this.loadSharesInternal(false);
                this.requireShare(shareId);
                const controller = new AbortController();
                this.activeAbortController = controller;
                const removeExternalAbort = forwardAbort(settings.signal, controller);
                try {
                    return await this.client.getFiles(shareId, paths,
                        Object.assign({}, settings, {
                            signal: controller.signal,
                            onChunk: event => this.forwardProgress("downloading", event, settings.onChunk),
                        }));
                } finally {
                    removeExternalAbort();
                    if (this.activeAbortController === controller) this.activeAbortController = null;
                }
            });
        }

        async getFile(shareId, path, options) {
            const result = await this.getFiles(shareId, [path], options);
            return result.files[0];
        }

        async cancelActive() {
            const canceledLocally = !!this.activeAbortController;
            if (this.activeAbortController) this.activeAbortController.abort();
            const canceledAtAgent = await this.client.cancelActiveTransfer();
            return canceledLocally || canceledAtAgent;
        }

        async beginStateRestore() {
            this.ensureAlive();
            this.generation++;
            if (this.activeAbortController) this.activeAbortController.abort();
            try { await this.client.cancelActiveTransfer(); } catch (error) {}
            this.invalidateSession("restoring");
            this.client.resetAfterRestore();
        }

        clearRestoreInput(stage) {
            this.ensureAlive();
            if (this.client.clearUart0Input()) return true;
            if (!this.warnedMissingUartInput) {
                this.warnedMissingUartInput = true;
                console.warn("V8FT could not clear v86 uart0.input during " + stage +
                    "; falling back to protocol resynchronization");
            }
            return false;
        }

        finishStateRestoreBeforeRun() {
            this.ensureAlive();
            this.clearRestoreInput("post-restore");
            this.client.resetAfterRestore();
            this.invalidateSession("restoring");
        }

        reconnectAfterRestore() {
            if (this.destroyed) return Promise.resolve(null);
            return this.connect().catch(error => {
                if (!this.destroyed) {
                    this.status = "offline";
                    this.emit({ kind: "offline", error });
                }
                return null;
            });
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.generation++;
            if (this.activeAbortController) this.activeAbortController.abort();
            if (this.activeOperationLease) {
                this.activeOperationLease.end();
                this.activeOperationLease = null;
            }
            this.client.destroy();
            this.emulator = null;
            this.invalidateSession("destroyed");
            this.listeners.clear();
        }

        enqueue(kind, operation) {
            this.ensureAlive();
            const generation = this.generation;
            this.queueDepth++;
            this.emit();
            const scheduled = this.queueTail.catch(function() {}).then(async () => {
                if (this.destroyed || generation !== this.generation) {
                    throw staleError();
                }
                const lease = this.coordinator.begin(kind);
                this.activeOperationLease = lease;
                try {
                    this.status = kind;
                    this.emit();
                    try {
                        return await operation();
                    } finally {
                        if (!this.destroyed && this.status === kind) {
                            this.status = this.client.connected ? "ready" : "offline";
                            this.emit();
                        }
                    }
                } finally {
                    lease.end();
                    if (this.activeOperationLease === lease) this.activeOperationLease = null;
                }
            }).finally(() => {
                this.queueDepth--;
                if (!this.destroyed) this.emit();
            });
            this.queueTail = scheduled.catch(function() {});
            return scheduled;
        }

        async ensureConnectedInternal() {
            this.ensureAlive();
            if (!isEmulatorRunning(this.emulator)) {
                const error = new Error("V8FT transfer requires a running emulator");
                error.code = "V8FT_EMULATOR_PAUSED";
                throw error;
            }
            if (!this.client.connected) {
                this.status = "connecting";
                this.emit();
                this.serverInfo = await this.client.connect();
            } else this.serverInfo = this.client.serverInfo;
            this.status = "ready";
            this.emit();
            return this.serverInfo;
        }

        async loadSharesInternal(force) {
            if (!this.shareCache || force) {
                this.shareCache = await this.client.shares();
                this.emit();
            }
            return this.shareCache;
        }

        requireShare(shareId) {
            const share = this.shareCache && this.shareCache.find(item => item.id === shareId);
            if (!share) {
                const error = new Error("unknown V8FT share: " + shareId);
                error.code = 3;
                throw error;
            }
            return share;
        }

        async forwardProgress(kind, event, callback) {
            this.emit({ kind: "progress", operation: kind, progress: event });
            if (typeof callback === "function") await callback(event);
        }

        invalidateSession(status) {
            this.status = status;
            this.serverInfo = null;
            this.shareCache = null;
            this.directoryView = null;
            this.sessionWriteBytes = 0;
            this.emit();
        }

        ensureAlive() {
            if (this.destroyed) throw new Error("V8FT manager is destroyed");
        }

        emit(detail) {
            if (!this.listeners.size) return;
            const snapshot = this.snapshot();
            for (const listener of this.listeners) {
                try { listener(snapshot, detail || null); }
                catch (error) { console.error("V8FT manager listener failed", error); }
            }
        }
    }

    function isEmulatorRunning(emulator) {
        return !emulator || typeof emulator.is_running !== "function" || emulator.is_running();
    }

    function forwardAbort(signal, controller) {
        if (!signal || typeof signal.addEventListener !== "function") return function() {};
        const abort = () => controller.abort();
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        return () => signal.removeEventListener("abort", abort);
    }

    function staleError() {
        const error = new Error("V8FT request was invalidated by emulator lifecycle change");
        error.code = "V8FT_STALE_MANAGER_REQUEST";
        return error;
    }

    return { V86FileTransferManager };
});
