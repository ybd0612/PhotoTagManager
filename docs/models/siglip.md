# SigLIP —— 零样本打标地基（A2 替代）

| 字段 | 值 |
|---|---|
| 能力 / 族 | 零样本打标／图像嵌入 ／ A2 理解与分析（本模型是**编码器**，不是完整打标端到端模型） |
| 里程碑 | 待定（2026-10-07 完成准入查验，**未进清单**） |
| 状态 | ☐ 未进清单 ｜ 许可档位：**可用（附披露）** ｜ **DirectML + CPU 双后端实测通过** |
| 默认模型 | —（尚无`defaultModelId`，能力条目本身也还没建） |
| 面向用户的说法 | **暂不对用户宣传**。它是内部地基，不是用户可选的一项处理行为 |

> **本文按 [`README.md`](README.md) 的卷宗模板 v1 书写。**
> 运行时数值（`repoId` / `sha256` / 张量名 / 归一化）**一旦写入 `electron/ai/capabilityCatalog.ts`，以那边为准**，本文件只引用。
>
> ⚠️ **本卷宗记的是「模型可用」，不是「功能可用」。** 从模型到功能之间还隔着三件事：
> ① 文本塔（下面§2 说明为何不能现在下）；② **Q11 词表策略未决**（`../design/ai-photo-processing.md:369`）；
> ③ 打标结果的**置信度阈值**未定。三件都没做之前，本条目进不了 `§4.3` 清单。

---

## 0. 为什么是 SigLIP 而不是 CLIP（本文存在的理由）

用户原计划是 CLIP ViT-B/32（文档 §3A2 写的就是它）。**2026-10-07 准入查证发现 CLIP 过不了准入**，换 SigLIP 的原因有三条，按重要性排：

| # | 原因 | CLIP ViT-B/32 | **SigLIP base-patch16-224** |
|---|---|---|---|
| 1 | **一手仓 SPDX 标识** | ❌ **查不到**（`openai/clip-vit-base-patch32` 的 `cardData.license` 为 `undefined`，README 里也无任何许可声明） | ✅ **`apache-2.0`** |
| 2 | 视觉塔量化后体积 | 84.5 MB（`vision_model_q4`） | **60.3 MB** |
| 3 | 训练语料 | WebLi英文为主 | WebLi，**中文零样本表现预期更好**（⚠️ 未实测，见 §5 未验项） |

第 1 条是**决定性的**：按 `../design/model-licensing-and-survey.md` §3.0 白名单原文——

> 拿不到明确 SPDX 标识、或许可写不清的 → **直接按「不列」处理，不进入讨论环节**

而 §3.1 的「可用（附披露）」改判**只对「标识已在白名单内、但 LICENSE 文件本体找不到」这一格有效**，救不了「标识本身缺失」。所以 CLIP 不是「风险高一点」，而是**按现有规则直接出局**。

### 查证时一并排除的候选（避免以后重复查）

| 候选 | 结果 | 依据 |
|---|---|---|
| `Xenova/dinov2-small` | ❌ 标识缺失 | `cardData.license` 与 LICENSE 文件**均无** |
| `Xenova/mobileclip_s0` | ❌ 不在白名单 | 标识 `other`，正文是 **Apple 专有许可**（含商标限制，非开源） |
| `apple/DFN5B-CLIP-ViT-H-14` | ❌ 不在白名单 | 标识 `apple-amlr` |
| `Xenova/siglip2-base-patch16-224` | —镜像仓不存在 | 只在 `google/` 一手仓有；且比 SigLIP 1 大一代，成本更高 |
| `openai/clip-vit-base-patch32` | ❌ 见上| 一手仓也无任何许可声明 |

> **一条方法论记录**：`Xenova/*` 这一批 ONNX 转导出仓**普遍不带 SPDX 标识**（实测 clip / dinov2 / beit / resnet-50 / vitmatte 全部 `undefined`，只有 modnet 与 RMBG-1.4 例外）。所以「查镜像仓的 license 字段」这条路对多数候选会直接撞墙，**必须回到一手仓查**。

---

## 1. 身份与来源

| 项 | 值 |
|---|---|
| 仓库 / 文件 | `Xenova/siglip-base-patch16-224` ／ `onnx/vision_model_q4.onnx`（**仅视觉塔**） |
| 源 1 hf-mirror | ✅ 200 → `https://hf-mirror.com/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_q4.onnx` |
| 源 2 ModelScope | ✅ **200**（**免代理直连**）→ `https://www.modelscope.cn/models/Xenova/siglip-base-patch16-224/resolve/master/onnx/vision_model_q4.onnx` |
| 体积 | 63,262,114 字节（**60.34 MB**，2026-10-07 实下） |
| **双源字节比对** | ✅ **两源各下一份，sha256 逐字节相同**（`ffb4672d…72ffb2524`，`cmp` 无差异）。这是本项目**第二次**做成双源比对（第一次是 MODNet） |
| 输入 | 张量名 **`pixel_values`**，`[1, 3, 224, 224]`，`float32`。⚠️ feed 必须带 `location: 'cpu'`，缺了报 `Tensor.location must be a string.`（onnxruntime-node 的契约，**不是模型问题**） |
| 输出 | **两个输出**：`last_hidden_state` `[1, 196, 768]`（逐 patch 特征）、`pooler_output`（投影后的全局向量，**打标用这个**） |
| 归一化 | 像素映到 **[-1, 1]**，即 `rescale 1/255` 后 `mean [0.5,0.5,0.5]` / `std [0.5,0.5,0.5]` |
| 一手出处 | `google/siglip-base-patch16-224`（Google Research）；论文 *Sigmoid Loss for Language Image Pre-Training*（**arXiv:2303.15343**，Zhai et al.）；首发仓库 <https://github.com/google-research/big_vision> |
| ⚠️ 模型卡性质 | 一手仓**没有官方模型卡**（README 自述 "The team releasing SigLIP did not write a model card"），现存README 由 HF 团队撰写 |

## 2. 许可（按 `../design/model-licensing-and-survey.md` §4 七项 + §3.1.1 四件）

| # | 证据项 | 结果 |
|---|--------|------|
| 1 | SPDX 许可 | **Apache-2.0** —— 在 §3.0 白名单内 ✅（一手仓 `google/siglip-base-patch16-224` 的 `cardData.license = "apache-2.0"`） |
| 2 | LICENSE 文件真在仓库内？**一手 ❌ / 分发 ❌** | 一手仓 `siblings` 共 **10 个文件**，**无 LICENSE**（`.gitattributes` / `README.md` / `config.json` / `model.safetensors` / `preprocessor_config.json` / `pytorch_model.bin` / `special_tokens_map.json` / `spiece.model` / `tokenizer.json` / `tokenizer_config.json`）；分发仓 `Xenova/siglip-base-patch16-224` 的 31 个文件里也**无 LICENSE** |
| 3 | 一手 or 二手 | **二手**：Xenova 从 PyTorch 转导出的 ONNX |
| 4 | 转换记录 / 可复现 | ❌ 分发仓未给转换脚本与源 `model.safetensors` 的哈希。**自转需装 PyTorch/transformers 级依赖**（数百 MB 至数 GB），与 `u2netp.md` §2 记的同一性质问题 |
| 5 | sha256 + 双源 | ✅ 见 §1，**双源逐字节一致**（`ffb4672d…72ffb2524`） |
| 6 | 本机 DirectML 跑通 | ✅ **见 §4，双后端均通过** |
| 7 | 归属 | 一手仓库 <https://github.com/google-research/big_vision>；arXiv:2303.15343；模型卡 `https://huggingface.co/google/siglip-base-patch16-224` |

**档位判定**：许可标识合规（Apache-2.0，在白名单内）+ LICENSE 文件本体找不到（一手与分发两处都缺）→ 按 2026-09-29 改判落 **「可用（附披露）」**；同一性靠 Xenova 担保 → 叠加一条 §6.1 四行记录。

### 已知限制（§6.1 四行格式）

```
缺口：        同一性——用的是 Xenova 转导出的 ONNX，无转换脚本、无源 safetensors 哈希；一手仓不附权重本体
谁担保：      Xenova（transformers.js 维护者，公开账号）
最坏后果：    零样本打标的准确率与官方 PyTorch 版有偏差——不是版权追责
复查触发条件：① 实际打标准确率明显低于预期；② 要把它升级成用户可见功能时；③ 上游换权重或仓库归档时
```

### §3.1.1 那四件留存的完成度

| 件 | 状态 |
|---|---|
| ① 查询方式与日期 | ✅ 2026-10-07，HF API `?blobs=true`（`hf-mirror.com`），结果原文见 §1/§2 |
| ② 文件清单原文 | ✅ **已贴**（一手仓 10 个文件全列；分发仓 `Xenova/siglip-base-patch16-224` 的 31 个 `.onnx` 也已枚举，见 §9 变更史） |
| ③ 标识出处 | ✅ 一手仓 `cardData.license = "apache-2.0"`；README 第 2 行 YAML frontmatter 亦写 `license: apache-2.0`。**两处独立一致**（README 自称，非平台核验值） |
| ④ 许可全文留存 | ✅ **无需新增文件**。上游一手仓 `google-research/big_vision` 的 `LICENSE` 经 `WebFetch` 取回确认为 **Apache-2.0 全文标准模板**（含 "END OF TERMS AND CONDITIONS" 与 APPENDIX），与本目录已留存的 `u2netp.apache-2.0.txt` / `modnet.apache-2.0.txt` **同为标准模板正文**（SHA-256 `c71d239d…f35d0ab4`，两仓上游都没填`Copyright [yyyy] [name]` 那一行）。**沿用已留存的那份即可**，理由：Apache-2.0 正文是同一份标准文本，抄第三份会产生无意义的重复副本 |

> **④ 为什么可以沿用**：规范 §3.1.1 第 ④ 件的目的是「既然不要求上游附 LICENSE，那这份全文就得由我们留存，否则 NOTICE 没内容可写」。本目录已有**同为 Apache-2.0 标准模板**的留存物在位，NOTICE 的内容来源已兑付，再存一份字节相同的文件不增加任何可核查性。

### 为什么只查了视觉塔、文本塔没动

零样本打标需要**图像塔 + 文本塔**（把标签文字编码成向量再和图像向量比）。本文只查了视觉塔，因为：

- 视觉塔是**模型的主体**（60 MB，含全部Transformer 结构），也是**DirectML 崩溃风险所在**（K2）—— 真机探针只需要它就能回答「跑不跑得通」；
- 文本塔（`text_model_q4.onnx`，60.7 MB）是标准 Transformer + 词表查表，**算子结构与视觉塔同构**，DirectML 风险性质相同、无新增风险类型；
- 但**它仍是未验项**，在真正做功能时必须一并实测（见 §5 未验项 1）。

**不许把「视觉塔跑通」说成「SigLIP 跑通」。**

## 3. 能力边界

- **它不是打标模型，是编码器。** 产出 768 维向量，**「这张图属于哪个标签」这一步还没做**——需要文本塔 + 余弦相似度 + 阈值。
- **零样本 ≠ 什么都认得。** 它认的是WebLi 语料里的概念。用它打「爷爷的生日」这类**具体到个人的标签**大概率失败——零样本的强项是通用概念（风景/动物/美食），不是私人语义。这一点必须写进界面文案，否则用户会以为它什么都能认。
- **标签体系的决定权在用户，不在模型。** 见 §2 开头那个 ⚠️ 与 Q11。
- 本模型**不做通用分割、不做人像抠图**，那些是 A8（u2netp / MODNet）的地盘。

## 4. 实测数字（开发机 RTX 5060 Laptop + AMD 610M，**不得当产品承诺**）

探针脚本 `C:\Users\ybd06\temp\siglip-probe\probe.cjs`（临时产物，未进仓库）。随机张量 `[1,3,224,224]`，**6 次取第 2–6 次的中位数**；CPU 侧按 D12 限 `intraOpNumThreads=2`。

| 日期 | 后端 | 加载 | 推理（首次 / 中位 / 最小 / 最大） | heapΔ |
|------|------|------|------------------------|-------|
| 2026-10-07 | **DirectML** | **645 ms** | 369 ms / **27 ms** / 26 ms / 28 ms | +0.6 MB |
| 2026-10-07 | **CPU（2 线程）** | 243 ms | 308 ms / **310 ms** / 272 ms / 340 ms | +0.2 MB |

**输出形态核对**（两后端一致）：`last_hidden_state` 实测值域 `[-24.99, 30.59]`（CPU 侧 `[-28.81, 26.96]`），**finite、非 NaN** —— 量化后没有数值崩坏。

### 三条结论

1. **DirectML 跑通了，且没有静默回落 CPU。** 依据：中位 27 ms vs CPU 310 ms，**11.5× 差距**。若DML 实际落到 CPU，两者数字应该接近。（⚠️ 但这是**推断**，不是直接证据——要彻底钉死仍依赖 `../design/gpu-self-probe.md` 第 0 步 P1「DirectML 到底选哪块卡从未验证」那个未结问题，见 §5 未验项 4。）
2. **CPU 兜底成立（K6）。** 310 ms 完全可用，**这是 SigLIP 相对 BiRefNet 那类模型的压倒性优势**（后者 CPU 侧 10 分钟不结束、吃 6.3 GB）。原因是量级：224² 输入 + base 规模 + 4bit 量化。
3. **K7 那条 60 秒体验线毫无压力**（最大 340 ms，余量两个数量级）。所以本条目**不因慢而出局**，可以考虑进清单。

## 5. 真图验收

**未做。** 本条目只完成了「模型能跑」，**没有验证「打标准不准」**。

- **未验项（不许当成已验）**：
  1. **文本塔未跑** —— §2 已说明，打标功能真正落地时必须一并实测。
  2. **真实照片上的零样本准确率未测** —— 需要文本塔 + 候选词表，目前两样都没有。
  3. **中文标签未验** —— §0 第 3 条说 SigLIP 中文预期更好，**这是我从训练语料推断的，没有实测支撑**。真要用中文标签做零样本，必须先拿中文词表实测。
  4. **DirectML 究竟跑在哪块卡未验** —— 4 个虚拟显示器（向日葵 / ToDesk / GameViewer）本机已实测枚举到，`2026-10-07` 已修`classifyAdapters`，但**「判定逻辑修对了」不等于「DML 选卡正确」**，仍阻塞在 `gpu-self-probe.md` 第 0 步 P1。
  5. **装机版端到端未跑** —— 只在纯 node 进程跑过，未经 Electron 推理子进程与真实 UI 链路（`verify:ai-child` 那条路）。
  6. **真实显存/内存峰值未测** —— 上表 `heapΔ` 是 Node 堆增量，**不是显存**。K3 那条`minVramMiB` 标定仍未做。

## 6. 与已有能力的关系

- 复用现有标签链路：产物是**标签**，走既有的 `XMP-ptm:Tags` 写入路径，**不新增产物形态**。
- **它是A17 相似检索的地基**（文档 §3A17「唯一正确技术路线」）。若这条走通，A17 / E3 连拍精选 / E4 找重复 / D1 NSFW / G5 地标 / K2 属性 / K3 事件类型 **全部受益**——这是「一次投入、多处受益」价值最高的一项。
- 与 A1 图像分类**不是替代关系**：A1 是封闭标签集的分类器（快、小、无需文本塔），A2/SigLIP 是开放词表的编码器。**封闭场景先走 A1**。

## 7. 待办

| # | 项 | 阻塞什么 |
|---|------|---------|
| 1 | **Q11 词表策略**（用已有标签当词表 vs 内置通用词表） | 阻塞**打标功能**本身。这是产品决策，文档记为 M3 阻塞项 |
| 2 | 下载并实测文本塔（`text_model_q4.onnx`，60.7 MB） | 阻塞打标功能；视觉塔跑通不能替代 |
| 3 | 定置信度阈值 + 候选词表设计 | 阻塞打标功能 |
| 4 | `capabilityCatalog` 增条目 + 补 `license` / `provenance` 字段 | 阻塞进清单。**注意 §5 待办⑤那条铁律：新增条目必须自带 `provenanceStatus` + §6.1 四行记录，豁免须逐条点名**（`tests/modelLicense.test.ts` 会红） |
| 5 | 留存文件沿用已存的那份 Apache-2.0 | ✅ 无需动作，见 §2 第 ④ 件 |
| 6 | 若最终选它，`NOTICE` 需加 SigLIP 条目（由 `scripts/gen-notice.cjs` 从清单生成，不手写） | 进清单时同步 |

## 8. 变更史

| 日期 | 事件 |
|---|---|
| 2026-10-07 | CLIP ViT-B/32 准入查证**失败**（一手仓无 SPDX 标识，按 §3.0 直接出局）→ 改选 SigLIP base-patch16-224。一手仓 Apache-2.0；双源各下一份 sha256 **逐字节一致**（`ffb4672d…`，本项目第二例）；**DirectML 645ms 加载 / 27 ms 推理、CPU 243ms / 310 ms 双后端实测通过**，11.5× 差距证明未静默回落 CPU。许可落「可用（附披露）」+ §6.1 四行记录。本条目**未进清单**（缺 Q11 词表决策、文本塔、准确率实测） |