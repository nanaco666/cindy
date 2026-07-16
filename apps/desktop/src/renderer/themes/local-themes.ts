import { createLogger } from '@/lib/logger';
import { toLocalFileUrl } from '@/lib/localPathResolver';

import {
  isLocalThemeId,
  LOCAL_THEME_SUFFIX,
  type LocalThemeWire,
  type LocalThemesResult,
} from '../../shared/local-themes';
import { Emitter } from './event';
import { normalizeLocalThemeColors } from './local-themes-normalize';
import { exportThemeColors } from './theme-service';
import type { Theme, ThemeType } from './types';

const log = createLogger('themes/local-themes');

let cachedThemes: Theme[] = [];
let cachedSignature = '';
const didChange = new Emitter<void>();

function mapWireTheme(theme: LocalThemeWire): Theme {
  // JSON 里的 logo 是本地绝对路径,转成 xdt-file:// URL 供 <img src> 使用。
  const logo = theme.logo ? toLocalFileUrl(theme.logo) : undefined;
  return {
    id: theme.id,
    name: theme.name,
    type: theme.type,
    // 加载期兼容归一化:把 text-placeholder slot 引入前创建的旧本地主题统一收口
    // 到新 slot(详见 local-themes-normalize.ts / DESIGN.md §13 G3)。
    colors: normalizeLocalThemeColors(theme.colors),
    ...(logo ? { logo } : {}),
    ...(theme.logoScale !== undefined ? { logoScale: theme.logoScale } : {}),
  };
}

function signatureOf(themes: Theme[]): string {
  return JSON.stringify(
    themes.map((t) => [t.id, t.type, t.name, t.colors, t.logo, t.logoScale]),
  );
}

/** Returns true if the cache content actually changed. */
function updateCachedThemes(payload: LocalThemesResult): boolean {
  const next = payload.success ? payload.themes.map(mapWireTheme) : [];
  const nextSignature = signatureOf(next);
  if (nextSignature === cachedSignature) return false;
  cachedThemes = next;
  cachedSignature = nextSignature;
  return true;
}

export function bootstrapLocalThemesSync(): void {
  try {
    updateCachedThemes(window.electronAPI.localThemes.listSync());
  } catch (error) {
    log.warn('Failed to bootstrap local themes:', error);
  }
}

export async function refreshLocalThemes(): Promise<LocalThemesResult> {
  const payload = await window.electronAPI.localThemes.list();
  if (updateCachedThemes(payload)) {
    didChange.fire(undefined);
  }
  return payload;
}

export function getLocalThemes(): Theme[] {
  return [...cachedThemes];
}

export function onLocalThemesChange(listener: () => void): () => void {
  return didChange.event(listener);
}

export function buildCopyFromTheme(source: Theme): {
  baseId: string;
  theme: {
    id: string;
    name: string;
    type: ThemeType;
    logo: string;
    logoScale: number;
    colors: Record<string, string>;
  };
} {
  const sourceId = isLocalThemeId(source.id)
    ? source.id.slice(0, -LOCAL_THEME_SUFFIX.length)
    : source.id;
  const baseId = `${sourceId}-copy`;
  return {
    baseId,
    theme: {
      id: baseId,
      name: `${source.name} Copy`,
      type: source.type,
      // logo / logoScale 作为可填模板写进副本:logo 留空 = 用默认打包 logo;
      // logoScale=1 = 原始大小。不携带 source 的值(内置 logo 是打包/xdt URL,
      // 写进 local JSON 会变死链;scale 也重置为默认,保持模板语义干净)。
      logo: '',
      logoScale: 1,
      colors: exportThemeColors(source),
    },
  };
}
