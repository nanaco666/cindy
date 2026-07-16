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

  it('returns uncustomized state when a setting is manually changed back to default', async () => {
    const { writeMemorySetting } = await import('../memory-settings-store.js');

    const customized = writeMemorySetting('maker', true);
    expect(customized.isCustomized).toBe(true);
    expect(customized.customizedKeys).toEqual(['maker']);

    const restored = writeMemorySetting('maker', false);
    expect(restored.isCustomized).toBe(false);
    expect(restored.customizedKeys).toEqual([]);
    expect(fs.existsSync(path.join(userDataDir, 'memory-settings.json'))).toBe(false);
  });
});
