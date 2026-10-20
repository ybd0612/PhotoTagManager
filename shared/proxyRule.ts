/**
 * 网络代理地址的规范化与校验（设置里那个输入框与主进程共用这一份判定）。
 *
 * 为什么只收 `host:port`：
 * - 带账号密码的写法（`http://user:pass@host:port`）会被明文写进 `settings.json`，
 *   等于把凭据留在磁盘上；这类用户应当走系统代理，而不是本应用的这个输入框。
 * - 本应用使用单一 HTTP 代理出口（例如检查更新），不支持 PAC / socks 混配，
 *   与其做一个填对了才有用的复杂语法，不如只认一种写法并明确拒绝其它。
 *
 * 留空 = 不做任何代理设置（跟随系统默认）。这不是"直连"：Chromium 仍会用它自己的
 * 系统代理判定，只是本应用不覆盖它。
 */
export interface ProxyRuleResult {
  ok: boolean;
  /** 规范化后可直接交给 Electron `session.setProxy({ proxyRules })` 的值 */
  value: string;
  /** 面向用户的说明；ok 为 false 时这是唯一要展示的话 */
  message?: string;
}

const HOST = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export function sanitizeProxyRules(raw: string): ProxyRuleResult {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { ok: true, value: '' };

  let body = trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(body)) {
    const scheme = body.slice(0, body.indexOf('://')).toLowerCase();
    if (scheme !== 'http') {
      return { ok: false, value: '', message: '只支持 http 代理，请填形如 127.0.0.1:7890 的地址。' };
    }
    body = body.slice(body.indexOf('://') + 3);
  }
  if (body.includes('@')) {
    return {
      ok: false,
      value: '',
      message: '代理地址不要带账号密码（会明文存在配置文件里）。请填不带认证的地址，或改用系统代理。'
    };
  }
  const idx = body.lastIndexOf(':');
  if (idx <= 0 || idx === body.length - 1) {
    return { ok: false, value: '', message: '请填写「地址:端口」，例如 127.0.0.1:7890。' };
  }
  const host = body.slice(0, idx);
  const port = Number(body.slice(idx + 1));
  if (!HOST.test(host)) {
    return { ok: false, value: '', message: '代理地址只能包含字母、数字、点、短横，例如 127.0.0.1 或 proxy.example.com。' };
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, value: '', message: '代理端口必须是 1–65535 之间的整数。' };
  }
  return { ok: true, value: `${host}:${port}` };
}
