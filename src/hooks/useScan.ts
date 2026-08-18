import { useEffect } from 'react';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';

/**
 * 扫描生命周期（R01/R02）。
 *
 * 订阅只能由**单个**组件持有（App 根组件调用 useScanSubscriptions），
 * 否则每个订阅者都会把 scan:progress 合并进 store 造成图片重复。
 * startScan / rescan / cancelScan 为普通函数，任何组件可直接调用。
 */

/** 订阅 scan:progress / scan:done / scan:error，增量合并到 store（仅 App 根组件调用一次） */
export function useScanSubscriptions(): void {
  useEffect(() => {
    const api = getApi();
    const offProgress = api.onScanProgress((batch) => {
      useAppStore.getState().mergeScanBatch(batch);
    });
    const offDone = api.onScanDone(({ stats }) => {
      const store = useAppStore.getState();
      store.setScanState('done');
      store.setScanStats(stats);
      // 扫描完成后加载持久化隐藏集（R06）
      void api
        .listHiddenFolders()
        .then((result) => {
          if (result.ok) {
            useAppStore.getState().setHiddenSet(result.data.map((r) => r.relPath));
          }
        })
        .catch(() => undefined);
    });
    const offError = api.onScanError((error) => {
      useAppStore.getState().setScanState('error');
      useAppStore.getState().setSnackbar(`扫描失败：${error.message}`);
    });

    return () => {
      offProgress();
      offDone();
      offError();
    };
  }, []);
}

/** 选择根目录并启动扫描（R01） */
export async function startScan(rootPath: string): Promise<void> {
  const store = useAppStore.getState();
  store.resetScan();
  store.setRootPath(rootPath);
  store.setScanState('scanning');
  try {
    await call(getApi().scanStart(rootPath));
  } catch (error) {
    useAppStore.getState().setScanState('error');
    useAppStore
      .getState()
      .setSnackbar(`启动扫描失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 重新全量扫描（A5：替换内存数据） */
export async function rescan(): Promise<void> {
  const rootPath = useAppStore.getState().rootPath;
  if (rootPath) await startScan(rootPath);
}

/** 取消当前扫描（R02） */
export async function cancelScan(): Promise<void> {
  try {
    await call(getApi().scanCancel());
  } catch {
    // 忽略取消失败
  }
  const store = useAppStore.getState();
  store.setScanState('idle');
  store.setScanStats(null);
}
