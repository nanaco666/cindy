import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';

export type AgentSwitchTarget = 'claude-code' | 'codex';

/**
 * 触发确认的交互原因。模型/来源行确认属于真正的切换选择；effort / Fast
 * 只是在已有意图上调整参数，不应重复打断用户。
 */
export type AgentSwitchConfirmationReason = 'model-selection' | 'intent-preference-update';

/**
 * 隐藏的本地用户 override（规则 20）：键缺失 = 系统默认“显示确认”；用户勾选
 * “下次不再提醒”并确认后，ConfirmDialogProvider 会写入显式 override。删除对应
 * `confirm-dialog.skip:*` localStorage 键即可恢复当前版本默认值，不固化默认快照。
 */
export const AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY = 'new-chat.agent-switch.handoff-risk.v1';

export interface AgentSwitchConfirmationCopy {
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  dontShowAgainLabel: string;
}

export interface ConfirmAgentSwitchRiskParams {
  existingIntentTarget: AgentSwitchTarget | null | undefined;
  targetAgentKind: AgentSwitchTarget;
  reason: AgentSwitchConfirmationReason;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  copy: AgentSwitchConfirmationCopy;
}

/**
 * Agent 切换确认门。
 *
 * - 首次切换、以及意图期内改选目标模型/来源：提示风险；
 * - 意图期选回原引擎：这是撤销意图，直接放行且不弹；
 * - 意图期只改 effort / Fast：不是再次确认切换，直接放行。
 */
export async function confirmAgentSwitchRisk({
  existingIntentTarget,
  targetAgentKind,
  reason,
  confirm,
  copy,
}: ConfirmAgentSwitchRiskParams): Promise<boolean> {
  const isCancelingExistingIntent =
    existingIntentTarget != null && existingIntentTarget !== targetAgentKind;
  if (isCancelingExistingIntent || reason === 'intent-preference-update') return true;

  return confirm({
    title: copy.title,
    description: copy.description,
    confirmText: copy.confirmText,
    cancelText: copy.cancelText,
    dontShowAgainKey: AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
    dontShowAgainLabel: copy.dontShowAgainLabel,
  });
}
