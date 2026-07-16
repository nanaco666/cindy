import type { RemoteSession } from '@/session/types';
export {
  summarizeAccountRateLimits,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '@lizi/maker-shared/session-controls';

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
