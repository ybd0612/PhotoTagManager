# 第三方许可留存（历史审计资料）

本目录保存此前评估过的 U²-Netp 与 MODNet 模型许可正文及其来源记录，供历史合规审计和决策追溯。

**当前产品不提供模型推理、模型下载或人像抠图功能；本目录中的许可留存不表示当前安装包分发模型权重，也不表示应用仍会引导用户下载这些权重。**

## 留存内容

| 文件 | 说明 |
|---|---|
| `u2netp.apache-2.0.txt` | U²-Net 上游仓库 Apache-2.0 许可正文留存副本 |
| `modnet.apache-2.0.txt` | MODNet 上游仓库 Apache-2.0 许可正文留存副本 |
| `apache-2.0.txt` | Apache-2.0 官方正文对照文本 |

逐模型来源、曾用模型权重的分发路径和实测信息属于历史记录，见 `docs/models/u2netp.md`、`docs/models/modnet.md` 及 `docs/design/model-licensing-and-survey.md`。这些资料不属于当前运行时模型清单。

## 当前发行包

当前发行包不包含 `LICENSES/third-party/` 历史模型许可目录。项目依赖各自保持原始许可；根目录 `NOTICE` 汇总当前依赖许可口径，根目录 `LICENSE` 是本项目自身的 MIT License。
