export const LOCAL_THEME_SUFFIX = '-local';

export function isLocalThemeId(id: string): boolean {
  return id.endsWith(LOCAL_THEME_SUFFIX);
}

export interface LocalThemeWire {
  id: string;
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  /** 欢迎页 logo 的本地图片绝对路径(可选);renderer 装载时转成 xdt-file:// URL。 */
  logo?: string;
  /** 欢迎页 logo 缩放倍数(可选,1 = 原始大小)。 */
  logoScale?: number;
}

export interface LocalThemeDiagnostic {
  file: string;
  error: string;
}

export interface LocalThemesPayload {
  success: true;
  themes: LocalThemeWire[];
  diagnostics: LocalThemeDiagnostic[];
}

export interface LocalThemesErrorPayload {
  success: false;
  error: string;
  themes: [];
  diagnostics: [];
}

export type LocalThemesResult = LocalThemesPayload | LocalThemesErrorPayload;

export interface LocalThemeWriteRequest {
  baseId: string;
  theme: {
    id: string;
    name: string;
    type: 'light' | 'dark';
    /** 欢迎页 logo 本地图片绝对路径;新建副本时写空串作模板(空 = 用默认 logo)。 */
    logo: string;
    /** 欢迎页 logo 缩放倍数;新建副本时写 1 作模板(默认 = 原始大小)。 */
    logoScale: number;
    colors: Record<string, string>;
  };
}

export type LocalThemeWriteResult =
  | { success: true; path: string; finalId: string }
  | { success: false; error: string };

export type LocalThemeOpenDirResult =
  | { success: true; path: string }
  | { success: false; error: string };
