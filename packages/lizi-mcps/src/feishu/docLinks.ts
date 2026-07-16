/**
 * docLinks.ts — 飞书用户可见文档链接的域名单点定义(2026-07 端点收敛)。
 *
 * blockManifest / server 各处拼给用户点击的 `https://feishu.cn/<type>/<token>`
 * 链接时统一从这里取 base,不再散写字面量(仓库根 scripts/check-endpoint-literals.mjs
 * 门禁扫描)。注意这是「文档跳转域名」,与 open.feishu.cn(OpenAPI)无关。
 */

/** 飞书文档/表格/知识库等对象的用户侧跳转域名。 */
export const FEISHU_DOC_LINK_BASE = 'https://feishu.cn';

/** 飞书妙记(会议纪要)的用户侧跳转域名。 */
export const FEISHU_MINUTES_LINK_BASE = 'https://meetings.feishu.cn';
