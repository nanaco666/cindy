/**
 * identityAnchor 测试:归一化 / upsert 幂等 / 多账号累积 / 损坏容错 / email 认领匹配。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findAnchorByEmail,
  findAnchorByIdentity,
  normalizeEmail,
  readIdentityAnchor,
  upsertIdentityAnchor,
} from '../identityAnchor';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-anchor-'));
  file = path.join(dir, 'migration', 'identity-anchor.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeEmail', () => {
  it('trim + lowercase', () => {
    expect(normalizeEmail('  David@XD.Com ')).toBe('david@xd.com');
  });

  it('空串 / 纯空白 / null / undefined → null', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe('upsertIdentityAnchor', () => {
  it('首写:创建目录 + 落盘归一化后的记录', () => {
    const r = upsertIdentityAnchor(file, {
      userId: 'u1', email: ' David@XD.Com ', feishuOpenId: ' ou_x ',
    }, '2026-07-14T00:00:00.000Z');
    expect(r).toBe('written');
    const anchor = readIdentityAnchor(file);
    expect(anchor.accounts).toEqual([
      { userId: 'u1', email: 'david@xd.com', feishuOpenId: 'ou_x', lastSeenAt: '2026-07-14T00:00:00.000Z' },
    ]);
  });

  it('内容无变化(忽略 lastSeenAt)跳过写盘', () => {
    upsertIdentityAnchor(file, { userId: 'u1', email: 'a@b.c', feishuOpenId: ' ou_x ' });
    const mtime1 = fs.statSync(file).mtimeMs;
    const r = upsertIdentityAnchor(file, { userId: 'u1', email: ' A@B.C ', feishuOpenId: 'ou_x' }, '2099-01-01T00:00:00.000Z');
    expect(r).toBe('unchanged');
    expect(fs.statSync(file).mtimeMs).toBe(mtime1);
  });

  it('同 userId 内容变化 → 原位更新', () => {
    upsertIdentityAnchor(file, { userId: 'u1', email: 'old@xd.com', feishuOpenId: null });
    const r = upsertIdentityAnchor(file, { userId: 'u1', email: 'new@xd.com', feishuOpenId: 'ou_y' });
    expect(r).toBe('written');
    const anchor = readIdentityAnchor(file);
    expect(anchor.accounts).toHaveLength(1);
    expect(anchor.accounts[0].email).toBe('new@xd.com');
    expect(anchor.accounts[0].feishuOpenId).toBe('ou_y');
  });

  it('多账号累积(同机切换账号各留一条)', () => {
    upsertIdentityAnchor(file, { userId: 'u1', email: 'a@xd.com', feishuOpenId: null });
    upsertIdentityAnchor(file, { userId: 'u2', email: 'b@xd.com', feishuOpenId: 'ou_b' });
    expect(readIdentityAnchor(file).accounts.map((a) => a.userId)).toEqual(['u1', 'u2']);
  });

  it('email / feishuOpenId 缺失归 null 仍可落盘(备锚语义)', () => {
    upsertIdentityAnchor(file, { userId: 'u1', email: undefined, feishuOpenId: '' });
    expect(readIdentityAnchor(file).accounts[0]).toMatchObject({ email: null, feishuOpenId: null });
  });
});

describe('readIdentityAnchor 容错', () => {
  it('文件不存在 → 空锚', () => {
    expect(readIdentityAnchor(file)).toEqual({ schemaVersion: 1, accounts: [] });
  });

  it('JSON 损坏 / 形状非法 → 空锚,且下次 upsert 重建', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{corrupt');
    expect(readIdentityAnchor(file).accounts).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, accounts: 'nope' }));
    expect(readIdentityAnchor(file).accounts).toEqual([]);
    expect(upsertIdentityAnchor(file, { userId: 'u1', email: 'a@b.c', feishuOpenId: null })).toBe('written');
    expect(readIdentityAnchor(file).accounts).toHaveLength(1);
  });

  it('accounts 内非法条目被过滤', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      accounts: [{ userId: 'u1', email: null, feishuOpenId: null, lastSeenAt: 't' }, { email: 'no-uid@x.y' }, null],
    }));
    expect(readIdentityAnchor(file).accounts.map((a) => a.userId)).toEqual(['u1']);
  });
});

describe('findAnchorByEmail(认领匹配语义)', () => {
  it('归一化后精确匹配唯一命中', () => {
    upsertIdentityAnchor(file, { userId: 'u1', email: 'a@xd.com', feishuOpenId: null });
    upsertIdentityAnchor(file, { userId: 'u2', email: 'b@xd.com', feishuOpenId: null });
    const hit = findAnchorByEmail(readIdentityAnchor(file), ' A@XD.com ');
    expect(hit?.userId).toBe('u1');
  });

  it('null email / 无命中 / 多命中一律返回 null(当新用户,绝不猜测)', () => {
    upsertIdentityAnchor(file, { userId: 'u1', email: 'dup@xd.com', feishuOpenId: null });
    upsertIdentityAnchor(file, { userId: 'u2', email: 'dup@xd.com', feishuOpenId: null });
    const anchor = readIdentityAnchor(file);
    expect(findAnchorByEmail(anchor, null)).toBeNull();
    expect(findAnchorByEmail(anchor, 'missing@xd.com')).toBeNull();
    expect(findAnchorByEmail(anchor, 'dup@xd.com')).toBeNull();
  });

  it('excludeUserId:Cindy 自身埋点先落锚时,排除新 uid 后仍能唯一认领老账号', () => {
    // 场景:Cindy 1.0 新登录成功 → 埋点先写 (new-uid, email) → 认领再查锚。
    upsertIdentityAnchor(file, { userId: 'old-uid', email: 'a@xd.com', feishuOpenId: null });
    upsertIdentityAnchor(file, { userId: 'new-uid', email: 'a@xd.com', feishuOpenId: null });
    const anchor = readIdentityAnchor(file);
    // 不排除 → 多命中误杀
    expect(findAnchorByEmail(anchor, 'a@xd.com')).toBeNull();
    // 排除当前新账号 → 唯一命中老账号
    expect(findAnchorByEmail(anchor, 'a@xd.com', { excludeUserId: 'new-uid' })?.userId).toBe('old-uid');
  });

  it('老锚缺 email 时回退 feishuOpenId，并排除已有 email 的 Cindy 新 UID', () => {
    upsertIdentityAnchor(file, { userId: 'old-uid', email: null, feishuOpenId: 'ou_same' });
    upsertIdentityAnchor(file, { userId: 'new-uid', email: 'new@xd.com', feishuOpenId: 'ou_same' });
    expect(findAnchorByIdentity(readIdentityAnchor(file), {
      email: 'new@xd.com',
      feishuOpenId: ' ou_same ',
    }, { excludeUserId: 'new-uid' })?.userId).toBe('old-uid');
  });

  it('email 唯一命中优先于指向其它账号的 feishuOpenId', () => {
    upsertIdentityAnchor(file, { userId: 'email-hit', email: 'new@xd.com', feishuOpenId: null });
    upsertIdentityAnchor(file, { userId: 'feishu-hit', email: null, feishuOpenId: 'ou_same' });
    expect(findAnchorByIdentity(readIdentityAnchor(file), {
      email: 'new@xd.com',
      feishuOpenId: 'ou_same',
    })?.userId).toBe('email-hit');
  });

  it('email 多命中时 fail closed，不用 feishuOpenId 绕过歧义', () => {
    upsertIdentityAnchor(file, { userId: 'a', email: 'dup@xd.com', feishuOpenId: 'ou_same' });
    upsertIdentityAnchor(file, { userId: 'b', email: 'dup@xd.com', feishuOpenId: null });
    expect(findAnchorByIdentity(readIdentityAnchor(file), {
      email: 'dup@xd.com',
      feishuOpenId: 'ou_same',
    })).toBeNull();
  });
});
