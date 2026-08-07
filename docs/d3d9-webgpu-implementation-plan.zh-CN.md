# D3D9.0c → WebGPU 直接转译完整实施方案

> 前置阅读：`d3d9-webgpu-architecture.md`（架构总览，英文）与
> `d3d8-webgpu-architecture.md` / `d3d8-webgpu-implementation-plan.zh-CN.md`
> （已落地的 D3D8 路径，本方案在其之上复用协议范式、传输层与部分 host 基础设施）。
> 阅读本文前请先确认已经理解 D3D8 路径的 D8WG 协议设计和
> `glbridge/d3d8-webgpu/d3d8_executor.js` 的整体结构，本文不重复其中仍然适用
> 的结论,只标注 D3D9 特有的差异。

## 1. 背景与问题定义

D3D8→WebGPU 路径（D8WG 协议 v1.7）已经达到 M4+ 里程碑：完整定长管线、
vertex shader 1.1 / pixel shader 1.1-1.4 到 WGSL 的手写翻译器、贴图/曲面/
状态块/Reset 生命周期、设备丢失恢复、save state 集成，足以驱动 MapleStory
v0.83 这类以固定管线为主、SM1.x 为辅的游戏。

现在的目标是三款画面复杂度依次递增的 D3D9.0c 游戏：

- **跑跑卡丁车（KartRider）**：以固定管线为主，赛道/角色带少量 SM2.0 特效
  （水面、反光）。
- **魔兽争霸 3（Warcraft III，经典版，非重制版）**：固定管线为主，地形是
  多层贴图混合（terrain splatting），单位/特效使用少量与 SM1.x 接近的
  vertex/pixel shader。
- **魔兽世界（World of Warcraft）**：SM2.0/3.0 全面使用，顶点蒙皮
  （skinning）在 vertex shader 内完成，地形多层混合，动态多渲染目标
  （MRT）特效，遮挡查询（occlusion query），环境/立方体贴图，且内容随资料片
  持续变化，shader 种类事实上无上限。

D3D9 相对 D3D8，不是"多几个 opcode"的差异，而是有质的不同：

1. **真正的可编程着色器**。D3D8 的 shader model 1.x 字节码没有控制流，
   D3D8 路径能用一张 opcode 表手写翻译成 WGSL。D3D9 的 SM2.0/3.0 字节码有
   `if/else/endif`、`rep/endrep`、`loop/endloop`、`call/callnz/ret`、
   谓词指令（predicate）、相对寻址（`a0.x` 索引常量寄存器）、更大的寄存器
   堆和更大的 opcode 集合。这已经是"写一个小型编译器"的工程量，不是扩展
   一张表能解决的。
2. **顶点声明取代 FVF 作为主表示**。`IDirect3DVertexDeclaration9` 允许任意
   属性组合、任意多个 stream、非 `D3DCOLOR`/`FLOATn` 之外的紧凑格式
   （`UBYTE4N`、`SHORT2N`、`FLOAT16_2` 等），FVF 仅作为兼容路径保留。
3. **独立的 sampler state**。D3D8 的采样参数塞在 texture stage state 里，
   D3D9 把它们拆到 `SetSamplerState`，这与 WebGPU 的 `GPUSampler` 对象模型
   更接近，但意味着 D3D8 路径的 texture-stage 状态机不能直接套用。
4. **多渲染目标、独立查询对象、显式 scissor rect、更大的贴图格式矩阵**
   （立方体贴图、体积贴图、浮点格式、ATI1/ATI2 压缩法线贴图）。
5. **游戏本身的规模**。KartRider/War3 是有限的、可穷举的资源集合；WoW 是
   一个会不断补丁更新的活内容库，draw call 量级、shader 种类、贴图分辨率
   都远高于 MapleStory。

因此本方案不是"升级 D8WG"，而是设计一条**平行的 D3D9 路径**：独立协议
（D9WG）、独立 guest DLL（`d3d9.dll`）、独立 host executor
（`d3d9_executor.js`），在可复用的地方复用 D3D8 路径已经验证过的设计
（VGL2 传输、批处理时机、handle 分代、pipeline/bind-group 缓存、checkpoint
思路），但不假装两者是同一件事。

## 2. 目标、非目标与成功标准

### 2.1 项目目标

- 提供一条不经过 WineD3D/opengl32/gl4es 的 D3D9.0c → WebGPU 直接转译路径。
- 按游戏复杂度分里程碑交付：KartRider 可玩 → War3 单机战役可玩 → WoW 登录
  /选角可用 → WoW 主世界可玩 → WoW 特效/后处理与性能收敛。
- 复用现有 `v86gl.sys` / PCI BAR / 16 MiB DMA 环形区，不改动 D3D8 路径的
  外层 VGL2 ABI。
- 建立一条**已验证**的 SM2.0/3.0 字节码到 WGSL 编译管线，而不是"以后再说"。

### 2.2 非目标（本方案明确不做）

- 不实现 D3D9Ex（`IDirect3D9Ex`/`IDirect3DDevice9Ex`）。它依赖 WDDM 驱动
  模型和 Vista+ 语义，与 v86 虚拟的 Windows XP 客户机不匹配；三款目标游戏
  也都以 D3D9（非 Ex）为基线。
- 不实现 D3D10/D3D11。
- 不实现 DXVA 视频加速、跨进程共享 surface（`D3DPOOL_DEFAULT` +
  `IDirect3DSurface9` 共享句柄）。
- 第一阶段不实现运行时 HLSL 源码编译（`D3DXCompileShader`/
  `D3DXCompileShaderFromFile`）。只支持游戏在磁盘/资源包中携带的**已编译**
  字节码（`.fxo`/内嵌 DWORD 数组），这是绝大多数发行版游戏的常态；若阶段 0
  的 API trace 发现某游戏在运行时编译 HLSL 源码，单列为风险项并单独立项
  （见第 14 章）。
- 不追求任意 GPU 渲染结果的同步只读回读（`GetRenderTargetData` 对纯 GPU
  绘制内容）。延续 D3D8 路径的原则：CPU 影子拷贝对上传/Clear/CopyRects/
  StretchRect（已知源）精确，对"仅由任意 GPU draw 产生"的像素不做同步
  回读；如某游戏依赖这类回读，需要先设计异步 guest-stall 协议再解锁。
- 不提供、不分发任何游戏客户端文件或版权资源；本方案只覆盖用户自备正版
  客户端时的渲染兼容层。

### 2.3 分游戏成功标准

| 游戏 | 最低可玩标准 |
| --- | --- |
| KartRider | 主菜单、角色选择、至少一条赛道从起点跑到终点，帧率不低于 30fps，无渲染错误的地形/道具穿插 |
| Warcraft III | 单机战役任意一关可以从开始过场到任务目标达成，地形多层混合正确，单位选框/UI 正确 |
| WoW | 阶段性：先到登录+选角界面稳定运行；再到进入主世界后地形/角色/UI 正确渲染且可操作移动镜头，帧率与硬件基线相当（不要求媲美原生 D3D9 驱动） |

## 3. 总体架构

```text
game.exe（KartRider.exe / War3.exe / Wow.exe）
  -> app-local d3d9.dll（COM + 顶点声明/着色器字节码影子 + 批处理）
  -> VGL2 DMA 传输信封 / D9WG 高层命令流（VGL2 fn = 0xFFE1）
  -> d3d9_executor.js（资源/状态表 + 字节码翻译管线 + pipeline 缓存）
  -> WebGPU / WGSL
```

D3D8 路径保持不变：

```text
MapleStory.exe -> d3d8.dll -> VGL2 fn=0xFFE0 / D8WG -> d3d8_executor.js -> WebGPU
```

两条路径共享 `v86gl.sys`、16 MiB DMA 环形区、PCI BAR 与
`v86gl-pci-frame` 事件，不共享渲染后端，也不共享 guest DLL：一个进程只加载
`d3d8.dll` 或 `d3d9.dll` 中的一个（见第 20 章部署互斥规则）。

### 3.1 与 D3D8 路径的复用边界

**直接复用设计范式，但各自实现一份：**

- VGL2 信封内嵌一个自描述批次（batch header + 一串带 size 的 command）。
- 资源 handle 采用"分代"编码，防止跨 Reset/跨会话的悬空句柄复用。
- guest 端持有真相状态（shadow state），host 端只持有 GPU 真相，不猜测
  guest 意图。
- 一帧内合批，`Present` 或 DMA 容量压力触发提交。
- pipeline/bind-group/sampler 均为有界 LRU 缓存，key 由不可变状态派生。

**建议抽成共享模块，供两个 executor 一起 import（新增
`glbridge/webgpu-runtime/` 目录）：**

- WebGPU adapter/device 获取、丢失监听与重建流程。
- overlay canvas 生命周期（与 gl4es canvas 并存但独立 context 的规则）。
- 通用有界 LRU 缓存实现（当前 `d3d8_executor.js` 内联实现的那部分）。
- checkpoint 文件头（magic/version）读写辅助——两条协议的 checkpoint 内容
  不同，但"版本化二进制 checkpoint"这件事的样板代码相同。

**不共享：** COM vtable 定义、opcode 枚举、shader 字节码解析/翻译、
资源表结构体形状。D3D8 与 D3D9 的资源/状态模型差异大到共享会让两边都变得
难以独立演进。

### 3.2 组件职责边界

| 组件 | 职责 |
| --- | --- |
| `glbridge/d3d9proxy/d3d9.dll` | COM 对象、顶点声明/FVF 影子、着色器字节码影子（原始 token 流 + hash）、状态去重、批处理、DMA 提交 |
| `v86gl.sys` / v86 PCI 设备 | 与 D3D8 路径完全一致，不感知 D9WG 内容，只做一次同步 guest-RAM 读 |
| `glbridge/d3d9-webgpu/d3d9_executor.js` | D9WG 解码、资源/状态表、字节码编译管线调用、pipeline/bind-group 缓存、WebGPU 编码与提交 |
| `glbridge/webgpu-runtime/`（新增） | D3D8/D3D9 共享的 WebGPU 设备生命周期与通用缓存基础设施 |

### 3.3 外部参考实现评估：`LostMyCode/d3d9-webgl`

社区里已有一个公开的 D3D9→Web 实现可以对照：
[`LostMyCode/d3d9-webgl`](https://github.com/LostMyCode/d3d9-webgl)（MIT
许可，用于将 *GunZ: The Duel*（2003）移植到浏览器，即
[Whiplash GunZ](https://gunz.sigr.io/)）。评估结论：**架构模型不同，
不能直接复用，但有三处具体技术值得借鉴**（见 4.7、8.4、9.11）。

不能直接复用的原因：

- **集成方式不同**。它是"drop-in 头文件 + 一个 `.cpp`"，游戏**源码**
  直接 `#include "d3d9.h"` 并用 Emscripten 与游戏逻辑一起编译成同一个
  WASM 二进制，DirectX 调用在编译期就变成直接的 WebGL 调用——这要求拿到
  游戏源码重新编译。本方案的前提正相反：目标是三款**不可获得源码、不
  可重新编译**的商业游戏,运行在 v86 模拟的未修改 Windows XP 客户机里,
  通过 drop-in 的 `d3d9.dll` + PCI DMA + 独立浏览器进程通信,这是二进制
  级兼容层,两种集成模型没有共享代码的空间。
- **渲染后端不同**。它的目标是 WebGL 2.0 / OpenGL ES 3.0,本方案的目标
  是 WebGPU / WGSL,状态模型（尤其是 pipeline/bind group 与 GLSL 全局
  状态机的差异）不通用。
- **它明确不解决本方案最难的问题**。README 里写得很直接：
  `GetDeviceCaps` 故意报告 `VertexShaderVersion = 0`，把应用"骗"进自己
  的固定管线代码路径,项目本身只实现了一个 vertex + 一个 fragment shader
  覆盖全部 FFP 状态组合,完全没有 SM2.0/3.0 字节码翻译。这恰好是第 9 章
  要解决的核心难点,该项目对此没有参考价值。
- **功能覆盖明显更窄**：单 vertex stream（不支持多流顶点声明）、最多
  3 个点光源硬编码、仅线性表雾（EXP/EXP2/range fog 被接受但无效果）、
  渲染目标不支持 `LockRect` 回读。这些限制对 KartRider/War3 可能可以
  接受,但 WoW 的顶点蒙皮天然需要多 stream（`BLENDWEIGHT`/
  `BLENDINDICES` 在独立 stream 里很常见）,不能套用这套限制。

## 4. 核心架构决策

### 4.1 D9WG 是独立协议，复用 framing 规则

理由已在第 1、3 章说明。具体收益：D9WG 的 command 编号、resource kind
编号可以从 1 重新开始，不需要与 D8WG 的编号空间对齐或避让,两边各自的
opcode 表可以独立增删而不必担心跨协议冲突。

### 4.2 字节码编译放在"首次遇到该 shader 时"，而不是每帧

guest 端只做三件事：解析字节码 token 数量（用于确定 payload 边界，方式与
D8WG 的 `instruction_token_count` 完全一致）、计算内容 hash、把原始 token
流连同 hash 一起放进 `D9WG_OP_CREATE_VERTEX_SHADER`/`CREATE_PIXEL_SHADER`
payload。guest **不**做任何语义翻译。

host 端收到 CREATE 命令后：

1. 用 hash 查编译结果缓存（内存 + 可选持久化，见第 19 章）。
2. 缓存命中：直接复用已缓存的 WGSL 源码与 `GPUShaderModule`。
3. 缓存未命中：跑一次 vkd3d-shader → SPIR-V → Tint → WGSL → 
   `device.createShaderModule` + `getCompilationInfo()` 校验，成功后写入
   缓存；失败则该 shader handle 标记为"不可用"，绑定它的 draw 调用直接跳过
   （不能让编译失败导致整批命令读取错位或崩溃）。

这一步必须在 `CREATE_*_SHADER` 命令处理时做完，不能推迟到第一次 `Draw`，
否则第一次使用某 shader 的那一帧会有不可预测的延迟尖峰且难以定位。

### 4.3 顶点声明是主表示，FVF 是兼容视图

`D8WG`（D3D8）里 FVF 就是唯一表示。D3D9 里两者并存：guest 端把
`SetFVF()` 内部转换成一个等价的 `D3DVERTEXELEMENT9` 数组（复用 D3D8 路径
已经写过的 FVF→属性布局映射代码，逻辑不变，只是产物形状变了），host 端
**只认** vertex declaration 描述，不单独实现第二套"FVF 直读"逻辑。这样
input-layout 推导只有一条代码路径。

### 4.4 独立 sampler state 是简化，不是负担

D3D9 把采样参数从 texture stage state 分离出来，恰好更贴近
`GPUSampler`：一个 D9WG `SetSamplerState` 序列可以直接映射成一次
sampler-cache 查找/创建，不需要像 D3D8 路径那样从纠缠在一起的 texture
stage 状态里拆解采样参数。texture stage state 在 D3D9 里保留的部分（颜色/
alpha 运算、参数来源、`D3DTOP_*`）仅用于**没有绑定 pixel shader 的固定
管线路径**，与 D3D8 的处理方式相同。

### 4.5 guest 保真状态、host 保真 GPU：原则延续

与 D3D8 路径一致：Reset/设备丢失后，guest 端的影子状态是唯一真相来源，
host 端资源表可以整体重建；host 端不缓存任何"猜测的" guest 意图。

### 4.6 部署 profile 继续互斥

一个游戏目录只能有 `d3d8.dll`、`d3d9.dll`、自定义 `opengl32.dll`
（WineD3D 回退）三者之一。三条路径都要往同一个 16 MiB DMA 环形区写批次，
混用会导致命令流交织、v86 PCI 侧无法区分归属。

### 4.7 WoW 存在真实的历史级 FFP 回退路径，可以用来拆出一个降风险的中间里程碑

`d3d9-webgl` 靠"把 caps 报告成零 shader 支持，让游戏自己走固定管线代码
路径"这一招就撑起了 GunZ 的移植，前提是 GunZ 本身确实带有可用的 FFP
代码路径。这不是巧合：**魔兽世界发布时（2004 年）的官方最低配置是
GeForce 2 MX / Radeon 7000 一类完全没有可编程 shader 的显卡**，这意味着
Blizzard 的引擎里确实存在一条经过发布前测试、真实可玩的固定管线渲染
路径（对应游戏内画质选项里最低的"地形/固定功能"档位），而不是需要我们
自己拼凑近似效果。

这给第 15 章的里程碑规划提供了一个值得采纳的调整：在 M4（WoW 登录/
选角）和 M5（WoW 主世界，要求完整 SM2.0/3.0 管线）之间，插入一个
**M4.5：WoW 固定管线/最低画质路径**——`d3d9.dll` 的 `GetDeviceCaps`
按照 M1-M4 已完成的固定管线能力诚实上报（`VertexShaderVersion`/
`PixelShaderVersion` 报 0 或报很低的值,不是"骗"，是如实反映当前尚未
实现 SM2.0/3.0），让 WoW 客户端按自己的画质自适应逻辑选中它自带的低
配置渲染路径。这样可以在**不等待第 9 章整条字节码编译管线跑通**的
情况下，提前验证 WoW 的地形/角色/UI 在本方案的固定管线基础设施上能不能
正确显示，把"WoW 到底能不能跑起来"这个大问题拆成"低画质能跑"和"高画质
需要完整 SM2.0/3.0"两个独立可验证的问题。

需要注意的边界：这一招对 GunZ 有效是因为 GunZ 允许运行时把
`VertexShaderVersion` 探测为 0 并优雅退回；阶段 0 的 WoW API trace
（第 5 章）需要验证客户端在检测到低 shader 版本时是否真的有一条完整
可用的降级路径而不是直接报错拒绝启动或画面大量缺失（例如角色皮肤在纯
FFP 路径下是否还能贴纹理、地形多层混合在没有 pixel shader 时是否退化为
可接受的单层贴图）——如果实测发现降级路径本身残缺，M4.5 就不成立，
需要直接进入完整 SM2.0/3.0 路径。

## 5. 阶段 0：三款游戏各自建立基线与 API 面追踪

在写任何 D9WG 代码之前，必须先量化"要支持多少"，否则第 9 章的字节码编译
管线和第 11 章的格式矩阵范围都无法收敛。

对三款游戏分别做：

1. **固定测试环境**：与 D3D8 路径相同的方法——在真实 Windows XP（非 v86）
   下用 WineD3D/系统自带 d3d9.dll 跑，用 API 拦截工具（例如自制的 LD_
   PRELOAD 风格 `d3d9.dll` 转发代理 + 日志，或者 apitrace 的 D3D9 支持）
   录制真实调用序列。
2. **旧链路指标基线**：帧率、draw call 数、状态切换数、贴图创建峰值。
3. **API 使用面统计**：出现过的 `D3DRS_*`/`D3DSAMP_*`/`D3DTSS_*`、贴图
   格式集合、shader 版本分布（`vs_1_1`/`vs_2_0`/`vs_3_0`/`ps_2_0`/
   `ps_3_0` 各自的调用/绘制占比）、是否调用了 D3DX9 入口、是否使用
   `SetStreamSourceFreq`（instancing）、是否使用超过 4 个同时纹理阶段、
   是否使用非默认 swap chain。
4. **贴图/顶点声明枚举**：收集实际出现过的 `D3DVERTEXELEMENT9` 组合与
   贴图格式集合，作为第 10、11 章矩阵的输入而不是凭空列举 D3D9 规格书
   里的全部可能值。

### 阶段 0 退出条件

- 三款游戏各自有一份可复现的 API trace 和调用面统计表。
- 明确回答："是否运行时编译 HLSL 源码"、"是否用到体积贴图/立方体贴图"、
  "是否用到 MRT"、"是否用到遮挡查询"、"D3DX9 具体链接了哪些入口"。
- D9WG v0.1 协议草案（第 6 章）根据统计结果冻结第一批 opcode 集合。

## 6. D9WG 二进制协议设计

### 6.1 基本规则（与 D8WG 相同）

- little-endian，`#pragma pack(push, 1)`，所有跨语言共享结构体在协议头里
  用静态断言锁定 `sizeof`。
- 一次 VGL2 `0xFFE1` 提交承载一个完整的、自描述的 D9WG batch。
- 每条 command 都带 `size`，parser 可以在不理解 opcode 语义的情况下跳过
  未知/不支持的 command（用于版本前向兼容的降级处理，但**不能**用于假装
  执行了不支持的操作——不支持的 opcode 仍然要让对应 D3D9 API 调用返回
  `D3DERR_INVALIDCALL`，"跳过"只是 parser 的容错手段，不是功能实现）。

### 6.2 batch header

```c
#define V86GL_CTRL_D3D9_BATCH 0xFFE1u

#define D9WG_MAGIC 0x47573944u /* "D9WG" */
#define D9WG_VERSION_MAJOR 1u
#define D9WG_VERSION_MINOR 0u

#pragma pack(push, 1)
typedef struct D9WGBatchHeader {
    uint32_t magic;
    uint16_t version_major;
    uint16_t version_minor;
    uint32_t frame_id;
    uint32_t flags;
    uint32_t command_count;
    uint32_t command_bytes;
    uint32_t session_id_low;
    uint32_t session_id_high;
} D9WGBatchHeader; /* 32 bytes, 与 D8WGBatchHeader 形状一致 */

typedef struct D9WGCommandHeader {
    uint16_t opcode;
    uint16_t flags;
    uint32_t size;
    uint32_t sequence;
    uint32_t reserved;
} D9WGCommandHeader; /* 16 bytes */
#pragma pack(pop)
```

### 6.3 版本与 feature negotiation

与 D8WG 相同：guest 在 `D9WG_OP_HELLO` 中携带 `feature_bits`，host 拒绝
不认识的 major 版本、拒绝比自己新的 minor 版本（宁可拒绝启动也不要静默
丢弃功能）。`session_id_low/high` 复用 D8WG 已验证过的"64 位每进程会话
命名空间"设计，防止跨会话数字 handle 碰撞。

### 6.4 资源 handle 与命名空间

D9WG 的资源比 D8WG 多两类（顶点声明、查询对象），handle 高位仍用于区分
kind，具体分配：

```c
#define D9WG_RESOURCE_BUFFER_VERTEX      1u
#define D9WG_RESOURCE_BUFFER_INDEX       2u
#define D9WG_RESOURCE_TEXTURE_2D         3u
#define D9WG_RESOURCE_TEXTURE_CUBE       4u
#define D9WG_RESOURCE_TEXTURE_VOLUME     5u
#define D9WG_RESOURCE_VERTEX_DECLARATION 6u
#define D9WG_RESOURCE_VERTEX_SHADER      7u
#define D9WG_RESOURCE_PIXEL_SHADER       8u
#define D9WG_RESOURCE_QUERY              9u
#define D9WG_RESOURCE_STATE_BLOCK        10u
```

着色器 handle 继续沿用 D8WG 的约定：bit 0 恒为 1，与 FVF token（bit 0
恒为 0，因为合法 FVF 值的 bit0 对应 `D3DFVF_RESERVED0`,规范禁止使用）
区分开，这样 `SetVertexShader`/旧式 `SetFVF` 兼容路径可以共用一个字段而
不产生歧义（延续 D8WG 已验证的技巧）。

### 6.5 opcode 分组（v0.1 草案，阶段 0 结果会调整具体子集）

```c
enum D9WGOpcode {
    D9WG_OP_HELLO = 1,
    D9WG_OP_CREATE_DEVICE = 2,
    D9WG_OP_RESET = 3,
    D9WG_OP_PRESENT = 4,
    D9WG_OP_CLEAR = 5,
    D9WG_OP_BEGIN_SCENE = 6,
    D9WG_OP_END_SCENE = 7,
    D9WG_OP_STRETCH_RECT = 8,        /* 新：D3D9 一等 API */
    D9WG_OP_COLOR_FILL = 9,          /* 新：D3D9 一等 API */
    D9WG_OP_UPDATE_SURFACE = 10,

    D9WG_OP_CREATE_BUFFER = 0x100,
    D9WG_OP_UPDATE_BUFFER = 0x101,
    D9WG_OP_DESTROY_RESOURCE = 0x103,
    D9WG_OP_CREATE_TEXTURE_2D = 0x110,
    D9WG_OP_CREATE_TEXTURE_CUBE = 0x111,     /* 新 */
    D9WG_OP_CREATE_TEXTURE_VOLUME = 0x112,   /* 新 */
    D9WG_OP_UPDATE_TEXTURE = 0x113,
    D9WG_OP_CREATE_VERTEX_DECLARATION = 0x120, /* 新 */
    D9WG_OP_CREATE_VERTEX_SHADER = 0x121,
    D9WG_OP_CREATE_PIXEL_SHADER = 0x122,
    D9WG_OP_CREATE_QUERY = 0x123,            /* 新 */
    D9WG_OP_CREATE_STATE_BLOCK = 0x124,

    D9WG_OP_SET_RENDER_STATE = 0x200,
    D9WG_OP_SET_SAMPLER_STATE = 0x201,       /* 新：独立于 texture stage */
    D9WG_OP_SET_TEXTURE_STAGE_STATE = 0x202, /* 仅剩色彩/alpha 运算部分 */
    D9WG_OP_SET_TEXTURE = 0x203,
    D9WG_OP_SET_VIEWPORT = 0x204,
    D9WG_OP_SET_SCISSOR_RECT = 0x205,        /* 新：D3D9 一等 API */
    D9WG_OP_SET_TRANSFORM = 0x206,
    D9WG_OP_SET_MATERIAL = 0x207,
    D9WG_OP_SET_LIGHT = 0x208,
    D9WG_OP_LIGHT_ENABLE = 0x209,
    D9WG_OP_SET_STREAM_SOURCE = 0x20A,
    D9WG_OP_SET_STREAM_SOURCE_FREQ = 0x20B,  /* 新：instancing，M6 前不实现 */
    D9WG_OP_SET_INDICES = 0x20C,
    D9WG_OP_SET_VERTEX_DECLARATION = 0x20D,
    D9WG_OP_SET_FVF = 0x20E,                 /* 兼容路径 */
    D9WG_OP_SET_RENDER_TARGET = 0x20F,       /* 带 target index，支持 MRT */
    D9WG_OP_SET_DEPTH_STENCIL_SURFACE = 0x210,
    D9WG_OP_SET_VERTEX_SHADER = 0x211,
    D9WG_OP_SET_PIXEL_SHADER = 0x212,
    D9WG_OP_SET_VERTEX_SHADER_CONSTANT_F = 0x213,
    D9WG_OP_SET_VERTEX_SHADER_CONSTANT_I = 0x214,
    D9WG_OP_SET_VERTEX_SHADER_CONSTANT_B = 0x215,
    D9WG_OP_SET_PIXEL_SHADER_CONSTANT_F = 0x216,
    D9WG_OP_SET_PIXEL_SHADER_CONSTANT_I = 0x217,
    D9WG_OP_SET_PIXEL_SHADER_CONSTANT_B = 0x218,
    D9WG_OP_SET_CLIP_PLANE = 0x219,          /* 新，见 9.11 */

    D9WG_OP_DRAW_PRIMITIVE = 0x300,
    D9WG_OP_DRAW_INDEXED_PRIMITIVE = 0x301,
    D9WG_OP_DRAW_PRIMITIVE_UP = 0x302,
    D9WG_OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303,

    D9WG_OP_BEGIN_QUERY = 0x400,             /* 新 */
    D9WG_OP_END_QUERY = 0x401,               /* 新 */
    D9WG_OP_GET_QUERY_DATA = 0x402           /* 新，见 6.7 同步语义 */
};
```

关键 payload 结构体草案（与 D8WG 的写法一致，字段顺序按访问频率排列，
这里只列出 D8WG 里没有对应物的新结构体）：

```c
/* D3DVERTEXELEMENT9 数组的线性编码：紧跟在 header 之后是
 * element_count 个 8 字节 D9WGVertexElement，不含 D3DDECL_END 哨兵，
 * 与 D8WG 的 shader token 计数约定一致（host 从 count 推导边界）。 */
typedef struct D9WGVertexElement {
    uint16_t stream;
    uint16_t offset;
    uint8_t  type;      /* D3DDECLTYPE */
    uint8_t  method;     /* D3DDECLMETHOD, 非 DEFAULT 直接拒绝 */
    uint8_t  usage;      /* D3DDECLUSAGE */
    uint8_t  usage_index;
} D9WGVertexElement; /* 8 bytes */

typedef struct D9WGCreateVertexDeclaration {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t element_count;
    uint32_t reserved;
    /* element_count 个 D9WGVertexElement 紧随其后 */
} D9WGCreateVertexDeclaration;

/* CREATE_VERTEX_SHADER / CREATE_PIXEL_SHADER 都新增 bytecode_hash，
 * 供 host 做首次编译缓存查找；其余字段与 D8WG 的等价结构体同构。 */
typedef struct D9WGCreateVertexShader {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t instruction_token_count;
    uint32_t code_offset;
    uint32_t bytecode_hash_low;
    uint32_t bytecode_hash_high;
} D9WGCreateVertexShader;
/* D9WGCreatePixelShader 同构 */

typedef struct D9WGSetShaderConstantF {
    uint32_t device_handle;
    uint32_t start_register;
    uint32_t vector_count;   /* float4 个数 */
    uint32_t data_offset;    /* 相对 batch 基址，vector_count*16 字节 */
} D9WGSetShaderConstantF;
/* SetShaderConstantI 类似，但 data_offset 指向 int4；
 * SetShaderConstantB 的 data_offset 指向按 32 位对齐打包的 bool 数组。 */

typedef struct D9WGSetRenderTarget {
    uint32_t device_handle;
    uint32_t target_index;         /* 0..3，MRT */
    uint32_t color_texture_handle; /* 0 = 解除绑定该槽位 */
    uint32_t color_level;
} D9WGSetRenderTarget;

typedef struct D9WGSetScissorRect {
    uint32_t device_handle;
    int32_t  left;
    int32_t  top;
    int32_t  right;
    int32_t  bottom;
} D9WGSetScissorRect;

typedef struct D9WGCreateQuery {
    uint32_t device_handle;
    uint32_t resource_handle;
    uint32_t query_type; /* D3DQUERYTYPE_OCCLUSION / EVENT，第一版仅这两种 */
    uint32_t reserved;
} D9WGCreateQuery;
```

M1 落地时发现的一处需要修正：上面"与D8WG同构"的假设对 `SetIndices`/
`DrawIndexedPrimitive` 不成立。`IDirect3DDevice9::SetIndices` 的签名只有
`(IDirect3DIndexBuffer9*)`，不带 base vertex index——D3D9 把这个参数移到了
`DrawIndexedPrimitive` 本身（`BaseVertexIndex` 是逐次绘制传入的，不是设备
状态）。因此实际实现里 `D9WGSetIndices` 只有 `device_handle`/
`buffer_handle` 两个字段，`D9WGDrawIndexedPrimitive` 比 D8WG 版本多一个
`int32_t base_vertex_index` 字段。另外 4.3 节"host 端只认 vertex
declaration 描述"的原则落到协议上意味着 `D9WG_OP_SET_FVF` 的 payload
不能只带原始 FVF DWORD——那样 host 还是要自己解码 FVF，等于两套布局
逻辑。实际形状是 guest 侧用与 `CREATE_VERTEX_DECLARATION` 相同的
`D9WGVertexElement` 数组把 FVF 展开后随命令发送，`fvf` 字段只保留给
host 端日志/诊断用，不参与解码。具体形状见
`glbridge/d3d9proxy/d3d9_protocol.h`（已按此修正实现并冻结）。

### 6.6 上传区

延续 D8WG 的共享 16 MiB transient upload ring 设计（`Draw*UP`、动态
buffer/texture staging 共用一段环形区,按 D8WG_ALIGN8 对齐）。D3D9 新增的
体积贴图更新（`LockBox`）沿用同一环形区，只是 `UpdateTexture` payload
多了一个 `depth`/`slice_pitch` 字段。

### 6.7 同步命令与查询语义

`GET_QUERY_DATA`（对应 `IDirect3DQuery9::GetData`）是本协议第一个**必须
往返**的命令：D3D9 允许 `GetData(NULL, 0, 0)` 做非阻塞轮询，也允许
`D3DGETDATA_FLUSH` 阻塞等待。第一版只支持轮询语义：guest 侧
`GetData` 在结果未就绪时直接返回 `S_FALSE`（与真实驱动允许的行为一致），
不阻塞、不做同步 PCI 往返；host 端在每次 `Present` 之后，把已完成的
occlusion query 结果写入一小块"query 结果影子区"（复用 checkpoint 里
已有的、host→guest 单向状态回传机制的思路，若该机制在 D3D8 路径中尚不
存在则在本阶段新增，只用于极小数据量的查询结果，不用于纹理回读）。

### 6.8 parser 安全要求

与 D8WG 相同：越界读、非法 command_count/size、未知 major 版本一律拒绝
整个 batch；`D9WGVertexElement`/shader token 数组长度必须先做算术溢出
检查再乘以元素大小，这一步在 D8WG 的实现中已经踩过坑，D9 的 parser 要
从一开始就写对。

## 7. Windows guest：自定义 `d3d9.dll`

### 7.1 建议目录结构

```text
glbridge/d3d9proxy/
  d3d9.def
  d3d9_protocol.h        # 对应本文件第 6 章，与 host 端共享的二进制契约
  d3d9_proxy.c            # 单文件实现（延续 d3d8_proxy.c 的组织方式）
  build.sh
  build_stageN_tests.sh   # 按里程碑拆分的验收测试构建脚本
  README.md
```

### 7.2 与 d3d8proxy 的代码复用策略

**不共享同一个 `.c` 文件，但共享一层传输基础设施头文件**：把 D8WG 路径
里"与 D3D8 语义无关"的部分——VGL2 DMA 提交、批次 flush 时机判断、DMA
环形区分配器、command header 写入辅助——抽成
`glbridge/d3d9proxy/../vgl2_transport.h`（新增，纯头文件，无外部依赖，
不依赖 CRT），`d3d8_proxy.c` 后续可以选择性迁移过去，但**不要求**本次
改造同步重构 D3D8 路径；新代码先在 `d3d9_proxy.c` 里独立实现一份，等
D3D9 路径跑通到 M2 里程碑、传输层设计稳定之后，再回头把 D8 路径迁移到
共享头文件（避免两条路径同时处于"传输层正在改"的不稳定状态）。

COM vtable、状态影子结构体、shader token 影子、顶点声明影子等 D3D9 特有
逻辑完全独立实现，不与 `d3d8_proxy.c` 共享。

### 7.3 COM 对象实现顺序

1. `IDirect3D9`：`CreateDevice`、适配器/格式/多重采样探测、`GetDeviceCaps`
   （caps 必须诚实反映当前里程碑已实现的功能，未实现能力不得声明支持，
   延续 D3D8 路径的"caps 审计"纪律）。
2. `IDirect3DDevice9`：`Clear`/`BeginScene`/`EndScene`/`Present`、
   `SetRenderState`/`SetSamplerState`/`SetTextureStageState`。
3. `IDirect3DVertexDeclaration9`：`CreateVertexDeclaration`/
   `SetVertexDeclaration`，FVF→声明的内部转换复用 D3D8 路径已验证的映射
   表逻辑。
4. `IDirect3DVertexBuffer9`/`IDirect3DIndexBuffer9`：`Lock`/`Unlock`，
   `D3DLOCK_DISCARD`/`D3DLOCK_NOOVERWRITE` 语义复用 D3D8 路径实现。
5. `IDirect3DVertexShader9`/`IDirect3DPixelShader9`：`CreateVertexShader`/
   `CreatePixelShader` 接收原始字节码，guest 端**只**做 token 计数与
   hash 计算，不解析语义（真正的解析/翻译在 host 端，见第 9 章）；
   `GetFunction` 返回原始字节码影子。
6. `IDirect3DTexture9`：`LockRect`/`UnlockRect`，格式转换表扩展自 D3D8
   路径（见第 11 章）。
7. `IDirect3DCubeTexture9`：`LockRect(face, level, ...)`，六个面各自的
   影子存储与独立脏区跟踪。
8. `IDirect3DVolumeTexture9`：`LockBox`/`UnlockBox`，三维脏区跟踪
   （比 2D 贴图的脏矩形多一维，需要新的影子存储结构，不能复用 2D 贴图的
   脏矩形代码）。
9. `IDirect3DSurface9`：`GetRenderTargetData`、`StretchRect`、
   `ColorFill`，只读回读遵循第 2.2 节的"精确来源"原则。
10. `IDirect3DQuery9`：`Issue`/`GetData`，第一版仅 `OCCLUSION`/`EVENT`。
11. `IDirect3DStateBlock9`：复用 D3D8 路径的 capture/apply 设计，扩展
    record 集合覆盖 sampler state、顶点声明、shader 常量。
12. `IDirect3DSwapChain9`：第一版只支持隐式（设备自带的）swap chain，
    `CreateAdditionalSwapChain` 返回 `D3DERR_INVALIDCALL`（三款目标游戏
    都是单窗口渲染，不需要多 swap chain）。

### 7.4 COM 语义与 capabilities 策略

与 D3D8 路径相同的纪律：未实现方法返回 `D3DERR_INVALIDCALL`，
`GetDeviceCaps`/`CheckDeviceFormat`/`CheckDeviceType` 只对已验证可用的
格式/能力返回"支持"。这一条在 D3D9 上更重要——WoW 在启动时会用 caps
探测结果选择渲染路径（例如是否启用 vertex shader 3.0 的顶点纹理采样），
caps 撒谎会导致游戏选中一条实际跑不通的路径而不是优雅降级。

### 7.5 shadow state 与重复设置抑制

延续 D3D8 路径的"重复 render state / texture stage state 抑制"设计，
扩展到 `SetSamplerState`（每个 sampler 槽位独立去重）和着色器常量
（按寄存器范围做脏区合并，避免同一常量被多次设置时产生多条
`SET_*_SHADER_CONSTANT_*` 命令）。

### 7.6 多线程策略

与 D3D8 路径相同：假设 D3D 调用发生在单一渲染线程上（`D3DCREATE_
MULTITHREADED` 标志只影响 guest 端内部锁，不改变协议模型），批处理状态
不做跨线程同步。

### 7.7 资源 pool 与 Lock/Unlock

延续 D3D8 路径的 `D3DPOOL_DEFAULT`/`MANAGED`/`SYSTEMMEM`/`SCRATCH`
处理规则；`D3DUSAGE_AUTOGENMIPMAP` 纹理在 host 端用 WebGPU 的 mip 生成
（`GPUCommandEncoder` 逐级 blit 或计算着色器降采样）实现，guest 端仅传递
该 usage 标志，不在 guest 侧生成 mip。

## 8. 浏览器端 WebGPU executor

### 8.1 建议模块

```text
glbridge/d3d9-webgpu/
  d3d9_executor.js         # D9WG 解码、资源/状态表、渲染
  d3d9_shader_pipeline.js  # 第 9 章字节码编译管线（可独立单测）
glbridge/webgpu-runtime/   # 新增，D3D8/D3D9 共享基础设施（见 3.1）
  webgpu_device.js
  lru_cache.js
```

### 8.2 初始化生命周期

与 D3D8 executor 相同的形状：独立 overlay canvas、独立 WebGPU
context，`HELLO`/`CREATE_DEVICE` 建立设备与会话命名空间，`RESET`
是"新纪元"而不是"就地修改"。

### 8.3 每个 batch 的执行流程

在 `SET_VERTEX_SHADER`/`SET_PIXEL_SHADER`/draw 命令处理路径上，pipeline
key 现在必须包含：vertex declaration 的属性布局签名、绑定的 vertex/pixel
shader handle（而不是"当前固定管线特性组合"）、独立采样器集合签名、
render target 格式集合（含 MRT 数量与各自格式）、多重采样参数。这比
D3D8 的 pipeline key 明显更大，必须做结构化哈希而不是字符串拼接，避免
key 计算本身成为热路径开销。

### 8.4 render pass 管理

新增 MRT 支持：一个 render pass 的 `colorAttachments` 数组长度等于当前
绑定的非空 render target 槽位数；`D3DRS_COLORWRITEENABLE1/2/3` 映射到
对应 attachment 的 `writeMask`。深度/模板附件的绑定规则与 D3D8 路径
一致。

WebGPU 的纹理坐标原点与 D3D9 一致（左上角为原点），不像 OpenGL/WebGL
是左下角原点。`d3d9-webgl` 项目因为目标是 WebGL，专门实现了"render-to-
texture 时自动做 Y 翻转"的逻辑来抹平这个差异；本方案走 WebGPU 不需要
这一层——渲染到贴图、再把该贴图当作采样源使用时，坐标语义与 D3D9 原生
行为天然一致，不需要额外的翻转 pass 或在 WGSL 里翻转 UV。唯一需要注意
的是最终呈现到 `<canvas>` 的 swap chain 表面本身的坐标约定，需要在
M1 阶段用一个非对称的测试图案（例如四个角颜色不同的矩形）验证一次，
而不是假设"两边都是左上角原点"就自动等价。

### 8.5 device lost

与 D3D8 路径一致的"从 guest 影子重建"策略；新增内容是 shader 编译缓存
在设备丢失后**不失效**（WGSL 源码与编译结果和具体 `GPUDevice` 实例无关，
只有 `GPUShaderModule`/`GPURenderPipeline` 这些设备绑定对象需要在新设备
上重新创建，翻译产物本身可以复用，避免设备丢失后需要重新跑一遍 vkd3d-
shader/Tint）。

## 9. Shader 字节码编译管线（核心难点）

这是本方案与 D3D8 路径差异最大、风险最高的部分，单独展开。

### 9.1 D3D9 字节码格式速览

D3D9 shader 字节码是一串 32 位 token：

- 首 token 是版本 token（`vs_1_1`..`vs_3_0`、`ps_1_1`..`ps_3_0`），与
  D8WG 现有约定一致（`code_tokens[0]` 就是版本 token）。
- 后续是指令 token 序列，指令带目的/源寄存器操作数，操作数携带寄存器
  类型（临时 `r#`、输入 `v#`、常量浮点 `c#`、常量整型 `i#`、常量布尔
  `b#`、地址 `a0`、循环计数 `aL`、纹理坐标、采样器 `s#`、谓词 `p0`、
  输出 `o#`/`oPos`/`oFog`/`oPts`/`oD#`/`oT#`）、写掩码、swizzle、源
  修饰符（negate/abs/bias/scale 等）、相对寻址标志。
- SM2.0+ 用 `dcl_` 伪指令声明输入/输出语义和采样器类型（2D/Cube/Volume），
  vs_3_0 的输出必须显式 `dcl_` 声明（不像 vs_1_1/2_0 隐式使用
  `oPos`/`oD0` 等固定寄存器）。
- 控制流指令：`if`/`ifc`/`else`/`endif`、`rep`/`endrep`、
  `loop`/`endloop`、`call`/`callnz`/`ret`、`break`/`breakc`。
- 结束哨兵 `D3DVS_END()`/`D3DPS_END()`，与 D8WG 现有约定一致：host 按
  token 计数确定边界，不扫描结束标记。

### 9.2 为什么手写翻译器不现实

D3D8 路径的 SM1.x 翻译器能手写，是因为 SM1.x 字节码是**无分支的直线
代码**：每条指令独立翻译成几行 WGSL，顺序拼接即可。SM2.0/3.0 有真正的
结构化控制流和函数调用，手写翻译需要：一个正确的基本块/控制流图构建
器、SSA 或等价的寄存器版本管理（避免 WGSL 里对同一变量的错误依赖顺序）、
相对寻址转成 WGSL 的动态数组索引、谓词指令转成条件赋值。这相当于重新
实现一个简化版的着色器编译器前端，工程量和正确性风险都远超"扩展一张
opcode 表"，且极易在边角指令组合上产生隐蔽的渲染错误（不崩溃，但颜色/
光照错误，比崩溃更难排查）。

### 9.3 推荐路线：借用成熟开源前端，只编译需要的部分到 WASM

**vkd3d-shader**（Wine 项目的一部分，LGPL-2.1-or-later）已经实现了完整
且经过大量真实 D3D9 游戏验证的 SM1-3 字节码解析、中间表示和 SPIR-V
后端。推荐：

1. 从 vkd3d-shader 裁剪出「D3D9 字节码解析 + IR + SPIR-V 输出」这条链路
   （不需要 vkd3d 的 Vulkan runtime 部分、不需要 HLSL 源码前端），
   用 Emscripten 编译为 WASM 模块。
2. 这个 WASM 模块作为**编译期/首次使用期**工具运行在浏览器主线程或专用
   Worker 里，输入原始字节码 + hash，输出 SPIR-V 二进制。

**Tint**（Chromium/Dawn 项目的一部分，BSD-3-Clause，本身就是 Chrome
WebGPU 实现里做 WGSL↔SPIR-V 转换的组件）编译为 WASM，把上一步的
SPIR-V 转成 WGSL 源码。

管线：

```text
D9WG CREATE_VERTEX_SHADER/CREATE_PIXEL_SHADER (原始字节码 + hash)
  -> [hash 命中缓存？] -> 是：直接用缓存 WGSL/GPUShaderModule
                       -> 否：
  -> vkd3d-shader(wasm)：D3D9 字节码 -> SPIR-V
  -> Tint(wasm)：SPIR-V -> WGSL
  -> device.createShaderModule(wgsl) + getCompilationInfo() 校验
  -> 写入 {hash -> {wgsl, module}} 缓存
```

### 9.4 备选/补充路线

**naga**（Rust 实现，MIT/Apache-2.0，wgpu 项目的 shader 翻译组件）目前
没有 D3D 字节码前端，只接受 WGSL/SPIR-V/GLSL 输入，因此如果 Tint 在
某些指令组合上转换效果不理想，naga 可以作为 SPIR-V→WGSL 的第二种实现
来源做交叉验证（同一份 SPIR-V 分别喂给 Tint 和 naga，比较渲染结果，
用于调试而非生产双运行）。不建议把 naga 设为生产路径的主选项，避免同时
维护两条 WASM 工具链的构建与更新负担。

**完全不推荐**：从零实现字节码到 SPIR-V/WGSL 的翻译器。这是在重新做
vkd3d-shader 已经做过的工作，而且 vkd3d-shader 的正确性是被大量真实
Direct3D 9 游戏（含 Wine/Proton 生态）验证过的，自研版本在启动阶段不可能
达到同等覆盖率。

### 9.5 何时执行编译，如何避免卡顿

- 编译只在 `CREATE_VERTEX_SHADER`/`CREATE_PIXEL_SHADER` 命令处理时触发
  一次，绝不在 `Draw*` 路径上触发。
- 编译是同步 CPU 计算（WASM），会阻塞该 batch 的处理；对 WoW 这种游戏
  内容加载时可能连续创建几十个新 shader 的场景，建议把编译工作放到
  独立 Worker（`vkd3d-shader`/Tint 的 WASM 实例跑在 Worker 里），
  `CREATE_*_SHADER` 命令允许"提交编译请求，标记 handle 为 pending"，
  真正 `Draw` 引用一个仍处于 pending 状态的 shader handle 时才等待
  （通常此时编译早已在后台完成）。这个 pending 机制在第一版可以先不做
  （同步编译，接受首次加载卡顿），作为 M6 性能收敛阶段的优化项而不是
  阻塞前面里程碑的前提条件。
- 编译结果需要持久化跨会话缓存（见第 19 章），否则每次刷新页面都要
  重新编译 WoW 加载时遇到的全部 shader，用户体验不可接受。

### 9.6 编译产物必须真实验证

`device.createShaderModule()` 之后必须调用 `getCompilationInfo()` 并
检查是否存在 `error` 级别消息；只有 `warning`/`info` 允许放行。绝不能
假设"字节码解析没报错就等于 WGSL 是对的"——这是 D3D8 路径的浏览器验证页
（`d3d8_webgpu_browser_test.html`）已经确立的纪律，D3D9 路径的等价页面
（第 18 章）必须延续。

### 9.7 常量寄存器与 uniform buffer 布局

D3D9 的常量堆比 D3D8 大得多且分三种类型（`c#`/`i#`/`b#`），vs_3_0 最多
256 个 float4 常量，ps_3_0 最多 224 个。WebGPU 侧只有统一的 uniform
buffer，需要设计一个打包布局：

```text
[0 .. float_const_count*16)          : c# 寄存器，逐 float4 紧凑排列
[float_region_end .. +int_count*16)  : i# 寄存器，按 int4 存储
[int_region_end .. +bool_count*4)    : b# 寄存器，每个 bool 占一个 32 位槽
                                        （WGSL 没有紧凑 bit-packed bool
                                        数组的原生支持，且这部分数据量很
                                        小，不值得为省内存增加解包开销）
```

vertex/pixel 各自独立一段 uniform，通过 dynamic offset 绑定（延续 D3D8
路径"uniform 走持久 ring + dynamic offset，不进 bind group identity"的
设计，这是它能保证"bind group 缓存不随 uniform 状态增长"的关键，D3D9
必须保留同样的性质，否则 WoW 级别的常量更新频率会让 bind group 缓存
失控增长）。

### 9.8 独立 sampler state 与纹理绑定

D3D9 的 sampler state 独立于 texture stage state，天然对应一个
`GPUSampler`；`dcl_` 声明里携带的采样器维度（2D/Cube/Volume）决定
`GPUTextureView` 的 `dimension`，绑定组布局需要按 shader 实际声明的
采样器集合生成，而不是像 D3D8 固定管线那样只有两个写死的纹理阶段。

### 9.9 vs_3_0 顶点纹理采样（高风险，后置特性）

`vs_3_0` 允许 vertex shader 采样纹理（`texldl` 等指令），WebGPU 规范
允许 vertex stage 采样纹理，但不是所有实现/硬件都同等支持（尤其是
`filterable` 采样在 vertex stage 的限制）。这个特性标记为 M6 阶段
「若目标游戏确实用到再实现」的可选项，不放进 M4/M5 的必要路径——阶段 0
的 API trace 需要明确回答 WoW 3.3.5a 是否真的用到顶点纹理采样（多数
情况下用于地形程序化位移，不是所有客户端版本都启用）。

### 9.10 不支持运行时 HLSL 源码编译

`D3DXCompileShader`/`D3DXCompileShaderFromFile` 需要一个完整的 HLSL
前端（词法/语法分析、类型检查、到字节码的代码生成），这本身是另一个
量级的编译器工程，且与"翻译已编译字节码"是完全不同的问题。第一版明确
不支持；如果阶段 0 的 API trace 发现某游戏在运行时编译源码（而不是加载
预编译 `.fxo`），需要单独立项评估是否引入
DirectXShaderCompiler/`fxc` 的兼容实现，并作为独立里程碑，不混入本方案
的时间线。

### 9.11 Clip Plane：用 fragment shader discard 模拟，不永久搁置

WebGPU 和 WebGL 一样没有硬件裁剪平面。`d3d9-webgl` 项目用一个廉价且
可直接照搬思路的办法解决了这个问题：在顶点着色器里把裁剪平面方程对
world-space 位置求点积算出一个带符号距离，作为一个 varying 传给片元
着色器，片元着色器里距离为负就 `discard`。这个技术不依赖任何 D3D9
特有的东西，可以原样搬到 WGSL：vertex shader 输出一个额外的
`@location` 标量，fragment shader 开头 `if (dist < 0.0) { discard; }`。

D3D8 路径的 README 把裁剪平面列为"未实现，caps 不声明支持"；D3D9 路径
不需要沿用同样的搁置决定——这是一个成本很低、不需要等字节码编译管线
（第 9.1-9.10 节）跑通就能做的功能，建议排进 M3（Warcraft III，如果
阶段 0 观测到用到）或 M5（WoW），而不是像 D3D8 路径那样长期留白。
`SetClipPlane` 对应新增一个 D9WG 状态设置命令，把平面方程系数
（4 个 float）传给 host，host 端把它作为每个受影响 pipeline 的一个
额外 uniform 参与 shader 生成，而不是一个全局渲染状态位。

## 10. Vertex Declaration 与 Input Assembly

- host 端把 `D9WGVertexElement` 数组直接映射为 WebGPU
  `GPUVertexBufferLayout[]`：`stream` 决定归属哪个 vertex buffer 槽位，
  `offset`/`type` 决定 `GPUVertexAttribute.offset`/`format`。
- `D3DDECLTYPE` → `GPUVertexFormat` 映射表（第一版覆盖实际出现的类型，
  按阶段 0 的枚举结果而非规格书全集）：`FLOAT1/2/3/4` →
  `float32/32x2/32x3/32x4`，`D3DCOLOR` → `unorm8x4`（注意 D3DCOLOR 是
  BGRA 字节序，WGSL 里读出后需要 swizzle，与 D3D8 路径处理 `DIFFUSE`
  颜色分量的方式一致）,`UBYTE4`→`uint8x4`,`UBYTE4N`→`unorm8x4`,
  `SHORT2/4`→`sint16x2/x4`,`SHORT2N/4N`→`snorm16x2/x4`,
  `FLOAT16_2/4`→`float16x2/x4`。不在此列的类型（`UDEC3`/`DEC3N` 等）
  在阶段 0 未观测到使用时保持未实现,`CreateVertexDeclaration` 直接拒绝。
- `D3DDECLMETHOD` 只接受 `DEFAULT`；`TESSELLATE`/`CROSSUV` 等 N-patch
  相关方法直接拒绝（三款目标游戏不使用硬件曲面细分）。
- `D3DDECLUSAGE` → WGSL `@location` 的映射沿用 D3D8 路径已经确立的
  "语义槽位固定分配"约定，扩展 `BLENDWEIGHT`/`BLENDINDICES`（顶点蒙皮，
  WoW 角色渲染必需）、`TANGENT`/`BINORMAL`（法线贴图相关效果）。
- FVF 兼容路径：guest 端把 `SetFVF` 翻译成一份等价 `D9WGVertexElement`
  数组后，通过与 `CreateVertexDeclaration` 完全相同的 D9WG 命令下发（即
  `D9WG_OP_SET_FVF` 只是语法糖，host 端处理逻辑与显式声明完全一致，
  不写第二套 input-layout 推导代码）。

## 11. Texture、Surface、Cube/Volume 与格式

### 11.1 格式矩阵（在 D3D8 已支持格式基础上新增）

延续已支持的 `A8R8G8B8`/`X8R8G8B8`/`R5G6B5`/`X1R5G5B5`/`A1R5G5B5`/
`A4R4G4B4`/`L8`/`A8`/DXT1/3/5，新增（按阶段 0 实际观测结果排优先级，
非观测到的格式保持不支持，caps 诚实反映）：

- `D3DFMT_A2R10G10B10`：转换到 `rgb10a2unorm`。
- `D3DFMT_G16R16`/`D3DFMT_R32F`/`D3DFMT_A16B16G16R16F`：浮点/高精度
  渲染目标，WoW 少数特效（如某些光照/HDR 中间缓冲）可能用到，按需实现。
- `D3DFMT_ATI2`（俗称 3Dc/BC5，法线贴图压缩）：WebGPU 对应
  `rg-bc5-unorm`（需确认目标浏览器的 `texture-compression-bc` 特性
  可用；不可用时走 CPU 解码回退，与现有 DXT 解码回退同样的策略）。
- 深度贴图作为着色器资源读取（部分特效读取深度缓冲做软阴影/雾效）：
  D3D9 时代常见的非官方 hack 格式（`D3DFMT_INTZ`/`DF16`/`DF24`）依赖
  厂商驱动私有扩展，**不承诺支持**；阶段 0 需要确认三款游戏是否依赖，
  若依赖则设计显式的"深度纹理"路径（WebGPU 原生支持深度纹理绑定为
  着色器资源，不需要 hack，只是需要 guest 端识别这个使用模式并请求
  正确的 usage）。

### 11.2 Cube Texture

`IDirect3DCubeTexture9` 六个面独立管理脏区和上传，映射为一个
`GPUTexture`（`dimension: "2d"`, `size.depthOrArrayLayers: 6`）配合
`GPUTextureView`（`dimension: "cube"`）用于采样、按面的
`dimension: "2d", baseArrayLayer: face` 视图用于渲染目标写入（如果游戏
把 cube map 的某一面设为渲染目标，例如动态环境反射）。

### 11.3 Volume Texture

`LockBox`/`UnlockBox` 的三维脏区跟踪需要新的影子存储数据结构（不是
2D 脏矩形的简单扩展），映射为 `GPUTexture`（`dimension: "3d"`）。体积
贴图在三款目标游戏里预期使用面很窄（体积雾、少量特效），不作为早期
里程碑的阻塞项。

### 11.4 Multiple Render Targets 与格式独立性

`D3DPMISCCAPS_MRTINDEPENDENTBITDEPTHS` 语义上允许各 render target
使用不同格式；WebGPU `colorAttachments` 天然支持每个 attachment
独立格式，这一条不需要额外设计，只需要 pipeline key 正确纳入每个
attachment 的格式（见 8.3）。

### 11.5 mipmap 与 AUTOGENMIPMAP

延续 D3D8 路径的显式 mip 上传；新增 `D3DUSAGE_AUTOGENMIPMAP` 由 host
端在纹理内容更新后用逐级降采样生成（简单双线性 box filter 足够，不需要
追求与原生驱动逐 bit 一致）。

### 11.6 禁止隐式 readback（原则延续）

与 D3D8 路径完全一致：CPU 影子精确覆盖"host 自己写入的内容"（上传、
`Clear`、`CopyRects`/`StretchRect` 已知源到已知目的），不覆盖"任意
GPU draw 产生的像素"。`GetRenderTargetData` 对后一类内容返回失败或
需要显式异步协议，不能静默返回陈旧/错误数据。

## 12. 独立 Sampler State 与多重渲染目标（补充说明）

已在 4.4、8.4、11.4 分别说明设计原则，这里补充实现顺序：**先做单
render target + 独立 sampler state（M4 前半），再做 MRT（M4 后半）**。
理由：WoW 登录/选角界面基本不需要 MRT，先把独立 sampler state 跑通即可
解锁一大批调用面；MRT 只在少数动态特效里出现，晚一点上线不阻塞主线。

## 13. Occlusion Query 与其他查询

- 第一版只实现 `D3DQUERYTYPE_OCCLUSION` 和 `D3DQUERYTYPE_EVENT`。
- Occlusion query 映射到 WebGPU `GPUQuerySet`（`type: "occlusion"`）；
  一个 query set 预分配固定槽位数（例如 256，超出时退化为"总是可见"而
  不是报错阻塞，避免遮挡剔除失效变成游戏崩溃）。
- `GetData` 语义见 6.7：非阻塞轮询为主，阻塞语义（`D3DGETDATA_FLUSH`）
  第一版不实现，返回未就绪状态即可（多数游戏的遮挡剔除逻辑本身就是
  "上一帧结果指导这一帧剔除"，能容忍轮询延迟一帧）。
- `D3DQUERYTYPE_TIMESTAMP`/`PIPELINETIMINGS` 等性能类查询不实现（游戏
  逻辑不依赖它们，只有调试工具会用）。

## 14. D3DX9 依赖评估

`d3dx9_xx.dll`（`_24` 到 `_43` 各版本号并存于 Windows 生态中）不是
D3D9 API 的一部分,而是微软提供的独立辅助库，常见用途：

- 纹理加载与格式转换（`D3DXCreateTextureFromFileInMemory`，支持
  BMP/JPG/PNG/TGA/DDS 解码 + 自动生成 mipmap）。
- Effect 框架（`.fx` 文件的运行时/离线编译与技术切换，`ID3DXEffect`）。
- 精灵批处理/字体绘制（`ID3DXSprite`/`ID3DXFont`，内部仍然是发出普通
  D3D9 draw call，不引入新的渲染语义）。
- 数学库（`D3DXMATRIX`/`D3DXVECTOR3` 等，纯 CPU 计算，与本方案无关）。

**评估结论与策略**：

1. 数学库部分与本方案无关，游戏静态链接或调用 DLL 均不影响 D9WG 协议。
2. `ID3DXSprite`/`ID3DXFont` 最终都落到普通 `Draw*` 调用，D9WG 路径
   不需要特殊处理，前提是它们内部使用的顶点格式/贴图格式在第 10、11
   章范围内。
3. 纹理加载（`D3DXCreateTextureFromFile*`）如果被游戏调用，说明游戏
   在运行时解码图片文件而不是直接读预转换好的 `.dds`；这部分**不经过
   D9WG 协议**，是纯 guest 端 CPU 工作（图片解码），只要 guest 端有
   可用的解码实现（复用 v86 XP 客户机里已有的图形库或提供一个精简的
   guest 侧 JPG/PNG/TGA 解码器），解码结果仍然通过标准
   `CreateTexture`+`LockRect` 路径进入 D9WG，不需要协议改动。这一项
   本身工作量不小，但边界清晰，可以独立于 D9WG 协议排期。
4. Effect 框架若只使用**预编译**技术（`.fxo`，游戏发行时已经把 HLSL
   编译成字节码），`ID3DXEffect` 内部对每个 pass 调用的仍然是
   `SetVertexShader`/`SetPixelShader`/`SetRenderState` 等标准 API，
   D9WG 路径不需要理解 `.fx` 技术/pass 语法本身。若游戏运行时编译
   `.fx` 源码，落回第 9.10 节的"不支持运行时 HLSL 编译"结论，需要
   单独立项。
5. **行动项**：阶段 0 必须为三款游戏分别确认它们链接的 D3DX9 版本号、
   实际调用的入口集合，以及 Effect 是否运行时编译。这直接决定是否需要
   一个独立的 `d3dx9_xx.dll` 转发/部分实现代理（类似 `winproxy` 对
   `opengl32.dll` 的做法），该代理如果需要，属于与 `d3d9proxy` 平行的
   新增工作项，不在本文档的里程碑内估算工期，留待阶段 0 结果出来后
   单独排期。

## 15. 分阶段实施流程（按游戏里程碑）

### M1：协议骨架与传输层

- 冻结 D9WG v0.1（第 6 章），实现 `HELLO`/`CREATE_DEVICE`/`RESET`/
  `PRESENT`/`CLEAR`/`BeginScene`/`EndScene`。
- guest 端 `d3d9.dll` 骨架：`IDirect3D9`/`IDirect3DDevice9` 生命周期，
  批处理与 DMA 提交（复用 D3D8 路径验证过的时机策略）。
- host 端 `d3d9_executor.js` 骨架：资源表、WebGPU 设备生命周期（可以
  直接依赖新增的 `glbridge/webgpu-runtime/` 共享模块）。
- 顶点声明 + 简单固定管线 draw（无 shader，等价于 D3D8 的
  `XYZRHW`/`XYZ` 预变换路径）。
- 验收：**War3 能进入主菜单，静态场景（无特效）能画出来，颜色/贴图
  基本正确**（2026-08-06 起改为验收目标，原因见下方状态记录；不要求
  单机战役可玩——那是 M3 的验收线）。

**2026-08-06 状态记录**：guest DLL（`d3d9_proxy.c`）与 host executor
（`d3d9_executor.js`）已经按本节范围实现，并且用 5 个独立的真实环境
smoke test 逐条验证过（`glbridge/sample/d3d9_{clear,triangle,texture,
world,reset}_test.c`，构建脚本见 `glbridge/d3d9proxy/build_smoke_test.sh`）：
`Direct3DCreate9`/`CreateDevice`/`Clear`/`Present` 链路、顶点缓冲+`SetFVF`+
`DrawPrimitive`、纹理上传+索引缓冲+`DrawIndexedPrimitive`、真实
`IDirect3DVertexDeclaration9`+`SetTransform`（验证了 host 端矩阵转置/乘法
顺序不是碰巧对的）、以及 `Reset` 后 `D3DPOOL_MANAGED` 资源存活与状态
重绑定，五项在 v86 内真实的 XP 客户机里全部通过。这已经超出本节原始
验收要求的验证深度。

验收目标原定 KartRider（主菜单场景最简单），但 KartRider 走的私服卡在
联网这一步，跟渲染管线无关，短期内无法验证。因此把 M1 的验收目标换成
War3——War3（2002 年发布）的原始最低配置显卡（GeForce 2 级别）本身完全
没有可编程 shader，说明它天然带一条不依赖 SM1.x 的固定管线兜底路径。

**2026-08-07：M1 验收达成。** Warcraft III 1.27.0.52240（冰封王座）在
真实的 v86 XP 客户机里进入主菜单并正确渲染：Logo、3D 冰封尖塔场景、
六个菜单按钮、版本号全部正常。host 端统计：117 张纹理 / 723 次上传 /
约 20 MB 纹理数据、330038 次索引绘制、0 次丢弃绘制、0 个畸形批次、
11 条渲染管线（缓存命中 330027 次）。**这也印证了 4.7 节的判断——
War3 确实不需要等 M2 的 shader 编译管线就能跑到主菜单**（caps 上报
`VertexShaderVersion`/`PixelShaderVersion` 均为 0.0，游戏接受并走了
固定管线路径）。

从"命令能送达"到"画面正确"之间实测暴露并修复的问题，按发现顺序：

1. **缓冲区更新未按 4 字节对齐**——`writeBuffer` 要求 4 的倍数，而 D3D9
   的 Lock 区间没有此约束（16 位索引缓冲的局部更新是常见反例）。改为在
   host 端维护 CPU 镜像，把更新写进镜像后只重传覆盖它的 4 字节对齐区间。
2. **swapchain 贴图跨宏任务失效**——`getCurrentTexture()` 只在获取它的
   那个任务内有效，而 guest 会在 DMA 环形区写满时把一帧拆成多次 PCI
   提交。改为只记录轻量操作列表，把贴图获取/建 pass/提交全部推迟到
   Present 那一刻同步完成。
3. **WVP 矩阵乘法顺序颠倒**——存储和上传各转置了一次，净效果是
   `Wᵀ·Vᵀ·Pᵀ` 而正确形式是 `Pᵀ·Vᵀ·Wᵀ`。原 world smoke test 的 VIEW/
   PROJECTION 都是单位矩阵，恰好使顺序不可观测，因此没抓到；新测试改用
   三个互不交换的矩阵并与独立实现的参考结果逐点比对。
4. **`GetSurfaceLevel` 未实现（本次黑屏的直接原因）**——原注释断言
   "通过 `CreateTexture()`+`LockRect()` 创建的纹理不需要这个"，对 War3
   不成立：它经由 `GetSurfaceLevel` 取得层级表面再锁定写入。该调用失败
   导致 117 张纹理全部创建并绑定却从未写入一个字节，几何正常但采样恒为
   黑色。同时补上了 `UpdateTexture`（SYSTEMMEM→DEFAULT）这条等价路径。
5. **深度目标跨设备世代泄漏**——上一个进程未 Present 完的帧会把它的
   深度视图带进下一个进程的帧，尺寸不符时 WebGPU 拒绝整个命令缓冲。
   改为在 `CREATE_DEVICE` 时丢弃残留帧，并在提交前做尺寸兜底检查。

诊断方法上的一条教训值得记下：**guest 与 host 两侧都存在"静默失败"盲区**
——已实现但因参数不支持而返回 `D3DERR_INVALIDCALL` 的调用、以及 host 端
被 `if (...) return;` 吞掉的绘制，都不会留下任何痕迹，与"游戏根本没调用"
无法区分。补上带完整参数的首次命中日志（guest 侧 `TRACE_FIRST`/
`TRACE_PROBE`，host 侧 `noteDroppedDraw` 与 `droppedDraws` 计数）之后，
定位速度显著提升。`d3d9_executor.js` 里的 `debug.forceClearColor` /
`shaderMode` / `disableCull` / `disableDepthTest` 开关保留在代码中，用于
把"画面不对"快速二分成显示、几何、颜色来源等独立环节。

**M1 尚未覆盖、留给后续里程碑的**。渲染特性：固定管线光照（`SetLight`/
`SetMaterial` 只存不算）、texture stage state 的颜色/alpha 运算组合、
多于一个纹理阶段、独立 sampler state（`SetSamplerState` 只存不用）、
状态块、cube/volume 贴图、render target 与 MRT、查询对象。War3 主菜单
未依赖这些即可正确显示；进入实际战役场景后大概率会需要，届时按 M3
排期。

基础设施上还有三项本节清单提到或 D3D8 路径已具备、而 D3D9 侧尚未做的：

- **`glbridge/webgpu-runtime/` 共享模块未建立**。本节清单里写的是 host
  端"可以直接依赖"它，属许可而非强制，`d3d9_executor.js` 目前自带设备
  生命周期与缓存实现。等 M2 出现第二个消费者时再抽取，比现在为单一
  使用者预先抽象更合理（第 17 章的共享重构本就排在里程碑之后）。
- **没有 per-process session 隔离**。D3D8 路径用 64 位会话号防止不同 XP
  进程的同名数字 handle 互相踩踏，D3D9 侧目前只有一张扁平设备/资源表。
  单进程单游戏够用，但在把这条路径当作可信之前应当补上。
- **没有设备丢失恢复**。D3D8 侧能从 CPU checkpoint 重建，D3D9 侧目前只
  在 `device.lost` 时打一条错误日志。

另外实测中发现的一个尚未处理的现象：全屏模式（`windowed=0`）下 guest 侧
`GetClientRect` 返回空矩形，导致 `D9WGPresent` 携带的 width/height 为 0。
当前不影响显示（canvas 定位回退到自身尺寸），但全屏下的窗口尺寸获取需要
另行处理。

### M2：SM2.0/3.0 字节码编译管线上线

- 第 9 章整条管线：vkd3d-shader(wasm) → SPIR-V → Tint(wasm) → WGSL，
  hash 缓存、`getCompilationInfo()` 校验。
- 顶点/像素常量寄存器（F/I/B）与 uniform 打包布局（9.7）。
- 独立 sampler state（4.4、12）。
- 验收：KartRider 的水面/反光等 SM2.0 特效正确渲染，赛道可以从起点
  跑到终点，帧率达标（见 2.3 成功标准表）。

### M3：Warcraft III 固定管线与地形

- 多层贴图混合（terrain splatting，通常是多纹理阶段固定管线运算或
  简单 SM1.x 等价 shader，复用第 9 章管线即可，不需要新设计）。
- 立方体/体积贴图（若 War3 实际用到，按阶段 0 结果决定是否本阶段做）。
- 状态块（`IDirect3DStateBlock9`）完整覆盖 D3D9 新增状态。
- 验收：单机战役任意一关可从过场到目标达成，地形/单位/UI 渲染正确。

### M4：独立 sampler state 收尾 + MRT + WoW 登录/选角

- MRT（12 章后半部分）。
- `StretchRect`/`ColorFill`/`GetRenderTargetData`（对已知来源内容）。
- Occlusion/Event Query（第 13 章）。
- 验收：WoW 登录界面、服务器列表、角色选择（含单个 3D 角色模型预览与
  基础光照）稳定运行。

### M4.5（可选，用于提前拆解风险）：WoW 固定管线/最低画质路径

- 背景与前提条件见第 4.7 节。仅在阶段 0 的 WoW API trace 确认"客户端
  真的存在可用的低 shader 版本降级路径"之后才排入计划；如果确认降级
  路径本身残缺，跳过本里程碑直接进入 M5。
- `GetDeviceCaps` 如实上报当前固定管线能力（不含 SM2.0/3.0），不新增
  D9WG opcode，只是提前用真实 WoW 客户端验证 M1-M4 已实现的固定管线/
  贴图/MRT 基础设施。
- 验收：WoW 在最低画质设置下进入主世界，角色/地形/UI 可见（画质粗糙
  可接受，渲染错误/崩溃不可接受），作为 M5 完整 SM2.0/3.0 路径的提前
  的健全性检查（sanity check），而不是最终交付标准。

### M5：WoW 主世界渲染

- 顶点蒙皮（`BLENDWEIGHT`/`BLENDINDICES` 声明 + vertex shader 里的
  骨骼矩阵调色板，矩阵调色板通过 `SetVertexShaderConstantF` 大批量更新，
  这是对第 9.7 节 uniform 打包/dynamic offset 设计的真正压力测试）。
- 地形多层混合、环境/立方体贴图反射。
- 验收：进入游戏世界后可以移动镜头、看到地形与角色正确渲染，UI（小地图、
  聊天框、单位框）正确。

### M6：特效、后处理与性能收敛

- 粒子系统（通常是大量小 `Draw*UP` 或点精灵，复用已有路径，重点是
  批处理效率）。
- 后处理通道（如果实际观测到，例如热浪扭曲等全屏效果，通常表现为
  "渲染到贴图再采样"的标准 MRT/RTT 模式，不需要新协议能力）。
- Shader 编译 Worker 化（9.5 节的 pending 机制）、持久编译缓存（19 章）、
  vs_3_0 顶点纹理采样（若需要，9.9 节）、instancing（若需要，
  `SetStreamSourceFreq`）。
- 性能预算收敛（第 16 章）。

每个里程碑结束时，未达标功能不得通过"假装支持"糊弄过关：延续 D3D8 路径
"未实现返回 `D3DERR_INVALIDCALL`、caps 诚实"的纪律。

## 16. 性能设计与预算

### 16.1 每帧目标预算（相对 D3D8 路径的调整）

D3D8 路径的目标是"每帧最多三次 PCI 提交、零 pipeline 创建、无 GPU
回读"。D3D9 路径尤其是 WoW 的 draw call 量级更高，预算相应放宽但仍需
明确上限，避免"能跑但很卡"被当作交付：

- 稳态每帧 PCI 提交次数：≤ 5（比 D3D8 路径宽松，因为 MRT/多 pass 特效
  可能需要多次提交，但仍需是常数级而非随 draw call 数增长）。
- 稳态每帧 pipeline/bind-group 创建次数：0（缓存命中率是关键指标，
  首次遇到新 shader/新状态组合除外）。
- 稳态无 GPU 回读（第 2.2 节原则）。
- **新增**：首次编译 shader 的延迟需要独立采集（第 16.2 节），不与
  稳态帧时间混在一起统计，否则会掩盖"加载时卡顿"这一真实存在的问题。

### 16.2 必须暴露的运行时统计（在 D3D8 路径统计项基础上新增）

- shader 编译缓存命中/未命中次数，未命中时的编译耗时分布（p50/p95/p99）。
- 已缓存 shader 总数、总 WGSL 源码大小（估算内存/持久化存储占用）。
- occlusion query 槽位使用率与"槽位耗尽退化为总是可见"的触发次数。
- MRT 场景下的 attachment 数量分布。

### 16.3 性能对照方式

与 D3D8 路径相同：真实 XP + WineD3D 链路的基线数据（阶段 0 采集）与
D9WG 路径逐里程碑对比，任何里程碑验收前必须有一次真实 Chrome + v86
XP guest + 目标游戏的手工验收，不能只依赖 host 端单元测试通过就宣布
达标。

## 17. 与 D3D8 路径共享代码的重构建议

优先级从高到低（第 3.1 节已列出候选模块，这里给出建议顺序，避免在
D3D9 路径尚不稳定时就强行重构 D3D8 路径引入不必要的回归风险）：

1. **M1 期间**：新建 `glbridge/webgpu-runtime/webgpu_device.js`
   （设备获取/丢失监听/canvas 生命周期）与 `lru_cache.js`（通用有界
   LRU），`d3d9_executor.js` 从一开始就依赖它们；`d3d8_executor.js`
   **暂不**改造，避免同时改两条已知能跑的路径和一条新路径。
2. **M2 完成后**（D9WG 传输层与编译缓存设计已经过至少一款游戏验证）：
   评估把 `d3d8_executor.js` 里对应的内联实现迁移到共享模块，用 D3D8
   的现有测试套件（`d3d8_webgpu_executor_test.js` 等）作为回归防线。
3. **M3 完成后**：评估 `vgl2_transport.h` 头文件抽取（7.2 节），让
   `d3d8_proxy.c` 迁移过去，同样要求 D3D8 现有验收测试全部通过。

不建议把这三步压缩到 D3D9 路径的 M1 阶段一次性做完——那样任何一个环节
出错都无法区分是"D3D9 新代码的问题"还是"重构 D3D8 共享代码引入的问题"。

## 18. 测试体系

### 18.1 协议单元测试

`glbridge/tests/d9wg_protocol_consistency_test.js`：镜像现有
`d3d8_protocol_consistency_test.js`，验证 `d3d9_protocol.h` 里的
`#pragma pack(1)` 结构体大小与 JS 侧解析常量一致，防止头文件改动后
两端 silently 失配。

### 18.2 host 单元测试

`node --test glbridge/tests/d3d9_webgpu_executor_test.js`：覆盖顶点
声明→`GPUVertexBufferLayout` 映射的每种 `D3DDECLTYPE`、sampler state
去重、MRT attachment 组装、occlusion query 槽位分配/回收。

`glbridge/tests/d3d9_shader_pipeline_test.js`：字节码编译管线的单元
测试，覆盖 vs_1_1/2_0/3_0 与 ps_2_0/3_0 各自至少一个含控制流
（`if`/`loop`）的真实着色器样本、常量寄存器打包、编译失败时的
"标记不可用而非崩溃"路径、hash 缓存命中/未命中行为。这组测试需要真实
跑通 vkd3d-shader(wasm) 和 Tint(wasm)，不能只测试"调用了某个 mock
函数"。

`glbridge/tests/d3d9_webgpu_perf_test.js`：镜像现有 D3D8 性能测试，
pin 住第 16.1 节的稳态预算（用计数假设备，不需要真实 GPU）。

### 18.3 浏览器 WebGPU 测试

`glbridge/tests/d3d9_webgpu_browser_test.html`：真实 WebGPU 设备上
创建覆盖每种目标特性的 pipeline（顶点声明变体、MRT、cube/volume
采样、vs_3_0 顶点纹理采样若已实现），断言 `getCompilationInfo()` 无
`error` 级别消息，并渲染出可视化验证画面（延续 D3D8 页面"报告 PASS
才算通过"的方式，不能只看控制台无异常）。

### 18.4 Windows guest 渐进测试

延续 D3D8 路径的分阶段验收可执行文件模式
（`build_stageN_tests.sh` → `/private/tmp/d3d9-stageN-tests`），按
第 15 章的 M1-M6 拆分对应的 stage 编号，每个 stage 覆盖该里程碑新增的
API 面而不是重新跑一遍前面已经覆盖过的用例。

### 18.5 分游戏验收矩阵

三款游戏各自维护一份验收清单（截图/录屏 + 关键指标数字），格式参考
D3D8 路径 README 里 MapleStory 验收段落的写法：具体到"第几关""哪个
场景""预期看到什么""实测数值"。

### 18.6 回归要求

任何后续修改 D9WG 协议或 `d3d9_executor.js` 的改动，必须先跑通已经
达到的最高里程碑对应的 stage 测试和浏览器测试，不能只跑新增功能的
测试就合并。

## 19. Save state、恢复与确定性

### 19.1 图形恢复

与 D3D8 路径相同的原则：guest 影子状态是恢复真相来源，host 端资源表
从 checkpoint 中的 guest 状态重建。新增内容：

- 顶点声明、shader 字节码影子、shader 常量寄存器堆都需要进入
  checkpoint（延续"guest 保真"原则，这些都是 guest 端持有的真相）。
- **shader 编译结果缓存不需要进入 checkpoint**：它是从字节码 hash
  可确定性派生的产物，checkpoint 只需要保存字节码本身（已经作为
  shader 影子的一部分保存），加载时重新查缓存（若持久化缓存命中则
  直接复用，未命中则重新编译，这个重新编译不算"恢复错误"，是正常的
  缓存未命中路径）。

### 19.2 编译结果的跨会话持久缓存

建议用浏览器 `IndexedDB` 存储 `{bytecode_hash -> wgsl_source}` 映射
（不持久化 `GPUShaderModule` 本身，它是运行时对象，每次加载都要用
缓存的 WGSL 源码重新 `createShaderModule`）。淘汰策略：LRU + 总大小
上限，超限淘汰最久未使用的条目。这一项直接影响 WoW 场景下"第二次
打开网页时加载资料片内容是否还要重新跑一遍全部 shader 编译"的体验，
优先级高于大多数 M6 的其他优化项。

### 19.3 音频恢复

不变：延续 D3D8 路径的方案，与图形 save state 完全独立。

## 20. 部署、开关与回退

### 20.1 按游戏配置

延续现有站点的"每个游戏一个独立磁盘镜像/部署 profile"模式（参见
`game/` 目录与 `README.md` 里 `populateGamePage()` 的组织方式）：
KartRider/War3/WoW 各自的部署目录里放各自匹配里程碑进度的 `d3d9.dll`，
**不与** `d3d8.dll`、自定义 `opengl32.dll` 共存于同一目录（第 4.6 节）。

### 20.2 feature flags

复用 D3D8 路径的 feature-bit 协商机制（6.3 节）：host 端可以按浏览器
能力（例如 `texture-compression-bc` 是否可用、`shader-f16` 是否可用）
关闭某些 feature bit，guest 端据此调整 caps 上报，而不是等到运行时
才因为具体某个格式创建失败而崩溃。

### 20.3 构建产物管理

延续现有 `build.sh`/`build_stageN_tests.sh` 模式；额外新增
vkd3d-shader(wasm)、Tint(wasm) 的构建脚本
（`glbridge/d3d9-webgpu/build_shader_toolchain.sh`），产物体积较大
（两个 WASM 编译器），需要评估是否随页面首屏加载还是按需懒加载（建议
懒加载：只有第一次遇到需要编译的 shader 时才拉取，登录界面等纯 UI
阶段可能完全不需要触发这条路径）。

## 21. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| vkd3d-shader/Tint 裁剪编译到 WASM 的工程量被低估 | M2 延期，阻塞后续所有里程碑 | 阶段 0 结束后立刻做一次独立的"能否把 vkd3d-shader 的 D3D9 前端 + SPIR-V 后端单独编译成 WASM"的技术尖刀验证（spike），只用一个真实 SM2.0 着色器打通全链路，作为 M2 立项前置条件，而不是等到 M2 里程碑内部才发现行不通 |
| WoW 内容持续更新导致 shader 集合事实上无上限 | 编译缓存永远追不上新内容，首次加载卡顿常态化 | 优先做持久化缓存（19.2）与 Worker 化编译（9.5），把"卡顿"限定在真正首次见到某 shader 的那一次，且卡顿是加载期而非帧率下降 |
| D3DX9 运行时依赖范围超出预期（尤其是运行时 HLSL 编译） | 可能需要额外的 HLSL 编译器工程，超出本方案范围 | 阶段 0 必须明确回答（14.5 节的"行动项”），一旦确认存在则单独立项，不混入本方案时间线，也不为了赶时间而"假装支持"运行时编译 |
| 三款游戏可能存在反作弊或联网校验组件 | 无法在离线/私服环境下运行，或运行时被判定异常 | 本方案只覆盖单机/离线/私服场景下的渲染兼容层；若目标客户端版本内置强制联网反作弊，需要用户自行选择兼容的私服或离线可运行版本，这不是渲染层要解决的问题，本方案不做任何反作弊绕过设计 |
| MRT/浮点渲染目标在部分浏览器 WebGPU 实现上支持不完整 | 特定效果在部分用户设备上无法渲染 | feature bit 协商（20.2）降级：不支持时该效果直接跳过或退化为单目标近似，而不是崩溃或黑屏 |
| pipeline key 结构比 D3D8 复杂得多，容易引入缓存未命中或错误复用 | 要么性能不达标（缓存爆炸），要么渲染错误（错误复用了不该复用的 pipeline） | 第 18.2 节的单元测试必须包含"结构不同但哈希容易碰撞"的边界用例；性能测试（18.2）持续 pin 住"pipeline 创建次数为零"的稳态断言 |
| 版权与分发边界模糊 | 法律/合规风险 | 本方案与现有站点一致：不提供、不分发游戏客户端或版权资源，只提供用户自备正版客户端时的渲染兼容层；文档与代码仓库都不应包含任何游戏资源文件 |

## 22. 推荐 PR 拆分

1. `docs`: 本文档 + 架构总览（已完成）。
2. `protocol`: `d3d9_protocol.h` + `d9wg_protocol_consistency_test.js`，
   无渲染行为，只锁定二进制契约。
3. `guest-skeleton`: `d3d9proxy` 骨架（`IDirect3D9`/`IDirect3DDevice9`
   生命周期 + 批处理框架），不含任何绘制。
4. `host-skeleton`: `d3d9_executor.js` 骨架 + `glbridge/webgpu-runtime/`
   共享模块的最初两个文件（17 章第 1 步）。
5. `m1-fixed-function`: 顶点声明 + 无 shader 的固定管线 draw 路径，
   端到端跑通 `d3d8_clear_test.exe` 等价的 D3D9 版本测试。
6. `shader-toolchain-spike`: vkd3d-shader/Tint 的 WASM 构建脚本 +
   一个真实 SM2.0 着色器的端到端编译验证（21 章第一条风险的验证结果），
   建议作为独立 PR 而不是塞进 m2，方便单独 review 构建产物体积与
   许可证声明。
7. `m2-shader-pipeline`: 完整字节码编译管线 + 常量寄存器打包 + 独立
   sampler state，KartRider 达到可玩标准。
8. `m3-warcraft3`: 多层地形混合、状态块扩展、cube/volume（按需）。
9. `m4-mrt-and-wow-login`: MRT、query、WoW 登录/选角验收。
10. `m5-wow-world`: 顶点蒙皮、环境贴图、WoW 主世界验收。
11. `m6-perf-and-effects`: Worker 化编译、持久缓存、粒子/后处理、性能
    收敛。
12. `shared-refactor-*`: 17 章第 2、3 步的 D3D8/D3D9 共享代码重构，
    各自独立 PR，且要求先合并对应里程碑再发起。

## 23. 发布门槛清单（分游戏）

### KartRider

- [ ] 主菜单、角色选择、赛道加载无渲染错误。
- [ ] 至少三条赛道从起点跑到终点，帧率达标（2.3 节）。
- [ ] 水面/反光等 SM2.0 特效视觉正确（人工比对真实 XP+WineD3D 基线截图）。
- [ ] `d3d9_webgpu_perf_test.js` 稳态预算全部通过。
- [ ] 无 `D3DERR_INVALIDCALL` 被静默吞掉导致的黑屏/缺失渲染（日志审计）。

### Warcraft III

- [ ] 单机战役至少三关从过场到目标达成。
- [ ] 地形多层混合、单位选框、小地图 UI 视觉正确。
- [ ] 存档/读档（v86 save state）在战役中途保存后能正确恢复渲染状态。
- [ ] 长时间游玩（≥30 分钟单场战斗）无内存/句柄泄漏（资源计数器审计）。

### World of Warcraft

- [ ] 登录、服务器列表、角色选择界面稳定运行，含 3D 角色预览。
- [ ] 进入主世界后可正常移动镜头，地形/角色/植被渲染正确。
- [ ] UI（小地图、聊天框、单位框、技能栏）渲染正确。
- [ ] 顶点蒙皮角色动画正确（无扭曲/撕裂）。
- [ ] 至少一个包含粒子特效的场景（如法术施放）渲染正确。
- [ ] shader 编译缓存持久化生效：二次访问同一区域加载明显快于首次。
- [ ] `d3d9_webgpu_perf_test.js` 稳态预算全部通过，且首次编译延迟已
      从稳态帧时间统计中分离并单独达标。

### 通用可靠性与回退

- [ ] 三款游戏各自的部署 profile 互不干扰，且都能通过关闭 `d3d9.dll`
      回退到 WineD3D/OpenGL 代理路径验证问题是否出在新路径本身。
- [ ] 设备丢失恢复（WebGPU device lost 模拟）在三款游戏上都能自动
      重建渲染状态而不需要重启游戏进程。

## 24. 当前仓库状态与下一步建议

截至本文档撰写时：

- D3D8 路径（D8WG v1.7）已实现到 M4+/shader-model-1.x 里程碑，是本
  方案在传输层、批处理、缓存设计上的直接参照物。
- `glbridge/d3d9proxy/`、`glbridge/d3d9-webgpu/`、
  `glbridge/webgpu-runtime/` 均**尚未创建**，本文档是这些目录出现前
  的设计依据。
- `game/warcraft3.img` 已存在于站点资源里；KartRider、WoW 尚未出现在
  `game/` 目录或 `README.md` 的游戏列表中，说明这两款游戏的镜像/部署
  流程本身也需要作为阶段 0 之外的独立准备工作（与本方案的渲染兼容层
  工作正交，不应混在一起排期）。

**建议的下一步（不等待本文档之外的批准，可以直接开始）：**

1. 先做 21 章的 shader 工具链尖刀验证（vkd3d-shader/Tint 编译到
   WASM，打通一个真实 SM2.0 着色器）。这是全案风险最高的单点，越早
   验证，后续里程碑的时间估算才越可信。
2. 与尖刀验证并行，开始阶段 0（第 5 章）的三款游戏 API trace 采集，
   为 D9WG v0.1 的 opcode 集合和第 11 章格式矩阵提供真实数据而不是
   规格书全集。
3. 确认 KartRider、WoW 的镜像/资源获取与部署方式（与本文档正交，但
   是能够开始 M1 端到端验收的前提）。

## 25. 参考资料与许可边界

- Direct3D 9.0c SDK 文档（`D3DVERTEXELEMENT9`、shader model 2.0/3.0
  指令集、caps 位定义）。
- vkd3d-shader（Wine 项目，LGPL-2.1-or-later）：D3D9 字节码解析与
  SPIR-V 生成的参照/裁剪来源。若最终方案编译并分发其代码的 WASM
  产物，必须在产物旁附带 LGPL 许可证文本与源码获取方式说明（LGPL 对
  静态链接到 WASM 模块的分发有明确的源码提供义务，需要在正式引入前
  确认满足方式：动态可替换的 WASM 模块，或提供构建脚本与对应源码
  快照）。
- Tint（Chromium/Dawn 项目，BSD-3-Clause）：SPIR-V 到 WGSL 转换的
  来源，BSD-3-Clause 要求保留版权声明，义务比 LGPL 轻，但仍需在
  `THIRD_PARTY_NOTICES` 类文件中列出。
- 本文档第 3.1、17 章提到的与 D3D8 路径共享设计范式，参照
  `d3d8-webgpu-architecture.md` 中已经记录的 BottleShip 参考边界
  （BottleShip 是 Apache-2.0，D3D8 路径是基于可观察架构的原创实现；
  D3D9 路径延续同样的立场——参考公开可观察的行为/架构决策，不照抄
  受版权保护的实现代码）。
- [`LostMyCode/d3d9-webgl`](https://github.com/LostMyCode/d3d9-webgl)
  （MIT 许可，用于 GunZ: The Duel 的浏览器移植 Whiplash GunZ）：架构
  模型（源码级重编译到单一 WASM 二进制，面向 WebGL2）与本方案（面向
  未修改二进制、走 v86 + PCI DMA + WebGPU）不同，不作为代码复用来源，
  详见第 3.3 节评估。三处具体技术被本方案采纳并记录在对应章节：
  clip plane 用 fragment shader discard 模拟（9.11）、WebGPU 纹理原点
  与 D3D9 一致而不需要 WebGL 式的渲染目标 Y 翻转（8.4）、以及"caps
  如实反映能力从而让应用自行走向其固定管线降级路径"这一验证过的策略
  被推广为 WoW 的 M4.5 里程碑选项（4.7）。MIT 许可比 LGPL/BSD 更宽松，
  但本方案没有照搬其 GLSL/C++ 源码，只是复用了上述三条思路，仍在此列出
  归属以保持透明。
- 本方案不提供、不分发任何游戏客户端、资源文件或反作弊绕过手段；
  三款目标游戏均需用户自备。
