import { useState } from 'react';

import { AskUserQuestionPrompt } from '@/components/new-chat/AskUserQuestionPrompt';
import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';
import { PlanActionCard } from '@/components/new-chat/PlanActionCard';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type {
  AskUserDraft,
  AskUserViewerState,
  PendingAskUser,
  PendingPermission,
} from '@/lib/makerChatStore';
import type {
  BotGroupInteractionDecision,
  BotGroupPendingInteraction,
} from '../../../shared/botGroupChat';

type PermissionUiResult = {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
  updatedPermissions?: unknown[];
};

export function botGroupPermissionDecision(
  result: PermissionUiResult,
): BotGroupInteractionDecision {
  return {
    kind: 'permission',
    behavior: result.behavior,
    ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
    ...(result.message ? { reason: result.message } : {}),
    ...(Array.isArray(result.updatedPermissions)
      ? { permissionUpdates: result.updatedPermissions }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function permissionFrom(
  interaction: BotGroupPendingInteraction,
): PendingPermission {
  const request = interaction.request;
  return {
    requestId: request.requestId,
    toolName: typeof request.toolName === 'string' ? request.toolName : 'Tool',
    input: record(request.input) ?? {},
    ...(typeof request.title === 'string' ? { title: request.title } : {}),
    ...(typeof request.displayName === 'string' ? { displayName: request.displayName } : {}),
    ...(typeof request.description === 'string' ? { description: request.description } : {}),
    ...(Array.isArray(request.suggestions) ? { suggestions: request.suggestions } : {}),
    ...(request.autoReviewUnavailable === true ? { autoReviewUnavailable: true } : {}),
  };
}

export function BotGroupInteractionPanel({
  interaction,
  onResolve,
}: {
  interaction: BotGroupPendingInteraction;
  onResolve: (decision: BotGroupInteractionDecision) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askViewerState, setAskViewerState] = useState<AskUserViewerState>('expanded');
  const [askDraft, setAskDraft] = useState<AskUserDraft | null>(null);

  const submit = async (decision: BotGroupInteractionDecision) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve(decision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const request = interaction.request;
  return (
    <div className={busy ? 'pointer-events-none opacity-70' : undefined}>
      {request.kind === 'permission' ? (
        <PermissionPrompt
          permission={permissionFrom(interaction)}
          onRespond={(result) => void submit(botGroupPermissionDecision(result))}
        />
      ) : request.kind === 'ask_user_question' ? (
        <AskUserQuestionPrompt
          pending={{
            requestId: request.requestId,
            questions: (Array.isArray(request.questions) ? request.questions : []) as PendingAskUser['questions'],
          }}
          onAnswer={(_requestId, answers) => void submit({
            kind: 'ask_user_question',
            answers,
          })}
          viewerState={askViewerState}
          onViewerStateChange={setAskViewerState}
          draft={askDraft}
          onDraftChange={setAskDraft}
        />
      ) : (
        <div className="space-y-2">
          <div className="max-h-72 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
            <MarkdownRenderer
              content={typeof request.plan === 'string' ? request.plan : ''}
              workingDir=""
            />
          </div>
          <PlanActionCard
            requestId={request.requestId}
            onRespond={(_requestId, approved, feedback) => void submit({
              kind: 'plan_review',
              behavior: approved ? 'allow' : 'deny',
              ...(feedback ? { reason: feedback } : {}),
            })}
            onCancel={() => void submit({
              kind: 'plan_review',
              behavior: 'deny',
              reason: 'User cancelled plan review',
            })}
          />
        </div>
      )}
      {error ? (
        <p className="mt-2 rounded-lg bg-[var(--status-danger-soft-bg)] px-3 py-2 text-12 text-[var(--text-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
