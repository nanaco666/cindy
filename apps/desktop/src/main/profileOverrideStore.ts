/**
 * profileOverrideStore.ts — 本地个人资料覆写(名字 / 头像)持久化。
 * ---------------------------------------------------------------------------
 * 产品服务端(`/api/user/me`)是用户资料的默认真源;本模块存的是用户在
 * **本设备**上的显式自定义(配置设计原则:系统默认值与用户 override 分离,
 * 见 docs/configuration-design-principles.md)。语义:
 *   - 字段缺失 = 未自定义,跟随服务端最新值;
 *   - 字段存在 = 用户显式覆写,登录 / refresh / 换头像之前都保持;
 *   - 「恢复默认」= 删除对应字段(清 override),不是写入一份服务端值快照。
 *
 * 存储:userData/profile-override.json,按 userId 分键——同机多账号互不
 * 串写,登出**不清**(同账号重登还能看到自己的自定义)。内容不敏感
 * (名字 + cindy-media 永久地址),明文 JSON 即可,与 canaryFlagStore 同款。
 *
 * 头像字节本身不在这里:按规则 25 走 cindy-media 媒体总仓,本模块只持有
 * `cindy-media://blobs/<hash><ext>` 永久地址;引用行(refKind 'profile-avatar')
 * 由 profileEdit 业务体维护。
 *
 * 所有函数接受可注入 baseDir(规则 14 / 规则 23:测试用 os.tmpdir,不碰 electron)。
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import { createLogger } from './logger';

const log = createLogger('profileOverrideStore');

const FILE_NAME = 'profile-override.json';

/** 单账号的本地覆写。两个字段都可缺失(缺失 = 跟随服务端)。 */
export interface ProfileOverride {
  /** 自定义显示名(非空 trim 后的字符串)。 */
  name?: string;
  /** 自定义头像的 cindy-media 永久地址(`cindy-media://blobs/...`)。 */
  avatarUrl?: string;
}

type StoreShape = Record<string, ProfileOverride>;

function filePathOf(baseDir?: string): string {
  return path.join(baseDir ?? app.getPath('userData'), FILE_NAME);
}

function readStore(baseDir?: string): StoreShape {
  try {
    const raw = fs.readFileSync(filePathOf(baseDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: StoreShape = {};
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue;
      const entry = value as { name?: unknown; avatarUrl?: unknown };
      const override: ProfileOverride = {};
      if (typeof entry.name === 'string' && entry.name.trim() !== '') {
        override.name = entry.name;
      }
      if (typeof entry.avatarUrl === 'string' && entry.avatarUrl.startsWith('cindy-media://')) {
        override.avatarUrl = entry.avatarUrl;
      }
      if (override.name !== undefined || override.avatarUrl !== undefined) {
        store[userId] = override;
      }
    }
    return store;
  } catch {
    // 文件不存在 / 损坏 → 视为无覆写(fail-safe 回服务端资料)。
    return {};
  }
}

function writeStore(store: StoreShape, baseDir?: string): void {
  const target = filePathOf(baseDir);
  // tmp + rename 原子落盘:写一半崩溃不会留半截 JSON(readStore 的 fail-safe
  // 会把损坏文件当"无覆写"整体丢弃,损失所有账号的自定义)。Node 的 rename 在
  // Windows / macOS 上都支持覆盖既有文件。
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log.error('write profile override store failed', err);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 残留 tmp 无害,忽略
    }
    throw err;
  }
}

/** 读某账号的覆写;无覆写返回 null。 */
export function readOverride(userId: string, baseDir?: string): ProfileOverride | null {
  const entry = readStore(baseDir)[userId];
  if (!entry) return null;
  return entry;
}

/**
 * 写某账号的覆写。两个字段都为空时等价于删除条目(恢复默认语义:
 * 清 override,不留空壳)。
 */
export function writeOverride(
  userId: string,
  override: ProfileOverride,
  baseDir?: string,
): void {
  const store = readStore(baseDir);
  const normalized: ProfileOverride = {};
  if (override.name !== undefined && override.name.trim() !== '') {
    normalized.name = override.name.trim();
  }
  if (override.avatarUrl !== undefined && override.avatarUrl !== '') {
    normalized.avatarUrl = override.avatarUrl;
  }
  if (normalized.name === undefined && normalized.avatarUrl === undefined) {
    delete store[userId];
  } else {
    store[userId] = normalized;
  }
  writeStore(store, baseDir);
}

/**
 * 把覆写合并进服务端用户资料(纯函数,authManager 状态出口调用)。
 * 只动 name / avatar 两个展示字段;id / role 等一律保持服务端真值。
 */
export function applyProfileOverride<T extends { id: string; name: string; avatar: string | null }>(
  user: T,
  override: ProfileOverride | null,
): T {
  if (!override) return user;
  const name = override.name !== undefined && override.name.trim() !== '' ? override.name : user.name;
  const avatar = override.avatarUrl !== undefined ? override.avatarUrl : user.avatar;
  if (name === user.name && avatar === user.avatar) return user;
  return { ...user, name, avatar };
}
