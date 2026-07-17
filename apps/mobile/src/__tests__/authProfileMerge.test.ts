/**
 * authProfileMerge.test.ts — 手机版展示资料合并纯函数单测。
 * 重点回归:头像收敛必须依据**本轮新鲜 membership** 的 avatarUrl,而不是
 * 合并态 identity.avatar——否则"跨设备清头像"与"产品头像更新下发"两条
 * 路径会永久卡死在旧值(2026-07 对抗 review 发现的语义洞)。
 */

import { describe, expect, it } from 'vitest';

import type { AuthMembership } from '@cindy/auth-client';

import {
  mapMembershipToMobileUser,
  mergeMembershipWithExisting,
  mergeProductProfile,
  type ProductMeUser,
} from '@/auth/profileMerge';

function membership(avatarUrl: string | null): AuthMembership {
  return {
    id: 'm1',
    kind: 'personal',
    role: 'owner',
    displayName: 'Lizi',
    avatarUrl,
    email: 'a@b.c',
    orgId: null,
    orgName: null,
  };
}

const PRODUCT: ProductMeUser = {
  id: 'm1',
  name: 'Feishu Name',
  avatar: 'https://p.example.invalid/feishu.png',
  email: 'a@b.c',
  defaultModel: 'model-x',
  defaultEffort: 'high',
};

const CUSTOM = 'https://oss.example.invalid/cindy/public/avatar/m1/custom.png';

describe('profileMerge(昵称/头像以 membership 为真源)', () => {
  it('membership 自定义头像优先于产品头像;昵称取 displayName,product.name 不覆盖', () => {
    const identity = mapMembershipToMobileUser(membership(CUSTOM));
    const merged = mergeProductProfile(identity, PRODUCT, CUSTOM);
    expect(merged.avatar).toBe(CUSTOM);
    expect(merged.name).toBe('Lizi');
    expect(merged.defaultModel).toBe('model-x');
  });

  it('未设置自定义头像:回落产品头像', () => {
    const identity = mapMembershipToMobileUser(membership(null));
    const merged = mergeProductProfile(identity, PRODUCT, null);
    expect(merged.avatar).toBe(PRODUCT.avatar);
  });

  it('跨设备清头像收敛:合并态还留着旧自定义头像,新鲜 membership 为 null → 收敛到产品头像', () => {
    // 上一轮:用户有自定义头像
    const previous = mergeProductProfile(mapMembershipToMobileUser(membership(CUSTOM)), PRODUCT, CUSTOM);
    // 本轮:另一台设备已清除头像(membership.avatarUrl = null)
    const identity = mergeMembershipWithExisting(membership(null), previous);
    // mergeMembershipWithExisting 保留旧值(product 拉取失败时不闪首字母)…
    expect(identity.avatar).toBe(CUSTOM);
    // …但 product 合并必须用新鲜 null 收敛,不能被合并态旧值卡死
    const merged = mergeProductProfile(identity, PRODUCT, null);
    expect(merged.avatar).toBe(PRODUCT.avatar);
  });

  it('产品头像更新下发:无自定义头像用户,合并态是旧产品头像,新一轮产品头像生效', () => {
    const stale = { ...mapMembershipToMobileUser(membership(null)), avatar: 'https://p.example.invalid/old.png' };
    const identity = mergeMembershipWithExisting(membership(null), stale);
    const merged = mergeProductProfile(identity, PRODUCT, null);
    expect(merged.avatar).toBe(PRODUCT.avatar);
  });

  it('identity 拉取失败(membershipAvatar undefined):保留合并态头像兜底', () => {
    const identity = { ...mapMembershipToMobileUser(membership(null)), avatar: CUSTOM };
    const merged = mergeProductProfile(identity, PRODUCT, undefined);
    expect(merged.avatar).toBe(CUSTOM);
  });
});
