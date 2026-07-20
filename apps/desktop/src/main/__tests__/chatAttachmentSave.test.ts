import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createChatAttachmentSaveHandler,
  sanitizeAttachmentSaveName,
  type ChatAttachmentSaveDeps,
} from '../chatAttachmentSave';

function makeDeps(overrides: Partial<ChatAttachmentSaveDeps> = {}): ChatAttachmentSaveDeps {
  return {
    isPathAllowed: () => true,
    stat: vi.fn(async () => ({ isFile: () => true })),
    copyFile: vi.fn(async () => {}),
    showSaveDialog: vi.fn(async ({ defaultPath }) => ({
      canceled: false,
      filePath: `${defaultPath}.saved`,
    })),
    getDownloadsDir: () => path.resolve('downloads'),
    ...overrides,
  };
}

describe('sanitizeAttachmentSaveName', () => {
  it('keeps the original extension while removing path and platform hazards', () => {
    expect(sanitizeAttachmentSaveName('../../setup.exe')).toBe('setup.exe');
    expect(sanitizeAttachmentSaveName('a\\b/re:po|rt?.msi')).toBe('report.msi');
    expect(sanitizeAttachmentSaveName('NUL.exe')).toBe('_NUL.exe');
    expect(sanitizeAttachmentSaveName('.')).toBe('download.bin');
  });
});

describe('createChatAttachmentSaveHandler', () => {
  it('restores the sanitized original name for a .bin cache file without opening it', async () => {
    const deps = makeDeps();
    const sourcePath = path.resolve('cache', 'random.bin');
    const result = await createChatAttachmentSaveHandler(deps)({
      sourcePath,
      suggestedName: '../../setup.exe',
    });

    const defaultPath = path.join(path.resolve('downloads'), 'setup.exe');
    expect(deps.showSaveDialog).toHaveBeenCalledWith({ defaultPath });
    expect(deps.copyFile).toHaveBeenCalledWith(sourcePath, `${defaultPath}.saved`);
    expect(result).toEqual({ status: 'saved', savedPath: `${defaultPath}.saved` });
  });

  it('treats dialog cancellation as a no-op', async () => {
    const deps = makeDeps({ showSaveDialog: vi.fn(async () => ({ canceled: true })) });
    const result = await createChatAttachmentSaveHandler(deps)({
      sourcePath: path.resolve('cache', 'random.bin'),
      suggestedName: 'setup.exe',
    });
    expect(result).toEqual({ status: 'canceled' });
    expect(deps.copyFile).not.toHaveBeenCalled();
  });

  it('rejects relative, forbidden, missing, and non-file sources before opening the dialog', async () => {
    const relative = makeDeps();
    await expect(
      createChatAttachmentSaveHandler(relative)({
        sourcePath: 'relative.bin',
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'invalid_source' });

    const forbidden = makeDeps({ isPathAllowed: () => false });
    await expect(
      createChatAttachmentSaveHandler(forbidden)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'forbidden' });

    const missing = makeDeps({
      stat: vi.fn(async () => {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
    });
    await expect(
      createChatAttachmentSaveHandler(missing)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'not_found' });

    const directory = makeDeps({ stat: vi.fn(async () => ({ isFile: () => false })) });
    await expect(
      createChatAttachmentSaveHandler(directory)({
        sourcePath: path.resolve('cache', 'folder'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'not_file' });

    expect(relative.showSaveDialog).not.toHaveBeenCalled();
    expect(forbidden.showSaveDialog).not.toHaveBeenCalled();
    expect(missing.showSaveDialog).not.toHaveBeenCalled();
    expect(directory.showSaveDialog).not.toHaveBeenCalled();
  });

  it('reports dialog and copy failures without claiming a save', async () => {
    const dialogFailure = makeDeps({
      showSaveDialog: vi.fn(async () => {
        throw new Error('dialog failed');
      }),
    });
    await expect(
      createChatAttachmentSaveHandler(dialogFailure)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'dialog_failed' });

    const copyFailure = makeDeps({
      copyFile: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    await expect(
      createChatAttachmentSaveHandler(copyFailure)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'copy_failed' });
  });
});
