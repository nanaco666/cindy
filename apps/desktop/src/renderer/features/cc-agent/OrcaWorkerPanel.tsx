/**
 * OrcaWorkerPanel —— 右侧栏「协同」tab 内的 worker-only 面板。
 *
 * 只承载 Worker 侧能力:worker 列表 / focus 切换 / 新建 / 归档 / 当前 focused worker
 * 会话流。Lead 主会话仍由普通 CCAgentSessionView 渲染,这里不复用 OrcaSplitView 的
 * 双栏布局与独立 resize/maximize。
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { canOpenWorkerFromShortcut } from '@/lib/newMakerCommandRouting';
import { CCAgentSessionView } from './CCAgentSessionView';
import { CreateWorkerPopover } from './CreateWorkerPopover';
import { WorkerListToolbar } from './RolePillDropdown';
import { useOrcaWorkerSelection } from './hooks/useOrcaWorkerSelection';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';

export interface OrcaWorkerPanelProps {
  leadSessionId: string;
  /** device-link controlled device that owns the Lead and its Worker team. */
  deviceId?: string;
  /** tab active && RSB 未折叠 && 窗口可见。挂载但不可见时不能清红点 / ack 消息。 */
  viewVisible: boolean;
  /** 重型聊天 snapshot 是否实时刷新；隐藏 keep-alive worker pane 会冻结 messages。 */
  chatRealtime?: boolean;
  focusWorkerSessionId?: string | null;
  focusWorkerHintRevision?: number;
  searchJump?: ConversationSearchJump | null;
  createWorkerRequestPending?: boolean;
  createWorkerRequestRevision?: number;
  onFocusWorkerSessionIdConsumed?: (revision: number) => void;
  onSelectionIntentCleared?: (revision: number) => void;
  onSearchJumpConsumed?: () => void;
  onCreateWorkerRequestConsumed?: (revision: number) => void;
}

function sameVisibleSessionPayload(
  a: string | string[] | null,
  b: string | string[] | null,
): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function OrcaWorkerPanel({
  leadSessionId,
  deviceId,
  viewVisible,
  chatRealtime = true,
  focusWorkerSessionId,
  focusWorkerHintRevision,
  searchJump,
  createWorkerRequestPending = false,
  createWorkerRequestRevision = 0,
  onFocusWorkerSessionIdConsumed,
  onSelectionIntentCleared,
  onSearchJumpConsumed,
  onCreateWorkerRequestConsumed,
}: OrcaWorkerPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refresh,
    selectedWorkerRecord,
    selectedWorkerId,
    workerSessionId,
    createOpen,
    setCreateOpen,
    handleCreateWorker,
    handleSwitchFocus,
    handleArchiveWorker,
  } = useOrcaWorkerSelection({
    leadSessionId,
    deviceId,
    focusWorkerSessionId,
    focusWorkerHintRevision,
    searchJump,
    onFocusWorkerSessionIdConsumed,
    onSelectionIntentCleared,
  });
  const lastAgentIslandPayloadRef = useRef<string | string[] | null>(null);
  const handledCreateWorkerRevisionRef = useRef(0);
  const hardLimitRef = useRef(hardLimit);
  hardLimitRef.current = hardLimit;

  useEffect(() => {
    handledCreateWorkerRevisionRef.current = 0;
  }, [leadSessionId]);

  useEffect(() => {
    if (!viewVisible || !createWorkerRequestPending || createWorkerRequestRevision <= 0) return;
    if (handledCreateWorkerRevisionRef.current >= createWorkerRequestRevision) return;
    handledCreateWorkerRevisionRef.current = createWorkerRequestRevision;
    let active = true;
    let settled = false;

    // Refresh before checking the hard limit: a cold/stale worker cache must never let the
    // keyboard path open a dialog that the visible create button would disable.
    void refresh().then((result) => {
      if (!active) return;
      settled = true;
      if (
        result?.status === 'applied' &&
        canOpenWorkerFromShortcut(result.workers, hardLimitRef.current)
      ) {
        setCreateOpen(true);
      }
      // Keep the intent pending while refresh is in flight. If this panel unmounts, the next
      // owner can retry the same revision instead of losing the shortcut in a stale callback.
      onCreateWorkerRequestConsumed?.(createWorkerRequestRevision);
    });

    return () => {
      active = false;
      if (!settled && handledCreateWorkerRevisionRef.current === createWorkerRequestRevision) {
        handledCreateWorkerRevisionRef.current = createWorkerRequestRevision - 1;
      }
    };
  }, [
    createWorkerRequestPending,
    createWorkerRequestRevision,
    leadSessionId,
    onCreateWorkerRequestConsumed,
    refresh,
    setCreateOpen,
    viewVisible,
  ]);

  useEffect(() => {
    if (!isAgentIslandSupported()) return;
    // 可见性归属契约:协同 tab 真正可见时由 worker panel 上报 [lead, worker]；
    // 隐藏、切 tab 或折叠 RSB 时回落为 lead,避免和主 Lead 视图靠 effect 时序抢归属。
    const visibleSessionIds =
      viewVisible && workerSessionId && workerSessionId !== leadSessionId
        ? [leadSessionId, workerSessionId]
        : leadSessionId;
    if (!sameVisibleSessionPayload(lastAgentIslandPayloadRef.current, visibleSessionIds)) {
      lastAgentIslandPayloadRef.current = visibleSessionIds;
      void window.electronAPI.agentIsland?.setVisibleSession?.(visibleSessionIds);
    }
  }, [leadSessionId, viewVisible, workerSessionId]);

  useEffect(() => {
    return () => {
      if (!isAgentIslandSupported()) return;
      if (lastAgentIslandPayloadRef.current !== leadSessionId) {
        lastAgentIslandPayloadRef.current = leadSessionId;
        void window.electronAPI.agentIsland?.setVisibleSession?.(leadSessionId);
      }
    };
  }, [leadSessionId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-content-area">
      <div className="flex h-8 shrink-0 items-center border-b border-border/40 px-3 text-[11px] font-medium leading-none text-muted-foreground">
        <WorkerListToolbar
          worker={selectedWorkerRecord ?? focusedWorker}
          workers={workers}
          selectedWorkerId={selectedWorkerId}
          activeWorkerCount={activeWorkerCount}
          softLimit={softLimit}
          hardLimit={hardLimit}
          onSwitchFocus={handleSwitchFocus}
          onOpenCreate={() => setCreateOpen(true)}
          onOpenSettings={() => navigate('/settings?section=collaboration')}
          settingsEnabled={!isSidebarWindow()}
          onArchiveWorker={handleArchiveWorker}
          clearAttentionWhenVisible={viewVisible}
        />
      </div>
      <div className="chat-rail-compact min-h-0 flex-1">
        {workerSessionId ? (
          <CCAgentSessionView
            key={workerSessionId}
            sessionIdProp={workerSessionId}
            compact
            orcaMode
            compactToolbar
            viewVisible={viewVisible}
            chatRealtime={chatRealtime}
            searchJumpProp={searchJump}
            onSearchJumpConsumed={onSearchJumpConsumed}
            navigationMode="sidebar-embedded"
            sidebarTargetSessionId={leadSessionId}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('orca.split.waitingForWorker')}
          </div>
        )}
      </div>
      <CreateWorkerPopover
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateWorker}
        deviceId={deviceId}
      />
    </div>
  );
}
