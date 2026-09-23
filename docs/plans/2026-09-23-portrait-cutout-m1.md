# 人像抠图（M1）实施任务清单

> 版本：v1.1 · 日期：2026-09-23 · 状态：**已实施（T1–T14 代码与自动化证据完成；§8 中标注"待人工"的条目需在真实安装包上验收**）
>
> **规格权威源：[docs/design/ai-photo-processing.md](../design/ai-photo-processing.md)（v0.6）**。本文件只负责"怎么拆、按什么顺序做、每步做完算交付"。两者冲突时**以规格文档为准**，并回来改本文件。
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
| 16 | CPU 模式限核并说明代价 | 部分 | `buildSessionOptions` 单测锁线程数；**任务管理器观察待人工** |
| 17 | 显存不足可读提示 + 一键卸载 | **待人工** | 需连续加载多模型构造 |
| 18 | 子进程崩溃后主窗口存活 | 自动 ✓（协议层） | `runner` 测试：exit → 当次失败 + 自动重启；真 BiRefNet 注入待人工 |
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

### 留给真机验收的人工清单（需你在装好的应用上做）

1. §8-11 人像照与非人像照各一张：不得崩溃，非人像允许选错主体但文案不得承诺"去除任意背景"；
2. §8-16 强制 CPU 模式时开任务管理器，确认占用被限制在 2 核量级（D12 的直接验收）；
3. §8-17 连续加载多模型构造显存不足，确认提示可读、窗口不卡死；
4. §8-18 用调试入口注入 BiRefNet（DirectML 上必崩），确认子进程重启且主窗口存活；
5. §8-22 手工把 `PIPELINE_VERSION` +1 后确认旧暂存不被命中；
6. §8-27 处理期间用抓包/连接表复核除模型下载外无出站；
7. §8-28 RAW、GIF、超大分辨率图各一张，核对落入 §6 表格某一行；
8. §8-1/6/9 的观感确认：按钮不置灰、棋盘格可见、按住对比贴合（截图留档）。

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
