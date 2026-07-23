/**
 * useDeleteMessage — 消息菜单的单条本地删除动作。
 *
 * 这里不复用 rewind：rewind 会裁掉 target 及其后的整段并回滚文件；本功能只
 * 清除当前 user / assistant 正文与元数据，保留无内容墓碑和后续消息，并让 main 在下一次发送前以
 * 剩余本地历史重建原生 Agent 上下文。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { deleteMessageFor } from '@/lib/makerTransport';
import { emitRefresh as emitSessionsRefresh } from '@/lib/sessionsBus';
import { toast } from '@/lib/toast';

const log = createLogger('useDeleteMessage');

interface UseDeleteMessageOptions {
  sessionId?: string;
  messageClientId?: string;
  /** 运行中的 turn 不允许删气泡，避免正在落库的增量把它立刻补回来。 */
  blocked?: boolean;
}

export function useDeleteMessage({
  sessionId,
  messageClientId,
  blocked = false,
}: UseDeleteMessageOptions): () => Promise<void> {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  return useCallback(async () => {
    if (!sessionId || !messageClientId) return;
    if (blocked) {
      toast.warning(t('chat.messageActionBar.deleteBusy'));
      return;
    }

    const ok = await confirm({
      title: t('chat.messageActionBar.deleteConfirmTitle'),
      description: t('chat.messageActionBar.deleteConfirmDescription'),
      confirmText: t('chat.messageActionBar.deleteConfirm'),
      cancelText: t('chat.messageActionBar.deleteCancel'),
    });
    if (!ok) return;

    try {
      await deleteMessageFor(sessionId, messageClientId);
      // main 广播通常会先一步移除；这里再做一次幂等镜像，覆盖旧 preload / 老
      // 被控端没有 push 通道但 invoke 已成功的兼容窗口。
      makerChatStore.removeMessageByClientId(sessionId, messageClientId);
      emitSessionsRefresh();
      const deviceId = getSessionDeviceId(sessionId);
      if (deviceId) void refreshRemoteDeviceSessions(deviceId);
    } catch (err) {
      log.warn('message delete failed', {
        sessionId,
        messageClientId,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error(t('chat.messageActionBar.deleteFailed'));
    }
  }, [blocked, confirm, messageClientId, sessionId, t]);
}
