/**
 * useCodexAuth — Codex OAuth UI hook (走 maker.auth.* IPC)。
 *
 * 历史: 老版本走 electronAPI.codex.auth.*, codex 元 IPC 升级到 maker.* 后改走
 * electronAPI.maker.auth.*('codex'), 内部链路 renderer → main → Maker → BaseAgent.deps.auth。
 *
 * 文件名仍叫 useCodexAuth 是因为 OAuth 子进程式登录 (浏览器跳转 + 取消) 是 Codex 专属
 * UX 流程; Claude 走 renderer useApiKey hook 的同步弹窗式登录, UX 形态完全不同, hook
 * 强行合并意义不大。本 hook 内部把 agentKind 写死成 'codex'。
 *
 * 未来加新 OAuth-style agent (e.g. Gemini) 可以参数化为 useAgentAuth(agentKind)。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodexUiState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'login-pending' }
  | { kind: 'authenticated'; identity?: string; expiresAt?: number; authSource?: 'oauth' | 'api-key' }
  | { kind: 'error'; message: string };

export type CodexLoginOutcome = 'authenticated' | 'cancelled' | 'failed' | 'already-pending';

const AGENT_KIND = 'codex' as const;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCodexAuth(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const { t } = useTranslation();
  const [state, setState] = useState<CodexUiState>({ kind: 'loading' });
  // Track in-flight triggerLogin so cancelLogin can be called
  const loginInFlight = useRef(false);

  // On mount: pull initial auth state from main
  useEffect(() => {
    if (!enabled) return undefined;
    window.electronAPI.maker.auth.getState(AGENT_KIND).then((raw) => {
      const s = raw as { authenticated: boolean; identity?: string; expiresAt?: number; authSource?: 'oauth' | 'api-key' };
      setState(
        s.authenticated
          ? { kind: 'authenticated', identity: s.identity, expiresAt: s.expiresAt, authSource: s.authSource }
          : { kind: 'unauthenticated' },
      );
    }).catch(() => {
      setState({ kind: 'unauthenticated' });
    });
  }, [enabled]);

  // Subscribe to state-changed push from main (按 agentKind 过滤, 多 agent 共用一条 channel)
  useEffect(() => {
    if (!enabled) return undefined;
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind !== AGENT_KIND) return;
      const s = payload as { authenticated: boolean; identity?: string; expiresAt?: number; errorReason?: string; authSource?: 'oauth' | 'api-key' };
      if (s.authenticated) {
        setState({ kind: 'authenticated', identity: s.identity, expiresAt: s.expiresAt, authSource: s.authSource });
      } else {
        setState(
          s.errorReason
            ? { kind: 'error', message: s.errorReason }
            : { kind: 'unauthenticated' },
        );
      }
    });
    return off;
  }, [enabled]);

  // Subscribe to login progress (binary download is handled at app startup,
  // so only login-pending phases reach here; codex CLI 的 OAuth URL 也走这里)。
  useEffect(() => {
    if (!enabled) return undefined;
    const off = window.electronAPI.maker.auth.onLoginProgress((p) => {
      if (p.agentKind !== AGENT_KIND) return;
      if (p.phase === 'login-pending') {
        setState({ kind: 'login-pending' });
      } else if (p.phase === 'login-error') {
        setState({ kind: 'error', message: p.detail ?? 'unknown' });
      }
    });
    return off;
  }, [enabled]);

  const triggerLogin = useCallback(async (): Promise<CodexLoginOutcome> => {
    if (loginInFlight.current) return 'already-pending';
    loginInFlight.current = true;
    // Optimistically jump straight to login-pending — binary is already prepared
    // at app startup, so there's no preparing phase to display.
    setState({ kind: 'login-pending' });
    try {
      const raw = await window.electronAPI.maker.auth.triggerLogin(AGENT_KIND);
      const result = raw as { authenticated: boolean; identity?: string; expiresAt?: number; errorReason?: string; authSource?: 'oauth' | 'api-key' };
      if (result.authenticated) {
        setState({ kind: 'authenticated', identity: result.identity, expiresAt: result.expiresAt, authSource: result.authSource });
        toast.success(t('logic.toasts.codexConnected'));
        return 'authenticated';
      }

      const reason = result.errorReason ?? 'login_failed';
      if (reason === 'login_cancelled') {
        setState({ kind: 'unauthenticated' });
        return 'cancelled';
      }
      setState({ kind: 'error', message: reason });
      return 'failed';
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'login_failed';
      if (msg.includes('login_cancelled')) {
        setState({ kind: 'unauthenticated' });
        return 'cancelled';
      }
      setState({ kind: 'error', message: msg });
      return 'failed';
    } finally {
      loginInFlight.current = false;
    }
  }, [t]);

  const cancelLogin = useCallback(async () => {
    await window.electronAPI.maker.auth.cancelLogin(AGENT_KIND).catch(() => undefined);
    setState({ kind: 'unauthenticated' });
  }, []);

  const logout = useCallback(async () => {
    try {
      await window.electronAPI.maker.auth.logout(AGENT_KIND);
      setState({ kind: 'unauthenticated' });
    } catch (error) {
      // main 可能在 marker 提交前失败（仍已连接），也可能在 marker 提交后的文件清理阶段
      // 失败（已权威断开）。重读一次状态，避免 UI 假报成功或永久停在过期连接态。
      try {
        const raw = await window.electronAPI.maker.auth.getState(AGENT_KIND);
        const current = raw as {
          authenticated: boolean;
          identity?: string;
          expiresAt?: number;
          authSource?: 'oauth' | 'api-key';
        };
        setState(current.authenticated
          ? {
            kind: 'authenticated',
            identity: current.identity,
            expiresAt: current.expiresAt,
            authSource: current.authSource,
          }
          : { kind: 'unauthenticated' });
      } catch {
        // 状态查询也失败时保留当前 UI；原始 logout 错误仍交给调用方展示。
      }
      throw error;
    }
  }, []);

  return { state, triggerLogin, cancelLogin, logout };
}
