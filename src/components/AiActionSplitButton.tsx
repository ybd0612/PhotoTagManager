import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import Stack from '@mui/material/Stack';
import { describeDownloadCost, useAiStore } from '../store/useAiStore';
import type { AiCapabilityView, AiModelView } from '../../shared/types';

/**
 * 预览底栏的组合按钮（D13 / D17）：主按钮 + 右侧模型下拉。
 *
 * 三条不可让步的约束都落在实现细节上：
 * - **主按钮语义恒定**：永远只表示"用当前模型处理这张图"，文案取自清单，
 *   不随下载/加载/推理状态换字，也**永不置灰**——灰色等于"坏了"，
 *   进行中改用背景填充表达进度（D17）。
 * - **hover 不承载动作**：下拉只由点击或键盘（Enter/Space）打开，
 *   悬停出来的入口对键盘与触屏用户不可达。
 * - **下拉可纯键盘操作**：Tab 进入、↑↓ 换行、Enter 执行该行动作、Esc 关闭
 *   并把焦点还给触发按钮。
 *
 * 下拉用自管的可导航列表而不是 MUI Menu：Menu 的按键语义在 jsdom 里测不准，
 * 而"必须可键盘导航"这条不能只靠肉眼验收。
 */

/** 超过 5 个行为时后面的收进「更多」，布局按可扩展做（§4.1） */
const MAX_VISIBLE_CAPABILITIES = 5;

interface Props {
  absPath: string;
}

export function AiActionSplitButton({ absPath }: Props) {
  const catalog = useAiStore((s) => s.catalog);
  const capabilities = useMemo(
    () =>
      (catalog?.capabilities ?? [])
        .map((cap) => ({ ...cap, models: cap.models.filter((m) => m.verified) }))
        .filter((cap) => cap.models.length > 0),
    [catalog]
  );
  const task = useAiStore((s) => s.task);
  const pendingConfirm = useAiStore((s) => s.pendingConfirm);
  const init = useAiStore((s) => s.init);
  const requestRun = useAiStore((s) => s.requestRun);
  const cancelRun = useAiStore((s) => s.cancelRun);
  const approveDownload = useAiStore((s) => s.approveDownload);
  const dismissConfirm = useAiStore((s) => s.dismissConfirm);

  useEffect(() => {
    init();
  }, [init]);

  const visible = capabilities.slice(0, MAX_VISIBLE_CAPABILITIES);
  const overflow = capabilities.slice(MAX_VISIBLE_CAPABILITIES);

  return (
    <Stack
      direction="row"
      spacing={1}
      data-testid="ai-split-button"
      sx={{
        // 底栏按钮区可横向滚动，避免加行为时改布局
        overflowX: 'auto',
        overflowY: 'hidden',
        whiteSpace: 'nowrap',
        scrollbarWidth: 'thin'
      }}
    >
      {visible.map((cap) => (
        <CapabilityButton key={cap.id} cap={cap} absPath={absPath} running={task?.capabilityId === cap.id} />
      ))}
      {overflow.length > 0 && <MoreCapabilitiesButton caps={overflow} absPath={absPath} />}
      {task && (
        <Button size="small" color="inherit" onClick={() => void cancelRun()} data-testid="ai-cancel">
          取消
        </Button>
      )}
      {pendingConfirm && (
        <Dialog open onClose={() => dismissConfirm()} aria-labelledby="ai-confirm-title">
          <DialogContent>
            <DialogContentText id="ai-confirm-title">
              首次使用需下载 {describeDownloadCost(pendingConfirm.sizeBytes)}，全程在本机处理，不上传照片内容。
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => dismissConfirm()}>取消</Button>
            <Button onClick={() => void approveDownload()} autoFocus>
              确认并开始
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Stack>
  );
}

function CapabilityButton({ cap, absPath, running }: { cap: AiCapabilityView; absPath: string; running: boolean }) {
  const task = useAiStore((s) => s.task);
  const requestRun = useAiStore((s) => s.requestRun);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const percent = running ? Math.max(0, Math.min(100, task?.percent ?? 0)) : 0;

  return (
    <Stack direction="row" spacing={0} sx={{ flexShrink: 0 }}>
      <Button
        size="small"
        variant="contained"
        onClick={() => requestRun(absPath, cap.id)}
        // 进行中不置灰：用 disabled 表达"忙"会让人以为程序坏了
        aria-busy={running}
        aria-valuenow={running ? percent : undefined}
        aria-valuemin={running ? 0 : undefined}
        aria-valuemax={running ? 100 : undefined}
        aria-label={`${cap.label}`}
        sx={{
          // 背景从左往右填充表达进度，文字始终保持可读对比
          backgroundImage: running
            ? `linear-gradient(to right, rgba(255,255,255,0.28) ${percent}%, transparent ${percent}%)`
            : 'none',
          position: 'relative'
        }}
      >
        {cap.label}
      </Button>
      <Button
        ref={triggerRef}
        size="small"
        variant="contained"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`选择模型（当前 ${cap.defaultModelId}）`}
        sx={{ minWidth: 0, px: 1 }}
      >
        ▾
      </Button>
      {menuOpen && (
        <ModelMenu
          cap={cap}
          onClose={() => {
            setMenuOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </Stack>
  );
}

function primaryActionOf(model: AiModelView): { label: string; action: 'download' | 'unload' | 'delete' } {
  if (model.status === 'absent') return { label: '下载', action: 'download' };
  return { label: model.loaded ? '卸载' : '删除', action: model.loaded ? 'unload' : 'delete' };
}

function ModelMenu({ cap, onClose }: { cap: AiCapabilityView; onClose: () => void }) {
  const modelAction = useAiStore((s) => s.modelAction);
  const [active, setActive] = useState(0);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  const models = cap.models;

  useEffect(() => {
    itemRefs.current[active]?.focus();
  }, [active]);

  const run = (index: number) => {
    const model = models[index];
    if (!model) return;
    void modelAction(model.id, primaryActionOf(model).action).then(onClose);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % models.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i - 1 + models.length) % models.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(models.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    }
  };

  return (
    <ul
      role="menu"
      aria-label={`${cap.label} 的候选模型`}
      onKeyDown={onKeyDown}
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        position: 'absolute',
        zIndex: 10,
        background: '#fff',
        border: '1px solid rgba(0,0,0,0.12)',
        borderRadius: 4,
        minWidth: 260
      }}
    >
      {models.map((model, index) => {
        const primary = primaryActionOf(model);
        return (
          <li
            key={model.id}
            role="menuitem"
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            // 只让当前行可被 Tab 落到，其余靠方向键换行
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setActive(index)}
            style={{ padding: '6px 10px', background: index === active ? 'rgba(25,118,210,0.08)' : undefined }}
          >
            <span>
              {model.displayName} · {describeDownloadCost(model.sizeBytes).split('，')[0]} ·{' '}
              {model.status === 'present' ? (model.loaded ? '已加载' : '已下载') : '未下载'}
            </span>
            <Stack direction="row" spacing={0.5} sx={{ ml: 1, display: 'inline' }}>
              <Button
                size="small"
                onClick={() => void modelAction(model.id, primary.action).then(onClose)}
                data-testid={`model-action-${primary.label}`}
              >
                {primary.label}
              </Button>
              {model.status === 'present' && !model.loaded && (
                <Button size="small" onClick={() => void modelAction(model.id, 'unload')}>
                  卸载
                </Button>
              )}
              {!model.isDefault && (
                <Button size="small" onClick={() => void modelAction(model.id, 'set-default')}>
                  设为默认
                </Button>
              )}
            </Stack>
          </li>
        );
      })}
    </ul>
  );
}

function MoreCapabilitiesButton({ caps, absPath }: { caps: AiCapabilityView[]; absPath: string }) {
  const [open, setOpen] = useState(false);
  const requestRun = useAiStore((s) => s.requestRun);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={ref}
        size="small"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多"
      >
        更多
      </Button>
      {open && (
        <ul role="menu" aria-label="更多处理行为" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {caps.map((cap, index) => (
            <li key={cap.id} role="menuitem" tabIndex={index === 0 ? 0 : -1}>
              <Button size="small" onClick={() => { setOpen(false); requestRun(absPath, cap.id); }}>
                {cap.label}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
