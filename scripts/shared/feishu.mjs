// =============================================================================
// 飞书生产 App 的公共标识 — 单一来源(single source of truth)。
//
// FEISHU_APP_ID 是飞书 OAuth 的公共 client id,不是密钥(app secret 只在 server
// 端持有并兑换 token),放进仓库无安全风险。以前它被逐字硬编码在多处:
//   - scripts/restart-desktop-remote.mjs(dev 启动时写 desktop .env 的默认值)
//   - apps/desktop/scripts/release-{macos,windows}.mjs(打包时注入 VITE_FEISHU_APP_ID)
// 换应用时要多处同步改、容易漏。这里收敛成一个常量,上述脚本统一 import 引用。
//
// 本文件位于仓库根 scripts/shared/,与 oss.mjs 同级,可被 desktop 发布脚本
// (apps/desktop/scripts/*.mjs,相对路径 ../../../scripts/shared/feishu.mjs)与
// 根 scripts/*.mjs(./shared/feishu.mjs)直接 import。
//
// 注意:apps/mobile 的飞书 App ID 另有其配置体系(eas.json / app.json / config
// plugin,JSON 无法 import JS),不在本文件收敛范围内。
// =============================================================================

export const FEISHU_APP_ID = 'cli_a94d4cf642381cd4';
