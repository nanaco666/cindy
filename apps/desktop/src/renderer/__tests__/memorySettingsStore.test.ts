import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createStorage(initial?: boolean): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set('memorySettings.makerEnabled', initial ? 'true' : 'false');
  }
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('memorySettingsStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to enabled when no renderer value exists', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const { getMakerMemoryEnabled } = await import('@/lib/memorySettingsStore');

    expect(getMakerMemoryEnabled()).toBe(true);
  });

  it('keeps a user toggle in memory when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const { getMakerMemoryEnabled, setMakerMemoryEnabled } = await import(
      '@/lib/memorySettingsStore'
    );

    expect(getMakerMemoryEnabled()).toBe(true);
    setMakerMemoryEnabled(false);
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('migrates a legacy false marker before syncing the new main default', async () => {
    vi.stubGlobal('localStorage', createStorage(false));
    const preserveLegacy = vi.fn().mockResolvedValue({
      maker: false,
      claudeCode: true,
      codex: true,
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: true,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled } = await import(
      '@/lib/memorySettingsStore'
    );

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).toHaveBeenCalledOnce();
    expect(preserveLegacy).toHaveBeenCalledWith(false);
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('migrates a legacy native-all-off profile without a renderer marker', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const preserveLegacy = vi.fn().mockResolvedValue({
      maker: false,
      claudeCode: false,
      codex: false,
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: false,
            codex: false,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled } = await import(
      '@/lib/memorySettingsStore'
    );

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).toHaveBeenCalledWith(null);
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('syncs a persisted Maker opt-out before the main view can create sessions', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const preserveLegacy = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: false,
            claudeCode: true,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled } = await import(
      '@/lib/memorySettingsStore'
    );

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).not.toHaveBeenCalled();
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('does not overwrite a user write that happens while bootstrap is pending', async () => {
    vi.stubGlobal('localStorage', createStorage(true));
    let resolveSettings!: (settings: {
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }) => void;
    const settingsPromise = new Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }>((resolve) => {
      resolveSettings = resolve;
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn(() => settingsPromise),
          memoryPreserveLegacyMakerDisabled: vi.fn(),
        },
      },
    });
    const {
      bootstrapMemorySettingsFromMain,
      getMakerMemoryEnabled,
      setMakerMemoryEnabled,
    } = await import('@/lib/memorySettingsStore');

    const bootstrap = bootstrapMemorySettingsFromMain();
    setMakerMemoryEnabled(false);
    resolveSettings({ maker: true, claudeCode: true, codex: true });
    await bootstrap;

    expect(getMakerMemoryEnabled()).toBe(false);
  });
});
