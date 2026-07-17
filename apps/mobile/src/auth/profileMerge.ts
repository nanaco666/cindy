/**
 * profileMerge.ts — 登录身份(auth-server membership)与产品资料(/api/user/me)
 * 的展示态合并纯函数,从 AuthContext 抽出以便单测(authProfileMerge.test.ts)。
 *
 * 2026-07 自助资料上线后,昵称/头像以 auth-server membership 为真源
 * (displayName / avatarUrl),产品资料只作头像未设置时的默认值回落,
 * 与 desktop authManager 的 mergeProductProfile 同语义。
 */

import type { AuthMembership } from '@cindy/auth-client';

import type { MobileUser } from './AuthContext';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_EFFORT = 'medium';

/** 产品服务器 /api/user/me 的 user 段(消费到的字段)。 */
export interface ProductMeUser {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  role?: 'user' | 'admin';
}

export function mapMembershipToMobileUser(
  membership: AuthMembership,
  passportId?: string,
): MobileUser {
  return {
    id: membership.id,
    name: membership.displayName || membership.email || 'Cindy',
    // auth-server 自助头像(PATCH /api/me/profile);null = 未设置,
    // product /me 水合时回落产品资料头像(mergeProductProfile)。
    avatar: membership.avatarUrl ?? null,
    email: membership.email,
    defaultModel: DEFAULT_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    membershipKind: membership.kind,
    membershipRole: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    passportId: passportId ?? membership.passportId ?? '',
  };
}

export function mergeMembershipWithExisting(
  membership: AuthMembership,
  existing: MobileUser | null,
  passportId?: string,
): MobileUser {
  const mapped = mapMembershipToMobileUser(membership, passportId);
  if (!existing || existing.id !== mapped.id) return mapped;
  return {
    ...mapped,
    // membership 自助头像优先;未设置时保留既有值(product /me 水合来的产品头像),
    // 避免 product 拉取失败的那一轮把头像闪成首字母兜底。
    avatar: mapped.avatar ?? existing.avatar,
    defaultModel: existing.defaultModel,
    defaultEffort: existing.defaultEffort,
    role: existing.role,
    passportId: mapped.passportId || existing.passportId,
  };
}

/**
 * 合并产品资料。`membershipAvatar` 是**本轮新鲜 membership** 的 avatarUrl
 * (null = 服务端明确未设置);undefined = 本轮 identity 拉取失败、拿不到
 * membership 真值。必须用新鲜值而不是 identity.avatar 判断——identity 是
 * mergeMembershipWithExisting 的合并态,其 avatar 已回落过旧值,拿它判断会把
 * "跨设备清头像"与"产品头像更新"两条收敛路径永久卡死在旧值上。
 */
export function mergeProductProfile(
  identity: MobileUser,
  product: ProductMeUser,
  membershipAvatar: string | null | undefined,
): MobileUser {
  const selfAvatar = membershipAvatar !== undefined ? membershipAvatar : identity.avatar;
  return {
    ...identity,
    avatar: selfAvatar ?? product.avatar,
    email: product.email ?? identity.email,
    defaultModel: product.defaultModel || identity.defaultModel,
    defaultEffort: product.defaultEffort || identity.defaultEffort,
    role:
      product.role === 'admin'
        ? 'admin'
        : product.role === 'user'
          ? 'user'
          : undefined,
  };
}
