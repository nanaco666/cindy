import type { TFunction } from 'i18next';

import { extractIpcError } from '@/utils/ipcError';

interface CollaborationStartErrorOptions {
  continueAsSingleSession?: boolean;
}

/**
 * 协同启动错误的 renderer 文案边界。
 * main 只负责返回稳定错误码；UI 文案统一在 i18n 里按错误码映射，避免把 IPC message 当作界面文本。
 */
export function getCollaborationStartErrorMessage(
  err: unknown,
  t: TFunction,
  options: CollaborationStartErrorOptions = {},
): string {
  const ipcError = extractIpcError(err);
  if (ipcError?.code === 'BUDGET_MODEL_REQUIRES_API_MODE') {
    return t(
      options.continueAsSingleSession
        ? 'newChat.collaboration.errors.BUDGET_MODEL_REQUIRES_API_MODE_CONTINUE'
        : 'newChat.collaboration.errors.BUDGET_MODEL_REQUIRES_API_MODE',
    );
  }
  return t(
    options.continueAsSingleSession
      ? 'newChat.collaboration.startFailedContinue'
      : 'newChat.collaboration.startFailed',
  );
}
