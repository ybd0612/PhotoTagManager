import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { describeDownloadCost, useAiStore } from '../store/useAiStore';
import { downloadConsent } from '../utils/strings';
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

/** D12：CPU 只能由人显式勾选；勾选后这句代价说明常驻在底栏，不写成一次性提示 */
const CPU_TOGGLE_LABEL = 'CPU 慢速模式（比 GPU 慢约一个数量级）';
// 刻意不写"限 X 核"这种数字：核数由 inferenceChild 的线程常量决定，界面复述一遍就是第二处事实源
const CPU_BACKEND_NOTICE = '当前走 CPU 慢速模式：比 GPU 慢约一个数量级，已限制线程数，不会占满全部核心';

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
  const backend = useAiStore((s) => s.backend);
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
      {backend === 'cpu' && (
        <Typography variant="caption" data-testid="ai-backend-notice" sx={{ alignSelf: 'center', flexShrink: 0 }}>
          {CPU_BACKEND_NOTICE}
        </Typography>
      )}
      {pendingConfirm && (
        <Dialog open onClose={() => dismissConfirm()} aria-labelledby="ai-confirm-title">
          <DialogContent>
            <DialogContentText id="ai-confirm-title">
            {downloadConsent(describeDownloadCost(pendingConfirm.sizeBytes))}
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
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const percent = running ? Math.max(0, Math.min(100, task?.percent ?? 0)) : 0;

  const closeMenu = (): void => {
    setAnchor(null);
    triggerRef.current?.focus();
  };

  return (
    <Box sx={{ flexShrink: 0 }}>
      <ButtonGroup
        size="small"
        variant="contained"
        disableElevation
        sx={{ borderRadius: 1.5, '& .MuiButton-root': { textTransform: 'none', fontWeight: 600 } }}
      >
        <Button
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
              : 'none'
          }}
        >
          {cap.label}
        </Button>
        <Button
          ref={triggerRef}
          onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          aria-label={`选择模型（当前 ${cap.defaultModelId}）`}
          sx={{ minWidth: 0, px: 1 }}
        >
          ▾
        </Button>
      </ButtonGroup>
      {anchor && <ModelMenu cap={cap} anchorEl={anchor} onClose={closeMenu} />}
    </Box>
  );
}

function primaryActionOf(model: AiModelView): { label: string; action: 'download' | 'unload' | 'delete' } {
  if (model.status === 'absent') return { label: '下载', action: 'download' };
  return { label: model.loaded ? '卸载' : '删除', action: model.loaded ? 'unload' : 'delete' };
}

/**
 * 状态标签。"已下载"和"已加载"只差一个字，纯灰文本肉眼分不出来（用户两次反馈），
 * 所以驻留那档给实心绿，其余描边——强度差是语义差，不是装饰。
 */
function ModelStatusChip({ model }: { model: AiModelView }) {
  const resident = model.status === 'present' && model.loaded && !model.statusReason;
  const label = model.statusReason
    ? '不可用'
    : model.status === 'absent'
      ? '未下载'
      : model.loaded
        ? '已加载'
        : '已下载';
  const chip = (
    <Chip
      size="small"
      data-testid="model-status"
      label={label}
      color={resident ? 'success' : 'default'}
      variant={resident ? 'filled' : 'outlined'}
      sx={{
        height: 20,
        flexShrink: 0,
        fontSize: '0.7rem',
        fontWeight: resident ? 700 : 500,
        '& .MuiChip-label': { px: 0.75 },
        ...(model.statusReason ? { color: 'warning.main', borderColor: 'warning.light' } : null)
      }}
    />
  );
  if (!resident) return chip;
  return (
    <Tooltip title="模型正驻留在显存/内存里，不会自己退出：点「卸载」立即释放，下次处理时会自动重新加载">
      {chip}
    </Tooltip>
  );
}

function ModelMenu({
  cap,
  anchorEl,
  onClose
}: {
  cap: AiCapabilityView;
  anchorEl: HTMLElement;
  onClose: () => void;
}) {
  const modelAction = useAiStore((s) => s.modelAction);
  const backend = useAiStore((s) => s.backend);
  const setBackend = useAiStore((s) => s.setBackend);
  const models = cap.models;
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  const [active, setActive] = useState(() => {
    const defaultIndex = models.findIndex((m) => m.isDefault);
    return defaultIndex < 0 ? 0 : defaultIndex;
  });

  useEffect(() => {
    // Modal 挂载时会自己动一次焦点，把"打开即落在当前行"那次冲掉；晚一帧再落位，
    // 否则键盘用户打开菜单后第一次回车没有目标
    const raf = requestAnimationFrame(() => itemRefs.current[active]?.focus());
    return () => cancelAnimationFrame(raf);
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

  // 后端是运行时选择，不挂在某个模型行上；D17 要求动作可点、能 Tab 到，所以用原生 checkbox
  const backendToggle = (
    <FormControlLabel
      sx={{ px: 0.75, display: 'flex', alignItems: 'center', minHeight: 30 }}
      control={
        <Checkbox
          size="small"
          sx={{ p: 0.5, '& .MuiSvgIcon-root': { fontSize: 16 } }}
          checked={backend === 'cpu'}
          onChange={(event) => setBackend(event.target.checked ? 'cpu' : 'dml')}
        />
      }
      label={<Typography variant="caption">{CPU_TOGGLE_LABEL}</Typography>}
    />
  );

  return (
    <Popover
      open
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      marginThreshold={8}
      disableAutoFocus
      disableRestoreFocus
      disableScrollLock
      PaperProps={{
        // 主题色而不是硬编码 #fff：深色预览层里继承的白字落到白底上就是一片看不见
        sx: {
          minWidth: 300,
          maxWidth: 'calc(100vw - 16px)',
          bgcolor: 'background.paper',
          color: 'text.primary',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1.5,
          boxShadow: 3
        }
      }}
    >
      <ul role="menu" aria-label={`${cap.label} 的候选模型`} onKeyDown={onKeyDown} style={{ listStyle: 'none', margin: 0, padding: '4px 0' }}>
        {models.map((model, index) => {
          const primary = primaryActionOf(model);
          return (
            <Box
              component="li"
              key={model.id}
              role="menuitem"
              ref={(el: HTMLLIElement | null) => {
                itemRefs.current[index] = el;
              }}
              // 只让当前行可被 Tab 落到，其余靠方向键换行
              tabIndex={index === active ? 0 : -1}
              onFocus={() => setActive(index)}
              sx={{
                px: 1,
                py: 0.25,
                minHeight: 34,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 0.75,
                bgcolor: model.isDefault ? 'action.selected' : index === active ? 'action.hover' : 'transparent'
              }}
            >
              <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1, fontSize: '0.82rem' }}>
                {model.displayName}
                <Box component="span" sx={{ color: 'text.secondary', ml: 0.75 }}>
                  {describeDownloadCost(model.sizeBytes).split('，')[0]}
                </Box>
              </Typography>
              <ModelStatusChip model={model} />
              {/* 不可用必须说清"为什么 + 怎么办"，只给一个灰词等于没解释（规格 §6） */}
              {model.statusReason ? (
                <Typography
                  variant="caption"
                  data-testid="model-unavailable-reason"
                  sx={{ color: 'text.secondary', flexBasis: '100%', lineHeight: 1.35 }}
                >
                  {model.statusReason}
                </Typography>
              ) : null}
              <Stack direction="row" spacing={0.5} alignItems="center">
                {/* 默认是单选：勾别行即切换，点在已勾那行不动作——没有"无默认模型"这个状态。
                    不关下拉，让用户亲眼看到高亮跟着换到新的那一行 */}
                <FormControlLabel
                  sx={{ mr: 0 }}
                  control={
                    <Checkbox
                      size="small"
                      data-testid={`model-is-default-${model.id}`}
                      aria-label={`设为默认（${model.displayName}）`}
                      checked={model.isDefault}
                      onChange={() => {
                        if (!model.isDefault) void modelAction(model.id, 'set-default');
                      }}
                      sx={{ p: 0.25, '& .MuiSvgIcon-root': { fontSize: 16 } }}
                    />
                  }
                  label={<Typography variant="caption">默认</Typography>}
                />
                <Button
                  size="small"
                  onClick={() => void modelAction(model.id, primary.action).then(onClose)}
                  data-testid={`model-action-${primary.label}`}
                  sx={{ textTransform: 'none', minWidth: 0, px: 0.75, fontSize: '0.78rem' }}
                >
                  {primary.label}
                </Button>
              </Stack>
            </Box>
          );
        })}
      </ul>
      <Divider />
      {backendToggle}
    </Popover>
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
