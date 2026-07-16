// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCodexAuth } from '../useCodexAuth';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function installAuthApi(logout: () => Promise<void>) {
  const auth = {
    getState: vi.fn(async () => ({
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth' as const,
    })),
    triggerLogin: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(logout),
    onStateChanged: vi.fn(() => () => undefined),
    onLoginProgress: vi.fn(() => () => undefined),
  };
  (window as unknown as { electronAPI: { maker: { auth: typeof auth } } }).electronAPI = {
    maker: { auth },
  };
  return auth;
}

describe('useCodexAuth lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('keeps the authenticated UI when durable disconnect was not committed', async () => {
    const auth = installAuthApi(async () => {
      throw new Error('[INTERNAL] failed to persist Codex disconnect state');
    });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow('failed to persist');
    });

    expect(auth.logout).toHaveBeenCalledWith('codex');
    expect(result.current.state.kind).toBe('authenticated');
  });

  it('switches to unauthenticated only after main confirms logout', async () => {
    installAuthApi(async () => undefined);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.state.kind).toBe('unauthenticated');
  });

  it('refreshes to disconnected when cleanup fails after the marker committed', async () => {
    const auth = installAuthApi(async () => {
      throw new Error('[INTERNAL] failed to remove Codex auth file');
    });
    auth.getState
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth' as const,
      })
      .mockResolvedValueOnce({ authenticated: false, identity: '', authSource: 'oauth' as const });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow('failed to remove');
    });

    expect(result.current.state.kind).toBe('unauthenticated');
  });

  it('returns failed while retaining the main-process login reason', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.triggerLogin.mockResolvedValue({ authenticated: false, errorReason: 'login_timeout' });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.triggerLogin()).resolves.toBe('failed');
    });

    expect(result.current.state).toEqual({ kind: 'error', message: 'login_timeout' });
  });

  it('treats user cancellation as a non-error outcome', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.triggerLogin.mockResolvedValue({ authenticated: false, errorReason: 'login_cancelled' });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.triggerLogin()).resolves.toBe('cancelled');
    });

    expect(result.current.state).toEqual({ kind: 'unauthenticated' });
  });
});
