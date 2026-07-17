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

  it('状态四色跨 light / dark 一致且不被 CINDY 接管(running/awaiting/error/done/recording)', () => {
    expect(darkColors.statusReady).toBe(lightColors.statusReady);
    expect(darkColors.statusAccent).toBe(lightColors.statusAccent);
    expect(darkColors.statusRecording).toBe(lightColors.statusRecording);
    expect(darkColors.statusAwaiting).toBe(lightColors.statusAwaiting);
    expect(darkColors.statusError).toBe(lightColors.statusError);
    expect(darkColors.statusDone).toBe(lightColors.statusDone);
    // 状态四色冻结值(CINDY 不接管状态语义色,与桌面/灵动岛三端同值)。
    expect(lightColors.statusAccent).toBe('#FF6600');
    expect(lightColors.statusAwaiting).toBe('#00D9C5');
    expect(lightColors.statusError).toBe('#ef4444');
    expect(lightColors.statusDone).toBe('#22c55e');
    expect(lightColors.statusRecording).toBe('#ef4444');
  });

  it('CTA 契约:品牌红 #DF0C27 底 + #FFFFFF 字,L=D 同值,对比度 ≥4.5:1(U3+U8 批准)', () => {    // 契约变更依据:CINDY 色板经 U3(全量替换语义)+U8(token 决策表)批准——
    // 此前"dark CTA 反相为白 pill"守护作废,改为红底白字 L=D 同值。
    // 这是对旧反相断言的显式契约改写,不是绕过;PR 描述须写明依据。
    expect(lightColors.cta).toBe('#DF0C27');
    expect(darkColors.cta).toBe('#DF0C27');
    expect(lightColors.ctaText).toBe('#FFFFFF');
    expect(darkColors.ctaText).toBe('#FFFFFF');
    // 红底白字实测 4.98:1,过 AA 普通文本门槛 4.5:1。
    for (const palette of [lightColors, darkColors]) {
      expect(contrastRatio(palette.ctaText, palette.cta)).toBeGreaterThanOrEqual(4.5);
    }
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
