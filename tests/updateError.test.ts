// 更新错误的人话化：界面给人话，原始码只留日志。
// 反面断言（message 里不得再出现 net:: / ENOENT）才是这条规则能失败的证据——
// 只测"包含连不上"的话，把 classifyUpdateError 换回模板字符串 `${detail}` 也照样绿。
import { describe, it, expect } from 'vitest';
import { classifyUpdateError } from '../shared/updateError';

describe('更新错误分类', () => {
  it('Chromium 断连类错误归为 network，并给出可执行的下一步', () => {
    for (const raw of [
      'net::ERR_CONNECTION_CLOSED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_TIMED_OUT',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'Error: read ECONNRESET'
    ]) {
      const r = classifyUpdateError(raw);
      expect(r.kind, raw).toBe('network');
      expect(r.message).toContain('GitHub');
      expect(r.message).toContain('重试');
    }
  });

  it('缺 app-update.yml 归为 no-config，说清要重装或手动下载', () => {
    const r = classifyUpdateError("ENOENT: no such file or directory, open 'app-update.yml'");
    expect(r.kind).toBe('no-config');
    expect(r.message).toContain('app-update.yml');
    expect(r.message).toContain('安装');
  });

  it('认不出的错误保留原文但不无限长，且仍给"重试"', () => {
    const long = 'X'.repeat(400);
    const r = classifyUpdateError(long);
    expect(r.kind).toBe('unknown');
    expect(r.message.length).toBeLessThan(220);
    expect(r.message).toContain('重试');
  });

  it('不该发生：界面上仍露出内部错误码（人话化的整条理由）', () => {
    for (const raw of ['net::ERR_CONNECTION_CLOSED', "ENOENT: open 'app-update.yml'"]) {
      expect(classifyUpdateError(raw).message).not.toMatch(/net::|ENOENT/);
    }
  });
});
