import { join } from 'path';

/**
 * userData 目录名必须钉死（U4）。
 *
 * 实测发现同一台机器上并存两份数据目录：
 * - `%APPDATA%\photo-tag-manager`（在用：根目录与应用偏好）
 * - `%APPDATA%\PhotoTagManager`（孤儿：只有一条根）
 *
 * 根因是 Electron 的 `app.getName()` 取 `package.json` 的 **name**（`photo-tag-manager`），
 * 而 electron-builder 的安装项 / appId / 卸载注册表用的是 **build.productName**（`PhotoTagManager`）。
 * 顶层 `productName` 一旦被人补上、或 Electron 改了默认取值，userData 就会换目录——
 * 用户看到的就是"根目录和应用偏好凭空消失"（数据没丢，只是去另一个目录读了），
 * 而界面上完全看不出原因。所以这里把名字写死并说明**不许改**。
 */
export const USER_DATA_DIR_NAME = 'photo-tag-manager';

/** 由 appData 拼出 userData 路径。抽成纯函数是为了能在单测里钉住那个名字 */
export function userDataDirFor(appData: string): string {
  return join(appData, USER_DATA_DIR_NAME);
}

/** 历史遗留的另一份目录名（大小写形式）。只用于启动时探测告警，绝不自动合并 */
export function legacyUserDataDirFor(appData: string): string {
  return join(appData, 'PhotoTagManager');
}
