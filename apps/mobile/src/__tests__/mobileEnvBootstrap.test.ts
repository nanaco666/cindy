import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE_URL, DEFAULT_DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMobileEnv,
  REQUIRED_MOBILE_ENV_KEYS,
} from '../../scripts/ensure-mobile-env.mjs';

const roots: string[] = [];

const productionEnv = {
  EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
  EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'https://auth-cn.example.com',
  EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.prod.example.com',
  EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.prod.example.com',
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
        'EXPO_PUBLIC_CINDY_AUTH_BASE_URL=',
        'EXPO_PUBLIC_XDT_API_BASE_URL=',
        'EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED=1',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.created).toBe(false);
    expect(result.addedKeys).toEqual([
      'EXPO_PUBLIC_CINDY_AUTH_BASE_URL',
      'EXPO_PUBLIC_XDT_API_BASE_URL',
      'EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL',
    ]);
    expect(env.EXPO_PUBLIC_CINDY_AUTH_REGION).toBe('global');
    expect(env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL).toBe(
      productionEnv.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
    );
    expect(env.EXPO_PUBLIC_XDT_API_BASE_URL).toBe(
      productionEnv.EXPO_PUBLIC_XDT_API_BASE_URL,
    );
    expect(env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL).toBe(
      productionEnv.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL,
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
        'EXPO_PUBLIC_CINDY_AUTH_BASE_URL=""',
        'EXPO_PUBLIC_XDT_API_BASE_URL=""',
        "EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL=''",
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
        "EXPO_PUBLIC_CINDY_AUTH_BASE_URL='https://auth.custom.example.com'",
        "EXPO_PUBLIC_XDT_API_BASE_URL='https://api.custom.example.com'",
        'EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL="https://relay.custom.example.com"',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.addedKeys).toEqual([]);
    expect(env.EXPO_PUBLIC_CINDY_AUTH_REGION).toBe('"global"');
    expect(env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL).toBe(
      "'https://auth.custom.example.com'",
    );
    expect(env.EXPO_PUBLIC_XDT_API_BASE_URL).toBe(
      "'https://api.custom.example.com'",
    );
    expect(env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL).toBe(
      '"https://relay.custom.example.com"',
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
      'EXPO_PUBLIC_CINDY_AUTH_BASE_URL=',
      `EXPO_PUBLIC_XDT_API_BASE_URL=${DEFAULT_API_BASE_URL}`,
      `EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL=${DEFAULT_DEVICE_LINK_API_BASE_URL}`,
      '',
    ].join('\n'),
  );
}
