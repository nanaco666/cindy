// @vitest-environment jsdom
/**
 * MigrationGate.retry.test.tsx
 * ---------------------------------------------------------------------------
 * gate decision 失败的有限重试链路(睡醒白屏修复的防御层):
 * transient 失败(如跨睡眠 db RPC 假超时)重试 2 次后成功 → 正常放行;
 * 持续失败耗尽重试 → 才落 fatal 阻断渲染。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => loggerMock,
}));

const authState = vi.hoisted(() => ({
  current: { user: { id: 'user-1' }, migration: { status: 'none' } as unknown },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

import { MigrationGate } from '../MigrationGate';

type ElectronApiStub = {
  localDb: {
    ensureReady: ReturnType<typeof vi.fn>;
    migration: {
      getStatus: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
    };
  };
  appReadyForBot: ReturnType<typeof vi.fn>;
};

function stubElectronApi(): ElectronApiStub {
  const api: ElectronApiStub = {
    localDb: {
      ensureReady: vi.fn().mockResolvedValue({ ready: true }),
      migration: {
        getStatus: vi.fn().mockResolvedValue('done'),
        setStatus: vi.fn().mockResolvedValue(undefined),
      },
    },
    appReadyForBot: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

function gateTree() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<MigrationGate />}>
          <Route index element={<div data-testid="main-content" />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderGate() {
  return render(gateTree());
}

/** 让 pending 的 microtask 链跑完(fake timers 下 await Promise 需要显式 flush)。 */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceRetryDelay(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await flushAsync();
}

describe('MigrationGate 有限重试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    authState.current = { user: { id: 'user-1' }, migration: { status: 'none' } };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('决策一次成功 → 直接放行主内容', async () => {
    stubElectronApi();
    renderGate();
    await flushAsync();
    expect(screen.getByTestId('main-content')).toBeTruthy();
  });

  it('transient 失败 2 次后成功 → 重试后放行,不落 fatal', async () => {
    const api = stubElectronApi();
    api.localDb.migration.getStatus
      .mockRejectedValueOnce(new Error('db worker RPC timeout: op="queryOne" (sleep)'))
      .mockRejectedValueOnce(new Error('db worker RPC timeout: op="queryOne" (sleep)'))
      .mockResolvedValue('done');

    renderGate();
    await flushAsync();
    expect(screen.queryByTestId('main-content')).toBeNull(); // 第 1 次失败,等待重试

    await advanceRetryDelay(); // 第 2 次(重试 1)仍失败
    expect(screen.queryByTestId('main-content')).toBeNull();

    await advanceRetryDelay(); // 第 3 次(重试 2)成功
    expect(screen.getByTestId('main-content')).toBeTruthy();
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying (1/2)'),
      expect.anything(),
    );
  });

  it('重试等待期 migrationKey 变化 → 新决策重置重试额度,不继承已消耗计数', async () => {
    const api = stubElectronApi();
    // 4 次 getStatus:决策#1 失败(消耗 1 次额度)→ key 变化重置 → 决策#2/#3 失败
    // (若额度未重置,第 3 次失败时计数已达上限,会提前 fatal)→ 决策#4 成功
    api.localDb.migration.getStatus
      .mockRejectedValueOnce(new Error('transient #1'))
      .mockRejectedValueOnce(new Error('transient #2'))
      .mockRejectedValueOnce(new Error('transient #3'))
      .mockResolvedValue('done');

    const view = renderGate();
    await flushAsync(); // 决策#1 失败,count=1,等待重试

    // 重试等待期 auth 状态更新导致 migrationKey 变化 → 触发全新决策
    authState.current = {
      user: { id: 'user-1' },
      migration: { status: 'pending', totalSessions: 0, totalMessages: 0 },
    };
    await act(async () => {
      view.rerender(gateTree());
    });
    await flushAsync(); // 决策#2 失败;额度已重置,count=1

    await advanceRetryDelay(); // 决策#3 失败,count=2,仍有重试
    await advanceRetryDelay(); // 决策#4 成功

    expect(api.localDb.migration.getStatus).toHaveBeenCalledTimes(4);
    expect(loggerMock.error).not.toHaveBeenCalled(); // 未提前 fatal
    view.unmount();
  });

  it('持续失败耗尽重试 → 落 fatal 阻断渲染', async () => {
    const api = stubElectronApi();
    api.localDb.migration.getStatus.mockRejectedValue(
      new Error('db worker RPC timeout: op="queryOne"'),
    );

    renderGate();
    await flushAsync();
    await advanceRetryDelay();
    await advanceRetryDelay();
    await flushAsync();

    expect(screen.queryByTestId('main-content')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'migration gate decision failed after retries',
      expect.anything(),
    );
    // 恰好尝试 3 次(1 次原始 + 2 次重试),没有无限重试
    expect(api.localDb.migration.getStatus).toHaveBeenCalledTimes(3);
  });
});
