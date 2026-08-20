# 扫描链路全面审查报告

## 结论

“扫描完成后再次重新扫描，进度直接到 99% 并卡住”不是单一 UI 问题，当前扫描链路存在一个高优先级生命周期缺陷：**重新扫描缺少扫描代际（generation/runId）隔离**。旧 Worker 被终止后，已经排队的消息仍可能到达主进程；主进程和渲染层只按 `rootId` 识别消息，无法区分旧扫描和当前扫描。

## P0：必须优先修复

### 1. 旧 Worker 消息可能覆盖新扫描状态

涉及：

- `electron/services/scanService.ts`
- `src/hooks/useScan.ts`
- `src/store/useAppStore.ts`

当前流程：

1. `startScan()` 调用 `this.cancel()`；
2. 创建新 Worker，并复用同一个 `rootId`；
3. 旧 Worker 的 `message/error` 回调仍然闭包捕获同一个 `rootId`；
4. 主进程无 runId/generation 校验，照常转发 `scan:progress`、`scan:done`、`scan:error`；
5. 前端 `onScanDone` 只接收 `{ rootId }`，直接执行 `setScanState('done')`；
6. 旧扫描的完成事件可能把新扫描提前置为 done，随后新扫描进度又把数值改回接近 99%，形成状态与进度不一致。

建议：

- 每次 `startScan` 生成唯一 `scanId`；
- `ScanBatch`、`scan:done`、`scan:error`、取消事件全部携带 `scanId`；
- `ScanService` 的 Worker 回调只接受当前 Worker 对应的 scanId；
- 前端 store 记录 `activeScanId`，所有进度/完成/错误事件先校验 scanId；
- 旧扫描的事件直接丢弃。

## P1：完成态和进度统计设计存在缺陷

### 2. Worker 内部把动态 totalFiles 在完成时强行改成 scannedFiles

位置：`electron/services/scanWorker.ts:184-188`

扫描过程中 `totalFiles` 只是“已遍历目录的文件数”，随着递归不断增加；完成时才改为最终总数。对于深层目录，前期分母会不断变化，百分比不具备严格单调性，可能出现跳变。当前 UI 又使用 `Math.min(99, ...)`，因此扫描中任何统计达到 100% 都会被压成 99%，只能等最后 done 才显示 100%。

建议：

- 最佳方案：扫描前先做轻量文件计数，再进行图片扫描，得到稳定分母；
- 或保留动态分母，但明确这是估算进度，并使用“已扫描文件数”辅助展示；
- 不要把动态统计伪装成严格百分比。

### 3. `scanState` 是全局单值，与多根后台扫描不匹配

位置：`src/hooks/useScan.ts:55-68`、`src/store/useAppStore.ts:252-304`

后台扫描非选中根时，`mergeScanBatch` 仍会把该根的 batch.stats 写入全局 `scanStats`；任意根的 `scan:done` 都会执行全局 `setScanState('done')`。因此后台根完成可能让当前选中根看起来已完成，或当前根仍在扫描时状态被其他根覆盖。

建议：

- 扫描状态按 rootId 保存：`scanStateByRoot` / `activeScanByRoot`；
- 底部 UI 只读取选中根状态；
- 自动扫描队列使用指定 rootId 的状态，不依赖全局单值。

## P1：Worker 生命周期处理不完整

### 4. `ScanService.cancel()` 只 terminate，不等待旧 Worker 退出

位置：`electron/services/scanService.ts:52-59`

`terminate()` 返回 Promise，但当前没有等待，也没有给旧回调设置失效标记。连续快速点击重新扫描、切换根目录、自动扫描队列切换时，容易形成旧消息与新消息交错。

建议：

- 在取消前记录旧 worker/token 为失效；
- 监听 `exit` 或使用 runId 判断；
- 新旧 Worker 回调均检查当前 token；
- `startScan` 需要明确串行生命周期，旧扫描未失效前不接受其事件。

### 5. Worker 的 `error` 事件没有清理当前 Worker 引用和状态

位置：`electron/services/scanService.ts:43-47`

Worker 报错后只发送 `scan:error`，没有将 `this.worker` 清空，也没有统一结束当前扫描上下文。后续再次扫描虽然会覆盖引用，但错误场景下自动队列可能进入不一致状态。

建议：统一 `finishRun()`，在 done/error/cancel/exit 中清理当前上下文，并区分正常取消与异常退出。

## P1：进度消息协议存在边界问题

### 6. 进度消息和图片批次共用 batchIndex，但没有消息类型

位置：`electron/services/scanWorker.ts:66-75`

空图片进度消息与图片批次都使用 `ScanBatch`，前端只能通过 `images.length === 0` 间接判断。协议语义不清，未来容易把空进度当成数据批次处理；而且进度消息与批次可能因 IPC 排队造成观察顺序与实际扫描时间不一致。

建议：增加明确的事件类型：`scan:progress`、`scan:batch`、`scan:done`，或者在 ScanBatch 增加 `kind: 'data' | 'progress'`。

### 7. 进度更新频率与批次策略曾多次互相影响

当前已从每 10 个文件调整为每 100 个文件，但没有基于耗时/消息队列的节流；大目录仍可能产生较多 IPC 消息。此前出现“图片加载中、点击无响应”说明渲染压力已经被实际触发过。

建议：按时间节流（例如 100～250ms）并保留最后一次统计，而不是只按文件数量；进度消息不应触发昂贵的树重建。

## P2：数据一致性与性能问题

### 8. `mergeScanBatch()` 对同一目录图片使用 `arr.push()`，协议重放/重复消息会产生重复图片

位置：`src/store/useAppStore.ts:288-294`

如果旧 Worker 消息重复到达，或者 IPC 层重发，图片会重复进入数组。当前没有按 image.id 去重。扫描代际隔离修复后风险会显著下降，但仍建议按 `id` 或 `absPath` 合并去重。

### 9. `loadRootTags()` 可能读取旧扫描快照

位置：`src/hooks/useScan.ts:23-45`

扫描完成后异步收集当前 store 中图片路径。若旧 done 事件先触发，会提前启动标签读取；新扫描 reset 后，旧标签任务仍可能回写旧路径的标签。标签本身按 absPath 缓存，通常不会破坏文件，但会增加 IPC 和渲染负载。

建议：标签加载任务绑定 scanId，开始新扫描时取消或忽略旧任务结果。

### 10. 现有测试未覆盖重新扫描时序

`tests/scan.test.ts` 主要覆盖：

- DFS 目录统计；
- 图片批次大小；
- 取消遍历；
- junction 跳过；
- 盘符根路径；
- 隐藏目录持久化。

缺失：

- 同一 root 连续两次 startScan；
- 旧 Worker 晚到的 batch/done/error 被丢弃；
- 后台根完成不影响当前选中根；
- cancel 后再 start；
- worker error/exit 后的状态清理；
- 空目录、无权限目录、动态 totalFiles 下的进度表现。

## 推荐修复顺序

1. **P0：引入 scanId/runId，隔离旧 Worker 事件。**
2. **P1：将 scanState、scanStats 按 rootId 管理，修复多根后台扫描串状态。**
3. **P1：统一 Worker done/error/cancel/exit 生命周期清理。**
4. **P1：补充重新扫描和旧消息乱序回归测试。**
5. **P2：图片批次按 id 去重，标签加载绑定扫描代际。**
6. **P2：优化进度协议和时间节流；如需真实百分比，再评估预扫描计数方案。**

## 本轮结论

本轮只读审查未修改业务代码。最应该先处理的是扫描代际隔离，而不是继续调整 99% 的显示算法。否则任何 UI 进度修补都可能被旧 Worker 的迟到事件再次覆盖。
