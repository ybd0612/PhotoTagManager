# 人像抠图（M1）实施任务清单

> 版本：v1.0 · 日期：2026-09-23 · 状态：**待执行**
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
