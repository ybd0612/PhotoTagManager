# PhotoTagManager

Windows 桌面图片 XMP 标签管理器（MVP）。选择根目录扫描图片 → 「仅含图片」目录树 → 文件夹隐藏/显示（持久化）→ 图片 XMP 自由标签增删 → 标签筛选 → 缩略图网格 + 大图预览。

技术栈：Electron + React（Vite + MUI + Tailwind CSS）+ exiftool-vendored + zustand + react-window。

## 快速开始

```bash
npm install        # 安装依赖（electron / exiftool 二进制下载较慢，失败可重试）
npm run dev        # 启动应用（electron-vite dev，打开桌面窗口）
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（HMR） |
| `npm run build` | 三端构建（main/preload/renderer + scanWorker） |
| `npm run start` | 预览构建产物 |
| `npm run typecheck` | TypeScript 全量类型检查（node + web 两套工程） |
| `npm run test` | Vitest 单元测试（worker 统计 / 隐藏持久化 / XMP 读写 / 渲染冒烟） |

## 使用流程

1. 点击「选择根目录」→ 选择图片文件夹 → 后台 Worker 扫描，状态栏显示进度、目录树逐步填充
2. 左侧目录树仅显示「递归含 ≥1 张图片」的目录；右键目录可隐藏/取消隐藏/重新扫描；右上角 👁 开关可查看已隐藏目录
3. 点击目录 → 右侧显示该目录图片缩略图网格（虚拟滚动，仅渲染可视区）
4. 点击缩略图 → 全屏预览：`←/→` 翻页、`Esc` 关闭；底部可添加/删除标签（立即写回 XMP）
5. 标签筛选条：添加筛选（含计数）、AND/OR 切换、清除；「标签管理」面板支持标签重命名/合并（P1）

## 架构要点

- **三进程**：主进程（IPC/文件系统/XMP/缩略图/持久化）、Worker 线程（目录扫描，批推送）、渲染进程（React UI + zustand）
- **IPC 命名**：`域:动作`（kebab-case），统一响应信封 `IpcResult`
- **标签存储**：写入图片 XMP `dc:subject`（数组）与 `xmp:Label`，仅更新标签字段、保留其他元数据
- **隐藏持久化**：`userData/hiddenFolders.json`，记录相对根目录路径
- **缩略图缓存**：`userData/thumbnails/{sha1(absPath:mtimeMs:size)}.jpg`
- **安全模型**：`contextIsolation: true, nodeIntegration: false`，preload 仅暴露白名单 `window.api`

## 目录结构

```
electron/                主进程（main / preload / ipc / services）
shared/                  跨进程共享（types.ts / imageExt.ts）
src/                     渲染进程（components / hooks / store / api）
tests/                   单元测试与渲染冒烟
docs/                    PRD.md / ARCHITECTURE.md
```

## 已知限制（MVP）

- 目录节点显示该目录**直接**图片；「包含子目录」浏览为二期（A1）
- 标签筛选作用于当前目录已加载标签的图片；全量标签统计属 P1（A2）
- 部分 RAW/HEIC 写回 XMP 可能不被支持 → 返回错误提示重试，不阻塞队列（A3）
- 打包分发（electron-builder）列入二期（A4）
