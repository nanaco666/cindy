import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dataOwnerStorageKey } from '../appSessionState.js';
import {
  claimLegacyOwnerNamespace,
  hasLegacyOwnerNamespaceClaim,
  __testing,
} from '../ownerNamespaceMigration.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-namespace-migration-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('claimLegacyOwnerNamespace', () => {
  it.each(['local', 'signed-out'] as const)('%s never resolves or scans userData', async (mode) => {
    const userDataDir = vi.fn(() => {
      throw new Error('must not resolve userData');
    });
    await expect(
      claimLegacyOwnerNamespace(
        { mode, dataOwnerId: mode === 'local' ? 'local-v1' : null, user: null },
        { userDataDir } as never,
      ),
    ).resolves.toEqual({ status: 'skipped', moved: 0, conflicts: 0 });
    expect(userDataDir).not.toHaveBeenCalled();
  });

  it('moves known legacy paths without overwriting existing scoped data', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey(ownerId));
    await fs.mkdir(path.join(root, 'ghost-kv'), { recursive: true });
    await fs.writeFile(path.join(root, 'ghost-kv', 'moved.json'), 'legacy');
    await fs.writeFile(path.join(root, 'ghost-kv', 'conflict.json'), 'legacy-conflict');
    await fs.mkdir(path.join(targetRoot, 'ghost-kv'), { recursive: true });
    await fs.writeFile(path.join(targetRoot, 'ghost-kv', 'conflict.json'), 'scoped');
    await fs.writeFile(path.join(root, 'ghost-cindy-prefs.json'), 'legacy-prefs');
    await fs.mkdir(path.join(root, 'learn'), { recursive: true });
    await fs.writeFile(path.join(root, 'learn', 'runs.json'), 'legacy-runs');
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await fs.writeFile(path.join(root, 'hook-bindings.json'), 'legacy-bindings');
    await fs.writeFile(path.join(root, 'voice-input-models.json'), 'legacy-voice-models');
    await fs.writeFile(path.join(root, 'voice-input-data.v1.json'), 'legacy-voice-data');
    await fs.writeFile(path.join(root, 'subagent-model-settings.json'), 'legacy-subagent-models');
    await fs.mkdir(path.join(root, 'cindy-brain', 'user-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, 'cindy-brain', 'user-plugin', 'manifest.json'), '{}');
    await fs.mkdir(path.join(root, 'maker-contacts'), { recursive: true });
    await fs.writeFile(path.join(root, 'maker-contacts', 'contacts.db'), 'legacy-contacts');

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    expect(result).toMatchObject({ status: 'migrated', conflicts: 1 });
    await expect(fs.readFile(path.join(targetRoot, 'ghost-kv', 'moved.json'), 'utf-8')).resolves.toBe('legacy');
    await expect(fs.readFile(path.join(targetRoot, 'ghost-kv', 'conflict.json'), 'utf-8')).resolves.toBe('scoped');
    await expect(fs.readFile(path.join(root, 'ghost-kv', 'conflict.json'), 'utf-8')).resolves.toBe('legacy-conflict');
    await expect(fs.readFile(path.join(targetRoot, 'ghost-cindy-prefs.json'), 'utf-8')).resolves.toBe('legacy-prefs');
    await expect(fs.readFile(path.join(targetRoot, 'learn', 'runs.json'), 'utf-8')).resolves.toBe('legacy-runs');
    await expect(fs.readFile(path.join(targetRoot, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
    await expect(fs.readFile(path.join(targetRoot, 'hook-bindings.json'), 'utf-8')).resolves.toBe('legacy-bindings');
    await expect(fs.readFile(path.join(targetRoot, 'voice-input-models.json'), 'utf-8')).resolves.toBe('legacy-voice-models');
    await expect(fs.readFile(path.join(targetRoot, 'voice-input-data.v1.json'), 'utf-8')).resolves.toBe('legacy-voice-data');
    await expect(fs.readFile(path.join(targetRoot, 'subagent-model-settings.json'), 'utf-8')).resolves.toBe('legacy-subagent-models');
    await expect(fs.readFile(path.join(targetRoot, 'maker-contacts', 'contacts.db'), 'utf-8')).resolves.toBe('legacy-contacts');
    await expect(fs.readFile(path.join(targetRoot, 'cindy-brain', 'user-plugin', 'manifest.json'), 'utf-8')).resolves.toBe('{}');
  });

  it('allows only the first verified cloud owner to claim remaining legacy data', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'builtin-tools-settings.json'), 'legacy');

    await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );
    await fs.writeFile(path.join(root, 'ghost-workdir-prefs.json'), 'left-behind');
    const second = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-b', user: { id: 'cloud-b' } },
      realFsDeps(root),
    );

    expect(second).toEqual({ status: 'claimed-by-other-owner', moved: 0, conflicts: 0 });
    const secondRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-b'));
    await expect(fs.access(path.join(secondRoot, 'ghost-workdir-prefs.json'))).rejects.toThrow();
    const marker = JSON.parse(
      await fs.readFile(path.join(root, __testing.CLAIM_MARKER), 'utf-8'),
    ) as { ownerKey: string };
    expect(marker.ownerKey).toBe(dataOwnerStorageKey('cloud-a'));
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(true);
    expect(hasLegacyOwnerNamespaceClaim('cloud-b', root)).toBe(false);
  });
});

function realFsDeps(root: string) {
  return {
    userDataDir: () => root,
    readFile: (file: string) => fs.readFile(file, 'utf-8'),
    writeFileExclusive: (file: string, text: string) =>
      fs.writeFile(file, text, { encoding: 'utf-8', flag: 'wx' }),
    writeFile: (file: string, text: string) => fs.writeFile(file, text, 'utf-8'),
    lstat: (file: string) => fs.lstat(file),
    readdir: (dir: string) => fs.readdir(dir),
    mkdir: async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
    },
    rename: (source: string, target: string) => fs.rename(source, target),
    rmdir: (dir: string) => fs.rmdir(dir),
  };
}
