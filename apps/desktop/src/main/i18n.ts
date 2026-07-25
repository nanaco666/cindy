/**
 * Main-process minimal i18n.
 *
 * Used for dialogs that fire before any renderer window exists (e.g. the
 * macOS App Translocation prompt at app-ready). The renderer's localStorage
 * language preference is not reachable at that moment, so we fall back to
 * the OS preferred language list via resolvePreferredSystemLocale.
 *
 * Locale JSONs are imported from the renderer's i18n bundle to avoid
 * duplicating string tables. They are pure data, so the cross-layer import
 * does not violate the main/renderer logic separation. If main-process
 * strings ever grow beyond a couple of dialogs, move the locales to
 * shared/i18n/locales/ and update both call sites.
 */
import { app } from 'electron';
import { BRAND_NAME } from '@lizi/maker-shared/branding';

import {
  DEFAULT_LOCALE,
  resolvePreferredSystemLocale,
  type SupportedLocale,
} from '../shared/locale.js';

import enCommon from '../renderer/i18n/locales/en/common.json';
import zhCNCommon from '../renderer/i18n/locales/zh-CN/common.json';
import jaCommon from '../renderer/i18n/locales/ja/common.json';
import koCommon from '../renderer/i18n/locales/ko/common.json';

const resources: Record<SupportedLocale, Record<string, unknown>> = {
  en: enCommon as Record<string, unknown>,
  'zh-CN': zhCNCommon as Record<string, unknown>,
  ja: jaCommon as Record<string, unknown>,
  ko: koCommon as Record<string, unknown>,
};

let cachedLocale: SupportedLocale | null = null;

function resolveOsLocale(): SupportedLocale {
  // app.getPreferredSystemLanguages() returns [] before app-ready. All
  // current callers fire after ready, but defend anyway so a stray early
  // t() call cannot throw.
  let langs: string[] = [];
  try {
    langs = app.getPreferredSystemLanguages();
  } catch {
    /* not ready */
  }
  if (langs.length === 0) {
    try {
      langs = [app.getLocale()];
    } catch {
      /* not ready */
    }
  }
  if (langs.length === 0) return DEFAULT_LOCALE;
  return resolvePreferredSystemLocale(langs);
}

function getMainLocale(): SupportedLocale {
  if (cachedLocale) return cachedLocale;
  cachedLocale = resolveOsLocale();
  return cachedLocale;
}

/**
 * Keep main-process native surfaces in sync with the renderer language
 * preference after the renderer has mounted.
 */
export function setMainLocale(locale: SupportedLocale): void {
  cachedLocale = locale;
}

/**
 * Resolved main-side locale (renderer preference after sync, OS fallback
 * before). learn-host 用它决定蒸馏自述的语言(跟随系统语言配置,规则 9:
 * 用代码注入确定性语言,不靠模型从请求里猜)。
 */
export function getResolvedMainLocale(): SupportedLocale {
  return getMainLocale();
}

function lookup(bundle: Record<string, unknown>, key: string): string | null {
  let cur: unknown = bundle;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/**
 * Translate a dot-path key (e.g. 'update.moveToApplications.title') using
 * the OS-resolved main-side locale, falling back to English, then to the
 * key itself.
 *
 * 与 renderer i18next 的 interpolation.defaultVariables 对齐:locale 文案里的
 * {{appName}} 由品牌常量注入(本迷你 i18n 不支持其它变量,main 消费的 key 若
 * 需要更多插值,应像 bootstrap 菜单那样在调用点自行 replace)。
 */
export function t(key: string): string {
  const loc = getMainLocale();
  const raw = lookup(resources[loc], key) ?? lookup(resources[DEFAULT_LOCALE], key) ?? key;
  return raw.replaceAll('{{appName}}', BRAND_NAME);
}
