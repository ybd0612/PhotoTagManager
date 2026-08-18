import { useEffect, useRef, useState } from 'react';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import type { ThumbnailResult } from '../../shared/types';

/**
 * 缩略图加载 hook（D4 性能策略②）：
 * - 仅请求可视区 absPath（调用方传可视区列表）
 * - 命中内存缓存跳过；订阅 thumb:ready 增量更新
 * - 同时按需批量读取可视区图片的 XMP 标签（Q7：点击目录/预览时才读取）
 */
export function useThumbnails(absPaths: string[]): {
  thumbnails: Map<string, ThumbnailResult>;
} {
  const [thumbnails, setThumbnails] = useState<Map<string, ThumbnailResult>>(new Map());
  const requestedThumbs = useRef<Set<string>>(new Set());
  const requestedTags = useRef<Set<string>>(new Set());

  // 订阅主进程缩略图生成完成推送（幂等：同一 absPath 覆盖更新）
  useEffect(() => {
    return getApi().onThumbReady((thumb) => {
      setThumbnails((prev) => {
        const next = new Map(prev);
        next.set(thumb.absPath, thumb);
        return next;
      });
    });
  }, []);

  // 请求缺失缩略图（仅一次）
  useEffect(() => {
    const missing = absPaths.filter((p) => !requestedThumbs.current.has(p));
    if (missing.length === 0) return;
    missing.forEach((p) => requestedThumbs.current.add(p));
    let cancelled = false;

    void (async () => {
      for (const absPath of missing) {
        try {
          const result = await call(getApi().getThumbnail(absPath));
          if (!cancelled && result) {
            setThumbnails((prev) => {
              const next = new Map(prev);
              next.set(absPath, result);
              return next;
            });
          }
        } catch {
          // 失败不重试：组件层用占位图兜底
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [absPaths]);

  // 按需批量读取可视区标签（写入 tagCache / tagCounts）
  const tagCache = useAppStore((s) => s.tagCache);
  const tagEpoch = useAppStore((s) => s.tagEpoch);
  // 标签重命名/合并后失效已请求集合，允许重新按需读取
  useEffect(() => {
    requestedTags.current.clear();
  }, [tagEpoch]);

  useEffect(() => {
    const missing = absPaths.filter((p) => !tagCache.has(p) && !requestedTags.current.has(p));
    if (missing.length === 0) return;
    missing.forEach((p) => requestedTags.current.add(p));
    let cancelled = false;

    void (async () => {
      try {
        const results = await call(getApi().readBulkTags(missing));
        if (!cancelled) {
          useAppStore.getState().setTagsForImages(results);
        }
      } catch {
        // 标签读取失败不阻塞浏览
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [absPaths, tagCache, tagEpoch]);

  return { thumbnails };
}
