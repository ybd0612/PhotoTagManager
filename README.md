# PhotoTagManager

基于 Electron 的 Windows 桌面图片 XMP 标签管理工具：多图库根目录 + 别名分组、自动扫描、标签直接写入图片源文件（自定义 XMP 命名空间）、常用标签筛选、批量打标、大图缩放预览。

> 标签以 XMP 元数据**内嵌在图片文件本身**（无独立数据库），但使用自定义命名空间 `XMP-ptm:Tags`——Windows 资源管理器属性面板的"标记"不会显示，标签仅在本应用内可见。

## 设计思想

### 要解决的问题

电脑上的图片通常分散在下载目录、项目资料、移动硬盘和历史文件夹中。用户首先需要知道“哪些目录里有图片”，然后才能按主题、用途或项目进行整理；如果采用传统的文件管理系统，为每个文件建立一条数据库记录，就必须持续维护文件路径、文件名、哈希值与数据库记录之间的对应关系。文件被移动、重命名、复制或备份后，外部记录容易失效，也会增加数据迁移和一致性维护成本。

### 核心原则：文件是主数据，应用是管理界面

PhotoTagManager 不把图片复制到应用专属仓库，也不为每张图片建立一条必须长期维护的数据库记录，而是把分类信息直接写入图片文件的 XMP 元数据中：

- **先发现，再整理**：用户添加若干目录作为扫描根目录，应用递归扫描并只展示实际包含图片的目录。
- **标签跟随文件**：分类标签和图片一起保存。图片被复制、备份、移动或重命名后，标签仍保留在文件中。
- **不依赖稳定文件身份**：应用不把绝对路径、文件名或哈希值作为跨会话的业务主键；路径和文件名只用于本次扫描、展示和访问文件。
- **应用配置与图片数据分离**：根目录别名、隐藏目录、缩略图缓存等属于本机使用偏好，保存在应用配置中；图片标签属于文件自身元数据，不依赖这些本机配置。
- **按需读取标签**：扫描阶段优先完成文件发现和目录构建，浏览图片时再读取 XMP 标签，避免扫描大量图片时被元数据读取拖慢。

### 典型工作流

```text
添加目录 → 递归发现图片 → 展示含图片的目录树 → 浏览/筛选图片
                                           ↓
                              添加或删除标签并写回原图片 XMP
                                           ↓
                         文件带着标签进入复制、备份和其他目录
```

### 设计取舍与边界

| 取舍 | 说明 |
|---|---|
| 不建“每文件一条记录”的中心数据库 | 减少路径、文件名、哈希变化带来的关联维护；标签统计和筛选基于当前扫描到的文件计算 |
| 标签写入原文件 | 文件迁移性更好，但写入会修改文件元数据；对重要图片建议先备份 |
| 使用自定义 `XMP-ptm:Tags` | 标签由本应用稳定识别，不依赖 Windows 属性面板；代价是其他软件通常不会显示该字段 |
| 应用仍保留本地配置 | 目录别名、隐藏目录和缩略图缓存不是图片分类数据；换电脑后需要重新添加扫描根目录 |
| 文件移动后需要重新扫描 | 标签不会丢失，但应用需要在新的扫描根目录中重新发现文件；当前版本不承诺自动追踪目录外的移动 |

因此，本项目不是“替用户重新管理文件位置”的文件管理器，而是一个**面向已有文件的图片发现、浏览和文件内标签管理工具**。应用可以重新扫描任何目录，重新读出图片中携带的标签；文件本身才是分类信息的长期载体。

## 功能特性

- **多根目录 + 别名**：可添加多个图片根目录（如 A 目录起名「照片」、B 目录起名「资料」），根列表持久化，重启自动恢复
- **自动扫描**：启动后自动扫描全部根目录（优先选中根，其余串行后台扫），懒加载不打断浏览
- **目录树**：仅显示含图片的目录，右键支持隐藏/恢复、在资源管理器中打开
- **标签管理**：预览中增删标签、Ctrl 多选后批量添加标签，全部直接写回源文件 XMP
- **标签筛选**：常用标签（按当前目录上下文统计）+ 高级筛选 + AND/OR 组合
- **缩略图网格**：虚拟滚动、列宽自适应、GIF/WebP 直接原图预览
- **大图预览**：滚轮缩放（光标为中心）、拖动平移、双击还原、Ctrl+C 复制文件、双色绝对路径显示
- **关于与外部链接**：关于页提供 GitHub 仓库和作者网站，点击后通过系统默认浏览器打开
- **性能**：Worker 线程扫描、exiftool 串行队列、缩略图磁盘缓存、按需读取标签

## 技术栈

Electron + React 18（Vite + MUI + Tailwind CSS）+ exiftool-vendored + zustand + react-window + vitest

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
| `npm run typecheck` | TypeScript 全量类型检查（node + web 两套工程） |
| `npm run test` | Vitest 单元测试（worker 统计 / 持久化 / XMP 读写 / 渲染冒烟） |
| `npm run dist` | electron-builder 打包 NSIS 安装包（输出到 `dist/`，同时生成 `latest.yml` 供自动更新） |

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

- **更新渠道**：`electron-updater` 读取 GitHub Releases（`publish` 配置为 github 源），应用**启动时静默检查** + 顶栏「检查更新」**手动检查**；发现新版本后下载进度条展示，下载完成可一键重启安装。
- **当前版本**：`0.1.5`（`package.json` 为准，v0.1.5 的 Release 已于 2026-09-29 发布），关于页显示中文产品名、GitHub 仓库和作者网站 `https://yangbang.de`，版本号从 `package.json` 自动同步。

- **本地打包**：也可在本机执行 `npm run dist` 生成安装包（首次打包会自动下载 electron 发行版与 NSIS 工具链，需联网）。

## 使用流程

1. 点击「添加根目录」→ 选择图片文件夹（自动起别名，可改）；可添加多个根
2. 启动后自动扫描所有根（第一个优先），左侧根列表显示扫描状态（黄点 = 扫描中）
3. 左侧目录树仅显示「递归含 ≥1 张图片」的目录；右键可隐藏/恢复、在资源管理器中打开；悬浮显示完整名称
4. 点击目录 → 右侧显示该目录（含子目录）图片网格；顶栏显示当前选中目录绝对路径
5. 单击图片 → 全屏预览：滚轮缩放、拖动平移、双击还原、`←/→` 翻页、`Esc` 关闭、`Ctrl+C` 复制文件
6. 预览中可添加/删除标签（立即写回 XMP）；`Ctrl` + 单击多选图片后，顶部操作条可**批量添加标签**
7. 标签筛选：常用标签（随选中目录变化）+「更多标签…」全量列表 + AND/OR 组合

## 标签存储设计

| 项 | 说明 |
|---|---|
| 存储位置 | 图片源文件 XMP 的 **`XMP-ptm:Tags`**（自定义命名空间，JSON 数组） |
| Windows 表现 | 属性面板"标记"不显示（普通图片与 GIF 一致，属有意设计） |
| 第三方兼容 | Lightroom 等不识别 `ptm` 命名空间 → 标签仅应用内可见 |
| 旧数据迁移 | 读取兼容旧 `dc:subject`；写入新标签时自动清空旧字段（渐进迁移） |
| 配置文件 | 首次运行自动生成 `userData/exiftool-config/.ExifTool_config`，经 `EXIFTOOL_HOME` 自动加载 |

## 架构要点

- **三进程**：主进程（IPC / 文件系统 / XMP / 缩略图 / 持久化）、Worker 线程（目录扫描，批推送）、渲染进程（React UI + zustand）
- **多根隔离**：roots/treesByRoot/imagesByDir/scanStatsByRoot/hiddenSet 均按 `rootId` 分桶，复合 key = `${rootId}\u0000${relPath}`
- **IPC 命名**：`域:动作`（kebab-case），统一响应信封 `IpcResult`
- **缩略图缓存**：`userData/thumbnails/{sha1(absPath:mtimeMs:size)}.jpg`
- **持久化**：根列表 `roots.json`、隐藏目录 `hiddenFolders.json`（按根隔离）
- **安全模型**：`contextIsolation: true, nodeIntegration: false`，preload 仅暴露白名单 `window.api`

## 目录结构

```
electron/                主进程（main / preload / ipc / services）
shared/                  跨进程共享（types.ts / imageExt.ts）
src/                     渲染进程（components / hooks / store / api / utils）
tests/                   单元测试与渲染冒烟
docs/                    PRD.md / ARCHITECTURE.md
```

## 测试

```bash
npm run typecheck   # 0 错误
npm run test        # 24 用例全绿（worker 统计 / 多根持久化 / XMP 自定义命名空间 / 渲染冒烟）
```

## 已知限制
- M1 的人像抠图仅保证"人像"，非人像可能选错主体；需真机验收的条目见 docs/plans/2026-09-23-portrait-cutout-m1.md 的人工清单。

- `electron-builder` 为开发依赖，`electron-updater` 随应用运行时打包；首次执行 `npm install` 或 `npm run dist` 前需先在本机安装依赖（`npm install`），首次打包会联网下载打包工具链，耗时较长
- `ptm` 命名空间仅本应用识别：其他图片软件与 Windows 属性面板不会显示这些标签（有意为之）
- 部分 RAW/HEIC 写回 XMP 可能不被 exiftool 支持 → 返回错误提示，不阻塞队列

## 照片 AI 处理（M1：人像抠图）

预览大图时点底栏「抠图 ▾」即可对本机照片做人像抠图：结果先进 `userData/ai-preview` 暂存，
在棋盘格底纹上按住对比确认，点「保存」才落到原图旁边生成 `原名.cutout.png`，
并自动继承原图标签 + 追加行为标签 `AI人像抠图`（可一键筛出所有 AI 产物）。

- **全程本机**：推理用 `onnxruntime-node` 的 DirectML 后端，跑在独立的 `utilityProcess` 子进程，
  照片内容不出机器；唯一的网络行为是从 `hf-mirror.com` 下载模型（约 4.4MB，下载前告知大小与粗估时长）。
- **原图永不被改**：保存是"移动派生文件"，不做任何不可逆操作，也不提供替换原图。
- **缓存**：暂存即缓存，键为五元组（原图指纹 : 模型指纹 : 输入尺寸 : 后处理参数 : 预处理管线版本），
  同一张图同一模型再点一次秒出预览；改动原图或递增管线版本都会失效重跑。
- **可拓展**：行为→模型→运行时三层分离，加模型只改清单数据，加行为只加清单条目 + 一个后处理函数。

### M1 的边界

只有「人像抠图」一个行为。U²-Netp 是人像 matting 模型：非人像照片**允许选错主体**（不会崩溃，
界面也不承诺"去除任意背景"）。通用抠图、智能打标、批量处理、后处理参数调节均不在 M1 范围。
