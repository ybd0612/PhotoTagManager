// @vitest-environment jsdom
// 移到回收站：主进程侧的路径守卫 + 渲染层移除后的账目一致性。
// 盯的是"删掉之后哪里会留下对不上的数"——列表、目录计数、选中集、标签计数、预览，
// 这五处任何一处没跟着改，都是要等人肉发现的那种错。
import { describe, it, expect, beforeEach } from 'vitest';
import { isInsideRoot } from '../shared/pathGuard';
import { useAppStore, rootKey } from '../src/store/useAppStore';
import type { FolderNode, ImageFile, ScanBatch } from '../shared/types';

function folder(relPath: string, name: string, directCount: number, totalCount: number, children: FolderNode[] = []): FolderNode {
  return { relPath, name, directCount, totalCount, hidden: false, childrenLoaded: true, children };
}

function image(absPath: string, dirRelPath: string): ImageFile {
  const name = absPath.slice(absPath.lastIndexOf('/') + 1);
  return {
    id: name.replace('.', ''),
    absPath,
    relPath: dirRelPath ? `${dirRelPath}/${name}` : name,
    name,
    ext: name.slice(name.lastIndexOf('.')),
    size: 1000,
    mtimeMs: 1,
    dirRelPath,
    tags: []
  };
}

/** 每个用例用独立 rootId：nodeMap 是模块级索引，跨用例复用同一 rootId 会互相污染 */
let rootSeq = 0;

function seed(): { rootId: string; a: ImageFile; b: ImageFile; c: ImageFile; d: ImageFile } {
  const rootId = `r${++rootSeq}`;
  const scanId = `s-${rootId}`;
  const a = image('C:/Photos/a.jpg', '');
  const b = image('C:/Photos/2024/b.jpg', '2024');
  const c = image('C:/Photos/2024/01/c.jpg', '2024/01');
  const d = image('C:/Photos/2024/02/d.jpg', '2024/02');
  const leaf01 = folder('2024/01', '01', 1, 1);
  const leaf02 = folder('2024/02', '02', 1, 1);
  const year = folder('2024', '2024', 1, 3, [leaf01, leaf02]);
  const root = folder('', '', 1, 4, [year]);
  const batch: ScanBatch = {
    rootId,
    scanId,
    kind: 'data',
    batchIndex: 0,
    folders: [root],
    images: [a, b, c, d],
    stats: { scannedFiles: 10, imageCount: 4, totalFiles: 10, done: true }
  };
  const s = useAppStore.getState();
  s.resetScan(rootId, scanId);
  s.mergeScanBatch(batch);
  s.finishScan(rootId, scanId, 'done', batch.stats);
  useAppStore.setState({ selectedRootId: rootId });
  return { rootId, a, b, c, d };
}

/** 按 relPath 在树里找节点；找不到返回 -1 计数，让断言响而不是空过 */
function node(rootId: string, relPath: string): FolderNode {
  const all: FolderNode[] = [];
  const walk = (list: FolderNode[]): void => {
    for (const n of list) {
      all.push(n);
      walk(n.children);
    }
  };
  walk(useAppStore.getState().treesByRoot.get(rootId) ?? []);
  return all.find((n) => n.relPath === relPath) ?? ({ relPath, directCount: -1, totalCount: -1 } as unknown as FolderNode);
}

beforeEach(() => {
  useAppStore.setState({
    imagesByDir: new Map(),
    treesByRoot: new Map(),
    tree: [],
    selectedImages: new Set(),
    tagCache: new Map(),
    tagCounts: new Map(),
    preview: null,
    snackbar: null
  });
});

describe('shared/pathGuard —— 删除前的路径守卫', () => {
  it('根内的绝对路径放行（Windows 大小写不敏感、分隔符混用也认）', () => {
    expect(isInsideRoot('C:/Photos/a.jpg', ['C:/Photos'])).toBe(true);
    expect(isInsideRoot('C:\\PHOTOS\\sub\\a.jpg', ['c:\\photos'])).toBe(true);
  });

  it('根外一律拒绝，包括"前缀像但其实是兄弟目录"这种绕过', () => {
    expect(isInsideRoot('C:/Windows/x.jpg', ['C:/Photos'])).toBe(false);
    // C:/PhotosEvil 以 C:/Photos 开头，但它不是 C:/Photos 里面的路径
    expect(isInsideRoot('C:/PhotosEvil/x.jpg', ['C:/Photos'])).toBe(false);
  });

  it('空值、相对路径与根自身都拒绝', () => {
    expect(isInsideRoot('', ['C:/Photos'])).toBe(false);
    expect(isInsideRoot('a.jpg', ['C:/Photos'])).toBe(false);
    expect(isInsideRoot('C:/Photos', ['C:/Photos'])).toBe(false);
    expect(isInsideRoot('C:/Photos/a.jpg', [])).toBe(false);
  });
});

describe('useAppStore.removeImagesLocal —— 删完不留对不上的数', () => {
  it('图片从列表消失，且所在目录与各级祖先的计数一起减', () => {
    const { rootId, c } = seed();
    expect(node(rootId, '2024').totalCount).toBe(3);
    useAppStore.getState().removeImagesLocal([c.absPath]);

    const s = useAppStore.getState();
    expect(s.imagesByDir.get(rootKey(rootId, '2024/01')) ?? []).toEqual([]);
    expect(node(rootId, '2024/01').directCount).toBe(0);
    expect(node(rootId, '2024/01').totalCount).toBe(0);
    // 关键：不只改 imagesByDir，父级的 totalCount 必须跟着掉，否则文件夹徽标骗人
    expect(node(rootId, '2024').totalCount).toBe(2);
    expect(node(rootId, '2024').directCount).toBe(1);
  });

  it('批量删跨多个目录：各自计数分别落账', () => {
    const { rootId, a, b } = seed();
    useAppStore.getState().removeImagesLocal([a.absPath, b.absPath]);
    expect(node(rootId, '2024').directCount).toBe(0);
    expect(node(rootId, '2024').totalCount).toBe(2);
    // 根目录自己的 directCount 也掉了（a.jpg 就在根下）
    const top = useAppStore.getState().treesByRoot.get(rootId) ?? [];
    expect(top.some((n) => n.relPath === '' ? n.directCount === 0 : false)).toBe(true);
  });

  it('选中集与标签计数同步：不留"选中的已经不在了"和虚高的标签数', () => {
    const { c } = seed();
    useAppStore.getState().setTagsForPath(c.absPath, ['人像'], undefined);
    useAppStore.getState().toggleSelectImage(c.id);
    expect(useAppStore.getState().tagCounts.get('人像')).toBe(1);

    useAppStore.getState().removeImagesLocal([c.absPath]);
    const s = useAppStore.getState();
    expect(s.selectedImages.has(c.id)).toBe(false);
    expect(s.tagCache.has(c.absPath)).toBe(false);
    expect(s.tagCounts.get('人像') ?? 0).toBe(0);
  });

  it('预览里删掉当前这张：跳到下一张而不是留着一张不存在的图', () => {
    const { a, b, c } = seed();
    useAppStore.getState().setPreview(b, [a, b, c]);
    useAppStore.getState().removeImagesLocal([b.absPath]);
    const p = useAppStore.getState().preview;
    expect(p).not.toBeNull();
    expect(p?.list.map((i) => i.absPath)).toEqual([a.absPath, c.absPath]);
    expect(p?.index).toBe(1); // 原 index=1 被删，钳到剩余列表内
    expect(p?.image.absPath).toBe(c.absPath); // 当前这张跟着走，不指向已删文件
  });

  it('预览只删掉别的张：当前这张不动', () => {
    const { a, b, c } = seed();
    useAppStore.getState().setPreview(b, [a, b, c]);
    useAppStore.getState().removeImagesLocal([a.absPath]);
    const p = useAppStore.getState().preview;
    expect(p?.image.absPath).toBe(b.absPath);
    expect(p?.index).toBe(0); // 前面少了一张，索引左移
  });

  it('预览整列被删空则关闭预览', () => {
    const { a, b, c, d } = seed();
    useAppStore.getState().setPreview(a, [a, b, c, d]);
    useAppStore.getState().removeImagesLocal([a.absPath, b.absPath, c.absPath, d.absPath]);
    expect(useAppStore.getState().preview).toBeNull();
  });

  it('删不存在的路径不改变任何东西（幂等，不抛）', () => {
    const { rootId } = seed();
    const before = node(rootId, '2024').totalCount;
    useAppStore.getState().removeImagesLocal(['C:/Photos/nope.jpg']);
    expect(node(rootId, '2024').totalCount).toBe(before);
  });
});
