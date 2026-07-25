// @ts-nocheck —— 被测对象是 .mjs 纯脚本模块(发布工具链),这里用 vitest 跑其纯函数。
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  mimeForExt,
  base64UrlSha256,
  sha256Hex,
  md5Hex,
  buildAssetEntry,
  buildManifest,
  assertOtaRuntimeMatchesBaseline,
} from '../../scripts/lib/ota-manifest.mjs';

const BYTES = Buffer.from('hello expo updates', 'utf8');

describe('hash helpers', () => {
  it('base64UrlSha256 = sha256 的 base64url(无 padding)', () => {
    const expected = crypto.createHash('sha256').update(BYTES).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(base64UrlSha256(BYTES)).toBe(expected);
    expect(base64UrlSha256(BYTES)).not.toMatch(/[+/=]/);
  });
  it('sha256Hex / md5Hex 长度正确', () => {
    expect(sha256Hex(BYTES)).toMatch(/^[0-9a-f]{64}$/);
    expect(md5Hex(BYTES)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('mimeForExt', () => {
  it('已知扩展名', () => {
    expect(mimeForExt('png')).toBe('image/png');
    expect(mimeForExt('.ttf')).toBe('font/ttf');
  });
  it('未知 → octet-stream', () => {
    expect(mimeForExt('xyz')).toBe('application/octet-stream');
  });
});

describe('buildAssetEntry', () => {
  it('普通 asset 带 fileExtension + 推断 contentType', () => {
    const e = buildAssetEntry({ bytes: BYTES, ext: 'png', url: 'https://cdn/x/a' });
    expect(e).toMatchObject({ contentType: 'image/png', fileExtension: '.png', url: 'https://cdn/x/a' });
    expect(e.hash).toBe(base64UrlSha256(BYTES));
    expect(e.key).toBe(md5Hex(BYTES));
  });
  it('launchAsset 固定 js contentType 且不带 fileExtension', () => {
    const e = buildAssetEntry({ bytes: BYTES, ext: 'hbc', url: 'https://cdn/x/b', isLaunchAsset: true });
    expect(e.contentType).toBe('application/javascript');
    expect(e.fileExtension).toBeUndefined();
  });
});

describe('buildManifest', () => {
  const launch = { hash: 'h', key: 'k', contentType: 'application/javascript', url: 'https://cdn/x/b' };
  it('组装完整 manifest', () => {
    const m = buildManifest({
      id: 'uuid-1', createdAt: '2026-07-01T00:00:00.000Z', runtimeVersion: 'rtv1',
      launchAsset: launch, assets: [], expoClient: { name: 'XDMaker' },
    });
    expect(m).toMatchObject({
      id: 'uuid-1', runtimeVersion: 'rtv1', launchAsset: launch,
      assets: [], metadata: {}, extra: { expoClient: { name: 'XDMaker' } },
    });
  });
  it('无 expoClient → extra 为空对象', () => {
    const m = buildManifest({ id: 'i', createdAt: 'c', runtimeVersion: 'r', launchAsset: launch, assets: [] });
    expect(m.extra).toEqual({});
  });
  it('缺必填字段抛错', () => {
    expect(() => buildManifest({ id: '', createdAt: 'c', runtimeVersion: 'r', launchAsset: launch })).toThrow();
    expect(() => buildManifest({ id: 'i', createdAt: 'c', runtimeVersion: 'r' })).toThrow();
  });
});

describe('assertOtaRuntimeMatchesBaseline', () => {
  it('runtime 与基线一致 → ok', () => {
    expect(assertOtaRuntimeMatchesBaseline({ runtimeVersion: 'rtv1', baselineRuntime: 'rtv1' })).toEqual({ ok: true });
  });
  it('runtime 与基线不一致 → 抛错(带两个 runtime 值)', () => {
    expect(() => assertOtaRuntimeMatchesBaseline({ runtimeVersion: 'rtvNEW', baselineRuntime: 'rtvOLD' }))
      .toThrow(/rtvNEW.*rtvOLD|rtvOLD.*rtvNEW/);
  });
  it('无冷更基线(null/undefined)→ 抛错,提示先出冷更整包', () => {
    expect(() => assertOtaRuntimeMatchesBaseline({
      runtimeVersion: 'rtv1',
      baselineRuntime: null,
      coldBuildCommand: 'pnpm mobile:release:android:local -- --region global --execute',
    })).toThrow(/mobile:release:android:local -- --region global --execute/);
    expect(() => assertOtaRuntimeMatchesBaseline({ runtimeVersion: 'rtv1', baselineRuntime: undefined }))
      .toThrow();
  });
  it('skip=true → 放行(即使不一致或缺基线也不抛)', () => {
    expect(assertOtaRuntimeMatchesBaseline({ runtimeVersion: 'a', baselineRuntime: 'b', skip: true })).toEqual({ skipped: true });
    expect(assertOtaRuntimeMatchesBaseline({ runtimeVersion: 'a', baselineRuntime: null, skip: true })).toEqual({ skipped: true });
  });
});
