/**
 * migration/targetIdentity — 迁移目标品牌(Cindy)的身份常量与路径派生。
 *
 * 与 maker-shared 的 BRAND_IDENTITY 区分:那边是**本构建自身**的身份
 * (过渡版仍是 xdt-maker),这边是**迁移 campaign 目标**的身份——两者只在
 * 过渡版里同时存在。目标值为 §10 决策 1 拍板基线;Cindy 构建自身发布时,
 * 这些值会成为其 BRAND_IDENTITY 主值。
 *
 * 路径派生规则(实机核实,inventory.md):
 *  - Windows:NSIS per-user 安装到 `%LOCALAPPDATA%\Programs\<app>`,
 *    userData 为 `%APPDATA%\<userDataDirName>`(Electron 默认派生);
 *  - macOS:`/Applications/<displayName>.app`,userData 为
 *    `~/Library/Application Support/<userDataDirName>`;
 *    Mach-O 名 = packagerConfig.executableName(本契约中的 `app`)，不跟 productName。
 */

import path from 'node:path';

/** 迁移目标品牌的静态身份(构建期常量)。 */
export interface MigrationTargetBrand {
  /** 机器可读短名(exe 基名 / 安装目录名)。 */
  readonly app: string;
  /** 展示名(mac .app 名)。 */
  readonly displayName: string;
  /** Electron userData 目录名(= 目标 package.json productName 派生)。 */
  readonly userDataDirName: string;
}

/** §10 决策 1:Cindy / cindy(.exe) / userData `Cindy`。 */
export const CINDY_TARGET_BRAND: MigrationTargetBrand = Object.freeze({
  app: 'cindy',
  displayName: 'Cindy',
  userDataDirName: 'Cindy',
});

export interface TargetPathContext {
  platform: NodeJS.Platform;
  /** Electron `app.getPath('appData')`(win %APPDATA% / mac ~/Library/Application Support)。 */
  appDataDir: string;
  /** win 专用:`%LOCALAPPDATA%`(mac 传空串即可)。 */
  localAppDataDir: string;
}

export interface ResolvedTargetPaths {
  installDir: string;
  userDataDir: string;
  /** win 为 `<app>.exe`;mac 为 Mach-O 名(= packager executableName / `app`)。 */
  exeName: string;
}

/** 从品牌常量 + 平台上下文派生目标安装/数据路径(纯函数)。 */
export function resolveTargetPaths(
  brand: MigrationTargetBrand,
  ctx: TargetPathContext,
): ResolvedTargetPaths {
  if (ctx.platform === 'win32') {
    return {
      installDir: path.win32.join(ctx.localAppDataDir, 'Programs', brand.app),
      userDataDir: path.win32.join(ctx.appDataDir, brand.userDataDirName),
      exeName: `${brand.app}.exe`,
    };
  }
  return {
    installDir: `/Applications/${brand.displayName}.app`,
    userDataDir: path.posix.join(ctx.appDataDir, brand.userDataDirName),
    exeName: brand.app,
  };
}
