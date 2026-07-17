import { describe, expect, it } from 'vitest';
import {
  darkColors,
  fontWeight,
  iconSize,
  lightColors,
  lineHeight,
  palettes,
  typeScale,
  type ThemeColors,
} from '@/theme/tokens';

// WCAG 2.1 对比度工具 —— 仅用于本文件 CTA 契约断言(sRGB 相对亮度法)。
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme tokens', () => {
  it('light / dark 色板 key 集合完全一致', () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
  });

  it('palettes 指向同一份 light / dark 对象', () => {
    expect(palettes.light).toBe(lightColors);
    expect(palettes.dark).toBe(darkColors);
  });

  it('每个颜色 token 都是非空字符串', () => {
    for (const palette of [lightColors, darkColors]) {
      for (const [key, value] of Object.entries(palette)) {
        expect(typeof value, key).toBe('string');
        expect(value.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('状态四色跨 light / dark 一致(设计定稿 2026-07-17:running #EA6B17 / awaiting #19D2C1 / error #D91F37 / done #2AAE5B)', () => {
    expect(darkColors.statusReady).toBe(lightColors.statusReady);
    expect(darkColors.statusAccent).toBe(lightColors.statusAccent);
    expect(darkColors.statusRecording).toBe(lightColors.statusRecording);
    expect(darkColors.statusAwaiting).toBe(lightColors.statusAwaiting);
    expect(darkColors.statusError).toBe(lightColors.statusError);
    expect(darkColors.statusDone).toBe(lightColors.statusDone);
    // 状态色设计定稿(2026-07-17),L=D 同值,与桌面 E5D 三端一致;CINDY 不接管状态语义色。
    expect(lightColors.statusAccent).toBe('#EA6B17');
    expect(lightColors.statusAwaiting).toBe('#19D2C1');
    expect(lightColors.statusError).toBe('#D91F37');
    expect(lightColors.statusDone).toBe('#2AAE5B');
    expect(lightColors.statusRecording).toBe('#D91F37');
    expect(lightColors.statusReady).toBe('#19D2C1');
  });

  it('CTA 契约:中性反相(light 深底浅字 / dark 浅底深字),对比度 ≥4.5:1(用户红色新规 2026-07-17)', () => {
    // 契约第二次改写依据:用户红色新规 2026-07-17——常规按钮不用红,红只留警告/报错。
    // 取代 U3+U8 时期的全态红契约(M2 的 cta=#DF0C27 L=D 红底白字作废),CTA 回归中性反相。
    // 这是显式契约改写,非绕过;PR 描述须写明依据。
    expect(lightColors.cta).toBe('#3C3F43');
    expect(darkColors.cta).toBe('#EEEEEE');
    expect(lightColors.ctaText).toBe('#FCFCFC');
    expect(darkColors.ctaText).toBe('#252222');
    // 亮暗反相回归:dark cta ≠ light cta(深底 ↔ 浅底)。
    expect(darkColors.cta).not.toBe(lightColors.cta);
    expect(darkColors.ctaText).not.toBe(lightColors.ctaText);
    // 中性反相对比度:light 10.32:1 / dark 13.60:1,过 AA 普通文本门槛 4.5:1。
    expect(contrastRatio(lightColors.ctaText, lightColors.cta)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkColors.ctaText, darkColors.cta)).toBeGreaterThanOrEqual(4.5);
  });

  it('毛玻璃 token 契约(R1 audit 模式1/3,E4M 新增 surfaceTranslucentSidebar / surfaceGlassPanel)', () => {
    // R1 audit:@2x 稿折半;模式1 侧栏 blur≈50 dark #120F0F@0.85 / light #F6F6F6@0.90;
    // 模式3 浮层卡 light #F8F8F8 / dark #3B3B3B@0.95。surface 不叠 blur 规避 Android 热路径。
    expect(lightColors.surfaceTranslucentSidebar).toBe('rgba(246, 246, 246, 0.90)');
    expect(darkColors.surfaceTranslucentSidebar).toBe('rgba(18, 15, 15, 0.85)');
    expect(lightColors.surfaceGlassPanel).toBe('#F8F8F8');
    expect(darkColors.surfaceGlassPanel).toBe('rgba(59, 59, 59, 0.95)');
  });

  it('typeScale 严格单调递增', () => {
    const sizes = Object.values(typeScale);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it('lineHeight / iconSize 各号均为正数', () => {
    for (const value of [...Object.values(lineHeight), ...Object.values(iconSize)]) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('fontWeight 只暴露四档字符串(bold 仅限 login 品牌 hero)', () => {
    expect(fontWeight).toEqual({ regular: '400', medium: '500', semibold: '600', bold: '700' });
  });

  it('ThemeColors 类型与运行时 key 对齐(编译期保证)', () => {
    // 类型层面:任意 ThemeColors 必须能由 lightColors 满足。
    const sample: ThemeColors = lightColors;
    expect(sample.surface).toBe(lightColors.surface);
  });
});
