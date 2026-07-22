import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const TEST_ROOT = '/tmp/xdt-install-service-test';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(TEST_ROOT, 'userData')),
  },
  net: {
    fetch: vi.fn(),
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../authManager', () => ({
  getCurrentUserId: vi.fn(),
}));

vi.mock('../../clientEndpointsService', () => ({
  getClientEndpoint: vi.fn(() => 'https://skillhub.test.invalid'),
}));

vi.mock('../../serverApiClient', () => ({
  serverApiFetch: vi.fn(),
}));

vi.mock('../registry', () => ({
  registryService: {
    addInstall: vi.fn(),
    getInstall: vi.fn(),
    removeInstall: vi.fn(),
  },
}));

vi.mock('../folderHash', () => ({
  computeFolderHash: vi.fn(async () => 'folder-hash'),
}));

vi.mock('../../maker-host/shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: vi.fn(async () => ({ warnings: [] })),
  prepareSharedProjectSkillLinks: vi.fn(async () => ({ warnings: [] })),
  projectWorkingDirFromSkillPath: vi.fn(() => null),
}));

async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function mockDownload(zipBuf: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-length' ? String(zipBuf.byteLength) : null,
    },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: zipBuf };
          },
          cancel: vi.fn(),
        };
      },
    },
  } as unknown as Response;
}

describe('skillhub/installService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  it('keeps the previous install intact when extraction fails during forced update', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'broken-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');

    const zipBuf = await makeZip({
      dir: 'file blocks child directory',
      'dir/child.txt': 'cannot be written',
    });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/broken-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    const result = await install(
      {
        name: 'broken-skill',
        installPath: finalDir,
        version: '1.0.1',
        force: true,
        skipBackup: true,
      },
      () => {},
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe('EXTRACT_FAILED');
    expect(fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf-8')).toBe('old content');
  });

  it('rejects archives that exceed the entry count limit before replacing the target', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'huge-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');

    vi.doMock('jszip', () => ({
      default: {
        loadAsync: vi.fn(async () => ({
          files: Object.fromEntries(
            Array.from({ length: 10_001 }, (_, i) => [
              `file-${i}.txt`,
              { name: `file-${i}.txt`, dir: false },
            ]),
          ),
        })),
      },
    }));
    const zipBuf = new Uint8Array([1, 2, 3]);
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { install } = await import('../installService');

    try {
      vi.mocked(getCurrentUserId).mockReturnValue('user-1');
      vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
        if (apiPath.includes('/download')) {
          return {
            url: 'https://oss.example.com/huge-skill.zip',
            expiresAt: '2030-01-01T00:00:00.000Z',
            fileHash: 'file-hash',
            fileSize: zipBuf.byteLength,
            zipSha256: sha256(zipBuf),
          };
        }
        throw new Error(`unexpected api path ${apiPath}`);
      });
      vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));

      const result = await install(
        {
          name: 'huge-skill',
          installPath: finalDir,
          version: '1.0.1',
          force: true,
        },
        () => {},
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.errorCode).toBe('EXTRACT_FAILED');
      expect(fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf-8')).toBe('old content');
    } finally {
      vi.doUnmock('jszip');
    }
  });

  it('removes a fresh install directory when registry registration fails', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'registry-fail-skill');
    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/registry-fail-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'registry-fail-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockRejectedValue(new Error('registry down'));

    const result = await install(
      {
        name: 'registry-fail-skill',
        installPath: finalDir,
        version: '1.0.0',
      },
      () => {},
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe('WRITE_FAILED');
    expect(fs.existsSync(finalDir)).toBe(false);
  });

  it('restores the previous install when registry registration fails during skip-backup update', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'restore-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/restore-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'restore-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockRejectedValue(new Error('registry down'));

    const result = await install(
      {
        name: 'restore-skill',
        installPath: finalDir,
        version: '1.0.1',
        force: true,
        skipBackup: true,
      },
      () => {},
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe('WRITE_FAILED');
    expect(fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf-8')).toBe('old content');
    expect(fs.readdirSync(path.dirname(finalDir)).filter((name) => name.includes('.replacing.'))).toEqual([]);
  });

  it('restores the previous install when registry registration fails during backed-up update', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'backup-restore-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/backup-restore-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'backup-restore-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockRejectedValue(new Error('registry down'));

    const result = await install(
      {
        name: 'backup-restore-skill',
        installPath: finalDir,
        version: '1.0.1',
        force: true,
      },
      () => {},
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe('WRITE_FAILED');
    expect(fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf-8')).toBe('old content');
    expect(fs.readdirSync(path.dirname(finalDir)).filter((name) => name.includes('.bak.'))).toEqual([]);
  });

  it('moves persistent backups outside agent skill roots after a backed-up update succeeds', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'backup-success-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/backup-success-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'backup-success-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);

    const result = await install(
      {
        name: 'backup-success-skill',
        installPath: finalDir,
        version: '1.0.1',
        force: true,
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf-8')).toBe('new content');
    const skillRootEntries = fs.readdirSync(path.dirname(finalDir));
    expect(skillRootEntries.filter((name) => name.includes('.bak.'))).toEqual([]);
    expect(skillRootEntries.filter((name) => name.includes('.xdt-replacing-'))).toEqual([]);

    const backupRoot = path.join(TEST_ROOT, 'userData', 'skillhub', 'backups', 'backup-success-skill');
    const backups = fs.readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupRoot, backups[0], 'SKILL.md'), 'utf-8')).toBe('old content');
  });

  it('prepares the Claude compatibility link after installing a project skill', async () => {
    const projectRoot = path.join(TEST_ROOT, 'project');
    const finalDir = path.join(projectRoot, '.agents', 'skills', 'project-skill');
    const zipBuf = await makeZip({ 'SKILL.md': 'project content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const sharedSkills = await import('../../maker-host/shared-global-skills.js');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/project-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'project-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);
    vi.mocked(sharedSkills.projectWorkingDirFromSkillPath).mockReturnValue(projectRoot);

    const result = await install(
      {
        name: 'project-skill',
        installPath: finalDir,
        version: '1.0.0',
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(sharedSkills.prepareSharedProjectSkillLinks).toHaveBeenCalledWith({
      workingDir: projectRoot,
    });
  });

  it('clears a previous auto-sync ignore marker after a successful manual install', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'ignored-skill');
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(
      prefPath,
      JSON.stringify({
        schemaVersion: 1,
        ignoredSkills: [
          { name: 'ignored-skill', userId: 'user-1', ignoredAt: 1 },
          { name: 'other-skill', userId: 'user-1', ignoredAt: 2 },
          { name: 'ignored-skill', userId: 'user-2', ignoredAt: 3 },
        ],
      }),
      'utf-8',
    );

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/ignored-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'ignored-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);

    const result = await install(
      {
        name: 'ignored-skill',
        installPath: finalDir,
        version: '1.0.0',
      },
      () => {},
    );

    expect(result.success).toBe(true);
    const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
      ignoredSkills: Array<{ name: string; userId: string }>;
    };
    expect(stored.ignoredSkills).toMatchObject([
      { name: 'other-skill', userId: 'user-1' },
      { name: 'ignored-skill', userId: 'user-2' },
    ]);
    const entry = vi.mocked(registryService.addInstall).mock.calls[0]?.[2];
    expect(entry?.autoSynced).toBe(false);
  });

  it('repairs a corrupt auto-sync preference file after a successful manual install', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'ignored-skill');
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, '{ broken json', 'utf-8');

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/ignored-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'ignored-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);

    const result = await install(
      {
        name: 'ignored-skill',
        installPath: finalDir,
        version: '1.0.0',
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(prefPath, 'utf-8'))).toEqual({
      schemaVersion: 1,
      ignoredSkills: [],
      autoSyncCandidates: [],
    });
  });

  it('marks registry entries created by auto-sync installs', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'auto-installed-skill');
    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/auto-installed-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'auto-installed-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);

    const result = await install(
      {
        name: 'auto-installed-skill',
        installPath: finalDir,
        version: '1.0.0',
        autoSync: true,
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(registryService.addInstall).toHaveBeenCalledWith(
      'auto-installed-skill',
      finalDir,
      expect.objectContaining({ autoSynced: true }),
    );
  });

  it('does not clear user ignore marker after an internal auto-sync install', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'auto-installed-skill');
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(
      prefPath,
      JSON.stringify({
        schemaVersion: 1,
        ignoredSkills: [
          { name: 'auto-installed-skill', userId: 'user-1', ignoredAt: 1 },
        ],
      }),
      'utf-8',
    );

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/auto-installed-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'auto-installed-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);

    const result = await install(
      {
        name: 'auto-installed-skill',
        installPath: finalDir,
        version: '1.0.0',
        autoSync: true,
      },
      () => {},
    );

    expect(result.success).toBe(true);
    const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
      ignoredSkills: Array<{ name: string; userId: string }>;
    };
    expect(stored.ignoredSkills).toMatchObject([{ name: 'auto-installed-skill', userId: 'user-1' }]);
  });

  it('preserves auto-sync ownership when manually updating an auto-synced skill', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'auto-updated-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content', 'utf-8');

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/auto-updated-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'auto-updated-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.getInstall).mockResolvedValue({
      version: '1.0.0',
      authorId: 'owner',
      folderHash: 'old-hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed',
      autoSynced: true,
    });
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);

    const result = await install(
      {
        name: 'auto-updated-skill',
        installPath: finalDir,
        version: '1.0.1',
        force: true,
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(registryService.addInstall).toHaveBeenCalledWith(
      'auto-updated-skill',
      finalDir,
      expect.objectContaining({ autoSynced: true }),
    );
  });

  it('records an auto-sync ignore marker when uninstalling an auto-synced skill', async () => {
    const finalDir = path.join(TEST_ROOT, '.agents', 'skills', 'auto-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'content', 'utf-8');

    const { getCurrentUserId } = await import('../../authManager');
    const { registryService } = await import('../registry');
    const { uninstall } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue({
      version: '1.0.0',
      authorId: 'owner',
      folderHash: 'hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed',
      autoSynced: true,
    });
    vi.mocked(registryService.removeInstall).mockResolvedValue(undefined);

    const result = await uninstall(finalDir);

    expect(result.success).toBe(true);
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
      ignoredSkills: Array<{ name: string; userId: string }>;
    };
    expect(stored.ignoredSkills).toMatchObject([{ name: 'auto-skill', userId: 'user-1' }]);
  });

  it('records an auto-sync ignore marker when uninstalling a legacy auto-synced skill', async () => {
    const finalDir = path.join(TEST_ROOT, '.agents', 'skills', 'xdoa-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'content', 'utf-8');

    const { getCurrentUserId } = await import('../../authManager');
    const { registryService } = await import('../registry');
    const { uninstall } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue({
      version: '1.0.0',
      authorId: 'owner',
      folderHash: 'hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed',
    });
    vi.mocked(registryService.removeInstall).mockResolvedValue(undefined);

    const result = await uninstall(finalDir);

    expect(result.success).toBe(true);
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
      ignoredSkills: Array<{ name: string; userId: string }>;
    };
    expect(stored.ignoredSkills).toMatchObject([{ name: 'xdoa-skill', userId: 'user-1' }]);
  });

  it('records an auto-sync ignore marker when uninstalling a remote-config legacy auto-synced skill', async () => {
    const finalDir = path.join(TEST_ROOT, '.agents', 'skills', 'remote-auto-skill');
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'content', 'utf-8');
    fs.writeFileSync(
      prefPath,
      JSON.stringify({
        schemaVersion: 1,
        ignoredSkills: [],
        autoSyncCandidates: [
          { name: 'remote-auto-skill', userId: 'user-1', updatedAt: 1 },
        ],
      }),
      'utf-8',
    );

    const { getCurrentUserId } = await import('../../authManager');
    const { registryService } = await import('../registry');
    const { uninstall } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue({
      version: '1.0.0',
      authorId: 'owner',
      folderHash: 'hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed',
    });
    vi.mocked(registryService.removeInstall).mockResolvedValue(undefined);

    const result = await uninstall(finalDir);

    expect(result.success).toBe(true);
    const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
      ignoredSkills: Array<{ name: string; userId: string }>;
    };
    expect(stored.ignoredSkills).toMatchObject([{ name: 'remote-auto-skill', userId: 'user-1' }]);
  });

  it('preserves remote-config candidates when recording fallback auto-sync candidates', async () => {
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(
      prefPath,
      JSON.stringify({
        schemaVersion: 1,
        ignoredSkills: [],
        autoSyncCandidates: [
          { name: 'remote-auto-skill', userId: 'user-1', updatedAt: 1 },
          { name: 'other-user-skill', userId: 'user-2', updatedAt: 2 },
        ],
      }),
      'utf-8',
    );

    const { recordAutoSyncCandidateSkills } = await import('../autoSyncPreferences');

    await recordAutoSyncCandidateSkills('user-1', ['xdoa-skill'], { replace: false });

    const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
      autoSyncCandidates: Array<{ name: string; userId: string }>;
    };
    expect(stored.autoSyncCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'remote-auto-skill', userId: 'user-1' }),
      expect.objectContaining({ name: 'xdoa-skill', userId: 'user-1' }),
      expect.objectContaining({ name: 'other-user-skill', userId: 'user-2' }),
    ]));
  });

  it('repairs a corrupt auto-sync preferences file when listing ignored skills', async () => {
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, '{broken', 'utf-8');

    const { listIgnoredAutoSyncSkills } = await import('../autoSyncPreferences');

    await expect(listIgnoredAutoSyncSkills('user-1')).resolves.toEqual(new Set());
    expect(JSON.parse(fs.readFileSync(prefPath, 'utf-8'))).toEqual({
      schemaVersion: 1,
      ignoredSkills: [],
      autoSyncCandidates: [],
    });
  });

  it('merges auto-sync candidates by default when replace is omitted', async () => {
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(
      prefPath,
      JSON.stringify({
        schemaVersion: 1,
        ignoredSkills: [],
        autoSyncCandidates: [
          { name: 'remote-auto-skill', userId: 'user-1', updatedAt: 1 },
        ],
      }),
      'utf-8',
    );

    const { recordAutoSyncCandidateSkills } = await import('../autoSyncPreferences');

    await recordAutoSyncCandidateSkills('user-1', ['xdoa-skill']);

    const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
      autoSyncCandidates: Array<{ name: string; userId: string }>;
    };
    expect(stored.autoSyncCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'remote-auto-skill', userId: 'user-1' }),
      expect.objectContaining({ name: 'xdoa-skill', userId: 'user-1' }),
    ]));
  });

  it('does not record an auto-sync ignore marker when uninstalling a regular installed skill', async () => {
    const finalDir = path.join(TEST_ROOT, '.agents', 'skills', 'regular-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'content', 'utf-8');

    const { getCurrentUserId } = await import('../../authManager');
    const { registryService } = await import('../registry');
    const { uninstall } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue({
      version: '1.0.0',
      authorId: 'owner',
      folderHash: 'hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed',
    });
    vi.mocked(registryService.removeInstall).mockResolvedValue(undefined);

    const result = await uninstall(finalDir);

    expect(result.success).toBe(true);
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    expect(fs.existsSync(prefPath)).toBe(false);
  });

  it('does not record an auto-sync ignore marker when uninstalling a published skill', async () => {
    const finalDir = path.join(TEST_ROOT, '.agents', 'skills', 'published-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'content', 'utf-8');

    const { getCurrentUserId } = await import('../../authManager');
    const { registryService } = await import('../registry');
    const { uninstall } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue({
      version: '1.0.0',
      authorId: 'owner',
      folderHash: 'hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'published',
    });
    vi.mocked(registryService.removeInstall).mockResolvedValue(undefined);

    const result = await uninstall(finalDir);

    expect(result.success).toBe(true);
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    expect(fs.existsSync(prefPath)).toBe(false);
  });

  it('rolls back a successful update when moving the backup fails', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'backup-fail-skill');
    const prefPath = path.join(TEST_ROOT, 'userData', 'skillhub', 'auto-sync-preferences.json');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');
    fs.writeFileSync(
      prefPath,
      JSON.stringify({
        schemaVersion: 1,
        ignoredSkills: [
          { name: 'backup-fail-skill', userId: 'user-1', ignoredAt: 1 },
        ],
      }),
      'utf-8',
    );

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');
    const previousEntry = {
      version: '1.0.0',
      authorId: 'old-owner',
      folderHash: 'old-hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed' as const,
    };

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/backup-fail-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'backup-fail-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.getInstall).mockResolvedValue(previousEntry);
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.promises.mkdir>) => {
      const [target] = args;
      if (String(target).includes(`${path.sep}skillhub${path.sep}backups${path.sep}`)) {
        throw new Error('backup disk full');
      }
      return originalMkdir(...args);
    });

    try {
      const result = await install(
        {
          name: 'backup-fail-skill',
          installPath: finalDir,
          version: '2.0.0',
          force: true,
        },
        () => {},
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.errorCode).toBe('WRITE_FAILED');
      expect(fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf-8')).toBe('old content');
      expect(registryService.addInstall).toHaveBeenLastCalledWith('backup-fail-skill', finalDir, previousEntry);
      expect(fs.readdirSync(path.dirname(finalDir)).filter((name) => name.includes('.xdt-replacing-'))).toEqual([]);
      const stored = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as {
        ignoredSkills: Array<{ name: string; userId: string }>;
      };
      expect(stored.ignoredSkills).toMatchObject([{ name: 'backup-fail-skill', userId: 'user-1' }]);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it('removes the new registry entry when backup failure cannot restore the old registry entry', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'backup-registry-restore-fail-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');
    const previousEntry = {
      version: '1.0.0',
      authorId: 'old-owner',
      folderHash: 'old-hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed' as const,
    };

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/backup-registry-restore-fail-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'backup-registry-restore-fail-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.getInstall).mockResolvedValue(previousEntry);
    vi.mocked(registryService.removeInstall).mockResolvedValue(undefined);
    vi.mocked(registryService.addInstall)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('registry locked'));
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.promises.mkdir>) => {
      const [target] = args;
      if (String(target).includes(`${path.sep}skillhub${path.sep}backups${path.sep}`)) {
        throw new Error('backup disk full');
      }
      return originalMkdir(...args);
    });

    try {
      const result = await install(
        {
          name: 'backup-registry-restore-fail-skill',
          installPath: finalDir,
          version: '2.0.0',
          force: true,
        },
        () => {},
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('WRITE_FAILED');
        expect(result.message).toContain('registry 回滚失败');
      }
      expect(fs.existsSync(finalDir)).toBe(false);
      const quarantines = fs.readdirSync(path.dirname(finalDir))
        .filter((name) => name.includes('.xdt-rollback-registry-failed-backup-registry-restore-fail-skill-'));
      expect(quarantines).toHaveLength(1);
      expect(fs.readFileSync(path.join(path.dirname(finalDir), quarantines[0], 'SKILL.md'), 'utf-8')).toBe('old content');
      const removeInstallMock = vi.mocked(registryService.removeInstall);
      const addInstallMock = vi.mocked(registryService.addInstall);
      expect(removeInstallMock).toHaveBeenCalledWith('backup-registry-restore-fail-skill', finalDir);
      expect(removeInstallMock.mock.invocationCallOrder[0]).toBeLessThan(
        addInstallMock.mock.invocationCallOrder[1],
      );
      expect(registryService.addInstall).toHaveBeenNthCalledWith(
        2,
        'backup-registry-restore-fail-skill',
        finalDir,
        previousEntry,
      );
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it('quarantines the rolled back directory when removing the new registry entry fails', async () => {
    const finalDir = path.join(TEST_ROOT, 'skills', 'backup-registry-remove-fail-skill');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old content');

    const zipBuf = await makeZip({ 'SKILL.md': 'new content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { registryService } = await import('../registry');
    const { install } = await import('../installService');
    const previousEntry = {
      version: '1.0.0',
      authorId: 'old-owner',
      folderHash: 'old-hash',
      installedAt: 1,
      updatedAt: 1,
      origin: 'installed' as const,
    };

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/backup-registry-remove-fail-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'backup-registry-remove-fail-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
    vi.mocked(registryService.getInstall).mockResolvedValue(previousEntry);
    vi.mocked(registryService.addInstall).mockResolvedValue(undefined);
    vi.mocked(registryService.removeInstall).mockRejectedValue(new Error('registry remove locked'));
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.promises.mkdir>) => {
      const [target] = args;
      if (String(target).includes(`${path.sep}skillhub${path.sep}backups${path.sep}`)) {
        throw new Error('backup disk full');
      }
      return originalMkdir(...args);
    });

    try {
      const result = await install(
        {
          name: 'backup-registry-remove-fail-skill',
          installPath: finalDir,
          version: '2.0.0',
          force: true,
        },
        () => {},
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('WRITE_FAILED');
        expect(result.message).toContain('registry 回滚失败');
      }
      expect(fs.existsSync(finalDir)).toBe(false);
      const quarantines = fs.readdirSync(path.dirname(finalDir))
        .filter((name) => name.includes('.xdt-rollback-registry-failed-backup-registry-remove-fail-skill-'));
      expect(quarantines).toHaveLength(1);
      expect(fs.readFileSync(path.join(path.dirname(finalDir), quarantines[0], 'SKILL.md'), 'utf-8')).toBe('old content');
      expect(registryService.removeInstall).toHaveBeenCalledWith('backup-registry-remove-fail-skill', finalDir);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  // ── 共享安装锁(与 learn apply 互斥) ───────────────────────────────────────

  it('rejects install while a learn apply holds the shared lock; other names unaffected', async () => {
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { tryAcquireSkillInstallLock } = await import('../installLock');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    const releaseLearn = tryAcquireSkillInstallLock('locked-skill', 'learn-apply')!;
    try {
      const result = await install(
        { name: 'locked-skill', installPath: path.join(TEST_ROOT, 'skills', 'locked-skill'), version: '1.0.0' },
        () => {},
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('INTERNAL');
        expect(result.message).toContain('learn');
      }
      // fail-fast:没有触碰网络,也没有写 registry
      expect(vi.mocked(serverApiFetch)).not.toHaveBeenCalled();
      expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();

      // 不同名不互相阻塞:locked-skill 被 learn 锁着时,other-skill 正常装完
      const zipBuf = await makeZip({ 'SKILL.md': 'content' });
      vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
        if (apiPath.includes('/download')) {
          return {
            url: 'https://oss.example.com/other-skill.zip',
            expiresAt: '2030-01-01T00:00:00.000Z',
            fileHash: 'file-hash',
            fileSize: zipBuf.byteLength,
            zipSha256: sha256(zipBuf),
          };
        }
        if (apiPath.includes('/batch-detail')) {
          return { items: [{ slug: 'other-skill', owner: { slug: 'owner' }, isMine: false }] };
        }
        throw new Error(`unexpected api path ${apiPath}`);
      });
      vi.mocked(net.fetch).mockResolvedValue(mockDownload(zipBuf));
      const ok = await install(
        { name: 'other-skill', installPath: path.join(TEST_ROOT, 'skills', 'other-skill'), version: '1.0.0' },
        () => {},
      );
      expect(ok.success).toBe(true);
    } finally {
      releaseLearn();
    }
  });

  it('holds the shared lock for the whole install; learn-side acquire fails until done', async () => {
    const zipBuf = await makeZip({ 'SKILL.md': 'content' });
    const { net } = await import('electron');
    const { getCurrentUserId } = await import('../../authManager');
    const { serverApiFetch } = await import('../../serverApiClient');
    const { getSkillInstallLockOwner, tryAcquireSkillInstallLock } = await import('../installLock');
    const { install } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath.includes('/download')) {
        return {
          url: 'https://oss.example.com/race-skill.zip',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileHash: 'file-hash',
          fileSize: zipBuf.byteLength,
          zipSha256: sha256(zipBuf),
        };
      }
      if (apiPath.includes('/batch-detail')) {
        return { items: [{ slug: 'race-skill', owner: { slug: 'owner' }, isMine: false }] };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });
    let releaseDownload: (() => void) | undefined;
    vi.mocked(net.fetch).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseDownload = resolve;
      });
      return mockDownload(zipBuf);
    });

    const installing = install(
      { name: 'race-skill', installPath: path.join(TEST_ROOT, 'skills', 'race-skill'), version: '1.0.0' },
      () => {},
    );
    await vi.waitFor(() => {
      expect(releaseDownload).toBeDefined();
    });

    // 安装挂在下载上时:learn 侧同名获取失败,不同名不受影响
    expect(getSkillInstallLockOwner('race-skill')).toBe('market-install');
    expect(tryAcquireSkillInstallLock('race-skill', 'learn-apply')).toBeNull();
    const other = tryAcquireSkillInstallLock('race-unrelated', 'learn-apply');
    expect(other).not.toBeNull();
    other!();

    releaseDownload!();
    const result = await installing;
    expect(result.success).toBe(true);
    expect(getSkillInstallLockOwner('race-skill')).toBeNull();
  });

  it('rejects uninstall while a learn apply holds the shared lock', async () => {
    const dir = path.join(TEST_ROOT, '.agents', 'skills', 'locked-skill');
    fs.mkdirSync(dir, { recursive: true });
    const { getCurrentUserId } = await import('../../authManager');
    const { registryService } = await import('../registry');
    const { tryAcquireSkillInstallLock } = await import('../installLock');
    const { uninstall } = await import('../installService');

    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    const releaseLearn = tryAcquireSkillInstallLock('locked-skill', 'learn-apply')!;
    try {
      const result = await uninstall(dir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('INTERNAL');
        expect(result.message).toContain('learn');
      }
      expect(fs.existsSync(dir)).toBe(true);
      expect(vi.mocked(registryService.removeInstall)).not.toHaveBeenCalled();
    } finally {
      releaseLearn();
    }
  });
});
