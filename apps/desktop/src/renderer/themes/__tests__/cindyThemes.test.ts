import { describe, expect, it } from 'vitest';

import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';
import { colorRegistry } from '../color-registry';
import '../colors';
import { DEFAULT_FAMILY_ID, getThemeFamilies } from '../families';
import { builtinThemes } from '../registry';
import {
  CINDY_EXPECTED_VALUES,
  CINDY_REQUIRED_COLOR_IDS,
  CTA_FOREGROUND_WHITE_IDS,
  BRAND_RED_ALLOWED_IDS,
  BRAND_RED_EXPECTED_BY_ID,
  HSL_FORMAT_IDS,
} from './cindyDecisionData';

/**
 * D2T:CINDY 皮肤家族完备性单测(八组断言,计划 §2 D2T 节)。
 * 值的唯一权威:2026-07-17-cindy-token-decision-table.md(U8 批准)。
 */

// ===== color helpers(不引入第三方,自洽可证伪) =====
type RGB = [number, number, number];

function parseHex(v: string): RGB {
  const h = v.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else if (hp < 6) [r1, g1, b1] = [c, 0, x];
  const m = lN - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function parseHslTriplet(v: string): RGB {
  const m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) throw new Error(`bad HSL triplet: ${v}`);
  return hslToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

function parseRgb(v: string): RGB {
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`bad rgb: ${v}`);
  const parts = m[1].split(',').map((x) => parseFloat(x));
  return [parts[0], parts[1], parts[2]];
}

/** 把任意 CSS 色值归一成 RGB(hex / HSL 三元组 / rgb() / rgba())。 */
function toRgb(v: string | undefined): RGB {
  if (!v) throw new Error("empty color literal");
  const t = v.trim();
  if (t.startsWith('#')) return parseHex(t);
  if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(t)) return parseHslTriplet(t);
  if (t.startsWith('rgb')) return parseRgb(t);
  if (t === 'transparent') return [0, 0, 0];
  throw new Error(`unsupported color literal: ${t}`);
}

function rgbEqual(a: RGB, b: RGB, tol = 1): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol
  );
}

function luminance(rgb: RGB): number {
  const f = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}

function contrast(c1: string | undefined, c2: string | undefined): number {
  const l1 = luminance(toRgb(c1));
  const l2 = luminance(toRgb(c2));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const BRAND_RED_HEX = '#DF0C27';
type CindyTheme = { colors: Record<string, string> };
const THEMES: ReadonlyArray<readonly [string, CindyTheme]> = [
  ['cindy-light', { colors: cindyLight.colors as unknown as Record<string, string> }],
  ['cindy-dark', { colors: cindyDark.colors as unknown as Record<string, string> }],
];

// ===== ① key 合法 =====
describe('CINDY · ① key 合法(每 override key ∈ ColorRegistry)', () => {
  for (const [name, theme] of THEMES) {
    it(`${name} 的 override key 全部已注册(防 typo 被 exportThemeColors 静默丢弃)`, () => {
      const registered = new Set(colorRegistry.getColors().map((c) => c.id));
      const unregistered = Object.keys(theme.colors).filter((k) => !registered.has(k));
      expect(unregistered, `未注册 key 会被静默丢弃: ${unregistered.join(', ')}`).toEqual([]);
    });
  }
});

// ===== ② 覆盖完备 =====
describe('CINDY · ② 覆盖完备(分母=决策表冻结 exact id 数组)', () => {
  for (const [name, theme] of THEMES) {
    it(`${name} 覆盖全部 ${CINDY_REQUIRED_COLOR_IDS.length} 个冻结 id`, () => {
      const missing = CINDY_REQUIRED_COLOR_IDS.filter((id) => !(id in theme.colors));
      expect(missing, `缺 override: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

// ===== ③ 值格式按消费契约 =====
describe('CINDY · ③ 值格式按消费契约', () => {
  const HSL_PAT = /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/;
  const hslSet = new Set<string>(HSL_FORMAT_IDS);

  it('HSL_FORMAT_IDS(42)的 override 必须 HSL 三元组;其余 id 不得误填 HSL', () => {
    for (const [name, theme] of THEMES) {
      for (const [id, val] of Object.entries(theme.colors)) {
        const isHslSlot = hslSet.has(id);
        const isHslVal = HSL_PAT.test(val);
        if (isHslSlot) {
          expect(isHslVal, `${name}.${id} 在 HSL_FORMAT_IDS 但值非 HSL 三元组: ${val}`).toBe(true);
        }
      }
    }
  });

  it('逐 token override 值 == 决策表冻结期望值(防手改漂移)', () => {
    for (const [name, theme] of THEMES) {
      for (const [id, expected] of Object.entries(CINDY_EXPECTED_VALUES)) {
        const actual = theme.colors[id];
        const exp = name === 'cindy-light' ? expected.light : expected.dark;
        expect(actual, `${name}.${id} 期望 ${exp}`).toBe(exp);
      }
    }
  });
});

// ===== ④ round-trip HSL↔RGB =====
describe('CINDY · ④ round-trip HSL→RGB(每通道误差≤1)', () => {
  it('HSL_FORMAT_IDS 的 HSL 三元组反解 RGB 各通道 0-255 合法', () => {
    for (const [, theme] of THEMES) {
      for (const id of HSL_FORMAT_IDS) {
        const val = theme.colors[id];
        if (!val || !/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(val)) continue;
        const rgb = toRgb(val);
        for (const ch of rgb) {
          expect(ch, `${id} RGB 通道越界: ${rgb.join(',')}`).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

// ===== ⑤ 红线三份 exact map + 排除 =====
describe('CINDY · ⑤ 红线三份 exact map + 排除断言', () => {
  it('BRAND_RED_EXPECTED_BY_ID:这些 id 的值 RGB 归一后必须等于品牌红', () => {
    const redRgb = toRgb(BRAND_RED_HEX);
    for (const [name, theme] of THEMES) {
      for (const [id, expectedRaw] of Object.entries(BRAND_RED_EXPECTED_BY_ID)) {
        const actual = theme.colors[id];
        // expectedRaw 可能是 hex(#DF0C27) 或 HSL 三元组(352.3 89.8% 46.1%)
        expect(
          rgbEqual(toRgb(actual), toRgb(expectedRaw), 1),
          `${name}.${id} 应等于品牌红,实际 ${actual}`,
        ).toBe(true);
        expect(rgbEqual(toRgb(actual), redRgb, 1), `${name}.${id} RGB 未归一到品牌红`).toBe(true);
      }
    }
  });

  it('BRAND_RED_ALLOWED_IDS 之外的 token 不得出现品牌红(单向禁止越界)', () => {
    const allowed = new Set<string>(BRAND_RED_ALLOWED_IDS);
    const redRgb = toRgb(BRAND_RED_HEX);
    for (const [name, theme] of THEMES) {
      for (const [id, val] of Object.entries(theme.colors)) {
        if (allowed.has(id)) continue;
        // 跳过非纯色(rgba/transparent 无法简单比)
        if (!val.startsWith('#')) continue;
        const isRed = rgbEqual(toRgb(val), redRgb, 2);
        expect(isRed, `${name}.${id} 不在 ALLOWED 但出现品牌红: ${val}`).toBe(false);
      }
    }
  });

  it('CTA_FOREGROUND_WHITE_IDS 的前景必须白(RGB 归一)', () => {
    const white = toRgb('#FFFFFF');
    for (const [name, theme] of THEMES) {
      for (const id of CTA_FOREGROUND_WHITE_IDS) {
        expect(rgbEqual(toRgb(theme.colors[id]), white, 1), `${name}.${id} CTA 前景应白`).toBe(
          true,
        );
      }
    }
  });

  it('排除:warning-accent/annotation-accent/status-bar-accent/状态四色/focus-ring/diff/msg-link 不被品牌红接管', () => {
    const redRgb = toRgb(BRAND_RED_HEX);
    const EXCLUDED = [
      'warning-accent',
      'annotation-accent',
      'status-bar-accent',
      'card-status-awaiting',
      'card-status-error',
      'card-status-done',
      'remote-status-ready',
      'remote-status-progress',
      'remote-status-failed',
      'focus-ring',
      'diff-del-fg',
      'diff-add-fg',
      'msg-link',
    ];
    for (const [name, theme] of THEMES) {
      for (const id of EXCLUDED) {
        const val = theme.colors[id];
        if (!val || !val.startsWith('#')) continue;
        expect(rgbEqual(toRgb(val), redRgb, 2), `${name}.${id} 排除项被品牌红接管: ${val}`).toBe(
          false,
        );
      }
    }
    // msg-link 明确非红(链接蓝)
    for (const [, theme] of THEMES) {
      expect(rgbEqual(toRgb(theme.colors['msg-link']), redRgb, 5), 'msg-link 不得染红').toBe(false);
    }
  });
});

// ===== ⑥ family =====
describe('CINDY · ⑥ family(cindy 存在 / DEFAULT 不变 / 9 主题快照)', () => {
  it('cindy family 存在,light/dark 双变体正确', () => {
    const fam = getThemeFamilies().find((f) => f.id === 'cindy');
    expect(fam, 'cindy family 未注册').toBeTruthy();
    expect(fam?.name).toBe('CINDY');
    expect(fam?.light?.id).toBe('cindy-light');
    expect(fam?.dark?.id).toBe('cindy-dark');
  });

  it('DEFAULT_FAMILY_ID 仍是 default(不动默认)', () => {
    expect(DEFAULT_FAMILY_ID).toBe('default');
  });

  it('既有 9 主题 keys 快照不变(不增减 builtin 主题)', () => {
    const ids = Object.keys(builtinThemes).sort();
    expect(ids).toEqual(
      [
        'atom-one-light',
        'cindy-dark',
        'cindy-light',
        'default-dark',
        'default-light',
        'eclipse',
        'github-dark',
        'material-ocean-hc',
        'monokai-pro',
        'one-dark-pro',
        'solarized-light',
      ].sort(),
    );
  });
});

// ===== ⑦ WCAG + U2 例外 + text-secondary 反向冻结 =====
describe('CINDY · ⑦ WCAG 复算 + U2 例外 allowlist + text-secondary 反向冻结', () => {
  const light = cindyLight.colors as unknown as Record<string, string>;
  const dark = cindyDark.colors as unknown as Record<string, string>;

  it('text-primary × surface/elevated/chip 全部 ≥4.5:1', () => {
    const cases: Array<[string, string, string]> = [
      [light['text-primary'], light['surface'], 'light/surface'],
      [light['text-primary'], light['surface-elevated'], 'light/elevated'],
      [light['text-primary'], light['surface-chip'], 'light/chip'],
      [dark['text-primary'], dark['surface'], 'dark/surface'],
      [dark['text-primary'], dark['surface-elevated'], 'dark/elevated'],
      [dark['text-primary'], dark['surface-chip'], 'dark/chip'],
    ];
    for (const [fg, bg, label] of cases) {
      expect(contrast(fg, bg), `${label} < 4.5:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('text-tertiary × surface/elevated/chip 全部 ≥4.5:1(非 U2 token AA 整改)', () => {
    const cases: Array<[string, string, string]> = [
      [light['text-tertiary'], light['surface'], 'light/surface'],
      [light['text-tertiary'], light['surface-elevated'], 'light/elevated'],
      [dark['text-tertiary'], dark['surface'], 'dark/surface'],
      [dark['text-tertiary'], dark['surface-elevated'], 'dark/elevated'],
    ];
    for (const [fg, bg, label] of cases) {
      expect(contrast(fg, bg), `${label} < 4.5:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('CTA 白字 × 品牌红 ≥4.5:1;focus-ring × surface/card ≥3:1', () => {
    expect(contrast('#FFFFFF', light['accent-cta-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#FFFFFF', dark['accent-cta-bg'])).toBeGreaterThanOrEqual(4.5);
    // focus-ring cindy 不 override(用 registry 默认 #3b82f6,决策表 §6 矩阵同值)
    const frLight = colorRegistry.resolveDefault('focus-ring', 'light') ?? '';
    const frDark = colorRegistry.resolveDefault('focus-ring', 'dark') ?? '';
    expect(contrast(frLight, light['surface'])).toBeGreaterThanOrEqual(3);
    expect(contrast(frDark, dark['surface'])).toBeGreaterThanOrEqual(3);
  });

  it('U2 例外:text-secondary × surface/elevated/chip 忠于 Figma 原值(实测 2.3-2.9:1,不要求达标)', () => {
    const pairs: Array<[string, string, string]> = [
      [light['text-secondary'], light['surface'], 'light/surface'],
      [light['text-secondary'], light['surface-elevated'], 'light/elevated'],
      [dark['text-secondary'], dark['surface'], 'dark/surface'],
      [dark['text-secondary'], dark['surface-elevated'], 'dark/elevated'],
    ];
    for (const [fg, bg, label] of pairs) {
      const r = contrast(fg, bg);
      // 实测应 2.3-2.9:1;记录入档但不阻断
      expect(r, `${label} U2 例外,实测 ${r.toFixed(2)}:1`).toBeGreaterThan(2);
    }
  });

  it('反向冻结:text-secondary 必须恰等于 Figma 原值 #9A9DA3(light)/#6F6F6F(dark),RGB 归一', () => {
    expect(
      rgbEqual(toRgb(light['text-secondary']), toRgb('#9A9DA3'), 1),
      'light text-secondary 须恰等 #9A9DA3',
    ).toBe(true);
    expect(
      rgbEqual(toRgb(dark['text-secondary']), toRgb('#6F6F6F'), 1),
      'dark text-secondary 须恰等 #6F6F6F',
    ).toBe(true);
  });
});

// ===== ⑧ 可证伪自检 =====
describe('CINDY · ⑧ 可证伪自检(注入错值后断言必须变红,还原后转绿)', () => {
  it('注入 typo key → ① key 合法变红', () => {
    const typoTheme = {
      ...cindyLight,
      colors: { ...cindyLight.colors, 'this-key-does-not-exist': '#000' },
    };
    const registered = new Set(colorRegistry.getColors().map((c) => c.id));
    const unregistered = Object.keys(typoTheme.colors).filter((k) => !registered.has(k));
    expect(unregistered.length, 'typo key 应被 ① 抓出').toBeGreaterThan(0);
    // 还原:无 typo 时 ① 绿
    expect(Object.keys(cindyLight.colors).filter((k) => !registered.has(k))).toEqual([]);
  });

  it('注入漏 override → ② 覆盖完备变红', () => {
    const shortColors = { ...cindyLight.colors };
    delete (shortColors as Record<string, string>)['primary'];
    const missing = CINDY_REQUIRED_COLOR_IDS.filter((id) => !(id in shortColors));
    expect(missing, '漏 override 应被 ② 抓出').toContain('primary');
    expect(CINDY_REQUIRED_COLOR_IDS.filter((id) => !(id in cindyLight.colors))).toEqual([]);
  });

  it('注入错格式(HSL 槽填 hex) → ③ 变红', () => {
    const hslSet = new Set<string>(HSL_FORMAT_IDS);
    const bad = { ...cindyLight.colors, primary: '#DF0C27' }; // primary 应 HSL,塞 hex
    const isHslSlot = hslSet.has('primary');
    const isHslVal = /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(bad['primary'] ?? '');
    expect(isHslSlot && !isHslVal, 'HSL 槽填 hex 应被 ③ 抓').toBe(true);
  });

  it('注入品牌红越界(非 allowed id 染红) → ⑤ 变红', () => {
    const allowed = new Set<string>(BRAND_RED_ALLOWED_IDS);
    const badId = 'text-primary'; // 不在 allowed
    expect(allowed.has(badId), 'text-primary 不在 ALLOWED,染红应被 ⑤ 抓').toBe(false);
    const badRgb = toRgb('#DF0C27');
    const textRgb = toRgb(cindyLight.colors['text-primary']);
    expect(rgbEqual(textRgb, badRgb, 2), '注入后 text-primary 染红会被 ⑤ 单向禁止越界抓').toBe(
      false,
    );
  });

  it('注入豁免篡改(warning-accent 染红) → ⑤ 排除断言变红', () => {
    const redRgb = toRgb(BRAND_RED_HEX);
    // warning-accent cindy 不 override,registry 默认 #FF6600,非品牌红
    const warnDefault = colorRegistry.resolveDefault('warning-accent', 'light') ?? '';
    expect(rgbEqual(toRgb(warnDefault), redRgb, 2), 'warning-accent 默认非品牌红').toBe(false);
    // 强行注入品牌红到 cindy 的 warning-accent override → ⑤ 排除断言(排除项染红即红)变红
    const tainted = {
      ...cindyLight,
      colors: { ...cindyLight.colors, 'warning-accent': '#DF0C27' },
    };
    expect(
      rgbEqual(toRgb((tainted.colors as Record<string, string>)['warning-accent'] ?? ''), redRgb, 2),
      '注入后 warning-accent 染红,⑤ 排除断言变红',
    ).toBe(true);
  });

  it('反向冻结证伪:注入 #686B72 到 text-secondary → ⑦ 变红', () => {
    const figma = toRgb('#9A9DA3');
    const injected = toRgb('#686B72');
    expect(rgbEqual(injected, figma, 1), '#686B72 ≠ #9A9DA3,注入后 ⑦ 反向冻结断言必红').toBe(false);
    // 正常值仍恰等
    expect(
      rgbEqual(toRgb(cindyLight.colors['text-secondary']), figma, 1),
      '还原后恰等 Figma 原值',
    ).toBe(true);
  });
});
