# 模型多源下载 + 网络代理设置（U7）——实施方案与交接记录

> 状态：**代码、全量自动验证、打包与真机验证全部完成；2026-09-29 来源级诊断日志已补上并从真机日志闭环（见《已验证》末段）。**
> 本文件是权威交接记录：新会话从这里接续，不依赖对话历史。
> 最后更新：2026-09-29 上午。

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

## 三、已完成（代码实现）

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

## 四、已解决的定向测试失败

本轮复现后确认最初输出为 **8 项失败**（交接记录中的“7 处”合并列了 MUI 两条输入用例）：

1. `shared/proxyRule.ts` scheme 正则补充数字、`+.-`，使 `socks5://...` 按“不支持的协议”拒绝；凭据拒绝规则未放宽。
2. `tests/ai/modelStore.test.ts` 更新源切换语义：两源中断时验证最终文件名不会出现；续传用例中两源各中断一次，第三次请求断言带 Range；状态三态同样验证双源失败时回到 absent；sha 错误消息断言改为“校验不通过”，另加首源内容错误、次源校验正确时只留下最终模型文件。
3. “进度只报已收/总量”用例的失败原因已取证：测试假仓库对 **ModelScope 和 hf-mirror 均返回 HTTP 404**，所以汇总成仓库不存在符合实现规则。该用例改为注入本地服务器，不改 `classifyFetchError`。
4. `SettingsDialog` 将 aria-label 传给 MUI `TextField` 的实际 input；测试使用 `getByRole('textbox', { name: '网络代理地址' })` 后触发 change。
5. `tests/ai/cutoutE2E.integration.test.ts` 的出站域名允许列表增加 `modelscope.cn`，同步新的首选源。

定向测试收尾结果：3 个指定测试文件 **31 项全绿**。

## 五、验证结果

### 已验证

- 指定定向测试：`tests/ai/modelStore.test.ts`、`tests/proxyRule.test.ts`、`tests/settingsGeneral.test.tsx`，**31 项通过**。
- 收尾全量：`npx vitest run`，**34 个文件 / 366 项通过**；本轮只在收尾执行一次全量。
- `npm run typecheck`：通过，0 错。
- `npm run build`、`npm run dist`：均 exit 0，生成 `dist/win-unpacked` 与 NSIS 安装包。
- 安装包 `resources/app.asar` 抽查五项全 PASS：主进程含 `modelscope.cn`、`setProxy`、`连不上模型服务器`；渲染层含「网络代理」「应用」。
- 真机运行 `dist/win-unpacked/PhotoTagManager.exe --remote-debugging-port=9223`。首次直接把参数交给 exe 会因当前 shell 环境变量 `ELECTRON_RUN_AS_NODE=1` 报 `bad option`；清除此继承变量后用已有 `scripts/cdp-up.cjs` 成功启动，端口可用。用户数据仍在 `%APPDATA%\photo-tag-manager`，没有更改路径。为校准脚本，临时修正了 `C:\Users\ybd06\temp\ptm-check\ptm-cut-run.cjs` 的抠图按钮查找条件，让它识别 aria-label 为「抠图」的 MUI 按钮；该调试脚本不属于仓库文件。
- **无代理档：**设置未覆盖代理（日志「网络代理：跟随系统默认（本应用未覆盖）」），先备份并删除原模型缓存，再经 CDP 抠图；观察到结果出现、忙碌状态结束、错误条为空。随后模型文件重新出现，大小 4,574,861 字节，SHA-256 为 `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`，与删除前备份相同。
- **代理设置档：**设置界面填写并应用 `127.0.0.1:7897`；`settings.json` 读回相同值，`main.log` 有「网络代理：已启用 127.0.0.1:7897」。再次删除前与备份核对 SHA-256；删除后经 CDP 抠图，结果出现、忙碌状态结束、错误条为空。模型文件重新生成，大小与 SHA-256 均与清单和备份一致。
- 原模型副本保存在 `C:\Users\ybd06\temp\ptm-check\u2netp.before-u7-proxy.onnx`。删除操作仅针对上述模型缓存，照片、标签与用户数据目录没有迁移或删除。
- **2026-09-29 来源级诊断日志闭环（提交 `22d52e6`）**：`ModelStore` 构造注入 `logger`（主进程接 electron-log），每次源尝试记「请求行（来源 + 完整 URL，续传时带 Range）」「HTTP 状态行」「连接失败行（类别 + 原因）」，最终成功行点名交付来源。定向测试 `tests/ai/modelStore.test.ts` 15 项通过，其中新增用例断言"首源 404 → 次源成功"时逐源各留一行且顺序可见；两源都连不上、两源都 404 两种情况日志里同样不会出现成功行（前一条即该反例）。
- **真机证据**：代理仍为 `127.0.0.1:7897`（TCP 实测可达），备份 `%APPDATA%\photo-tag-manager\models\u2netp\u2netp.onnx` 并核对 SHA-256 后删除，`npm run cdp:up` 起 win-unpacked、CDP 对未处理过的照片触发抠图（耗时 25.3 秒，结果出现、错误条为空），`main.log` 新增五条：
  `09:44:28.421 模型下载：source=modelscope 请求 https://modelscope.cn/models/BritishWerewolf/U-2-Netp/resolve/master/onnx/model.onnx` →
  `09:44:28.610 source=modelscope HTTP 404` →
  `09:44:28.612 source=hf-mirror 请求 https://hf-mirror.com/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx` →
  `09:44:33.279 source=hf-mirror HTTP 200` →
  `09:44:51.316 source=hf-mirror 成功（校验通过，字节=4574861）`。重新下载的模型 SHA-256 与删除前备份一致（`309c8469…f4ddd8`）。
- **一条坑（重跑真机下载验证前必读）**：预览缓存判断在模型状态检查**之前**（`aiService.ts:553` 命中即返回，不走下载）。同一张图只要以前处理过，删掉模型也测不出下载——本轮前两次触发（卡片 0、7）都是这么空跑的，必须选没处理过的照片。

### 未验证 / 证据边界

> 2026-09-29 修订：本节记录的是 09-28 当时的证据边界，正文保留不改写。其中"日志没有逐源请求轨迹"的缺口已由来源级诊断日志补上并从真机闭环，见《已验证》末段。

- 生产日志目前只记代理启用，没有记录每次请求 URL / HTTP 状态。因此两档抠图成功已实测，但“ModelScope 返回 404 后具体从 hf-mirror 成功”的真机源级顺序**未从运行日志直接证实**。顺序有源码实现与自动用例覆盖，不把它冒称真机日志已验证。
- 代理档成功发生在代理已应用、缓存删除后；因日志没有每个源的请求轨迹，不宣称单凭当前日志能确认下载请求具体走 hf-mirror。模型 SHA-256 与清单一致、UI 无错误条为已验证。

## 六、功能与代码层面的完成状态

### 功能层面

**已完成并有证据：**

- 用户可以在「设置 → 常规」配置模型下载代理；留空表示本应用不覆盖系统代理。代理地址只接受 `host:port`（可带 `http://`），拒绝账号密码和其他协议；点击「应用」后保存并立即应用。
- 模型下载按 `ModelScope → hf-mirror` 顺序尝试；下载失败或 SHA-256 不符时继续尝试下一源，完整性校验通过后才登记为可用模型；取消下载不继续换源。
- 下载使用 Electron 网络栈，代理由 `session.setProxy` 应用。网络不可达时，界面提示用户可在设置中配置代理。
- 真机不覆盖代理与应用 `127.0.0.1:7897` 两档都完成过抠图；结果出现、错误条为空，模型文件重新生成且 SHA-256 与清单一致。
- 用户数据目录仍为 `%APPDATA%\photo-tag-manager`。验证时只操作模型缓存文件，先做了哈希一致的备份；照片、标签及其他用户数据没有迁移或删除。

**尚未由真机证据闭环的功能验收：**

- ~~尚不能证明某一次真机下载确实经历了「ModelScope 返回 404 → hf-mirror 下载成功」~~ → **2026-09-29 已闭环**：来源级诊断日志实装（`22d52e6`）后真机触发一次真实下载，`main.log` 逐源五条齐全（modelscope 404 → hf-mirror 200 → 校验通过），见《已验证》末段。U7 至此无已知未闭环项。

### 代码层面

**已完成：**

- 双源 URL 展开、固定顺序、失败分类与错误汇总；`ModelStore` 的逐源下载、断点续传、SHA-256 校验、坏文件清理与取消处理。
- 代理地址校验、设置持久化、启动时读取、设置页显式应用，以及将代理配置应用到 Electron session；用户数据目录路径保持固定。
- 对应的单元/组件/集成测试更新，以及安装包内容检查。历史收尾记录为：定向测试 31 项通过；全量测试 34 个文件 / 366 项通过；`typecheck`、`build`、`dist` 通过；安装包五项断言通过。
- 本轮代码和验收记录已提交于 `acfefff`（`fix(ai): 完成 U7 模型多源下载与代理验证`）。未 push、未发布。

**尚未完成的代码工作：**

- 当前没有未完成的 U7 实现或已知失败的自动化检查。~~主进程尚未记录每个模型源的请求 URL/来源标识及 HTTP 状态~~ → **2026-09-29 已实装并提交（`22d52e6`）**，真机日志闭环见《已验证》末段。
- 未 push、未发布。若要让装机版用户获得本笔日志与 U7 全部改动，需发 0.1.5（bump、出包、推提交、建 release），属对外动作，逐步需用户确认（见验收④）。

## 七、约束（新会话必须遵守）

- 全量测试只在收尾跑一次；中途只跑定向。
- 先提交后写报告；报告里"已验证/未验证"分开写，不许把"应该通了"写成"已验证"。
- 文档和交接使用直白说法，例如"对照检查""守卫检查""能失败的断言"。
- 用户数据目录 `%APPDATA%\photo-tag-manager` 是钉死的（U4），任何改动都要保住"升级不丢数据"这条。
- 代理地址涉及用户凭据：只收 host:port，带账号密码一律拒绝（`shared/proxyRule.ts` 已实现，别放宽）。

## 八、相关历史（本文件之前的批次 4/5/验收①–④ 都在同目录另一份 `2026-09-26-ui-functional-gaps.md`）

- U7 的发现过程：Node `fetch` 直连 hf-mirror 超时导致 7 条端到端用例跳过 → 查出"应用下载不读系统代理"。
- `disableDifferentialDownload`（U3）仍未决策：等更新器日志（U1 已接）跑出一次真实更新的证据再定。
- **2026-09-29 复查**：`main.log` 最新两次启动（09-28 21:57、09-29 09:41）均为「已是最新版本（0.1.4）」，没有发生过任何真实下载，也没有 `Cannot download differentially` 回退记录 → **差分回退证据仍为空，取值维持不动**。唯一可得证据的场景已排入验收④：发 0.1.5 后让装机版 0.1.4 真机走一次更新器下载，看 `main.log` 是否出现该句，再定 `disableDifferentialDownload` 并把结论写进代码注释。
- **2026-09-29 晚些时候结案（上面那条"维持不动"已失效）**：v0.1.5 发布后装机版真机走了更新器下载，用户观察到进度 89% 归零 → 回退确实发生。根因是 updater 缓存里 08-20 留下的旧 `current.blockmap`（4486 块）与拿来当旧包的 `installer.exe`（0.1.4，真块数 5795）不配对，起因是 0.1.4 手动覆盖安装绕过了更新器的缓存刷新。**定案：`disableDifferentialDownload = false`（保留差分）**——两版 blockmap 仅 902/5798 块不同，差分约 18 MB 对比整包 115.8 MB。取证数字、源码行号、缓存自愈与反证实验全部记在 `2026-09-26-ui-functional-gaps.md` 的《U3 定案（2026-09-29）》一节。
