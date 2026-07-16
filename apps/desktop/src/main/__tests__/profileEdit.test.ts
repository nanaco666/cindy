/**
 * profileEdit.test.ts — 个人资料编辑业务体单测(规则 14:全依赖注入,内存直测)。
 * 覆盖:未登录 / 非法参数拒绝、名字"输入 == 默认 → 清 override"、头像三态
 * (keep / set / reset)的入仓与引用维护顺序、体积与扩展名校验。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  AVATAR_MAX_BYTES,
  chooseAvatarFile,
  getProfileEditState,
  updateProfile,
  type ProfileEditDeps,
} from '../profileEdit';
import type { ProfileOverride } from '../profileOverrideStore';

const HASH_NEW = 'f'.repeat(64);

function makeDeps(overrides: Partial<ProfileEditDeps> = {}): {
  deps: ProfileEditDeps;
  written: Array<{ userId: string; override: ProfileOverride }>;
  notify: ReturnType<typeof vi.fn>;
} {
  const written: Array<{ userId: string; override: ProfileOverride }> = [];
  const notify = vi.fn();
  const deps: ProfileEditDeps = {
    getCurrentUserId: () => 'u1',
    getServerProfile: () => ({ name: 'Server Name', avatar: null }),
    showAvatarOpenDialog: vi.fn(async () => null),
    readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
    ingestMedia: vi.fn(async () => ({
      hash: HASH_NEW,
      ext: '.png',
      mimeType: 'image/png',
      bytes: 3,
      url: `cindy-media://blobs/${HASH_NEW}.png`,
      deduplicated: false,
      refIds: ['ref-1'],
    })),
    removeRefsExceptHash: vi.fn(async () => 1),
    removeRefs: vi.fn(async () => 1),
    readOverride: () => null,
    writeOverride: (userId, override) => written.push({ userId, override }),
    notifyChanged: notify,
    logWarn: vi.fn(),
    ...overrides,
  };
  return { deps, written, notify };
}

const ipcCode = (err: unknown): string | undefined =>
  (err as { code?: string } | null)?.code;

describe('登录态与参数守卫', () => {
  it('未登录:三个入口都抛 PRECONDITION_FAILED', async () => {
    const { deps } = makeDeps({ getCurrentUserId: () => null });
    expect(() => getProfileEditState(deps)).toThrowError();
    await expect(chooseAvatarFile(deps)).rejects.toSatisfy((e) => ipcCode(e) === 'PRECONDITION_FAILED');
    await expect(updateProfile(deps, { name: null, avatar: { type: 'keep' } })).rejects.toSatisfy(
      (e) => ipcCode(e) === 'PRECONDITION_FAILED',
    );
  });

  it('payload 非对象 / avatar 动作畸形 / name 非法类型 → INVALID_PARAMS', async () => {
    const { deps } = makeDeps();
    for (const bad of [null, 'x', { name: 42, avatar: { type: 'keep' } }, { name: null, avatar: { type: 'nope' } }, { name: null, avatar: { type: 'set' } }]) {
      await expect(updateProfile(deps, bad)).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
    }
  });

  it('名字超长(>40 码点)拒绝', async () => {
    const { deps } = makeDeps();
    await expect(
      updateProfile(deps, { name: '啊'.repeat(41), avatar: { type: 'keep' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
  });
});

describe('getProfileEditState(弹窗预填)', () => {
  it('返回服务端真值 + 现有覆写', () => {
    const { deps } = makeDeps({
      readOverride: () => ({ name: 'Custom', avatarUrl: 'cindy-media://blobs/a.png' }),
    });
    expect(getProfileEditState(deps)).toEqual({
      serverName: 'Server Name',
      serverAvatar: null,
      overrideName: 'Custom',
      overrideAvatarUrl: 'cindy-media://blobs/a.png',
    });
  });
});

describe('名字收敛(规则 20:输入 == 默认 → 清 override)', () => {
  it('新名字与服务端不同 → 存 override', async () => {
    const { deps, written, notify } = makeDeps();
    await updateProfile(deps, { name: '  Lizi  ', avatar: { type: 'keep' } });
    expect(written).toEqual([{ userId: 'u1', override: { name: 'Lizi', avatarUrl: undefined } }]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('输入与服务端一致 → 不存快照(清名字 override)', async () => {
    const { deps, written } = makeDeps();
    await updateProfile(deps, { name: 'Server Name', avatar: { type: 'keep' } });
    expect(written[0].override.name).toBeUndefined();
  });

  it('null / 空串 → 恢复默认名字;keep 时现有头像覆写不受影响', async () => {
    const { deps, written } = makeDeps({
      readOverride: () => ({ name: 'Old', avatarUrl: 'cindy-media://blobs/old.png' }),
    });
    await updateProfile(deps, { name: null, avatar: { type: 'keep' } });
    expect(written[0].override).toEqual({
      name: undefined,
      avatarUrl: 'cindy-media://blobs/old.png',
    });
  });
});

describe('头像三态', () => {
  it('set:落账顺序 = ingest 挂新引用 → store 提交 + 广播 → 清旧指纹引用(崩溃窗口契约)', async () => {
    const order: string[] = [];
    const { deps, written, notify } = makeDeps({
      writeOverride: (userId, override) => {
        order.push('write');
        written.push({ userId, override });
      },
    });
    notify.mockImplementation(() => order.push('notify'));
    (deps.ingestMedia as ReturnType<typeof vi.fn>).mockImplementation(async (params: {
      buffer: Uint8Array;
      mimeType: string;
      refs: unknown[];
    }) => {
      order.push('ingest');
      expect(params.mimeType).toBe('image/png');
      expect(params.refs).toEqual([{ refKind: 'profile-avatar', refId: 'u1', originKind: 'user' }]);
      return {
        hash: HASH_NEW,
        ext: '.png',
        mimeType: 'image/png',
        bytes: 3,
        url: `cindy-media://blobs/${HASH_NEW}.png`,
        deduplicated: false,
        refIds: ['ref-1'],
      };
    });
    (deps.removeRefsExceptHash as ReturnType<typeof vi.fn>).mockImplementation(async (params: unknown) => {
      order.push('removeExcept');
      expect(params).toEqual({ refKind: 'profile-avatar', refId: 'u1', keepHash: HASH_NEW });
      return 1;
    });

    await updateProfile(deps, { name: null, avatar: { type: 'set', filePath: 'C:\\pics\\me.PNG' } });
    expect(order).toEqual(['ingest', 'write', 'notify', 'removeExcept']);
    expect(written[0].override.avatarUrl).toBe(`cindy-media://blobs/${HASH_NEW}.png`);
  });

  it('set:旧引用清理失败不回滚保存结果,只 warn 留痕', async () => {
    const { deps, written } = makeDeps();
    (deps.removeRefsExceptHash as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db busy'));
    await expect(
      updateProfile(deps, { name: null, avatar: { type: 'set', filePath: '/a/b.png' } }),
    ).resolves.toEqual({ ok: true });
    expect(written[0].override.avatarUrl).toBe(`cindy-media://blobs/${HASH_NEW}.png`);
    expect(deps.logWarn).toHaveBeenCalledTimes(1);
  });

  it('set:扩展名不在白名单 / 文件超限 / 空文件 → INVALID_PARAMS,不触发入仓', async () => {
    const { deps } = makeDeps();
    await expect(
      updateProfile(deps, { name: null, avatar: { type: 'set', filePath: '/a/b.svg' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');

    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Buffer.alloc(AVATAR_MAX_BYTES + 1),
    );
    await expect(
      updateProfile(deps, { name: null, avatar: { type: 'set', filePath: '/a/b.png' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');

    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Buffer.alloc(0));
    await expect(
      updateProfile(deps, { name: null, avatar: { type: 'set', filePath: '/a/b.png' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');

    expect(deps.ingestMedia).not.toHaveBeenCalled();
  });

  it('reset:先清覆写地址再删引用(store 永不指向零引用指纹)', async () => {
    const order: string[] = [];
    const written: Array<{ userId: string; override: ProfileOverride }> = [];
    const { deps } = makeDeps({
      readOverride: () => ({ avatarUrl: 'cindy-media://blobs/old.png' }),
      writeOverride: (userId, override) => {
        order.push('write');
        written.push({ userId, override });
      },
      removeRefs: vi.fn(async () => {
        order.push('removeRefs');
        return 1;
      }),
    });
    await updateProfile(deps, { name: null, avatar: { type: 'reset' } });
    expect(deps.removeRefs).toHaveBeenCalledWith({ refKind: 'profile-avatar', refId: 'u1' });
    expect(order).toEqual(['write', 'removeRefs']);
    expect(written[0].override.avatarUrl).toBeUndefined();
  });
});

describe('chooseAvatarFile(选图预校验,不入仓)', () => {
  it('取消选择返回 canceled,不读文件', async () => {
    const { deps } = makeDeps();
    await expect(chooseAvatarFile(deps)).resolves.toEqual({ canceled: true });
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('合法图片返回路径 + data URL 预览;不触发 ingest', async () => {
    const { deps } = makeDeps({
      showAvatarOpenDialog: vi.fn(async () => '/pics/me.webp'),
      readFile: vi.fn(async () => Buffer.from('abc')),
    });
    const result = await chooseAvatarFile(deps);
    expect(result.canceled).toBe(false);
    expect(result.filePath).toBe('/pics/me.webp');
    expect(result.previewDataUrl).toBe(`data:image/webp;base64,${Buffer.from('abc').toString('base64')}`);
    expect(deps.ingestMedia).not.toHaveBeenCalled();
  });

  it('白名单外扩展名拒绝', async () => {
    const { deps } = makeDeps({ showAvatarOpenDialog: vi.fn(async () => '/pics/me.bmp') });
    await expect(chooseAvatarFile(deps)).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
  });
});
