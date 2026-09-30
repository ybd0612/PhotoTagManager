// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { ThumbnailGrid } from '../src/components/ThumbnailGrid';
import { rootKey, useAppStore } from '../src/store/useAppStore';
import type { ImageFile, PhotoTagApi } from '../shared/types';

/**
 * 网格容器测尺 —— 多选条出现时网格必须跟着变矮。
 *
 * 缺陷原样：观察器只在挂载那一次绑到"首帧量尺占位 div"上，分支切到网格后那个节点被摘出文档，
 * 观察器从此不再回调，尺寸永远停在没有批量条时的高度，批量条一出现整块网格就溢出压住底部状态栏。
 * 这里不量像素（jsdom 没有排版引擎，量了也是假断言），只钉两件事：
 * ① 观察器最终绑的是当前真正挂在文档里的那个容器；② 容器高度变了，react-window 外层跟着变。
 */

const observed: HTMLElement[] = [];
let live: { el: HTMLElement; cb: (entries: { contentRect: { width: number; height: number } }[]) => void }[] = [];

/** 照抄宿主行为：只有仍连着文档、且没被 disconnect 的观察器才会上报尺寸。
 *  少了这条限制，假件会把已摘除的节点也报活，正好把要抓的 bug 放过去。 */
class FakeResizeObserver {
  private entry: (typeof live)[number] | null = null;
  constructor(cb: (entries: { contentRect: { width: number; height: number } }[]) => void) {
    this.cb = cb;
  }
  private cb: (entries: { contentRect: { width: number; height: number } }[]) => void;
  observe(el: HTMLElement): void {
    observed.push(el);
    this.entry = { el, cb: this.cb };
    live.push(this.entry);
  }
  unobserve(): void {
    if (this.entry) live = live.filter((x) => x !== this.entry);
  }
  disconnect(): void {
    if (this.entry) live = live.filter((x) => x !== this.entry);
    this.entry = null;
  }
}

/** 模拟宿主上报一次容器尺寸；没有任何存活观察器时返回 false（= 这次变更没人收到） */
function reportSize(width: number, height: number): boolean {
  const alive = live.filter((x) => x.el.isConnected);
  if (alive.length === 0) return false;
  act(() => {
    alive.forEach((x) => x.cb([{ contentRect: { width, height } }]));
  });
  return true;
}

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const api = {
  onThumbReady: vi.fn(() => () => undefined),
  getThumbnail: vi.fn(async () => ok(null)),
  readBulkTags: vi.fn(async () => ok([])),
  revealFileInExplorer: vi.fn(async () => ok(undefined)),
  trashFiles: vi.fn(async () => ok({ trashed: [], failed: [] }))
} as unknown as PhotoTagApi;

function makeImage(name: string): ImageFile {
  return {
    id: `id-${name}`,
    absPath: `C:\\Photos\\${name}`,
    relPath: name,
    name,
    ext: '.jpg',
    size: 1024,
    mtimeMs: 1,
    dirRelPath: '',
    tags: []
  };
}

beforeEach(() => {
  observed.length = 0;
  live = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('api', api);
  useAppStore.setState({
    roots: [{ id: 'r1', path: 'C:/Photos', alias: '照片', addedAt: 1 }],
    selectedRootId: 'r1',
    selectedDir: '',
    tree: [],
    imagesByDir: new Map([[rootKey('r1', ''), [makeImage('a.jpg'), makeImage('b.jpg')]]]),
    scannedRoots: new Set(['r1']),
    tagCache: new Map(),
    selectedImages: new Set()
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** react-window 的外层滚动容器：它的高度就是传给 FixedSizeGrid 的 height */
function gridOuter(container: HTMLElement): HTMLElement {
  const outer = container.firstElementChild as HTMLElement | null;
  expect(outer, '容器里没有网格外层').toBeTruthy();
  return outer as HTMLElement;
}

describe('网格容器测尺', () => {
  it('首帧量尺分支切到网格后，观察器跟着改绑到仍在文档里的容器', () => {
    render(<ThumbnailGrid />);
    // 首帧 size 为 0，走的是量尺占位分支；宿主上报一次后切进网格分支
    expect(observed).toHaveLength(1);
    expect(reportSize(1000, 696)).toBe(true);

    const container = observed[observed.length - 1];
    expect(container.isConnected, '观察器仍绑在已被摘除的节点上').toBe(true);
    expect(container.className).toContain('overflow-hidden');
    expect(gridOuter(container).style.height).toBe('696px');
  });

  it('多选条出现把容器压矮，网格外层必须跟着变矮（否则溢出压住状态栏）', () => {
    render(<ThumbnailGrid />);
    reportSize(1000, 696);
    const container = observed[observed.length - 1];

    const card = document.querySelector('[aria-label^="打开图片预览："]') as HTMLElement;
    fireEvent.click(card, { ctrlKey: true });
    // 批量条真的渲染出来了，这条用例才不是在空跑
    expect(document.querySelector('input[placeholder="输入标签，回车批量添加"]')).toBeTruthy();

    // 批量条占掉 55.6px，宿主把新高度报给观察器
    expect(reportSize(1000, 640)).toBe(true);
    expect(gridOuter(container).style.height).toBe('640px');
  });

  it('取消全部选择后容器长回来，网格也跟着长回来', () => {
    render(<ThumbnailGrid />);
    reportSize(1000, 696);
    const container = observed[observed.length - 1];
    const card = document.querySelector('[aria-label^="打开图片预览："]') as HTMLElement;
    fireEvent.click(card, { ctrlKey: true });
    reportSize(1000, 640);
    expect(gridOuter(container).style.height).toBe('640px');

    // 网格重渲染过，卡片节点已换过一批，必须重新取
    const sameCard = document.querySelector('[aria-label^="打开图片预览："]') as HTMLElement;
    fireEvent.click(sameCard, { ctrlKey: true });
    expect(document.querySelector('input[placeholder="输入标签，回车批量添加"]')).toBeNull();
    expect(reportSize(1000, 696)).toBe(true);
    expect(gridOuter(container).style.height).toBe('696px');
  });
});
