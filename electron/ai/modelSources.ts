/**
 * 模型下载源与失败分类（2026-09-28 加 ModelScope 为第一源）。
 *
 * 为什么清单里不再存整条 URL，而存 `repoId + filePath`：
 * 两个源都是按 HuggingFace 的「命名空间/仓库名」组织的，同一份权重在两边的路径只差在域名与
 * 分支名（ModelScope 用 master，hf-mirror 用 main）。存一份仓库坐标 + 按固定顺序展开成多个 URL，
 * 加模型就只填一次，不会出现"两个源的条目各改各的、最后指向不同文件"。
 *
 * 顺序就是优先级：实测本机 ModelScope 直连 282ms / 2.8 MB/s，hf-mirror 直连超时（只有走代理才通）。
 *
 * 失败必须分类，因为「这个源上没有这个仓库」和「这台机器出不去」是两件完全不同的事，
 * 混成一句"下载失败，请检查网络"会把网络正常的用户送去折腾代理。
 */

export type SourceId = 'modelscope' | 'hf-mirror';

export interface RepoRef {
  /** HuggingFace 风格的「命名空间/仓库名」，两个源共用 */
  repoId: string;
  /** 仓库内文件路径 */
  filePath: string;
}

export interface SourceTarget extends RepoRef {
  source: SourceId;
  url: string;
}

/** 允许的域名白名单：清单守卫检查用它，防止有人把 URL 写成别的站点 */
export const ALLOWED_SOURCE_HOSTS = ['modelscope.cn', 'hf-mirror.com'] as const;

const TEMPLATES: Array<{ id: SourceId; build: (ref: RepoRef) => string }> = [
  { id: 'modelscope', build: (r) => `https://modelscope.cn/models/${r.repoId}/resolve/master/${r.filePath}` },
  { id: 'hf-mirror', build: (r) => `https://hf-mirror.com/${r.repoId}/resolve/main/${r.filePath}` }
];

/** 按优先级展开成可尝试的 URL 列表。顺序即降级顺序。 */
export function sourceTargets(ref: RepoRef): SourceTarget[] {
  return TEMPLATES.map((t) => ({ source: t.id, ...ref, url: t.build(ref) }));
}

/** 下载失败的类别 */
export type DownloadFailure = 'not-found' | 'unreachable' | 'corrupt' | 'cancelled';

/** HTTP 状态 → 类别；成功返回 null */
export function classifyHttpStatus(status: number): DownloadFailure | null {
  if (status === 200 || status === 206) return null;
  if (status === 404 || status === 403 || status === 451) return 'not-found';
  if (status >= 500) return 'unreachable';
  return 'unreachable';
}

/** 抛出来的异常 → 类别。用户主动取消单独一类，不能算成网络问题 */
export function classifyFetchError(err: unknown): DownloadFailure {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'AbortError') return 'cancelled';
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/ERR_TIMED_OUT|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|fetch failed|ERR_PROXY|ERR_NAME/i.test(text)) {
    return 'unreachable';
  }
  return 'unreachable';
}

/**
 * 把所有源的失败汇总成一句给人看的话。
 * 判定顺序刻意把"连不上"放在最前：只有网络类失败才该提示去配代理，
 * 仓库不存在是清单问题，让用户查代理只会浪费时间。
 */
export function describeDownloadFailure(
  ref: RepoRef,
  failures: Array<{ source: SourceId; failure: DownloadFailure }>
): string {
  const kinds = new Set(failures.map((f) => f.failure));
  if (kinds.has('cancelled')) return '下载已取消';
  if (kinds.has('unreachable')) {
    return (
      `连不上模型服务器（${failures.map((f) => f.source).join('、')} 都试过了）。` +
      '这台机器可能需要代理才能访问外网：可在「设置 → 常规 → 网络代理」里填写代理地址（形如 127.0.0.1:7890）后重试。'
    );
  }
  if (kinds.has('not-found')) {
    return `两个下载源上都没有这个模型仓库「${ref.repoId}」，这是清单配置问题，与你的网络无关，请联系开发者核对仓库路径。`;
  }
  return `下载的内容校验不通过（sha256 与清单不一致），已丢弃。可以再试一次；反复失败请把这条截图反馈给开发者。`;
}
