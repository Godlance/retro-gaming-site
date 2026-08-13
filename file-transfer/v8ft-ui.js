"use strict";

(function(root, factory) {
    const protocol = root && root.V8FTProtocol ||
        (typeof require === "function" ? require("./v8ft-protocol.js") : null);
    const api = factory(protocol);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.V86FileTransferUI = api.V86FileTransferUI;
})(typeof globalThis !== "undefined" ? globalThis : this, function(protocol) {
    const DOWNLOAD_RATE_BYTES_PER_SECOND = 600 * 1024;
    const UPLOAD_RATE_BYTES_PER_SECOND = 240 * 1024;
    const LONG_TRANSFER_CONFIRM_SECONDS = 60;

    class V86FileTransferUI {
        constructor(options) {
            this.options = options || {};
            this.manager = null;
            this.unsubscribe = null;
            this.opened = false;
            this.busy = false;
            this.shares = [];
            this.shareId = null;
            this.path = "";
            this.entries = [];
            this.selectedPaths = new Set();
            this.pendingFiles = [];
            this.lastFocused = null;
            this.bindElements();
            this.bindEvents();
            this.render();
        }

        bindElements() {
            const byId = id => document.getElementById(id);
            this.button = byId("file_transfer_btn");
            this.overlay = byId("file_transfer_overlay");
            this.closeButton = byId("file_transfer_close");
            this.connection = byId("file_transfer_connection");
            this.sharesElement = byId("file_transfer_shares");
            this.breadcrumbs = byId("file_transfer_breadcrumbs");
            this.refreshButton = byId("file_transfer_refresh");
            this.notice = byId("file_transfer_notice");
            this.entriesElement = byId("file_transfer_entries");
            this.empty = byId("file_transfer_empty");
            this.moreButton = byId("file_transfer_more");
            this.selectAll = byId("file_transfer_select_all");
            this.dropzone = byId("file_transfer_dropzone");
            this.chooseButton = byId("file_transfer_choose");
            this.uploadInput = byId("file_transfer_upload_input");
            this.uploadSummary = byId("file_transfer_upload_summary");
            this.uploadHint = byId("file_transfer_upload_hint");
            this.progress = byId("file_transfer_progress");
            this.progressTitle = byId("file_transfer_progress_title");
            this.progressDetail = byId("file_transfer_progress_detail");
            this.progressBar = byId("file_transfer_progress_bar");
            this.footerNote = byId("file_transfer_footer_note");
            this.cancelButton = byId("file_transfer_cancel");
            this.downloadButton = byId("file_transfer_download");
            this.uploadButton = byId("file_transfer_upload");
        }

        bindEvents() {
            this.button.addEventListener("click", () => this.open());
            this.closeButton.addEventListener("click", () => this.close());
            this.overlay.addEventListener("click", event => {
                if (event.target === this.overlay) this.close();
            });
            document.addEventListener("keydown", event => {
                if (event.key === "Escape" && this.opened) this.close();
            });
            this.refreshButton.addEventListener("click", () => this.loadDirectory(false));
            this.moreButton.addEventListener("click", () => this.loadDirectory(true));
            this.selectAll.addEventListener("change", () => this.selectAllFiles());
            this.chooseButton.addEventListener("click", () => this.uploadInput.click());
            this.uploadInput.addEventListener("change", () => {
                this.setPendingFiles(Array.from(this.uploadInput.files || []));
            });
            for (const eventName of ["dragenter", "dragover"]) {
                this.dropzone.addEventListener(eventName, event => {
                    event.preventDefault();
                    if (!this.busy) this.dropzone.classList.add("is-dragging");
                });
            }
            for (const eventName of ["dragleave", "drop"]) {
                this.dropzone.addEventListener(eventName, event => {
                    event.preventDefault();
                    this.dropzone.classList.remove("is-dragging");
                });
            }
            this.dropzone.addEventListener("drop", event => {
                if (!this.busy) this.setPendingFiles(Array.from(event.dataTransfer.files || []));
            });
            this.uploadButton.addEventListener("click", () => this.uploadFiles());
            this.downloadButton.addEventListener("click", () => this.downloadSelected());
            this.cancelButton.addEventListener("click", () => this.cancelTransfer());
        }

        attachManager(manager) {
            if (this.unsubscribe) this.unsubscribe();
            this.manager = manager || null;
            this.unsubscribe = null;
            this.resetBrowser();
            this.button.classList.toggle("hidden", !this.manager);
            if (this.manager) {
                this.unsubscribe = this.manager.subscribe(snapshot => {
                    this.connection.textContent = connectionLabel(snapshot);
                    this.connection.classList.toggle("is-ready", snapshot.connected);
                    this.renderActions();
                });
                if (this.opened) setTimeout(() => this.connect(), 0);
            } else if (this.opened) {
                this.setNotice("The emulator was replaced. Waiting for the new Windows XP instance…");
            }
            this.render();
        }

        async open() {
            if (!this.manager || this.opened) return;
            this.opened = true;
            this.lastFocused = document.activeElement;
            this.overlay.classList.remove("hidden");
            this.overlay.setAttribute("aria-hidden", "false");
            this.button.setAttribute("aria-expanded", "true");
            this.closeButton.focus();
            if (!this.shares.length) await this.connect();
        }

        close() {
            if (!this.opened) return;
            this.opened = false;
            this.overlay.classList.add("hidden");
            this.overlay.setAttribute("aria-hidden", "true");
            this.button.setAttribute("aria-expanded", "false");
            if (this.lastFocused && typeof this.lastFocused.focus === "function") {
                this.lastFocused.focus();
            }
        }

        async connect() {
            if (!this.manager) return;
            this.setBusy(true, "Connecting to Windows XP…");
            this.setNotice("Connecting to the Windows XP file agent…");
            try {
                const info = await this.manager.connect();
                this.shares = info.shares || await this.manager.shares();
                const writable = this.shares.find(share => !share.readOnly);
                const preferred = this.shares.find(share => share.id === "desktop");
                const first = preferred || writable || this.shares[0];
                this.renderShares();
                if (first) {
                    this.setBusy(false);
                    await this.selectShare(first.id);
                }
                else this.setNotice("The agent did not publish any available locations.", "error");
            } catch (error) {
                this.handleError(error, "Could not connect to the Windows XP file agent.");
            } finally {
                this.setBusy(false);
            }
        }

        async selectShare(shareId) {
            if (this.busy || !this.manager) return;
            this.shareId = shareId;
            this.path = "";
            this.selectedPaths.clear();
            this.clearPendingFiles();
            this.render();
            await this.loadDirectory(false);
        }

        async openDirectory(name) {
            if (this.busy) return;
            this.path = joinPath(this.path, name);
            this.selectedPaths.clear();
            this.clearPendingFiles();
            this.render();
            await this.loadDirectory(false);
        }

        async navigateTo(path) {
            if (this.busy) return;
            this.path = path;
            this.selectedPaths.clear();
            this.clearPendingFiles();
            this.render();
            await this.loadDirectory(false);
        }

        async loadDirectory(append) {
            if (!this.manager || !this.shareId || this.busy) return;
            this.setBusy(true, append ? "Loading more files…" : "Loading folder…");
            this.setNotice(append ? "Loading the next page…" : "Reading this Windows XP folder…");
            try {
                const page = await this.manager.listDirectory(this.shareId, this.path, {
                    pageSize: 128,
                    append: !!append,
                });
                this.entries = page.entries.slice().sort(compareEntries);
                if (!append) this.selectedPaths.clear();
                this.setNotice(directoryNotice(this.currentShare(), this.entries.length));
            } catch (error) {
                if (!append) this.entries = [];
                this.handleError(error, "Could not read this Windows XP folder.");
            } finally {
                this.setBusy(false);
                this.render();
            }
        }

        setPendingFiles(files) {
            if (this.busy) return;
            const accepted = files.filter(file => file && typeof file.slice === "function");
            this.pendingFiles = accepted;
            this.uploadInput.value = "";
            this.renderUploadSelection();
            this.renderActions();
            const limitError = this.pendingFilesError();
            if (limitError) this.setNotice(limitError, "error");
            else if (this.pendingFiles.length) {
                this.setNotice(plural(this.pendingFiles.length, "file") +
                    " ready to upload to this Windows XP folder.");
            } else this.setNotice(directoryNotice(this.currentShare(), this.entries.length));
        }

        toggleFile(path, checked) {
            if (checked) this.selectedPaths.add(path);
            else this.selectedPaths.delete(path);
            this.renderActions();
            this.updateSelectAll();
            this.updateSelectionNotice();
        }

        selectAllFiles() {
            const files = this.entries.filter(entry => !entry.isDirectory);
            for (const entry of files) {
                const path = joinPath(this.path, entry.name);
                if (this.selectAll.checked) this.selectedPaths.add(path);
                else this.selectedPaths.delete(path);
            }
            this.renderEntries();
            this.renderActions();
            this.updateSelectionNotice();
        }

        async uploadFiles() {
            const share = this.currentShare();
            if (!this.manager || !share || share.readOnly || !this.pendingFiles.length || this.busy) return;
            const existing = new Set(this.entries.map(entry => entry.name.toLocaleLowerCase()));
            const conflicts = this.pendingFiles.filter(file => existing.has(file.name.toLocaleLowerCase()));
            for (const conflict of conflicts) {
                if (!window.confirm("Replace the existing Windows XP file?\n\n" + conflict.name)) return;
            }
            const files = this.pendingFiles.map(file => ({ path: joinPath(this.path, file.name), file }));
            const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
            const estimateSeconds = totalBytes / UPLOAD_RATE_BYTES_PER_SECOND;
            if (estimateSeconds > LONG_TRANSFER_CONFIRM_SECONDS &&
                !window.confirm("This upload is expected to take about " +
                    formatDuration(estimateSeconds) + ".\n\nContinue uploading " +
                    plural(files.length, "file") + " to Windows XP?")) return;
            const started = now();
            this.setBusy(true, "Checking files…", true);
            this.showProgress("Checking " + plural(files.length, "file"), 0,
                formatBytes(totalBytes) + " total");
            try {
                const result = await this.manager.putFiles(this.shareId, files, {
                    onHashChunk: event => {
                        const completed = files.slice(0, event.fileIndex)
                            .reduce((sum, item) => sum + item.file.size, 0);
                        const percent = totalBytes ? Math.min(8,
                            (completed + event.hashedBytes) / totalBytes * 8) : 8;
                        this.showProgress("Checking " + event.path, percent,
                            formatBytes(event.hashedBytes) + " checked");
                    },
                    onChunk: event => {
                        const percent = totalBytes ? 8 + event.sentBytes / totalBytes * 90 : 98;
                        this.showProgress(event.sentBytes >= totalBytes ? "Committing files…" :
                            "Uploading " + basename(event.path), percent,
                            transferDetail(event.sentBytes, totalBytes,
                                event.measuredRateBytesPerSecond, started));
                    },
                });
                this.pendingFiles = [];
                this.uploadInput.value = "";
                this.showProgress("Upload complete", 100,
                    plural(result.fileCount, "file") + " · " + formatBytes(result.totalBytes));
                await this.loadDirectoryAfterOperation();
                this.setNotice("Upload complete. These files only persist in this browser session until you save state.",
                    "success");
            } catch (error) {
                if (isCancelled(error)) this.setNotice("Upload cancelled; existing files were preserved.");
                else this.handleError(error, "Upload failed.");
            } finally {
                this.setBusy(false);
                this.render();
            }
        }

        async downloadSelected() {
            if (!this.manager || !this.selectedPaths.size || this.selectedFilesError() || this.busy) return;
            const paths = Array.from(this.selectedPaths);
            const selectedEntries = this.entries.filter(entry =>
                this.selectedPaths.has(joinPath(this.path, entry.name)));
            const totalBytes = selectedEntries.reduce((sum, entry) => sum + Number(entry.sizeBytes), 0);
            const started = now();
            this.setBusy(true, "Downloading files…", true);
            this.showProgress("Downloading " + plural(paths.length, "file"), 0,
                formatBytes(totalBytes) + " total");
            try {
                const result = await this.manager.getFiles(this.shareId, paths, {
                    onChunk: event => {
                        const percent = totalBytes ? event.receivedTotalBytes / totalBytes * 98 : 98;
                        this.showProgress("Downloading " + basename(event.path), percent,
                            transferDetail(event.receivedTotalBytes, totalBytes,
                                event.measuredRateBytesPerSecond, started));
                    },
                });
                if (result.files.length === 1) {
                    this.downloadBlob(new Blob([result.files[0].bytes], { type: "application/octet-stream" }),
                        safeDownloadName(basename(result.files[0].path)));
                } else {
                    const zip = buildStoredZip(result.files.map(file => ({
                        name: relativeDownloadPath(this.path, file.path),
                        bytes: file.bytes,
                        crc32: file.crc32,
                    })));
                    this.downloadBlob(zip, "v86-files-" + timestamp() + ".zip");
                }
                this.showProgress("Download ready", 100,
                    plural(result.files.length, "file") + " · " + formatBytes(result.totalBytes));
                this.setNotice(result.files.length === 1 ?
                    "The selected file was sent to your Downloads folder." :
                    "The selected files were packaged as an uncompressed ZIP.", "success");
            } catch (error) {
                if (isCancelled(error)) this.setNotice("Download cancelled.");
                else this.handleError(error, "Download failed.");
            } finally {
                this.setBusy(false);
                this.renderActions();
            }
        }

        async cancelTransfer() {
            if (!this.manager || !this.busy) return;
            this.cancelButton.disabled = true;
            this.progressTitle.textContent = "Cancelling…";
            try { await this.manager.cancelActive(); }
            catch (error) { console.warn("V8FT cancel request failed", error); }
        }

        async loadDirectoryAfterOperation() {
            this.busy = false;
            await this.loadDirectory(false);
            this.busy = true;
        }

        currentShare() {
            return this.shares.find(share => share.id === this.shareId) || null;
        }

        clearPendingFiles() {
            this.pendingFiles = [];
            this.uploadInput.value = "";
        }

        downloadBlob(blob, filename) {
            return (this.options.saveBlob || saveBlob)(blob, filename);
        }

        pendingFilesError() {
            if (!this.pendingFiles.length || !this.manager || !this.manager.serverInfo) return null;
            const info = this.manager.serverInfo;
            const total = this.pendingFiles.reduce((sum, file) => sum + file.size, 0);
            const names = new Set();
            const duplicate = this.pendingFiles.find(file => {
                const name = file.name.toLocaleLowerCase();
                if (names.has(name)) return true;
                names.add(name);
                return false;
            });
            if (duplicate) return "More than one selected file is named " + duplicate.name +
                ". Choose only one file for each Windows XP filename.";
            const share = this.currentShare();
            const maxFileBytes = share && share.maxFileBytes ?
                Math.min(info.maxFileBytes, share.maxFileBytes) : info.maxFileBytes;
            const oversized = this.pendingFiles.find(file => file.size > maxFileBytes);
            if (oversized) return oversized.name + " exceeds the " +
                formatBytes(maxFileBytes) + " per-file limit.";
            if (this.pendingFiles.length > info.maxRequestFiles) return "Select at most " +
                info.maxRequestFiles + " files per upload.";
            if (total > info.maxRequestBytes) return "This upload exceeds the " +
                formatBytes(info.maxRequestBytes) + " request limit.";
            const sessionBytes = this.manager.sessionWriteBytes || 0;
            if (info.maxSessionWriteBytes && sessionBytes + total > info.maxSessionWriteBytes) {
                return "This upload exceeds the remaining session write limit. Reload the page to start a new session.";
            }
            return null;
        }

        selectedFilesError() {
            if (!this.selectedPaths.size || !this.manager || !this.manager.serverInfo) return null;
            const info = this.manager.serverInfo;
            const entries = this.entries.filter(entry =>
                this.selectedPaths.has(joinPath(this.path, entry.name)));
            const oversized = entries.find(entry => Number(entry.sizeBytes) > info.maxFileBytes);
            if (oversized) return oversized.name + " exceeds the " +
                formatBytes(info.maxFileBytes) + " per-file download limit.";
            if (entries.length > info.maxRequestFiles) return "Select at most " +
                info.maxRequestFiles + " files per download.";
            const total = entries.reduce((sum, entry) => sum + Number(entry.sizeBytes), 0);
            if (total > info.maxRequestBytes) return "The selected files exceed the " +
                formatBytes(info.maxRequestBytes) + " download limit.";
            return null;
        }

        updateSelectionNotice() {
            const error = this.selectedFilesError();
            if (error) this.setNotice(error, "error");
            else if (this.selectedPaths.size) {
                this.setNotice(plural(this.selectedPaths.size, "file") + " selected for download.");
            } else this.setNotice(directoryNotice(this.currentShare(), this.entries.length));
        }

        resetBrowser() {
            this.shares = [];
            this.shareId = null;
            this.path = "";
            this.entries = [];
            this.selectedPaths.clear();
            this.pendingFiles = [];
            this.busy = false;
            if (this.progress) this.progress.classList.add("hidden");
        }

        setBusy(busy, title, cancellable) {
            this.busy = busy;
            if (busy && title) this.progressTitle.textContent = title;
            this.cancelButton.classList.toggle("hidden", !busy || !cancellable);
            this.cancelButton.disabled = false;
            this.renderActions();
        }

        setNotice(message, kind) {
            this.notice.textContent = message;
            this.notice.classList.toggle("is-error", kind === "error");
            this.notice.classList.toggle("is-success", kind === "success");
        }

        showProgress(title, percent, detail) {
            this.progress.classList.remove("hidden");
            this.progressTitle.textContent = title;
            this.progressDetail.textContent = detail || "";
            this.progressBar.style.width = Math.max(0, Math.min(100, percent)) + "%";
        }

        handleError(error, fallback) {
            console.error(fallback, error);
            this.setNotice(errorMessage(error, fallback), "error");
        }

        render() {
            this.renderShares();
            this.renderBreadcrumbs();
            this.renderEntries();
            this.renderUploadSelection();
            this.renderActions();
        }

        renderShares() {
            this.sharesElement.replaceChildren();
            for (const share of this.shares) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "file-transfer-share";
                button.classList.toggle("is-active", share.id === this.shareId);
                button.disabled = this.busy;
                const label = document.createElement("span");
                label.textContent = share.label;
                const access = document.createElement("small");
                access.textContent = share.readOnly ? "READ ONLY" : "READ / WRITE";
                button.append(label, access);
                button.addEventListener("click", () => this.selectShare(share.id));
                this.sharesElement.appendChild(button);
            }
        }

        renderBreadcrumbs() {
            this.breadcrumbs.replaceChildren();
            const share = this.currentShare();
            if (!share) return;
            const segments = this.path ? this.path.split("/") : [];
            const items = [{ label: share.label, path: "" }];
            let accumulated = "";
            for (const segment of segments) {
                accumulated = joinPath(accumulated, segment);
                items.push({ label: segment, path: accumulated });
            }
            items.forEach((item, index) => {
                if (index) {
                    const separator = document.createElement("span");
                    separator.className = "file-transfer-crumb-separator";
                    separator.textContent = "/";
                    this.breadcrumbs.appendChild(separator);
                }
                const button = document.createElement("button");
                button.type = "button";
                button.className = "file-transfer-crumb";
                button.textContent = item.label;
                button.disabled = this.busy || item.path === this.path;
                button.addEventListener("click", () => this.navigateTo(item.path));
                this.breadcrumbs.appendChild(button);
            });
        }

        renderEntries() {
            this.entriesElement.replaceChildren();
            for (const entry of this.entries) {
                const row = document.createElement("tr");
                const checkCell = document.createElement("td");
                checkCell.className = "file-transfer-check-cell";
                if (!entry.isDirectory) {
                    const checkbox = document.createElement("input");
                    checkbox.type = "checkbox";
                    const path = joinPath(this.path, entry.name);
                    checkbox.checked = this.selectedPaths.has(path);
                    checkbox.disabled = this.busy;
                    checkbox.setAttribute("aria-label", "Select " + entry.name);
                    checkbox.addEventListener("change", () => this.toggleFile(path, checkbox.checked));
                    checkCell.appendChild(checkbox);
                }
                const nameCell = document.createElement("td");
                const nameWrap = document.createElement("span");
                nameWrap.className = "file-transfer-entry-name";
                const icon = document.createElement("span");
                icon.className = "file-transfer-entry-icon";
                icon.textContent = entry.isDirectory ? "▱" : "·";
                if (entry.isDirectory) {
                    const open = document.createElement("button");
                    open.type = "button";
                    open.className = "file-transfer-entry-open";
                    open.textContent = entry.name;
                    open.disabled = this.busy;
                    open.addEventListener("click", () => this.openDirectory(entry.name));
                    nameWrap.append(icon, open);
                } else {
                    const text = document.createElement("span");
                    text.textContent = entry.name;
                    nameWrap.append(icon, text);
                }
                nameCell.appendChild(nameWrap);
                row.append(checkCell, nameCell,
                    cell(entry.isDirectory ? "Folder" : fileType(entry.name)),
                    cell(entry.isDirectory ? "—" : formatBytes(Number(entry.sizeBytes))),
                    cell(formatFiletime(entry.mtimeFiletime)));
                this.entriesElement.appendChild(row);
            }
            this.empty.classList.toggle("hidden", !!this.entries.length);
            this.empty.textContent = this.shareId ? "This folder is empty." : "No folder selected.";
            const snapshot = this.manager && this.manager.snapshot();
            this.moreButton.classList.toggle("hidden", !(snapshot && snapshot.directory &&
                snapshot.directory.nextCursor));
            this.updateSelectAll();
        }

        renderUploadSelection() {
            const totalBytes = this.pendingFiles.reduce((sum, file) => sum + file.size, 0);
            if (!this.pendingFiles.length) {
                this.uploadSummary.textContent = "Choose one or more files";
                this.uploadHint.textContent = "Files upload to the folder shown above.";
                return;
            }
            this.uploadSummary.textContent = plural(this.pendingFiles.length, "file") + " ready · " +
                formatBytes(totalBytes);
            const quota = sessionQuotaText(this.manager);
            this.uploadHint.textContent = this.pendingFiles.slice(0, 3)
                .map(file => file.name + " (" + formatBytes(file.size) + ")").join(", ") +
                (this.pendingFiles.length > 3 ? " and " + (this.pendingFiles.length - 3) + " more" : "") +
                " · about " + formatDuration(totalBytes / UPLOAD_RATE_BYTES_PER_SECOND) +
                (quota ? " · " + quota : "");
        }

        renderActions() {
            const share = this.currentShare();
            const canUpload = !!(this.manager && share && !share.readOnly && this.pendingFiles.length &&
                !this.pendingFilesError() && !this.busy);
            this.chooseButton.disabled = !this.manager || !share || share.readOnly || this.busy;
            this.uploadButton.disabled = !canUpload;
            this.downloadButton.disabled = !this.manager || !this.selectedPaths.size ||
                !!this.selectedFilesError() || this.busy;
            this.refreshButton.disabled = !this.manager || !share || this.busy;
            this.selectAll.disabled = !this.entries.some(entry => !entry.isDirectory) || this.busy;
            this.dropzone.hidden = !!(share && share.readOnly);
            this.footerNote.textContent = share && share.readOnly ?
                "This Windows XP location is read-only. Select files above to download them." :
                "Uploaded files only persist in this browser session until you save state.";
            if (this.selectedPaths.size) {
                const entries = this.entries.filter(entry =>
                    this.selectedPaths.has(joinPath(this.path, entry.name)));
                const bytes = entries.reduce((sum, entry) => sum + Number(entry.sizeBytes), 0);
                this.downloadButton.textContent = "Download " + this.selectedPaths.size +
                    " selected · " + formatDuration(bytes / DOWNLOAD_RATE_BYTES_PER_SECOND);
            } else this.downloadButton.textContent = "Download selected";
        }

        updateSelectAll() {
            const paths = this.entries.filter(entry => !entry.isDirectory)
                .map(entry => joinPath(this.path, entry.name));
            const selected = paths.filter(path => this.selectedPaths.has(path)).length;
            this.selectAll.checked = !!paths.length && selected === paths.length;
            this.selectAll.indeterminate = selected > 0 && selected < paths.length;
        }
    }

    function connectionLabel(snapshot) {
        if (snapshot.connected) return snapshot.operation === "idle" ? "Connected" : snapshot.operation;
        if (snapshot.status === "connecting") return "Connecting";
        return "Offline";
    }

    function directoryNotice(share, count) {
        if (!share) return "No location selected.";
        return plural(count, "item") + (share.readOnly ? " · read-only location" : " · uploads allowed");
    }

    function compareEntries(left, right) {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
    }

    function joinPath(parent, name) { return parent ? parent + "/" + name : name; }
    function basename(path) { return path.split("/").pop() || "download.bin"; }
    function plural(count, word) { return count + " " + word + (count === 1 ? "" : "s"); }
    function now() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

    function cell(text) {
        const element = document.createElement("td");
        element.textContent = text;
        return element;
    }

    function fileType(name) {
        const index = name.lastIndexOf(".");
        return index > 0 ? name.slice(index + 1).toUpperCase() : "File";
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return "—";
        if (bytes < 1024) return bytes + " B";
        const units = ["KiB", "MiB", "GiB"];
        let value = bytes / 1024;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
        return value.toFixed(value >= 10 ? 1 : 2) + " " + units[unit];
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 1) return "< 1 sec";
        if (seconds < 60) return Math.ceil(seconds) + " sec";
        const minutes = Math.floor(seconds / 60);
        const remainder = Math.ceil(seconds % 60);
        return minutes + " min" + (remainder ? " " + remainder + " sec" : "");
    }

    function transferDetail(done, total, rate, started) {
        const elapsed = Math.max(0, (now() - started) / 1000);
        const remaining = Math.max(0, total - done) / Math.max(1, rate || 1);
        return formatBytes(done) + " / " + formatBytes(total) + " · " +
            formatBytes(rate || 0) + "/s · " + formatDuration(remaining) + " left · " +
            formatDuration(elapsed) + " elapsed";
    }

    function sessionQuotaText(manager) {
        const info = manager && manager.serverInfo;
        if (!info || !info.maxSessionWriteBytes) return "";
        return "session " + formatBytes(manager.sessionWriteBytes || 0) + " / " +
            formatBytes(info.maxSessionWriteBytes);
    }

    function formatFiletime(value) {
        try {
            const ticks = typeof value === "bigint" ? value : BigInt(value || 0);
            if (!ticks) return "—";
            const unixMs = Number(ticks / 10000n - 11644473600000n);
            const date = new Date(unixMs);
            return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
        } catch (error) { return "—"; }
    }

    function errorMessage(error, fallback) {
        const code = error && error.code;
        const messages = {
            3: "This Windows XP location is no longer available.",
            4: "This Windows XP location is read-only.",
            5: "The selected path is invalid.",
            6: "The selected path is outside the shared location.",
            7: "The selected path is too long for Windows XP.",
            10: "The selected file or folder no longer exists.",
            13: "Windows shortcuts and reparse points cannot be followed.",
            14: "Windows XP is currently using this file. Close it and try again.",
            15: "A selected file exceeds the per-file transfer limit.",
            16: "The selected files exceed the per-request transfer limit.",
            17: "This emulator has reached its session write limit. Reload the page to start a new session.",
            18: "The Windows XP disk does not have enough free space.",
            25: "The transfer was cancelled.",
            26: "The Windows XP file agent timed out.",
        };
        if (messages[code]) return messages[code];
        if (code === "V8FT_EMULATOR_PAUSED") return "Start or resume the emulator before transferring files.";
        if (code === "V86_OPERATION_BUSY") return "Another emulator operation is currently active.";
        if (code === "V8FT_TIMEOUT") return "The Windows XP file agent did not respond. Start V8FT.EXE and try again.";
        return fallback + (error && error.message ? " " + error.message : "");
    }

    function isCancelled(error) {
        return !!error && (error.code === 25 || (protocol && error.code === protocol.ErrorCode.CANCELLED));
    }

    function safeDownloadName(name) {
        const safe = String(name || "download.bin").replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
            .replace(/[. ]+$/g, "");
        return safe || "download.bin";
    }

    function relativeDownloadPath(rootPath, fullPath) {
        const prefix = rootPath ? rootPath + "/" : "";
        return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : basename(fullPath);
    }

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function timestamp() {
        return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    }

    function buildStoredZip(files) {
        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        let offset = 0;
        const nowDate = dosDateTime(new Date());
        for (const file of files) {
            const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
            const name = encoder.encode(String(file.name).replace(/\\/g, "/"));
            const crc32 = file.crc32 === undefined && protocol ? protocol.crc32(bytes) : file.crc32 >>> 0;
            const local = new Uint8Array(30 + name.length);
            const localView = new DataView(local.buffer);
            localView.setUint32(0, 0x04034B50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0x0800, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, nowDate.time, true);
            localView.setUint16(12, nowDate.date, true);
            localView.setUint32(14, crc32, true);
            localView.setUint32(18, bytes.length, true);
            localView.setUint32(22, bytes.length, true);
            localView.setUint16(26, name.length, true);
            local.set(name, 30);
            localParts.push(local, bytes);

            const central = new Uint8Array(46 + name.length);
            const centralView = new DataView(central.buffer);
            centralView.setUint32(0, 0x02014B50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0x0800, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, nowDate.time, true);
            centralView.setUint16(14, nowDate.date, true);
            centralView.setUint32(16, crc32, true);
            centralView.setUint32(20, bytes.length, true);
            centralView.setUint32(24, bytes.length, true);
            centralView.setUint16(28, name.length, true);
            centralView.setUint32(42, offset, true);
            central.set(name, 46);
            centralParts.push(central);
            offset += local.length + bytes.length;
        }
        const centralBytes = centralParts.reduce((sum, part) => sum + part.length, 0);
        const end = new Uint8Array(22);
        const endView = new DataView(end.buffer);
        endView.setUint32(0, 0x06054B50, true);
        endView.setUint16(8, files.length, true);
        endView.setUint16(10, files.length, true);
        endView.setUint32(12, centralBytes, true);
        endView.setUint32(16, offset, true);
        return new Blob(localParts.concat(centralParts, end), { type: "application/zip" });
    }

    function dosDateTime(date) {
        const year = Math.max(1980, date.getFullYear());
        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
            date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        };
    }

    return { V86FileTransferUI, buildStoredZip, safeDownloadName };
});
