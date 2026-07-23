import { app } from 'electron';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { dataOwnerStorageKey, type AppSessionMode } from './appSessionState.js';
import { createLogger } from './logger.js';

const CLAIM_MARKER = '.owner-namespace-claim-v1.json';
const LEGACY_PATHS = [
  'ghost-kv',
  'ghost-fs',
  'ghost-cindy-prefs.json',
  'ghost-workdir-prefs.json',
  'ghost-recent-usage.json',
  'dialogues',
  'learn',
  'maker-memory',
  'cindy-brain',
  'brain',
  'builtin-tools-settings.json',
  'slack-hook.json',
  'hook-bindings.json',
  'hook-connections.json',
  'voice-input-models.json',
  'voice-input-data.v1.json',
  'model-access-credentials.json',
  'memory-settings.json',
  'contacts-settings.json',
  'maker-contacts',
  'compaction-settings.json',
  'subagent-model-settings.json',
] as const;

interface MigrationSessionState {
  mode: AppSessionMode;
  dataOwnerId: string | null;
  user: { id: string } | null;
}

interface ClaimMarker {
  version: 1;
  ownerKey: string;
  complete: boolean;
}

interface MigrationDeps {
  userDataDir(): string;
  readFile(file: string): Promise<string>;
  writeFileExclusive(file: string, text: string): Promise<void>;
  writeFile(file: string, text: string): Promise<void>;
  lstat(file: string): Promise<{ isDirectory(): boolean }>;
  readdir(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  rmdir(dir: string): Promise<void>;
}

export interface OwnerNamespaceMigrationResult {
  status: 'skipped' | 'claimed-by-other-owner' | 'migrated' | 'partial';
  moved: number;
  conflicts: number;
}

const log = createLogger('ownerNamespaceMigration');

const productionDeps: MigrationDeps = {
  userDataDir: () => app.getPath('userData'),
  readFile: (file) => fs.readFile(file, 'utf-8'),
  writeFileExclusive: (file, text) => fs.writeFile(file, text, { encoding: 'utf-8', flag: 'wx' }),
  writeFile: (file, text) => fs.writeFile(file, text, 'utf-8'),
  lstat: (file) => fs.lstat(file),
  readdir: (dir) => fs.readdir(dir),
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
  rename: (source, target) => fs.rename(source, target),
  rmdir: (dir) => fs.rmdir(dir),
};

function verifiedCloudOwner(state: MigrationSessionState): string | null {
  if (state.mode !== 'cloud') return null;
  if (!state.dataOwnerId || !state.user || state.user.id !== state.dataOwnerId) {
    throw new Error('owner namespace migration requires a verified cloud membership');
  }
  return state.user.id;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readMarker(deps: MigrationDeps, markerPath: string): Promise<ClaimMarker | null> {
  try {
    const parsed = JSON.parse(await deps.readFile(markerPath)) as Partial<ClaimMarker>;
    if (
      parsed.version === 1 &&
      typeof parsed.ownerKey === 'string' &&
      typeof parsed.complete === 'boolean'
    ) {
      return parsed as ClaimMarker;
    }
    throw new Error('invalid owner namespace claim marker');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Legacy secrets may only be imported by the cloud owner that won the global
 * pre-namespace claim. The marker is intentionally outside owner roots so a
 * later account cannot reinterpret the same shared legacy credential files.
 */
export function hasLegacyOwnerNamespaceClaim(
  ownerId: string,
  userDataDir = app.getPath('userData'),
): boolean {
  try {
    const parsed = JSON.parse(
      fsSync.readFileSync(path.join(userDataDir, CLAIM_MARKER), 'utf-8'),
    ) as Partial<ClaimMarker>;
    return parsed.version === 1 && parsed.ownerKey === dataOwnerStorageKey(ownerId);
  } catch {
    return false;
  }
}

async function pathType(
  deps: MigrationDeps,
  file: string,
): Promise<'missing' | 'directory' | 'other'> {
  try {
    return (await deps.lstat(file)).isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
}

async function moveWithoutOverwrite(
  deps: MigrationDeps,
  source: string,
  target: string,
): Promise<{ moved: number; conflicts: number }> {
  const sourceType = await pathType(deps, source);
  if (sourceType === 'missing') return { moved: 0, conflicts: 0 };

  const targetType = await pathType(deps, target);
  if (targetType === 'missing') {
    await deps.mkdir(path.dirname(target));
    try {
      await deps.rename(source, target);
      return { moved: 1, conflicts: 0 };
    } catch (error) {
      // Another process for the same owner may have won the target race.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  if (sourceType !== 'directory' || (await pathType(deps, target)) !== 'directory') {
    return { moved: 0, conflicts: 1 };
  }

  let moved = 0;
  let conflicts = 0;
  for (const name of await deps.readdir(source)) {
    const result = await moveWithoutOverwrite(
      deps,
      path.join(source, name),
      path.join(target, name),
    );
    moved += result.moved;
    conflicts += result.conflicts;
  }
  try {
    await deps.rmdir(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && !isMissing(error)) throw error;
  }
  return { moved, conflicts };
}

/**
 * Claim pre-namespace private data for the first verified cloud owner.
 * Local/signed-out sessions return before resolving or probing userData.
 */
export async function claimLegacyOwnerNamespace(
  state: MigrationSessionState,
  deps: MigrationDeps = productionDeps,
): Promise<OwnerNamespaceMigrationResult> {
  const ownerId = verifiedCloudOwner(state);
  if (!ownerId) return { status: 'skipped', moved: 0, conflicts: 0 };

  const userDataDir = deps.userDataDir();
  const ownerKey = dataOwnerStorageKey(ownerId);
  const markerPath = path.join(userDataDir, CLAIM_MARKER);
  const targetRoot = path.join(userDataDir, 'owners', ownerKey);
  await deps.mkdir(userDataDir);

  let marker = await readMarker(deps, markerPath);
  if (!marker) {
    marker = { version: 1, ownerKey, complete: false };
    try {
      await deps.writeFileExclusive(markerPath, JSON.stringify(marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      marker = await readMarker(deps, markerPath);
      if (!marker) throw new Error('owner namespace claim marker disappeared');
    }
  }
  if (marker.ownerKey !== ownerKey) {
    return { status: 'claimed-by-other-owner', moved: 0, conflicts: 0 };
  }
  if (marker.complete) {
    return { status: 'migrated', moved: 0, conflicts: 0 };
  }

  let moved = 0;
  let conflicts = 0;
  let failed = false;
  for (const relativePath of LEGACY_PATHS) {
    try {
      const result = await moveWithoutOverwrite(
        deps,
        path.join(userDataDir, relativePath),
        path.join(targetRoot, relativePath),
      );
      moved += result.moved;
      conflicts += result.conflicts;
    } catch (error) {
      failed = true;
      log.warn('legacy owner path migration failed', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!failed) {
    await deps.writeFile(markerPath, JSON.stringify({ ...marker, complete: true }));
  }
  log.info('legacy owner namespace claim completed', {
    ownerKey,
    moved,
    conflicts,
    failed,
  });
  return { status: failed ? 'partial' : 'migrated', moved, conflicts };
}

export const __testing = { CLAIM_MARKER, LEGACY_PATHS };
