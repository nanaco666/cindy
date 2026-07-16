import { describe, expect, it } from 'vitest';
import { formatMobileBuildLabel, normalizeBuildInfo } from '@/config/buildInfo';

describe('mobile build info', () => {
  it('normalizes branch / commit / version / buildNumber / metroHost', () => {
    expect(normalizeBuildInfo({
      branch: 'dash/mobile-sim-rebuild-tool',
      commit: 'abc1234',
      version: '1.0.0',
      buildNumber: '2026062608',
      metroHost: '127.0.0.1:8082',
    })).toEqual({
      branch: 'dash/mobile-sim-rebuild-tool',
      commit: 'abc1234',
      version: '1.0.0',
      buildNumber: '2026062608',
      metroHost: '127.0.0.1:8082',
    });
  });

  it('blank / non-string sources collapse to null, version defaults to 0.0.0', () => {
    expect(normalizeBuildInfo({ branch: '  ', commit: undefined, version: null, buildNumber: '', metroHost: 42 as unknown as string }))
      .toEqual({ branch: null, commit: null, version: '0.0.0', buildNumber: null, metroHost: null });
  });

  it('formats the compact label with branch + build + metro host', () => {
    expect(formatMobileBuildLabel(normalizeBuildInfo({
      branch: 'dash/mobile-sim-rebuild-tool',
      version: '1.0.0',
      buildNumber: '2026062608',
      metroHost: '127.0.0.1:8082',
    }))).toBe('dash/mobile-sim-rebuild-tool · v1.0.0 (2026062608) · 127.0.0.1:8082');
  });

  it('falls back to commit, then unknown; omits build/metro when absent', () => {
    expect(formatMobileBuildLabel(normalizeBuildInfo({ commit: 'abc1234' }))).toBe('abc1234 · v0.0.0');
    expect(formatMobileBuildLabel(normalizeBuildInfo({}))).toBe('unknown · v0.0.0');
  });
});
