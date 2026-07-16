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

  it('语义不变色跨 light / dark 一致(statusReady / statusAccent)', () => {
    expect(darkColors.statusReady).toBe(lightColors.statusReady);
    expect(darkColors.statusAccent).toBe(lightColors.statusAccent);
  });

  it('CTA 在 dark 下相对 light 反相(避免误用旧深色)', () => {
    expect(darkColors.cta).not.toBe(lightColors.cta);
    expect(darkColors.ctaText).not.toBe(lightColors.ctaText);
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
