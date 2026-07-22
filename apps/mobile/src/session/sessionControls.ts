import type { RemoteSession } from '@/session/types';
export {
  summarizeAccountRateLimits,
  summarizeCodexRateLimitReset,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '@lizi/maker-shared/session-controls';

/** Local app-server quota controls must never be shown for an SSH-hosted session. */
export function canUseLocalCodexRateLimitControl(
  session: Pick<RemoteSession, 'agentKind' | 'remoteHostId'> | null,
): boolean {
  return session?.agentKind === 'codex' && !session.remoteHostId?.trim();
}

export function buildContextUsageCreateOpts(session: RemoteSession): Record<string, unknown> {
  return {
    agentKind: session.agentKind === 'codex' ? 'codex' : 'claude-code',
    workingDir: session.workingDir ?? '',
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    fastMode: session.fastMode,
  };
}
