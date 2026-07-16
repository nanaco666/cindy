import { describe, expect, it } from 'vitest';

import '../themes/colors';
import { defaultDark } from '../themes/builtin/default-dark';
import { defaultLight } from '../themes/builtin/default-light';
import { resolveThemeValue } from '../themes/theme-service';
import type { Theme } from '../themes/types';

describe('default theme permission colors', () => {
  it('pins Auto Approval to readable accents in both default variants', () => {
    expect(defaultLight.colors['perm-auto-selected-text']).toBe('#000050');
    expect(defaultDark.colors['perm-auto-selected-text']).toBe('#00D9C5');
  });

  it('resolves Auto Approval from registry fallback instead of neutral text', () => {
    const lightFallbackTheme: Theme = {
      ...defaultLight,
      colors: {},
    };
    const darkFallbackTheme: Theme = {
      ...defaultDark,
      colors: {},
    };

    expect(resolveThemeValue(lightFallbackTheme, 'perm-auto-selected-text')).toBe('#000050');
    expect(resolveThemeValue(darkFallbackTheme, 'perm-auto-selected-text')).toBe('#00D9C5');
  });
});
