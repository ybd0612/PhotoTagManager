// 批次1 的纯函数：文件名搜索 + 排序。先红后绿。
import { describe, it, expect } from 'vitest';
import { matchName, sortImages, THUMB_SIZES, type SortKey, type SortDir } from '../src/utils/viewFilters';
import type { ImageFile } from '../shared/types';

function img(name: string, over: Partial<ImageFile> = {}): ImageFile {
  return {
    id: name,
    absPath: `C:/P/${name}`,
    relPath: name,
    name,
    ext: name.slice(name.lastIndexOf('.')),
    size: 1000,
    mtimeMs: 1000,
    dirRelPath: '',
    tags: [],
    ...over
  };
}

describe('utils/viewFilters.matchName —— 文件名搜索', () => {
  const list = [img('PixPin_2025-07-16.png'), img('照片 海边.jpg'), img('Readme.md')];

  it('空查询原样返回同一批（不复制不重排）', () => {
    expect(matchName(list, '')).toEqual(list);
    expect(matchName(list, '   ')).toEqual(list);
  });

  it('子串匹配大小写不敏感，中文也能搜', () => {
    expect(matchName(list, 'pixpin').map((i) => i.name)).toEqual(['PixPin_2025-07-16.png']);
    expect(matchName(list, '海边').map((i) => i.name)).toEqual(['照片 海边.jpg']);
    expect(matchName(list, 'MD').map((i) => i.name)).toEqual(['Readme.md']);
  });

  it('没匹配到就是空数组（界面要能区分"没匹配"与"目录本来就空"）', () => {
    expect(matchName(list, '不存在的词')).toEqual([]);
  });
});

describe('utils/viewFilters.sortImages —— 排序', () => {
  const a = img('b.jpg', { mtimeMs: 300, size: 50 });
  const b = img('a.jpg', { mtimeMs: 100, size: 900 });
  const c = img('c.jpg', { mtimeMs: 200, size: 500 });
  const list = [a, b, c];

  it.each<[SortKey, SortDir, string[]]>([
    ['name', 'asc', ['a.jpg', 'b.jpg', 'c.jpg']],
    ['name', 'desc', ['c.jpg', 'b.jpg', 'a.jpg']],
    // fixture：a.jpg mtime100/size900，b.jpg mtime300/size50，c.jpg mtime200/size500
    ['time', 'asc', ['a.jpg', 'c.jpg', 'b.jpg']],
    ['time', 'desc', ['b.jpg', 'c.jpg', 'a.jpg']],
    ['size', 'asc', ['b.jpg', 'c.jpg', 'a.jpg']],
    ['size', 'desc', ['a.jpg', 'c.jpg', 'b.jpg']]
  ])('%s / %s', (key, dir, want) => {
    expect(sortImages(list, key, dir).map((i) => i.name)).toEqual(want);
  });

  it('不改动传入数组（渲染层的 memo 依赖引用不变会算错）', () => {
    const before = list.map((i) => i.name);
    sortImages(list, 'size', 'desc');
    expect(list.map((i) => i.name)).toEqual(before);
  });

  it('三档缩略图尺寸是递增的具体像素值', () => {
    expect(THUMB_SIZES.small).toBeLessThan(THUMB_SIZES.medium);
    expect(THUMB_SIZES.medium).toBeLessThan(THUMB_SIZES.large);
  });
});
