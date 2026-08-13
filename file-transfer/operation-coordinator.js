"use strict";

(function(root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.V86OperationCoordinator = api.V86OperationCoordinator;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    class V86OperationCoordinator {
        constructor() {
            this.state = "idle";
            this.activeId = 0;
            this.listeners = new Set();
        }

        tryBegin(kind) {
            validateKind(kind);
            if (this.state !== "idle") return null;
            const id = ++this.activeId;
            this.state = kind;
            this.notify();
            let ended = false;
            return {
                kind,
                end: () => {
                    if (ended || this.activeId !== id) return false;
                    ended = true;
                    this.state = "idle";
                    this.notify();
                    return true;
                },
            };
        }

        begin(kind) {
            const lease = this.tryBegin(kind);
            if (lease) return lease;
            const error = new Error("v86 operation is busy: " + this.state);
            error.code = "V86_OPERATION_BUSY";
            error.activeOperation = this.state;
            throw error;
        }

        async run(kind, operation) {
            if (typeof operation !== "function") throw new TypeError("operation callback is required");
            const lease = this.begin(kind);
            try {
                return await operation();
            } finally {
                lease.end();
            }
        }

        subscribe(listener) {
            if (typeof listener !== "function") throw new TypeError("listener must be a function");
            this.listeners.add(listener);
            listener(this.state);
            return () => this.listeners.delete(listener);
        }

        notify() {
            for (const listener of this.listeners) {
                try { listener(this.state); }
                catch (error) { console.error("V86 operation listener failed", error); }
            }
        }
    }

    function validateKind(kind) {
        if (typeof kind !== "string" || !kind || kind === "idle") {
            throw new TypeError("operation kind must be a non-idle string");
        }
    }

    return { V86OperationCoordinator };
});
