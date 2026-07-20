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
  // 所有消费方（loader / writer / open-dir IPC）都经这里拿路径，先确保一次性搬迁完成。
  migrateLegacyThemesDirOnce();
  return path.join(os.homedir(), '.cindy', 'themes');
}

/** 品牌迁移前的旧主题目录（2026-07-20 起硬切为 ~/.cindy/themes），仅用于一次性搬迁。 */
function getLegacyLocalThemesDir(): string {
  return path.join(os.homedir(), '.xdmaker', 'themes');
}

let themesMigrationDone = false;

/** 仅供测试：清掉进程内"已搬迁"标记。 */
export function resetLocalThemesMigrationForTest(): void {
  themesMigrationDone = false;
}

/**
 * 一次性把 ~/.xdmaker/themes 搬到 ~/.cindy/themes（老在新不在 → rename）。
 * 同步实现：loadLocalThemesSync 在 renderer 启动的同步 IPC 里跑，搬迁必须
 * 发生在它第一次扫描目录之前。幂等（进程内只跑一次），失败仅 warn 不阻断——
 * 后续按新目录为空的语义继续。搬空后的 ~/.xdmaker 空壳顺手删掉（失败忽略）。
 */
function migrateLegacyThemesDirOnce(): void {
  if (themesMigrationDone) return;
  themesMigrationDone = true;
  const oldDir = getLegacyLocalThemesDir();
  // 不走 getLocalThemesDir()（它会回调本函数），直接拼新路径。
  const newDir = path.join(os.homedir(), '.cindy', 'themes');
  try {
    if (!fs.existsSync(oldDir) || !fs.statSync(oldDir).isDirectory()) return;
    if (fs.existsSync(newDir)) return;
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    log.info(`Migrated local themes dir from '${oldDir}' to '${newDir}'.`);
    try {
      fs.rmdirSync(path.dirname(oldDir));
    } catch {
      // 旧 ~/.xdmaker 非空（还有别的东西）或删除失败：保留即可。
    }
  } catch (error) {
    log.warn(`Failed to migrate legacy local themes dir: ${normalizeError(error)}`);
  }
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
