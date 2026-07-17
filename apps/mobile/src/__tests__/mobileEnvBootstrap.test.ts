import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMobileEnv,
  REQUIRED_MOBILE_ENV_KEYS,
} from '../../scripts/ensure-mobile-env.mjs';

const roots: string[] = [];

// 2026-07 端点清单重构后,.env 必填键收缩为构建身份 + 清单自举基址;
// 业务端点初值 dev 走仓内 config/endpoint.json,不再进 .env 必填集。
const productionEnv = {
  EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
  EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix.example.invalid/app',
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mobile simulator env bootstrap', () => {
  it('creates apps/mobile .env from eas production profile env', () => {
    const mobileDir = createMobileFixture({ production: { env: productionEnv } });

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.created).toBe(true);
    expect(result.addedKeys).toEqual(REQUIRED_MOBILE_ENV_KEYS);
    expect(env).toMatchObject(productionEnv);
    expect(env).not.toHaveProperty('EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED');
  });

  it('preserves existing user values and only fills missing or empty required keys', () => {
    const mobileDir = createMobileFixture({
      production: { env: productionEnv },
    });
    writeFileSync(
      join(mobileDir, '.env'),
      [
        '# local overrides',
        'EXPO_PUBLIC_CINDY_AUTH_REGION=global',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=',
        'EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED=1',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.created).toBe(false);
    expect(result.addedKeys).toEqual(['EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL']);
    expect(env.EXPO_PUBLIC_CINDY_AUTH_REGION).toBe('global');
    expect(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL).toBe(
      productionEnv.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL,
    );
    expect(env.EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED).toBe('1');
  });

  it('replaces copied example placeholders and quoted empty values', () => {
    const mobileDir = createMobileFixture({ production: { env: productionEnv } });
    writeEnvExample(mobileDir);
    writeFileSync(
      join(mobileDir, '.env'),
      [
        'EXPO_PUBLIC_CINDY_AUTH_REGION=',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=""',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.addedKeys).toEqual(REQUIRED_MOBILE_ENV_KEYS);
    expect(env).toMatchObject(productionEnv);
  });

  it('preserves real user values even when they are quoted', () => {
    const mobileDir = createMobileFixture({ production: { env: productionEnv } });
    writeEnvExample(mobileDir);
    writeFileSync(
      join(mobileDir, '.env'),
      [
        'EXPO_PUBLIC_CINDY_AUTH_REGION="global"',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL="https://hotfix.custom.example.invalid/app"',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.addedKeys).toEqual([]);
    expect(env.EXPO_PUBLIC_CINDY_AUTH_REGION).toBe('"global"');
    expect(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL).toBe(
      '"https://hotfix.custom.example.invalid/app"',
    );
  });
});

function createMobileFixture(build: Record<string, unknown>) {
  const mobileDir = mkdtempSync(join(tmpdir(), 'xdt-mobile-env-'));
  roots.push(mobileDir);
  writeFileSync(join(mobileDir, 'eas.json'), JSON.stringify({ build }, null, 2));
  return mobileDir;
}

function readEnvMap(envPath: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

function writeEnvExample(mobileDir: string) {
  writeFileSync(
    join(mobileDir, '.env.example'),
    [
      'EXPO_PUBLIC_CINDY_AUTH_REGION=cn',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=',
      '',
    ].join('\n'),
  );
}
