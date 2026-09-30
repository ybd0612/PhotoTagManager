import { useCallback, useEffect, useState } from 'react';
import { call, getApi } from '../api';
import { updatePrimaryAction } from '../utils/updateStatus';
import type { IpcResult, UpdateStatus } from '../../shared/types';

/**
 * 更新状态与三个动作的一份实现。
 * AppLayout 挂载一次后把控制器传给设置分区和右下角通知卡——订阅只有一处，
 * 两处界面看到的永远是同一个状态，不需要谁去同步谁。
 */
export interface UpdateController {
  status: UpdateStatus;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): void;
  /** 执行当前状态下唯一的主动作，界面侧不用各自判断该调哪个 */
  runPrimary(): void;
}

export function useUpdate(): UpdateController {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  // 挂载即订阅：启动检查的 available 事件可能早于任何界面渲染到达
  useEffect(() => getApi().onUpdateStatus((s) => setStatus(s)), []);

  // IPC 信封失败和主进程的 error 事件收到同一处：本地也落到 error 态，界面才有「重试」可点
  const run = useCallback(async (op: () => Promise<IpcResult<UpdateStatus>>) => {
    try {
      setStatus(await call(op()));
    } catch (error) {
      setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const check = useCallback(() => run(() => getApi().checkUpdate()), [run]);
  const download = useCallback(() => run(() => getApi().downloadUpdate()), [run]);
  // 安装会让进程退出，不等返回
  const install = useCallback(() => {
    void getApi().installUpdate();
  }, []);

  const runPrimary = useCallback(() => {
    const action = updatePrimaryAction(status);
    if (action === 'download') void download();
    else if (action === 'install') install();
    else if (action === 'check') void check();
  }, [status, check, download, install]);

  return { status, check, download, install, runPrimary };
}
