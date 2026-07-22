import type { RemoteSession } from '@/session/types';
export {
  summarizeAccountRateLimits,
  summarizeCodexRateLimitReset,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '@lizi/maker-shared/session-controls';

/** Local ChatGPT quota controls are only relevant to local Codex subscription sessions. */
export function canUseLocalCodexRateLimitControl(
  session: Pick<RemoteSession, 'agentKind' | 'model' | 'providerId' | 'remoteHostId'> | null,
): boolean {
  if (session?.agentKind !== 'codex' || session.remoteHostId?.trim()) return false;
  const providerId = session.providerId?.trim() ?? '';
  const model = session.model.trim();
  return (providerId === '' || providerId === 'openai')
    && !model.startsWith('codex/')
    && !model.startsWith('chatgpt/')
    && !model.startsWith('xai/');
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
