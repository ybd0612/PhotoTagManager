import type { UpdateController } from '../../src/hooks/useUpdate';
import type { UpdateStatus } from '../../shared/types';

/**
 * 更新控制器的测试假件。
 * 真控制器由 AppLayout 里的 useUpdate() 建一次再往下传，所以直接渲染 SettingsDialog
 * 或 AboutUpdatePane 的用例必须自己补一份——它不该去碰 window.api。
 */
export function updateStub(status: UpdateStatus = { state: 'idle' }): UpdateController {
  const noop = async (): Promise<void> => undefined;
  return {
    status,
    check: noop,
    download: noop,
    install: () => undefined,
    runPrimary: () => undefined
  };
}
