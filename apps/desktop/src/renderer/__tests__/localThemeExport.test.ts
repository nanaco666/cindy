import { describe, expect, it } from 'vitest';

import { buildCopyFromTheme } from '../themes/local-themes';
import type { Theme } from '../themes/types';

describe('local theme export', () => {
  it('用可直接替换的示例路径解释 icon / logo 配置', () => {
    const source: Theme = {
      id: 'cindy-light',
      name: 'CINDY Light',
      type: 'light',
      colors: {},
    };

    expect(buildCopyFromTheme(source).theme.brand).toEqual({
      icon: '/absolute/path/to/your-image-folder/icon-square-50x50px.png',
      logo: '/absolute/path/to/your-image-folder/logo-horizontal-110x37.5px.png',
    });
  });
});
