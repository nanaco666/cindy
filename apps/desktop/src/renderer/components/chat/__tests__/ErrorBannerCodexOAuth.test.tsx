// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBanner } from '../ErrorBanner';
import { useCodexAuth } from '@/hooks/useCodexAuth';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  getState: vi.fn(),
  triggerLogin: vi.fn(),
  cancelLogin: vi.fn(),
  logout: vi.fn(),
  onStateChanged: vi.fn(),
  onLoginProgress: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  // invalidate 会在横幅渲染前把已收割的 OAuth host 回落为 env-key；明确失效原因
  // 仍必须保留 ChatGPT 重连入口。
  useCodexRuntimeRoute: () => ({ authInjection: 'env-key' }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

describe('ErrorBanner OpenAI connection recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockResolvedValue({
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth',
    });
    mocks.triggerLogin.mockResolvedValue({ authenticated: true, authSource: 'oauth' });
    mocks.cancelLogin.mockResolvedValue(undefined);
    mocks.logout.mockResolvedValue(undefined);
    mocks.onStateChanged.mockReturnValue(() => undefined);
    mocks.onLoginProgress.mockReturnValue(() => undefined);
    (
      window as unknown as {
        electronAPI: {
          maker: {
            auth: {
              getState: typeof mocks.getState;
              triggerLogin: typeof mocks.triggerLogin;
              cancelLogin: typeof mocks.cancelLogin;
              logout: typeof mocks.logout;
              onStateChanged: typeof mocks.onStateChanged;
              onLoginProgress: typeof mocks.onLoginProgress;
            };
          };
        };
      }
    ).electronAPI = {
      maker: {
        auth: {
          getState: mocks.getState,
          triggerLogin: mocks.triggerLogin,
          cancelLogin: mocks.cancelLogin,
          logout: mocks.logout,
          onStateChanged: mocks.onStateChanged,
          onLoginProgress: mocks.onLoginProgress,
        },
      },
    };
  });

  it('waits for an explicit inline action and restores retry after success', async () => {
    const { rerender } = render(
      <ErrorBanner
        error="refresh_token_reused"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.triggerLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledWith('codex'));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('logic.toasts.codexConnected');
    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();

    rerender(
      <ErrorBanner
        error="token_invalidated"
        retryText="retry another turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.codexSessionReconnected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('keeps the reconnect action after user cancellation without showing an error toast', async () => {
    mocks.triggerLogin.mockResolvedValue({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledWith('codex'));
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('keeps the reconnect action and shows actionable copy after timeout', async () => {
    mocks.triggerLogin.mockResolvedValue({
      authenticated: false,
      errorReason: 'login_timeout',
    });
    render(
      <ErrorBanner
        error="token_invalidated"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('settings.connections.codex.toast.loginFailed');
    });
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('uses the same inline recovery for Claude models backed by ChatGPT', async () => {
    render(
      <ErrorBanner
        error="bridge auth unavailable for chatgpt/ (subscription login may have expired)"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="cc"
        modelId="chatgpt/gpt-5.4"
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledWith('codex'));
    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
  });

  it('does not classify a non-OpenAI provider error as ChatGPT reconnect', () => {
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="xai/grok-4"
      />,
    );

    expect(screen.getByText('token_revoked')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
  });

  it('joins an OAuth flow already started from the settings auth hook', async () => {
    const login = deferred<{ authenticated: boolean; authSource: 'oauth' }>();
    mocks.triggerLogin.mockImplementation(() => login.promise);
    const settingsAuth = renderHook(() => useCodexAuth());
    await waitFor(() => expect(settingsAuth.result.current.state.kind).toBe('authenticated'));

    let settingsOutcome!: ReturnType<typeof settingsAuth.result.current.triggerLogin>;
    act(() => {
      settingsOutcome = settingsAuth.result.current.triggerLogin();
    });

    render(
      <ErrorBanner
        error="refresh_token_reused"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    login.resolve({ authenticated: true, authSource: 'oauth' });
    await act(async () => {
      await expect(settingsOutcome).resolves.toBe('authenticated');
    });

    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(mocks.triggerLogin).toHaveBeenCalledWith('codex');
  });
});
