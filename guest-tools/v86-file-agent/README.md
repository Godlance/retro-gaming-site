# v86 file agent development

This directory contains the release `V8FT` v1 agent. Phase 3 adds transactional
PUT, cancellation, write quotas, idempotent
chunk retry, rollback, and crash recovery to the Phase 2 share/LIST/GET base.

Phase 2 was validated on the real Windows XP image on 2026-08-11:
`PATHSAFE.EXE` passed, the three default read-only shares were enumerated, the
system-drive root was listed, and `WINDOWS/win.ini` downloaded as 477 bytes with
CRC32 `9695d435`.

Phase 3 was validated on real Windows XP on 2026-08-12. `PATHSAFE.EXE` and
`PUTTEST.EXE` both passed, the agent opened COM3, and the browser negotiated all
six features (`63`). A transactional 18-byte upload to `desktop` returned
`errorCode: 0` and GET read back the exact original text.

## Build and run the V8FT agent

```sh
./guest-tools/v86-file-agent/build-v1.sh
```

The result is `v8ft_agent.exe`, a Windows XP-compatible PE32 console program
with no CRT dependency. Copy it into XP and run:

```bat
v8ft_agent.exe
```

On macOS, create an ISO for the existing **Insert CD** control:

```sh
./guest-tools/v86-file-agent/build-v1-iso.sh
```

The release CD contains only `V8FT.EXE` and `V8FT.INI`.

It scans COM1-COM9. To select the current XP mapping explicitly:

```bat
set V86FT_COM=COM3
v8ft_agent.exe
```

The COM number is only a Windows name. The selected device must be a standard
**Communications Port** whose resources are I/O `03F8-03FF` and IRQ `4`, which
is where v86 UART0 is fixed. A **Multiport Communications Port**, a one-byte
range such as `0247-0247`, or unknown resources is the wrong device even if it
is named COM3. Uninstall that device and add `[Standard port types] ->
Communications Port` manually.

Page reload and loading an older state restore that state's Windows registry,
PnP database, and dirty disk cache. After installing and verifying the port,
capture a new state; otherwise the next reload can legitimately bring the old
device configuration back.

Launch the browser page with `v8ft=1`. Phase 4 exposes the lifecycle-aware,
queued entry point as `window.v86FileTransferManager` (the lower-level client
remains available as `window.v86FileTransferV1` for protocol diagnostics):

```js
const ft = window.v86FileTransferManager
await ft.connect()
console.table(await ft.shares())
const page = await ft.listDirectory("system", "", { pageSize: 64 })
console.table(page.entries)
const winini = await ft.getFile("system", "WINDOWS/win.ini")
console.log(winini.sizeBytes, winini.crc32.toString(16), winini.bytes)

const uploaded = await ft.putFile(
  "desktop",
  "v8ft-test.bin",
  new Uint8Array([1, 2, 3, 4]),
  { onChunk(progress) { console.log(progress.sentBytes, progress.totalBytes) } }
)
console.log(uploaded)

const unsubscribe = ft.subscribe((state, event) => console.log(state, event))
// During an active GET or PUT, run: await ft.cancelActive()
unsubscribe()
```

The manager caches shares, serializes browse/upload/download requests, tracks
the current directory cursor, and prevents transfers from racing save/restore.
Call `listDirectory(..., { append: true })` to consume its cached next cursor.
`getFiles()` accepts multiple paths. Set
`{ collect: false, onChunk(chunk) { ... } }` to consume data without allocating
a complete browser-side copy.

`putFiles()` accepts `{ path, bytes }` entries, where `bytes` is a
`Uint8Array`, and browser `File`/`Blob` inputs. `File`/`Blob` data is hashed and
sent through bounded `slice()` reads rather than one whole-file allocation.
Uploads are staged and become visible only after the complete request commits.
The transfer promise settles only after the agent reports the actual final
transaction result. `CANCELLED` is error code 25.

The manager is tied to its emulator instance. Replacing the emulator destroys
the old manager and invalidates queued work. State restore clears the private
v86 UART input queue before and after restore when that internal path exists,
resets the parser, resumes the VM, sends a 64-byte resync preamble, negotiates a
new nonce, and discards cached shares/cursors. If the agent is absent, transfer
calls time out without disabling the existing game or save-state controls.

For raw handshake diagnostics only:

```js
await window.v86FileTransferV1.ping(new Uint8Array([1, 2, 3]))
await window.v86FileTransferV1.echo(new Uint8Array([0, 1, 0x56, 0x38, 0x46, 0x54, 0xff]))
```

The ISO's default `V8FT.INI` declares `system` (`C:\`) read-only, plus `games`
(`D:\`, when present) and `desktop` (`%USERPROFILE%\Desktop`) read-write.
Missing roots are skipped. PUT never creates missing parent directories and
never follows a reparse point. A successful guest disk write exists only in
the running browser session unless the user later saves state or exports it.
