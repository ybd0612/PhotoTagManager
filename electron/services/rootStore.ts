import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, join } from 'path';
import type { RootEntry } from '../../shared/types';

/**
 * 根目录列表持久化存储（R10：多根 + 别名）。
 * 记录于 userData/roots.json；同路径去重（忽略大小写/尾分隔符差异）。
 * 写入采用「临时文件 + rename」保证原子性，避免崩溃导致配置损坏。
 */
export class RootStore {
  private readonly filePath: string;
  private readonly cache = new Map<string, RootEntry>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'roots.json');
  }

  /** 读取全部根目录（按添加时间排序） */
  async list(): Promise<RootEntry[]> {
    await this.load();
    return [...this.cache.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  /** 按 id 获取 */
  async get(id: string): Promise<RootEntry | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  /** 添加根目录：同路径返回已有条目；别名默认取目录名 */
  async add(path: string, alias?: string): Promise<RootEntry> {
    await this.load();
    const norm = normalizePath(path);
    for (const entry of this.cache.values()) {
      if (normalizePath(entry.path) === norm) return entry;
    }
    const id = createHash('sha1').update(path).digest('hex').slice(0, 8);
    const defaultAlias = basename(path.replace(/[\\/]+$/, '')) || path;
    const entry: RootEntry = {
      id,
      path,
      alias: alias?.trim() ? alias.trim() : defaultAlias,
      addedAt: Date.now()
    };
    this.cache.set(id, entry);
    await this.persist();
    return entry;
  }

  /** 删除根目录；返回是否删除成功 */
  async remove(id: string): Promise<boolean> {
    await this.load();
    const existed = this.cache.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  /** 修改别名；返回更新后的条目或 null（根不存在） */
  async rename(id: string, alias: string): Promise<RootEntry | null> {
    await this.load();
    const entry = this.cache.get(id);
    if (!entry) return null;
    const next: RootEntry = { ...entry, alias: alias.trim() };
    this.cache.set(id, next);
    await this.persist();
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const records = JSON.parse(raw) as RootEntry[];
      if (Array.isArray(records)) {
        for (const record of records) {
          if (record && typeof record.id === 'string' && typeof record.path === 'string') {
            this.cache.set(record.id, {
              id: record.id,
              path: record.path,
              alias: typeof record.alias === 'string' && record.alias.trim() ? record.alias : basename(record.path.replace(/[\\/]+$/, '')) || record.path,
              addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0
            });
          }
        }
      }
    } catch {
      // 首次启动文件不存在：视为空
    }
    this.loaded = true;
  }

  private persist(): Promise<void> {
    const write = this.writeChain.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const payload = JSON.stringify([...this.cache.values()], null, 2);
      await fs.writeFile(tmpPath, payload, 'utf-8');
      await fs.rename(tmpPath, this.filePath);
    });
    this.writeChain = write.catch(() => undefined);
    return write;
  }
}

/** 路径归一化：统一正斜杠、小写、去掉尾分隔符，用于同路径去重 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
