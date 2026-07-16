import { describe, expect, it } from 'vitest';

import {
  countFileDragItems,
  hasFileDragPayload,
  isDroppedFilePreviewSupported,
  splitExternalFilePath,
} from '../dropExternalFile';

describe('file-browser external drop helpers', () => {
  it('allows the formats the sidebar can preview directly', () => {
    expect(isDroppedFilePreviewSupported('C:\\tmp\\note.md')).toBe(true);
    expect(isDroppedFilePreviewSupported('/tmp/photo.PNG')).toBe(true);
    expect(isDroppedFilePreviewSupported('/tmp/spec.pdf')).toBe(true);
    expect(isDroppedFilePreviewSupported('/tmp/diagram.drawio')).toBe(true);
    expect(isDroppedFilePreviewSupported('/tmp/archive.zip')).toBe(false);
    expect(isDroppedFilePreviewSupported('/tmp/movie.mp4')).toBe(false);
  });

  it('splits native absolute paths into a workdir and basename relPath', () => {
    expect(splitExternalFilePath('C:\\tmp\\note.md')).toEqual({
      absPath: 'C:\\tmp\\note.md',
      workdir: 'C:\\tmp',
      relPath: 'note.md',
    });
    expect(splitExternalFilePath('C:\\note.md')).toEqual({
      absPath: 'C:\\note.md',
      workdir: 'C:\\',
      relPath: 'note.md',
    });
    expect(splitExternalFilePath('/tmp/note.md')).toEqual({
      absPath: '/tmp/note.md',
      workdir: '/tmp',
      relPath: 'note.md',
    });
    expect(splitExternalFilePath('/note.md')).toEqual({
      absPath: '/note.md',
      workdir: '/',
      relPath: 'note.md',
    });
    expect(splitExternalFilePath('note.md')).toBeNull();
    expect(splitExternalFilePath('/tmp/')).toBeNull();
  });

  it('only treats native file drags as external file payloads', () => {
    expect(hasFileDragPayload({ types: ['Files'], files: { length: 0 } })).toBe(true);
    expect(hasFileDragPayload({ types: [], files: { length: 1 } })).toBe(true);
    expect(hasFileDragPayload({ types: ['text/plain'], files: { length: 0 } })).toBe(false);
    expect(hasFileDragPayload({ types: ['application/x-panel-drag'], files: { length: 0 } })).toBe(false);
  });

  it('counts native file items before falling back to the files list', () => {
    expect(
      countFileDragItems({
        items: {
          length: 3,
          0: { kind: 'file' },
          1: { kind: 'string' },
          2: { kind: 'file' },
        },
        files: { length: 9 },
      }),
    ).toBe(2);
    expect(countFileDragItems({ items: { length: 1, 0: { kind: 'string' } }, files: { length: 2 } })).toBe(2);
    expect(countFileDragItems({ files: { length: 1 } })).toBe(1);
  });
});
