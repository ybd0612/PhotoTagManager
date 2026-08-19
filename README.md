# PhotoTagManager

基于 Electron 的 Windows 桌面图片 XMP 标签管理工具：多图库根目录 + 别名分组、自动扫描、标签直接写入图片源文件（自定义 XMP 命名空间）、热门标签筛选、批量打标、大图缩放预览。

> 标签以 XMP 元数据**内嵌在图片文件本身**（无独立数据库），但使用自定义命名空间 `XMP-ptm:Tags`——Windows 资源管理器属性面板的"标记"不会显示，标签仅在本应用内可见。

## 功能特性

- **多根目录 + 别名**：可添加多个图片根目录（如 A 目录起名「照片」、B 目录起名「资料」），根列表持久化，重启自动恢复
- **自动扫描**：启动后自动扫描全部根目录（优先选中根，其余串行后台扫），懒加载不打断浏览
- **目录树**：仅显示含图片的目录，右键支持隐藏/恢复、在资源管理器中打开
- **标签管理**：预览中增删标签、Ctrl 多选后批量添加标签，全部直接写回源文件 XMP
- **标签筛选**：热门标签（按当前目录上下文统计）+ 高级筛选 + AND/OR 组合
- **缩略图网格**：虚拟滚动、列宽自适应、GIF/WebP 直接原图预览
- **大图预览**：滚轮缩放（光标为中心）、拖动平移、双击还原、Ctrl+C 复制文件、双色绝对路径显示
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

- **发版流程**：打 tag 并推送，GitHub Actions 自动打包并发布到 GitHub Releases：

  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```

  Actions（`.github/workflows/release.yml`）在 `windows-latest` 上执行 `npm ci` → `npm run build` → `npx electron-builder --publish always`，产出 NSIS 安装包（`dist/PhotoTagManager-<version>-x64.exe`）与 `latest.yml` 更新清单。

- **更新渠道**：`electron-updater` 读取 GitHub Releases（`publish` 配置为 github 源），应用**启动时静默检查** + 顶栏「检查更新」**手动检查**；发现新版本后下载进度条展示，下载完成可一键重启安装。

- **本地打包**：也可在本机执行 `npm run dist` 生成安装包（首次打包会自动下载 electron 发行版与 NSIS 工具链，需联网）。

## 使用流程

1. 点击「添加根目录」→ 选择图片文件夹（自动起别名，可改）；可添加多个根
2. 启动后自动扫描所有根（第一个优先），左侧根列表显示扫描状态（黄点 = 扫描中）
3. 左侧目录树仅显示「递归含 ≥1 张图片」的目录；右键可隐藏/恢复、在资源管理器中打开；悬浮显示完整名称
4. 点击目录 → 右侧显示该目录（含子目录）图片网格；顶栏显示当前选中目录绝对路径
5. 单击图片 → 全屏预览：滚轮缩放、拖动平移、双击还原、`←/→` 翻页、`Esc` 关闭、`Ctrl+C` 复制文件
6. 预览中可添加/删除标签（立即写回 XMP）；`Ctrl` + 单击多选图片后，顶部操作条可**批量添加标签**
7. 标签筛选：热门标签（随选中目录变化）+「更多标签…」全量列表 + AND/OR 组合

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

- `electron-builder` 为开发依赖，`electron-updater` 随应用运行时打包；首次执行 `npm install` 或 `npm run dist` 前需先在本机安装依赖（`npm install`），首次打包会联网下载打包工具链，耗时较长
- `ptm` 命名空间仅本应用识别：其他图片软件与 Windows 属性面板不会显示这些标签（有意为之）
- 部分 RAW/HEIC 写回 XMP 可能不被 exiftool 支持 → 返回错误提示，不阻塞队列
