import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_DEVICE_LINK_API_BASE_URL,
  deviceLinkWsUrl,
  getMobileConfigIssues,
  normalizeBaseUrl,
  resolveEnvFlag,
  resolveDeviceLinkApiBaseUrl,
} from '@/config/env';

describe('mobile env', () => {
  it('normalizes the API base URL', () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_API_BASE_URL);
    expect(normalizeBaseUrl('')).toBe(DEFAULT_API_BASE_URL);
    expect(normalizeBaseUrl('https://example.com/')).toBe('https://example.com');
  });

  it('resolves the split device-link relay base URL', () => {
    expect(resolveDeviceLinkApiBaseUrl(undefined, DEFAULT_API_BASE_URL)).toBe(DEFAULT_DEVICE_LINK_API_BASE_URL);
    expect(resolveDeviceLinkApiBaseUrl(' https://relay.example.com/ ', DEFAULT_API_BASE_URL)).toBe('https://relay.example.com');
    expect(resolveDeviceLinkApiBaseUrl(undefined, 'http://localhost:3333')).toBe('http://localhost:3335');
    expect(resolveDeviceLinkApiBaseUrl(undefined, 'http://192.168.68.84:3333/')).toBe('http://192.168.68.84:3335');
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
});
