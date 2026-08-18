import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { HiddenFolderRecord } from '../../shared/types';

/**
 * 隐藏文件夹持久化存储（D2，多根隔离）。
 * 记录 (rootId + 相对根目录路径) 集合，写入 userData/hiddenFolders.json；
 * key = `${rootId}\u0000${relPath}`，避免不同根同 relPath 冲突。
 * 写入采用「临时文件 + rename」保证原子性，避免崩溃导致配置损坏。
 */
export class FolderStore {
  private readonly filePath: string;
  private readonly cache = new Map<string, HiddenFolderRecord>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'hiddenFolders.json');
  }

  /** 读取指定根目录的全部隐藏记录（按 relPath 排序） */
  async list(rootId: string): Promise<HiddenFolderRecord[]> {
    await this.load();
    return [...this.cache.values()]
      .filter((r) => r.rootId === rootId)
      .sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'));
  }

  /** 判断某目录是否被隐藏 */
  async isHidden(rootId: string, relPath: string): Promise<boolean> {
    await this.load();
    return this.cache.has(keyOf(rootId, relPath));
  }

  /** 隐藏一个目录（rootId + 相对根目录路径） */
  async hide(rootId: string, relPath: string): Promise<void> {
    await this.load();
    const key = keyOf(rootId, relPath);
    if (!this.cache.has(key)) {
      this.cache.set(key, { rootId, relPath, hiddenAt: Date.now() });
      await this.persist();
    }
  }

  /** 取消隐藏：仅清除该目录自身记录（其子目录若单独隐藏仍保持隐藏，§7） */
  async unhide(rootId: string, relPath: string): Promise<void> {
    await this.load();
    if (this.cache.delete(keyOf(rootId, relPath))) {
      await this.persist();
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const records = JSON.parse(raw) as HiddenFolderRecord[];
      if (Array.isArray(records)) {
        for (const record of records) {
          if (record && typeof record.rootId === 'string' && typeof record.relPath === 'string') {
            this.cache.set(keyOf(record.rootId, record.relPath), record);
          }
        }
      }
    } catch {
      // 首次启动文件不存在：视为空；旧版单根数据（无 rootId）忽略
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

function keyOf(rootId: string, relPath: string): string {
  return `${rootId}\u0000${relPath}`;
}
