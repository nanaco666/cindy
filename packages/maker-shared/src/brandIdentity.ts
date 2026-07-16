/**
 * brand-identity — 产品**标识符层**身份的单一事实源(构建期单点)。
 *
 * 与 `branding.ts`(展示名层,`BRAND_NAME`)互补:那边管用户/LLM 看到的名字,
 * 这边管 OS 注册身份与磁盘/协议标识符——exe 名、AppUserModelId/bundle id、
 * 深链 scheme、userData 目录名、CDN 渠道前缀、更新器产物名等。此前这些值
 * 散落在 package.json / forge.config / main 常量 / release 脚本里,改名要全仓
 * 追散点;收敛后改名只动本文件 + 出一份迁移方案。
 *
 * ⚠️ 语义边界(docs/cindy-rebrand/migration-state-machine.md §11):
 *  - 这是**构建期单点,不是运行时开关**。任何字段的取值在发布后即成为线上
 *    身份,改动任何一个字段仍然等于一次完整迁移(新更新渠道 + 迁移 manifest
 *    + 新老两端 hook)。收敛的收益是"下次改名代码 churn 归零、不会漏改散点",
 *    不是"改个配置就能热切"。
 *  - 历史兼容锚点(旧 scheme 解析、旧 userData / DB 文件识别)由
 *    `legacySchemes` / `legacyUserDataDirNames` / `legacyDbFilePrefixes`
 *    承载,只增不减:老用户机器上的存量注册与文件可能永远带着旧值。
 *  - 永久不随本配置变化的标识符(settings 键名 `xdtMaker.*`、MCP server 名
 *    `lizi_xdt_helper`、`xdt-image://` 等进程内 scheme、`.cshare` 扩展名、
 *    localStorage 键等)见 docs/cindy-rebrand/inventory.md §2 的 B 类清单,
 *    不要试图从这里派生它们。
 *
 * 消费方(收敛目标,见 docs/cindy-rebrand/inventory.md):
 *  - apps/desktop forge.config.ts(executableName / appId / protocols)
 *  - apps/desktop main 常量(AUMID、DEEP_LINK_PROTOCOL、orphan-reaper 路径
 *    标记、skillhub usageIndexer 的 userData 兜底路径、localDb 文件名前缀)
 *  - release / publish / promote / smoke 脚本(产物名、OSS 前缀)
 *  - 迁移编排生成的执行器 manifest(Rust 执行器不直接读本文件,经 manifest 注入)
 */

import { BRAND_NAME } from './branding.js';

/** 标识符层身份配置的完整形状。字段语义见各注释;全部为纯数据,零运行时逻辑。 */
export interface BrandIdentity {
  /** 展示名(与 branding.ts 的 BRAND_NAME 同源,这里仅聚合成完整档案)。 */
  readonly displayName: string;
  /** 可执行文件基名(Windows 加 .exe;mac .app bundle 名同源派生)。 */
  readonly executableName: string;
  /**
   * Windows AppUserModelId = NSIS appId = macOS bundle id。
   * ⚠️ AUMID 三位一体:NSIS appId、运行时 setAppUserModelId、快捷方式 AUMID
   * 必须逐字符一致,否则 Windows toast 通知被静默丢弃。
   */
  readonly appId: string;
  /** 自有 UTI / ProgId 等派生标识的前缀(如 `<bundleIdPrefix>.cindy` UTI)。 */
  readonly bundleIdPrefix: string;
  /** 深链主 scheme(OS 级注册,`<scheme>://session/...`)。 */
  readonly primaryScheme: string;
  /** 历史 scheme,永久保持注册 + 解析兼容(存量链接不能死)。只增不减。 */
  readonly legacySchemes: readonly string[];
  /** Electron userData 目录名(= package.json productName,Electron 默认派生)。 */
  readonly userDataDirName: string;
  /** 历史 userData 目录名(orphan-reaper 等按路径识别的消费点需匹配全量)。只增不减。 */
  readonly legacyUserDataDirNames: readonly string[];
  /** 更新分发 CDN / OSS 的一级路径前缀(渠道身份,老客户端永远只看自己的前缀)。 */
  readonly cdnPrefix: string;
  /** 更新器/迁移执行器产物基名(`<updaterName>.exe`)。 */
  readonly updaterName: string;
  /** 本地主库文件名前缀(`<dbFilePrefix>-<userId>.db`)。 */
  readonly dbFilePrefix: string;
  /** 历史主库文件名前缀；账号/品牌迁移认领旧 UID 库时只增不减。 */
  readonly legacyDbFilePrefixes: readonly string[];
  /** Windows 卸载注册表条目 DisplayName 前缀(迁移时定位老卸载键用)。 */
  readonly uninstallDisplayNamePrefix: string;
}

/**
 * 当前生效的身份档案。
 *
 * 现值 = xdt-maker 现状(接入本模块的重构必须行为零变化);切换 Cindy 时改本
 * 对象:primary* 换新值、旧值移入对应 legacy 数组(migration-state-machine.md
 * §10 已拍板的目标值:Cindy / cindy / com.magiclizi.cindy / cindy:// / Cindy /
 * cindy / cindy-updater)。
 */
export const BRAND_IDENTITY: BrandIdentity = Object.freeze({
  displayName: BRAND_NAME,
  executableName: 'xdt-maker',
  appId: 'com.magiclizi.xdt-maker',
  bundleIdPrefix: 'com.magiclizi.xdt-maker',
  primaryScheme: 'xdt-maker',
  legacySchemes: Object.freeze([]),
  userDataDirName: 'xdt-maker',
  legacyUserDataDirNames: Object.freeze([]),
  cdnPrefix: 'xdt-maker',
  updaterName: 'xdt-updater',
  dbFilePrefix: 'xdt-maker',
  legacyDbFilePrefixes: Object.freeze([]),
  uninstallDisplayNamePrefix: 'xdt-maker',
});

/** 深链需要注册/解析的全部 scheme(主 + 历史),顺序稳定:主 scheme 恒为首位。 */
export function allDeepLinkSchemes(identity: BrandIdentity = BRAND_IDENTITY): readonly string[] {
  return [identity.primaryScheme, ...identity.legacySchemes];
}

/** 按路径识别本产品 userData 的全部目录名(当前 + 历史),主目录名恒为首位。 */
export function allUserDataDirNames(identity: BrandIdentity = BRAND_IDENTITY): readonly string[] {
  return [identity.userDataDirName, ...identity.legacyUserDataDirNames];
}

/** 主库认领需要扫描的当前 + 历史文件名前缀，顺序稳定且去重。 */
export function allDbFilePrefixes(identity: BrandIdentity = BRAND_IDENTITY): readonly string[] {
  return Array.from(new Set([identity.dbFilePrefix, ...identity.legacyDbFilePrefixes]));
}
