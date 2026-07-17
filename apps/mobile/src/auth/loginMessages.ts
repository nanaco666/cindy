import { getLocales } from 'expo-localization';

export type LoginLanguage = 'zh' | 'en';

const messages = {
  zh: {
    product: 'Cindy',
    title: '登录 Cindy',
    subtitleCn: '国内版 · 手机号归因',
    subtitleGlobal: '国际版 · 邮箱归因',
    phone: '手机号',
    email: '邮箱',
    phonePlaceholder: '输入手机号（含国家区号）',
    emailPlaceholder: '输入邮箱地址',
    continue: '继续',
    or: '或',
    apple: '通过 Apple 继续',
    google: '通过 Google 继续',
    wechat: '通过微信继续',
    chooseMethod: '选择登录方式',
    orgDetected: '{email} 属于企业「{org}」',
    enterpriseLogin: '以企业身份登录',
    personalLogin: '以个人身份登录',
    emailCode: '发送邮箱验证码',
    ssoRequired: '该组织要求使用企业 SSO 登录。',
    ssoEntry: '使用企业 SSO 登录',
    ssoOrgTitle: '企业 SSO 登录',
    ssoOrgSubtitle: '输入企业 ID，跳转到你所在企业的单点登录。',
    ssoOrgPlaceholder: '请输入企业 ID',
    ssoOrgHint: '不知道企业 ID？请联系企业管理员。',
    ssoOrgDetected: '选择企业「{org}」的单点登录方式',
    enterCode: '输入验证码',
    codeSentTo: '验证码已发送至',
    codePlaceholder: '6 位验证码',
    signIn: '登录',
    resendCode: '重新发送验证码',
    chooseAccount: '选择身份',
    chooseAccountSubtitle: '选择本次要进入的个人或组织身份。',
    personalAccount: '个人身份',
    bindPhoneTitle: '绑定手机号',
    bindPhoneSubtitle: '国内版需要验证手机号后才能完成登录。',
    bindEmailTitle: '绑定真实邮箱',
    bindEmailSubtitle: '国际版需要验证真实邮箱后才能完成登录。',
    sendCode: '发送验证码',
    back: '返回',
    cancel: '取消',
    browserTitle: '请在浏览器中完成登录',
    browserSubtitle: '完成后会自动返回 Cindy。',
    working: '处理中…',
    configTitle: '登录配置未完成',
    regionGlobal: '国际',
    errorFallback: '登录未完成，请重试。',
  },
  en: {
    product: 'Cindy',
    title: 'Sign in to Cindy',
    subtitleCn: 'China · phone attribution',
    subtitleGlobal: 'Global · email attribution',
    phone: 'Phone',
    email: 'Email',
    phonePlaceholder: 'Phone number with country code',
    emailPlaceholder: 'Email address',
    continue: 'Continue',
    or: 'or',
    apple: 'Continue with Apple',
    google: 'Continue with Google',
    wechat: 'Continue with WeChat',
    chooseMethod: 'Choose a sign-in method',
    orgDetected: '{email} belongs to "{org}"',
    enterpriseLogin: 'Sign in with your work identity',
    personalLogin: 'Sign in with a personal account',
    emailCode: 'Send an email code',
    ssoRequired: 'Your organization requires enterprise SSO.',
    ssoEntry: 'Sign in with enterprise SSO',
    ssoOrgTitle: 'Enterprise SSO',
    ssoOrgSubtitle: 'Enter your company ID to continue with single sign-on.',
    ssoOrgPlaceholder: 'Enter your company ID',
    ssoOrgHint: "Don't know your company ID? Ask your admin.",
    ssoOrgDetected: 'Choose a single sign-on connection for "{org}"',
    enterCode: 'Enter verification code',
    codeSentTo: 'We sent a code to',
    codePlaceholder: '6-digit code',
    signIn: 'Sign in',
    resendCode: 'Resend code',
    chooseAccount: 'Choose an account',
    chooseAccountSubtitle:
      'Choose the personal or organization account to use.',
    personalAccount: 'Personal account',
    bindPhoneTitle: 'Verify your phone',
    bindPhoneSubtitle: 'The China service requires a verified phone number.',
    bindEmailTitle: 'Verify your email',
    bindEmailSubtitle:
      'The Global service requires a verified real email address.',
    sendCode: 'Send code',
    back: 'Back',
    cancel: 'Cancel',
    browserTitle: 'Finish signing in in your browser',
    browserSubtitle: 'You will return to Cindy automatically.',
    working: 'Working…',
    configTitle: 'Sign-in configuration is incomplete',
    regionGlobal: 'Global',
    errorFallback: 'Sign-in did not complete. Please try again.',
  },
} as const;

export type LoginMessageKey = keyof typeof messages.en;

/** Login follows the system language and intentionally supports only Chinese and English. */
export function getLoginLanguage(): LoginLanguage {
  const languageTag = getLocales()[0]?.languageTag?.toLowerCase() ?? 'en';
  return languageTag.startsWith('zh') ? 'zh' : 'en';
}

export function getAuthLocale(): 'zh-CN' | 'en' {
  return getLoginLanguage() === 'zh' ? 'zh-CN' : 'en';
}

export function loginText(key: LoginMessageKey): string {
  return messages[getLoginLanguage()][key];
}

const authErrorMessages: Record<string, { zh: string; en: string }> = {
  INVALID_CODE: {
    zh: '验证码无效或已过期。',
    en: 'The verification code is invalid or expired.',
  },
  INVALID_PARAMS: {
    zh: '输入内容格式不正确。',
    en: 'Please check the information you entered.',
  },
  INVALID_AUTH_CODE: {
    zh: '登录授权已过期，请重新发起。',
    en: 'The authorization expired. Please start again.',
  },
  INVALID_LOGIN_TICKET: {
    zh: '身份选择已过期，请重新登录。',
    en: 'Account selection expired. Please sign in again.',
  },
  INVALID_BIND_TICKET: {
    zh: '绑定流程已过期，请重新登录。',
    en: 'Verification expired. Please sign in again.',
  },
  STATE_MISMATCH: {
    zh: '登录状态校验失败，请重新登录。',
    en: 'Sign-in state validation failed. Please try again.',
  },
  REGION_MISMATCH: {
    zh: '客户端区域与登录服务不匹配。',
    en: 'This app does not match the authentication region.',
  },
  NETWORK_ERROR: {
    zh: '网络连接失败，请检查网络后重试。',
    en: 'Could not connect. Check your network and try again.',
  },
  REQUEST_TIMEOUT: {
    zh: '登录请求超时，请重试。',
    en: 'The sign-in request timed out. Please try again.',
  },
  USER_CANCELLED: { zh: '已取消登录。', en: 'Sign-in was cancelled.' },
  SOCIAL_PROVIDER_NOT_CONFIGURED: {
    zh: '该登录方式尚未完成配置。',
    en: 'This sign-in method is not configured yet.',
  },
  SOCIAL_PROVIDER_UNAVAILABLE: {
    zh: '当前设备无法使用该登录方式。',
    en: 'This sign-in method is unavailable on this device.',
  },
  AUTH_REQUEST_FAILED: {
    zh: '登录服务暂时不可用，请稍后重试。',
    en: 'The sign-in service is temporarily unavailable.',
  },
  ORG_SSO_NOT_FOUND: {
    zh: '未找到该企业，或该企业未启用 SSO 登录。',
    en: 'Company not found, or it has no SSO connection enabled.',
  },
};

export function authErrorText(code: string | null): string | null {
  if (!code) return null;
  const localized = authErrorMessages[code];
  return localized?.[getLoginLanguage()] ?? loginText('errorFallback');
}
