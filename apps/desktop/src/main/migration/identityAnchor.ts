/**
 * migration/identityAnchor — 身份锚埋点(账号系统切换的前置契约)。
 *
 * 背景:Cindy 1.0 直接接入新账号系统(2026-07-14 拍板;新 auth server 全新
 * 空库,不迁移老 server 数据),userId 会变更,而本地主库按 userId 切片
 * (`xdt-maker-<userId>.db`)。新老 server 之间唯一稳定的关联锚是 email
 * (一致性由新 auth server 保证),备锚 feishuOpenId。映射只能发生在客户端
 * 本地——所以老 app(XDMaker 收尾版)必须在还能拿到老登录态时,把
 * `{ userId, email, feishuOpenId }` 持久化到 userData 内;首启自拷会把本
 * 文件带进 Cindy(copyExcludes 的 COPY_MUST_KEEP_PREFIXES 已登记),
 * Cindy 首启健康检查 confirmed 后进入新账号系统登录页,"新登录成功"钩子里
 * 优先按 email、零命中时回退 feishuOpenId 匹配本文件认领老库(复制重绑,先于 ensureReady;见
 * docs/cindy-rebrand/upgrade-launch-checklist.md §7.1)。
 *
 * ⚠️ 认领与埋点的顺序竞态:Cindy 侧同样有埋点订阅,若埋点先于认领执行,
 * 锚里会同时存在 (oldUid, email) 与 (newUid, email) 两条同 email 记录,
 * 朴素的"多命中拒绝"会误杀认领——所以 findAnchorByEmail 支持
 * excludeUserId(排除当前新账号自身),认领调用方必须传入。
 *
 * 设计要点:
 *  - **多账号数组**:同机可能登录过多个账号(每账号一份库文件),锚按
 *    userId upsert 累积,认领时按归一化 email 精确匹配,绝不做"本机只有
 *    一个库就直接认"的猜测;
 *  - **登出不清**:锚的意义就是在老登录态消失后仍可用,logout 不删;
 *  - **无变化跳过写盘**:每次 auth 状态就绪都会调用,内容(忽略时间戳)
 *    一致时跳过,避免每次启动的无意义盘写;
 *  - 读损坏容忍(同 markerStore 语义):解析失败按空锚处理,下次登录重建。
 *
 * 零 Electron 依赖,路径由调用方传入,vitest 直测。
 */

import { writeJsonAtomic } from './markerStore';
import fs from 'node:fs';

/** 相对 userData 根;必须与 copyExcludes.COPY_MUST_KEEP_PREFIXES 中的条目一致。 */
export const IDENTITY_ANCHOR_REL_PATH = 'migration/identity-anchor.json';

/** 单账号锚记录。 */
export interface IdentityAnchorAccount {
  /** 老账号系统的 userId(本地库文件名 `xdt-maker-<userId>.db` 的切片键)。 */
  userId: string;
  /** 归一化(trim + lowercase)后的邮箱;老 server user.email 可空。 */
  email: string | null;
  /** 备锚:飞书 open_id(server user.feishuId);email 缺失时的匹配兜底。 */
  feishuOpenId: string | null;
  /** 最近一次以该账号登录成功的时间(ISO)。 */
  lastSeenAt: string;
}

export interface IdentityAnchorFile {
  schemaVersion: 1;
  accounts: IdentityAnchorAccount[];
}

/** email 归一化:trim + lowercase;空串 / 非字符串一律归 null。 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** 读锚文件;不存在 / 损坏 / 形状非法返回空锚(下次登录重建,幂等安全)。 */
export function readIdentityAnchor(filePath: string): IdentityAnchorFile {
  const empty: IdentityAnchorFile = { schemaVersion: 1, accounts: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw) as IdentityAnchorFile;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.accounts)) return empty;
    const accounts = parsed.accounts.filter(
      (a): a is IdentityAnchorAccount =>
        a != null && typeof a.userId === 'string' && a.userId.length > 0,
    );
    return { schemaVersion: 1, accounts };
  } catch {
    return empty;
  }
}

/**
 * 按 userId upsert 一条账号锚;内容(忽略 lastSeenAt)无变化时跳过写盘。
 *
 * @returns 'written' 落盘 / 'unchanged' 跳过
 */
export function upsertIdentityAnchor(
  filePath: string,
  account: { userId: string; email: string | null | undefined; feishuOpenId: string | null | undefined },
  nowIso?: string,
): 'written' | 'unchanged' {
  const email = normalizeEmail(account.email);
  const trimmedFeishuOpenId = typeof account.feishuOpenId === 'string'
    ? account.feishuOpenId.trim()
    : '';
  const feishuOpenId = trimmedFeishuOpenId.length > 0 ? trimmedFeishuOpenId : null;

  const current = readIdentityAnchor(filePath);
  const existing = current.accounts.find((a) => a.userId === account.userId);
  if (existing && existing.email === email && existing.feishuOpenId === feishuOpenId) {
    return 'unchanged';
  }

  const next: IdentityAnchorAccount = {
    userId: account.userId,
    email,
    feishuOpenId,
    lastSeenAt: nowIso ?? new Date().toISOString(),
  };
  const accounts = existing
    ? current.accounts.map((a) => (a.userId === account.userId ? next : a))
    : [...current.accounts, next];
  writeJsonAtomic(filePath, { schemaVersion: 1, accounts } satisfies IdentityAnchorFile);
  return 'written';
}

/**
 * 按归一化 email 匹配账号锚(Cindy 侧认领入口的参考实现)。
 * email 命中多条(理论不该发生——新 auth server 保证 email 唯一)或为 null
 * 时返回 null,让调用方走"当新用户"分支,绝不猜测。
 *
 * @param opts.excludeUserId 当前新账号的 userId——认领前 Cindy 自己的埋点
 *   可能已把 (newUid, email) 写进锚,必须排除自身避免"多命中"误杀(顶注)。
 */
export function findAnchorByEmail(
  anchor: IdentityAnchorFile,
  rawEmail: string | null | undefined,
  opts?: { excludeUserId?: string },
): IdentityAnchorAccount | null {
  const email = normalizeEmail(rawEmail);
  if (email == null) return null;
  const hits = anchor.accounts.filter(
    (a) => a.email === email && a.userId !== opts?.excludeUserId,
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 认领匹配入口：email 唯一命中优先；排除新 UID 后 email 零命中时回退
 * feishuOpenId（覆盖老锚缺 email、新账号已有 email）。email 多命中仍直接拒绝。
 */
export function findAnchorByIdentity(
  anchor: IdentityAnchorFile,
  identity: {
    email: string | null | undefined;
    feishuOpenId: string | null | undefined;
  },
  opts?: { excludeUserId?: string },
): IdentityAnchorAccount | null {
  const email = normalizeEmail(identity.email);
  if (email != null) {
    const emailHits = anchor.accounts.filter(
      (account) => account.email === email && account.userId !== opts?.excludeUserId,
    );
    if (emailHits.length === 1) return emailHits[0];
    if (emailHits.length > 1) return null;
  }
  const feishuOpenId = typeof identity.feishuOpenId === 'string'
    ? identity.feishuOpenId.trim()
    : '';
  if (!feishuOpenId) return null;
  const hits = anchor.accounts.filter(
    (account) => account.feishuOpenId === feishuOpenId
      && account.userId !== opts?.excludeUserId,
  );
  return hits.length === 1 ? hits[0] : null;
}
