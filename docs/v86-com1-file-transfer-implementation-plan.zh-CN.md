# v86 COM1 通用文件上传/下载实施方案

> 目标：在浏览器与 v86 guest 之间提供通用的文件上传、下载与目录浏览能力  
> 传输方向：浏览器 host ↔ v86 COM1 ↔ Windows guest agent  
> 核心原则：不修改 v86 核心、不直接修改虚拟硬盘、不依赖外部文件服务器  
> 本方案不是按游戏定制的存档工具。游戏相关内容只以可选的 UI 快捷方式存在（见 8.4）。

## 1. 背景与当前仓库条件

当前站点在浏览器中运行完整的 Windows 98/XP，并通过两块异步 IDE 镜像分别提供系统盘和游戏盘。Diablo II 从游戏库进入时自动启用通用 `File transfer`；旧的专用存档按钮已移除。多个游戏共用同一块 Windows XP 系统盘（`windowsxp_multidisk_C_2G.img.zst`），因此 agent 只需安装一次即可服务所有基于该系统盘的游戏。

当前 v86 构建已经提供所需的双向串口接口：

- host → guest：`emulator.serial_send_bytes(0, Uint8Array)`（`libv86.js` `P.prototype.serial_send_bytes`）；
- guest → host：`emulator.add_listener("serial0-output-byte", listener)`（`P.prototype.add_listener`）；
- COM1 对应串口编号 `0`。

以上三点已对当前 `libv86.js` 核对确认。`uart0` 由 `V86` 无条件创建，I/O 基址 `0x3F8`，构造函数将其映射为 `com=0`，因此 COM1 不需要任何 config 开关即可使用。当前 `app.js` 的 `new V86({...})` 没有传入 `serial_container`，所以没有内置 SerialAdapter 抢占 `serial0-output-byte`，本方案的监听器是该事件的唯一消费者。

因此第一版不需要新增 v86 设备、修改 WASM、修改 `v86gl` PCI 协议，也不需要 Windows 内核驱动。Windows guest 只需要一个普通 Win32 用户态程序，通过系统自带的 COM1 驱动读写数据。

### 1.1 已核实的 v86 UART 行为（设计约束来源）

以下事实来自当前 `libv86.js` 中的 UART 实现，本方案的多处设计直接依赖它们。任何一条在升级 v86 后发生变化，都必须重新评估相关章节。

1. **baud rate 完全不参与节流。** `baud_rate` 只在 DLAB 置位时被写入寄存器并可读回，设备从不用它限速。`data_received` 立即置 `LSR.DR` 并抛中断；`write_data` 立即 `bus.send("serial0-output-byte", byte)`。因此"115200 baud"只是 guest 侧驱动的配置值，不构成任何吞吐上限或下限。
2. **guest 发送端没有背压。** `lsr` 初值 `0x60`（THRE|TEMT），并且在 `write_data` 中从不被清除，所以 guest 可以以指令速度连续写出字节。
3. **接收队列 `uart0.input` 是无上限的 JS 数组。** 设备不模拟 overrun，也不丢字节；host 推入的数据一定会被 guest 读到。这意味着字节级流控不是正确性问题，只是内存与延迟问题。
4. **中断行为不对称。** `data_received` 在 `input` 排空前保持 IRQ 拉高，所以一次中断可以排空大量接收字节；而 `write_data` **每个发送字节都抛一次 THRE 中断**。`iir` 会上报 FIFO 已启用（`fifo_control&1` 时 `|= 0xC0`），serial.sys 因此可能每次 THRE 写出至多 16 字节，但中断密度仍显著高于接收方向。
5. **`uart0.input` 不在 state 中。** `Hc.prototype.get_state` 只序列化 `[ints, baud_rate, line_control, lsr, fifo_control, ier, iir, modem_control, modem_status, scratch_register, irq]`；`input` 既不保存也不在 `set_state` 中清空。详见 5.4.1。
6. **`set_state` 不调用 `CheckInterrupt()`。** `ints`/`iir` 被恢复，但 CPU 的 IRQ 线不会被重新拉起。详见 5.4.2。

由 1、2、4 可推出一个重要结论：**真实吞吐由每字节的 JS 调用与 guest 中断开销决定，且上行（host→guest）与下行（guest→host）大概率不对称，下行更慢。** 这与"下载比上传轻量"的直觉相反，必须在阶段 0 分方向实测。

### 1.2 guest 磁盘 I/O 的浏览器内存成本

这一条在按游戏定制的存档场景下无关紧要（存档只有几十 KB），但**通用文件传输会立刻撞上它**，所以必须作为一等约束。

`app.js` 中 `hda`/`hdb` 都是 `async: true` + `use_parts: true` 的远程分片盘，对应 `libv86.js` 的 `za`（partfile buffer）。它的读写路径有两个关键性质：

- `za.prototype.set = ya.prototype.set`：**写入以 256 字节为粒度存进一个 JS `Map`**，每 256 字节一个 `Uint8Array` 条目，外加 `block_cache_is_write` 里的一个 `Set` 条目。
- `cache_reads` 在 `fixed_chunk_size` 存在时为真（当前配置是 1 MiB），因此 `handle_read` **也会把读到的块塞进同一个 `Map`**。

后果：

- **上传一个 N 字节的文件，浏览器堆增长约 N 字节的数据 + 每 256 字节一份对象与 Map 条目开销。** 具体放大倍数取决于引擎，需在阶段 0 实测，但数量级上 100 MB 的写入意味着约 40 万个小对象，GC 压力显著。
- **下载一个 N 字节的文件同样会让堆增长约 N 字节**，因为读缓存也会被填充——即使这次传输一个字节都没写。
- 这些内存**不会随传输结束而释放**，它属于虚拟磁盘的缓存，只在 emulator 被 destroy 时消失。

因此通用文件传输必须有明确的尺寸上限和累计上限，见 4.7。这是一个比 COM1 吞吐更硬的约束：吞吐不足只是慢，内存耗尽是标签页崩溃。

## 2. 目标、非目标与成功标准

### 2.1 目标

1. 用户可以在网页上浏览 guest 中若干个预先配置的共享根（share）及其子目录。
2. 用户可以把本地文件上传到任意可写 share 下的任意子目录。
3. 用户可以把 share 下的任意文件（或多选文件）下载到本地。
4. 传输完全发生在当前浏览器页面和本地虚拟机之间，不经过业务服务器。
5. 上传中断、CRC 错误、页面切换或 state 恢复不能破坏已有文件。
6. 传输功能与现有的 v86 save/load state、图形桥和游戏启动流程互不干扰。
7. 能力对所有使用该 XP 系统盘的游戏一致可用，新增游戏不需要改 agent 配置。
8. 用户在传输前能预估耗时，在传输后明确知道数据的持久性边界（见 2.4）。

### 2.2 非目标

- **不提供删除、重命名、新建目录、移动等修改性文件管理操作。** 只有"上传"这一种写操作。用户需要整理文件时，在 guest 内用资源管理器完成。
- 不允许网页发送 Windows 绝对路径；寻址方式固定为 `share_id` + 相对路径（见 4.3）。
- 不支持目录递归上传/下载；一次请求的文件清单必须是显式列举的。
- 不跟随符号链接、junction 或其他 reparse point。
- 不修改 HDA/HDB 的 FAT/NTFS 元数据。
- 不使用 VirtIO 9P；Windows XP/98 没有可直接复用的原生 9P 客户端。
- 不复用或扩展 `v86gl.sys`。文件传输不应与图形驱动共享代码路径。但独立的 PCI 批量通道是**已列入阶段 0 决策闸门的正式备选方案**，不是被永久排除的选项，见 4.6。
- 第一版只正式支持仓库中的 Windows XP 环境；Windows 98 支持必须单独验证后再开启。
- 第一版不要求上传 ZIP，也不在 guest 内解压。ZIP 只用于多文件下载的容器封装。
- 第一版不解决 guest 磁盘写入的持久化问题（见 2.4），只负责如实告知用户。

### 2.3 完成标准

1. 网页可以列出所有已配置 share，进入子目录，并正确显示文件名、大小和修改时间。
2. 上传一个文件到指定 share 的指定子目录，guest 内文件的大小与 CRC32 完全一致。
3. 下载一个文件，本地文件与 agent 读取的文件在大小和 CRC32 上完全一致。
4. 多选下载生成 ZIP，解压后每个文件的 CRC32 均一致。
5. 上传过程中强制取消、刷新页面或恢复 state，原文件保持不变，没有半写文件。
6. `../`、绝对路径、设备名、超长路径、reparse point、越出 share 根的相对路径、只读 share 上的写入、超限文件全部被拒绝，且返回可区分的错误码。
7. 目录条目数很大时（如 `C:\Windows\System32`）浏览不会卡死主线程，也不会一次性传输全部条目。
8. agent 不存在、未启动或协议版本不兼容时，网页显示明确错误，游戏本身仍然可以运行。
9. 未启用该功能时，现有页面行为完全不变。

### 2.4 持久性边界（必须向用户明示）

`app.js` 中 `hda` 与 `hdb` 都是远程分片盘。guest 的写入只进入内存 `block_cache`，**不会写回任何后端存储**。因此：

- 上传的文件只存在于**当前标签页的这一次会话**中；刷新或关闭页面即丢失。
- `emulator.save_state()` 会序列化 `block_cache_is_write` 标记的脏块，所以"保存 state 并下载"可以保住上传结果，代价是一个数百 MB 的 state 文件。
- **下载功能因此不只是导出通道，也是这个体系里唯一轻量的持久化出口。**

产品结论：上传成功后 UI 必须明确提示"该文件只存在于本次会话，离开前请下载或保存 state"。不允许让用户在不知情的情况下投入时间后丢失成果。

### 2.5 威胁模型：这个 agent 到底在防什么

通用化之后，"agent 只能访问白名单目录"这条旧约束被显著放宽了，所以需要把安全定位讲清楚，避免后续争论。

**guest 的实际属性**：单租户、在用户自己机器的浏览器里运行、不含用户的任何私密数据、写入不持久、每次刷新都从 R2 的 initial state 重建。用户把 guest 搞坏的代价是重载一次页面。

因此路径校验在这里**主要不是安全边界，而是正确性边界**——防止实现缺陷或畸形输入把文件默默写到非预期位置，以及防止 agent 破坏自己的运行环境。据此定级：

| 关注点 | 是否仍需强制 | 理由 |
|---|---|---|
| 相对路径不得逃出 share 根 | 是，强制 | 这是 share 语义本身；失效意味着 UI 显示的位置与实际写入位置不一致 |
| 拒绝 reparse point | 是，强制 | 同上，junction 可以让"看起来在 share 内"的路径落到别处 |
| 拒绝 Windows 设备名与非法文件名 | 是，强制 | 不是安全问题，而是这些名字会造成难以诊断的怪异失败 |
| 尺寸与累计上限 | 是，强制 | 见 1.2，这是标签页存活问题 |
| agent 自身文件与运行目录 | 是，强制拒绝写入 | agent 不能在运行中被覆盖 |
| 扩展名白名单 | 否，默认关闭 | 通用工具无法预知合法扩展名；保留为 share 级可选项 |
| 游戏进程检测 | 否，移除 | 见 4.5 |
| 系统目录只读 | 由 share 配置决定，不硬编码 | 默认把 `C:\` 配成 `ro`、把游戏盘配成 `rw` 即可覆盖绝大多数需要 |

仍需记住的一点：页面上的任何第三方脚本或 XSS 都能调用这套 API。由于 guest 不含敏感数据且可重建，影响面限于"破坏本次会话"，这在本站的风险偏好下可以接受；但这意味着**不应把这套 agent 复用到任何承载真实用户数据的 VM 上**。这条限制要写进 README。

## 3. 总体架构

```text
┌──────────────────────────── Browser host ────────────────────────────┐
│ File transfer UI                                                      │
│     ├── share picker / directory browser                              │
│     ├── upload queue                                                  │
│     └── download selection                                            │
│     │                                                                 │
│ V86FileTransferManager                                                │
│     ├── path & policy pre-validation (UI 侧快速反馈，非信任边界)       │
│     ├── frame encoder / streaming parser (unbounded resync)           │
│     ├── request queue / ACK / adaptive timeout / cancel               │
│     ├── ring buffer fed by the hot-path byte listener                 │
│     └── single-file download / ZIP packaging                          │
│                │ serial_send_bytes(0, bytes)                          │
│                │ serial0-output-byte                                  │
└────────────────┼─────────────────────────────────────────────────────┘
                 │
                 │ emulated COM1  (transport is replaceable, see 4.6)
                 │
┌────────────────┼────────────── Windows XP guest ─────────────────────┐
│ V86FileAgent.exe                                                     │
│     ├── COM1 reader/writer (bounded read/write timeouts)              │
│     ├── bounded protocol parser                                       │
│     ├── share table (id → root, access, limits)                       │
│     ├── canonicalization & containment check  ← 信任边界              │
│     ├── paged directory listing                                       │
│     └── transactional upload / recovery journal                       │
│                │                                                      │
│                └── configured share roots                             │
└───────────────────────────────────────────────────────────────────────┘
```

组件职责必须保持以下边界：

| 组件 | 负责 | 不负责 |
|---|---|---|
| 网页 UI | 浏览交互、选择、警告、进度、持久性提示 | 直接访问 guest 磁盘；充当安全边界 |
| Browser manager | framing、校验、重试、会话和 v86 生命周期 | 决定 Windows 实际绝对路径 |
| 传输通道 | 有界、可恢复的双向消息传输 | 可信任任意输入；保证消息边界 |
| Guest agent | share 解析、路径规范化与包含性检查、事务写入、分页列目录 | share 根之外的任何访问 |
| v86 | 模拟 UART 并传递字节 | 理解文件内容；限速；保证 state 完整性 |

浏览器侧的路径校验只为快速反馈存在。**唯一的信任边界是 agent 内的规范化与包含性检查**，它必须假设收到的一切都是敌意输入。

## 4. 核心架构决策

### 4.1 使用 COM1，而不是虚拟软盘或 9P

COM1 的优势是 Windows XP 自带驱动，host 和 guest 都已有可用 API，文件数据可以直接流入目标目录。相比软盘方案，它没有 FAT12/VFAT 解析、1.44 MiB 容量和写缓存弹出问题；相比 9P，它不需要为旧 Windows 开发或安装 VirtIO 文件系统驱动。

COM1 只作为传输通道。可靠性、流量控制和消息边界由本协议负责，不能假设一次 host 调用会对应 guest 的一次读取。

选择 COM1 的前提是它的实测吞吐能覆盖目标文件尺寸。由 1.1 可知这个吞吐无法从 baud rate 推算，只能实测。**阶段 0 必须给出分方向的实测值并据此决定是否继续走 COM1**，见 4.6。通用化提高了这个闸门的重要性：按游戏定制时只要能搬动几十 KB 的存档就够了，通用工具则会被用来搬几十 MB 的文件。

### 4.2 Share：与游戏无关的可配置共享根

Agent 在 guest 侧维护一张 share 表。每个 share 是一个具名的目录根，与任何游戏无关：

```ini
[share.system]
root=C:\
label=System Drive (C:)
access=ro
max_file_bytes=67108864

[share.games]
root=D:\
label=Games Drive (D:)
access=rw
max_file_bytes=67108864

[share.desktop]
root=C:\Documents and Settings\Administrator\Desktop
label=Desktop
access=rw
max_file_bytes=67108864

[limits]
max_request_files=64
max_request_bytes=134217728
max_session_write_bytes=268435456
max_dir_entries_per_page=256
```

设计要点：

- **share ID 是稳定的 ASCII 短标识**，`label` 是给用户看的显示名。网页只发 ID。
- **share 表是通用配置，不随游戏变化。** 新增一个游戏不需要改 agent 配置——它的文件本来就在 `C:\` 或 `D:\` 下，用户浏览过去即可。
- `access=ro` 的 share 只允许 `LIST_DIR` 与 `GET`。把 `C:\` 配成 `ro` 是推荐默认值：它让用户能取出任何位置的文件，同时避免误写系统盘。需要写 `C:\` 下某个目录时，为那个目录单独加一个 `rw` share。
- share 根之间允许重叠（例如 `desktop` 在 `system` 之内）。这没有问题，因为包含性检查始终针对**本次请求解析出的那个 share 根**。
- 可选的 `extensions=` 字段保留但默认不设置。它是给需要锁死某个 share 的场景准备的，不是通用路径。

Agent 在启动时对每个 share 根做一次规范化（`GetFullPathName` + 解析短名 + 校验存在性），把结果缓存下来；后续所有包含性检查都对这个缓存值做。配置里写的路径不再被信任。

### 4.3 寻址方式：share_id + 相对路径

所有涉及文件或目录的请求都携带 `share_id` 和一个**相对路径**。这是相对旧方案（只接受 basename）最大的语义扩展，也是本次通用化的主要风险来源，因此规则要写死：

- 相对路径使用 `/` 作为分隔符，由 agent 转换为 `\`。禁止在传输中出现 `\`，避免两侧转义规则不一致。
- 相对路径不得以 `/` 开头，不得包含盘符或 `:`。
- 每个路径段单独校验（见 6.3），空段、`.`、`..` 一律拒绝——**不做"先允许 `..` 再规范化"的处理**，直接拒绝更简单也更难出错。
- 规范化之后必须再做一次包含性检查，作为兜底，不能只依赖段级校验。
- 相对路径的总长度受限，且 `share_root + relative_path` 的最终绝对路径必须满足 Windows XP 的 `MAX_PATH`（260）约束，超出直接拒绝而不是尝试 `\\?\` 前缀。

拒绝 `..` 而不是规范化它，意味着 UI 必须自己维护当前目录并发送完整相对路径，不能发 `foo/../bar`。这是刻意的：把路径运算放在可以随便出错的一侧，把校验放在另一侧。

### 4.4 上传采用同盘 staging 和提交

上传不能直接覆盖目标文件。Agent 应在**目标 share 的根目录内**建立受控 staging 目录，保证 rename 始终发生在同一卷上：

```text
<share root>\
  .v86-transfer\
    <request-id>\
      incoming\
      backup\
      transaction.log
```

staging 放在 share 根而不是目标子目录，是为了让恢复扫描只需要检查固定的几个位置。这要求 share 根本身可写；`ro` 的 share 不建 staging。

完整流程：

1. 校验 manifest、share、相对路径、数量和总大小。
2. 每个文件写入 `incoming`，写入完成后调用 `FlushFileBuffers`。
3. 校验实际大小和整文件 CRC32。
4. 写入并 flush transaction journal（含每个文件的目标相对路径）。
5. 将旧文件移动到 `backup`。
6. 确保目标子目录存在——**若不存在则拒绝，不自动创建**（新建目录是非目标，见 2.2）。
7. 将所有 incoming 文件逐个移动到最终位置。
8. 标记事务完成，再清理 staging。
9. 任一步失败时按 journal 回滚旧文件。

Windows 不提供跨多个文件的整体原子替换，因此 journal、同卷 rename 和回滚是多文件一致性的必要条件。

### 4.5 不做游戏进程检测，改为通用的占用与覆盖处理

旧方案里有一条"目标游戏运行时拒绝所有操作"的规则。通用化之后这条规则无法保留：agent 不知道用户正在操作哪个游戏的文件，也不该维护一张游戏进程表。

替代方案分两层：

**Agent 层（强制，通用）**：以独占写方式打开目标文件。失败时返回 `SHARING_VIOLATION`，不重试、不强制覆盖、不尝试解除占用。这覆盖了"文件正被运行中的程序持有"这一类问题，而且不需要知道那个程序是什么。

**UI 层（提示，非强制）**：在上传面板常驻一条提示——"如果目标文件属于正在运行的程序，请先退出该程序"。

**必须承认这里有一处能力回退。** Diablo II 的失败模式不是文件被占用，而是游戏**退出时**把内存中的角色状态写回存档文件，从而覆盖掉运行期间导入的内容。独占打开检测不到这种情况，agent 也无法通用地检测。因此在通用模型下，用户完全可以在 D2 运行时上传存档、然后在退出游戏时静默丢失它。

处理方式是 8.4 的可选快捷方式层：为已知游戏提供一条纯 UI 的警告（"检测到这是 Diablo II 存档目录，请先退出游戏"），零强制、零 agent 侧配置。这保住了大部分实用价值，同时不把游戏知识塞回 agent。这个取舍要在文档里留痕，避免以后被当成 bug 重新发现。

### 4.6 COM1 吞吐不足时的备选通道（阶段 0 决策闸门）

当前 build 里已经存在一条高带宽 guest↔host 通道：`v86gl_pci` DMA 设备，`app.js` 配置 `maxBatchBytes: 16 MiB`，驱动已随 `v86gl_driver` 装进这些 XP 镜像，并且它的状态已被正确序列化进 v86 state。

本方案不复用它，理由是避免文件传输与图形驱动的**代码耦合**——这个理由只对共享代码路径成立，不构成"PCI 方案不可行"。诚实的表述是：一条独立的 PCI 批量通道（新设备，或同设备上的第二个描述符环）是现成可行的后备方案，成本主要在于需要一个 guest 内核驱动。

**因此决策闸门必须放在阶段 0 结束时，而不是上线之后。** 判据：

- 若下行（guest→host）实测吞吐 ≥ 目标速率，继续 COM1，冻结协议进入阶段 1；
- 若低于目标速率，先评估批量优化（增大 chunk、放宽 stop-and-wait 为滑动窗口）能否补足；
- 若仍不足，转 PCI 通道。此时协议层（5.x）的消息定义、share 模型、事务语义全部可以原样复用，只替换 transport——这也是要求 7.1 把 transport 做成可替换抽象的原因之一。

目标速率由"用户可接受的最大等待时间"倒推，在阶段 0 与 11 节一并写死。

#### 4.6.1 新增的 v86 并口只能先作为候选 transport

2026-08-09 上游提交 [f3d4472a — Expose a parallel port](https://github.com/copy/v86/commit/f3d4472a9c934b9ad78a311f5849ba711a296d23) 已合入本仓库 `glbridgetest`。它新增的是 `LPT1/LPT2` 并口，不是新的 UART/COM 串口：

- `parallel0` 默认存在，I/O `0x378`、IRQ 7；
- guest 写 data/control 寄存器分别产生 `parallel0-data-output` / `parallel0-control-output`；
- browser 只能通过 `parallel0-status-input` 驱动打印机状态线；
- 设备状态已加入 v86 state；
- 上游 source 与 release API tests 的 LPT1/LPT2 guest→host 输出均已在本分支通过。

因此它天然支持 guest→host 字节输出，但 **host→guest 不是对称的字节通道**。若要在不增加内核驱动的前提下承载完整文件传输，需要 XP 用户态 `LPT1` 驱动能够通过 `IOCTL_PAR_QUERY_INFORMATION` 稳定读出 browser 驱动的状态线，再在这些状态线上实现半字节/握手编码。即使可读，反向吞吐也必须实测，不能把并口的 data-output 速率当成双向速率。

当前已加入 `LPTPROBE.EXE` 和 `window.v86LptPhase0` 做这一能力闸门。结论规则：

- 四组 browser status pattern 在 XP 用户态产生可区分结果：进入 LPT 双向吞吐基准；
- 状态不可区分或 IOCTL 不可用：LPT 只保留为可选的 guest→host 下载通道，不替换 COM1；
- 反向可用但低于 4.6 的目标速率：仍不作为通用 transport，转 PCI 评估。

### 4.7 传输规模上限

通用文件传输必然会遇到用户尝试搬运大文件。上限必须由 agent 强制，并由 UI 提前拦截以避免用户白等。三层上限：

| 上限 | 建议默认值 | 依据 |
|---|---:|---|
| 单文件 | 64 MiB | 1.2 的内存放大 + 4.6 的吞吐 |
| 单次请求总量 | 128 MiB | 同上 |
| 单会话累计写入 | 256 MiB | 1.2：写缓存不随传输结束释放 |
| 单次请求文件数 | 64 | 限制 manifest 与 journal 规模 |

这些是配置项，不是常量；协议层另有一个不可放宽的编译期硬上限（建议 256 MiB 单文件）。

`max_session_write_bytes` 是本方案独有的一项，理由见 1.2：写入的块缓存在整个 emulator 生命周期内不会释放，所以真正危险的不是单次大传输，而是"传了十次 30 MB"。agent 维护会话累计计数，超限后拒绝新的 PUT 并返回 `SESSION_QUOTA_EXCEEDED`，提示用户重载页面。计数在新 session nonce 时**不**重置——它跟随 emulator 实例，而不是协议会话。

UI 侧必须在用户选择文件后、开始传输前：

1. 用最近实测速率估算耗时，超过阈值（建议 60 秒）时显式确认；
2. 超过任一上限时直接拒绝并显示实际上限数值；
3. 展示当前会话已用配额。

## 5. COM1 二进制协议 v1

### 5.1 基本规则

- 所有多字节整数使用 little-endian。
- magic 固定为四个 ASCII 字节 `V8FT`。
- 控制字符串使用 UTF-8，并带显式 `uint16` 字节长度。
- 单帧 payload 上限为 32 KiB。
- 尺寸上限见 4.7；协议层编译期硬上限为单文件 256 MiB，配置只能收紧不能放宽。
- 同一时刻只允许一个活跃请求。
- 文件 chunk 采用 stop-and-wait：收到当前 chunk 的 ACK 后才发送下一块。若阶段 0 实测显示 stop-and-wait 的 RTT 开销显著，可在 v1.1 通过 feature bit 引入固定窗口，v1 不预留半成品实现。
- 每帧校验 payload CRC32；完整文件在 COMMIT/END 时再次校验总长度和整文件 CRC32。
- **CRC32 算法固定为 CRC-32/ISO-HDLC**：反射多项式 `0xEDB88320`，init `0xFFFFFFFF`，final XOR `0xFFFFFFFF`，输入输出均反射。C 与 JS 实现必须对同一组固定向量产出相同结果，向量随协议一起进版本库。仅写"CRC32"不足以避免两端实现分歧。
- CRC32 用于检测意外损坏，不作为身份认证或加密手段。
- 未知 major version 必须拒绝；同 major 下根据 feature bits 协商可选功能。

### 5.2 固定帧头

v1 使用 32 字节帧头：

| 偏移 | 大小 | 字段 | 说明 |
|---:|---:|---|---|
| 0 | 4 | `magic` | ASCII `V8FT` |
| 4 | 1 | `version_major` | 第一版为 1 |
| 5 | 1 | `version_minor` | 第一版为 0 |
| 6 | 1 | `message_type` | 消息类型 |
| 7 | 1 | `flags` | 响应、结束等标志 |
| 8 | 4 | `request_id` | host 生成，0 仅保留给主动 HELLO |
| 12 | 4 | `sequence` | chunk/响应序号 |
| 16 | 4 | `payload_length` | 最大 32768 |
| 20 | 4 | `payload_crc32` | 空 payload 时使用 0 |
| 24 | 4 | `reserved` | v1 必须为 0 |
| 28 | 4 | `header_crc32` | 对前 28 字节计算 |

`reserved` 必须排在 `header_crc32` **之前**并被它覆盖。若把 `reserved` 放在 CRC 之后，一个被损坏的 `reserved` 会先通过头部 CRC 校验、再被"v1 必须为 0"的规则拒绝，导致一次本可避免的重新同步。

解析器要求：

1. 可以逐字节输入，也可以一次收到多帧。
2. **magic 之前的垃圾字节必须被无上限地丢弃。** 解析器维持一个 4 字节滑动窗口做 magic 匹配，不缓存、不计数、不因丢弃量过大而进入错误状态。5.4 描述的 state 恢复场景会在流首部注入任意数量的陈旧字节，任何有限的重同步窗口都可能导致永久失步。
3. 头部 CRC、版本、保留位或长度非法时不得为 payload 分配内存，并回到步骤 2 的重同步状态。
4. payload 缓冲必须受全局上限约束。
5. 错误帧不能导致 parser 无限等待或增长缓冲区。

### 5.3 消息类型

第一版冻结以下消息：

| 类型 | 方向 | 用途 |
|---|---|---|
| `HELLO` | host → guest | 新会话 nonce、版本和 feature bits |
| `HELLO_ACK` | guest → host | 回显 nonce、agent 版本、限额和能力 |
| `PING` / `PONG` | 双向 | 空闲健康检查 |
| `SHARES_REQUEST` | host → guest | 请求 share 列表 |
| `SHARES_REPLY` | guest → host | share ID、label、access 和各自的限额 |
| `LIST_DIR_REQUEST` | host → guest | share + 相对目录路径 + 分页游标 |
| `LIST_DIR_ENTRY` | guest → host | 一个条目：名称、is_dir、大小、mtime |
| `LIST_DIR_END` | guest → host | 本页结束，含下一页游标或结束标志 |
| `PUT_BEGIN` | host → guest | 目标 share + 每个文件的相对路径、大小和 CRC32 |
| `PUT_READY` | guest → host | staging 建立成功，可以发送 chunk |
| `PUT_CHUNK` | host → guest | 文件索引、offset 和文件数据 |
| `PUT_ACK` | guest → host | 确认已持久写入的 chunk |
| `PUT_COMMIT` | host → guest | 请求校验和提交整个请求 |
| `PUT_RESULT` | guest → host | 成功或明确错误 |
| `GET_REQUEST` | host → guest | share + 相对路径清单 |
| `GET_BEGIN` | guest → host | 导出 manifest（每个文件的大小和 CRC32） |
| `GET_CHUNK` | guest → host | 文件索引、offset 和数据 |
| `GET_ACK` | host → guest | host 已接收 chunk，可继续 |
| `GET_END` | guest → host | 导出完成和总校验信息 |
| `CANCEL` | 双向 | 取消指定 request |
| `ERROR` | 双向 | 协议级或操作级错误 |

所有涉及文件系统的请求必须携带 `share_id`（长度前缀 ASCII）和相对路径（长度前缀 UTF-8，`/` 分隔）。agent 对未知 share 返回 `UNKNOWN_SHARE`，对 `ro` share 上的 PUT 返回 `READ_ONLY_SHARE`。

**目录列举必须分页。** `C:\Windows\System32` 有数千个条目，一次性返回会撑破 payload 上限，也会让 UI 一次性渲染几千个 DOM 节点。规则：

- `LIST_DIR_REQUEST` 携带一个不透明游标（第一页为空）和期望页大小（上限取 `max_dir_entries_per_page`）。
- agent 按稳定顺序（建议目录优先、其后按名称的 UTF-16 序）返回至多一页条目，`LIST_DIR_END` 携带下一页游标。
- 游标只在同一 session 内有效；session 变更后必须从头开始。
- agent 不得为分页在内存中缓存整个目录快照；用 `FindFirstFile`/`FindNextFile` 的流式遍历配合"跳过前 N 项"或记录上一项名称的方式实现。**若采用重新遍历+跳过的实现，必须接受目录在翻页间被修改时可能漏项或重项**，并在文档与 UI 中说明列表非事务性快照。

LIST、PUT 和 GET payload 应使用简单的定长字段加长度前缀字符串，不在 guest 内引入通用 JSON parser。协议结构必须同时以 C header 和 JS codec 单元测试固定。

**CANCEL 与 COMMIT 的竞态必须显式定义**，否则两端会在超时边界上产生分歧：

- agent 收到 CANCEL 时若该 request 的 commit **尚未开始**，回滚 staging 并回 `CANCELLED`。
- 若 commit **正在进行**，agent 忽略 CANCEL，把 commit 跑完，然后返回 commit 的真实结果（`OK` 或具体错误）。commit 是不可中断的临界区。
- 若 commit **已经完成**，CANCEL 是 no-op，agent 重发该 request 原始的 `PUT_RESULT`。
- host 在发出 CANCEL 后必须继续接收该 request 的响应，直到收到 `PUT_RESULT` 或 `CANCELLED` 为止，不能立刻把 request 视为已结束——否则用户会看到"已取消"，而 guest 里文件其实已经被替换。

### 5.4 会话与恢复语义

每次下列事件发生后，browser manager 都必须生成新的 128-bit 随机 session nonce，并重新发送 HELLO：

- emulator 首次 ready；
- v86 state 恢复成功；
- emulator restart；
- agent 响应超时后重新连接。

Agent 收到不同 nonce 的 HELLO 时必须：

1. 取消旧会话的未提交请求；
2. 回滚或清理未提交 staging；
3. 清空旧的传输状态、序号和目录游标；
4. **在回复中回显收到的 nonce。**

`HELLO` 的 `request_id` 固定为 0，因此 **nonce 是唯一能区分新旧会话响应的字段**。host 必须丢弃任何 nonce 与当前会话不匹配的 `HELLO_ACK`，不能因为收到了"某个 HELLO_ACK"就认为握手成功。

所有请求都绑定当前 session。旧时间线迟到的 chunk 或 ACK 必须被忽略，不能提交到新会话。

注意 4.7 的 `max_session_write_bytes` 计数**不**在这里重置：它统计的是 emulator 实例的写缓存增长，与协议会话无关。

#### 5.4.1 state 恢复会在字节流中注入陈旧数据

这是本方案最容易被忽略的正确性缺口，来源见 1.1 第 5 条。

`Hc.prototype.get_state` 不序列化接收队列 `uart0.input`，`set_state` 也不清空它。因此 `restore_state` 之后：

- `lsr` 被覆盖成快照中的值（`DR` 位通常为 0）；
- 但 `input` 里仍保留着**恢复前那条时间线**推入的字节；
- 这些字节暂时不可见，直到下一次 `data_received` 重新置上 `DR`；
- 此后 guest 读到的是**旧会话字节直接拼在新会话字节前面**的流。

session nonce 本身挡不住这个问题——陈旧字节位于新 HELLO 之前，属于帧同步层而不是会话层。因此必须三条一起做：

1. **两侧解析器无上限丢弃非 magic 字节**（见 5.2 解析器要求第 2 条）。
2. **browser manager 在 restore 前后显式清空 `uart0` 接收队列。** 公开 API 没有等价能力，这是 7.1"只用公开 API"原则的唯一例外，必须集中在一个带注释的辅助函数里，并对 `emulator.v86?.cpu?.devices?.uart0` 逐级做存在性判断，缺失时降级为仅依赖重同步而不抛错。
3. **restore 完成后，host 先发送一段不含 `V8FT` 的 resync 前导（建议 64 字节 `0x00`），再发送新的 HELLO。** 这样即使前两条中有一条在未来的 v86 版本上失效，agent 侧也能干净地重新对齐。

#### 5.4.2 恢复后中断线不会自动重新拉起

`set_state` 恢复了 `ints` 与 `iir`，但不调用 `CheckInterrupt()`，CPU 的 IRQ 线不会被重新拉高。若快照恰好停在 agent 等待 THRE 中断的时刻，那个中断不会再来。

- 接收方向可以自愈：下一次 `data_received` 会触发 `ThrowInterrupt` → `CheckInterrupt` → 重新拉起 IRQ。
- 发送方向不会自愈，只能靠 guest 侧驱动或 agent 自身的超时兜底。

因此 6.2 中"为 COM1 读写设置有限超时"是**正确性必需项，不是性能优化项**。agent 不得依赖纯事件驱动的写完成通知。

### 5.5 超时与重试

固定超时在低吞吐链路上会自我引爆：一个 32 KiB chunk 在 20 KB/s 下需要约 1.6 秒（安全），在 5 KB/s 下需要约 6.5 秒——固定 5 秒超时会必然触发重传，而重传本身又加重拥塞，形成活锁。

因此 **chunk 级超时必须是自适应的**：

```text
chunk_timeout = base_timeout + chunk_bytes / measured_rate * safety_factor
```

- `base_timeout` 初始 3 秒；
- `measured_rate` 取该方向最近若干个成功 chunk 的移动平均，初值来自阶段 0 的实测基线（上行、下行各一个）；
- `safety_factor` 初始 3；
- 结果夹在 `[3 秒, 120 秒]` 之间。

控制类消息使用固定超时即可，它们的 payload 很小：

| 项目 | 初始值 |
|---|---:|
| HELLO 超时 | 5 秒 |
| 普通控制响应 | 5 秒 |
| 目录分页响应 | 10 秒 |
| 单 chunk ACK | 自适应，见上式 |
| 单 chunk 最大重试 | 3 次 |
| 完整提交/回滚 | 15 秒 |
| 空闲 PING | 10 秒 |

`measured_rate` 的初值必须来自阶段 0，不能拍脑袋填。分方向记录，因为 1.1 第 4 条说明两个方向的开销结构不同。

重试必须复用同一个 request ID、sequence 和 payload。Agent 必须能够识别重复 PUT_CHUNK：如果对应 offset 已经以相同 CRC 持久写入，则直接重复 ACK；如果内容不同，则终止事务。

### 5.6 错误码

至少定义：

- `OK`
- `UNSUPPORTED_VERSION`
- `AGENT_NOT_READY`
- `UNKNOWN_SHARE`
- `READ_ONLY_SHARE`
- `INVALID_PATH`
- `PATH_ESCAPE`
- `PATH_TOO_LONG`
- `INVALID_NAME`
- `INVALID_EXTENSION`
- `NOT_FOUND`
- `NOT_A_DIRECTORY`
- `IS_A_DIRECTORY`
- `REPARSE_POINT`
- `SHARING_VIOLATION`
- `FILE_TOO_LARGE`
- `REQUEST_TOO_LARGE`
- `SESSION_QUOTA_EXCEEDED`
- `DISK_FULL`
- `CRC_MISMATCH`
- `OUT_OF_ORDER`
- `STALE_CURSOR`
- `BUSY`
- `IO_ERROR`
- `ROLLBACK_FAILED`
- `CANCELLED`
- `TIMEOUT`

`PATH_ESCAPE` 与 `INVALID_PATH` 刻意分开：前者表示相对路径在语法上合法但解析后落在 share 根之外，这是需要在日志里高亮的信号——正常 UI 永远不该产生它，出现即意味着 UI 有 bug 或存在人为构造的请求。

网页应将已知错误码转成面向用户的中文提示，同时在控制台保留 request ID 和内部错误码用于诊断。

## 6. Windows XP guest agent

### 6.1 目标形态

第一版建议实现为单个原生 Win32 x86 可执行文件：

- 不依赖 .NET、Visual C++ Redistributable 或浏览器组件；
- 使用系统 Win32 API 和静态链接的 C runtime；
- 后台运行，不弹出常驻控制台窗口；
- 使用命名 mutex 防止重复启动；
- COM 读写和文件操作不占用游戏主线程；
- 维护有大小上限的本地日志；
- 提供可选的 `--console` 诊断模式。

建议目录：

```text
guest-tools/
  v86-file-agent/
    protocol.h
    agent.c
    serial.c
    transfer.c
    shares.c
    pathsafe.c
    dirlist.c
    crc32.c
    Makefile
```

`pathsafe.c` 单独成文件并配独立测试：它是 3 节表格里唯一的信任边界，不应和传输逻辑混在一起。

Browser 侧建议目录：

```text
file-transfer/
  protocol.js         # 帧编解码、CRC、消息常量
  frame-parser.js     # 增量解析与无上限重同步
  transport-serial.js # serial_send_bytes + 字节监听器 + 环形缓冲
  transfer-manager.js # 会话、请求队列、自适应超时、重试
  browser-model.js    # share 列表、当前目录、分页游标
  file-package.js     # 单文件下载与 ZIP 打包
tests/
  file-transfer/
```

`transport-serial.js` 单独成文件，是为了让 4.6 的通道切换只影响这一个模块。

实际拆分可以根据现有静态站点构建方式调整，但协议 codec、生命周期 manager、UI 和 guest agent 不应全部塞进 `app.js`。

### 6.2 COM1 配置

Agent 通过 `CreateFile("\\\\.\\COM1", ...)` 打开串口，建议起始配置为：

- 115200 baud；
- 8 data bits；
- no parity；
- 1 stop bit；
- 不依赖硬件流控；
- 使用协议 ACK 做背压；
- **通过 `SetCommTimeouts` 设置有限读写超时**，既为了及时响应取消和退出，也为了兜住 5.4.2 描述的"恢复后 THRE 中断不再触发"。agent 不得依赖纯事件驱动的写完成通知。

关于 baud rate 必须明确：**这个值只影响 guest 侧 serial.sys 的配置，对实际吞吐没有任何作用。** v86 的 UART 存下 `baud_rate` 后从不用它限速（见 1.1 第 1 条）。填 115200 是为了让 XP 侧驱动处于一个常规状态，而不是因为链路有 115200 bps 的能力——真实速率可能远高于也可能远低于它。

v86 内部不会为应用提供消息边界，因此 agent 必须将 COM1 当作连续字节流处理。吞吐量必须在真实 XP 镜像上分方向测量。

### 6.3 路径安全（唯一信任边界）

这是通用化之后风险最集中的一节。旧方案只需校验 basename；现在要校验任意深度的相对路径，攻击面和实现复杂度都显著上升。

**每个路径段**必须依次通过：

1. 非空，且不等于 `.` 或 `..`。
2. 不含 `\`、`/`、`:`、`*`、`?`、`"`、`<`、`>`、`|`，以及所有 `< 0x20` 的控制字符。
3. 不以空格结尾，不以 `.` 结尾。
4. 去掉扩展名后不等于 Windows 设备名：`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`（大小写不敏感）。
5. UTF-8 字节数与转换后的 UTF-16 长度均在限制内。

**整条路径**还必须通过：

6. 段数不超过上限（建议 32）。
7. 拼接后的绝对路径长度满足 `MAX_PATH`。
8. 用 `GetFullPathName` 规范化后，仍以缓存的 share 根为前缀，且前缀之后紧跟路径分隔符——**必须做分隔符检查**，否则 `C:\GamesEvil` 会被判定为在 `C:\Games` 之内。
9. 逐级检查中间目录与最终目标的 `FILE_ATTRIBUTE_REPARSE_POINT`，命中即返回 `REPARSE_POINT`。只检查最终路径是不够的，中间任意一级 junction 都能改变落点。
10. 目标不得位于任何 share 的 `.v86-transfer` 之内，也不得指向 agent 自身的可执行文件或配置文件。

校验顺序固定为：解析 share → 检查 `access` → 逐段校验 → 整条路径校验 → 规范化与包含性检查 → reparse point 检查 → 扩展名（若该 share 配置了）→ 尺寸与配额。任何一步失败立即返回对应错误码，不继续后续步骤。

**实现要求**：以上逻辑集中在 `pathsafe.c`，对外只暴露一个"给我 share_id 和相对路径，返回可用的绝对路径或错误码"的函数。传输代码不得自己拼路径。所有分支都要有单元测试，包括第 8 条的前缀分隔符边界和第 9 条的中间级 junction。

### 6.4 启动与部署

Agent 安装到固定目录，并通过 Windows Startup 或受控的 `Run` 注册表项启动。由于 share 表与游戏无关，agent 与其配置一次性装进共用的 XP 系统盘即可覆盖所有基于该盘的游戏；但 **initial state 是每个游戏一份，必须为每个要启用该功能的游戏分别重新捕获**。

对每个游戏，制作新的 initial state 前应：

1. 安装 agent 和 share 配置。
2. 确认 COM1 在设备管理器中可用，且没有被其他程序占用。
3. 启动 agent，确认它处于等待 HELLO 的空闲状态。
4. 确认游戏本身的正常启动没有受影响。
5. 捕获新的 initial state。
6. 使用新 URL 或版本号发布 state，避免 CDN/浏览器缓存旧文件。

第 5 步有一个细节：state 会把 `uart0` 的寄存器状态一并快照（`ier`、`line_control`、`modem_control` 等），所以捕获时 agent 应处于"已打开 COM1、空闲等待"的稳定状态，而不是正在读写的中途。接收队列 `input` 不在 state 内（见 1.1 第 5 条），这一点对 initial state 无害，但对用户自己下载的 state 有影响，由 5.4.1 处理。

网页必须兼容旧 state：如果握手失败，只禁用文件传输工具，不阻止游戏运行。

### 6.5 崩溃恢复

Agent 启动和每次新 HELLO 时扫描每个可写 share 根下的 `.v86-transfer`：

- 没有 commit 标记的 incoming 直接删除；
- 已移动旧文件但未完成提交的事务按 journal 回滚；
- 已完成提交但未清理的事务只做清理；
- 无法自动判定的事务保留现场、拒绝该 share 上的新 PUT，并返回明确错误，不能猜测删除用户文件。

由于 share 根可能重叠，扫描必须按规范化后的根去重，避免同一个 `.v86-transfer` 被处理两次。

## 7. Browser 文件传输管理器

### 7.1 职责

`V86FileTransferManager` 应封装：

- 注册和移除 `serial0-output-byte` listener；
- 增量 frame parser；
- HELLO、request ID 和 session nonce；
- share 列表缓存与目录分页游标；
- 同一时刻唯一活动请求；
- PUT/GET chunk 队列、ACK、自适应超时和重试；
- 进度、取消、失败和完成回调；
- emulator 被替换、destroy、restart 和 restore 时的清理；
- 可测试的 transport 抽象，单元测试不需要启动 v86。

transport 抽象不只是为了测试。4.6 的 PCI 备选方案要求协议层与 transport 完全解耦，这样"COM1 换成 PCI"是替换一个实现，而不是重写 5.x 到 8.x。

发送必须只使用当前仓库已经公开的 `serial_send_bytes` API，不直接访问 `emulator.v86.cpu.devices.uart0` 等内部对象。

**唯一例外**：5.4.1 要求在 state 恢复前后清空 `uart0` 的接收队列，公开 API 没有等价能力。该访问必须满足：

- 集中在一个带注释的辅助函数里，不散落在各处；
- 对 `emulator.v86?.cpu?.devices?.uart0?.input` 逐级做存在性判断；
- 任何一级缺失时静默降级为"仅依赖 5.2 的无上限重同步"，并写一条 console 警告，**不得抛错、不得阻塞 restore 流程**；
- 在注释里写明它依赖 v86 内部结构，升级 v86 时需要复查。

### 7.2 与现有操作状态协调

当前 `app.js` 已有一个 `stateOperationInProgress` 布尔量，`save_state` 与 `load_state_file` 两个 handler 共用它。文件传输接入后，应把它收敛为统一操作协调器，而不是在旁边再加几个互不知情的布尔变量：

```text
idle
  ├── saving-state
  ├── restoring-state
  ├── browsing
  ├── uploading
  └── downloading
```

规则：

- 传输要求 emulator 正在运行；
- 传输期间禁止 save/restore state；
- save/restore state 期间禁止开始传输；
- 浏览（`LIST_DIR`）与传输互斥，因为同一时刻只允许一个活跃请求；UI 在传输期间应把目录树置为只读而不是隐藏；
- emulator 改变时立即取消当前请求并释放 UI；
- agent 离线不能阻塞现有 save state、CD 和全屏按钮。

restore 的完整时序必须固定为（对应现有 handler 中 `restore_state` 前后的位置）：

1. 取消当前传输请求，标记会话失效；
2. `stop()`；
3. 清空 `uart0` 接收队列（7.1 的例外路径）；
4. `restore_state()`；
5. 再次清空 `uart0` 接收队列；
6. 重置 frame parser 到重同步状态；
7. `run()`；
8. 发送 resync 前导，生成新 session nonce，重新握手；
9. 丢弃所有目录分页游标，把浏览器视图重置到当前目录的第一页。

第 3 步和第 5 步都要做：前者清掉恢复前残留，后者清掉 `set_state` 过程中可能被推入的字节。

### 7.3 内存与主线程约束

- 不把整个串口历史保存在数组中。
- parser 只保留当前 header/payload；重同步阶段只维持 4 字节滑动窗口，不缓存被丢弃的字节（见 5.2）。
- 上传通过 `Blob.slice()`/`File.slice()` 分块读取，不把整个文件读进内存。
- 下载按文件分配已知且受限的目标缓冲；总大小超限立即取消。
- 目录列表按页持有，切换目录时释放上一目录的条目。
- 每个 chunk 之间让出事件循环，避免长时间阻塞输入、音频和 WebGPU 提交。
- 进度更新节流，不对每个串口字节修改 DOM。
- 目录条目列表用虚拟滚动或分页渲染，不一次性创建数千个 DOM 节点。

#### 7.3.1 `serial0-output-byte` 监听器在 v86 的 CPU 时间片内部执行

这条约束比它看起来重要。guest 每写出一个字节，`write_data` 就同步调用一次 `bus.send("serial0-output-byte", byte)`，而这发生在 **v86 自己的 CPU 执行循环内部**，不在本方案的代码栈里。"每个 chunk 之间让出事件循环"对它完全无效——回调的调用时机不由本方案控制。

因此硬性要求：

- **监听器函数体只能做一件事：把字节写入预分配的环形缓冲区。** 不解析、不分配对象或闭包、不触发进度回调、不碰 DOM、不做条件日志。
- 解析在 `setTimeout(0)` 或 `queueMicrotask` 排空阶段进行，与监听器解耦。
- 环形缓冲区容量固定，溢出时记录一次错误并让当前请求失败，而不是动态扩容。

这一点在有图形负载时尤其关键：`app.js` 给 `v86gl_pci` 配置了 `maxBatchBytes: 16 MiB`，D3D 桥正在跑大批量 DMA 提交，此时再叠加每字节的 JS 回调，音频和画面很容易出现可感知的抖动。

## 8. 用户界面与流程

通用 `File transfer` 入口直接由 Phase 5 UI 管理，不再经过游戏专属事件。当前游戏库为 `diablo_2` 和 `kartrider` 链接添加 `v8ft=1`；其他游戏保持原 URL，后续应在对应 state 已安装 agent 后再按游戏开启。

面板分三个区域：左侧 share 列表，中间当前目录的条目表，底部传输队列与进度。

### 8.1 浏览

1. 握手完成后请求 `SHARES_REPLY`，渲染 share 列表（用 `label` 显示，`ro` 的加只读标记）。
2. 选中 share 后请求其根目录第一页。
3. 目录条目表显示名称、类型、大小、修改时间；目录排在文件前。
4. 面包屑显示 `share label / 子目录 / ...`，**不显示 Windows 绝对路径**。
5. 条目多于一页时提供"加载更多"或滚动触底加载，使用协议返回的游标。
6. 明确标注列表不是事务性快照（见 5.3）：翻页期间目录被修改可能导致漏项，提供手动刷新。
7. 目录为空、无权访问、路径已消失时分别给出可区分的提示。

### 8.2 上传

1. 用户导航到目标目录（必须是 `rw` share 下的已存在目录）。
2. 选择一个或多个本地文件，或拖放到条目表。
3. 面板显示待上传清单、每个文件大小、总大小、当前会话已用配额，以及**基于实测速率的预计耗时**。
4. 超过 4.7 任一上限时直接拒绝，提示中给出实际上限数值。
5. 预计耗时超过阈值时要求显式确认。
6. 目标目录已存在同名文件时，逐个要求确认覆盖；agent 仍然保留备份。
7. 显示总进度、当前文件、已用时间、估算剩余时间和取消按钮。
8. `PUT_RESULT` 成功后给出 2.4 的持久性提示：该文件只存在于本次会话，离开前请下载或保存 state。

第 8 条不是可选项。用户上传文件后投入时间、关闭标签页、成果全失，是这个功能最容易造成的实际伤害。

上传不创建目录（见 2.2、4.4 第 6 步）。目标目录不存在时返回 `NOT_FOUND`，UI 提示用户先在 guest 内创建。

### 8.3 下载

1. 在条目表中多选文件（不支持选中目录）。
2. 显示总大小与预计耗时；由于下行可能是较慢的方向（见 1.1），多 MB 的下载必须有明确的进度反馈和可用的取消按钮，UI 不能是不可关闭的模态遮罩。
3. `GET_END` 完成后触发下载：
   - 只选了一个文件时**直接下载原文件**，保留原文件名；
   - 选了多个文件时打包成 ZIP，ZIP 内保留相对目录结构。
4. 下载文件名使用安全的 ASCII 名称加时间戳；原始文件名中不适合作为下载名的字符要转义，但 ZIP 内条目保留原名。

下载 ZIP 只负责容器封装，不压缩也可以接受。若引入第三方 ZIP 库，必须本地固定版本、记录许可证，并在无网络环境下工作。

### 8.4 可选的游戏快捷方式（纯 UI，零 agent 配置）

通用浏览对熟悉 Windows 的用户够用，但"找到 Diablo II 的存档目录"对普通用户仍是负担。因此在面板顶部提供一组可选快捷方式：一个 `gameId → {share_id, 相对路径, 提示文案}` 的**前端静态表**，点击直接跳转到该目录。

约束：

- 这张表完全在浏览器侧，agent 对它一无所知；
- 快捷方式失效（目录不存在）时降级为普通浏览，不报错；
- 它**不携带任何强制语义**——不限制扩展名、不限制操作。

这一层同时承载 4.5 承认的能力回退：对已知会在退出时回写存档的游戏（Diablo II 是典型），当用户导航到其存档目录时显示一条提示——"该游戏会在退出时覆盖存档，请先退出游戏再上传"。这是提示，不是拦截；agent 不做任何进程检测。

### 8.5 状态与错误提示

至少区分：

- agent 未安装/旧 state；
- agent 正在连接；
- 该 share 只读；
- 目标文件被占用（`SHARING_VIOLATION`）；
- 路径非法 / 越界 / 过长；
- 目录不存在或已消失；
- 文件超过单文件上限（提示中给出实际上限数值）；
- 请求总量超限；
- 会话写入配额耗尽（提示重载页面）；
- guest 磁盘空间不足；
- 正在浏览 / 上传 / 下载；
- 正在校验；
- 正在提交或回滚；
- 用户取消；
- 串口超时；
- guest I/O 失败；
- 成功完成（附带持久性提示）。

不要把原始 Windows 绝对路径暴露给网页用户；详细诊断只写控制台和受限 agent 日志。

## 9. 测试方案

### 9.1 JS 协议单元测试

- header/frame 编解码 round trip；
- CRC-32/ISO-HDLC 固定向量，与 C 实现结果一致；
- 每一个字节单独到达；
- 一次到达多个完整帧；
- 任意位置拆包；
- magic 前存在垃圾；
- **magic 前存在 1 MiB 垃圾时仍能同步，且内存占用不随垃圾量增长**（对应 5.2 的无上限重同步）；
- 错误 header CRC、payload CRC、版本和保留位；
- `reserved` 非零时被 header CRC 之后的规则拒绝并正确重同步；
- 超大 payload_length 不分配内存；
- 重复 ACK、迟到 ACK、错误 sequence；
- 超时、重试和取消；
- **自适应 chunk 超时：低速率下不产生虚假超时；速率突降时超时值随之放大**；
- **CANCEL 在 commit 前 / commit 中 / commit 后三种时序下的语义**（对应 5.3）；
- 目录分页：游标推进、末页标志、session 变更后游标失效；
- nonce 不匹配的 HELLO_ACK 被丢弃；
- state restore 后旧 session 帧被忽略。

### 9.2 Guest agent 单元测试

`pathsafe.c` 是重点，它的测试要独立成组：

- 每一条段级规则的正例与反例；
- `..`、`.`、空段、`/` 开头、含盘符、含 `:`；
- 各种 Windows 设备名，含带扩展名形式（`COM1.txt`）与大小写变体；
- 尾随空格与尾随点；
- 段数超限、路径长度超限、`MAX_PATH` 边界；
- **前缀分隔符边界：share 根 `C:\Games` 下的路径不得匹配到 `C:\GamesEvil`**；
- **中间级 junction**：`share/a/b/c` 中 `b` 是 reparse point 时被拒绝；
- 重叠 share 下同一物理路径经不同 share 访问时，各自的 `access` 独立生效；
- 指向 `.v86-transfer` 或 agent 自身文件的路径被拒绝。

其余 agent 测试：

- share 表解析、根规范化、不存在的根；
- 只读 share 上的 PUT 返回 `READ_ONLY_SHARE`；
- 分页列目录：空目录、单页、多页、翻页间目录被修改；
- 大目录（数千条目）不导致一次性内存分配；
- 0 字节、1 字节、chunk 边界、单文件上限与超限文件；
- 会话累计配额耗尽后拒绝新 PUT；
- 重复 chunk 幂等处理；
- CRC 错误不会进入 commit；
- 目标目录不存在时返回 `NOT_FOUND` 且不自动创建；
- 目标文件被独占占用时返回 `SHARING_VIOLATION` 且不重试覆盖；
- 磁盘写满时返回 `DISK_FULL` 并完整回滚；
- 备份、提交、故障注入和回滚；
- agent 重启后的 transaction recovery，含重叠 share 的去重扫描。

文件系统测试必须使用临时测试目录，不能指向开发机或镜像中的真实目录。

### 9.3 v86 集成测试

先在最小 XP 测试镜像中运行 agent，再进入真实游戏镜像：

1. HELLO/HELLO_ACK 与 share 列表。
2. 浏览多层目录，含一个数千条目的系统目录。
3. 双向传输固定测试文件并比较 CRC32。
4. 传输 1 B、31 KiB、32 KiB、33 KiB、256 KiB、4 MiB 和单文件上限。
5. PUT 中途发送 CANCEL，确认原文件不变。
6. GET 中途 restore state，确认 browser 清理旧请求并重新握手。
7. **载入一个在传输中途捕获的 state**，确认 5.4.1 的陈旧字节被清理、协议能重新对齐，且不会有旧 chunk 被提交到新会话。这是 `uart0.input` 不在 state 内所导致的场景，必须单独覆盖。
8. **在 restore 之后立即发起一次 GET**，确认 5.4.2 的 THRE 中断问题不会让 agent 永久卡在写入等待上。
9. 连续执行 浏览 → 下载 → 上传 → 浏览。
10. **在 D3D/WebGPU 桥满载时并发跑一次多 MB 传输**，观察音频与帧率。这是真实最坏情况：`v86gl_pci` 正在提交大批量 DMA，同时串口每字节触发一次 JS 回调。
11. **内存回归**：连续上传若干个数十 MB 文件，记录标签页内存增长曲线，验证 1.2 的估算与 4.7 的配额设置是否匹配。
12. 吞吐回归门禁：记录两个方向的速率，低于阶段 0 基线的设定比例时视为回归。

### 9.4 人工验收

通用能力：

- 浏览 `C:\` 与 `D:\`，进出多层目录，面包屑正确；
- 上传一个文件到 `D:\` 下的某个已有目录，在 guest 资源管理器中确认；
- 下载一个文件，本地打开确认内容正确；
- 多选下载生成 ZIP，解压后目录结构与内容正确；
- 在只读 share 上尝试上传，被明确拒绝；
- 上传超过上限的文件，被拒绝且提示给出实际上限；
- 上传成功后 UI 给出了 2.4 的持久性提示。

真实场景抽查（走通用路径，不依赖专用代码）：

- 通过快捷方式跳到 Diablo II 存档目录，上传一组角色存档，退出游戏后重进确认角色可用；
- 上传一张多 MB 的 Warcraft III 自定义地图到 Maps 目录，游戏内可见并能开局；
- 在 Diablo II 运行时上传存档，确认 8.4 的提示出现（并确认这只是提示，符合 4.5 的取舍）。

回归：

- agent 离线时游戏照常启动；
- 现有 v86 save/load state、CD 和全屏功能无回归。

## 10. 可观测性

Browser 开发日志至少包含：

- 协议版本和 agent build ID；
- session ID 的短摘要；
- request ID、share ID、操作类型和状态；
- 相对路径的**长度与段数**，不记录路径内容本身；
- 文件数量、总字节、已传字节；
- 当前会话累计写入量与剩余配额；
- retry、timeout、cancel 和错误码；
- **分方向吞吐量与总耗时**，以及自适应超时当前使用的 `measured_rate`；
- **重同步事件计数与每次丢弃的字节数**。这是诊断 5.4.1 的主要信号：restore 之后出现一次大额丢弃属于预期，反复出现则说明清空逻辑失效。

日志不得包含文件内容。发布版默认不打印逐帧或逐 chunk 日志。

Agent 日志使用大小上限和轮转，记录：

- 启动版本、share 加载与规范化结果、COM1 打开结果；
- 请求 ID、share、操作、字节数和结果；
- **每一次 `PATH_ESCAPE` 与 `REPARSE_POINT`，含完整入参**。正常 UI 永远不该触发这两个错误，出现即说明有 bug 或人为构造请求，是最有价值的诊断信号；
- transaction recovery 和 rollback；
- Windows 错误码。

## 11. 分阶段实施计划

> 实施状态（2026-08-10）：阶段 0 的 XP probe、browser runner、临时 codec、确定性测试数据和本地模拟测试已经落地，详见 [阶段 0 基准记录](./v86-com1-phase0-benchmark.zh-CN.md)。真实 XP 镜像的两轮常规负载持续吞吐已通过预先冻结的绝对门槛。产品已明确决定接受尚未完成的 D3D 满载、磁盘 cache 内存和 restore 验证风险，冻结 transport 为 COM 并直接进入阶段 1；这些验证仍保留为后续回归/配额任务，不标记为已通过。

### 阶段 0：真实环境盘点、分方向吞吐基线与通道决策

这一阶段的产出决定后面所有章节是否成立，必须先做完再冻结协议。1.1 与 1.2 的行为已经从 `libv86.js` 静态确认，但吞吐与内存放大只能实测。

任务：

- [x] 确认当前 `libv86.js` 的 `serial_send_bytes` 和 output listener 双向工作（nonce HELLO、确定性二进制数据与双向 CRC 均通过）。
- [x] 在实际 XP 镜像中确认 UART0 对应的 Windows COM 设备可打开且没有被其他程序占用（当前手动安装为 COM3，资源 `03F8-03FF` / IRQ 4）。
- [ ] 确认 XP 镜像的盘符布局、默认用户目录路径，冻结初版 share 表。
- [x] 准备不含用户数据的确定性测试数据（支持数十 MB）和预期 CRC32。
- [x] **分方向测量吞吐**：上行与下行各测 1 KiB、32 KiB、1 MiB、8 MiB；已完成两轮常规负载矩阵，8 MiB 较慢样本分别为 `243.66 KiB/s` 与 `642.22 KiB/s`。
- [ ] 用 Performance trace 补录传输期间的 long task、GC 和主线程卡顿归因；console 中单次 1 MiB 下行退化不能代替归因数据。
- [ ] **实测 1.2 的内存放大倍数**：向 guest 写入 8 MiB / 32 MiB，记录标签页堆增长，据此标定 4.7 的三档配额。
- [ ] 在 D3D/WebGPU 桥满载时重复一次吞吐测量，记录退化幅度。
- [ ] 验证 restore state 后 `uart0.input` 的残留行为，确认 7.1 的清空手法在当前 build 上可用。
- [ ] 根据测得速率标定 5.5 自适应超时的 `measured_rate` 初值（上行、下行各一）。
- [x] **执行通道决策闸门（见 4.6）**：2026-08-10 决定继续 COM；未完成验证作为已接受风险后移，不阻塞 codec。

**通道决策闸门的判据必须在开测前写死。** 建议从"用户可接受的最大等待时间"倒推目标速率——若定为"32 MiB 文件上传不超过 5 分钟"，则上行目标约 110 KB/s；若定为"8 MiB 文件下载不超过 2 分钟"，则下行目标约 70 KB/s。通用化把这两个数字抬高了不少，COM1 未必够用，这正是要在阶段 0 就决策的原因。实际数值由产品侧确认后填入。

退出条件（全部满足才能进入阶段 1）：

1. 浏览器和 XP 测试程序可以双向交换任意二进制数据；
2. share 表初版已冻结；
3. 分方向吞吐数值已记录，含图形负载下的对照组；
4. 内存放大倍数已实测，4.7 的配额已据此标定；
5. 通道决策已作出：继续 COM1，或转 4.6 的 PCI 方案。

阶段 0 的第 2–4 项未全部满足；2026-08-10 产品决定以显式风险接受覆盖阶段顺序闸门。阶段 1 不因此获得文件系统访问权限：在 share 表和内存配额补齐前，最小 agent 只协商协议并提供 PING/内存 ECHO。

若决策为转 PCI，则 5.x 的消息定义、share 模型和事务语义原样保留，只替换 transport 与 6.2；阶段 1 的任务改为实现 PCI 驱动与对应的 transport 实现。

### 阶段 1：协议 codec 与最小 agent

> 实施状态（2026-08-10）：**阶段 1 已完成。** 正式 `V8FT` v1 JS/C codec、COM client、XP 最小 agent、交叉 harness 和 ISO 已落地；自动化 codec 测试与真实 XP UART smoke test 均已通过。实机返回 agent `v8ft-agent-1.0-20260810`、`features=1`、`maxPayloadBytes=32768`，PING 与完整 32 KiB ECHO 均成功。Windows 名称可能是 COM1、COM3 或其他 COMn，不作为身份依据。

任务：

- [x] 冻结 v1 frame header、消息类型、错误码和 feature bits。
- [x] 固定 CRC-32/ISO-HDLC 测试向量，C 与 JS 共用同一份。
- [x] 实现 JS encoder 和增量 parser（含无上限重同步）。
- [x] 实现 C encoder 和增量 parser（含无上限重同步）。
- [x] 实现 HELLO（含 nonce 回显）、PING 和内存 echo 测试。
- [x] 覆盖 fragmentation、CRC、超限和 resync 单元测试。
- [x] 建立 agent 可重复的 Win32 x86 构建流程。
- [x] 在真实 XP 的标准 Communications Port（I/O `03F8-03FF` / IRQ 4）上完成 `V8FT.EXE` 与 `window.v86FileTransferV1` 的 HELLO/PING/32 KiB ECHO smoke test。

退出条件：host/guest codec 交叉 round trip 通过，损坏帧不会崩溃、失控分配或永久失步。**已满足（2026-08-10）。**

### 阶段 2：路径安全与只读能力

刻意把只读能力（浏览 + 下载）与写能力分成两个阶段：路径校验是唯一的信任边界，让它先在没有写操作的情况下稳定下来。

> 实施状态（2026-08-11）：**阶段 2 已完成。** host/guest 代码、Phase 2 payload codec、只读 share 表、分页 LIST、stop-and-wait GET、host/C 路径安全测试和 XP `PATHSAFE.EXE` 已落地，agent build 为 `v8ft-agent-1.1-phase2-20260810`。自动化测试与 XP 5.1 交叉构建通过；真实 XP 中 `PATHSAFE.EXE` 返回 `PASS`，HELLO 协商 `features=15`，三个只读 share 正确返回，`C:\` 目录列举成功，`WINDOWS/win.ini` 下载得到 477 字节且 browser 端 CRC32 校验为 `9695d435`。

任务：

- [x] 实现 share 表解析与根规范化。
- [x] 实现 `pathsafe.c` 全部规则及其独立测试组；真实 XP junction 测试已通过随 ISO 提供的 `PATHSAFE.EXE`。
- [x] 实现分页 `LIST_DIR`。
- [x] 实现 GET streaming。
- [x] 实现 `access` 语义（此阶段所有 share 均按 `ro` 处理）。

退出条件：可以浏览任意深度目录并正确下载文件；9.2 的 `pathsafe` 测试组全绿，包括前缀分隔符与中间级 junction 两个边界。**已满足（2026-08-11）。**

### 阶段 3：写路径与事务安全

实现状态（2026-08-12）：已正式验收完成。`PATHSAFE.EXE` 与 `PUTTEST.EXE` 均在真实 Windows XP 通过；Phase 3 agent build `v8ft-agent-1.2-phase3-20260811` 成功打开 COM3。浏览器与真实 guest 协商 features `63`，在可写 `desktop` share 上传 18 字节后得到 `PUT_RESULT errorCode=0`，再通过 GET 回读出完全相同的 `V8FT Phase 3 works`。因此本阶段不是仅凭交叉编译或模拟测试判定通过。

任务：

- [x] 实现 PUT staging、CRC、write-ahead journal、commit 和 rollback。
- [x] 实现重复 chunk 幂等、取消的 agent 语义、120 秒空闲超时清理。
- [x] 实现 64 MiB/128 MiB/256 MiB 三档配额、64 文件限制与 emulator 生命周期累计计数。
- [x] 实现独占打开与 `SHARING_VIOLATION`。
- [x] 实现 `DISK_FULL` 故障注入和完整回滚路径。
- [x] 实现启动/新 HELLO transaction recovery，含规范化重叠 share 去重和歧义状态写阻断。
- [x] 在真实 XP 运行 `PATHSAFE.EXE`/`PUTTEST.EXE`，并完成浏览器到 guest 的端到端 PUT + GET 回读验收；浏览器交互式取消归入阶段 4 manager/UI 回归。

退出条件：临时测试目录内的成功、取消、断电模拟和回滚测试全部通过，任何失败路径都不留下半写最终文件。**已满足（2026-08-12）。**

### 阶段 4：Browser manager 与现有 v86 生命周期

实现状态（2026-08-12）：Phase 4 host 代码与自动化回归已落地。新增独立
`V86FileTransferManager`、可替换 serial transport、统一操作协调器、请求队列、
share/游标缓存、双向进度与取消、Blob/File 有界分块读取，以及固定的 restore/
emulator replacement 清理时序。完整 host 测试为 31/31 通过，其中 Phase 4 覆盖
transport 注入、流式上传、GET 取消、队列互斥、新 nonce 重连和 stale request
作废；现有 D3D8/D3D9 executor、perf 与 bridge route 回归为 9/9 通过。真实 XP
的 Phase 4 manager 入口已完成 HELLO（features `63`）、三 share、系统盘目录、
`WINDOWS/win.ini` 477 字节 GET（CRC32 `9695d435`）以及 1 MiB desktop PUT/GET
回读；该样本上传约 3.45 秒、逐块约 `246.9–335.1 KiB/s`，下载逐块约
`535.2–787.1 KiB/s`，大小均为 1048576，manifest/内容 CRC32 均为
`d424bdc1`。真实 XP 的 PUT 取消/回滚也已通过：在首个 32760 字节 chunk ACK
后取消，agent 返回 `CANCELLED(25)`，同名原文件内容及 manifest/内容 CRC32
`3fe6bf57` 均保持不变，操作协调器回到 `idle`。真实 state restore/reconnect 也
已通过：沿用同一 manager，session nonce 从 `78e0a4a787986883dfed572992654258`
更新为 `c3f85cd97f0b40f028fe1cfcd5220c47`，重新协商 features `63`，恢复后
`win.ini` GET/CRC 正常，client operation/transfer、waiter、inbox 和 manager queue
均清零，状态为 `ready/idle`。Phase 4 最终退出仍需在真实页面补做 emulator
replacement 与 D3D/WebGPU 满载回归；产品于 2026-08-12 接受这两项残余风险并
要求直接进入 Phase 5，因此保留为后续回归项，不阻塞 UI 实施，也不把整个阶段
标成最终验收完成。

任务：

- [x] 实现独立的 transfer manager，不把协议逻辑写入 `app.js`。
- [x] 接入真实 v86 serial API，transport 保持可替换。
- [x] 实现只做环形缓冲写入的 `serial0-output-byte` 监听器（见 7.3.1）。
- [x] 实现 handshake、share 缓存、目录游标、请求队列、自适应超时、重试、进度和取消。
- [x] 将文件传输和现有 `stateOperationInProgress` 收敛到统一操作协调器。
- [x] 实现 7.2 的 restore 时序，含 `uart0` 队列清空与 resync 前导。
- [ ] 验证图形、音频和输入没有明显回归（含 D3D 桥满载对照）。

退出条件：页面可以通过非 UI 测试入口稳定完成 浏览/上传/下载，并正确处理 restore 和 emulator 更换。

### 阶段 5：UI

实现状态（2026-08-12）：通用 Phase 5 文件面板已接入游戏页。控制栏在 CD 控件
与全屏之间显示 `File transfer`，点击后连接现有 Phase 4 manager，列出 agent
发布的 share，并支持只显示 share label 的目录浏览、面包屑、手动刷新和游标
分页。可写 share 支持文件选择器或拖放一次上传一个或多个文件，上传前检查单
文件、请求、文件数和会话配额，逐个确认同名覆盖，并对预计超过 60 秒的操作
二次确认；传输期间显示文件、总进度、速率、已用/剩余时间和取消入口。目录中
可多选文件下载：单文件保留安全化文件名直接下载，多文件在浏览器本地打包为
UTF-8、stored method ZIP，不依赖网络库。成功上传后始终显示 state 持久性提示。
桌面 1600×1100 与窄屏 700×900 的无头浏览器视觉检查均无横向溢出；Phase 5
UI/ZIP/多文件行为测试为 7/7 通过。游戏专属快捷方式是可选增强；旧的 Diablo II
专用按钮和事件 hook 已移除，游戏库为 Diablo II 和 KartRider 自动添加 `v8ft=1`。虚拟滚动
暂未加入，目录继续使用显式分页加载。

任务：

- [x] 在控制栏接入通用文件传输入口，删除 Diablo II 专用按钮/hook，并在游戏库按游戏启用。
- [x] 实现 share 列表、目录浏览、面包屑、手动刷新与游标分页；大目录虚拟滚动保留为优化项。
- [x] 实现多选上传、拖放、逐文件覆盖确认、配额、耗时预估及长操作确认。
- [x] 实现多选下载、单文件直接下载与本地 stored ZIP 打包。
- [ ] 实现 8.4 的游戏快捷方式静态表与 Diablo II 提示。
- [x] 实现 8.5 的用户状态与错误映射、传输进度/取消和强制持久性提示。

退出条件：非开发用户无需操作 Windows 资源管理器即可完成浏览、上传和下载。
**本次要求的通用流程已满足；可选游戏快捷方式不作为退出条件。**

### 阶段 6：镜像部署、回归和灰度启用

任务：

- [ ] 将 agent 与 share 配置安装进共用的 XP 系统盘并配置自动启动。
- [ ] 为要启用的每个游戏分别生成和发布带版本的新 initial state。
- [ ] 通过 feature flag 分游戏开启。
- [ ] 完成协议、agent、v86 集成和人工验收矩阵。
- [ ] 记录 agent build ID、state 版本和回退 URL。
- [ ] 在 README 写明 2.5 的适用范围限制。
- [ ] 验证关闭 feature flag 后现有页面行为完全恢复。

退出条件：已启用游戏的默认流程稳定，旧 state 可降级运行，其他游戏没有行为变化。

## 12. 推荐提交拆分

1. **最小 Win32 echo agent 与分方向吞吐 / 内存测量脚本**（阶段 0，先于协议）。
2. 阶段 0 测量结果与通道决策，写回本文档 4.6、4.7 与 11 节。
3. 文档、协议常量、CRC 固定向量和纯 JS/C codec 测试。
4. `pathsafe.c` 与其独立测试组（不含任何传输逻辑）。
5. share 表、分页 LIST_DIR 与 GET。
6. PUT transaction、配额、rollback 和故障注入测试。
7. browser transfer manager、监听器热路径与 v86 生命周期协调（含 restore 时序）。
8. UI：浏览、上传、下载、ZIP 打包。
9. 游戏快捷方式静态表。
10. XP 镜像/state 部署元数据、feature flag 和最终验收。

第 1、2 项刻意排在协议之前：它们的产出决定协议参数与配额，也决定是否继续使用 COM1。第 4 项刻意独立：路径校验是唯一信任边界，应该能被单独 review。

每个提交都应保持站点可启动。协议变更必须同时更新 C、JS、测试和本文档，不能只修改一端。

## 13. 风险与应对

| 风险 | 后果 | 应对 |
|---|---|---|
| 通用化后用户搬运大文件，写缓存撑爆标签页 | 页面崩溃，用户丢失整个会话 | 1.2 实测放大倍数；4.7 三档配额含会话累计上限；UI 提前拦截 |
| 下行吞吐不足（每字节一次 THRE 中断 + 每字节一次 JS 回调） | 数十 MB 下载耗时不可接受 | 阶段 0 分方向实测；4.6 通道决策闸门；transport 可替换 |
| 相对路径校验有缺陷 | 文件写到 share 之外，UI 显示与实际不符 | `pathsafe.c` 独立成模块与测试组；前缀分隔符与中间级 junction 专项用例；`PATH_ESCAPE` 单独错误码并全量记日志 |
| 大目录一次性列举 | payload 超限或 UI 卡死 | 强制分页 + 虚拟滚动；agent 不缓存整目录快照 |
| D2 类游戏退出时回写覆盖上传内容 | 用户静默丢失存档 | 已知能力回退，见 4.5；8.4 提供纯 UI 提示；文档留痕 |
| 浏览器主线程逐字节开销 | 音频或画面卡顿 | 监听器只做环形缓冲写入，解析异步化（7.3.1）；D3D 满载对照测试 |
| `uart0.input` 不在 state 内，恢复后陈旧字节混入新流 | 协议永久失步或旧数据被当作新数据 | 无上限重同步 + restore 前后清空队列 + resync 前导（5.4.1） |
| `set_state` 不重新拉起 IRQ | agent 卡在发送等待上 | `SetCommTimeouts` 有限写超时，不依赖纯事件驱动（5.4.2） |
| 固定 chunk 超时在低速率下触发虚假重传 | 重传加重拥塞，形成活锁 | 自适应超时公式，基线来自阶段 0（5.5） |
| guest 磁盘写入不持久 | 用户上传后投入时间，关闭页面丢失全部成果 | 上传成功后强制展示持久性提示（2.4、8.2） |
| 目标文件被运行中的程序占用 | 写入失败或文件损坏 | 独占打开 + `SHARING_VIOLATION`，不重试覆盖（4.5） |
| CANCEL 与 COMMIT 竞态 | UI 显示已取消但文件已被替换 | 三种时序语义显式定义（5.3） |
| 多文件提交中途失败 | 文件组版本不一致 | 同卷 staging、journal、备份和 rollback |
| 重叠 share 导致恢复扫描重复处理 | 同一事务被处理两次 | 按规范化根去重（6.5） |
| agent 不在旧 state 中 | UI 永久等待 | HELLO 超时并安全降级，不阻止游戏 |
| 协议两端版本漂移 | 难以诊断的传输失败 | major/minor 协商、build ID、CRC 固定向量、交叉 codec 测试 |
| 这套 agent 被复用到含真实数据的 VM | 第三方脚本可读写用户数据 | 2.5 的适用范围限制写进 README |

## 14. 后续扩展

按价值与风险排序：

1. **上传时自动解压 ZIP**。用户导入 Mod 或多文件包时最常见的需求。风险是 zip slip（条目名含 `../`），必须复用 `pathsafe.c` 对每个条目名做同样校验，且解压前先校验全部条目名再落盘。
2. **断点续传**。大文件在低吞吐链路上尤其需要。协议已有 offset 和 per-chunk CRC，主要工作在 agent 侧保留 staging 与 host 侧记录进度。
3. **删除与新建目录**。当前是明确的非目标（2.2）。若要加入，每个操作都需要各自的事务与回滚语义，且要重新审视 2.5 的威胁模型。
4. **传输期间的写缓存回收**。若 1.2 的内存问题成为主要瓶颈，可以研究在传输后主动清理 `block_cache` 中已落盘的只读块——但这会与 v86 的磁盘语义冲突，属于高风险改动。

传输通道的演进由 4.6 的决策闸门在阶段 0 决定，不推迟到上线后。如果阶段 0 判定 COM1 够用，就不要为潜在的大文件场景提前修改 v86 核心或 `v86gl` 驱动；如果判定不够用，则在阶段 1 直接转 PCI 通道，而不是先做一版注定要重写的 COM1 实现。

## 15. 第一项实际工作

实现阶段应从阶段 0 开始，不要先写完整 UI。第一项可执行任务是制作最小 XP COM1 echo 程序，并用当前站点构建中的 `serial_send_bytes(0, ...)` 与 `serial0-output-byte` 完成二进制 round trip。

这个 echo 程序从一开始就要**分方向打印计时**，并且要有一条把收到的数据真正写入 guest 磁盘的路径，以便同时测量 1.2 的内存放大——通用化之后这两个数字共同决定 4.7 的配额，而配额又决定这个功能到底能用来搬什么。不要等协议做完再补测量。同时在这一步验证 restore state 之后 `uart0.input` 的残留行为，确认 7.1 的清空手法在当前 build 上可用。

只有在通道决策闸门通过、协议参数与配额可以据实标定之后，才进入正式 agent 开发。
