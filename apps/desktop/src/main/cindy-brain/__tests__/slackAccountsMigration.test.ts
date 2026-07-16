/**
 * slackAccountsMigration 单测:老 Slack 官方 MCP 集成(单账号 safe-storage)
 * → cindy-slack 意识保险库的一次性搬账(规则 14,内存假体零 Electron)。
 * 用例形态镜像 atlassianAccountsMigration.test.ts(同一套搬账纪律)。
 */
import { describe, expect, it } from 'vitest';

import {
  CINDY_SLACK_GHOST_ID,
  CINDY_SLACK_SECRET_KEY,
  migrateSlackAccounts,
  type SlackAccountsMigrationDeps,
} from '../slackAccountsMigration.js';
import type { GhostOauthVault } from '../ghostOauthAccounts.js';

function memoryVault(seed?: Record<string, string>): GhostOauthVault & { data: Map<string, string> } {
  const data = new Map<string, string>(
    Object.entries(seed ?? {}).map(([k, v]) => [`${CINDY_SLACK_GHOST_ID} ${k}`, v]),
  );
  return {
    data,
    read: (ghostId, key) => data.get(`${ghostId} ${key}`) ?? null,
    store: (ghostId, key, value) => {
      data.set(`${ghostId} ${key}`, value);
      return true;
    },
    remove: (ghostId, key) => {
      data.delete(`${ghostId} ${key}`);
    },
  };
}

function makeDeps(overrides?: Partial<SlackAccountsMigrationDeps>): SlackAccountsMigrationDeps {
  return {
    readLegacyRefreshToken: () => 'rt-legacy',
    readLegacyConnection: () => ({ userId: 'U0123ABCD' }),
    vault: memoryVault(),
    ...overrides,
  };
}

function readManifest(vault: GhostOauthVault): {
  defaultAccountId: string | null;
  accounts: Array<{ id: string; label: string | null; status: string; createdAt: number }>;
} | null {
  const raw = vault.read(CINDY_SLACK_GHOST_ID, `${CINDY_SLACK_SECRET_KEY}-accounts`);
  return raw ? (JSON.parse(raw) as ReturnType<typeof readManifest>) : null;
}

describe('migrateSlackAccounts', () => {
  it('有老 rt:迁一个账号,label = 老连接 userId,rt 落 vault,老存储不动', () => {
    const vault = memoryVault();
    expect(migrateSlackAccounts(makeDeps({ vault }))).toBe(1);
    const manifest = readManifest(vault);
    expect(manifest).not.toBeNull();
    expect(manifest?.accounts).toHaveLength(1);
    const account = manifest!.accounts[0];
    expect(account.label).toBe('U0123ABCD');
    expect(account.status).toBe('connected');
    expect(manifest!.defaultAccountId).toBe(account.id);
    expect(vault.read(CINDY_SLACK_GHOST_ID, `${CINDY_SLACK_SECRET_KEY}-rt-${account.id}`)).toBe('rt-legacy');
  });

  it('意识侧已有账号清单 → 整体跳过(幂等,二次启动不重复迁)', () => {
    const vault = memoryVault({
      [`${CINDY_SLACK_SECRET_KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'existing',
        accounts: [{ id: 'existing', label: 'U9EXIST', status: 'connected', createdAt: 1 }],
      }),
    });
    expect(migrateSlackAccounts(makeDeps({ vault }))).toBe(0);
    expect(readManifest(vault)?.accounts[0]?.id).toBe('existing');
  });

  it('无老存储 / rt 解密失败 → no-op', () => {
    const vault = memoryVault();
    expect(migrateSlackAccounts(makeDeps({ vault, readLegacyRefreshToken: () => null }))).toBe(0);
    expect(readManifest(vault)).toBeNull();
  });

  it('连接信息缺失或无 userId → label 为 null,照迁', () => {
    const vault = memoryVault();
    expect(migrateSlackAccounts(makeDeps({ vault, readLegacyConnection: () => null }))).toBe(1);
    expect(readManifest(vault)?.accounts[0]?.label).toBeNull();
  });

  it('清单写失败 → 回收已搬 rt,保持"没迁过"状态', () => {
    const vault = memoryVault();
    const failingVault: GhostOauthVault = {
      read: vault.read,
      store: (ghostId, key, value) => {
        if (key === `${CINDY_SLACK_SECRET_KEY}-accounts`) return false;
        return vault.store(ghostId, key, value);
      },
      remove: vault.remove,
    };
    expect(migrateSlackAccounts(makeDeps({ vault: failingVault }))).toBe(0);
    // rt 已回收,vault 里不残留任何键。
    expect(vault.data.size).toBe(0);
  });
});
