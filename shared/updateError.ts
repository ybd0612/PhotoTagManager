/**
 * 更新链路错误的人话化（主进程与渲染层共用这一份判定）。
 *
 * 为什么必须翻：electron-updater 6.x 发请求走的是 Chromium 的 `net.request`
 * （node_modules/electron-updater/out/electronHttpExecutor.js），失败时交回来的
 * message 就是 `net::ERR_CONNECTION_CLOSED` 这类内部码。本项目口径是
 * "错误消息给人话、错误码只留在日志里"，原文由 updaterService 完整写进 main.log。
 */
export type UpdateErrorKind = 'network' | 'no-config' | 'unknown';

export interface UpdateErrorText {
  kind: UpdateErrorKind;
  /** 面向用户的结论与下一步，不含原始错误码 */
  message: string;
}

/** 连不上、被断开、握手失败、代理故障——用户侧都是同一件事：出不了网 */
const NETWORK =
  /ERR_CONNECTION_|ERR_NETWORK_CHANGED|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY|ERR_SSL|ERR_SOCKET|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|handshake|fetch failed/i;

/** 装机版缺 app-update.yml（例如直接跑包目录里的副本）会让更新器根本没有源可查 */
const NO_CONFIG = /app-update\.yml|ENOENT|Cannot update using|no published versions|Cannot find channel/i;

/** 未知错误也要把原文带上，但一条 Chromium 堆栈不该整段糊在对话框里 */
const MAX_RAW_LEN = 160;

export function classifyUpdateError(raw: string): UpdateErrorText {
  const text = raw ?? '';
  if (NETWORK.test(text)) {
    return {
      kind: 'network',
      message:
        '连不上更新服务器（GitHub），本机照片与标签不受影响。可稍后点「重试」；若这台电脑必须经代理上网，请到「常规」分区填代理地址。'
    };
  }
  if (NO_CONFIG.test(text)) {
    return {
      kind: 'no-config',
      message: '本机缺少更新配置文件 app-update.yml，自动更新不可用。请用安装包装一遍，或到源码地址的 Releases 页手动下载。'
    };
  }
  const detail = text.length > MAX_RAW_LEN ? `${text.slice(0, MAX_RAW_LEN)}…` : text;
  return { kind: 'unknown', message: `更新没有成功：${detail || '原因未知'}。可点「重试」再查一次。` };
}
