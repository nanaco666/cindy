import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LOCAL_THEME_SUFFIX,
  type LocalThemeDiagnostic,
  type LocalThemeWire,
  type LocalThemesResult,
} from '../../shared/local-themes';
import { createLogger } from '../logger';

const log = createLogger('local-themes');

interface LocalThemeJson {
  id: string;
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  logo?: string;
  logoScale?: number;
}

interface FileEntry {
  file: string;
  content: string;
}

export function getLocalThemesDir(): string {
  return path.join(os.homedir(), '.xdmaker', 'themes');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid '${field}': expected non-empty string.`);
  }
  return value;
}

function parseLocalThemeJson(raw: unknown): LocalThemeJson {
  if (!isRecord(raw)) {
    throw new Error('Invalid theme JSON: expected object.');
  }

  const id = asNonEmptyString(raw.id, 'id');
  const name = asNonEmptyString(raw.name, 'name');
  if (raw.type !== 'light' && raw.type !== 'dark') {
    throw new Error("Invalid 'type': expected 'light' or 'dark'.");
  }
  if (!isRecord(raw.colors)) {
    throw new Error("Invalid 'colors': expected object.");
  }

  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.colors)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid color '${key}': expected string value.`);
    }
    colors[key] = value;
  }

  // logo 可选:本地图片绝对路径。非空 string 才带上,其余忽略(向后兼容老 JSON)。
  const logo =
    typeof raw.logo === 'string' && raw.logo.trim().length > 0
      ? raw.logo.trim()
      : undefined;

  // logoScale 可选:正有限数才带上,其余忽略。clamp 交给 renderer 渲染时处理。
  const logoScale =
    typeof raw.logoScale === 'number' && Number.isFinite(raw.logoScale) && raw.logoScale > 0
      ? raw.logoScale
      : undefined;

  return {
    id,
    name,
    type: raw.type,
    colors,
    ...(logo ? { logo } : {}),
    ...(logoScale !== undefined ? { logoScale } : {}),
  };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processEntries(entries: Array<FileEntry | { file: string; error: string }>): LocalThemesResult {
  const themes: LocalThemeWire[] = [];
  const diagnostics: LocalThemeDiagnostic[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    if ('error' in entry) {
      log.warn(`Failed to load local theme '${entry.file}': ${entry.error}`);
      diagnostics.push({ file: entry.file, error: entry.error });
      continue;
    }
    try {
      const parsed = parseLocalThemeJson(JSON.parse(entry.content));
      const id = `${parsed.id}${LOCAL_THEME_SUFFIX}`;
      if (seenIds.has(id)) {
        const error = `Skipped duplicate local theme '${id}' from '${entry.file}'.`;
        log.warn(error);
        diagnostics.push({ file: entry.file, error });
        continue;
      }
      seenIds.add(id);
      themes.push({ ...parsed, id });
    } catch (error) {
      const message = normalizeError(error);
      log.warn(`Failed to load local theme '${entry.file}': ${message}`);
      diagnostics.push({ file: entry.file, error: message });
    }
  }

  return { success: true, themes, diagnostics };
}

function pickJsonFiles(entries: string[]): string[] {
  return entries
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
}

function topLevelFailure(error: unknown): LocalThemesResult {
  const message = normalizeError(error);
  log.warn(`Failed to scan local themes: ${message}`);
  return { success: false, error: message, themes: [], diagnostics: [] };
}

export async function loadLocalThemes(): Promise<LocalThemesResult> {
  try {
    const dir = getLocalThemesDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const files = pickJsonFiles(await fs.promises.readdir(dir));
    const entries = await Promise.all(
      files.map(async (file): Promise<FileEntry | { file: string; error: string }> => {
        try {
          const content = await fs.promises.readFile(path.join(dir, file), 'utf8');
          return { file, content };
        } catch (error) {
          return { file, error: normalizeError(error) };
        }
      }),
    );
    return processEntries(entries);
  } catch (error) {
    return topLevelFailure(error);
  }
}

export function loadLocalThemesSync(): LocalThemesResult {
  try {
    const dir = getLocalThemesDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = pickJsonFiles(fs.readdirSync(dir));
    const entries = files.map((file): FileEntry | { file: string; error: string } => {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        return { file, content };
      } catch (error) {
        return { file, error: normalizeError(error) };
      }
    });
    return processEntries(entries);
  } catch (error) {
    return topLevelFailure(error);
  }
}
