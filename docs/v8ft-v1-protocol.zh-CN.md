# V8FT v1 协议冻结记录

状态：阶段 1、阶段 2 均已完成，2026-08-11。transport 固定为 v86 UART0；Windows 端口名称可变，协议不依赖 COMn 名称。

真实 XP smoke 记录：agent `v8ft-agent-1.0-20260810` 成功完成 nonce HELLO，协商 `features=1`，发布 `maxPayloadBytes=32768`；PING 和 32 KiB 确定性 payload ECHO 均通过。阶段 1 未发布文件功能，所以 `maxFileBytes`、`maxRequestBytes`、`maxSessionWriteBytes`、`maxRequestFiles` 和 `maxDirEntriesPerPage` 均为 0，符合本协议冻结值。

阶段 2 真实 XP smoke 记录：`PATHSAFE.EXE` 返回 `PASS`，覆盖真实 NTFS 中间级 junction；agent `v8ft-agent-1.1-phase2-20260810` 成功协商 `features=15`，发布 64 MiB 单文件、128 MiB 单请求、64 文件和 128 条目/页限额。`SHARES_REPLY` 返回 `system`、`games`、`desktop` 三个只读 share；真实 `C:\` 的 13 个条目成功列举；`GET system:WINDOWS/win.ini` 返回 477 字节，browser 端完整长度与 CRC32 `9695d435` 校验通过并触发本地下载。

## 帧

magic 为 ASCII `V8FT`。所有多字节整数均为 little-endian。头部固定 32 字节：

| 偏移 | 类型 | 字段 |
|---:|---|---|
| 0 | 4 bytes | magic |
| 4 | u8 | version major，固定 1 |
| 5 | u8 | version minor，当前 0 |
| 6 | u8 | message type |
| 7 | u8 | flags |
| 8 | u32 | request ID；0 只用于 HELLO |
| 12 | u32 | sequence |
| 16 | u32 | payload length，最大 32768 |
| 20 | u32 | payload CRC-32/ISO-HDLC；空 payload 为 0 |
| 24 | u32 | reserved，v1 必须为 0 |
| 28 | u32 | 前 28 字节的 CRC-32/ISO-HDLC |

flags：`RESPONSE=0x01`、`END=0x02`、`RETRY=0x04`；其他位在 v1 中非法。解析器必须先验证 header CRC、major、flags、reserved 和 payload length，之后才允许接收 payload。

## 消息编号

| 名称 | 值 | 名称 | 值 |
|---|---:|---|---:|
| HELLO | `0x01` | HELLO_ACK | `0x02` |
| PING | `0x03` | PONG | `0x04` |
| ECHO | `0x05` | ECHO_REPLY | `0x06` |
| SHARES_REQUEST | `0x10` | SHARES_REPLY | `0x11` |
| LIST_DIR_REQUEST | `0x20` | LIST_DIR_ENTRY | `0x21` |
| LIST_DIR_END | `0x22` | PUT_BEGIN | `0x30` |
| PUT_READY | `0x31` | PUT_CHUNK | `0x32` |
| PUT_ACK | `0x33` | PUT_COMMIT | `0x34` |
| PUT_RESULT | `0x35` | GET_REQUEST | `0x40` |
| GET_BEGIN | `0x41` | GET_CHUNK | `0x42` |
| GET_ACK | `0x43` | GET_END | `0x44` |
| CANCEL | `0x70` | ERROR | `0x7F` |

ECHO/ECHO_REPLY 是阶段 1 诊断能力，不访问文件系统。PING/PONG payload 原样回显，上限同普通帧。

## feature bits

| 名称 | 值 |
|---|---:|
| ECHO | `1 << 0` |
| SHARES | `1 << 1` |
| LIST | `1 << 2` |
| GET | `1 << 3` |
| PUT | `1 << 4` |
| CANCEL | `1 << 5` |

阶段 1 agent 只发布 ECHO。阶段 2 agent 发布 ECHO、SHARES、LIST 和 GET。阶段 3 agent 发布全部六项能力（bit mask `63`），新增 PUT/CANCEL。PING/PONG 和 HELLO 是基本协议能力，不占 feature bit。未协商的可选消息必须拒绝。

真实 XP 验收状态（2026-08-12）：agent `v8ft-agent-1.2-phase3-20260811` 协商 features `63`；`PATHSAFE.EXE` 与事务测试 `PUTTEST.EXE` 均 PASS；浏览器 PUT 成功后经 GET 回读一致。

## HELLO payload

HELLO 固定 20 字节：`nonce[16]`、`requested_features:u32`。host 每次首次连接、restore、restart 或超时重连都生成新 nonce。

HELLO_ACK 为 46 字节固定前缀加 build ID：

| 偏移 | 类型 | 字段 |
|---:|---|---|
| 0 | 16 bytes | 回显 nonce |
| 16 | u32 | negotiated features |
| 20 | u32 | max payload bytes |
| 24 | u32 | max file bytes；能力未发布时为 0 |
| 28 | u32 | max request bytes；能力未发布时为 0 |
| 32 | u32 | max session write bytes；能力未发布时为 0 |
| 36 | u16 | max request files；能力未发布时为 0 |
| 38 | u16 | max directory entries/page；能力未发布时为 0 |
| 40 | u16 | agent major |
| 42 | u16 | agent minor |
| 44 | u16 + bytes | UTF-8 build ID |

阶段 1 agent 不发布 LIST/GET/PUT，所以对应限额必须为 0。阶段 2 发布 `maxFileBytes=67108864`、`maxRequestBytes=134217728`、`maxRequestFiles=64`、`maxDirEntriesPerPage=128`，但 `maxSessionWriteBytes` 为 0。阶段 3 保持前三档限制，并发布 `maxSessionWriteBytes=268435456`；会话写入量跟随 emulator 实例，新的 HELLO nonce 不会清零。

## 阶段 2 payload

本节冻结 Phase 2 新增的 payload。`str16` 表示 `length:u16 + bytes[length]`；share ID 是可打印 ASCII，显示文本、相对路径和文件名是严格 UTF-8。相对路径使用 `/` 分隔，目录根使用空字符串。所有 reserved 字段必须为 0。

### SHARES

`SHARES_REQUEST` payload 必须为空。`SHARES_REPLY`：

```text
count:u16
repeat count:
  share_id:str16
  label:str16
  access:u8          # 0=ro, 1=rw
  reserved:u8
  max_file_bytes:u32
```

Phase 2 无论配置文件写的是 `ro` 还是 `rw`，均回复 `access=0`。Phase 3 按配置回复真实权限；只有 `access=1` 的 share 接受 PUT。

### LIST_DIR

`LIST_DIR_REQUEST`：

```text
share_id:str16
relative_directory:str16
cursor_id:u32
cursor_offset:u32
page_size:u16
reserved:u16
```

第一页的两个 cursor 字段均为 0。后续页必须原样携带上一页返回的非零 cursor；`cursor_id` 由当前 session nonce 派生，HELLO/restore 后旧 cursor 返回 `STALE_CURSOR`。

每个 `LIST_DIR_ENTRY` 单独占一帧：

```text
entry_flags:u8       # bit0=directory, bit1=reparse point
reserved:u8
name_length:u16
size_bytes:u64       # 目录为 0
mtime_filetime:u64   # Windows FILETIME
name_utf8[name_length]
```

条目帧的 sequence 从 0 递增。`LIST_DIR_END` sequence 等于本页条目数，payload 为 `next_cursor_id:u32 + next_cursor_offset:u32`；末页两个字段均为 0，并设置 `RESPONSE|END`。当前 agent 使用 Win32 枚举顺序并通过“重新枚举 + 跳过 N 个可见条目”翻页，不缓存完整目录快照；未改变的目录顺序稳定，翻页间修改目录可能导致漏项或重项。

### GET

`GET_REQUEST`：

```text
share_id:str16
file_count:u16
repeat file_count:
  relative_file_path:str16
```

`GET_BEGIN` sequence 为 0：

```text
file_count:u16
repeat file_count:
  relative_file_path:str16
  size_bytes:u32
  file_crc32:u32
```

`GET_CHUNK` payload 为 `file_index:u16 + reserved:u16 + offset:u32 + data[]`，sequence 从 1 跨文件连续递增。host 校验 offset、累计长度和增量 CRC 后，发送相同 request ID/sequence 的 `GET_ACK`：`file_index:u16 + reserved:u16 + next_offset:u32`。agent 只在收到精确的 `next_offset` 后发送下一块，因此链路是 stop-and-wait；单块数据上限为 32760 字节。

全部文件完成后，agent 发送 `RESPONSE|END` 的 `GET_END`，sequence 为最后一块之后的值，payload 为：

```text
file_count:u16
reserved:u16
total_bytes:u32
```

host 必须分别验证 manifest 中每个文件的完整长度和 CRC32；`GET_END` 的总数只能作为附加一致性校验。0 字节文件不产生 chunk，其 CRC32 为 0。

## 阶段 3 payload

### PUT

`PUT_BEGIN` sequence 为 0：

```text
share_id:str16
file_count:u16
repeat file_count:
  relative_file_path:str16
  size_bytes:u32
  file_crc32:u32
```

agent 完成路径、权限、配额和 staging 检查后回复 sequence 0 的 `PUT_READY`：

```text
file_count:u16
reserved:u16
total_bytes:u32
session_write_bytes:u32
```

`PUT_CHUNK` 与 GET chunk 使用相同布局：`file_index:u16 + reserved:u16 + offset:u32 + data[]`，sequence 从 1 跨文件连续递增，单块数据最多 32760 字节。每块写入 staging 并 `FlushFileBuffers` 后，agent 回复相同 sequence 的 `PUT_ACK`：

```text
file_index:u16
reserved:u16
next_offset:u32
session_write_bytes:u32
```

ACK 超时重发必须复用相同 request ID、sequence 和 payload，并只在重发帧设置 `RETRY`。相同 offset/长度/块 CRC 的最近一块重复数据只重发 ACK，不重复计入会话配额；同 sequence 内容不同则以 `CRC_MISMATCH` 终止事务。

全部块 ACK 后，host 以空 payload 发送下一 sequence 的 `PUT_COMMIT`。agent 完成整文件 CRC、journal、备份、替换或回滚后，以 `RESPONSE|END` 回复相同 sequence 的 `PUT_RESULT`：

```text
error_code:u32
file_count:u16      # 失败时为 0
reserved:u16
total_bytes:u32     # 失败时为 0
session_write_bytes:u32
```

0 字节文件不产生 chunk；其 CRC32 为 0，但仍在同一事务 commit 时创建或替换。

### CANCEL

`CANCEL` 使用待取消 request 的 request ID、sequence 0 和空 payload。对 GET，agent 停止发送后续 chunk 并返回 error code `CANCELLED` 的 `ERROR`。对 PUT，commit 尚未开始时，agent 删除 staging 并返回 error code `CANCELLED` 的 `PUT_RESULT`；commit 已开始则完成不可中断的 commit 并返回真实结果；commit 已完成则重放原 `PUT_RESULT`。host 发出取消后必须等待最终结果，不能提前宣称下载或文件替换已经取消。

### staging 与恢复

每个事务使用 `<share>\\.v86-transfer\\<request-id>\\incoming|backup|transaction.log`。journal 在每次备份/安装前写入 intent 并 flush，操作完成后再写入完成阶段，因此恢复不会根据单一文件是否存在进行猜测。新 HELLO 和 agent 启动扫描可写 share；已提交事务清理，未提交事务回滚，损坏或物理状态矛盾的 journal 保留现场并将该 share 标为不可写。

## 错误码

`OK=0`。其后依次冻结为：`UNSUPPORTED_VERSION=1`、`AGENT_NOT_READY=2`、`UNKNOWN_SHARE=3`、`READ_ONLY_SHARE=4`、`INVALID_PATH=5`、`PATH_ESCAPE=6`、`PATH_TOO_LONG=7`、`INVALID_NAME=8`、`INVALID_EXTENSION=9`、`NOT_FOUND=10`、`NOT_A_DIRECTORY=11`、`IS_A_DIRECTORY=12`、`REPARSE_POINT=13`、`SHARING_VIOLATION=14`、`FILE_TOO_LARGE=15`、`REQUEST_TOO_LARGE=16`、`SESSION_QUOTA_EXCEEDED=17`、`DISK_FULL=18`、`CRC_MISMATCH=19`、`OUT_OF_ORDER=20`、`STALE_CURSOR=21`、`BUSY=22`、`IO_ERROR=23`、`ROLLBACK_FAILED=24`、`CANCELLED=25`、`TIMEOUT=26`、`BAD_REQUEST=27`、`UNSUPPORTED_FEATURE=28`。

ERROR payload 在 v1 中至少包含 `error_code:u32`。损坏到无法信任 request ID 的帧只做本地丢弃和重同步，不发送 ERROR。

## CRC 固定向量

算法为 CRC-32/ISO-HDLC，多项式 `0xEDB88320`、init `0xFFFFFFFF`、final XOR `0xFFFFFFFF`：

| 输入 | CRC |
|---|---:|
| 空 | `0x00000000` |
| ASCII `123456789` | `0xCBF43926` |
| byte 0..255 | `0x29058C73` |
| 阶段 0 确定性 pattern 1 KiB | `0x59886955` |
| 阶段 0 确定性 pattern 32 KiB | `0xD2712994` |

这些向量存放于机器可读 fixture，由 JS codec 与 C harness 共同执行。
