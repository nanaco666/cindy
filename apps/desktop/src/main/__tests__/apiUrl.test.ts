/**
 * Tests for buildApiUrl — the same-origin guard for the `api:request` IPC
 * proxy. The proxy attaches the user's bearer token, so escaping the base
 * origin means leaking that token to an attacker. These tests pin that
 * every known escape shape is rejected and legitimate rooted paths pass.
 */

import { describe, expect, it } from 'vitest';

import { buildApiUrl } from '../apiUrl.js';

const BASE = 'https://api.example.com';

describe('buildApiUrl', () => {
  it('accepts a rooted same-origin path', () => {
    expect(buildApiUrl(BASE, '/api/issues')).toBe('https://api.example.com/api/issues');
  });

  it('preserves query strings on rooted paths', () => {
    expect(buildApiUrl(BASE, '/api/x?a=1&b=2')).toBe('https://api.example.com/api/x?a=1&b=2');
  });

  it('rejects the userinfo-authority attack (@host after base)', () => {
    // The original `API_BASE_URL + path` bug: path='@evil.com/x' →
    // 'https://api.example.com@evil.com/x' (evil.com is the real host).
    expect(() => buildApiUrl(BASE, '@evil.com/x')).toThrow();
  });

  it('rejects absolute URLs to another origin', () => {
    expect(() => buildApiUrl(BASE, 'https://evil.com/x')).toThrow();
    expect(() => buildApiUrl(BASE, 'http://evil.com/x')).toThrow();
  });

  it('rejects protocol-relative authority (//host)', () => {
    expect(() => buildApiUrl(BASE, '//evil.com/x')).toThrow();
  });

  it('rejects backslash authority (/\\host)', () => {
    expect(() => buildApiUrl(BASE, '/\\evil.com/x')).toThrow();
  });

  it('rejects non-rooted relative paths', () => {
    expect(() => buildApiUrl(BASE, 'api/issues')).toThrow();
    expect(() => buildApiUrl(BASE, '')).toThrow();
  });

  it('rejects non-string input (renderer input is untrusted)', () => {
    // apiPath is typed `unknown` on purpose — the runtime guard, not the type
    // system, is what protects the credentialed fetch.
    expect(() => buildApiUrl(BASE, undefined)).toThrow();
    expect(() => buildApiUrl(BASE, { toString: () => '/api/x' })).toThrow();
    expect(() => buildApiUrl(BASE, 42)).toThrow();
  });

  it('does not let a path change the port/scheme of the base', () => {
    // Even with a rooted path the resolved origin must equal the base origin.
    expect(buildApiUrl('https://host:8443', '/x')).toBe('https://host:8443/x');
  });
});
