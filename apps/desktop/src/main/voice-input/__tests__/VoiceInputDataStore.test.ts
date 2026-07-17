import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => {
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
  return {
    dataDir: '',
    window,
    appGetPath: vi.fn(() => mocks.dataDir),
  };
});

vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPath },
  BrowserWindow: { getAllWindows: vi.fn(() => [mocks.window]) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { VoiceInputDataStore } from '../VoiceInputDataStore.js';

describe('VoiceInputDataStore persistence', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-input-data-store-'));
    mocks.dataDir = dataDir;
    mocks.window.webContents.send.mockClear();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the candidate before committing state and broadcasting it', () => {
    const store = new VoiceInputDataStore();

    const next = store.updateSettings({ language: 'en' });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'voice-input-data.v1.json'), 'utf8'),
    ) as { settings: { language: string } };

    expect(next.language).toBe('en');
    expect(persisted.settings.language).toBe('en');
    expect(store.getSettings().language).toBe('en');
    expect(mocks.window.webContents.send).toHaveBeenCalledTimes(1);
    expect(mocks.window.webContents.send).toHaveBeenCalledWith(
      'voice-input:data-changed',
      expect.objectContaining({ settings: expect.objectContaining({ language: 'en' }) }),
    );
  });

  it.each([
    ['writeFileSync', 'disk full'],
    ['renameSync', 'rename denied'],
  ])('keeps the previous state and does not broadcast when %s fails', (_operation, message) => {
    const store = new VoiceInputDataStore();
    store.updateSettings({ language: 'en' });
    mocks.window.webContents.send.mockClear();
    const before = store.getSnapshot();
    const failure = new Error(message);

    const method = _operation === 'writeFileSync' ? 'writeFileSync' : 'renameSync';
    vi.spyOn(fs, method).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => store.updateSettings({ language: 'ja' })).toThrow(
      `voice input data write failed: ${message}`,
    );
    expect(store.getSnapshot()).toEqual(before);
    expect(mocks.window.webContents.send).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'voice-input-data.v1.json'), 'utf8'),
    ) as { settings: { language: string } };
    expect(persisted.settings.language).toBe('en');
  });
});
