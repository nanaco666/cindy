/**
 * 中国大陆手机号输入处理：手机号登录当前只支持 +86，前缀在 UI 固定展示、不可切换，
 * 输入框只承载 11 位本地号码。规则全部代码化，不依赖服务端提示：
 * - 输入只保留数字；粘贴带 "+86" / "86" 国际前缀的完整号码时剥掉前缀；
 * - 超长截断到 11 位；
 * - 提交前必须恰好 11 位，发给 auth-server 时拼回完整号码（"+86" + 本地号）。
 */
export const CN_PHONE_LENGTH = 11;
export const CN_PHONE_PREFIX = '+86';

/** 清洗用户输入为本地号码数字串（粘贴容错：去非数字、剥 86 国际前缀、截断）。 */
export function sanitizeCnPhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  // 只有超出本地号长度时才剥 86 前缀：避免把用户正在输入的 "86…" 开头串误剥
  // (大陆手机号首位是 1,11 位内以 86 开头的串交给服务端校验拒绝即可)。
  if (digits.length > CN_PHONE_LENGTH && digits.startsWith('86')) {
    digits = digits.slice(2);
  }
  return digits.slice(0, CN_PHONE_LENGTH);
}

/** 是否已是完整的 11 位本地号码。 */
export function isCompleteCnPhone(digits: string): boolean {
  return digits.length === CN_PHONE_LENGTH;
}

/** 拼回提交给 auth-server 的完整号码。 */
export function toCnE164(digits: string): string {
  return `${CN_PHONE_PREFIX}${digits}`;
}
