const FEISHU_APP_SCHEMES = new Set(['feishu:', 'lark:']);

export function isFeishuAppLink(rawUrl: string): boolean {
  try {
    return FEISHU_APP_SCHEMES.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}
