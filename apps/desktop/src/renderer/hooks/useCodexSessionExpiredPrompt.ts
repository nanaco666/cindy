import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';

export function isCodexSessionExpiredError(error: string): boolean {
  return /app_session_terminated|token_invalidated|refresh_token_reused|Your session has ended|authentication token has been invalidated|refresh token was already used|refresh_token.*already used/i.test(
    error,
  );
}

export function useCodexSessionExpiredPrompt(options?: {
  onAuthenticated?: () => void;
  onPromptClosed?: () => void;
}): (error: string) => boolean {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const promptedForErrorRef = useRef<string | null>(null);
  const promptActiveRef = useRef(false);
  const onAuthenticatedRef = useRef(options?.onAuthenticated);
  const onPromptClosedRef = useRef(options?.onPromptClosed);
  onAuthenticatedRef.current = options?.onAuthenticated;
  onPromptClosedRef.current = options?.onPromptClosed;

  return useCallback((error: string) => {
    if (!isCodexSessionExpiredError(error)) return false;
    if (promptedForErrorRef.current === error) return promptActiveRef.current;
    promptedForErrorRef.current = error;
    promptActiveRef.current = true;

    const closePrompt = () => {
      promptedForErrorRef.current = null;
      promptActiveRef.current = false;
      onPromptClosedRef.current?.();
    };

    void (async () => {
      const ok = await confirm({
        title: t('chat.errorBanner.codexSessionExpiredDialog.title'),
        description: t('chat.errorBanner.codexSessionExpiredDialog.description'),
        confirmText: t('chat.errorBanner.codexSessionExpiredDialog.confirm'),
        cancelText: t('chat.errorBanner.codexSessionExpiredDialog.cancel'),
        autoFocusConfirm: true,
      });
      if (!ok) {
        closePrompt();
        return;
      }

      try {
        const result = await window.electronAPI.maker.auth.triggerLogin('codex');
        if (result.authenticated) {
          onAuthenticatedRef.current?.();
          toast.success(t('logic.toasts.codexConnected'));
        } else {
          toast.error(result.errorReason ?? 'login_failed');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'login_failed';
        toast.error(msg);
      } finally {
        closePrompt();
      }
    })();
    return true;
  }, [confirm, t]);
}
