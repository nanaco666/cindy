import { describe, expect, it } from 'vitest';

import {
  CN_PHONE_LENGTH,
  CN_PHONE_PREFIX,
  isCompleteCnPhone,
  sanitizeCnPhoneInput,
  toCnE164,
} from '@/auth/cnPhone';

describe('cnPhone(手机号登录固定 +86)', () => {
  it('普通 11 位本地号原样保留', () => {
    expect(sanitizeCnPhoneInput('13812345678')).toBe('13812345678');
  });

  it('去掉空格 / 连字符等非数字字符', () => {
    expect(sanitizeCnPhoneInput('138 1234-5678')).toBe('13812345678');
  });

  it('粘贴 +86 完整号码时剥掉国际前缀', () => {
    expect(sanitizeCnPhoneInput('+8613812345678')).toBe('13812345678');
    expect(sanitizeCnPhoneInput('8613812345678')).toBe('13812345678');
    expect(sanitizeCnPhoneInput('+86 138 1234 5678')).toBe('13812345678');
  });

  it('11 位以内以 86 开头的输入不误剥(交给服务端校验)', () => {
    expect(sanitizeCnPhoneInput('861')).toBe('861');
    expect(sanitizeCnPhoneInput('86123456789')).toBe('86123456789');
  });

  it('超长输入截断到 11 位', () => {
    expect(sanitizeCnPhoneInput('138123456789999')).toBe('13812345678');
    expect(sanitizeCnPhoneInput('138123456789999').length).toBe(
      CN_PHONE_LENGTH,
    );
  });

  it('完整性校验只认恰好 11 位', () => {
    expect(isCompleteCnPhone('13812345678')).toBe(true);
    expect(isCompleteCnPhone('1381234567')).toBe(false);
    expect(isCompleteCnPhone('')).toBe(false);
  });

  it('提交号码拼回 +86 前缀', () => {
    expect(toCnE164('13812345678')).toBe('+8613812345678');
    expect(toCnE164('13812345678').startsWith(CN_PHONE_PREFIX)).toBe(true);
  });
});
