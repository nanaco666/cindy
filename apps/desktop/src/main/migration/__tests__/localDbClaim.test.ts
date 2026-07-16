import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertIdentityAnchor, IDENTITY_ANCHOR_REL_PATH } from '../identityAnchor';
import { claimLegacyLocalDb } from '../localDbClaim';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';

let userDataDir: string;
const copyDatabase = vi.fn(async (sourcePath: string, targetPath: string) => {
  fs.copyFileSync(sourcePath, targetPath);
});

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-claim-'));
  copyDatabase.mockClear();
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

function seedAnchor(userId: string, email: string): void {
  upsertIdentityAnchor(path.join(userDataDir, IDENTITY_ANCHOR_REL_PATH), {
    userId,
    email,
    feishuOpenId: null,
  });
}

describe('claimLegacyLocalDb', () => {
  it('email 唯一命中时复制旧 UID 库，保留源并写认领 sentinel', async () => {
    seedAnchor('old-uid', 'a@xd.com');
    seedAnchor('new-uid', 'a@xd.com');
    const source = path.join(userDataDir, 'xdt-maker-old-uid.db');
    fs.writeFileSync(source, 'legacy-db');

    const result = await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'cindy',
      dbFilePrefixes: ['cindy', 'xdt-maker'],
      newUserId: 'new-uid',
      email: ' A@XD.COM ',
      copyDatabase,
      nowIso: () => '2026-07-15T00:00:00.000Z',
    });

    expect(result).toMatchObject({ status: 'claimed', oldUserId: 'old-uid' });
    expect(fs.readFileSync(path.join(userDataDir, 'cindy-new-uid.db'), 'utf8')).toBe('legacy-db');
    expect(fs.readFileSync(source, 'utf8')).toBe('legacy-db');
    expect(fs.readdirSync(path.join(userDataDir, 'migration'))).toContain(
      `db-claim-${Buffer.from('new-uid').toString('base64url')}.json`,
    );
  });

  it('老账号缺 email 时按唯一 feishuOpenId 兜底认领', async () => {
    upsertIdentityAnchor(path.join(userDataDir, IDENTITY_ANCHOR_REL_PATH), {
      userId: 'old-uid',
      email: null,
      feishuOpenId: 'ou_same',
    });
    upsertIdentityAnchor(path.join(userDataDir, IDENTITY_ANCHOR_REL_PATH), {
      userId: 'new-uid',
      email: 'new@xd.com',
      feishuOpenId: 'ou_same',
    });
    fs.writeFileSync(path.join(userDataDir, 'xdt-maker-old-uid.db'), 'legacy-db');

    const result = await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'cindy',
      dbFilePrefixes: ['xdt-maker'],
      newUserId: 'new-uid',
      email: 'new@xd.com',
      feishuOpenId: 'ou_same',
      copyDatabase,
    });

    expect(result).toMatchObject({ status: 'claimed', oldUserId: 'old-uid' });
  });

  it('db 前缀不变时也能按 old UID → new UID 认领', async () => {
    seedAnchor('old-uid', 'a@xd.com');
    fs.writeFileSync(path.join(userDataDir, 'xdt-maker-old-uid.db'), 'legacy-db');
    const result = await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'xdt-maker',
      dbFilePrefixes: ['xdt-maker'],
      newUserId: 'new-uid',
      email: 'a@xd.com',
      copyDatabase,
    });
    expect(result.status).toBe('claimed');
  });

  it('默认 SQLite online backup 产出可读的完整目标库', async () => {
    seedAnchor('old-uid', 'a@xd.com');
    const source = path.join(userDataDir, 'xdt-maker-old-uid.db');
    const sourceDb = createBetterSqliteDatabase(source);
    sourceDb.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    sourceDb.prepare('INSERT INTO notes (body) VALUES (?)').run('legacy row');
    sourceDb.close();

    const result = await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'cindy',
      dbFilePrefixes: ['xdt-maker'],
      newUserId: 'new-uid',
      email: 'a@xd.com',
    });
    expect(result.status).toBe('claimed');
    const targetDb = createBetterSqliteDatabase(path.join(userDataDir, 'cindy-new-uid.db'), {
      readonly: true,
    });
    expect(targetDb.prepare('SELECT body FROM notes').get()).toEqual({ body: 'legacy row' });
    targetDb.close();
  });

  it('目标已存在时绝不覆盖', async () => {
    seedAnchor('old-uid', 'a@xd.com');
    fs.writeFileSync(path.join(userDataDir, 'xdt-maker-old-uid.db'), 'legacy-db');
    fs.writeFileSync(path.join(userDataDir, 'cindy-new-uid.db'), 'current-db');
    const result = await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'cindy',
      dbFilePrefixes: ['xdt-maker'],
      newUserId: 'new-uid',
      email: 'a@xd.com',
      copyDatabase,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'target-exists' });
    expect(copyDatabase).not.toHaveBeenCalled();
  });

  it('无唯一 email 锚或多个旧库候选时不猜测', async () => {
    seedAnchor('old-a', 'dup@xd.com');
    seedAnchor('old-b', 'dup@xd.com');
    expect((await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'cindy',
      dbFilePrefixes: ['xdt-maker'],
      newUserId: 'new-uid',
      email: 'dup@xd.com',
      copyDatabase,
    }))).toEqual({ status: 'skipped', reason: 'no-unique-anchor' });

    seedAnchor('only-old', 'one@xd.com');
    fs.writeFileSync(path.join(userDataDir, 'xdt-maker-only-old.db'), 'a');
    fs.writeFileSync(path.join(userDataDir, 'legacy-only-old.db'), 'b');
    expect((await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'cindy',
      dbFilePrefixes: ['xdt-maker', 'legacy'],
      newUserId: 'new-uid',
      email: 'one@xd.com',
      copyDatabase,
    }))).toEqual({ status: 'skipped', reason: 'ambiguous-source-db' });
  });

  it('复制失败时清临时文件并返回 failed，目标库不落位', async () => {
    seedAnchor('old-uid', 'a@xd.com');
    fs.writeFileSync(path.join(userDataDir, 'xdt-maker-old-uid.db'), 'legacy-db');
    const result = await claimLegacyLocalDb({
      userDataDir,
      currentDbPrefix: 'cindy',
      dbFilePrefixes: ['xdt-maker'],
      newUserId: 'new-uid',
      email: 'a@xd.com',
      copyDatabase: async (_source, target) => {
        fs.writeFileSync(target, 'partial');
        throw new Error('backup failed');
      },
    });
    expect(result).toEqual({ status: 'failed', error: 'backup failed' });
    expect(fs.existsSync(path.join(userDataDir, 'cindy-new-uid.db'))).toBe(false);
    expect(fs.readdirSync(userDataDir).some((name) => name.includes('.claim-'))).toBe(false);
  });
});
