# DirectDraw 与 Direct3D 1-7 → WebGPU 转译完整实施方案

> 前置阅读：`ddraw-d3d7-webgpu-architecture.md`（架构总览，英文）、
> `d3d9-webgpu-architecture.md` 与 `d3d9-webgpu-implementation-plan.zh-CN.md`
> （D9WG 协议与 host executor 的既有设计）、`glbridge/d3d8proxy/README.md`
> （D3D8 以"翻译层"而非"第二后端"落到 D9WG 的先例）。
> 本文不重复其中仍然成立的结论，只写 DirectDraw / D3D1-7 特有的差异。
>
> 参考实现：`https://github.com/apitrace/dxsdk/tree/master/Include`（DirectX
> 7 时代的原始 SDK 头文件，用于核对结构体布局与 vtable 顺序）；
> `d7vk`（DXVK 的 D3D7/6/5/3-on-D3D9 前端，验证了"旧 D3D 不需要第二后端"
> 这一判断）。本方案与 d7vk 的关键区别：d7vk 依赖 Wine 的 `ddraw.dll` 承担
> DirectDraw 2D 部分，我们没有 Wine，2D 部分必须自己实现——而这恰好是本
> 项目游戏库里占比最大的一类。

## 1. 背景与问题定义

`game/` 目录下 32 个磁盘镜像中，约 20 个是 DirectDraw 时代的游戏：

| 类别 | 游戏 | 使用的 API |
| --- | --- | --- |
| 纯 2D（DirectDraw only） | 帝国时代 2、红警 2 / 尤里的复仇、星际争霸、英雄无敌 3、辐射 2、文明 2、主题医院、模拟城市 3000、过山车大亨 2、铁路大亨 2、大富翁 4、合金弹头、盟军敢死队 1 | DirectDraw 1-7 |
| 无限引擎 2D | 博德之门 2、冰风谷 1/2、异域镇魂曲 | DirectDraw 2/4 |
| 2D + 可选 D3D7 | 暗黑破坏神 2（D3D 模式）、暗黑破坏神 1 | DDraw + D3D7 |
| D3D5/6/7 3D | 恐龙危机、生化危机 2、神偷、极品飞车 3、Hitman 47、Road Rash、半条命 / CS（D3D 渲染器） | D3D5-7 |

这些游戏今天在 XP guest 里的实际情况是两种之一：

1. 走微软自带的软件 `ddraw.dll`，所有 blit 由 v86 解释执行的 x86 完成，再
   经 VGA framebuffer 到页面 canvas。800x600x16 全屏刷新一次是 ~940 KB 的
   逐像素搬运，在 v86 上是个位数帧率。
2. 坚持要 Direct3D HAL 的游戏（Hitman 47、恐龙危机等）直接起不来，因为
   guest 里没有任何 3D 显示驱动。

D3D8/D3D9 路径已经把"COM 前端在 guest、GPU 资源在 host"这条路走通并跑到
3DMark06。本方案把同一条路延伸到 DirectDraw 时代，一次性覆盖游戏库里数量
最多的那一类。

关键的工程判断（详见架构文档的头文件数据）：**Direct3D 7 是比 D3D8 更干净
的 D3D9 子集**——渲染状态、纹理阶段状态、`D3DTOP_*`/`D3DTA_*`/`D3DPT_*`、
`D3DLIGHT7`/`D3DMATERIAL7`/`D3DVIEWPORT7` 全部与 D3D9 数值/布局一致，而且
**完全没有可编程着色器**，即 D3D9 路径里最难的那部分（字节码编译器）在这里
不存在。真正的新工作量集中在两处，都在 guest 侧：

- **DirectDraw 的 2D 表面语义**：Lock/Unlock 的 CPU 指针、色键 blit、翻转
  链、调色板、剪裁器、GDI 互操作、显示模式与协作级别。
- **D3D1-6 的旧对象模型**：execute buffer、viewport 对象、material 对象、
  texture handle、`Begin`/`Vertex`/`End` 立即模式、strided draw。

## 2. 目标、非目标与成功标准

### 2.1 目标

- 提供 app-local `ddraw.dll`，实现 DirectDraw 1/2/3/4/7 与 Direct3D
  1/2/3/5/6/7 的**立即模式**，全部翻译为 D9WG 命令流，由现有
  `d3d9_executor.js`（加 `ddraw_ops.js`）执行。
- 不新增第二个 host 后端，不新增第二个资源表，不改动 VGL2 外层 ABI。
- 按"2D → D3D7 → D3D5/6 → D3D1/2 execute buffer"的顺序分里程碑交付，每个
  里程碑都以游戏库里的真实游戏为验收对象。

### 2.2 非目标（本方案明确不做）

- **不实现 Direct3D Retained Mode**（`d3drm.dll`）。它是建立在立即模式之上
  的独立 DLL，如果 guest 里保留微软自带的 `d3drm.dll`，它会调用我们的
  `IDirect3D3`/`IDirect3DDevice3`，可能顺带能跑，但这不是验收目标，也不为它
  做任何适配。d7vk 同样明确不支持。
- **不实现 Ramp/Mono 设备**（`IID_IDirect3DRampDevice`、
  `D3DRENDERSTATE_MONOENABLE`/`ROP2`/`PLANEMASK`/`STIPPLE*`）。这是 1996 年
  软件光栅器的调色板光照模型，与 GPU 管线无对应物。`EnumDevices` 不枚举它，
  `CreateDevice` 对该 GUID 返回 `DDERR_INVALIDPARAMS`。
- **不实现 DirectDraw VideoPort**（`IDDVideoPortContainer`、`dvp.h`）。它是
  硬件视频捕获端口，1998 年之后的游戏都不用。
- **不实现 Glide**（暗黑 2、极品飞车 3 的另一条渲染路径）；这些游戏走它们的
  D3D 路径。
- **不实现 DirectInput/DirectSound/DirectPlay**。本方案只覆盖图形。
- **不支持 Windows 98/ME guest**。传输层 `v86gl.sys` 是 WDM 驱动，只有 XP /
  2000 有。
- **不支持 `CoCreateInstance(CLSID_DirectDraw)` 创建路径**（走注册表解析到
  `system32\ddraw.dll`，绕过 app-local 副本）。M0 会统计目标游戏里有没有人这
  么做；如果有，再单独立项做每镜像的 COM 注册。
- **第一阶段不实现 DirectDraw 的多显示器/多设备枚举**：只枚举主显示设备。

### 2.3 分里程碑成功标准

| 里程碑 | 验收游戏 | 最低标准 |
| --- | --- | --- |
| M1 2D 基线 | 帝国时代 2、英雄无敌 3 | 主菜单与游戏内画面完全正确（含调色板动画与精灵透明），800x600 下不低于 30fps，退出干净 |
| M2 2D 完整 | 红警 2 / 尤里、无限引擎四作、辐射 2、星际争霸 | 全部可玩；窗口/全屏切换、剪裁器、GDI 文字、`WaitForVerticalBlank` 节奏正确 |
| M3 D3D7 | 暗黑 2（D3D 模式）、Hitman 47、半条命 D3D 渲染器 | 进入游戏并可玩，多重纹理/雾/Alpha 测试/深度缓冲正确 |
| M4 D3D5/6 | 恐龙危机、生化危机 2、极品飞车 3、神偷 | 可玩；`IDirect3DDevice2/3` 的 viewport/material/light 对象模型与 texture handle 正确 |
| M5 execute buffer | 3DMark99 / 任一 D3D1-2 demo | 能正确解析并执行 execute buffer；游戏库里目前没有强依赖此路径的标题，故以合成用例验收 |
| M6 收敛 | 全部 | 性能预算达标、偏差清单齐全、save/load 状态处理有明确结论 |

补充基准：**3DMark2000** 是 D3D7 时代的标准跑分，作为 M3 之后的一致性基准
（对应 D3D8 路径的 3DMark2001、D3D9 路径的 3DMark06）。

## 3. 总体架构

```text
game.exe
  └─ app-local ddraw.dll                       (glbridge/ddrawproxy/)
       ├─ DirectDraw COM: IDirectDraw/2/3/4/7, Surface/2/3/4/7,
       │    Palette, Clipper, ColorControl, GammaControl
       ├─ Direct3D COM:   IDirect3D/2/3/7, Device/2/3/7, Texture/2,
       │    Viewport/2/3, Material/2/3, Light, ExecuteBuffer,
       │    VertexBuffer/7
       ├─ 表面影子内存 + 脏矩形跟踪
       ├─ 旧状态 → D3D9 状态翻译（ddraw_protocol.h）
       └─ D9WG 命令发射器（与 d3d8proxy 同构的 emit_command/submit_batch）
  └─ v86gl.sys → PCI BAR → 16 MiB DMA 环
       └─ v86_network_bridge.js  (fn=0xFFE1 → d3d9Executor.submit)
            └─ d3d9_executor.js + ddraw_ops.js  →  WebGPU
```

三条既有前端（`d3d8.dll`/`d3d9.dll`/`opengl32.dll`）与 `ddraw.dll` 互斥部署，
理由不变：一个 DMA 竞技场、一个 overlay canvas、一个所有者。

### 3.1 与 D3D8 路径的复用边界

| 复用 | 说明 |
| --- | --- |
| D9WG framing、batch header、session id、response 区、heartbeat | 原样使用，`ddraw_protocol.h` `#include "../d3d9proxy/d3d9_protocol.h"` |
| `emit_command`/`submit_batch_locked`/`batch_capacity`/`allocate_handle` | 按 d3d8proxy 的先例复制同构实现（约 250 行），不做跨 DLL 共享——三个 DLL 各自独立编译，共享头文件会把三者的生命周期绑死 |
| `d3d8_stage_state_to_sampler_state()` | D3D7 的 10 个采样类 TSS 里有 9 个与 D3D8 完全相同，直接复用该映射，只需补 `D3DTSS_ADDRESS`(12) |
| host 的资源表、frame/pass 构建、pipeline/bindgroup/sampler 缓存、固定管线 | 全部复用 |
| guest 侧软件 T&L（`d3d9_proxy.c` 的 ProcessVertices 实现） | 供 `IDirect3DVertexBuffer7::ProcessVertices` 与 execute buffer 的 `D3DOP_PROCESSVERTICES` 使用 |

### 3.2 新增文件

```text
glbridge/ddrawproxy/
  ddraw_protocol.h     翻译层：旧状态→D3D9 状态的映射表 + D9WG 1.7 新增结构体
  ddraw_proxy.c        全部 COM 实现（预计 12k-16k 行，与 d3d9_proxy.c 同量级）
  ddraw.def            导出表
  build.sh             与 d3d9proxy/build.sh 同构，含无 CRT 导入校验
  README.md            实现了什么、偏差在哪里（与 d3d9proxy/README.md 同规格）
glbridge/d3d9-webgpu/
  ddraw_ops.js         D9WG 0x500 组的 host 实现（handler mixin）
glbridge/tests/
  ddraw_protocol_consistency_test.js
  ddraw_webgpu_executor_test.js
  ddraw_blit_colorkey_test.js
glbridge/sample/
  ddraw_*_test.c       guest 内运行的验收样例（与 d3d8_*/d3d9_* 同规格）
```

## 4. 核心架构决策

### 4.1 表面就是纹理，不引入第二种资源

DirectDraw surface 直接映射到 D9WG 的 `CREATE_TEXTURE_2D` / `UPDATE_TEXTURE`
/ `DESTROY_RESOURCE`。宽高、格式、mip 链（`DDSCAPS_MIPMAP` 的 attached 链
折叠为 `level_count`）、cube map（`DDSCAPS2_CUBEMAP` → `CREATE_TEXTURE_CUBE`）
都有现成对应物。

**后果（必须遵守）**：DirectDraw 的 attached surface 图（`AddAttachedSurface`
/ `GetAttachedSurface` / `EnumAttachedSurfaces`）是纯 guest 侧的对象关系图，
不上线。翻转链、Z 缓冲附着、mip 链在 guest 侧解析成"哪个 handle 参与哪次
操作"，host 永远只看到扁平的 handle。

### 4.2 翻转在 guest 侧轮转，host 不引入 flip chain 概念

`Flip()` 的语义是轮转翻转链里各表面的"当前扫描输出者"。guest 侧维护环形
下标，翻转后把新的 front buffer 用 `DD_BLT` 拷到 swapchain image（handle 0）
再 `PRESENT`。代价是每帧一次全屏 GPU 拷贝（640x480 量级，可忽略），收益是
host 不需要任何翻转链生命周期，且**窗口模式下"直接 Blt 到 primary"与全屏
翻转走的是同一条路径**。

`DDFLIP_NOVSYNC`/`DDFLIP_WAIT`/`DDFLIP_INTERVALn` 记录在 guest 侧统计里，
不改变 host 行为（浏览器的呈现节奏由 rAF 决定）——列入偏差清单。

### 4.3 P8 表面在 GPU 侧保持索引，不做 CPU 展开

现有 D3D9 路径把 P8 在 host 上 CPU 展开成 RGBA，并在调色板变化时整表重绘
（`repaintPalettizedTextures`）。DirectDraw 路径**不能**这么做，理由是正确性
而不是性能：

- 2D 游戏整帧都在做 P8→P8 的 blit，表面里存的是**索引**；之后换调色板必须
  改变"更早 blit 进去的像素"的颜色。RGBA 拷贝无法反查索引，那些像素会被永久
  冻结在 blit 当时的调色板上。
- 色键在 P8 上比较的是索引本身，不是颜色。
- 调色板动画（帝国时代 2 的水面、无限引擎的渐变、辐射 2 的火光）是这个时代的
  常规手法，每帧换表；CPU 整表重绘 800x600 会成为主要开销。

因此 DirectDraw 的 P8 表面在 host 上存为 `r8uint`，采样与呈现时经 256 项
调色板 buffer 解析。换调色板 = 1 KiB 的 `writeBuffer`。

**与现有 D3D9 P8 路径的关系**：两条路径并存，由资源创建时的来源标记区分。
不改 D3D9 既有行为（它已被现有测试覆盖），只为 DirectDraw 创建的 P8 表面走
索引路径。

### 4.4 色键必须在源格式的整数域里比较，且两侧扩展规则必须**完全一致**

`DDCOLORKEY` 给的是源表面**原生格式**的像素值区间 `[low, high]`
（RGB565 就是 16 位值，P8 就是索引）。GPU 上比较的是 host 上传时展开出来的
8 位纹素。因此 guest 展开色键的规则，必须与 host 展开纹素的规则逐值相同。

**规则本身是可选的，一致性不是。** 采用 host 既有的规则：

```c
    return (value * 255u) / max;    /* 截断缩放 */
```

即 `d3d9_executor.js` 的 `expandRowToGPU` 已经在用的 `(v * 255 / max) | 0`。
DirectDraw 时代硬件用的是**高位复制**（`(v5<<3)|(v5>>2)`），两者在普通数值上
就会差 1——5 位的 24 缩放成 197、复制成 198——用另一条规则展开的色键在这些
颜色上**必然失配**，表现是"该透明的精灵变成一块实心矩形"。

之所以是 guest 让步：host 那条规则是既有实现，D3D8/D3D9 路径上每一张 16 位
纹理都在走它，且已有测试覆盖。

P8 表面走 `r8uint`，直接整数比较索引，不涉及扩展。

`ddraw_channel_expansion_test.js` 会**真的编译** `ddraw_protocol.h` 里的这个
函数并逐值与 executor 的规则比对（每种位宽的每个取值），两侧不可能悄悄漂移。

> 实施记录：M1 编码时这条正是先写错的一条——guest 先按高位复制实现，
> 与 host 的截断缩放在 24/31、48/63 等值上不一致，由上述测试抓出后改为
> 与 host 一致。这是本方案里最典型的"看不出来的错"。

### 4.5 Lock/Unlock：影子内存 + 脏矩形，只在 GPU 真的写过时才回读

每个表面在 guest 侧有一块系统内存影子：

- `Lock(rect)` 返回影子内存里的指针，`lPitch` 由我们决定（按 4 字节对齐的
  行距），`Unlock` 时把 lock 过的矩形用 `UPDATE_TEXTURE` 上传。
- `DDLOCK_READONLY` 的 Unlock 不上传。
- 表面带"GPU 已写"标记（被 `DD_BLT` 写过、被 D3D7 当过渲染目标）时，`Lock`
  必须先用 `READBACK_SURFACE` 同步回读，再返回指针；否则读到的是过期数据。
  没有该标记时不回读——这是绝大多数 2D 游戏的情况（它们在系统内存里画完整
  帧再 Blt 到 primary）。
- 回读走 D9WG 既有的 response 区 + heartbeat 机制，超时判据是"host 停止推进"
  而不是墙钟时间（沿用 D3D9 路径的结论）。

### 4.6 可锁表面尽量直接落在 DMA 竞技场里

M2 的性能优化项：当表面尺寸允许时，把影子内存直接分配在 16 MiB DMA 竞技场
的一段固定区域里，`Unlock` 就退化为"发一条引用该偏移的 `UPDATE_TEXTURE`"，
省掉一次 guest 内 `memcpy`。竞技场可用空间约 12 MiB（末 4 MiB 是 response
区），一个 800x600x32 的表面 1.9 MiB，所以这是"给最热的 1-3 个表面用"的优化
而不是通用分配器。分配失败时无缝退回普通堆影子内存。

### 4.7 剪裁器在 guest 侧解析

`IDirectDrawClipper` 的 `SetHWnd` 情形下，剪裁矩形列表就是窗口可见区域；
`SetClipList` 情形下直接给出 `RGNDATA`。两种都在 guest 侧解析成矩形数组，
把一次 Blt 拆成 N 次 `DD_BLT`。host 不需要剪裁概念。N 很大时（复杂遮挡）
退化为一次全矩形 blit 加统计计数——列入偏差清单。

### 4.8 显示模式与独占全屏：先真改分辨率，失败再 1:1 覆盖

`SetCooperativeLevel(EXCLUSIVE|FULLSCREEN)` + `SetDisplayMode(w,h,bpp)` 的
处理顺序：

1. 尝试 `ChangeDisplaySettings` 把 guest 桌面真的切到该模式。v86 的 VGA/VBE
   支持 640x480/800x600 的 8/16/32bpp。成功时：游戏窗口 = 全屏，overlay
   canvas 覆盖整个 v86 画面，**鼠标坐标天然 1:1 对齐**。
2. 失败时：不改桌面，创建一个 w×h 的窗口置于 (0,0)，overlay 按 1:1 呈现。

**绝不做的事**：把 640x480 的画面拉伸到 1024x768 的 overlay 上却不同步变换
输入坐标。那会让画面正确、鼠标全错，而且从截图上完全看不出来。拉伸模式作为
后续独立特性，必须与站点侧的输入坐标变换一起上线。

`GetDisplayMode` 恒定返回当前生效的模式，`EnumDisplayModes` 只枚举我们真的
能呈现的模式集合（沿用"只声明真正实现的能力"这一纪律）。

### 4.9 D3D1-6 的旧对象模型全部在 guest 侧折叠

viewport 对象（`IDirect3DViewport3`）、material 对象（`IDirect3DMaterial3`）、
light 对象（`IDirect3DLight`）、texture handle（`GetHandle` +
`D3DRENDERSTATE_TEXTUREHANDLE`）、matrix handle（`CreateMatrix`/`SetMatrix`）
在 D3D7 里都消失了，被设备上的直接方法取代。host 只认 D3D7/D3D9 形态的状态，
所以这些对象的语义全部在 guest 侧解析：

- viewport → `SET_VIEWPORT`（当前 viewport 由 `SetCurrentViewport` 决定）+
  背景材质的 `CLEAR`。
- material/light → `SET_MATERIAL` / `SET_LIGHT` / `LIGHT_ENABLE`。
  `D3DLIGHT`/`D3DLIGHT2` 的 `dwFlags` 里 `D3DLIGHT_ACTIVE` 位映射到
  `LIGHT_ENABLE`。
- texture handle → 一张 guest 侧 handle→表面 的注册表，
  `D3DRENDERSTATE_TEXTUREHANDLE` 翻译为 `SET_TEXTURE(stage 0)`。
- matrix handle → guest 侧矩阵表，`D3DOP_STATETRANSFORM` 与
  `IDirect3DDevice::SetMatrix` 都写这张表，随后发 `SET_TRANSFORM`。

### 4.10 caps 只声明真正实现的能力

沿用 repo 纪律：`GetCaps`（`D3DDEVICEDESC7`、`D3DDEVICEDESC`、`DDCAPS`）里的
每一位都要在代码里有对应实现，`ddraw_proxy.c` 的 `fill_caps` 处以注释指明
实现位置。没实现的能力位不点亮，宁可让游戏走它的兼容路径，也不要点亮之后在
渲染上撒谎。

### 4.11 拒绝要显式、可见

沿用 D3D9 路径的 `D9WG_OP_GUEST_LOG`：guest 拒绝掉的调用（未实现的 blit
标志、不支持的设备 GUID、超出格式矩阵的表面）以去重后的诊断消息发到 host，
出现在浏览器控制台。"画面不对"和"我们明确拒绝了某个调用"是两类问题，必须能
一眼分开。

## 5. 阶段 0：基线与 API 面追踪

在写任何实现代码之前，先拿到事实：

1. 在 XP guest 里放一个**只做转发与统计**的 `ddraw.dll`（`LoadLibrary`
   真实的 `system32\ddraw.dll`，包装全部 vtable，记录调用），对 M1-M4 的
   验收游戏各跑一遍，产出：
   - 每个游戏实际用到的接口版本（`IDirectDraw2` 还是 `7`？`Surface3` 还是
     `Surface7`？）与方法集合；
   - `Blt` 标志位直方图（`DDBLT_KEYSRC` 占比、有没有 ROP、有没有镜像）；
   - 表面创建参数直方图（格式、caps、尺寸、数量峰值）；
   - Lock 频率与锁定矩形面积（决定 4.6 的优化是否必要）；
   - 是否出现 `CoCreateInstance` 创建路径、GDI 互操作、overlay。
2. 验证 app-local `ddraw.dll` 在目标 guest 镜像里确实被优先加载（确认
   `ddraw` 不在该镜像的 `KnownDLLs` 注册表项里）。
3. 验证 `ChangeDisplaySettings` 在 v86 的 XP guest 里能切到 640x480x8 /
   800x600x16（决定 4.8 走哪条分支）。

### 阶段 0 退出条件

- 上述直方图落盘为 `docs/` 下的一份数据附录；
- 4.8 的分支、4.6 的必要性、`CoCreateInstance` 是否需要立项，三个问题都有
  基于数据的结论；
- M1 的 opcode 子集据此定稿。

## 6. D9WG 协议 1.7 增量

版本号 `D9WG_VERSION_MINOR` 由 6 升到 7。**不破坏既有布局**：只新增 opcode，
既有结构体一个字段都不动，`d3d8.dll`/`d3d9.dll` 无需重新编译。

新 opcode 集中在 `0x500` 段（现有分组：`0x1xx` 资源、`0x2xx` 状态、
`0x3xx` 绘制、`0x4xx` 查询）：

```c
D9WG_OP_DD_BLT                 = 0x500,
D9WG_OP_DD_SET_COLOR_KEY       = 0x501,
D9WG_OP_DD_SET_SURFACE_PALETTE = 0x502,
D9WG_OP_DD_SET_DISPLAY_MODE    = 0x503,
D9WG_OP_DD_UPDATE_OVERLAY      = 0x504,   /* M6 */
```

### 6.1 `DD_BLT`

```c
typedef struct D9WGDDBlt {          /* 80 字节 */
    uint32_t device_handle;
    uint32_t source_handle;        /* 0 = swapchain image */
    uint32_t source_level;
    uint32_t source_face;          /* cube map 面，2D 表面恒为 0 */
    int32_t  source_rect[4];       /* left, top, right, bottom */
    uint32_t destination_handle;   /* 0 = swapchain image */
    uint32_t destination_level;
    uint32_t destination_face;
    uint32_t flags;                /* D9WG_DDBLT_* */
    int32_t  destination_rect[4];
    uint32_t fill_color;           /* COLOR_FILL：目标格式的原生值 */
    float    fill_depth;           /* DEPTH_FILL */
    uint32_t fill_stencil;
    uint32_t reserved;
} D9WGDDBlt;

#define D9WG_DDBLT_KEY_SOURCE      (1u << 0)  /* 源色键，读源表面的 SRCBLT key */
#define D9WG_DDBLT_KEY_DESTINATION (1u << 1)  /* 目标色键 */
#define D9WG_DDBLT_MIRROR_X        (1u << 2)
#define D9WG_DDBLT_MIRROR_Y        (1u << 3)
#define D9WG_DDBLT_COLOR_FILL      (1u << 4)
#define D9WG_DDBLT_DEPTH_FILL      (1u << 5)
#define D9WG_DDBLT_FILTER_LINEAR   (1u << 6)
```

语义要点：

- `source_rect` 与 `destination_rect` 尺寸不同即为拉伸（DirectDraw 的
  `Blt` 允许，`BltFast` 不允许）。
- 无色键、无镜像、格式相同、尺寸相同 → 走 `copyTextureToTexture` 快路径
  （复用 `onStretchRect` 已有的判断）。
- 其余情形 → 走 blit 渲染管线：一个全屏三角形 + 采样源纹理的片元着色器，
  按 flags 选择变体（色键 discard / 镜像的 UV 翻转 / 索引格式的直通）。
  管线按 `(源格式, 目标格式, flags)` 键缓存。
- 目标是索引（`r8uint`）表面时，管线必须是**整数直通**：不采样调色板，不做
  过滤，把源索引原样写入目标。这是 P8→P8 精灵 blit 的正确行为。
- `COLOR_FILL` 复用既有 `onColorFill` 的实现路径。

表面的"索引存储"标记不占新命令：`CREATE_TEXTURE_2D` 的 `usage` 增加一个
私有位 `D9WG_USAGE_DDRAW_INDEXED`（bit 31，`D3DUSAGE` 从不定义该位），
带此位的 P8 纹理在 host 上存为 `r8uint` 并在采样/呈现时经调色板解析。

### 6.2 `DD_SET_COLOR_KEY`

```c
typedef struct D9WGDDSetColorKey {
    uint32_t surface_handle;
    uint32_t key_kind;      /* 0=SRCBLT 1=DESTBLT 2=SRCOVERLAY 3=DESTOVERLAY */
    uint32_t color_low;     /* 已按 4.4 扩展到 8bit/通道，或索引原值 */
    uint32_t color_high;
    uint32_t present;       /* 0 = 清除该色键 */
    uint32_t reserved;
} D9WGDDSetColorKey;
```

色键是**表面状态**，不是 blit 参数：`DDBLT_KEYSRC` 的含义就是"用源表面上
挂着的那个键"。`DDBLT_KEYSRCOVERRIDE`（blit 自带键）在 guest 侧解析成"先发
一条临时 `DD_SET_COLOR_KEY`，blit 后恢复"，避免给 `DD_BLT` 再加两个字段。

### 6.3 `DD_SET_SURFACE_PALETTE`

```c
typedef struct D9WGDDSetSurfacePalette {
    uint32_t surface_handle;
    uint32_t palette_index;   /* 复用既有 SET_PALETTE 装填的调色板槽位 */
    uint32_t flags;           /* bit0: 该表面是索引存储 */
    uint32_t reserved;
} D9WGDDSetSurfacePalette;
```

调色板数据本身仍由既有 `D9WG_OP_SET_PALETTE` 装填（256 项 `D3DCOLOR`）。
本命令只做"哪个表面用哪个槽位"的绑定。表面没有绑定时回退到设备当前调色板，
与 D3D9 行为一致。

### 6.4 `DD_SET_DISPLAY_MODE`

```c
typedef struct D9WGDDSetDisplayMode {
    uint32_t device_handle;
    uint32_t width;
    uint32_t height;
    uint32_t bits_per_pixel;
    uint32_t refresh_rate;
    uint32_t cooperative_flags;  /* EXCLUSIVE / FULLSCREEN / NORMAL */
    uint32_t guest_mode_changed; /* ChangeDisplaySettings 是否真的成功 */
    uint32_t reserved;
} D9WGDDSetDisplayMode;
```

host 据此设定 swapchain image 的尺寸与呈现比例，并把结果通过既有的
`onSurface` 回调交给 `v86_network_bridge.js` 定位 overlay canvas。
`guest_mode_changed` 让 host 知道该覆盖整块画面还是只覆盖窗口矩形——这个
事实只有 guest 知道，推断不出来。

### 6.5 `DD_UPDATE_OVERLAY`（M6）

```c
typedef struct D9WGDDUpdateOverlay {
    uint32_t surface_handle;
    uint32_t overlay_id; /* DuplicateSurface 别名有独立 overlay 身份 */
    int32_t  source_rect[4];
    int32_t  destination_rect[4];
    uint32_t flags;      /* SHOW/HIDE/KEYSRC/KEYDEST/MIRROR/OVERRIDE */
    uint32_t z_order;
    uint32_t destination_handle;
} D9WGDDUpdateOverlay;
```

近似实现：把 overlay 表面在 `PRESENT` 前合成到 swapchain image 上，按
`z_order` 排序、按色键 discard。与真实硬件 overlay 的区别（不参与 GDI 合成、
不独立于翻转链刷新）写进偏差清单。

### 6.6 解析器安全

沿用既有规则：未知 opcode 按 `size` 跳过而不是报错；所有矩形、handle、
偏移在 host 侧做边界检查；`DD_BLT` 的矩形必须先与源/目标的实际尺寸求交，
空交集直接返回并计数。

## 7. Guest DLL：COM 对象模型

### 7.1 一个对象，多套 vtable

DirectDraw 的版本化接口（`IDirectDraw` → `IDirectDraw7`）**指向同一个对象**：
`QueryInterface` 在版本之间来回转换必须返回一致的身份，且引用计数是共享的。
实现方式与 Wine 相同：

```c
typedef struct DDSurface {
    const IDirectDrawSurface7Vtbl *vtbl7;   /* 必须是第一个成员 */
    const IDirectDrawSurface4Vtbl *vtbl4;
    const IDirectDrawSurface3Vtbl *vtbl3;
    const IDirectDrawSurface2Vtbl *vtbl2;
    const IDirectDrawSurfaceVtbl  *vtbl1;
    LONG   ref;
    ...
} DDSurface;
```

从任一 vtable 指针反算对象基址（`CONTAINING_RECORD` 风格的偏移减法）。

**必须小心的两处版本语义差异**（这类差异是旧 DDraw 移植的经典坑）：

- `IDirectDrawSurface7::Lock` 的 `DDSURFACEDESC2` 与 `Surface3` 及更早的
  `DDSURFACEDESC` 大小不同（`dwSize` 区分）。所有接受描述符的方法都要按
  `dwSize` 分派，且**拒绝 `dwSize` 不匹配的调用**（`DDERR_INVALIDPARAMS`），
  而不是猜。
- `IDirectDrawSurface::Blt` 系列在 1/2/3 版与 4/7 版之间参数类型相同，但
  `GetAttachedSurface` 的匹配规则在 v1 与 v7 之间不同（v7 要求 caps 精确
  匹配）。按版本分别实现，不要共用一份。

### 7.2 实现顺序

| 顺序 | 接口 | 里程碑 |
| --- | --- | --- |
| 1 | `IDirectDraw7` + `IDirectDrawSurface7` + `IDirectDrawPalette` + `IDirectDrawClipper` | M1 |
| 2 | `IDirectDraw`/`2`/`4` 与 `IDirectDrawSurface`/`2`/`3`/`4` 的 vtable 薄层 | M2 |
| 3 | `IDirect3D7` + `IDirect3DDevice7` + `IDirect3DVertexBuffer7` | M3 |
| 4 | `IDirect3D3`/`2`/`1` + `IDirect3DDevice3`/`2` + `Viewport3`/`2`/`1` + `Material3`/`2`/`1` + `Light` + `Texture2`/`1` | M4 |
| 5 | `IDirect3DDevice`（execute buffer）+ `IDirect3DExecuteBuffer` | M5 |
| 6 | `IDirectDrawColorControl`、`IDirectDrawGammaControl`、overlay | M6 |

各接口方法数（用于工作量估算，来自头文件统计）：DirectDraw 侧
`IDirectDraw*` 23/24/25/28/30、`IDirectDrawSurface*` 36/39/40/45/49、
`Palette` 7、`Clipper` 9；Direct3D 侧 `IDirect3D*` 9/9/12/8、
`IDirect3DDevice*` 22/33/42/49、`Viewport*` 16/18/21、`Material*` 9/6/6、
`Texture*` 8/6、`ExecuteBuffer` 10、`VertexBuffer*` 8/9、`Light` 6。
合计约 680 个方法槽位，其中大量是版本薄层与 `Get*` 影子状态查询。

### 7.3 导出表

```text
DirectDrawCreate            DirectDrawCreateEx        DirectDrawCreateClipper
DirectDrawEnumerateA/W      DirectDrawEnumerateExA/W
DllGetClassObject           DllCanUnloadNow
```

另外必须导出真实 `ddraw.dll` 的这些符号，否则静态导入它们的游戏**加载即
失败**（与 D3D8 路径上 Warcraft III 的 `ValidateVertexShader` 是同一类问题）：

```text
AcquireDDThreadLock         ReleaseDDThreadLock       D3DParseUnknownCommand
CompleteCreateSysmemSurface DDInternalLock            DDInternalUnlock
GetDDSurfaceLocal           GetSurfaceFromDC          RegisterSpecialCase
DSoundHelp                  SetAppCompatData          GetOLEThunkData
```

其中 `D3DParseUnknownCommand` 有真实语义（execute buffer 的未知命令解析），
M5 实现；其余按"存在且返回合理值"实现，被真正调用时发 `GUEST_LOG`。

### 7.4 线程与锁

DirectDraw 应用普遍是单渲染线程 + 可能的音频/输入线程。沿用 D3D9 路径的
策略：一把进程级临界区保护 DMA 竞技场与批处理状态，COM 对象的引用计数用
`InterlockedIncrement`/`Decrement`。不实现 `AcquireDDThreadLock` 的真实
跨进程语义。

## 8. 格式矩阵

DirectDraw 的 `DDPIXELFORMAT` 用位掩码描述格式，必须映射到 D9WG 的
`D3DFORMAT` 枚举。M1 支持集合：

| DDPIXELFORMAT | D3DFORMAT | host 存储 | 备注 |
| --- | --- | --- | --- |
| `DDPF_PALETTEINDEXED8` | `D3DFMT_P8` | `r8uint` + palette | 2D 游戏主力格式，走索引路径 |
| `DDPF_RGB` 16bpp `565` | `D3DFMT_R5G6B5` | `rgba8unorm` | 截断式 `value*255/max` 扩展 |
| `DDPF_RGB` 16bpp `1555` | `D3DFMT_A1R5G5B5` | `rgba8unorm` | |
| `DDPF_RGB` 16bpp `555` | `D3DFMT_X1R5G5B5` | `rgba8unorm` | |
| `DDPF_RGB` 16bpp `4444` | `D3DFMT_A4R4G4B4` | `rgba8unorm` | |
| `DDPF_RGB` 24bpp `888` | `D3DFMT_R8G8B8` | `rgba8unorm` | 行内 3 字节，上传时展开 |
| `DDPF_RGB` 32bpp `8888`/`x888` | `D3DFMT_A8R8G8B8` / `X8R8G8B8` | `rgba8unorm` | |
| `DDPF_ALPHA` 8bpp | `D3DFMT_A8` | `r8unorm` | |
| `DDPF_LUMINANCE` 8bpp | `D3DFMT_L8` | `r8unorm` | |
| `DDPF_ZBUFFER` 16/24/32 | `D3DFMT_D16` / `D24X8` / `D24S8` | depth | `dwZBufferBitDepth`/`dwStencilBitDepth` 决定 |
| `DDPF_FOURCC` `DXT1..DXT5` | 同名 | BC1-3 | D3D7 支持压缩纹理，M3 起 |
| `DDPF_FOURCC` `UYVY`/`YUY2` | 同名 | 既有 YUV 路径 | overlay，M6 |
| `DDPF_PALETTEINDEXED1/2/4` | — | — | 拒绝并 `GUEST_LOG`；实际游戏未见使用 |

`EnumSurfaces` / `EnumTextureFormats` / `EnumZBufferFormats` 只枚举本表里
真的支持的项。

## 9. Direct3D 7 → D9WG 映射

| D3D7 | D9WG / D3D9 | 处理位置 |
| --- | --- | --- |
| `IDirect3D7::CreateDevice(guid, surface, ...)` | `CREATE_DEVICE` + `SET_RENDER_TARGET(surface)` | guest |
| `IID_IDirect3DHALDevice` / `IID_IDirect3DTnLHalDevice` | 同一实现（T&L 本来就在 GPU 上） | guest |
| `IID_IDirect3DRGBDevice` | 同一实现，别名；`RampDevice`/`MMXDevice` 拒绝 | guest，偏差清单 |
| `SetRenderState` 的 53 个共有状态 | 同号直通 | `ddraw_protocol.h` |
| `TEXTUREHANDLE`(1) | `SET_TEXTURE(0, handle)` | guest handle 表 |
| `TEXTUREADDRESS`(3)/`TEXTUREADDRESSU`(44)/`V`(45)/`WRAPU`(5)/`WRAPV`(6) | `SET_SAMPLER_STATE` ADDRESSU/V | guest |
| `TEXTUREMAG`(17)/`TEXTUREMIN`(18) | `SET_SAMPLER_STATE` MAG/MIN/MIPFILTER | guest |
| `MIPMAPLODBIAS`(46)/`ANISOTROPY`(49)/`BORDERCOLOR`(43) | 对应 sampler state | guest |
| `TEXTUREMAPBLEND`(21) | 展开为 `COLOROP`/`ALPHAOP` 阶段级联（`MODULATE`/`ADD`/`DECAL*` 各一套） | guest |
| `ZBIAS`(47) | `DEPTHBIAS`，用 D3D8 路径同一常数 `-0.000005f/级` | 复用 `d3d8_protocol.h` 的结论 |
| `COLORKEYENABLE`(41)/`COLORKEYBLENDENABLE`(144) | 纹理上传时把色键像素的 alpha 置 0 + `ALPHATESTENABLE` | guest，偏差清单 |
| `ANTIALIAS`(2)/`EDGEANTIALIAS`(40) | 忽略（WebGPU 无对应物），记录 | guest |
| `MONOENABLE`/`ROP2`/`PLANEMASK`/`STIPPLE*`/`SUBPIXEL*`/`TRANSLUCENTSORTINDEPENDENT`/`EXTENTS`/`FLUSHBATCH`/`ZVISIBLE`/`STIPPLEDALPHA`/`TEXTUREPERSPECTIVE` | 影子保存供 `GetRenderState`，不上线 | guest |
| `SetTextureStageState` 的 19 个共有状态 | 同号直通 | 直通 |
| 10 个采样类 TSS | `SET_SAMPLER_STATE`，复用 `d3d8_stage_state_to_sampler_state()`，补 `ADDRESS`(12) | `ddraw_protocol.h` |
| `SetTransform` WORLD/WORLD1-3 | `D3DTS_WORLDMATRIX(0..3)` = 256..259 | guest |
| `SetLight`/`GetLight`（`D3DLIGHT7`） | `SET_LIGHT`，结构体逐字节相同 | memcpy |
| `D3DLIGHT_PARALLELPOINT`(4) | 近似为 `DIRECTIONAL` | 偏差清单 |
| `D3DLIGHT_GLSPOT`(5) | 近似为 `SPOT` | 偏差清单 |
| `SetMaterial`（`D3DMATERIAL7`） | `SET_MATERIAL`，逐字节相同 | memcpy |
| `SetViewport`（`D3DVIEWPORT7`） | `SET_VIEWPORT`，逐字节相同 | memcpy |
| `Clear` | `CLEAR` | 直通 |
| `DrawPrimitive`/`DrawIndexedPrimitive`（FVF + 用户内存） | `SET_FVF` + `DRAW_PRIMITIVE_UP` / `DRAW_INDEXED_PRIMITIVE_UP` | guest |
| `DrawPrimitiveStrided`/`DrawIndexedPrimitiveStrided` | guest 侧交织成单一顶点流后同上 | guest |
| `DrawPrimitiveVB`/`DrawIndexedPrimitiveVB` | `SET_STREAM_SOURCE` + `DRAW_*` | guest |
| `CreateVertexBuffer` / `Lock` / `Unlock` | `CREATE_BUFFER` / `UPDATE_BUFFER` | guest |
| `IDirect3DVertexBuffer7::ProcessVertices` | 复用 `d3d9_proxy.c` 的 guest 侧软件 T&L | guest |
| `SetClipPlane`/`GetClipPlane` | `SET_CLIP_PLANE` | 直通 |
| `BeginStateBlock`/`EndStateBlock`/`Apply`/`Capture`/`Delete`/`CreateStateBlock` | guest 侧状态块（与 D3D8/9 路径同构） | guest |
| `Load`（表面到纹理拷贝）/`PreLoad` | `DD_BLT` / 无操作 | guest |
| `ComputeSphereVisibility` | guest 侧用当前视锥计算 | guest |
| `ValidateDevice` | 依据已实现的阶段级联判定 | guest |
| `GetInfo` | `S_FALSE`（D3D7 允许） | guest |

**FVF 陷阱**：D3D7 的 `D3DFVF_RESERVED1`(0x20) 就是 D3D9 的
`D3DFVF_PSIZE`(0x20)，`D3DFVF_POSITION_MASK` 与 `RESERVED2` 的宽度在两代之间
也不同。guest 侧必须先按 D3D7 的语义解析完 FVF，再按 D3D9 的语义重新组装，
不能整数直通。

## 10. Direct3D 3/5/6 的额外差异（M4）

| 差异 | 处理 |
| --- | --- |
| `IDirect3DDevice2/3::SetRenderTarget` 换渲染目标表面 | `SET_RENDER_TARGET` |
| `SetLightState`（`D3DLIGHTSTATE_MATERIAL`/`AMBIENT`/`FOG*`/`COLORMODEL`） | 拆成 `SET_MATERIAL` 与对应渲染状态 |
| `D3DVERTEXTYPE`：`D3DVT_VERTEX`/`LVERTEX`/`TLVERTEX` | 分别等价于 FVF `XYZ\|NORMAL\|TEX1`、`XYZ\|DIFFUSE\|SPECULAR\|TEX1`、`XYZRHW\|DIFFUSE\|SPECULAR\|TEX1` |
| `Begin`/`BeginIndexed`/`Vertex`/`Index`/`End` 立即模式 | guest 侧累积到临时缓冲，`End` 时发一次 `DRAW_*_UP` |
| `IDirect3DTexture2::Load` | 系统内存表面 → 显存纹理的拷贝，`DD_BLT` |
| `IDirect3DTexture::GetHandle` + `SwapTextureHandles` | guest handle 表；`SwapTextureHandles` 交换表项 |
| `IDirect3DViewport3::Clear`/`Clear2`/`SetBackground` | `SET_VIEWPORT` + `CLEAR` |
| `IDirect3DViewport::TransformVertices`/`LightElements` | 软件 T&L 路径；`LightElements` 拒绝（D3D 从未实现） |
| `SetClipStatus`/`GetClipStatus` | 影子保存，M4 不影响渲染 |
| `IDirect3DDevice2::Index`/`GetStats` | `GetStats` 返回 guest 侧计数 |

## 11. Direct3D 1/2 execute buffer（M5）

`IDirect3DDevice::Execute` 执行一段 execute buffer：`D3DINSTRUCTION` 头
（opcode / 每条记录大小 / 记录条数）后跟记录数组。需要实现的 14 个 opcode：

| opcode | 处理 |
| --- | --- |
| `D3DOP_POINT`(1) / `LINE`(2) / `TRIANGLE`(3) | 从缓冲里的顶点数组取索引 → `DRAW_INDEXED_PRIMITIVE_UP` |
| `D3DOP_MATRIXLOAD`(4) / `MATRIXMULTIPLY`(5) | guest 矩阵表运算 |
| `D3DOP_STATETRANSFORM`(6) | 写矩阵表 + `SET_TRANSFORM` |
| `D3DOP_STATELIGHT`(7) | 同 `SetLightState` |
| `D3DOP_STATERENDER`(8) | 同 `SetRenderState`（走第 9 章映射表） |
| `D3DOP_PROCESSVERTICES`(9) | guest 软件 T&L（`D3DPROCESSVERTICES_TRANSFORMLIGHT`/`TRANSFORM`/`COPY`/`NOCOLOR` 各一路） |
| `D3DOP_TEXTURELOAD`(10) | 同 `IDirect3DTexture::Load` |
| `D3DOP_EXIT`(11) | 结束执行 |
| `D3DOP_BRANCHFORWARD`(12) | 按 status 位做前向跳转 |
| `D3DOP_SPAN`(13) | 拒绝（仅 Ramp 设备使用），`GUEST_LOG` |
| `D3DOP_SETSTATUS`(14) | 更新 `D3DSTATUS` 的 clip flags / 包围盒 |

`ExecuteBuffer` 的 `Lock`/`Unlock`/`SetExecuteData`/`GetExecuteData` 是纯
guest 侧内存管理。`Optimize` 返回 `D3D_OK` 但不做任何事。

游戏库里目前没有强依赖这条路径的标题，所以 M5 用合成用例（`sample/`
下自写的 execute buffer 程序）与 3DMark99 验收，优先级最低。

## 12. Host 侧：`ddraw_ops.js`

```js
// 以 mixin 形式合入 D3D9WebGPUExecutor.prototype，并向 handler 表注册
// 0x500 组。不改动既有 handler 的任何行为。
installDDrawOps(D3D9WebGPUExecutor);
```

需要新增的 host 能力：

1. **blit 管线缓存**：键为 `(sourceGPUFormat, destinationGPUFormat, flags)`，
   值为 `GPURenderPipeline`。着色器变体：直通、色键 discard、镜像 UV、
   索引直通（`r8uint` → `r8uint`）。
2. **索引表面支持**：`r8uint` 纹理的创建、上传、采样（在固定管线的片元着色器
   里经调色板 storage buffer 解析）、呈现时的解析 pass。
3. **每表面色键与调色板绑定表**：挂在既有资源对象上，随 `DESTROY_RESOURCE`
   一起清理。
4. **显示模式**：`DD_SET_DISPLAY_MODE` → swapchain image 尺寸 + `onSurface`
   回调（复用既有的 overlay 定位机制）。
5. **统计**：`ddBlits`、`ddBlitsColorKeyed`、`ddBlitsSkipped`、
   `ddPaletteResolves`、`ddReadbacks`、`ddOverlayComposites`，进 `getStats()`。

**不做的事**：host 不实现剪裁列表、不实现翻转链、不实现 attached surface 图、
不实现 DirectDraw 的表面丢失/恢复（`Restore`）语义——这些全部在 guest 侧。

## 13. 性能预算与风险

### 13.1 2D 路径的真实瓶颈是 guest 内的 memcpy，不是 GPU

一个典型 2D 游戏每帧的数据流：CPU 在系统内存表面上画完整帧 → Blt 到
back buffer → Flip。我们把后两步搬到 GPU 上，但**第一步的结果必须过一次
DMA 竞技场**。

| 分辨率 / 格式 | 每帧字节 | 60fps 带宽 |
| --- | --- | --- |
| 640x480 P8 | 300 KiB | 18 MB/s |
| 800x600 P8 | 469 KiB | 27 MB/s |
| 800x600 RGB565 | 938 KiB | 55 MB/s |
| 1024x768 X8R8G8B8 | 3.0 MiB | 180 MB/s |

v86 解释执行的 `rep movsd` 大致在几十 MB/s 量级，所以：

- P8 与 640x480 档位安全；
- 800x600x16 处于临界，必须靠脏矩形（多数 2D 引擎只重画变化区域，且
  `Lock(rect)` 已经告诉了我们范围）；
- 1024x768x32 的全屏每帧上传不可行——但这个组合在目标游戏里不存在。

因此 **4.5 的脏矩形与 4.6 的竞技场内表面不是可选优化，是 M2 的必要条件**，
阶段 0 的 Lock 面积直方图直接决定它们的优先级。

### 13.2 回读是第二个悬崖

任何一次"GPU 写过的表面被 Lock"都要同步回读，代价是一次 GPU→CPU 往返加
一次 DMA 拷贝。2D 引擎正常不会这么做；会这么做的是"读回 back buffer 做
特效"的少数游戏。M0 的直方图要专门统计这一项，命中的游戏单独评估。

### 13.3 每帧命令数

2D 游戏的精灵 blit 可以到每帧数千次（无限引擎、星际争霸）。每条
`DD_BLT` 是 80 字节，5000 次 = 400 KiB/帧，竞技场放得下，但 host 侧要
避免每次 blit 建一个 render pass。合批规则：连续的、目标相同的 `DD_BLT`
合并进同一个 pass，只在目标切换或遇到需要读回目标的操作时断开。这条与
既有 `frame.ops` 的 pass 合并逻辑同构。

### 13.4 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| app-local `ddraw.dll` 未被优先加载 | 整个方案不成立 | 阶段 0 第 2 项先验证 |
| 游戏用 `CoCreateInstance` 创建 DirectDraw | 该游戏不走我们的路径 | 阶段 0 统计；必要时做 COM 注册立项 |
| `ChangeDisplaySettings` 在 guest 里失败 | 全屏体验退化为 1:1 窗口覆盖 | 4.8 已有兜底分支 |
| 2D 上传带宽超预算 | 帧率不达标 | 脏矩形 + 竞技场内表面；必要时降到 P8 |
| GDI 与 DirectDraw 混用 | 文字/UI 丢失 | M2 用 DIB section 实现 `GetDC`/`ReleaseDC`；更深的混用列入偏差清单（d7vk 直接不支持这一类） |
| 游戏依赖表面丢失/恢复语义 | `Restore` 之后画面空白 | guest 侧永不报告丢失，除非真的设备丢失 |
| 并发会话改动同一批文件 | 审计结论过期 | 动工前查 `git status` 与文件 mtime |

## 14. 里程碑

### M0：基线与追踪（见第 5 章）

**退出条件**：三份直方图落盘；4.8/4.6/`CoCreateInstance` 三个问题有结论；
M1 opcode 子集定稿。

### M1：2D 骨架跑通一个游戏

范围：

- `ddrawproxy/` 目录、`ddraw_protocol.h`、`build.sh`（含无 CRT 导入校验）；
- D9WG 1.7 的 `DD_BLT` / `DD_SET_COLOR_KEY` / `DD_SET_SURFACE_PALETTE` /
  `DD_SET_DISPLAY_MODE` 四个 opcode，guest 与 host 两侧；
- `DirectDrawCreate`/`DirectDrawCreateEx`/枚举/`SetCooperativeLevel`/
  `SetDisplayMode`；
- `IDirectDraw7` + `IDirectDrawSurface7` + `IDirectDrawPalette` +
  `IDirectDrawClipper`；
- 表面：primary、翻转链、offscreen plain、系统内存；`Lock`/`Unlock` 影子
  内存与脏矩形上传；`Blt`/`BltFast`/`Flip`/`GetDC`；
- P8 索引存储与调色板解析（host）；源色键（host）；
- host `ddraw_ops.js` 与 blit 管线缓存。

**退出条件**：帝国时代 2 与英雄无敌 3 主菜单+游戏内画面正确，含调色板动画
与精灵透明；`ddraw_*_test.js` 全绿；DLL 无 CRT 导入；新增 WGSL 经 `naga`
真实校验。

### M2：2D 完整

范围：旧版本 vtable 薄层（`IDirectDraw`/`2`/`4`、`Surface`/`2`/`3`/`4`）；
剪裁器的矩形解析；窗口/全屏切换与 `Restore`；`WaitForVerticalBlank`/
`GetScanLine` 的节奏近似；GDI `GetDC`/`ReleaseDC` 的 DIB section 实现；
目标色键与镜像 blit；竞技场内表面优化；`DDBLT_ROP` 的 `SRCCOPY`/`BLACKNESS`。

**退出条件**：红警 2/尤里、无限引擎四作、辐射 2、星际争霸、文明 2、主题医院、
模拟城市 3000、过山车大亨 2、铁路大亨 2、大富翁 4、合金弹头、盟军敢死队
全部可玩；800x600 下不低于 30fps。

### M3：Direct3D 7

范围：`IDirect3D7`/`IDirect3DDevice7`/`IDirect3DVertexBuffer7`；第 9 章的
完整映射表；Z 缓冲表面附着；纹理表面（含 mip 链、DXT1-5、cube map）；
状态块；`Clear`；`ComputeSphereVisibility`；`ProcessVertices`。

**退出条件**：暗黑 2 的 D3D 模式、Hitman 47、半条命 D3D 渲染器可玩；
3DMark2000 能跑完并给出分数；`fill_caps` 的每一位都能指向实现代码。

### M4：Direct3D 3/5/6

范围：第 10 章全部；`IDirect3D3`/`2`/`1`、`Device3`/`2`、`Viewport3`/`2`/`1`、
`Material3`/`2`/`1`、`Light`、`Texture2`/`1`。

**退出条件**：恐龙危机、生化危机 2、极品飞车 3、神偷可玩。

### M5：execute buffer

范围：第 11 章全部；`D3DParseUnknownCommand` 的真实实现。

**退出条件**：`sample/ddraw_execute_buffer_test.c` 覆盖全部 14 个 opcode 并
在 guest 内渲染正确；3DMark99 可跑。

### M6：收敛

范围：overlay（`DD_UPDATE_OVERLAY`）；`IDirectDrawColorControl` /
`IDirectDrawGammaControl`（后者复用既有 `SET_GAMMA_RAMP`）；性能收敛；
`README.md` 与偏差清单定稿；save/load 状态的结论。

**关于 save/load**：`d3d9_executor.js` 目前没有 `serializeState`/
`restoreState`，D3D8 路径迁移时继承了这个缺口，`v86_network_bridge.js` 用
`typeof` 检查静默跳过。DirectDraw 路径会**放大**这个问题（2D 游戏的表面集合
比 3D 游戏的更大更长寿）。M6 必须给出结论：要么实现三条路径共用的
`serializeState`/`restoreState`，要么在站点 UI 上明确标出"该游戏不支持存档
快照"，不能继续静默失败。

## 15. 测试策略

沿用既有三层结构：

1. **协议一致性测试**（`ddraw_protocol_consistency_test.js`）：从
   `ddraw_protocol.h` 与 `d3d9_protocol.h` 解析出结构体布局与 opcode 值，
   与 JS 侧解码器的常量比对。写错偏移是这类项目最常见、最难查的错误。
2. **executor 测试**（`ddraw_webgpu_executor_test.js`）：用假 WebGPU 设备
   驱动真实字节流，断言出来的 pipeline 变体、bind group、`writeBuffer` 内容，
   以及哪些 blit 是被**明确拒绝**而不是错误执行的。
3. **两侧一致性测试**（`ddraw_channel_expansion_test.js`）：编译并运行
   guest 侧的通道展开函数，与 host 的规则逐值比对（见 4.4）。
4. **guest 内样例**（`sample/ddraw_*_test.c`）：与 `d3d8_*`/`d3d9_*` 同规格
   的小程序，在 XP guest 里真实运行并截图比对。至少覆盖：色键 blit、调色板
   动画、翻转链、拉伸 blit、镜像 blit、Lock/Unlock 往返、Z 缓冲、多重纹理、
   execute buffer。
5. **WGSL 校验**（`ddraw_blit_wgsl_validation_test.js`）：blit/调色板着色器的
   **每一个变体组合**都经真实 `naga` 编译校验。
6. **无 CRT 校验**：`build.sh` 沿用 `objdump -p` 检查，出现 `msvcrt`/`ucrt`/
   `libgcc` 即失败。
7. **协议一致性测试**（`ddraw_protocol_consistency_test.js`）：从
   `d3d9_protocol.h` 解析出结构体字段偏移，核对 `ddraw_ops.js` 的每一处
   `getUint32(offset + N)` 都落在真实字段上、且必读字段一个不缺；同时核对
   opcode/flag 数值、协议版本号、以及 `ddraw.def` 的导出表与 `ddraw_proxy.c`
   的定义互相对得上。

## 16. 已知偏差清单（随实现同步更新）

每一条都必须在 `glbridge/ddrawproxy/README.md` 里有对应条目，说明"API 说
什么、我们做了什么、为什么"。初始清单：

| 偏差 | 说明 |
| --- | --- |
| `DDFLIP_NOVSYNC`/`INTERVALn` 无效 | 呈现节奏由浏览器 rAF 决定 |
| `IID_IDirect3DRGBDevice` 由硬件路径实现 | 软件光栅器的逐像素行为不复现 |
| Ramp/MMX/Ref 设备映射到 RGB 路径 | 无对应的软件光栅器，保留对象模型与固定功能语义 |
| `D3DLIGHT_PARALLELPOINT`/`GLSPOT` 近似 | 分别退化为 directional / spot |
| `EDGEANTIALIAS`/`ANTIALIAS` 忽略 | WebGPU 无逐边 AA |
| 超过 64 个矩形的 clip list 丢弃尾部矩形 | 控制单次 blit 的有界工作量，并通过 host counter 报告 |
| overlay 在 present 前合成 | 不破坏 primary，但无法像真实 scanout overlay 那样独立刷新或参与 guest GDI 合成 |
| overlay alpha/bob/video-port 模式不声明也不接受 | 需要视频采集与独立 scanout 模型，普通纹理合成无法诚实复现 |
| 过滤后的 true-colour 纹理色键在采样 RGB 量化后比较 | texel 中心精确；过滤边缘可能与特定旧驱动不同 |
| D3D1 `D3DOP_SPAN` 映射为 point list | WebGPU 无 span primitive |
| D3D1 triangle Pick 使用 guest float top-left rule | 共享边缘可能与特定旧驱动有亚像素舍入差异 |
| 深度 GDI 混用不支持 | 与 d7vk 相同的边界 |
| 桌面分辨率可能未真正改变 | `ChangeDisplaySettings` 失败时的兜底 |
| save/load 快照不保留 host GPU 状态 | 继承自 D3D9 路径，M6 给结论 |

## 17. 与既有路径的关系

- **不改动** `d3d8proxy/`、`d3d9proxy/`、`d3d8-webgpu/`、`openglproxy/`、
  `v86gl_driver/` 的任何行为。
- `d3d9_protocol.h` 只**追加** opcode 与结构体，`D9WG_VERSION_MINOR` 6→7；
  既有结构体布局不变，`d3d8.dll`/`d3d9.dll` 无需重编。
- `d3d9_executor.js` 的改动限于：加载 `ddraw_ops.js`、在 handler 表里注册
  `0x500` 组、资源对象上多两个可选字段（色键、调色板绑定）。既有测试必须
  全绿且不修改。
- `v86_network_bridge.js` 无需改动：`ddraw.dll` 走的是既有的 `0xFFE1` 路由。
- 部署 profile 继续互斥：一个游戏目录里 `ddraw.dll`、`d3d8.dll`、
  `d3d9.dll`、`opengl32.dll` 只能有一个。

## 18. 实施进度

> 本节随实现推进更新，记录"计划里的哪一部分已经落地、并且被什么验证过"。

### 已落地（截至 2026-08-24）

| 内容 | 位置 | 验证方式 |
| --- | --- | --- |
| D9WG 协议 1.7：`DD_BLT` / `DD_SET_COLOR_KEY` / `DD_SET_SURFACE_PALETTE` / `DD_SET_DISPLAY_MODE` / `DD_UPDATE_OVERLAY` 五个 opcode 与结构体、`D9WG_USAGE_DDRAW_INDEXED` 位 | `d3d9proxy/d3d9_protocol.h` | 编译期 `sizeof` 断言 + 协议一致性测试 |
| 翻译层：格式矩阵、色键展开、渲染状态分类、TSS→sampler、transform、FVF、灯光类型、`TEXTUREMAPBLEND` 级联、execute buffer opcode 表 | `ddrawproxy/ddraw_protocol.h` | 独立 C 用例逐项断言 + 通道展开一致性测试 |
| host 侧 DirectDraw 组：blit 管线变体缓存（float/index/fill × 源/目标色键 × 调色板）、索引存储、每表面色键与调色板绑定、显示模式、depth-only render-pass 矩形填充、overlay present-time composite | `d3d9-webgpu/ddraw_ops.js` | 19 项 executor 测试 + 27 个 WGSL 变体经 `naga` 校验 |
| executor 接入：`r8uint` 可渲染、索引/BC/cube subresource 创建、上传与回读、handler 扩展点、`ddblit` op 回放、协议版本 1.7 | `d3d9-webgpu/d3d9_executor.js` | 既有 158 项 d3d9 测试全绿，无回归 |
| guest DLL：传输层、诊断日志、`IDirectDraw7` / `IDirectDrawSurface7` / `IDirectDrawPalette` / `IDirectDrawClipper` 全部方法、翻转链、Lock/Unlock 影子与脏矩形、Blt/BltFast/Flip、GDI DC、回读握手、21 个导出 | `ddrawproxy/ddraw_proxy.c`（4.3k 行） | `-Wall -Wextra -Werror` 无告警编译，无 CRT 导入，导出表一致性测试 |
| **旧版本接口全部落地**：`IDirectDraw`/`2`/`3`/`4` 与 `IDirectDrawSurface`/`2`/`3`/`4`，以宏生成的 thunk 转换参数后转发到 v7 实现；`DirectDrawCreate` 正常返回 v1 接口 | 同上 | `ddraw_vtable_layout_test.js`：12 个接口共 **355 个 vtable 槽位**逐个对照 SDK 头文件的声明顺序 |
| **D3D7 立即模式与高级纹理**：`IDirect3D7`、49 槽 `IDirect3DDevice7` 与 `IDirect3DVertexBuffer7`；完整固定功能状态/draw/state block/CPU `ProcessVertices`；mip/cube/DXT1-5、纹理色键、精确 sphere visibility（含 user clip plane） | `ddrawproxy/d3d7_proxy.inc` + `ddraw_proxy.c` | `ddraw_d3d7_vtable_test.js`：三个接口 **66 个槽位**逐项对照 SDK；高级 XP 样例可构建；158 项 D3D9 executor 测试无回归 |
| **Direct3D 1-6 旧对象模型**：D3D1/2/3 factory/device、Texture1/2、Viewport1/2/3、Material1/2/3、Light、旧 VertexBuffer；共享 D3D7 状态与资源 | `ddrawproxy/d3d_legacy_proxy.inc` | `ddraw_d3d_legacy_vtable_test.js`：17 个接口 **241 个槽位**逐项对照 SDK；`-Werror -nostdlib` DLL 构建通过 |
| **D3D1 execute buffer**：矩阵 handle、锁定/校验/优化、14 个 opcode、PROCESSVERTICES、分支/状态/纹理加载、triangle Pick/GetPickRecords | 同上 | XP D3D1 样例构造真实指令流并可构建，无 CRT 导入 |
| **目标色键、overlay、`DuplicateSurface`、`SetSurfaceDesc`**：目标读取快照、非破坏 overlay 合成与 z-order、共享存储/像素别名、client-owned system-memory 换绑 | `ddraw_proxy.c` + `ddraw_ops.js` | executor/protocol/WGSL 测试；高级 DirectDraw XP 样例可构建 |
| XP 四个冒烟包 | `sample/ddraw_d3d7_triangle_test.c`、`sample/ddraw_d3d7_advanced_texture_test.c`、`sample/ddraw_d3d1_execute_buffer_test.c`、`sample/ddraw_surface_advanced_test.c` | EXE 与 DLL 均为 XP 5.01 subsystem、无 CRT；EXE 仅导入 `ddraw`/`kernel32`/`user32` |

### 未落地（按优先级）

1. **尚未在任何真实游戏或 guest 内样例上运行过**。这是当前的头号事项。D3D7
   triangle 样例与无 CRT 的 XP 冒烟包已经写好并构建通过，但尚未放入 guest
   执行；M0 的转发式 tracing DLL 也尚未做。
2. 竞技场内表面优化（4.6）与脏矩形之外的带宽收敛。
3. Direct3D 1-7 已实现路径的 guest/真实游戏兼容性收敛；重点核对 execute
   buffer 的边界行为、过滤纹理色键的驱动差异和 BC 格式在实际浏览器 adapter
   上的可用性。

### 与计划的偏离

- **4.4 的色键展开规则由"高位复制"改为"截断缩放"**，理由见该节的实施记录：
  必须与 host 既有的 `expandRowToGPU` 逐值一致。
- M1/M3 的游戏退出条件都**尚未验证**：2D 与 D3D7 核心代码路径已经存在，
  但没有在 guest 里跑过任何一帧。在真实 guest 验证之前不宣称相应里程碑完成。
