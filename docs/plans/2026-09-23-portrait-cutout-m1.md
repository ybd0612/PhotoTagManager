# 人像抠图（M1）实施任务清单

> 版本：v1.3 · 日期：2026-09-24 · 状态：**代码完成，待人工验收**（§8 中标注"待人工"的条目需在真实安装包上走一遍）
>
> 2026-09-24 两个开口均已裁定并落地，不再是待办：
> **§8-16 用户选定「M1 内补显式 CPU 开关」**（`333864b` + `b5e097c`，见文末《§8-16 裁定与实装》）；
> **打包污染已修**（`build.files` 收紧，`cd49cdd`，见文末《打包污染已修复》）。
>
> **规格权威源：[docs/design/ai-photo-processing.md](../design/ai-photo-processing.md)（v0.7）**。本文件只负责"怎么拆、按什么顺序做、每步做完算交付"。两者冲突时**以规格文档为准**，并回来改本文件。
>
> 执行方式：逐任务实现，每个任务独立提交。每个任务开始前把该任务展开成 TDD 细步（写失败测试 → 跑它确认失败 → 最小实现 → 跑通 → 提交），**不要跳测试直接写实现**。

---

## Goal

在 PhotoTagManager 的预览界面里，点一下「抠图」就能对当前照片做**人像抠图**，结果先进暂存、预览对比、点保存才落到原图旁边并自动带标签。全程推理在本机完成，不上传任何图片内容。

## Architecture

三进程 Electron 不变。新增 `electron/ai/` 六个职责单一的主进程模块 + 一个 `utilityProcess` 推理子进程；渲染层新增组合按钮、对比视图、设置页 AI 分区，状态放独立的 `useAiStore`。模型清单是纯数据，加模型/加行为不改 UI 与 IPC。

**Tech Stack**：Electron 31.7.7（Chromium 126）、React 18、MUI 5、zustand、TypeScript、vitest、`onnxruntime-node@1.30.0`（DirectML）、`sharp@0.35.4`、exiftool-vendored（既有）。

---

## Global Constraints（每个任务都隐含遵守）

- **引擎**：`onnxruntime-node@1.30.0` 的 **DirectML** 后端。**不使用** `ort-web` / WebGPU（实测在 Electron 31 会话创建死锁）；**不使用** CUDA（npm 预编译包里没有，`backend not found`）。
- **推理必须在 `utilityProcess` 子进程**，主进程只做编排。原生层报错是进程级崩溃，不能带崩窗口。
- **任何 CPU 路径必须显式设 `intraOpNumThreads` / `interOpNumThreads`**（默认 2）。实测未限时 ORT 吃满 32 核、单进程 6.3GB，把开发机压到无响应。
- **模型下载只走 `hf-mirror.com`，用 Node `fetch`**，不用 Windows `curl`（证书吊销列表不可达会 `CRYPT_E_REVOCATION_OFFLINE`）。`huggingface.co` 直连超时。
- **暂存目录 = `userData/ai-preview/`**，**绝不得放在任何照片扫描根内**——扫描器按扩展名过滤，放错位置半成品会被扫进用户网格。
- **缓存键 = 五元组** `sha1(原图指纹 : 模型指纹 : 输入尺寸 : 后处理参数 : 预处理管线版本)`，原图指纹沿用 `sha1(absPath:mtimeMs:size)`。
- **行为标签 `AI人像抠图` 是清单里的字段**，UI / 写入 / 筛选都从清单取，禁止各处硬编码字符串。
- **产物命名 `原名.cutout.png`，冲突递增 `.cutout.2.png`。不提供"替换原图"**，不做任何不可逆操作。
- **UI 两条硬约束**：hover 只显示状态、**不承载动作**（下拉菜单必须可键盘导航）；进行中**不得置灰**，用按钮背景填充进度 + 保留可读文字 + 给「取消」。
- **M1 设置页参数区可以整块为空，但禁止出现调了没反应的假控件。**
- **IPC 命名 `域:动作`（kebab-case），统一 `IpcResult` 信封**；跨进程类型只放 `shared/types.ts`（该文件不得 import electron）；`electron/preload.ts` 白名单与 `src/api.ts` **三处一次改齐**。
- **三层分离三条可验收约束**：加模型只改清单数据；加行为只加清单条目 + 后处理函数；`320×320`/`sigmoid`/`u2netp` 这类具体形状**禁止出现在通用代码路径**。
- 测试：vitest，默认 node 环境，`tests/**/*.test.{ts,tsx}`，渲染测试文件头加 `// @vitest-environment jsdom`。用例名用中文，与现有 `tests/scan.test.ts` 风格一致。
- dev 端口 **51783**（`strictPort`），冲突直接报错，不要改端口。
- 每个任务完成后按约定式中文 commit，**精确 `git add` 本次文件，禁止 `git add -A`；不 push**。

---

## 已验证事实（直接采用，不要重新探测）

| 事实 | 值 | 来源 |
|---|---|---|
| u2netp 下载 URL | `https://hf-mirror.com/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx` | 2026-09-23 实下 200 |
| u2netp 体积 | **4,574,861 字节**（4.36 MB） | 实下 |
| u2netp sha256 | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` | 实算 |
| 输入张量 | 名 `input.1`，dims `[1,3,320,320]`，ImageNet 归一化（mean `[.485,.456,.406]` / std `[.229,.224,.225]`，rescale 1/255） | 仓库 `preprocessor_config.json` + 实测 |
| 输出张量 | 7 个，名 `1959`…`1965`；取 `outputNames[0]`（`1959`），shape `[1,1,320,320]` | 实测 |
| **首输出已是概率** | 实测范围 `[0.000, 0.997]` → **不要再过 sigmoid**（判据见 T6） | 实测 |
| DirectML 加载 | u2netp **0.96s** | 实测 |
| DirectML 推理 | **20 / 8 / 7 ms**（3 次） | 实测 |
| CPU 推理（限 2 线程） | 约 201 ms | 实测 |
| 整卡显存增量 | Δ325 MiB（**整卡口径**，含其他进程；分进程显存拿不到，`--query-compute-apps` 返回 `[N/A]`） | 实测 |
| 成品/掩码体积 | cutout PNG **1119 KB**，mask PNG **29 KB**（690×920 输入） | 实测 |
| 下载速率 | 0.39 ~ 1.27 MB/s（波动大，UI 不得按固定速率外推剩余时间） | 实测 |
| 引擎体积 | `bin/napi-v6/win32/x64` = **64.0 MB**（onnxruntime.dll 27.4 + DirectML 17.7 + dxcompiler 17.2 + dxil 1.4 + binding 0.3）；npm 包的 287~301 MB 含 4 个不发布平台 | 实测 |
| 当前基线 | 安装包 **89.8 MB**，安装后 **351.8 MB**；`typecheck` 0 错，`test` 24 用例绿 | 实测 |
| 本机 | RTX 5060 Laptop 8151 MiB（Blackwell）/ 32GB 内存 / C 盘剩 247GB / 32 逻辑核 | 实测 |
| 已确认失败、**不要重试** | ① `ort-web` WebGPU EP 会话创建死锁 ② CUDA EP 不存在 ③ **BiRefNet-lite 在 DirectML 上推理报 `DmlFusedNode`**（加载能成功，别被骗） | 实测 |

探针与产物保留在 `C:\Users\ybd06\temp\ptm-ortweb-probe\`（含 `models/u2netp.onnx` 可直接当测试夹具，`out/cutout.u2netp.onnx.dml.png` 是已知正确的参照图）。

---

## 文件结构（先定边界，再拆任务）

```
electron/ai/
├── capabilityCatalog.ts   纯数据：行为 → 模型 → 仓库/体积/sha256/张量规格/行为标签/输出扩展名
├── paths.ts               userData 下各目录的唯一解析入口（models / ai-preview / index）
├── cacheKey.ts            五元组缓存键（无依赖，可单测）
├── modelStore.ts          下载（Range 续传 + .part + sha256 校验）/ 本地索引 / 删除回收
├── preprocess.ts          解码 → EXIF 转正 → 补边缩放 → 归一化；导出 PIPELINE_VERSION
├── postprocess.ts         掩码 → alpha 合成 → PNG 编码；CutoutParams 结构体（M1 全默认值）
├── inferenceChild.ts      utilityProcess 入口：建 DirectML 会话（限线程）、跑推理、只回数据不写盘
├── runner.ts              InferenceRunner 接口 + ChildRunner 实现（子进程生死、重启、超时）
└── aiService.ts           编排：ensureReady → 查缓存 → 推理 → 写暂存 → save 移入目录 → 清理

shared/types.ts            追加全部跨进程类型 + PhotoTagApi 新方法
electron/ipc.ts            追加 ai:* handler（IpcResult 信封）
electron/preload.ts        追加白名单
src/api.ts                 类型自动跟随（无需改，除非加 helper）
src/store/useAiStore.ts    AI 状态独立分桶，不塞进 useAppStore
src/components/AiActionSplitButton.tsx   主按钮 + 模型下拉
src/components/AiCompareView.tsx         棋盘格底纹 + 按住对比 + 分屏
src/components/settings/SettingsDialog.tsx   应用级设置总入口
src/components/settings/AiSettingsPane.tsx   只读统计 + 参数区（M1 可为空）
tests/ai/*.test.ts         新增测试目录
```

---

## 任务清单

> 顺序即依赖顺序。T1–T9 全部可在 node 环境测完，**不依赖 UI**；T10 起才接线。

### T1 · 依赖、目录布局与打包裁剪

**产出**：`electron/ai/paths.ts`、`package.json`（加 `onnxruntime-node` `sharp`、加 `build.files` 排除与 `asarUnpack`）、`tests/ai/paths.test.ts`。
**Done when**：`paths.modelsDir()` / `previewDir()` / `indexFile()` 返回 `userData` 下预期路径且自动建目录；`npm run typecheck` 与 `npm run dist` 通过，`dist/win-unpacked` 里**只有** `win32/x64` 那五个原生文件、无 darwin/linux/arm64。
**注意**：`sharp` 也是原生模块，`asarUnpack` 必须一并覆盖，否则运行时加载不到。

### T2 · 能力清单（单一事实源）

**产出**：`electron/ai/capabilityCatalog.ts` + 单测。
**Done when**：清单里 `portrait-cutout` 行为含 `actionTag: 'AI人像抠图'`、`outputExt: '.png'`、`outputSuffix: 'cutout'`、u2netp 条目含上表真实的 URL/体积/sha256/`inputName: 'input.1'`/`inputDims: [1,3,320,320]`/`verified: true`；单测断言**全仓 `src/` 与 `electron/` 中不出现硬编码的 `'AI人像抠图'` 字面量**（除清单本身）——这是 D10 的防线。
**关键**：`verified` 字段必须存在。只有 `verified: true` 的条目允许进 UI（§4.3 硬规则）。

### T3 · 缓存键五元组

**产出**：`electron/ai/cacheKey.ts` + 单测。
**Done when**：五个分量**各自单独变化**都能使键不同（5 个用例逐个改一项、其余固定）；原图指纹复用 `sha1(absPath:mtimeMs:size)` 格式。
**为什么单独成任务**：这是审计里最严重的 A1/A4，键漏一项就是**静默出错**。测试必须能失败——把任一分量从键实现里拿掉，对应用例就该红。

### T4 · 模型下载与本地索引

**产出**：`electron/ai/modelStore.ts` + 单测（用本地 http server 提供 Range 与截断）。
**Done when**：① 首次下载写 `.part` → 完成后校验 sha256 → 改名就位；② 中断后重下从断点续（服务端记录 Range 命中）；③ sha256 不符 → 删除文件并报"内容损坏"；④ 可用磁盘不足时**下载前**拒绝；⑤ `status(modelId)` 返回 `absent|downloading|present`；⑥ 删除同时清临时文件与索引条目，无孤儿。
**禁止**：直接写最终文件名；用固定速率推算剩余时间。

### T5 · 预处理（含 EXIF 转正）

**产出**：`electron/ai/preprocess.ts` + 单测（夹具放 `tests/fixtures/`，含一张带 Orientation 的 JPEG）。
**Done when**：① 输出 `Float32Array` 长度 `3*320*320`、CHW 排布、按 ImageNet mean/std 归一化；② **带 Orientation 的图，转正后像素方向与肉眼所见一致**，且输出不再写方向标记（A3）；③ 保持比例缩放 + 补边（对应 `keep_aspect_ratio` + `pad`）；④ 导出 `PIPELINE_VERSION = 1`。
**说明**：`sharp` 默认会应用 EXIF 旋转——**别依赖默认行为，显式 `.rotate()`（无参 = 按 EXIF 转正）并在测试里锁死**，因为这是回归高发点。

### T6 · 后处理与成品合成

**产出**：`electron/ai/postprocess.ts` + 单测。
**Done when**：① 按输出数值范围**自动判定**是否已过 sigmoid（实测 u2netp 首输出已在 `[0,0.997]`，不该再过一遍；判据写成"最小值 ≥ -0.01 且最大值 ≤ 1.01 视为概率"）；② 掩码 resize 回原图尺寸后逐像素写入 alpha 通道，产出真带透明的 PNG；③ `CutoutParams` 结构体先定义并**全部取默认值/恒等变换**，同时把它纳入 T3 缓存键的参数分量（M1 无 UI 可调，但键必须已经含它——否则参数一实装就是 A1 那个 bug）；④ 空掩码/全零掩码不崩。

### T7 · DirectML 推理子进程

**产出**：`electron/ai/inferenceChild.ts`、`electron/ai/runner.ts`、`electron.vite.config.ts`（main 增加 `aiChild` 入口）、集成测试 `tests/ai/inference.integration.test.ts`。
**Done when**：① 子进程用 `executionProviders: ['dml']` + `intraOpNumThreads: 2` + `interOpNumThreads: 1` 建会话，跑 `[1,3,320,320]` 返回 `Float32Array(102400)`；② 主进程侧 `ChildRunner` 在子进程 `exit`/无响应时能**重启并让当次任务失败可读**，不拖垮调用方；③ 集成测试在模型缺失时 `skip` 并打印获取命令（把探针的 `models/u2netp.onnx` 拷进 `tests/fixtures/models/` 即可跑）；④ 会话创建超时有硬上限，**不允许无限等待**。
**不要**：把 `320`、`'input.1'`、`'1959'` 写进 `runner.ts`/`aiService.ts`——一律从清单传（D7 ③）。

### T8 · aiService 编排（run）

**产出**：`electron/ai/aiService.ts` + 单测（注入 `FakeRunner`，不碰原生）。
**Done when**：① `run()` 一次调用串完 未下载→（确认后）下载→静默加载→推理→写暂存，**中途不需要第二次调用**；② 缓存命中时**不调用 runner**（断言 FakeRunner 调用次数为 0）且结果带 `cacheHit: true`；③ 全程发 `ai:progress`，`phase` 取 `download|load|infer|encode`；④ 同一时刻只有一个推理在跑，第二个请求排队；⑤ `cancel(taskId)` 能中断含下载在内的整条链；⑥ 子进程崩溃 → 该任务 `ai:error` 可读，服务存活。

### T9 · 保存与暂存清理

**产出**：`aiService.save()` / `aiService.cleanup()` + 单测。
**Done when**：① `save()` 把暂存文件移入原图旁命名 `原名.cutout.png`，冲突递增 `.cutout.2.png`；② 移动后写元数据：继承原图 `XMP-ptm:Tags` + 追加清单里的 `actionTag` + 保留 EXIF/ICC（复用 `xmpService`）；③ **原图字节不变**（比对 sha256/mtime）；④ 保存失败（占用/只读/磁盘满）→ 报可读原因且**暂存结果保留可重试**；⑤ `cleanup()` 双条件（保留期 + 容量上限）按 LRU 淘汰，且**删除前校验路径前缀在 `ai-preview/` 内**——构造一个索引被篡改成指向外部路径的用例，必须拒绝删除。

### T10 · 跨进程类型 + IPC + preload 三处同步

**产出**：`shared/types.ts` 追加类型、`electron/ipc.ts` 追加 handler、`electron/preload.ts` 追加白名单、`tests/ai/ipc.test.ts`。
**Done when**：通道齐备 `ai:catalog` `ai:run` `ai:cancel` `ai:save` `ai:model-download` `ai:model-delete` `ai:model-unload` `ai:model-set-default` `ai:storage-stats` + 事件 `ai:progress` `ai:done` `ai:error`；**不存在** `ai:discard` / `ai:pending-review`（D18 已作废）；所有 handler 走 `IpcResult` 信封、不裸抛；`shared/types.ts` 无 `import electron`；`typecheck` 过（三处不同步会在这里红）。

### T11 · useAiStore + 组合按钮

**产出**：`src/store/useAiStore.ts`、`src/components/AiActionSplitButton.tsx`、jsdom 渲染测试。
**Done when**：① 主按钮语义恒定为「抠图」，不随内部状态换文字/禁用；② 进行中是**背景进度填充 + 「取消」，非灰态**（断言不出现 disabled 样式类）；③ 下拉可 Tab 进入、方向键选行、回车执行；④ **只渲染 `verified: true` 的条目**，未验证行为与模型不进 UI；⑤ 首次运行弹「需下载 4.4MB，约 10 秒」确认，取消则不下载。

### T12 · 对比视图

**产出**：`src/components/AiCompareView.tsx` + 渲染测试。
**Done when**：① 默认按住模式：按住显示原图、松开显示结果，两图同位同尺寸叠加；② **棋盘格底纹**存在（透明区不得呈纯白/纯黑）；③ 分屏模式为次要，且切过去必须显示「掩码在 320×320 下计算」字样（数值从清单取，不硬编码）；④ 两个动作：保存 / 不保存（**没有"丢弃"按钮**）。

### T13 · 设置总入口 + AI 分区

**产出**：`src/components/settings/SettingsDialog.tsx`、`AiSettingsPane.tsx`、`AppLayout.tsx` 加入口、渲染测试。
**Done when**：① 顶栏有「设置」，AI 分区显示只读统计（模型占用 / 可用磁盘 / 整卡显存，**口径标注"整卡"**）+ 暂存保留期与容量上限；② **不含**模型下载/删除/卸载操作（D17 唯一入口在下拉）；③ 参数区 M1 为空态并标注「暂无可调参数」，**不出现任何无效控件**。

### T14 · 接线、端到端验收与文档同步

**产出**：`PreviewOverlay.tsx` 挂载按钮与对比视图；`docs/PRD.md` 追加 R19+/D 系列引用与 US；`README.md` 功能特性与已知限制更新；本文件勾选状态。
**Done when**：规格文档 **§8 的 28 条验收逐条在真实构建产物上手动走通**并记录结果（尤其第 21–27 条：缓存键含参数、管线版本失效、EXIF 方向、保存失败保留暂存、保存后可见性、AG1 无出站请求）。**typecheck 0 错、test 全绿只是必要条件，不替代行为验收。**

---

## M1 明确不做（防止范围被塞回来）

- 不做通用抠图（BiRefNet 在 DirectML 上推理失败，Q14）
- 不做智能打标（CLIP 未实测，Q15）
- 不做任何后处理参数 UI 实装（§4.7 表里的候选项留给 M2，含耗时实测）
- 不做批量处理（M4）
- 不做插件 / 双安装包（D11 已否）
- 不替换原图、不做任何不可逆操作
- 不 push、不改 dev 端口、不动既有 XMP 存储方案

## 推到实施阶段的未决项

Q16 失败可诊断性（错误码 + 查看日志入口）· Q17 同图多份暂存的唯一键与清理归组 · Q18 M1 范围边界集中声明（本文件已代做）· Q19 ICC 剖面的验证方式。

---

## 实施记录与 §8 验收台账（2026-09-23）

提交序列：`ebce602`(T1) → `7f5a73b`(T2) → `496d1e8`(T3) → `74e5463`+`35e4573`(T4) → `57d1da9`(T5)
→ `bc2c22f`(T6) → `272273b`(T7) → `475314f`(T8) → `d2b1fe0`(T9) → `af68e01`(T10) → `b159572`(T11)
→ `41305b4`(T12) → `52e18b6`(T13) → `9af0587`(T14 接线) → `28febae`(T14 端到端 + 顺序修复)

自动化基线：`typecheck` 0 错；**214** 用例绿（基线 24）；`npm run build` 通过；
安装包 89.8 → **115.8 MB**，包内原生库只剩 `napi-v6/win32/x64` 五个文件 64.4MB。

| §8 | 条目 | 状态 | 证据 |
|----|------|------|------|
| 1 | 底栏组合按钮存在、非灰、无"请先下载" | 自动 ✓ | `previewWiring.test.tsx`、`aiUi.test.tsx` ②③ |
| 2 | 首次点击一次走完下载→加载→抠图 | 自动 ✓ | `cutoutE2E` 首条（真 hf-mirror 下载 + 真 DirectML） |
| 3 | 断点续传 / 完成后 sha256 | 自动 ✓ | `modelStore.test.ts` ①②③ |
| 4 | 处理时照片目录零新增；保存才落盘；原图不变 | 自动 ✓ | `aiService` 红线用例 + `cutoutE2E` |
| 5 | 加载不可见 | 自动 ✓ | `aiUi.test.tsx`（无"加载"文案、无第二击） |
| 6 | 进行中不置灰、背景进度、有取消 | 自动 ✓ | `aiUi.test.tsx` ②（断言无 `Mui-disabled`） |
| 7 | 下拉可纯键盘操作 | 自动 ✓ | `aiUi.test.tsx` ③（Enter/方向键/Esc + tabIndex） |
| 8 | 模型管理只有一个入口 | 自动 ✓ | `aiSettings.test.tsx` ② |
| 9 | 默认按住对比 + 棋盘格底纹 | 自动 ✓ | `aiCompareView.test.tsx` |
| 10 | 分屏注明掩码尺寸，数值取自清单 | 自动 ✓ | 同上（换 512×288 验证非写死） |
| 11 | 人像/非人像都不崩、文案不承诺通用抠图 | **待人工** | 需真实照片集，见下方人工清单 |
| 12 | 派生文件继承标签 + 行为标签，可筛出 | 自动 ✓ | `cutoutE2E`（真 exiftool 读回） |
| 13 | 不保存则照片目录始终干净 | 自动 ✓ | `cutoutE2E` §8-13 |
| 14 | 设置总入口 + 无假控件 | 自动 ✓ | `aiSettings.test.tsx` ①③（断言 input/slider 为 0） |
| 15 | 底栏只有已实测的行为 | 自动 ✓ | `aiUi.test.tsx`（verified 过滤） |
| 16 | CPU 模式限核并说明代价 | 自动 ✓（观感待人工） | 限核：并行度实测 1.99 核；开关与常驻代价提示 `b5e097c`；切后端必重建会话 `333864b`。新增 6 条用例（主进程 2 条 + 渲染层 4 条）**全部先红后绿**。**任务管理器观察待人工** |
| 17 | 显存不足可读提示 + 一键卸载 | **待人工** | 需连续加载多模型构造 |
| 18 | 子进程崩溃后主窗口存活 + 重启后仍能跑 | **自动 ✓（真机 Electron）** | `npm run verify:ai-crash` 全绿 exit 0：真杀进程后可读失败 68ms、主进程与窗口存活、BiRefNet 的 DmlFusedNode 被子进程内捕获、重启后 u2netp 6.6s 出正确掩码。**过程中揪出并修掉一个会让装机版抠图完全跑不通的传输 bug**，见文末《§8-18》 |
| 19 | 暂存不污染视图 | 自动 ✓ | `cutoutE2E` 断言结果只落 `ai-preview` |
| 20 | 缓存命中不重跑；改图必须重跑 | 自动 ✓ | `aiService` + `cutoutE2E`（inferCount 不变） |
| 21 | 缓存键含参数 | 自动 ✓ | `cacheKey` 五分量变异反证各红一次 |
| 22 | 管线版本变更失效 | 单元 ✓ / 端到端待人工 | `cacheKey` 用例覆盖分量；真改常量重跑需人工 |
| 23 | 清理只删暂存，不碰已保存成果 | 自动 ✓ | `previewLifecycle`（含前缀校验变异反证） |
| 24 | EXIF 方向图不抠歪 | 自动 ✓ | `oriented-6.jpg` 夹具 + `cutoutE2E` |
| 25 | 保存失败保留暂存可重试 | 自动 ✓ | `previewLifecycle` ④（moveFile 注入失败） |
| 26 | 保存后可见性 | 自动 ✓（选了提示方案） | `previewWiring`：snackbar 明确"重新扫描后出现" |
| 27 | AG1 无出站请求 | 自动 ✓（模块级） | `cutoutE2E` 包住 `global.fetch` 审计；**系统级抓包待人工** |
| 28 | RAW/GIF/超大图按 §6 表现 | **待人工** | M1 未实装 RAW/HEIC 解码分支 |

### 人工验收清单（一条命令一条观察 · 2026-09-24 整理）

环境先说清楚，省得每条重复：安装包 `dist/PhotoTagManager-0.1.3-x64.exe`；
**认包看字节**：本轮重建后 = **121,410,411**（含 CPU 开关、后端变化重建会话、打包收紧）；
`121,556,711` 那份是 12:54 的旧包，**不含 §8-16 的开关**，别拿它验第 16 行；
暂存目录打包后为 `%APPDATA%\PhotoTagManager\ai-preview\`，dev 跑时为 `%APPDATA%\Electron\ai-preview\`
（dev 的 `--user-data-dir` 实测就是 `AppData\Roaming\Electron`）。
"全新环境"= 先删掉 `%APPDATA%\PhotoTagManager\models\` 与 `ai-preview\` 两个目录再启动。

| §8 | 执行什么 | 只盯这一件事 | 结果 |
|----|---------|-------------|------|
| 11 | 装好后导入含**一张真人像**的目录 → 预览 → 点「抠图」→ 走完下载确认 | 保留的是**人**、背景变透明（棋盘格从透明区透出）。发丝边缘粗糙可接受；若留下的是椅子/墙面，记为"u2netp 选错主体"而不是 bug。**换一张风景或演出照再点一次：允许选错主体，但不得崩溃、不得出现"未知错误"，界面文案不得出现"去除任意背景"这类承诺。**  | ☐ |
| 16 | 装机版：点「抠图 ▾」→ 勾下拉底部「CPU 慢速模式（比 GPU 慢约一个数量级）」→ 再抠一张 | 底栏立刻常驻一句「当前走 CPU 慢速模式…」；任务管理器里 `PhotoTagManager` 的 CPU 占用压在 2 核量级（本机 32 逻辑核 → 约 6%），不得占满；**取消勾选后提示消失、再抠一张走 GPU**（快一个数量级） | ☐ |
| 17 | 另开一个吃满显存的程序（游戏/渲染/`torch` 占位）把整卡吃到 7.5 GB 以上，再在应用里点「抠图」 | 得到可读的"显存不足，请先卸载 XX"**并带一键卸载**；界面不卡死、窗口不崩。**不得**看到它悄悄改用 CPU 跑出结果（§5.2 明令禁止无声降级） | ☐ |
| 22 | dev 仓库里先抠一张让暂存命中；再把 `electron/ai/preprocess.ts:12` 的 `PIPELINE_VERSION = 1` 改成 `= 2`；`npm run dev` 重启；**同一张图**再点一次抠图 | 必须**重跑**（进度条走完、耗时是正常量级），不能秒出上次烘好的图。验完把常量改回 1 | ☐ |
| 27 | 抠图进行中，在另一个 PowerShell 里执行：`Get-NetTCPConnection -State Establish,Idle,Bound \| Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -like 'PhotoTag*' }` | **先把尺子证干净**：这条按进程名过滤，dev 跑时进程叫 `Electron`，一条都不匹配 → 空表看着像"零出站"其实是没抓到。要么在装机版上做，要么把条件改成 `-like 'PhotoTag*' -or $_ -eq 'Electron'` 并确认表里确实出现了该进程的条目。自证之后再看：除**模型下载阶段**对 `hf-mirror.com:443` 的连接外，加载/推理/编码期间**一条出站都不该有**（模型已下载好的第二次抠图，整段应完全没有出站连接） | ☐ |
| 28 | 往扫描目录放一张 RAW（.CR2/.NEF/.ARW）和一张 ≥4000 万像素的图，各点一次抠图 | RAW：给出中文可读原因（M1 未实装 RAW 解码分支，预期 `DECODE_FAILED` 的说明文案），**不是**"未知错误"、不是崩溃。超大图：正常出结果，且界面注明"已在 NxN 下处理" | ☐ |
| 1/6/9 | 全新环境启动 → 直接看底栏；点「抠图」；进对比视图 | ① 按钮一上来就可点、非灰、没有"请先下载"字样；② 处理中按钮以**背景填充**表进度，文字仍可读、有「取消」，全程不置灰；③ 对比默认是按住模式：按住=原图、松开=结果，两图同位精确叠加不偏移，透明区落在**棋盘格**上（不得纯白/纯黑底）。三条各截一张图留档 | ☐ |

#### §8-16 已裁定并实装（2026-09-24，用户选定「M1 内补显式 CPU 开关」）

**裁定结果**：不改判 M2，在 M1 内补齐。实装三件事，提交 `333864b`（主进程）+ `b5e097c`（渲染层）：

1. 下拉底部一行「CPU 慢速模式（比 GPU 慢约一个数量级）」勾选框——可点、可 Tab 到，不是 hover 浮层（D17）；
2. 勾选后底栏**常驻**代价提示「当前走 CPU 慢速模式：比 GPU 慢约一个数量级，已限制线程数，不会占满全部核心」；
   提示里刻意不写"限 X 核"这种数字，核数由 `inferenceChild` 的线程常量单点决定，界面复述一遍就是第二处事实源；
3. **后端变化必须重建推理会话**。加载守卫原先只比 `runner.loadedModelId !== model.id`：模型已驻留时第二次请求整个跳过 `load()`，用户勾的 CPU 被静默丢掉，界面写着走 CPU、实际还在 GPU 会话上跑——正是 D12「禁止无声降级」的反面。改后判据是「模型 id 或后端任一变化即重建」，并始终显式把后端传给子进程，不再依赖对方默认值。**这条不是"待人工"能看出来的，只有把开关接上才暴露**。

**两条随裁定一并定死的口径**：

- 后端选择**不持久化**，重启回 GPU。它是慢速兜底而不是偏好项，代价换来不新增 IPC 通道（免三处同步）；要不要进 `settings.json` 留给 M2。
- **`backend` 不进缓存键**。五元组锁的是"输出内容"，后端只决定快慢，同一模型同一参数下 CPU 与 GPU 产物等价；把后端塞进键里会让切一次后端就把暂存全部作废。

**顺带照出、本轮不做的一条**：规格 §6 最后一行「无可用 GPU 加速设备 → 清单里所有条目转**「不可用」并说明原因**，允许显式选择 CPU 慢速模式」——M1 只实装了后半句（显式选 CPU 现在有正门了），**前半句没做**：清单没有设备能力探测，`AiModelStatus` 只有 `absent|downloading|present` 三态，没有 GPU 可用性判定。后果是没有 DML 设备的机器上，用户看到的是点完之后的可读错误，而不是提前就标注好的「不可用」条目。已记为 M2 待办，本轮不扩范围。

**下面这段诊断与那两条临时验证路径 (a)(b) 保留作历史，路径已作废**——装机版现在有正门，不必再靠禁 GPU 或改代码默认值去造 CPU 场景。

#### §8-16 为什么装机版执行不了（实施期发现的口径缺口）

规格 §8-16 要求"强制 CPU 模式 → 界面明确说明当前走 CPU 及其代价"，但 M1 实现里
`AiRunRequest.backend`（`shared/types.ts:160`，注释写明"必须用户显式勾选"）**只是个字段**——
渲染层没有任何控件会传它，装机版唯一的 CPU 路径是 DirectML 建会话失败时引擎自己回退，
而那属于 §5.2 明令禁止的"无声降级"。**线程限核本身已有实测证据**
（`tests/ai/cpuThreads.integration.test.ts`：限 2 线程并行度 1.99 核 vs 放开 16 的 15.94 核），
缺的是"用户能显式选 CPU + 界面写明代价"这半条。

两条可执行的验证路径（都不需要新功能）：
- (a) **§6 最后一行的场景**：在设备管理器里禁用 GPU（或换一台无 DML 的机器）后启动 → 看清单条目是否转"不可用"并说明原因、是否允许显式选 CPU；
- (b) dev 仓库里把 `aiService` 请求的默认 `backend` 临时改成 `'cpu'` 跑一次 → 看界面有没有写明代价。

这条**不该记成"待人工"**，它是实现缺口。要不要在 M1 内补一个 CPU 开关，等人工验收时一并裁定。

#### §8-11 的正确性判据边界（别再踩）

探针产物 `out/cutout.u2netp.onnx.dml.png` **不能**当"抠得对不对"的基准
（与两种生产算法平均 alpha 差 21%~24%，且它保留的是画面下方人群而原图显著区在上方烟花，
详见上一节《更正》）。人像抠对只能靠这张表第 11 行人眼看，端到端测试只断言链路与形态。

### 实施期间修正的设计文档缺口

- **§4.4 保存后必须写标签，而 `copyMetadataFrom` 的 `-all:all` 会把源图 `XMP-ptm:Tags`
  整体刷回派生文件**，覆盖掉刚追加的行为标签。已把顺序改为"先复制元数据、后写标签"，
  并在单测里钉死调用顺序（`28febae`）。规格未写明这个先后关系，属于实施期才发现的口径缺口。
- **Q19 ICC 验证方式已定**：解压 PNG `iCCP` 块做字节比对（`postprocess.test.tsx`）。
- **§5.2 "整卡口径"落到实现与文案**：新增 `electron/ai/gpuStats.ts`，界面必须写"整卡已用"，
  测试禁止出现"AI 占用"这类措辞。
- sharp 0.35 的 `joinChannel` 在源图带 alpha 时**静默忽略掩码**，改用 `composite + dest-in`
  并以 LA 第二波段承载掩码；`resize` 后 `.raw()` 会扩成 3 波段。四条都写进了代码注释。

### 更正：探针参照图不能当正确性判据（2026-09-23 实测）

上表把 `out/cutout.u2netp.onnx.dml.png` 称作"已知正确的参照图"，这条**不成立**，已用真机实验否掉：

| 变体 | 与参照图的平均 alpha 绝对差 |
|---|---|
| 裁掉补边后映回原图（本实现） | 61.70 / 255（24.2%） |
| 整幅 320×320 直接拉伸回原图 | 54.45 / 255（21.4%） |

两种算法都和参照图差两成以上，说明参照图用的是**另一套掩码处理**，不是同一结果。
更关键的是对齐判断：该图（演唱会烟花）在 320 网格上 `padY=0`、只有左右各 40 像素补边，
所以"裁不裁"只造成横向 1.33 倍差异，**不可能把显著区从上方搬到下方**；
而参照图保留的是画面下方的人群与烟雾，原图最亮的显著区在上方烟花。
本实现的输出保留的正是上方烟花爆发区，与 §4.3 对这张图的记述一致
（"它把舞台亮部当成了主体"）——即 u2netp 对非人像选错主体时的预期表现。

结论：这张参照图只能证明"DirectML 能产出真带透明的 PNG"（M0 的原始目的），
**不能用来判 M1 抠图对不对**。因此：

- §8-11「人像照应抠对」**仍是待人工**，需要一张真人像照片；不能用参照图代替；
- 端到端测试只断言链路与形态（尺寸、alpha 通道、方向、缓存、字节不变），
  不断言"抠得准"，避免把主观质量伪装成自动通过。

### 安装包复核（T14 收尾）

`npx electron-builder` exit 0；`dist/PhotoTagManager-0.1.3-x64.exe` = 121,542,225 字节（115.9MB）。
`app.asar` 内含 `out/main/index.js`、`out/main/scanWorker.js`、**`out/main/aiChild.js`**（推理子进程入口，缺它则打包后无法起子进程）；
`app.asar.unpacked` 内原生库恰为 5 个：onnxruntime.dll 28,754,232 / DirectML.dll 18,527,584 /
dxcompiler.dll 17,986,360 / dxil.dll 1,508,664 / onnxruntime_binding.node 298,848，共 64.4MB，
无 darwin/linux/win32-arm64 残留。

### 真 Electron utilityProcess 复核（2026-09-23，`npm run verify:ai-child`）

node 环境的集成测试只能证明 `ChildInference` 本身，证明不了 `aiChild.js` 作为
`utilityProcess` 子进程的传输链路。用真 Electron 跑打包产物复核，结果：

```
[probe] load reply ok=true {"modelId":"u2netp","loadMs":4953,
        "outputNames":["1959","1960","1961","1962","1963","1964","1965"]}
[probe] infer ok len=102400 dims=1x1x320x320 out=1959 inferMs=39 range=[0.000,0.001]
[probe] 未知类型回 ok=false msg=未知的子进程请求类型：bogus
[probe] child exit code=0
```

由此确认：`out/main/aiChild.js` 可被 fork；子进程内 DirectML 会话建立成功
（7 个输出、名 `1959`…`1965`，与"已验证事实"表一致）；`[1,3,320,320]` 输入回传
`Float32Array(102400)`，推理 39ms 与 M0 的 20/8/7ms 同量级；协议错误在子进程内
转成 `ok:false` 而不是崩进程；`child.kill()` 后退出码 0（不留孤儿）。

台账相应更新：
- §8-18 的"子进程崩溃不影响主窗口"——传输与生命周期已在真 Electron 里实测，
  **仍待人工**的是注入必崩模型（BiRefNet）后的窗口存活观察；
- §8-2 / §8-5 的"一次点击走完、加载不可见"——底层链路已实测，界面层仍待人工走一遍。

### §6 输入形态闸门补齐（2026-09-24）

补上此前缺口的两条 §6 行为，`preprocess` 现在在解码前先看元数据：

- **多帧 / GIF** → `assertSingleFrame` 明确拒绝（"不支持多帧/动图输入（如 GIF）：M1 只处理单帧图片"），
  不静默取首帧当正常结果；
- **RAW / HEIC / 损坏文件** → 解码异常包成中文可读原因，`aiService` 映射为
  `DECODE_FAILED`（此前会落到 `INTERNAL_ERROR`，界面只能显示"未知错误"）。

夹具 `tests/fixtures/ai/anim2.gif`（ffmpeg 生成，sharp 读回 `pages=4`）。
测试先断言"夹具本身确实是多帧"再断言管线拒绝——第一版用 sharp 造动图，
`pages` 恒为 1，用例里的 `if (pages < 2) return` 让它**静默空过**，
属于典型假绊线，已换成真断言。

台账更新：§8-28 的 GIF 与损坏文件两行已有自动证据；**RAW 与超大分辨率图仍需真机各跑一次**
（本机无 RAW 样本，且"已在 NxN 下处理"的界面注明属人工观察项）。

### §8-16 CPU 限核改为实测（2026-09-24）

原先这条只由 `buildSessionOptions` 的字段断言支撑，属于"代码里写了参数"，
不等于运行时真的被限住。补 `tests/ai/cpuThreads.integration.test.ts`：
用 `process.cpuUsage()` 与墙钟时间算出实际并行度，并带一条反证。

```
[dml-guard] 限 2 线程：并行度≈1.99 核（本机 32 逻辑核），12 轮耗时 7146ms
[dml-guard] 16 线程并行度≈15.94，2 线程≈2.00
```

断言用相对值（并行度 < 4 且 < 逻辑核数的一半；放开线程时至少是限核时的 1.5 倍），
不设绝对耗时阈值，避免换机器就假红。§8-16 由"部分"升为自动证据；
**界面必须写明"当前走 CPU、会慢很多"这条仍属人工观察项。**

## §8-18 真机崩溃恢复探针（2026-09-24，**全绿 exit 0**，顺带揪出一个致命传输 bug）

跑法：`npm run verify:ai-crash`。探针**不自带 runner 副本**：新增构建入口
`out/main/crashHarness.js` 暴露生产的 `ChildRunner` + `makeUtilityProcessSpawner`，
与 `out/main/index.js` require 的是同一个 `out/main/chunks/runner-<hash>.js`
（已核对，因此跑绿跑红都算在发布代码头上）。三段场景：B1 在途请求遇到子进程真死 →
A 注入必崩模型 BiRefNet-lite@DirectML → R 崩溃后服务必须还能用。
判定不过 exit 1，探针自身总超时 exit 3。
上一会话"探针跑很久没结果"的真因是脚本自身正则没闭合（`node --check` 一条命令即暴露），
Electron 主进程加载失败弹的是**原生阻塞对话框**，进程挂着而 stdout 永远为空。

### 根因：`makeUtilityProcessSpawner` 解包解错了层

`electron/ai/runner.ts` 原来读 `payload = message.data`。**套 `{ data }` 信封的是子进程那侧的
`process.parentPort`；Electron 的 `utilityProcess.on('message')` 在父进程侧直接把消息本体交出来。**
于是 `reply.id` 恒为 `undefined` → `pending.get(undefined)` 不命中 →
**每一条子进程答复都被静默丢弃**，主进程只能等到超时。
这不是崩溃恢复的边角问题：**修之前，装机版里没有任何一次抠图能走通。**

为什么 220 个用例全绿也照不出来：runner 的测试假件讲的是**内部 `ChildEvent` 形状**，
从没经过 `makeUtilityProcessSpawner` 这一层；而昨天通过的 `verify:ai-child` 探针自带一套
手工收发（读的是 `msg.id`，恰好就是 Electron 的真实形状），所以它好、生产路径坏。
**教训：跨进程适配器必须有一条"按宿主真实形状"的用例，不能让假件替宿主说话。**
补的用例先红（`ChildNotRespondingError: 加载模型 u2netp 超时（1 秒）`）后绿。

### 修好后的真机实测（`probe-exit=0`，总耗时 30.5s）

| 断言 | 实测 |
|---|---|
| B1 真的拿到 pid 并下了 kill | 通过。早先只等 400ms 时 `.pid` 还是空、kill 从未真的执行——已把等待改到 1.5s 并把"是否真杀"写成断言 |
| B1 在途任务以可读错误失败、不静默成功 | `推理子进程已退出（code=1）…`，**68ms** 返回（阈值 60s） |
| B1 主进程与 BrowserWindow 存活 | 均通过 |
| A 注入 BiRefNet-lite@DirectML | `load 9053ms` **成功**，执行期抛 `DmlFusedNode_19_64`，被 `createMessageHandler` 捕获成可读错误（进程没死，形态 = caught-in-child） |
| R 崩溃后服务仍可用 | 新进程上 u2netp **6626ms** 加载 + 推理成功，掩码 `len=102400 dims=1x1x320x320 out=1959` |
| R 重启确实发生且跑在新进程上 | `restartCount=1`（由 B1 引发；A 按设计不产生重启） |
| 整卡显存采样 | B1 后 1366 MiB → A 后 **7734 MiB**（逼近本机 8151）→ R 仍成功 |

两条可用事实：① BiRefNet 一次失败加载就把整卡顶到 7.7GB，**§8-17 的显存压力条件几乎自然出现**；
② 子进程退出后 `.pid` 会读成空，所以"pid 为空"不能当"进程没起来"的证据——
判 kill 是否真发生必须在 kill 之前取 pid 并断言。

### 撤回本节先前写下的两条结论（都是被上面这个 bug 遮蔽出的假象）

1. ~~"崩溃之后服务不能再跑 / 同一主进程内第二次 `utilityProcess.fork` 完全不应答"~~
   —— 不是二次 fork 的问题，是**所有**答复都没被结算；修好后 R 一次通过。
2. ~~"BiRefNet@DirectML 的失败形态是会话创建挂死 120~240s，M0 记的'加载成功'不再成立"~~
   —— **M0 的记述完全正确**：加载成功（本次 9.1s）、执行期抛 `DmlFusedNode_19_64`。
   之前看到的"挂死"就是 reply 被丢导致的超时。结论方向不变：BiRefNet 在 DirectML 上不可用，
   M1 不承诺通用抠图。仍然成立的新增实测：BiRefNet 真实输入张量名是 **`input_image`**
   （旧探针误写 `input.1`）、CPU 侧读它的元数据要 **17.1s**。

### 本轮两个真实产品修复与一条提醒

- **载荷解包**（上面那个，影响"整个功能在装机版能不能跑"）。
- **代际隔离**：超时回收 child#1 后立刻拉起 child#2 时，child#1 迟到的 `exit` 会走 `handleExit`，
  把 child#2 的在途请求一起 `failAll`，并把仍存活、占着显存的 child#2 从台账抹掉
  （等于泄漏一个会话）。改法：每个子进程一个 `generation`，非当前代际的事件直接丢弃；
  `handleExit` / 超时回收 / `dispose` 三处都作废代际，超时回收同时计一次重启。
- **加载预算**：BiRefNet 一次加载实测 9.1s，而 `DEFAULT_LOAD_TIMEOUT_MS = 30_000` 只剩 3 倍余量，
  模型再大就不够。M1 只发 4.4MB 的 u2netp 不受影响；M3 加百 MB 级模型前要把加载上限做成按体积算的参数。

### 打包新增依赖（本轮改动带来的）

main 多了一个入口后 rollup 开始代码分割：`out/main/index.js` 现在
`require("./chunks/runner-<hash>.js")`（文件名带内容哈希，改一次 `runner.ts` 就会变，别按具体名字断言）。**`out/main/chunks/` 成了运行时必需**，
`build.files` 的 `out/**/*` 需实测覆盖到它——收尾复核安装包时必须确认 asar 内含该目录。
`out/main/crashHarness.js` 已加入 `build.files` 排除，不进产品包。

复核结果（2026-09-24，`npm run dist` exit 0 + `npx asar list`）：

```
/out/main/aiChild.js  /out/main/index.js  /out/main/scanWorker.js
/out/main/chunks/runner-<hash>.js          ← 代码分割后的运行时必需件，已在包内
安装包 121,555,296 字节（115.98MB，较上一版 115.9MB 基本未变）
```

### 打包污染已修复（2026-09-24，`cd49cdd`）

采纳方案「收紧 `build.files`」，不动 `tsconfig`：`out/**/*` → `out/main/**` + `out/preload/**` + `out/renderer/**`，
其余排除项原样保留（先收录后排除，与改前顺序一致）。选它而不是"把 tsc 的 `outDir` 挪出 `out/`"，
因为前者只回答"发什么给用户"这一个问题，后者动的是开发工具链。

复核用能失败的两条断言（缺一即算未过）：`out/main/chunks/` 必须有条目、`tsc-` 命中数必须为 0。

```
npx asar list dist/win-unpacked/resources/app.asar   # 逐条目核对

收紧前 29,538 条 → 收紧后 29,444 条，差 94 条正好全是 out/tsc-*
  ├ 编译后的测试文件 *.test.js  21 条
  ├ *.tsbuildinfo                2 条
  ├ out/tsc-web/zz-test-new.txt  1 条
  └ 一条 tsc 版 crashHarness.js —— !out/main/crashHarness.js 从没覆盖到它，
    崩溃探针源码一直随包发出（这条此前未被记录）
收紧后 out/main 下五条原样在册：aiChild.js / index.js / scanWorker.js
  / chunks / chunks\runner-BI5CGBT1.js   ← 代码分割的运行时必需件未受影响
安装包 121,556,711 → 121,409,987 字节（-146,724）
asar.unpacked 内原生库仍是 win32/x64 五个文件，无其他平台残留
```

（前文《安装包复核》记的 "27 条测试文件 / 121,555,296 字节" 出自另一次构建，按本轮实测数为准。）

### 安装包重建（含 §8-16 开关）· 2026-09-24

提交序列：`333864b`（后端变化必重建会话）→ `b5e097c`（CPU 开关与代价提示）→ `cd49cdd`（`build.files` 收紧）。

门槛全绿：`typecheck` exit 0、`npm test` **227 用例全过**（21 个文件，含真 DirectML 的 `cutoutE2E` 90s 与
`cpuThreads` 限核实测）、`npm run build` exit 0、`npm run dist` exit 0。
最终包：`dist/PhotoTagManager-0.1.3-x64.exe` = **121,410,411 字节**，asar 内 `out/` 只剩 14 条
（renderer 5 + preload 2 + main 5 + 目录 2），`tsc-*` 0 条、`crashHarness` 0 条。
待人工清单里 **§8-16 这条现在可以在装机版上执行了**。

**本轮踩到的两条，记下来**：

- **`npm run dist` 不含 `electron-vite build`**（`dist` 脚本就是 `electron-builder`）。改完代码直接 `dist`，
  打进去的是 `out/` 里上一次构建的旧产物，而 `asar list` 的条目数几乎不变，完全看不出代码是旧的。
  本轮第一次重建就打了旧包，靠"`out/main/index.js` 的 mtime + 是否含 `loadedBackend`"才发现。
  顺序必须是 `build` → `dist`（`verify:ai-*` 脚本已经自带 build）。
- **复核不能只数条目**。收紧 `files` 的正确性用"条目数 -94、`tsc-` 为 0"能证；但"发布代码对不对"
  要把包抽出来 grep 内容：`asar.extractAll` 到临时目录后，在 `out/main/index.js` 里查 `loadedBackend` 判据、
  在 `out/renderer/assets/index-*.js` 里查「CPU 慢速模式」与常驻提示文案，并确认 `out/main/chunks/`
  仍有 runner 分片。六条全 PASS 才算这个包可信。
