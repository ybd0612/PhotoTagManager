# 第三方许可留存（LICENSES/third-party）

这里是 `docs/design/model-licensing-and-survey.md` §3.1.1 第 ④ 件要求的**留存动作**：
清单里每个模型，其上游一手仓库的许可全文必须由我们自己抓下来存在这里——
镜像仓不附 LICENSE 文件本体不等于授权不存在，缺的只是这份留存。

取得日期：2026-09-30。取回后按字节原样写入，**不改动一个字符**（不换行风格、不加标题、不追加注释），
所以每个文件都可与上游仓库的 `LICENSE` 逐字节比对。属性与来源声明写在本文件，不写进许可正文。

## 文件清单

| 文件 | 对应模型 | 取源 | 字节 | SHA-256 |
|------|----------|------|------|---------|
| `u2netp.apache-2.0.txt` | U²-Netp | `https://api.github.com/repos/xuebinqin/U-2-Net/contents/LICENSE?ref=master` | 11357 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `modnet.apache-2.0.txt` | MODNet | `https://api.github.com/repos/ZHKKKe/MODNet/contents/LICENSE?ref=master` | 11357 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `apache-2.0.txt` | —（对照用基准文本） | `https://www.apache.org/licenses/LICENSE-2.0.txt` | 11358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |

两份上游文件**彼此逐字节相同**，且与 Apache 官方正文只差末尾一个换行符（11357 对 11358）。
两者的 `LICENSE` 都是不含具体版权人姓名的标准 Apache-2.0 模板正文——上游没有填写 `Copyright [yyyy] [name of copyright owner]`
那一行，**这不是我们的疏漏，也不是他们授权有瑕疵**；归属以下面两行为准，授权类型以该正文为准。

## 归属（Apache-2.0 第 4 条对再分发的硬性要求）

- **U²-Netp**：Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane, Martin Jagersand，
  *U²-Net: U-shape Convolutional Neural Network for Salient Object Detection*（CVPR 2020）。
  一手仓库 <https://github.com/xuebinqin/U-2-Net>（论文作者方，仅作出处与归属来源，不作分发来源）。
- **MODNet**：一手仓库 <https://github.com/ZHKKKe/MODNet>，
  *MODNet: Real-Time Trimap-Free Portrait Matting via Objective Decomposition*（AAAI 2020）。
  ⚠️ 作者名单未逐字核对原论文，本文件只声明一手仓库为归属来源，不代写作者姓名（见 `docs/models/modnet.md` 第 28 行的同一保留）。

## 必须一并读到的披露（§2 裁定三）

本项目 UI 里出现的这两个 ONNX 权重，**都不是上表一手作者自己发布的产物**：

- U²-Netp 的权重来自镜像仓 `BritishWerewolf/U-2-Netp`——**系第三方转导出，非上游一手发布**，无转换脚本、无源 `.pth` 标识、无转换日期。
  该缺口已于 2026-09-29 经用户裁定为「已知限制并明确接受」（见规范 §6.1 四行记录），最坏后果是抠图效果与作者版本不同，不是版权追责。
- MODNet 的权重来自模型卡 `Xenova/modnet`——一手仓 `ZHKKKe/MODNet` 全树只有 `LICENSE`、**没有任何权重文件**，
  因此一手仓无法作分发来源；本项目的 sha256 在 ModelScope 与 hf-mirror 两个源上逐字节一致。

权重本身**不在安装包里**：清单只引导用户从公开模型源（ModelScope 优先、hf-mirror 兜底）自行下载，并按上表的许可使用。

## 代码依赖不在这里列

React / Material UI / Electron / electron-builder / electron-updater / exiftool-vendored / onnxruntime-node 等
npm 依赖的许可正文，**随发行包内各自的 `node_modules/<包>/LICENSE` 一同分发**（实测 v0.1.5 安装包内有 98 份此类文件）。
把它们再抄一遍到本目录只会产生第二份可能过时的副本，与项目「同一事实只在一处」的口径相反，所以不抄。
`NOTICE` 里只列**模型**这类包内没有原始许可文件、且需要额外归属声明的对象。
