import { useEffect } from 'react';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import type { RootEntry } from '../../shared/types';

/**
 * 扫描生命周期（R01/R02，多根懒扫描 R10）。
 *
 * 订阅只能由**单个**组件持有（App 根组件调用 useScanSubscriptions），
 * 否则每个订阅者都会把 scan:progress 合并进 store 造成图片重复。
 * startScan / rescan / cancelScan 为普通函数，任何组件可直接调用。
 * 懒扫描：选中未扫过的根才触发；已扫过的根直接浏览。
 */

/** 订阅 scan:progress / scan:done / scan:error，增量合并到 store（仅 App 根组件调用一次） */
export function useScanSubscriptions(): void {
  useEffect(() => {
    const api = getApi();
    const offProgress = api.onScanProgress((batch) => {
      useAppStore.getState().mergeScanBatch(batch);
    });
    const offDone = api.onScanDone(({ rootId }) => {
      const store = useAppStore.getState();
      store.setScanState('done');
      // 扫描完成后加载该根的持久化隐藏集（R06）
      void api
        .listHiddenFolders(rootId)
        .then((result) => {
          if (result.ok) {
            useAppStore.getState().setHiddenSet(rootId, result.data.map((r) => r.relPath));
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

/** 启动扫描指定根（懒扫描：切换未扫过的根时调用） */
export async function startScan(root: RootEntry): Promise<void> {
  const store = useAppStore.getState();
  store.resetScan(root.id);
  store.setScanState('scanning');
  try {
    await call(getApi().scanStart(root.id, root.path));
  } catch (error) {
    useAppStore.getState().setScanState('error');
    useAppStore
      .getState()
      .setSnackbar(`启动扫描失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 重新全量扫描当前根（A5：替换内存数据） */
export async function rescan(): Promise<void> {
  const root = useAppStore.getState().roots.find((r) => r.id === useAppStore.getState().selectedRootId);
  if (root) await startScan(root);
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
