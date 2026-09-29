# u2netp —— 人像抠图（A8）

| 字段 | 值 |
|---|---|
| 能力 / 族 | 人像抠图（去除人像背景）／ A8 显著性抠图 |
| 里程碑 | **M1，已上线**（当前软件唯一的 AI 行为） |
| 状态 | ☑ 已确认在用 ｜ 许可档位：**需评估**（详见下） |
| 面向用户的说法 | 「抠图」，下拉里标注**人像**——不承诺"去除任意背景" |

> **运行时数值（`repoId` / `sha256` / 张量名 / 归一化）取自 `electron/ai/capabilityCatalog.ts`，本文件只引用、未在此复核。** 要改数值改那边。

---

## 1. 身份与来源

| 项 | 值 |
|---|---|
| 仓库 / 文件 | `BritishWerewolf/U-2-Netp` ／ `onnx/model.onnx` |
| 下载 URL | `https://hf-mirror.com/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx`（2026-09-23 实下 200） |
| 体积 | 4,574,861 字节（4.36 MB，2026-09-23 实下） |
| sha256 | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`（2026-09-23 实算；09-29 U7 重下后哈希与备份一致） |
| 输入 | 张量名 `input.1`，形状 `[1, 3, 320, 320]` |
| 归一化 | `rescale 1/255`，`mean [0.485, 0.456, 0.406]`，`std [0.229, 0.224, 0.225]` |
| **第二源** | ⚠️ **ModelScope 无此仓库（实测 404，另试 8 个可能的镜像仓库名全部不存在）** → 这条是"不拿 ModelScope 替换 hf-mirror"的直接原因 |

## 2. 许可（2026-09-29 查，按 `model-licensing-and-survey.md` §4 七项）

| # | 证据项 | 结果 |
|---|--------|------|
| 1 | SPDX 许可 | **Apache-2.0** —— 在 §3.0 白名单内 ✅ |
| 2 | LICENSE 文件真在仓库内？**一手** ✅ / **二手** ❌ | 一手 `xuebinqin/U-2-Net` **有 LICENSE 文件**（查文件清单确认）；我们实际下载的镜像**没有**（`siblings` 只有 `.gitattributes`/`README.md`/`config.json`/`onnx/model.onnx`/`preprocessor_config.json`） |
| 3 | 一手 or 二手 | **二手**：第三方转导出的 ONNX，个人账号 2025-03 建 |
| 4 | 转换记录 / 可复现 | ❌ **无**：README 未给转换脚本、源 `.pth` 标识或转换日期 |
| 5 | sha256 + 双源 | 见上表（ModelScope 404，无法双源比对） |
| 6 | 本机 DirectML 跑通 | ✅ 见 §4，两组数字（09-23、09-29 各一次） |
| 7 | 归属 | Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane, Martin Jagersand — U²-Net，CVPR 2020；一手仓库 `https://github.com/xuebinqin/U-2-Net` |

**二手方的自述（重要，它决定了这不是"冒充授权"）**：该仓库 README 明确写
`The authors of the original U-2-Net model can be credited at https://github.com/xuebinqin/U-2-Net` 与
`This model is licensed under the Apache License 2.0 to match the original U-2-Net model` ——
即**沿用上游许可并如实标注**。

**同链条上更谨慎一方的原话**（rembg issue #837）："It does not cover the model files"、"I am not the rightsholder for those, so I cannot grant or confirm rights to them"、"I do not have a conversion record for that file"，并建议要可验证来源链就自己从上游权重转导出；另指出离线交付时引导下载属于 `redistributing them yourself`。

**还有一处解释空间**：一手仓库的 `u2netp.pth` 放在 GoogleDrive / 百度网盘，README 未单独声明权重许可，仓库根的 Apache-2.0 是否延伸到仓库外文件并不确定。（本条按新加的"权重与 LICENSE 同仓"判据已不再需要解释——它变成我们的筛选理由，而不是待论证的疑点。）

### 已知限制（按规范 §6.1 的四行格式，**已结案，不整改**）

```
缺口：        同一性——下载的是一份转导出的 ONNX，无转换记录
谁担保：      BritishWerewolf/U-2-Netp（个人账号，无转换记录）；许可本身由一手作者仓库的 Apache-2.0 担保
最坏后果：    抠图效果与作者版本不同（掩码质量差/主体判错）——不是版权追责
复查触发条件： ① 人像抠图出现无法解释的效果异常；② 更换或新增抠图模型时一并重估
```

**为什么不整改**：自转一手需要装 PyTorch 级依赖（数百 MB 至 2 GB），而最坏后果只是效果差异，**收益不抵成本**（2026-09-29 用户裁定）。

## 3. 能力边界（别对用户说过头）

- **只适合人像。** 早期探针拿一张演唱会现场照测，它把**舞台亮部**当成了主体（前景占比 8.7%，轮廓连贯但完全选错对象）。链路与性能都是真的，**通用性不是**。
- 因此 M1 的对外文案定为「人像抠图」，**通用抠图另立 Q14**，且 Q14 至今未结（BiRefNet-lite 在本机 DirectML 上加载成功但执行即抛 `DmlFusedNode`）。
- 允许在非人像图上选错主体，**但不许崩溃、不许报未知错误**（这是 §8-11 的验收口径）。

## 4. 实测数字（都是开发机，不得当产品承诺）

| 日期 | 后端 | 加载 | 推理 | 显存增量 | 备注 |
|------|------|------|------|---------|------|
| 2026-09-23 | DirectML | **0.96 s** | **21 ms** | 整卡 **+325 MiB** | 冷启动首次 3.5 s（DLL 落地代价） |
| 2026-09-23 | CPU（2 线程） | 0.18 s | 201 ms | — | 慢约 10× |
| 2026-09-29 | DirectML | **1.47 s** | **27.1 ms** | 整卡 **+337 MiB** | 复测，与旧值同量级 → 独立复现了一次 |
| 2026-09-29 | CPU（2 线程） | 53.6 ms | **243.4 ms** | 0 | 约 9× |
| 2026-09-29 | CPU（4 线程） | 67.9 ms | **174.8 ms** | 0 | 加线程只快 28%，收益见顶很快 |

⚠️ 口径：显存是**整卡已用**（含机器上其他 GPU 进程），界面只能写"整卡已用"，不能写"AI 占了多少"。
两条推论：**GPU 慢在准备、CPU 慢在计算**（加载 1.47 s vs 0.05 s，推理反过来）。

## 5. 管线与产物

- **sigmoid 自动判定**：实测 u2netp 首输出已在 `[0, 0.997]`，**不该再过一遍 sigmoid**；判据写成"最小值 ≥ -0.01 且最大值 ≤ 1.01 视为概率"。
- 掩码在 `320×320` 上计算后 resize 回原图尺寸写 alpha；**分屏对比时必须注明"掩码在 320×320 下计算"**，否则用户会把右图变糊当 bug 报。
- 产物：`原名.cutout.png`（同目录派生新文件，原图字节不动）；继承原图 `XMP-ptm:Tags` 并追加 `AI人像抠图`。
- ICC 由 sharp `keepIccProfile()` 在编码时保住；EXIF 拍摄时间靠 exiftool 复制且**必须额外点名 `-ICC_PROFILE`**（单用 `-all:all` 会静默少复制）。
- CPU 路径必须显式限 `intraOpNumThreads`，默认线程会吃满全部核心。

## 6. 一处**过期陈述**（待同步，本文件未改那边）

`docs/plans/2026-09-23-portrait-cutout-m1.md:68` 仍写探针产物 `out/cutout.u2netp.onnx.dml.png` 是"**已知正确的参照图**"。
这条**同日已被实测否证**：它与生产管线两种变体的平均 alpha 绝对差为 61.70/255 与 54.45/255（差两成以上），且那张图的主体位置差异不可能由补边造成——参照图保留画面下方人群与烟雾，原图最亮区在上方烟花。**它只能证明"DirectML 能产出真带透明的 PNG"，不能判抠得对不对。**
→ 建议把那边改成"仅证明链路可跑通的探针产物"，但**未获授权，本轮不动**。

## 7. 待办

- 无强制待办（许可已结案）。
- 可选：给这条条目补 `license` / `provenance` / `provenanceStatus: 'second-hand'` 字段（规范 §5 待办 2 的断言一旦上线，这条会因缺字段变红，需要点名豁免）。

## 8. 变更史

| 日期 | 事件 |
|---|---|
| 2026-09-23 | 探针选定、实下、sha256 实算、DirectML 跑通；因通用性不足把行为改名为"人像抠图"；参照图"已知正确"的说法被实测否证 |
| 2026-09-24 | 修跨进程答复信封 bug 后，装机版第一次真正跑通抠图（修前**没有任何一次抠图能走通**） |
| 2026-09-28 | 用户真机认可抠图主观质量（"效果很好"） |
| 2026-09-29 | U7 下载跟随系统代理闭环：删缓存重下，逐源日志齐（modelscope 404 → hf-mirror 200 → 校验通过），哈希与备份一致；许可链条查清并结案；复测性能两组 |
