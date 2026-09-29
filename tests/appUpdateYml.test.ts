// @vitest-environment node
// app:go 补写的 resources/app-update.yml 必须和 electron-builder 打 nsis 包时写出来的那份一致。
// 这条是 2026-09-29 那条 ENOENT 的防线：`--win dir` 不生成该文件（PublishManager 的
// isSuitableWindowsTarget 只认 nsis/nsis-*），补写内容若与上游口径漂移，副本里查更新照样失败。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { buildAppUpdateYml, writeAppUpdateYml } = require('../scripts/write-app-update-yml.cjs') as {
  buildAppUpdateYml: (pkg: unknown, override?: string) => string;
  writeAppUpdateYml: (dir: string, yaml: string) => string;
};

const repoPkg = require('../package.json');

/** 正文只有 `key: value` 一行一项，手工解析即可，不为此引 transitive 的 js-yaml */
function parseSimpleYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    expect(i, `不是 key: value 行：${line}`).toBeGreaterThan(-1);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

describe('app-update.yml 补写', () => {
  it('从本仓库 package.json 派生出的坐标与上游写进装机版的五行一致', () => {
    expect(parseSimpleYaml(buildAppUpdateYml(repoPkg))).toEqual({
      provider: 'github',
      owner: 'ybd0612',
      repo: 'PhotoTagManager',
      releaseType: 'release',
      updaterCacheDirName: 'photo-tag-manager-updater',
    });
  });

  it('publish 坐标缺失时报错，而不是写出一个没有更新源的空文件', () => {
    expect(() => buildAppUpdateYml({ name: 'photo-tag-manager', build: {} })).toThrowError(/build\.publish/);
    // 包名含大写或非法字符时，推导规则不再等价于上游的 sanitizeFileName，必须停下而不是猜
    expect(() =>
      buildAppUpdateYml({ name: 'Photo Tag', build: { publish: { provider: 'github' } } })
    ).toThrowError(/updaterCacheDirName/);
  });

  it('resources 目录不存在就拒绝写入（解包失败时不能静默续跑）', () => {
    const missing = path.join(os.tmpdir(), `ptm-no-such-resources-${Date.now()}`);
    expect(() => writeAppUpdateYml(missing, 'provider: github\n')).toThrowError(/目录不存在/);
  });

  it('写进去的字节读回来仍是那五行', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-app-update-'));
    const file = writeAppUpdateYml(dir, buildAppUpdateYml(repoPkg));
    expect(path.basename(file)).toBe('app-update.yml');
    expect(parseSimpleYaml(fs.readFileSync(file, 'utf8'))).toEqual(parseSimpleYaml(buildAppUpdateYml(repoPkg)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 装机版是真实参照：这台机器上装过才可比，没装过就跳过并说明
  const installed = 'C:/Program Files/PhotoTagManager/resources/app-update.yml';
  const against = fs.existsSync(installed) ? it : it.skip;
  against('与本机装机版（nsis 真产物）逐键相等', () => {
    expect(parseSimpleYaml(buildAppUpdateYml(repoPkg))).toEqual(parseSimpleYaml(fs.readFileSync(installed, 'utf8')));
  });
});
