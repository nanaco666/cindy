export type ColorIdentifier = string;
export type ColorValue = string;
export type ThemeType = 'light' | 'dark';

export interface ColorDefaults {
  light: ColorValue | null;
  dark: ColorValue | null;
}

export interface ColorContribution {
  id: ColorIdentifier;
  defaults: ColorDefaults;
  description: string;
}

export interface Theme {
  id: string;
  name: string;
  type: ThemeType;
  colors: Partial<Record<ColorIdentifier, ColorValue>>;
  /**
   * 欢迎页 logo,可直接用于 <img src> 的 URL。
   * - 内置主题:打包资源 URL(`import x from '@/assets/x.png'`)。
   * - local 主题:由 JSON 里的本地绝对路径经 toLocalFileUrl() 转成的 xdt-file:// URL。
   * 缺省时欢迎页回退到默认打包 logo。
   */
  logo?: string;
  /**
   * 欢迎页 logo 缩放倍数(以默认尺寸 114.3px 高为基准,1 = 原始大小)。
   * 缺省 / 非法值按 1 处理,渲染时会被 clamp 到合理区间。
   */
  logoScale?: number;
}
