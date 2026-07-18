import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_LINK_API_BASE_URL,
  deviceLinkWsUrl,
  getMobileConfigIssues,
  resolveEnvFlag,
  resolveDeviceLinkApiBaseUrl,
} from '@/config/env';

describe('mobile env', () => {
  it('resolves the device-link relay base URL(显式值优先,否则回落 env/dev 默认)', () => {
    expect(resolveDeviceLinkApiBaseUrl(undefined)).toBe(DEFAULT_DEVICE_LINK_API_BASE_URL);
    expect(resolveDeviceLinkApiBaseUrl('')).toBe(DEFAULT_DEVICE_LINK_API_BASE_URL);
    expect(resolveDeviceLinkApiBaseUrl(' https://relay.example.com/ ')).toBe('https://relay.example.com');
    expect(deviceLinkWsUrl('https://relay.example.com')).toBe('wss://relay.example.com/api/device-link/ws');
  });

  it('uses region defaults and rejects malformed explicit auth-server URLs', () => {
    expect(getMobileConfigIssues({})).toEqual([]);
    expect(
      getMobileConfigIssues({
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'ftp://auth.example.com',
      }).map((issue) => issue.key),
    ).toEqual(['EXPO_PUBLIC_CINDY_AUTH_BASE_URL']);
    expect(
      getMobileConfigIssues({
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'https://auth.example.com',
      }),
    ).toEqual([]);
  });

  it('parses boolean env flags for local auth testing', () => {
    expect(resolveEnvFlag(undefined)).toBe(false);
    expect(resolveEnvFlag('')).toBe(false);
    expect(resolveEnvFlag('0')).toBe(false);
    expect(resolveEnvFlag('1')).toBe(true);
    expect(resolveEnvFlag(' true ')).toBe(true);
    expect(resolveEnvFlag('YES')).toBe(true);
  });

  it('selects the bundled dev endpoint manifest from AUTH_REGION', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/config/env.ts'), 'utf8');
    expect(source).toContain("AUTH_REGION === 'global'");
    expect(source).toContain("require('../../../../config/endpoint.global.json')");
    expect(source).toContain("require('../../../../config/endpoint.json')");
  });
});
