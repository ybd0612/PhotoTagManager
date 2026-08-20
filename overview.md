# PhotoTagManager 自动更新功能收尾概览

## 2026-08-20 0.1.3 补丁发布

- 版本升级到 `0.1.3`，保留已发布的 `0.1.2` 不变。
- 本版本包含关于页版本号同步修复：直接读取 `package.json.version`。
- 发布前已完成类型检查和 24/24 全量测试；后续通过 `v0.1.3` 标签发布正式 Release。

## 2026-08-20 版本号同步修复

- 修复关于页仍显示 `0.1.1` 的发布遗漏：`AboutDialog` 现在直接读取 `package.json` 版本号，当前显示 `0.1.2`。
- `tsconfig.web.json` 纳入 `package.json`，确保 JSON 单一来源可通过类型检查和渲染构建。
- 增加应用冒烟测试对版本展示的校验，防止版本号再次漂移。
- 验证：类型检查通过；清理缓存后 24/24 测试通过。

## 已完成

- 从提交 `cf4219a` 继续核对 GitHub Releases 自动更新实现。
- 修复 `package.json` 与 `package-lock.json` 不一致：将运行时依赖 `electron-updater` 放入 `dependencies`，并同步锁文件。
- 校正 README 的已知限制说明，明确 `electron-updater` 随应用运行时打包，`electron-builder` 仍为开发依赖。
- 确认 GitHub Actions 发布工作流、electron-builder GitHub publish 配置、更新 IPC/UI 链路均已存在。

## 验证结果

- `npm run typecheck`：通过，无 TypeScript 错误。
- `npm run test`：通过，4 个测试文件、24 个用例全部通过；存在既有 React `act(...)` 警告和 Vite CJS API 弃用提示，不影响退出码。
- `npm run build`：通过，main/preload/renderer 与 scanWorker 均成功生成到 `out/`。
- `npm run dist`：在配置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 并通过本地 `127.0.0.1:7897` mixed 代理下载 GitHub 工具后成功。
- 已生成 `dist/PhotoTagManager-0.1.0-x64.exe`（约 89.8 MB）、`dist/latest.yml` 和 `.blockmap`；`latest.yml` 版本为 `0.1.0`。
- GitHub Actions 的真实发布仍需仓库配置完成后通过版本 tag 验证；本地打包产物未纳入 Git 提交。

## 提交

- 已补充 GitHub Actions `permissions.contents: write`，提交为 `d487446`。
- 已通过本地 `127.0.0.1:7897` mixed 代理推送 `master` 和 `v0.1.0` 标签；远程确认指向 `d487446`。
- `v0.1.0` 已触发 GitHub Actions Release 工作流；最初生成 Draft，现已通过 GitHub CLI 转为正式 Release，标题为 `PhotoTagManager v0.1.0`，Assets 已全部可下载。
- 后续发布配置已更新：Actions 构建使用 Node.js 24，electron-builder GitHub publish 设置 `releaseType: "release"`，并改由 `gh release create --title "PhotoTagManager <tag>" --generate-notes` 自动创建正式 Release、填写标题和提交记录说明。
- 新增 Windows 系统托盘：关闭窗口仅隐藏到托盘，单击托盘图标恢复，右键菜单的“退出 PhotoTagManager”才真正退出。
- 修复预览缩小后的拖动边界：缩放值不等于 1 时都允许抓取拖动，避免图片偏移到可视区外后无法找回。类型检查与 24 个测试用例均通过。
- 扫描进度改为确定性百分比：Worker 每扫描约 50 个文件推送一次统计，底部按 `scannedFiles / totalFiles` 展示 0%～99%，完成后显示 100%；空目录和总数未知时安全显示 0%。
- 增加 Electron 单实例锁：重复启动不会创建新窗口，而是激活、显示并聚焦已有窗口；即使已有窗口隐藏在 Windows 托盘，也会被恢复显示。
- 本轮验证：`npm run typecheck` 通过，`npm run test` 通过（4 个测试文件、24 个用例）；仍有既有 React `act(...)` 与 Vite CJS API 警告。
- 修复扫描进度长时间显示 99% 的问题：Worker 每 10 个文件独立发送一次统计消息，不再因图片/目录批次未满而吞掉进度；图片批次大小保持不变。

## 明天继续

- 首要待办：修复 Windows 系统托盘图标显示为黑色、看不见的问题。
- 当前托盘图标在 `electron/main.ts` 中通过 `nativeImage.createFromDataURL()` 加载内联 SVG；明天优先改为可见的 PNG/ICO 或正确处理 SVG 图标，验证浅色和深色 Windows 主题下均能正常显示。
- 已将托盘图标从内联 SVG 替换为内嵌 RGBA PNG，避免 Windows 托盘 SVG 透明色解析异常导致黑色不可见。
- 验证：`npm run typecheck` 通过；`npm run test` 通过（4 个测试文件、24 个用例）。`npm run build` 因 `out/main/index.js` 被占用，安全清理旧构建目录失败，未发现代码编译错误。

## 2026-08-20 目录提示单行布局

- 顶部当前目录提示改为单行横向显示：`目录名 · 绝对路径`。
- 路径过长时使用省略号，悬停 Tooltip 仍可查看完整绝对路径。
- 中文产品名“照片标签管家”和关于页面保持不变。
- 验证：`npm run typecheck` 通过；清理 `node_modules/.vite` 后全量测试 4 个文件、24 个用例通过。
- 备注：首次直接重跑测试出现一次 Vitest/Vite 缓存导致的 React invalid hook call，清理缓存后恢复；仍有既有 `act(...)` 与 Vite CJS API 警告，不影响退出码。

## 2026-08-20 作者网站与外部链接

- 关于页面新增作者网站 `https://yangbang.de`。
- GitHub 与作者网站链接统一通过 Electron 主进程 `shell.openExternal` 调用系统默认浏览器打开，渲染层阻止默认导航。
- 主进程仅允许 HTTPS 且限制 `github.com`、`yangbang.de` 域名白名单；preload 与共享 API 类型同步更新。
- 验证：`npm run typecheck` 通过；清理 `node_modules/.vite` 后全量测试 4 个文件、24 个用例通过。
- 既有非阻断警告：React `act(...)`、Vite CJS Node API 弃用提示。

## 当前状态

- 最新提交：`b9d0b74 修复扫描进度跳到99%`。
- 本轮修改待提交；未推送远程。
- 如果重新打包前仍提示 `out` 文件占用，请先关闭正在运行的 PhotoTagManager/构建相关进程，再重试 `npm run build` 或 `npm run dist`。
- 修复扫描期间浏览卡顿：进度消息从每 10 个文件调整为每 100 个文件，降低 IPC 和渲染重绘压力；缩略图请求不再因扫描批次更新触发 effect 清理而被取消，已加载图片可继续显示和点击预览。
- 本轮验证：`npm run typecheck` 与 `npm run test` 通过，4 个测试文件、24 个用例全部通过。
- 全面修复扫描链路：增加 scanId 代际隔离、按根扫描状态、Worker 生命周期清理、明确 batch kind、进度时间节流、图片去重、标签/隐藏回写代际校验，以及自动扫描等待绑定具体扫描。
- 扫描修复验证：`npm run typecheck` 通过；`npm run test` 通过（4 个测试文件、24 个用例）。存在既有 React act 警告和 Vite CJS API 弃用提示。
