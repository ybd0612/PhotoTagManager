// modelStore 单测：下载 / 断点续传 / sha256 校验 / 磁盘预检 / 本地索引 / 删除回收。
// 用真实本地 http server，不打网络也不 mock fetch —— 续传语义只有真跑一遍才算验。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { mkdtemp, rm, readdir, stat, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

import { configureAiPaths, resetAiPaths, modelDir, modelsDir, indexFile } from '../../electron/ai/paths';
import { ModelStore, type ModelDownloadSpec } from '../../electron/ai/modelStore';

/** 64KB 确定性内容 */
function makePayload(): Buffer {
  const buf = Buffer.alloc(64 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) % 251;
  return buf;
}

const PAYLOAD = makePayload();
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

interface ServerState {
  /** 每次请求收到的 Range 头，用于断言续传真的发生了 */
  rangeHeaders: (string | undefined)[];
  requestCount: number;
  /** 前 N 次请求在传完部分字节后强行掐断连接 */
  truncateFirst: number;
  bytesBeforeTruncate: number;
}

const state: ServerState = { rangeHeaders: [], requestCount: 0, truncateFirst: 0, bytesBeforeTruncate: 0 };
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      state.requestCount += 1;
      const rangeHeader = req.headers.range;
      state.rangeHeaders.push(typeof rangeHeader === 'string' ? rangeHeader : undefined);

      let body = PAYLOAD;
      let status = 200;
      if (typeof rangeHeader === 'string') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        const from = m && m[1] ? Number(m[1]) : 0;
        if (from < PAYLOAD.length) {
          body = PAYLOAD.subarray(from);
          status = 206;
          res.setHeader('Content-Range', `bytes ${from}-${PAYLOAD.length - 1}/${PAYLOAD.length}`);
        }
      }
      res.writeHead(status, { 'Content-Length': String(body.length), 'Content-Type': 'application/octet-stream' });
      if (state.requestCount > state.truncateFirst) {
        res.end(body);
        return;
      }
      // 只发一截然后掐断 socket，模拟下载中断
      const cut = Math.min(state.bytesBeforeTruncate || Math.floor(body.length / 2), body.length);
      res.write(body.subarray(0, cut), () => {
        res.socket?.destroy();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}/model.onnx`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let userData = '';
const spec: ModelDownloadSpec = {
  id: 'fixture-model',
  repoId: 'fixture-ns/ptm-model',
  filePath: 'onnx/model.onnx',
  fileName: 'model.onnx',
  sizeBytes: PAYLOAD.length,
  sha256: PAYLOAD_SHA256
};

/**
 * 注入一个把任意源地址改写到本地真服务器的 fetch：
 * 保留 Range 与掐断 socket 这些真实语义（续传只有真跑一遍才算验），
 * 同时让 modelStore 自己按「ModelScope → hf-mirror」的顺序去拼 URL。
 */
const localFetch: typeof fetch = (input, init) => fetch(baseUrl, init);

function storeWith(freeBytes: number | null = null): ModelStore {
  return new ModelStore({
    fetchImpl: localFetch,
    ...(freeBytes === null ? {} : { freeBytesProbe: async () => freeBytes })
  });
}

async function readIndex(): Promise<{ models?: Record<string, { sha256: string; sizeBytes: number; path: string }> }> {
  try {
    return JSON.parse(await readFile(indexFile(), 'utf8'));
  } catch {
    return {};
  }
}

beforeEach(async () => {
  resetAiPaths();
  userData = await mkdtemp(join(tmpdir(), 'ptm-model-store-'));
  configureAiPaths(userData);
  state.rangeHeaders = [];
  state.requestCount = 0;
  state.truncateFirst = 0;
  state.bytesBeforeTruncate = 0;
});

afterEach(async () => {
  resetAiPaths();
  if (userData) await rm(userData, { recursive: true, force: true });
});

describe('ai/modelStore —— 下载与本地索引', () => {
  it('① 首次下载：写 .part → 校验 sha256 → 改名就位，不留临时文件', async () => {
    const result = await storeWith().download(spec);
    expect(existsSync(result.path)).toBe(true);
    expect((await stat(result.path)).size).toBe(PAYLOAD.length);
    expect(result.cacheHit).toBe(false);
    expect(await readdir(modelDir(spec.id))).toEqual([spec.fileName]);
  });

  it('第一个源上没有这个仓库时，自动降级到第二个源并成功', async () => {
    const tried: string[] = [];
    const store = new ModelStore({
      fetchImpl: (input, init) => {
        const url = String(input);
        tried.push(url);
        // 第一源（ModelScope）报 404，第二源交给本地真服务器
        if (tried.length === 1) return Promise.resolve(new Response(null, { status: 404 }));
        return fetch(baseUrl, init);
      }
    });
    const result = await store.download(spec);
    expect(result.sizeBytes).toBe(PAYLOAD.length);
    expect(tried[0]).toContain('modelscope.cn');
    expect(tried.length).toBe(2);
  });

  it('两个源都连不上时说的是"需要代理"，而不是含糊的下载失败', async () => {
    const store = new ModelStore({
      fetchImpl: () => Promise.reject(new Error('fetch failed: ETIMEDOUT'))
    });
    await expect(store.download(spec)).rejects.toThrow(/代理/);
  });

  it('禁止直接写最终文件名：中断后目标目录里只允许出现 .part', async () => {
    state.truncateFirst = 99;
    await expect(storeWith().download(spec)).rejects.toBeTruthy();
    const files = await readdir(modelDir(spec.id));
    expect(files).not.toContain(spec.fileName);
    expect(files.some((f) => f.endsWith('.part'))).toBe(true);
  });

  it('② 中断后重下从断点续：第三次请求必须带 Range，结果字节完整', async () => {
    state.truncateFirst = 2;
    await expect(storeWith().download(spec)).rejects.toBeTruthy();

    const partial = (await readdir(modelDir(spec.id))).find((f) => f.endsWith('.part'))!;
    const partialSize = (await stat(join(modelDir(spec.id), partial))).size;
    expect(partialSize).toBeGreaterThan(0);

    const result = await storeWith().download(spec);
    expect(state.requestCount).toBe(3);
    expect(state.rangeHeaders[0]).toBeUndefined();
    expect(state.rangeHeaders[1]).toBe(`bytes=${Math.floor(PAYLOAD.length / 2)}-`);
    expect(state.rangeHeaders[2]).toBe(`bytes=${partialSize}-`);
    const onDisk = await readFile(result.path);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(PAYLOAD_SHA256);
  });

  it('③ 两个源的 sha256 都不符：丢弃文件并报校验失败，索引不留条目', async () => {
    const bad: ModelDownloadSpec = { ...spec, sha256: '0'.repeat(64) };
    await expect(storeWith().download(bad)).rejects.toThrow(/校验不通过/);
    const dir = modelDir(bad.id);
    expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);
    expect((await readIndex()).models?.[bad.id]).toBeUndefined();
    expect(await storeWith().status(bad.id)).toBe('absent');
  });

  it('③ 换源后校验通过：清掉首源坏文件，只留下正确模型', async () => {
    const tried: string[] = [];
    const store = new ModelStore({
      fetchImpl: (input, init) => {
        tried.push(String(input));
        if (tried.length === 1) {
          return Promise.resolve(new Response(Buffer.from('bad'), { status: 200 }));
        }
        return Promise.resolve(new Response(PAYLOAD, {
          status: 200,
          headers: { 'Content-Length': String(PAYLOAD.length) }
        }));
      }
    });

    const result = await store.download(spec);
    const files = await readdir(modelDir(spec.id));
    const onDisk = await readFile(result.path);
    expect(tried).toHaveLength(2);
    expect(tried[0]).toContain('modelscope.cn');
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(PAYLOAD_SHA256);
    expect(files).toEqual([spec.fileName]);
  });

  it('④ 可用磁盘不足时在发起请求前拒绝（服务器一次请求都不该收到）', async () => {
    await expect(storeWith(PAYLOAD.length + 1).download(spec)).rejects.toThrow(/磁盘/);
    expect(state.requestCount).toBe(0);
  });

  it('⑤ status 三态：absent → downloading → present', async () => {
    const store = storeWith();
    expect(await store.status(spec.id)).toBe('absent');

    state.truncateFirst = 2;
    state.bytesBeforeTruncate = 1024;
    const pending = store.download(spec);
    // 下载标记在任何 await 之前就置位，所以此处必然看到 downloading
    expect(await store.status(spec.id)).toBe('downloading');
    await expect(pending).rejects.toBeTruthy();
    expect(await store.status(spec.id)).toBe('absent');

    await storeWith().download(spec);
    expect(await store.status(spec.id)).toBe('present');
  });

  it('⑥ 删除同时清临时文件与索引条目，不留孤儿', async () => {
    await storeWith().download(spec);
    await mkdir(modelDir(spec.id), { recursive: true });
    await writeFile(join(modelDir(spec.id), 'model.onnx.part'), 'junk');
    expect(await storeWith().status(spec.id)).toBe('present');

    await storeWith().remove(spec.id);
    expect((await readIndex()).models?.[spec.id]).toBeUndefined();
    expect(existsSync(modelDir(spec.id))).toBe(false);
    expect(await storeWith().status(spec.id)).toBe('absent');
  });

  it('索引记录真实路径 / 体积 / 指纹，供 UI 与缓存键取用', async () => {
    await storeWith().download(spec);
    const entry = (await readIndex()).models?.[spec.id];
    expect(entry?.sha256).toBe(PAYLOAD_SHA256);
    expect(entry?.sizeBytes).toBe(PAYLOAD.length);
    expect(entry?.path).toBe(join(modelsDir(), spec.id, spec.fileName));
  });

  it('进度只报已收 / 总量，不提供任何"预计还需多久"（实测速率 0.39~1.27 MB/s 波动大）', async () => {
    const seen: Record<string, unknown>[] = [];
    const store = new ModelStore({ fetchImpl: localFetch, onProgress: (p) => seen.push(p as unknown as Record<string, unknown>) });
    await store.download(spec);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(typeof p.receivedBytes).toBe('number');
      expect(p.totalBytes).toBe(PAYLOAD.length);
      for (const forbidden of ['eta', 'etaSeconds', 'remainingSeconds', 'estimatedRemaining', 'speed']) {
        expect(p).not.toHaveProperty(forbidden);
      }
    }
  });

  it('取消下载报"已取消"且不写索引', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(storeWith().download(spec, ac.signal)).rejects.toThrow(/取消/);
    expect((await readIndex()).models?.[spec.id]).toBeUndefined();
  });

  it('重复下载同一个已就位的模型不再联网', async () => {
    await storeWith().download(spec);
    const before = state.requestCount;
    const again = await storeWith().download(spec);
    expect(state.requestCount).toBe(before);
    expect(again.cacheHit).toBe(true);
  });
});
