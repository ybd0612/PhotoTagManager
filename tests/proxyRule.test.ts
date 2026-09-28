// @vitest-environment node
// 代理地址校验：设置里那个输入框与主进程共用这一份判定，所以它必须自己说得住。
import { describe, it, expect } from 'vitest';
import { sanitizeProxyRules } from '../shared/proxyRule';

describe('sanitizeProxyRules —— 合法输入', () => {
  it('留空 = 不覆盖，规范化后仍是空串', () => {
    expect(sanitizeProxyRules('')).toEqual({ ok: true, value: '' });
    expect(sanitizeProxyRules('   ')).toEqual({ ok: true, value: '' });
  });

  it('host:port 原样接受，多余空白与 http:// 前缀会被去掉', () => {
    expect(sanitizeProxyRules('127.0.0.1:7890').value).toBe('127.0.0.1:7890');
    expect(sanitizeProxyRules('  http://127.0.0.1:7890  ').value).toBe('127.0.0.1:7890');
    expect(sanitizeProxyRules('proxy.example.com:3128').value).toBe('proxy.example.com:3128');
  });
});

describe('sanitizeProxyRules —— 必须拒绝的输入', () => {
  it('带账号密码：会明文落盘，直接拒绝并说明原因', () => {
    const r = sanitizeProxyRules('http://user:pass@127.0.0.1:7890');
    expect(r.ok).toBe(false);
    expect(r.value).toBe('');
    expect(r.message).toContain('账号密码');
  });

  it('非 http 协议（socks 等）不支持', () => {
    const r = sanitizeProxyRules('socks5://127.0.0.1:1080');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('http');
  });

  it('缺端口、端口越界、端口非整数、地址含非法字符一律拒绝', () => {
    for (const bad of ['127.0.0.1', '127.0.0.1:', '127.0.0.1:0', '127.0.0.1:99999', '127.0.0.1:abc', 'local host!:8080']) {
      expect(sanitizeProxyRules(bad).ok, `「${bad}」不该被接受`).toBe(false);
    }
  });
});
