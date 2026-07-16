/**
 * branding — 产品品牌展示名的单一事实源（single source of truth）。
 *
 * 目标：把散落在 UI 文案、窗口标题、LLM 可见描述里的品牌名收敛到一处，
 * 未来改名只改这里（i18n 文案经 defaultVariables 注入 {{appName}} 同步生效）。
 *
 * 边界（改名时也【不要】跟随本常量变化的标识符，改了会造成数据迁移事故）：
 *  - 深链协议 `xdt-maker://`（apps/desktop 深度链接 / 会话链接）
 *  - Electron userData 目录名（`xdt-maker` / `xdt-maker-dev*`）与 package.json productName
 *  - 浏览器自动化的受管 profile 目录名（mcp-integrations/browser.ts 的 MANAGED_PROFILE）
 *  - deviceId 前缀、Windows AppUserModelId、macOS bundle id、内部包名
 * 这些属于磁盘 / 协议 / 系统注册层标识符，与展示名解耦正是本模块存在的意义。
 *
 * 完整的改名操作清单（手动项 / 外部协调项 / 标识符边界）见 docs/branding-rename-checklist.md。
 */

/** 产品对用户 / LLM 展示的品牌名（唯一规范写法，不要再派生 "XD Maker" 等变体）。 */
export const BRAND_NAME = 'XDMaker';

/** 产品官网（下载 / 落地页）。 */
export const BRAND_WEBSITE_URL = 'https://xdmaker.magiclizi.com';
