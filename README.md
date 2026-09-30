# 图片管家 PhotoTagManager

一款 Windows **本机图片管理工具**：把散落在下载目录、项目资料、移动硬盘和历史文件夹里的图片挂进来，就能浏览、搜索、打标、清理，并在本机做 AI 处理。标签直接写进图片文件自身的 XMP 元数据——**不搬文件、不建数据库**，图片被复制或移动后，标签跟着文件走。

> 中文显示名「图片管家」只用于界面；程序实体（安装目录、进程、快捷方式、exe 文件名）仍是 `PhotoTagManager`，配置文件夹是 `%APPDATA%\photo-tag-manager`。为什么这些标识不能跟着改名，见「发布与更新」的最后一条。

## 它是什么，不是什么

| | 说明 |
|---|---|
| **是** | 面向**已有文件**的图片浏览、查找、整理和轻处理工具。应用重新扫描任何目录，就能重新读出图片携带的标签。 |
| **不是** | 不替用户重新安排文件位置——不提供移动、重命名、按相册归档这类操作；不建"每张图片一条记录"的中心数据库；不上传照片，也没有任何云同步。 |
| **边界** | 唯一会碰像素的动作是 AI 处理，而它的产物是**新文件**（`原名.cutout.png`），原图字节始终不变。删除动作只做"移到系统回收站"，不做物理删除。 |

## 核心原则：文件是主数据，应用是管理界面

不把图片复制进应用专属仓库，也不为每张图片建一条必须长期维护的记录，而是把分类信息写进文件自身的 XMP 元数据：

- **先发现，再整理**：添加若干目录作为扫描根，应用递归扫描，只展示实际包含图片的目录。
- **标签跟随文件**：分类标签和图片一起保存，复制、备份、移动、重命名后仍在。
- **不依赖稳定文件身份**：绝对路径、文件名和哈希都不作为跨会话业务主键，只用于本次扫描、展示和访问文件。
- **配置与图片数据分离**：根目录别名、隐藏目录、缩略图缓存、AI 模型偏好属于本机使用偏好，存在应用配置里；标签属于文件自身元数据。
- **按需读取标签**：扫描阶段只做文件发现和目录构建，浏览到图片时才读 XMP，避免大批量扫描被元数据读取拖慢。

## 功能

### 浏览

- **多根目录 + 别名**：可添加多个图片根（如 A 目录起名「照片」、B 目录起名「资料」），根列表持久化，重启自动恢复
- **自动扫描**：启动后自动扫描全部根目录（优先选中根，其余串行后台扫），扫描中可随时取消，懒加载不打断浏览
- **目录树**：只显示含图片的目录；右键可隐藏/恢复（支持整个子树全部恢复与逐项恢复）、在资源管理器中打开；悬浮显示完整名称
- **缩略图网格**：虚拟滚动、列宽自适应，小/中/大三档（与设置里同一个开关），GIF/WebP 直接原图预览
- **大图预览**：滚轮缩放（光标为中心）、拖动平移、双击还原、`←/→` 翻页、`Ctrl+C` 把文件复制到剪贴板、双色显示绝对路径
- **界面细节**：顶栏由应用自绘（与原生标题栏无色差）、左栏可折叠（`Ctrl + B`，折叠后当前目录仍在顶栏）、系统托盘常驻

### 整理

- **打标**：预览中增删标签、`Ctrl` 多选后批量添加，全部直接写回源文件 XMP
- **标签治理**：「标签管理」面板列出全量已用标签与计数，支持**重命名/合并**——把原标签在所有图片的 XMP 中替换为目标标签
- **找图**：常用标签（按当前目录上下文统计）+ 高级筛选全量列表 + AND/OR 组合，再叠加**文件名搜索**与**名称/时间/大小排序**（升/降序），三段管道依次过滤
- **清理**：右键或批量「移到回收站」，走系统回收站可找回、一次显式确认；主进程只放行落在已添加根目录内的路径，越界逐条拒绝并给原因

### 处理（本机 AI）

预览大图时点底栏「人像抠图」即可对本机照片做处理：结果先进 `userData/ai-preview` 暂存，在棋盘格底纹上**按住空格对比**确认，点「保存」才落到原图旁边生成 `原名.cutout.png`（同名顺延 `.cutout.2.png`），并自动继承原图标签 + 追加行为标签 `AI人像抠图`，可一键筛出所有 AI 产物。

- **全程本机**：推理用 `onnxruntime-node` 的 DirectML 后端，跑在独立的 `utilityProcess` 子进程，照片内容不出机器
- **模型清单**：当前两个候选，`U²-Netp`（默认，约 4.4MB）与 `MODNet`（约 24.7MB）；**模型下载/卸载/删除/设为唯一的默认项全部在预览底栏那个下拉里**，设置页不重复提供，避免两处状态打架
- **下载源**：按固定优先级先 ModelScope 再 hf-mirror（实测本机 ModelScope 直连更快，hf-mirror 需走代理）；首次下载前一次性告知体积与粗估时长，每次尝试的来源与 HTTP 状态都有日志
- **代理**：设置「常规」里的网络代理只影响「模型下载」与「检查更新」两件事，不支持带账号密码的地址（那会明文落进配置文件）
- **缓存**：暂存即缓存，键为五元组（原图指纹 : 模型指纹 : 输入尺寸 : 后处理参数 : 预处理管线版本），同图同模型再点一次秒出预览；改动原图或递增管线版本都会失效重跑
- **暂存回收**：按保留天数与总量上限双条件 LRU 淘汰，删除前校验路径确在暂存目录内；已保存的成果不受影响
- **可拓展**：行为→模型→运行时三层分离，加模型只改清单数据，加行为只加清单条目 + 一个后处理函数
- **当前只有「人像抠图」一个行为**。U²-Netp 与 MODNet 都是人像 matting 模型：非人像照片**允许选错主体**（不会崩溃，界面也不承诺"去除任意背景"）。掩码在 320×320 上计算，分屏看右侧结果必然偏软，界面已注明。通用抠图、智能打标、批量处理、后处理参数调节尚未实装。

### 交付与维护

- **自动更新**：应用启动时静默检查，也可在设置「关于与更新」分区手动检查；发现新版本后展示下载进度，下载完成可一键重启安装
- **开源与作者**：设置「关于与更新」分区提供 GitHub 仓库和作者网站 `https://yangbang.de`，点击后经系统默认浏览器打开
- **许可**：MIT License

## 支持的图片格式

JPG / JPEG / PNG / WebP / GIF / BMP / TIFF / HEIC / HEIF / RAW / CR2 / CR3 / NEF / ARW / DNG / ORF / RW2（扩展名白名单见 `shared/imageExt.ts`，元数据读写经 exiftool-vendored）。

## 典型工作流

```text
添加目录 → 递归发现图片 → 展示含图片的目录树 → 浏览 / 搜索 / 筛选
                                          ↓
                             增删标签并写回原图片 XMP
                                          ↓
                （可选）预览里点「人像抠图」→ 对比确认 → 存为派生文件
                                          ↓
                    文件带着标签进入复制、备份和其他目录
```

## 技术栈

Electron + React 18（Vite + MUI + Tailwind CSS）+ exiftool-vendored + sharp + onnxruntime-node（DirectML）+ zustand + react-window + electron-updater + electron-log + vitest

## 快速开始

```bash
npm install        # 安装依赖（electron / exiftool 二进制下载较慢，失败可重试）
npm run dev        # 启动应用（dev server 端口 51783）
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（HMR），端口 **51783**（非默认，冲突时直接报错） |
| `npm run build` | 三端构建（main/preload/renderer + scanWorker） |
| `npm run start` | 预览构建产物 |
| `npm run app:go` | 本机看效果一条龙：杀掉运行中的实例 → 构建 → 打 `win-unpacked` → 自动启动 |
| `npm run typecheck` | TypeScript 全量类型检查（node + web 两套工程） |
| `npm run test` | Vitest 单元与集成测试 |
| `npm run dist` | electron-builder 打包 NSIS 安装包（输出到 `dist/`，同时生成 `latest.yml` 供自动更新） |

## 标签存储设计

| 项 | 说明 |
|---|---|
| 存储位置 | 图片源文件 XMP 的 **`XMP-ptm:Tags`**（自定义命名空间，JSON 数组） |
| Windows 表现 | 属性面板"标记"不显示（普通图片与 GIF 一致，属有意设计） |
| 第三方兼容 | Lightroom 等不识别 `ptm` 命名空间 → 标签仅应用内可见 |
| 旧数据迁移 | 读取兼容旧 `dc:subject`；写入新标签时自动清空旧字段（渐进迁移） |
| 配置文件 | 首次运行自动生成 `userData/exiftool-config/.ExifTool_config`，经 `EXIFTOOL_HOME` 自动加载 |

## 架构要点

- **四个执行体**：主进程（窗口 / IPC 路由 / 文件系统 / XMP / 缩略图 / 回收站 / 持久化 / 代理 / 更新）、Worker 线程（目录扫描，批推送）、AI 推理子进程（`utilityProcess`，ONNX DirectML，崩溃不影响主界面）、渲染进程（React UI + zustand）
- **多根隔离**：roots / treesByRoot / imagesByDir / scanStatsByRoot / hiddenSet 均按 `rootId` 分桶，复合 key = `${rootId}\u0000${relPath}`
- **IPC 命名**：`域:动作`（kebab-case），统一响应信封 `IpcResult`；通道按域分为 roots / scan / folder / file / tags / thumb / image / prefs / ai / update / dialog / clipboard / shell / app
- **缩略图缓存**：`userData/thumbnails/{sha1(absPath:mtimeMs:size)}.jpg`
- **持久化**：根列表 `roots.json`、隐藏目录 `hiddenFolders.json`（按根隔离）、偏好 `settings.json`
- **安全模型**：`contextIsolation: true, nodeIntegration: false`，preload 仅暴露白名单 `window.api`；写盘类通道（回收站）在主进程按根目录白名单守卫

## 目录结构

```
electron/                主进程（main / preload / ipc / services / ai）
shared/                  跨进程共享（types.ts / imageExt.ts / proxyRule.ts）
src/                     渲染进程（components / hooks / store / api / utils）
tests/                   单元测试、渲染冒烟与 AI 集成测试
scripts/                 图标生成、CDP 取证、构建后补写 app-update.yml 等辅助脚本
docs/                    PRD.md / ARCHITECTURE.md / design 设计决策 / models 模型台账 / plans 实施计划
```

## 发布与更新

- **发版流程**：本地打包后手动建 Release（不再由 GitHub Actions 自动发版，2026-09-29 起）：

  ```bash
  npm run build && npm run dist        # 产出 dist/PhotoTagManager-<version>-x64.exe + .blockmap + latest.yml
  gh release create v<version> \
    dist/PhotoTagManager-<version>-x64.exe \
    dist/PhotoTagManager-<version>-x64.exe.blockmap \
    dist/latest.yml \
    --title "PhotoTagManager v<version>" --notes "<人写的更新说明>"
  git tag v<version> && git push origin v<version>
  ```

  **三个资产必须齐全**：`latest.yml` 是自动更新的清单入口，缺它装机版就查不到新版本；`exe` 是安装包本体，`.blockmap` 供差分下载。`npm run dist` 已固定带 `--publish never`，electron-builder 自己不会去建 Release。`package.json` 的 `build.publish` 仍保留 github 坐标——它同时是装机版 `resources/app-update.yml`（更新源）的唯一来源，改动前先跑一次 `npm run dist` 确认该文件还在。`npm run app:go` 用的是 `--win dir`，这个目标不写 `app-update.yml`，脚本第③.5 步会用 `scripts/write-app-update-yml.cjs` 按同一口径补写，所以从 `dist/win-unpacked` 跑的副本也能自查更新。

- **不要改的标识符**：`package.json` 的 `name`（`photo-tag-manager`）被 `electron/userDataDir.ts` 钉为 userData 目录名；`build.productName` / `appId` / `nsis.shortcutName` / `artifactName` / `publish.repo` 分别决定安装目录、注册表卸载项、快捷方式、安装包文件名和更新源地址。改动其中任何一个，老用户看到的就是"根目录和已下载模型凭空消失"或更新链路断裂——真要改名，得连数据目录迁移和更新链路一起做。
- **当前版本**：`0.1.5`（以 `package.json` 为准，v0.1.5 的 Release 已于 2026-09-29 发布）。

## 测试

```bash
npm run typecheck   # 0 错误
npm run test        # 35 个测试文件 / 397 用例通过（2026-09-30 实测）
```

覆盖范围：Worker 扫描统计、多根持久化、XMP 自定义命名空间读写、目录树与回收站守卫、标签筛选与排序管道、渲染冒烟与界面行为用例、AI 能力清单与模型仓库坐标、CPU 限核实测、人像抠图端到端（真下载 / 真 DirectML / 真 exiftool）。

## 已知限制

1. **程序名与界面中文名不一致**：界面叫「图片管家」，而安装目录、进程、配置文件夹和 exe 文件名是 `PhotoTagManager`（配置文件夹实际取 `package.json` 的 `photo-tag-manager`）。这是有意冻结的——改名代价见「发布与更新」最后一条，设置「关于与更新」分区里也向用户说明了这一点。
2. **`ptm` 命名空间仅本应用识别**：其他图片软件与 Windows 属性面板不会显示这些标签（有意为之）。
3. **部分 RAW/HEIC 写回 XMP 可能不被 exiftool 支持** → 返回错误提示，不阻塞队列。
4. **人像抠图只保证"人像"**：非人像照片允许选错主体；真机验收清单见 `docs/plans/2026-09-23-portrait-cutout-m1.md`。
5. `electron-builder` 为开发依赖，`electron-updater` 随应用运行时打包；首次 `npm install` 或 `npm run dist` 前需先装好依赖，首次打包会联网下载打包工具链，耗时较长。
