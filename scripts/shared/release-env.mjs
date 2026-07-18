/** 发布/下载工具的显式环境变量入口；不再回退到仓内私有 JSON。 */
export function resolveReleaseCdnBaseUrl() {
  const raw = process.env.XDT_CDN_BASE_URL?.trim();
  if (!raw) {
    throw new Error('缺少发布 CDN 配置: 请设置 XDT_CDN_BASE_URL');
  }
  return raw.replace(/\/+$/, '');
}
