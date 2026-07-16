/**
 * maker:auth:* IPC 的纯 handler body。
 *
 * Electron adapter 只负责注入 registry 和 broadcast，这里维护参数校验、Maker 调用和
 * push payload 归一化。
 */

import type { AgentKind, AuthState, Maker } from '@lizi/maker-core';

import { requireEnum, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** main → renderer 的 push 广播能力。 */
export type MakerIpcBroadcast = (channel: string, payload: unknown) => void;

/** IPC 允许的 agent 种类；运行时枚举校验不能靠 TypeScript 强转替代。 */
const AGENT_KINDS = ['claude-code', 'codex'] as const satisfies readonly AgentKind[];

export function registerMakerAuthHandlers(
  registry: IpcHandlerRegistry,
  maker: Maker,
  broadcast: MakerIpcBroadcast,
  /** 网关 API key 读取器(host 注入,同 renderer useApiKey 那把 key;handler 只暴露 presence)。 */
  readApiKey: () => string | null,
  /**
   * Codex(OpenAI)账号成功登录/登出后的额外回调(可选,可 async)；参数是边界后的登录态。
   * 生产注入两件事(见 auth.ts):清 bridge 凭证缓存(旧 accessToken/accountId 已失效,
   * 否则新账号登录后 30s 内仍带旧凭证发请求)+ 重读 codex models_cache 刷新 chatgpt/
   * 发现清单。handler 在 AUTH_STATE_CHANGED 广播**之前** await 它 —— renderer 收到广播
   * 后 refetch 的必须已是最新目录,否则新模型要等重启才出现在选择器里。
   */
  onCodexAuthChange?: (authenticated: boolean) => void | Promise<void>,
): void {
  registry.handle(MAKER_INVOKE.AUTH_GET_STATE, async (_e, agentKind: unknown): Promise<AuthState> => {
    return maker.getAgentAuthState(requireAgentKind(agentKind));
  });

  // presence-only:只回「有没有配 key」,绝不回密钥本体。device-link 控制端(手机 / 远程桌面)
  // 用它决定骨折版(codex/)行是否置灰 —— key 与请求都在被控端,这里才是判定真相。
  registry.handle(MAKER_INVOKE.API_KEY_PRESENT, async (): Promise<{ present: boolean }> => {
    return { present: !!readApiKey() };
  });

  registry.handle(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, async (_e, agentKind: unknown): Promise<AuthState> => {
    const kind = requireAgentKind(agentKind);
    const result = await maker.triggerAgentLogin(kind, {
      onProgress: (msg) => {
        broadcast(MAKER_PUSH.AUTH_LOGIN_PROGRESS, toLoginProgressPayload(kind, msg));
      },
    });
    if (kind === 'codex' && result.authenticated && result.authSource === 'oauth') {
      await onCodexAuthChange?.(true);
    }
    broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, ...result });
    return result;
  });

  registry.handle(MAKER_INVOKE.AUTH_CANCEL_LOGIN, async (_e, agentKind: unknown): Promise<void> => {
    maker.cancelAgentLogin(requireAgentKind(agentKind));
  });

  registry.handle(MAKER_INVOKE.AUTH_LOGOUT, async (_e, agentKind: unknown): Promise<void> => {
    const kind = requireAgentKind(agentKind);
    try {
      await maker.logoutAgent(kind);
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
    if (kind === 'codex') await onCodexAuthChange?.(false);
    broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, authenticated: false });
  });
}

function requireAgentKind(value: unknown): AgentKind {
  return requireEnum(value, AGENT_KINDS, 'agentKind');
}

function toLoginProgressPayload(agentKind: AgentKind, msg: string): Record<string, unknown> {
  // Codex CLI 会把 OAuth URL 打到 stdout/stderr，两路都归一成 login-pending。
  if (msg.startsWith('stdout:')) {
    return { agentKind, phase: 'login-pending', detail: msg.slice('stdout:'.length) };
  }
  if (msg.startsWith('stderr:')) {
    return { agentKind, phase: 'login-pending', detail: msg.slice('stderr:'.length) };
  }
  return { agentKind, phase: msg };
}
