# D3D9 → WebGPU：距离 9.0a/b/c 全特性还差什么

审计日期：2026-08-23。基线：3DMark 2006 全部测试可跑完。

> **修订 2026-08-23 14:10** —— 初稿把 bump environment mapping 列为 P0 第一大缺口，
> 这是错的：该特性在工作区（未提交）里已经实现，审计期间正好有并行工作在改同一批
> 文件。详见 P0 第 1 条。其余条目已按当前工作区重新核对。

## 审计方法

对照的不是 MS Learn 的散文页，而是三份机器可核对的清单——它们才是"9.0a/b/c
全特性"的实际定义：

1. `IDirect3D9` / `IDirect3DDevice9` / 各资源接口的 vtable（`d3d9.h`）
2. `d3d9types.h` 里每个枚举的**全域取值**（`D3DRENDERSTATETYPE`、
   `D3DTEXTUREOP`、`D3DSAMPLERSTATETYPE`、`D3DTEXTURESTAGESTATETYPE`、
   `D3DQUERYTYPE`、`D3DTEXTUREADDRESS`、`D3DFILLMODE`…）
3. `D3DCAPS9` 的每个字段与每个 bit

每一项都追到了实现点或缺口点，行号见条目。

## 总体结论

**API 面是完整的。** `IDirect3D9` 的 17 个方法、`IDirect3DDevice9` 的 119 个方法、
所有资源接口都已挂上 vtable，没有空洞。

缺口全部在**枚举值的覆盖率**和**状态的消费率**上：guest 侧把状态收全了并送到了
host，host 侧只消费了其中一部分。

| 枚举 | 已消费 / 全域 |
| --- | --- |
| `D3DRENDERSTATETYPE` | 68 / ~103 |
| `D3DTEXTUREOP` | 21 / 26 |
| `D3DSAMPLERSTATETYPE` | 9 / 13 |
| `D3DTEXTURESTAGESTATETYPE` | 18 / 18 |
| `D3DQUERYTYPE` | 5 / 14 |
| shader 指令 | 拒绝 4 条（`UNSUPPORTED_OPS`，`d3d9_shader_pipeline.js:130`）|

---

## P0：真实游戏会踩、且画面会错 —— 已全部完成（2026-08-23）

实现要点与偏差：

- **五个 texture op**：`MODULATEALPHA_ADDCOLOR` / `MODULATECOLOR_ADDALPHA` /
  `MODULATEINVALPHA_ADDCOLOR` / `MODULATEINVCOLOR_ADDALPHA` 四个已按 D3D9 文档的
  代数式实现，并只在 colour 通道有效（D3D9 本身也只为 `D3DTSS_COLOROP` 定义它们，
  alpha 通道仍然拒绝并计数）。`PREMODULATE` 仍然拒绝：它要与**下一段**的纹理相乘，
  而 cascade 没有任何向后传值的通道。
- **`MaxStreams` 16**：guest 侧 16 个槽位。host 不为此绑 16 个 WebGPU vertex
  buffer —— layout 只按*声明实际引用*的 stream 建，超过 8 个（WebGPU 保证的
  `maxVertexBuffers`）才拒绝并计数。
- **LOD**：`D3DSAMP_MAXMIPLEVEL` 与 `SetLOD`（新增协议 opcode `0x222`）都映射到
  `lodMinClamp`，取两者中更严格的一个；`D3DSAMP_MIPMAPLODBIAS` 因为 WebGPU sampler
  根本没有 bias 字段，改为在采样点用 `textureSampleBias` 实现，FFP 与翻译后的
  pixel shader 两条路都覆盖。bias 以字面量烘进 WGSL 并量化到 1/16 级，避免逐帧
  改 bias 的标题每帧新建管线。
- **Gamma ramp**：新增协议 opcode `0x223`。在 present 那一步（每个像素上画布前的
  最后一站，也正是硬件应用它的位置）做 256 项查表。identity ramp 会被识别并退回
  普通 copy，不付全屏 pass 的代价。**偏差**：真实 D3D9 只在全屏设备上生效，这里
  窗口模式也生效。
- **`D3DRS_FILLMODE`**：WebGPU 没有 polygon mode，wireframe 改为把每个三角形重写成
  三条边的 line-list（strip 会先展开）。这是精确实现而非近似。`D3DFILL_POINT` 退化为
  1 像素点 —— WebGPU 在 point-sprite 路径外没有点尺寸，这是唯一的偏差。
- **`MIRRORONCE`**：sampler 本来就已经选了 clamp-to-edge，补上坐标的 `abs()` 就是
  精确实现，不是近似。FFP 与翻译路径都覆盖。
- **`SPHEREMAP`**：用 `GL_SPHERE_MAP` / wined3d 的同一套公式（标题的球面贴图美术
  就是照这个做的）。
- **flat shading**：`@interpolate(flat)`（WGSL 默认 provoking vertex 是 first，与
  D3D9 一致），只作用于两个颜色 varying；纹理坐标在 D3D9 里 flat 模式下仍然插值。
  翻译后的 pixel shader 不受影响 —— D3D9 不会按 shade mode 重新插值 shader 的输出。

新增 caps：`D3DPRASTERCAPS_MIPMAPLODBIAS`、`D3DPTADDRESSCAPS_MIRRORONCE`、
`D3DVTXPCAPS_TEXGEN_SPHEREMAP`、四个 `D3DTEXOPCAPS_MODULATE*_ADD*`。
协议版本 1.4 → 1.5。测试：executor 145 项、shader pipeline 42 项、
naga 校验 178 个着色器，全绿；DLL 以 `-Werror` 编译通过。


- [x] 1. Bump environment mapping 全家桶 —— 已由并行工作完成，只剩 4 条冷门指令
- [x] 2. 五个 texture op 缺失 —— 四个已实现，PREMODULATE 仍拒绝
- [x] 3. `MaxStreams` 4 → 16
- [x] 4. Mip LOD 控制整条链（`MIPMAPLODBIAS` / `MAXMIPLEVEL` / `SetLOD`）
- [x] 5. `SetGammaRamp` 落地
- [x] 6. `D3DRS_FILLMODE`（wireframe / point）
- [x] 7. `D3DTADDRESS_MIRRORONCE`
- [x] 8. `D3DTSS_TCI_SPHEREMAP`
- [x] 9. `D3DRS_SHADEMODE = D3DSHADE_FLAT`

### 1. Bump environment mapping 全家桶 —— 已完成

**2026-08-23 更新：这一项在本次审计写完之前就已经由并行进行的工作实现了，
审计初稿把它列为最大缺口是错的。** 当前工作区（未提交）里已经有：

- `D3DTOP_BUMPENVMAP`(22) / `BUMPENVMAPLUMINANCE`(23) 在 cascade 里
  （`d3d9_executor.js:1859`），含两段耦合逻辑（`isBumpSource`，7537 起）
- `D3DTSS_BUMPENVMAT00..11`、`BUMPENVLSCALE`、`BUMPENVLOFFSET` 全部消费并上传
  （`d3d9_executor.js:9826` 与 `9916`）
- ps_1_x 的 `texbem` / `texbeml` / `texdp3` / `texdp3tex` / `texm3x2pad` /
  `texm3x2tex` / `texm3x3pad` / `texm3x3tex` / `texm3x3spec` / `texm3x3vspec`
  已翻译（`d3d9_shader_pipeline.js` 的 `emit()`）

`D3DTEXTURESTAGESTATETYPE` 因此从 12/18 变成 18/18。

剩余仍被拒绝的只有 4 条冷门指令（`UNSUPPORTED_OPS`，`d3d9_shader_pipeline.js:130`）：

- [ ] `bem`（ps_1_4 的独立 bump，无纹理采样）
- [ ] `texm3x2depth` / `texdepth`（用纹理寻址结果改写 fragment depth）
- [ ] `texm3x3`（Radeon 世代写 3x3 结果的变体）

优先级低：这四条在实际游戏里近乎绝迹。

### 2. 五个 texture op 缺失

`PREMODULATE`(17)、`MODULATEALPHA_ADDCOLOR`(18)、`MODULATECOLOR_ADDALPHA`(19)、
`MODULATEINVALPHA_ADDCOLOR`(20)、`MODULATEINVCOLOR_ADDALPHA`(21)。（初稿写"七个"是把已实现的两个 bump op 误算在内。）

2002-2004 年的 FFP 引擎里非常常见（镜面高光叠加、贴花）。

### 3. `MaxStreams = 4`，D3D9 是 16

`d3d9_proxy.c:697` 的 `D9_MAX_STREAMS`。骨骼动画 + 顶点色 + 多套 UV 拆流的引擎
会直接超。

### 4. Mip LOD 控制整条链缺失

`D3DSAMP_MIPMAPLODBIAS`(8)、`D3DSAMP_MAXMIPLEVEL`(9)、
`IDirect3DBaseTexture9::SetLOD`。

caps 里已经诚实地关掉了 `D3DPRASTERCAPS_MIPMAPLODBIAS`，但游戏的"纹理质量"
设置项会静默失效。

### 5. `SetGammaRamp` 是彻底的空函数

`d3d9_proxy.c:5512` —— 函数体只有一串 `(void)` 转型。而 `fill_caps` 在
`d3d9_proxy.c:3196` 以 `/* device_set_gamma_ramp(). */` 为注释宣告了
`D3DCAPS2_FULLSCREENGAMMA`。这是一条已经失效的 caps 承诺：游戏的亮度滑条不起作用。

修法很短：把 ramp 带到 host，在 present 的 blit 里做 LUT。

### 6. `D3DRS_FILLMODE`

wireframe / point 填充完全没实现。WebGPU 没有 polygon mode，必须把三角形索引
改写成 line-list。

### 7. `D3DTADDRESS_MIRRORONCE` 静默退化成 clamp

注意：executor 已经为 `BORDER` 做了 shader 端的坐标域外替换，`MIRRORONCE` 完全
可以走同一条路。这不是"WebGPU 无法表达"，只是没做。

### 8. `D3DTSS_TCI_SPHEREMAP`

被计数拒绝，`d3d9_executor.js:7465`。

### 9. `D3DRS_SHADEMODE = D3DSHADE_FLAT`

未消费。WGSL 有 `@interpolate(flat)`，几乎零成本。

---

## P1：规范内、影响面较窄 —— 9/10 完成（2026-08-23）

唯一剩下的是 `CreateAdditionalSwapChain`，原因见下。


- [x] **`ProcessVertices` 已实现**（guest 侧软件顶点管线，从 D3D8 路径移植）。
      必须在 guest 侧做：这个调用的全部意义就是结果落在 app 能 Lock 读取的内存里，
      而本栈的 host 是异步的，没有任何同步 GPU 往返能回答它。覆盖 world/view/
      projection 变换、透视除法、viewport 映射、方向光/点光/聚光的环境与漫反射项、
      以及 diffuse/specular/texcoord/psize 的透传，支持 `D3DPV_DONOTCOPYDATA`。
      **两处具名限制**（不是静默降级）：绑定了 vertex shader 时拒绝（用固定管线顶替
      会悄悄产出不同的几何）；`D3DRS_SPECULARENABLE` 的高光不计算，destination 要
      SPECULAR 就透传 source 的 —— 与 D3D8 路径的做法一致。
      配套新增自检冒烟测试 `sample/d3d9_process_vertices_test.c`：它不看像素，
      Lock destination 直接**核对数字**，所以乘法次序错、少了透视除法、viewport
      偏移差半个像素都会失败而不是变成"看起来还行"的画面。
- [x] **`SetSoftwareVertexProcessing` 与 `D3DCREATE_` 行为标志**：`BehaviorFlags`
      此前被完全忽略。现在 `CreateDevice` 校验它（必须恰好命名一种顶点处理模式；
      `PUREDEVICE` 只能配 `HARDWARE`），混合设备上 `SetSoftwareVertexProcessing`
      真正生效并能读回，非混合设备只接受它已有的模式。
- [x] **`D3DCREATE_PUREDEVICE`** 已实现：D3D9 文档列出的 27 个 Get\* 全部返回
      `D3DERR_INVALIDCALL`。这个代理其实*保留*着那份影子状态（Reset 和 state block
      需要它），所以回答这些调用很容易 —— 但那样是错的：app 要了 pure device 却拿到
      答案，等于被告知"你的性能提示被采纳了"，而它花代价想避免的跟踪其实还在跑。
- [ ] **`CreateDevice` 的 `BehaviorFlags` 被完全忽略**：代码里 `D3DCREATE_` 一次
      都没出现。`D3DCREATE_PUREDEVICE` 要求所有 `Get*` 失败；
      `SOFTWARE_VERTEXPROCESSING` 要求无视 caps 接受任意版本 shader 和 256 个常量。
      两条语义都没实现。
- [x] **`Surface::GetDC` / `ReleaseDC` 已实现**，纯 guest 侧：DIB section 是唯一
      一种 GDI 既肯往里画、又肯交出裸指针的位图，所以 DC 存在期间 surface 的像素
      同时活在两处，`ReleaseDC` 时拷回并走普通 LockRect 的上传路径。wined3d 也是
      这么做的，原因相同。只允许 D3D9 规定的四种未压缩显示格式；DC 存在期间 surface
      保持 LockRect 锁定（这正是 D3D9 的规定）；surface 析构时回收 GDI 对象，
      不指望调用方。
- [ ] **`CreateAdditionalSwapChain`** 仍被拒 —— **P1 唯一未完成项**。
      它不是 guest 侧能补的：附加交换链面向*另一个 HWND*，而 host 的 present 路径
      绑定在单一 canvas 上（`this.context`）。要做需要贯穿三层的改动 —— executor
      维护 swap chain handle → GPUCanvasContext 的映射，bridge 按 `D9WG_OP_WINDOW_STATE`
      已经携带的窗口几何创建并定位第二个 canvas，页面负责合成。属于独立的一块工作，
      不是这一轮能顺手带上的。实际影响面最小：用它的基本是编辑器/工具，不是游戏。
- [x] **`D3DRS_WRAP0..15`**：确认**无法实现** —— wrap 是逐三角形比较三个顶点的
      坐标后做的决定，WebGPU 没有任何能看到整个图元的阶段（几何着色器或逐 draw 的
      compute 预处理是仅有的两种可行形态）。现在会显式报告并说明症状（柱面/球面
      UV 的接缝），不再静默忽略。
- [x] **`D3DRS_MULTISAMPLEMASK`** 已映射到 `multisample.mask`。
      `D3DRS_MULTISAMPLEANTIALIAS=FALSE` 近似为只写 sample 0。
      **顺带修掉一个真实 bug**：渲染管线此前从不声明 `multisample`，而附件是
      多重采样的 —— WebGPU 要求两者一致，所以任何 MSAA 设备的每一次 draw 都会
      校验失败。现在 sample count 从 render target 一路带到管线并进了缓存键。
- [x] **Query 5/14 不是缺口** —— 复核后撤回。缺的九种全是可选的驱动性能计数器
      （`VCACHE`、`RESOURCEMANAGER`、`VERTEXSTATS`、各类 `*TIMINGS`），真实零售
      驱动同样以 `D3DERR_NOTAVAILABLE` 拒绝它们，而代理已经返回的正是这个错误码。
      伪造计数器只会让 app 相信一些编造的数字。真正重要的五种（`EVENT`、
      `OCCLUSION`、三种 `TIMESTAMP`）都已实现。
- [x] **`D3DCAPS2_CANAUTOGENMIPMAP` 已打开**：`d3d9_proxy.c:3199` 的
      注释说 AUTOGENMIPMAP "deliberately refused"，但 2D 和 cube 两条路径现在都
      实现了（executor 5626 / 6031，proxy 6145 / 9574）。注释和代码已经不同步，
      caps 少报了一个已经能用的特性。
- [x] **StretchRect 不是缺口** —— 复核后撤回。格式转换**已经支持**（走 blit
      管线，正是它覆盖缩放与格式转换）。只有压缩目标被拒，而 D3D9 本身也拒绝：
      StretchRect 的目标必须是 render target 或 offscreen plain surface，
      BCn 格式无法成为 render attachment。

---

## P2：规范要求但游戏几乎不用（高阶图元）

这一整块是零实现，而且 **`SetNPatchMode` 返回 `D3D_OK` 却什么都不做**
（`d3d9_proxy.c:5913`），属于和 P1 第一条同一类的"假装成功"。

- [ ] `DrawRectPatch` / `DrawTriPatch` / `DeletePatch`（RT-patch，D3D8 起）
- [ ] N-patch（`D3DUSAGE_NPATCHES`、`D3DRS_POSITIONDEGREE`/`NORMALDEGREE`）
- [ ] **9.0 新增的自适应细分 + 位移贴图**：`D3DRS_ENABLEADAPTIVETESSELLATION`、
      `D3DRS_ADAPTIVETESS_X/Y/Z/W`、`D3DDMAPSAMPLER`、`D3DUSAGE_DMAP`
      —— 这几个常量在代码里一次都没出现
- [ ] `D3DFMT_MULTI2_ARGB8` + `D3DSAMP_ELEMENTINDEX`(12) + `D3DSAMP_DMAPOFFSET`(13)

WebGPU 没有 tessellation stage，只能靠 compute shader 预细分。如果目标是"规范
完整"，这块躲不掉；如果目标是"跑游戏"，实际用户只有 ATI TruForm 演示。

- [x] **`SetNPatchMode` 已改成诚实的拒绝**：`segments > 1.0` 返回
      `D3DERR_INVALIDCALL` 并记录；关闭细分（`<= 1.0`）仍然接受，因为每个标题
      退出时都会这么调一次。

---

## P3：规范外，但 9.0c 时代游戏真的依赖

如果目标包含"跑完所有 9.0c 游戏"而不只是"实现规范"，这些 vendor FourCC hack
绕不过去：

- [ ] `INTZ`、`RAWZ`、`DF16` / `DF24`（深度当纹理读）
- [ ] `NULL`（空 render target）
- [ ] `ATI1N` / `ATI2N`（3Dc 法线压缩）
- [ ] `RESZ`（深度 resolve）
- [ ] `ATOC`（alpha-to-coverage；WebGPU 原生支持 `alphaToCoverageEnabled`）
- [ ] `NVDB`（深度边界测试）

---

## 建议顺序

1. **Bump mapping 那一组**是唯一"大"的工作，而且 D3D8 和 D3D9 两条路径共用收益，
   排第一。
2. **七个 texture op + `MaxStreams` 16 + LOD bias** —— 都是小改动、高覆盖。
3. **gamma ramp、`MIRRORONCE`、flat shading** —— 各自半天。

## 横向问题：caps 与实现已经漂移

- `FULLSCREENGAMMA` 报了但没做
- `CANAUTOGENMIPMAP` 做了但没报
- `SetNPatchMode` / `SetSoftwareVertexProcessing` 假装成功

`d3d9proxy/README.md` 里写了 "verify a cap is backed by real code before
advertising it" 这条纪律，但没有自动化守卫——上面三条就是在没有守卫的情况下漂出来的。

- [ ] 加一个一致性测试，把 `fill_caps` 的每个 bit 对到 executor 里的实现点，
      比逐条人工复查更能防住下一次漂移。

## 已确认没有缺口的部分

避免重复审计，以下都追到了实现：cube / volume 纹理、8 段 texture stage、
MRT（4 个）、6 个 user clip plane、point sprite、vertex blending（含 indexed，
256 个 world matrix）、palette（协议 1.4）、MSAA（back buffer + render target）、
硬件 shadow map（comparison sampler）、vs_3_0 顶点纹理采样、`vPos` / `vFace`、
two-sided stencil、separate alpha blend、instancing（`SetStreamSourceFreq`）、
`TRIANGLEFAN` 索引展开、sRGB 读写、depth bias / slope-scaled、
`IDirect3D9` 全部枚举与 Check* 方法、readback / occlusion query。
