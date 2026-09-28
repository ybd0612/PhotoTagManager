# 模型多源下载 + 网络代理设置（U7）——实施方案与交接记录

> 状态：**代码已改到一半，有 4 处测试未更新到新语义（见"当前红灯"）**。
> 本文件是权威交接记录：新会话从这里接续，不依赖对话历史。
> 最后更新：2026-09-28 晚。

## 一、目标（用户已拍板）

1. 模型下载源做成**统一的两源顺序**：`ModelScope → hf-mirror`，清单里每个模型只存一份仓库坐标。
2. 用户网络不通时，提示去设置里配代理；代理就是**填 IP:端口**，不做"自动/直连/自定义"三选。
3. 下载改走 Electron `net.fetch`（这样 `session.setProxy` 才管得住它）。

## 二、已实测的事实（直接采用，不要重新测）

| 事实 | 证据 |
|---|---|
| hf-mirror 直连超时，只有显式代理 127.0.0.1:7897 才通 | Node `fetch` 直连 10s 超时；`curl`（读了 shell 里的 `http_proxy`）0.29s 返回 200；`HTTPS_PROXY` 显式设置后 Node `fetch` 0.67s 返回 200 |
| **Electron `net.fetch` 也不自动跟随代理** | 对照实验（`temp/ptm-check/probe-netfetch.cjs`）：`net.fetch` 打 hf-mirror 同样 `ERR_TIMED_OUT`。所以"换 net.fetch 就自动解决"是错的，代理必须显式落到 `session.setProxy` |
| ModelScope 直连 200 / 346ms；下载 2.8 MB/s；支持 Range（206） | `temp/ptm-check` 各探针脚本 |
| ModelScope 按 HF 原名镜像，**只镜像热门仓库** | 命中：`onnx-community/BiRefNet_lite-ONNX`、`onnx-community/BiRefNet-ONNX`、`Xenova/clip-vit-base-patch32`、`Xenova/sam-vit-base`、`onnx-community/depth-anything-v2-small`；未命中：`BritishWerewolf/U-2-Netp`（M1 在用）、`Meeperomi/GFPGANv1.4-onnx`、8 个 u2net 替代名 |
| URL 格式 | `https://modelscope.cn/models/{repoId}/resolve/master/{filePath}`（hf-mirror 是 `/resolve/main/`） |
| Node 全局 `fetch` 不读 Windows 系统代理，只认 `HTTPS_PROXY` 环境变量 | 见上 |

## 三、已完成（代码在工作树，已做保存性提交）

| 文件 | 内容 |
|---|---|
| `electron/ai/modelSources.ts`（新） | 源顺序展开 `sourceTargets({repoId,filePath})`、域名白名单、失败分类（`not-found`/`unreachable`/`corrupt`/`cancelled`）、汇总成一句人话的 `describeDownloadFailure`（**先判连不上**，再判源上没有） |
| `electron/ai/capabilityCatalog.ts` | `ModelSpec.downloadUrl` → `repoId + filePath`；u2netp 标注了"ModelScope 无镜像、会降级" |
| `electron/ai/modelStore.ts` | `ModelDownloadSpec` 改仓库坐标；`download()` 按源顺序逐个试，失败分类逐源记录，全失败抛 `describeDownloadFailure`；sha 不一致记 `corrupt` 并换源；`TransferError` 携带类别；用户取消立即中断不换源 |
| `electron/main.ts` | `ModelStore` 注入 `net.fetch`；启动时读 settings.json 的 `ui.proxyRules` 并 `applyProxyRules`（`app.setName/setPath` 双钉 userData 那段在更早，别动） |
| `electron/ipc.ts` + `shared/types.ts` | `UiPrefs.proxyRules`（''=不覆盖）；`prefs:set` 用 `shared/proxyRule.ts` 校验，**不合法保留原值不落盘**，合法则写盘后立刻调 `deps.applyProxy` |
| `shared/proxyRule.ts`（新） | 校验：只收 `host:port`（可带 `http://` 前缀）；**拒绝带账号密码**（凭据会明文落盘）与 socks 等其它协议；留空=不覆盖（跟随系统默认），文案不要写成"直连" |
| `src/store/useAppStore.ts` | `proxyRules` 状态 + `setProxyRules` + 已补进 `loadUiPrefs` 逐字段列表 |
| `src/components/settings/SettingsDialog.tsx` | 常规分区新增「网络代理」行：显式点「应用」才保存；非法值就地说明；说明文案强调"只影响模型下载与检查更新，照片不出本机" |
| `scripts/check-sources.cjs`（新） | 清单里每个模型在两源的可用性检查；`--full` 两源各下全文算 sha256 并与清单比对。**快速模式只比大小，不等于内容一致** |

## 四、当前红灯（新会话第一件事）

`npx vitest run tests/ai/modelStore.test.ts tests/proxyRule.test.ts tests/settingsGeneral.test.tsx` 共 **7 处失败**：

1. `proxyRule.test`：`socks5://…` 没被拒成"只支持 http"。原因：scheme 正则 `^[a-zA-Z]+:\/\/` 不认带数字的 `socks5`。改成 `[a-zA-Z][a-zA-Z0-9+.-]*`。
2. `modelStore.test` 三条旧用例写死了"中断/校验失败 = 必须报错"，现在中断后会**换源成功**（这是新特性，且 sha 校验保证文件是对的）。要改的是断言语义：
   - 「禁止直接写最终文件名」→ 把 `truncateFirst` 从 1 改成 99（两个源都掐断），此时才应该 reject 且目录里只有 `.part`；
   - 「② 断点续传」→ 同样改成两源都掐断后再成功，并断言第二次请求带 Range；
   - 「⑤ status 三态」→ 同上；
   - 「③ sha256 不符」→ 消息口径改了（现在是"两个源的内容校验不通过…"），断言改 `/校验不通过/`，并补一条：换源后成功则不留坏文件。
3. `modelStore.test`「进度只报已收/总量」失败，且报错是"两个源上都没有这个模型仓库"——**这是未解之谜**：该用例用默认 fetch（不注入），ModelScope 对假仓库名应返回 404（not-found），hf-mirror 应超时（unreachable），汇总应该说"需要代理"；实际却进了 not-found 分支。**先查 `classifyFetchError` 对 vitest 里 hf-mirror 的失败到底分到哪类**（可能在测试环境 hf-mirror 返回了 404 而不是超时）。查清前不要改分类函数。
4. `settingsGeneral.test` 两条用 `getByLabelText('网络代理地址')` 的用例报 "does not have a value setter"——MUI 的 TextField 把 aria-label 挂在了别处。改用 `screen.getByRole('textbox', { name: '网络代理地址' })` 后用 `fireEvent.change`。

## 五、剩余步骤（按顺序）

1. 修上面 7 处红灯（第 3 条先取证再动手）。
2. `npx vitest run`（全量）+ `npm run typecheck` → 全绿。
3. `npm run build && npm run dist` → 出包；抽包断言：主进程含 `modelscope.cn`、`session.setProxy`、`连不上模型服务器`；渲染层含「网络代理」「应用」。
4. 真机验证两档：
   - 不设代理：抠图 → u2netp 应经 ModelScope 404 → 降级 hf-mirror **成功**（错误条不出现）；
   - 设置里填 `127.0.0.1:7897` 应用 → 删掉 `%APPDATA%\photo-tag-manager\models\u2netp\u2netp.onnx` 再抠 → 应经代理从 hf-mirror 下成功（日志有「网络代理：已启用」）。
   - 用 CDP 驱动的脚本在 `temp/ptm-check/`（`ptm-cut-run.cjs` / `ptm-roots.cjs` 可改）。
5. 文档回填本文件的"已完成"，并把 `settingsGeneral` 新用例与 U7 写进验收台账。
6. 提交（中文约定式，精确 add）。**push 与发布需用户单独授权。**

## 六、约束（新会话必须遵守）

- 全量测试只在收尾跑一次；中途只跑定向。
- 先提交后写报告；报告里"已验证/未验证"分开写，不许把"应该通了"写成"已验证"。
- 用普通人能读懂的话：不写"腿/棒/绊线/尺子/账本"这类词；说"对照检查""守卫检查""能失败的断言"。
- 用户数据目录 `%APPDATA%\photo-tag-manager` 是钉死的（U4），任何改动都要保住"升级不丢数据"这条。
- 代理地址涉及用户凭据：只收 host:port，带账号密码一律拒绝（`shared/proxyRule.ts` 已实现，别放宽）。

## 七、相关历史（本文件之前的批次 4/5/验收①–④ 都在同目录另一份 `2026-09-26-ui-functional-gaps.md`）

- U7 的发现过程：Node `fetch` 直连 hf-mirror 超时导致 7 条端到端用例跳过 → 查出"应用下载不读系统代理"。
- `disableDifferentialDownload`（U3）仍未决策：等更新器日志（U1 已接）跑出一次真实更新的证据再定。
