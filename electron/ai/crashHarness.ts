import { ChildRunner, makeUtilityProcessSpawner } from './runner';

/**
 * 崩溃恢复探针专用的构建入口（`npm run verify:ai-crash`），**不打包进产品**。
 *
 * 存在的理由：§8-18 要证明的是"发布代码在子进程真死时会恢复"。探针若自带一份
 * runner 副本，跑绿了也只证明副本，不证明 `out/main/index.js` 里那一份。
 * 这里把生产的 `ChildRunner` + utilityProcess 适配器原样暴露给 .cjs 探针使用。
 */
export const production = { ChildRunner, makeUtilityProcessSpawner };
export { ChildRunner, makeUtilityProcessSpawner };
