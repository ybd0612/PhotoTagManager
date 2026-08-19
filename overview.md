# PhotoTagManager 自动更新功能收尾概览

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
