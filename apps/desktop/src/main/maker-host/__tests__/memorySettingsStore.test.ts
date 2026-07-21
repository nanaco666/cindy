import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected path: ${name}`);
      return userDataDir;
    },
  },
}));

describe('memory-settings-store', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-memory-settings-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('enables Maker Memory by default for a new user', async () => {
    const { readMemorySettings } = await import('../memory-settings-store.js');

    expect(readMemorySettings()).toEqual({ maker: true, claudeCode: true, codex: true });
  });

  it('persists a legacy renderer opt-out under the new enabled default', async () => {
    const { preserveLegacyMakerMemoryDisabled, readMemorySettingsState } = await import(
      '../memory-settings-store.js'
    );

    expect(preserveLegacyMakerMemoryDisabled().maker).toBe(false);
    expect(readMemorySettingsState()).toMatchObject({
      value: { maker: false, claudeCode: true, codex: true },
      customizedKeys: ['maker'],
    });
  });

  it('does not overwrite an existing maker override during legacy migration', async () => {
    fs.writeFileSync(
      path.join(userDataDir, 'memory-settings.json'),
      JSON.stringify({ maker: true }),
      'utf-8',
    );
    const { preserveLegacyMakerMemoryDisabled } = await import('../memory-settings-store.js');

    expect(preserveLegacyMakerMemoryDisabled().maker).toBe(true);
  });

  it('returns uncustomized state when a setting is manually changed back to default', async () => {
    const { writeMemorySetting } = await import('../memory-settings-store.js');

    const customized = writeMemorySetting('maker', false);
    expect(customized.isCustomized).toBe(true);
    expect(customized.customizedKeys).toEqual(['maker']);

    const restored = writeMemorySetting('maker', true);
    expect(restored.isCustomized).toBe(false);
    expect(restored.customizedKeys).toEqual([]);
    expect(fs.existsSync(path.join(userDataDir, 'memory-settings.json'))).toBe(false);
  });
});
