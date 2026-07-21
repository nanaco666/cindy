import { AuthApiError, type AccountTokenPair } from '@cindy/auth-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DesktopAccountSession,
  restoreAccountMemberships,
  restoreAccountMembershipsWithinTimeout,
} from '../accountSession';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('DesktopAccountSession', () => {
  it('清理或重新登录后不复用旧 refresh，旧 finally 也不会清掉新任务', async () => {
    let storedRefreshToken: string | null = 'refresh-old';
    const oldRefresh = deferred<AccountTokenPair>();
    const newRefresh = deferred<AccountTokenPair>();
    const refreshAccount = vi.fn((refreshToken: string) =>
      refreshToken === 'refresh-old' ? oldRefresh.promise : newRefresh.promise,
    );
    const session = new DesktopAccountSession({
      readRefreshToken: () => storedRefreshToken,
      writeRefreshToken: (refreshToken) => {
        storedRefreshToken = refreshToken;
      },
      removeRefreshToken: () => {
        storedRefreshToken = null;
      },
      refreshAccount,
      isAccessTokenExpiring: () => false,
      replacementRecheckDelaysMs: [],
    });

    const supersededRun = session.refresh();
    session.clear();
    session.install({
      accountToken: 'access-new-login',
      accountRefreshToken: 'refresh-new-login',
    });
    const currentRun = session.refresh();

    oldRefresh.resolve({
      accountToken: 'access-old-late',
      accountRefreshToken: 'refresh-old-late',
    });
    await expect(supersededRun).resolves.toBe(false);

    // The old run settled, but its cleanup must leave the newer run deduplicated.
    const duplicateCurrentRun = session.refresh();
    expect(duplicateCurrentRun).toBe(currentRun);
    expect(refreshAccount).toHaveBeenCalledTimes(2);

    newRefresh.resolve({
      accountToken: 'access-newer',
      accountRefreshToken: 'refresh-newer',
    });
    await expect(currentRun).resolves.toBe(true);
    await expect(duplicateCurrentRun).resolves.toBe(true);
    expect(session.peekAccessToken()).toBe('access-newer');
    expect(storedRefreshToken).toBe('refresh-newer');
  });

  it('共享 userData 中旧 token 失败时追赶另一进程写入的新 token', async () => {
    let storedRefreshToken: string | null = 'refresh-old';
    const removeRefreshToken = vi.fn(() => {
      storedRefreshToken = null;
    });
    const refreshAccount = vi.fn(async (refreshToken: string): Promise<AccountTokenPair> => {
      if (refreshToken === 'refresh-old') {
        storedRefreshToken = 'refresh-from-winner';
        throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'already rotated');
      }
      return {
        accountToken: 'access-after-replacement',
        accountRefreshToken: 'refresh-after-replacement',
      };
    });
    const session = new DesktopAccountSession({
      readRefreshToken: () => storedRefreshToken,
      writeRefreshToken: (refreshToken) => {
        storedRefreshToken = refreshToken;
      },
      removeRefreshToken,
      refreshAccount,
      isAccessTokenExpiring: () => false,
      replacementRecheckDelaysMs: [],
    });

    await expect(session.refresh()).resolves.toBe(true);
    expect(refreshAccount).toHaveBeenNthCalledWith(1, 'refresh-old');
    expect(refreshAccount).toHaveBeenNthCalledWith(2, 'refresh-from-winner');
    expect(storedRefreshToken).toBe('refresh-after-replacement');
    expect(removeRefreshToken).not.toHaveBeenCalled();
  });

  it('本进程新登录已替换会话后，旧失败任务不会再轮换新登录 token', async () => {
    let storedRefreshToken: string | null = 'refresh-old';
    const oldRefresh = deferred<AccountTokenPair>();
    const refreshAccount = vi.fn(() => oldRefresh.promise);
    const session = new DesktopAccountSession({
      readRefreshToken: () => storedRefreshToken,
      writeRefreshToken: (refreshToken) => {
        storedRefreshToken = refreshToken;
      },
      removeRefreshToken: () => {
        storedRefreshToken = null;
      },
      refreshAccount,
      isAccessTokenExpiring: () => false,
      replacementRecheckDelaysMs: [],
    });

    const supersededRun = session.refresh();
    session.install({
      accountToken: 'access-new-login',
      accountRefreshToken: 'refresh-new-login',
    });
    oldRefresh.reject(new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'already rotated'));

    await expect(supersededRun).resolves.toBe(false);
    expect(refreshAccount).toHaveBeenCalledTimes(1);
    expect(storedRefreshToken).toBe('refresh-new-login');
    expect(session.peekAccessToken()).toBe('access-new-login');
  });

  it('INVALID_REFRESH_TOKEN 后的最后读删窗口仍会保留刚出现的替换 token', async () => {
    let readCount = 0;
    let storedRefreshToken: string | null = 'refresh-old';
    const removeRefreshToken = vi.fn(() => {
      storedRefreshToken = null;
    });
    const session = new DesktopAccountSession({
      readRefreshToken: () => {
        readCount += 1;
        // Initial read + generic failure resolution still see the requested token;
        // the final pre-delete read observes another process's replacement.
        if (readCount === 3) storedRefreshToken = 'refresh-just-written';
        return storedRefreshToken;
      },
      writeRefreshToken: (refreshToken) => {
        storedRefreshToken = refreshToken;
      },
      removeRefreshToken,
      refreshAccount: async () => {
        throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'already rotated');
      },
      isAccessTokenExpiring: () => false,
      replacementRecheckDelaysMs: [],
    });

    await expect(session.refresh()).resolves.toBe(false);
    expect(storedRefreshToken).toBe('refresh-just-written');
    expect(removeRefreshToken).not.toHaveBeenCalled();
  });

  it('当前 account refresh token 确定失效时只清 account 会话', async () => {
    let storedRefreshToken: string | null = 'refresh-expired';
    const resourceRefreshToken = 'resource-refresh-stays-valid';
    const session = new DesktopAccountSession({
      readRefreshToken: () => storedRefreshToken,
      writeRefreshToken: (refreshToken) => {
        storedRefreshToken = refreshToken;
      },
      removeRefreshToken: () => {
        storedRefreshToken = null;
      },
      refreshAccount: async () => {
        throw new AuthApiError('REFRESH_TOKEN_EXPIRED', 401, 'expired');
      },
      isAccessTokenExpiring: () => false,
      replacementRecheckDelaysMs: [],
    });

    await expect(session.refresh()).resolves.toBe(false);
    expect(storedRefreshToken).toBeNull();
    expect(session.peekAccessToken()).toBeNull();
    // Resource credentials are deliberately outside DesktopAccountSession.
    expect(resourceRefreshToken).toBe('resource-refresh-stays-valid');
  });

  it('网络类瞬时失败保留 account refresh token 供后续自愈', async () => {
    let storedRefreshToken: string | null = 'refresh-valid';
    const removeRefreshToken = vi.fn(() => {
      storedRefreshToken = null;
    });
    const session = new DesktopAccountSession({
      readRefreshToken: () => storedRefreshToken,
      writeRefreshToken: (refreshToken) => {
        storedRefreshToken = refreshToken;
      },
      removeRefreshToken,
      refreshAccount: async () => {
        throw new AuthApiError('NETWORK_ERROR', 0, 'offline');
      },
      isAccessTokenExpiring: () => false,
      replacementRecheckDelaysMs: [],
    });

    await expect(session.refresh()).resolves.toBe(false);
    expect(storedRefreshToken).toBe('refresh-valid');
    expect(removeRefreshToken).not.toHaveBeenCalled();
  });

  it('等待旧 refresh 时若新登录完成，getAccessToken 返回新会话 token', async () => {
    let storedRefreshToken: string | null = 'refresh-old';
    const refresh = deferred<AccountTokenPair>();
    const session = new DesktopAccountSession({
      readRefreshToken: () => storedRefreshToken,
      writeRefreshToken: (refreshToken) => {
        storedRefreshToken = refreshToken;
      },
      removeRefreshToken: () => {
        storedRefreshToken = null;
      },
      refreshAccount: () => refresh.promise,
      isAccessTokenExpiring: () => false,
      replacementRecheckDelaysMs: [],
    });

    const pendingAccess = session.getAccessToken();
    session.install({
      accountToken: 'access-from-new-login',
      accountRefreshToken: 'refresh-from-new-login',
    });
    refresh.resolve({
      accountToken: 'access-old-late',
      accountRefreshToken: 'refresh-old-late',
    });

    await expect(pendingAccess).resolves.toBe('access-from-new-login');
    expect(storedRefreshToken).toBe('refresh-from-new-login');
  });
});

describe('restoreAccountMemberships', () => {
  it('缓存 access token 被拒绝后刷新一次并恢复成员列表', async () => {
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('access-old')
      .mockResolvedValueOnce('access-new');
    const invalidateAccessToken = vi.fn();
    const listMemberships = vi.fn(async (accessToken: string) => {
      if (accessToken === 'access-old') {
        throw new AuthApiError('UNAUTHORIZED', 401, 'expired access token');
      }
      return [{ id: 'membership-1' }];
    });

    await expect(
      restoreAccountMemberships({
        getAccessToken,
        invalidateAccessToken,
        listMemberships,
        isUnauthorized: (error) => error instanceof AuthApiError && error.statusCode === 401,
      }),
    ).resolves.toEqual([{ id: 'membership-1' }]);
    expect(invalidateAccessToken).toHaveBeenCalledTimes(1);
    expect(listMemberships).toHaveBeenCalledTimes(2);
  });

  it('刷新后的第二次成员查询失败也统一回落，不向登录页抛异常', async () => {
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('access-old')
      .mockResolvedValueOnce('access-new');
    const listMemberships = vi
      .fn<(accessToken: string) => Promise<Array<{ id: string }>>>()
      .mockRejectedValueOnce(new AuthApiError('UNAUTHORIZED', 401, 'expired access token'))
      .mockRejectedValueOnce(new AuthApiError('NETWORK_ERROR', 0, 'offline'));

    await expect(
      restoreAccountMemberships({
        getAccessToken,
        invalidateAccessToken: vi.fn(),
        listMemberships,
        isUnauthorized: (error) => error instanceof AuthApiError && error.statusCode === 401,
      }),
    ).resolves.toBeNull();
  });

  describe('bounded login-page recovery', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('不取消轮换请求，但到达等待上限后允许显示普通登录入口', async () => {
      const accessToken = deferred<string | null>();
      const recovery = restoreAccountMembershipsWithinTimeout(
        {
          getAccessToken: () => accessToken.promise,
          invalidateAccessToken: vi.fn(),
          listMemberships: vi.fn(async () => [{ id: 'membership-late' }]),
          isUnauthorized: () => false,
        },
        100,
      );

      await vi.advanceTimersByTimeAsync(100);
      await expect(recovery).resolves.toBeNull();

      // The rotating request is still allowed to settle safely in the background.
      accessToken.resolve('access-late');
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
