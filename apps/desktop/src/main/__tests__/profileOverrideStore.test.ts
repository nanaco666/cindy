/**
 * profileOverrideStore.test.ts — 本地个人资料覆写存储单测。
 * 全部走注入 baseDir(os.tmpdir 下临时目录,规则 23),electron 仅 mock 兜底。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
}));

const store = await import('../profileOverrideStore');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readOverride / writeOverride', () => {
  it('无文件时读回 null;写入后按 userId 读回', () => {
    expect(store.readOverride('u1', dir)).toBeNull();
    store.writeOverride('u1', { name: 'Lizi 自定义', avatarUrl: 'cindy-media://blobs/a.png' }, dir);
    expect(store.readOverride('u1', dir)).toEqual({
      name: 'Lizi 自定义',
      avatarUrl: 'cindy-media://blobs/a.png',
    });
    expect(store.readOverride('u2', dir)).toBeNull();
  });

  it('多账号互不串写', () => {
    store.writeOverride('u1', { name: 'A' }, dir);
    store.writeOverride('u2', { avatarUrl: 'cindy-media://blobs/b.webp' }, dir);
    expect(store.readOverride('u1', dir)).toEqual({ name: 'A' });
    expect(store.readOverride('u2', dir)).toEqual({ avatarUrl: 'cindy-media://blobs/b.webp' });
  });

  it('两个字段都清空 = 删除条目(恢复默认语义,不留空壳)', () => {
    store.writeOverride('u1', { name: 'A', avatarUrl: 'cindy-media://blobs/a.png' }, dir);
    store.writeOverride('u1', {}, dir);
    expect(store.readOverride('u1', dir)).toBeNull();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'profile-override.json'), 'utf-8'));
    expect(raw).toEqual({});
  });

  it('name 会 trim;空白名视为未设置', () => {
    store.writeOverride('u1', { name: '  Lizi  ' }, dir);
    expect(store.readOverride('u1', dir)).toEqual({ name: 'Lizi' });
    store.writeOverride('u1', { name: '   ' }, dir);
    expect(store.readOverride('u1', dir)).toBeNull();
  });

  it('损坏的 JSON / 非法字段 fail-safe 回无覆写', () => {
    fs.writeFileSync(path.join(dir, 'profile-override.json'), '{{{{not json', 'utf-8');
    expect(store.readOverride('u1', dir)).toBeNull();
    // 非 cindy-media 协议的头像地址不认(防手改文件注入任意 URL)
    fs.writeFileSync(
      path.join(dir, 'profile-override.json'),
      JSON.stringify({ u1: { avatarUrl: 'https://evil.example/x.png' }, u2: { name: 'ok' } }),
      'utf-8',
    );
    expect(store.readOverride('u1', dir)).toBeNull();
    expect(store.readOverride('u2', dir)).toEqual({ name: 'ok' });
  });
});

describe('applyProfileOverride(状态出口合并,纯函数)', () => {
  const user = { id: 'u1', name: 'Server Name', avatar: null as string | null, role: 'admin' };

  it('无覆写原样返回(同一引用,不产生新对象)', () => {
    expect(store.applyProfileOverride(user, null)).toBe(user);
  });

  it('只覆写展示字段,其它字段保持服务端真值', () => {
    const merged = store.applyProfileOverride(user, {
      name: 'Custom',
      avatarUrl: 'cindy-media://blobs/a.png',
    });
    expect(merged).toEqual({
      id: 'u1',
      name: 'Custom',
      avatar: 'cindy-media://blobs/a.png',
      role: 'admin',
    });
    expect(user.name).toBe('Server Name'); // 不改入参
  });

  it('部分覆写:只有头像时名字跟随服务端', () => {
    const merged = store.applyProfileOverride(user, { avatarUrl: 'cindy-media://blobs/a.png' });
    expect(merged.name).toBe('Server Name');
    expect(merged.avatar).toBe('cindy-media://blobs/a.png');
  });
});
