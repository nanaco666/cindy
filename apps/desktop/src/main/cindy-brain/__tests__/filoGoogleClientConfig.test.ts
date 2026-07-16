import { describe, expect, it, vi } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost.js';
import {
  migrateLegacyBundledFiloGoogleClientConfig,
  withFiloGoogleBuildClientConfig,
} from '../filoGoogleClientConfig.js';

function manifest(oauth: Record<string, unknown> = {}): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'filo-google',
    name: 'Filo Google',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['network'],
    network: {
      hosts: ['accounts.google.com'],
      secrets: [{
        key: 'google_account',
        label: 'Google 账号',
        source: 'oauth',
        inject: { header: 'Authorization', format: 'Bearer {value}' },
        oauth: {
          authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          ...oauth,
        },
      }],
    },
  };
}

function memoryVault(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    read: (_ghostId: string, key: string) => data.get(key) ?? null,
    store: (_ghostId: string, key: string, value: string) => {
      data.set(key, value);
      return true;
    },
    remove: (_ghostId: string, key: string) => {
      data.delete(key);
    },
  };
}

describe('withFiloGoogleBuildClientConfig', () => {
  it('只在 main 内存 manifest 补构建环境 client，不修改原对象', () => {
    const source = manifest();
    const hydrated = withFiloGoogleBuildClientConfig(source, {
      clientId: ' build-client ',
      clientSecret: ' build-secret ',
    });
    const oauth = hydrated.network?.secrets?.[0]?.oauth;
    expect(oauth).toMatchObject({ clientId: 'build-client', clientSecret: 'build-secret' });
    expect(source.network?.secrets?.[0]?.oauth?.clientId).toBeUndefined();
  });

  it('非 Filo Google 或未配置环境变量时原样返回', () => {
    const source = manifest();
    expect(withFiloGoogleBuildClientConfig(source, {})).toBe(source);
    expect(withFiloGoogleBuildClientConfig({ ...source, id: 'other' }, { clientId: 'x' }).id).toBe('other');
  });

  it('发布环境只给 clientId 时按纯 PKCE 处理，不混用旧 secret', () => {
    const source = manifest({ clientId: 'old-client', clientSecret: 'old-secret' });
    const oauth = withFiloGoogleBuildClientConfig(source, { clientId: 'new-client' })
      .network?.secrets?.[0]?.oauth;
    expect(oauth?.clientId).toBe('new-client');
    expect(oauth?.clientSecret).toBeUndefined();
  });
});

describe('migrateLegacyBundledFiloGoogleClientConfig', () => {
  it('把旧安装 manifest 的 client 搬进保险库', () => {
    const vault = memoryVault();
    expect(migrateLegacyBundledFiloGoogleClientConfig(
      manifest({ clientId: 'old-client', clientSecret: 'old-secret' }),
      vault,
    )).toBe(true);
    expect(vault.data.get('google_account-client-id')).toBe('old-client');
    expect(vault.data.get('google_account-client-secret')).toBe('old-secret');
  });

  it('已有用户配置时不覆盖；secret 写失败时回滚 id', () => {
    const existing = memoryVault({ 'google_account-client-id': 'custom-client' });
    expect(migrateLegacyBundledFiloGoogleClientConfig(manifest({ clientId: 'old-client' }), existing)).toBe(false);
    expect(existing.data.get('google_account-client-id')).toBe('custom-client');

    const failing = memoryVault();
    const store = vi.fn((_ghostId: string, key: string, value: string) => {
      if (key.endsWith('client-secret')) return false;
      failing.data.set(key, value);
      return true;
    });
    expect(migrateLegacyBundledFiloGoogleClientConfig(
      manifest({ clientId: 'old-client', clientSecret: 'old-secret' }),
      { ...failing, store },
    )).toBe(false);
    expect(failing.data.has('google_account-client-id')).toBe(false);
  });
});
