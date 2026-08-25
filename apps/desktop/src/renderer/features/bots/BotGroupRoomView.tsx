import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Archive, ArrowLeft, CircleAlert, MessageCircleMore, Settings2, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ChatInput } from '@/components/new-chat/ChatInput';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useAttachments } from '@/hooks/useAttachments';
import type { Message } from '@/lib/ccAgent.types';
import * as messageService from '@/lib/messageService';
import * as sessionService from '@/lib/sessionService';
import { serializeAttachedFiles } from '@/lib/messageAttachmentPayload';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { BotGroupInteractionPanel } from './BotGroupInteractionPanel';
import {
  botGroupRoomState,
  normalizeBotGroupReferences,
  presentedRoomMessages,
} from './botGroupChatPresentation';
import {
  archiveBotGroupRoom,
  refreshBotGroupRoom,
  updateBotGroupRoom,
} from './botGroupStore';
import { useBotProfiles } from './botStore';
import type { BotGroupRoomProjection } from '../../../shared/botGroupChat';

type RoomLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; room: BotGroupRoomProjection; roomSession: Awaited<ReturnType<typeof sessionService.get>>; messages: Message[] }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export function BotGroupRoomView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { roomId } = useParams();
  const bots = useBotProfiles();
  const [state, setState] = useState<RoomLoadState>({ kind: 'loading' });
  const [sendError, setSendError] = useState<string | null>(null);
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editAvatar, setEditAvatar] = useState('👥');
  const [manageBusy, setManageBusy] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const roomSessionId = state.kind === 'ready' ? state.room.roomSessionId : undefined;
  const attachmentState = useAttachments(roomSessionId, roomId ? `bot-group:${roomId}` : undefined);

  const load = useCallback(async () => {
    if (!roomId) {
      setState({ kind: 'missing' });
      return;
    }
    try {
      const room = await refreshBotGroupRoom(roomId);
      if (!room) {
        setState({ kind: 'missing' });
        return;
      }
      const [messages, roomSession] = await Promise.all([
        messageService.list(room.roomSessionId, { limit: 300 }),
        sessionService.get(room.roomSessionId),
      ]);
      setState({ kind: 'ready', room, roomSession, messages });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!roomId) return;
    const unsubscribeGroup = window.electronAPI.maker.botGroups.onChanged((payload) => {
      if (payload.roomId === roomId) void load();
    });
    const unsubscribeMessage = window.electronAPI.localDb.messages.onCreated((payload) => {
      if (state.kind === 'ready' && payload.sessionId === state.room.roomSessionId) {
        void load();
      }
    });
    return () => {
      unsubscribeGroup();
      unsubscribeMessage();
    };
  }, [load, roomId, state]);

  const messages = useMemo(
    () => state.kind === 'ready' ? presentedRoomMessages(state.messages) : [],
    [state],
  );
  const activeInteraction = state.kind === 'ready' ? state.room.interactions?.[0] : undefined;

  const applyRoomRuntimePatch = useCallback(
    async (patch: Parameters<typeof sessionService.update>[1]) => {
      if (state.kind !== 'ready') return;
      const next = await sessionService.update(state.room.roomSessionId, patch);
      setState((current) => (current.kind !== 'ready' ? current : { ...current, roomSession: next }));
      await Promise.all(
        state.room.members.map((member) => sessionService.update(member.sessionId, patch)),
      );
    },
    [state],
  );

  const openManagement = () => {
    if (state.kind !== 'ready') return;
    setEditName(state.room.name);
    setEditAvatar(state.room.avatar);
    setManageError(null);
    setManageOpen(true);
  };

  const saveIdentity = async () => {
    if (state.kind !== 'ready' || !editName.trim() || !editAvatar.trim()) return;
    setManageBusy(true);
    setManageError(null);
    try {
      await updateBotGroupRoom(state.room.id, {
        name: editName.trim(),
        avatar: editAvatar.trim(),
      });
      await load();
      setManageOpen(false);
    } catch (error) {
      setManageError(error instanceof Error ? error.message : String(error));
    } finally {
      setManageBusy(false);
    }
  };

  const archiveRoom = async () => {
    if (state.kind !== 'ready') return;
    const accepted = await confirm({
      title: t('bots.groups.archiveTitle'),
      description: t('bots.groups.archiveDescription', { name: state.room.name }),
      confirmText: t('bots.groups.archive'),
      cancelText: t('bots.cancel'),
      confirmVariant: 'destructive',
    });
    if (!accepted) return;
    setManageBusy(true);
    setManageError(null);
    try {
      await archiveBotGroupRoom(state.room.id);
      await load();
      setManageOpen(false);
    } catch (error) {
      setManageError(error instanceof Error ? error.message : String(error));
    } finally {
      setManageBusy(false);
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, state.kind === 'ready' ? state.room.running : false]);

  if (state.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <Spinner size={20} role="status" aria-label={t('ccAgent.common.loading')} />
      </main>
    );
  }

  if (state.kind !== 'ready') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
        <section className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-center">
          <CircleAlert size={24} className="mx-auto text-[var(--text-danger)]" />
          <h1 className="mt-3 text-16 font-medium text-[var(--text-primary)]">
            {t(state.kind === 'missing' ? 'bots.groups.missingTitle' : 'bots.groups.loadFailedTitle')}
          </h1>
          <p className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
            {t(state.kind === 'missing' ? 'bots.groups.missingDescription' : 'bots.groups.loadFailedDescription')}
          </p>
          {state.kind === 'error' ? (
            <p className="mt-3 rounded-lg bg-[var(--surface)] px-3 py-2 text-left text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">
              {state.message}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => navigate('/bots/groups')}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            <ArrowLeft size={14} />
            {t('bots.groups.back')}
          </button>
        </section>
      </main>
    );
  }

  const { room } = state;
  const roomState = botGroupRoomState(room);
  const memberBots = room.members
    .map((member) => bots.find((bot) => bot.id === member.botId))
    .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot));

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--surface)]">
      <header className="flex min-h-16 items-center gap-3 border-b border-[var(--border-default)] px-5 py-3">
        <button
          type="button"
          onClick={() => navigate('/bots/groups')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"
          aria-label={t('bots.groups.back')}
        >
          <ArrowLeft size={17} />
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-16" aria-hidden>
          {room.avatar}
        </div>
        <div className="flex -space-x-1.5">
          {memberBots.slice(0, 4).map((bot) => (
            <BotAvatar key={bot.id} bot={bot} size="sm" className="ring-2 ring-[var(--surface)]" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-15 font-medium text-[var(--text-primary)]">{room.name}</h1>
          <p className="truncate text-11 text-[var(--text-tertiary)]">
            {t(`bots.groups.state.${roomState}`)} · {t('bots.groups.memberCount', { count: room.members.length })}
          </p>
        </div>
        <button
          type="button"
          onClick={openManagement}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"
          aria-label={t('bots.groups.manage')}
        >
          <Settings2 size={16} />
        </button>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-center">
              <MessageCircleMore size={28} className="text-[var(--text-tertiary)]" />
              <p className="mt-3 text-14 font-medium text-[var(--text-primary)]">
                {t('bots.groups.roomEmptyTitle')}
              </p>
              <p className="mt-1 max-w-md text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.groups.roomEmptyDescription')}
              </p>
            </div>
          ) : messages.map(({ id, value }) => {
            const bot = value.kind === 'bot'
              ? bots.find((candidate) => candidate.id === value.botId)
              : null;
            const user = value.kind === 'user';
            return (
              <article key={id} className={cn('flex gap-2.5', user && 'justify-end')}>
                {!user && bot ? <BotAvatar bot={bot} size="sm" className="mt-0.5" /> : null}
                <div className={cn('min-w-0 max-w-[78%]', user && 'text-right')}>
                  <div className="mb-1 px-1 text-11 text-[var(--text-tertiary)]">{value.name}</div>
                  <div className={cn(
                    'whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-left text-13 leading-5 [overflow-wrap:anywhere]',
                    user
                      ? 'rounded-br-md bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]'
                      : 'rounded-bl-md border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]',
                  )}>
                    {value.text}
                    {value.attachments.length > 0 ? (
                      <div className={cn('mt-2 flex flex-wrap gap-1.5', !value.text && 'mt-0')}>
                        {value.attachments.map((name, index) => (
                          <span key={`${name}:${index}`} className={cn(
                            'rounded-lg border px-2 py-1 text-11',
                            user
                              ? 'border-white/30 bg-white/10 text-current'
                              : 'border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-secondary)]',
                          )}>
                            {name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setReplyThreadId(value.threadId)}
                    className="mt-1 px-1 text-11 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  >
                    {t('bots.groups.replyThread')}
                  </button>
                </div>
              </article>
            );
          })}
          {room.running ? (
            <p className="text-12 italic text-[var(--text-tertiary)]">{t('bots.groups.responding')}</p>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </section>

      <footer className="border-t border-[var(--border-default)] px-5 pb-4 pt-3">
        <div className="mx-auto w-full max-w-3xl">
          {activeInteraction ? (
            <div className="mb-3">
              <p className="mb-2 text-12 font-medium text-[var(--text-primary)]">
                {t('bots.groups.interactionTitle', { name: activeInteraction.botName })}
              </p>
              <BotGroupInteractionPanel
                key={activeInteraction.request.requestId}
                interaction={activeInteraction}
                onResolve={async (decision) => {
                  await window.electronAPI.maker.botGroups.resolveInteraction(
                    room.id,
                    activeInteraction.request.requestId,
                    decision,
                  );
                  await load();
                }}
              />
            </div>
          ) : null}
          {sendError ? (
            <p className="mb-2 rounded-lg bg-[var(--status-danger-soft-bg)] px-3 py-2 text-12 text-[var(--text-danger)]">
              {sendError}
            </p>
          ) : null}
          {replyThreadId ? (
            <div className="mb-2 flex items-center justify-between rounded-lg bg-[var(--surface-elevated)] px-3 py-2 text-11 text-[var(--text-secondary)]">
              <span>{t('bots.groups.replyingThread')}</span>
              <button type="button" onClick={() => setReplyThreadId(null)} className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                {t('bots.cancel')}
              </button>
            </div>
          ) : null}
          {!activeInteraction ? <ChatInput
            sessionId={room.roomSessionId}
            draftKey={`bot-group:${room.id}`}
            runtimeAgentKind={
              state.roomSession.agentKind === 'codex'
                ? 'codex'
                : state.roomSession.agentKind === 'pi'
                  ? 'pi'
                  : 'claude-code'
            }
            vendorKey={
              state.roomSession.agentKind === 'codex'
                ? 'codex'
                : state.roomSession.agentKind === 'pi'
                  ? 'pi'
                  : 'cc'
            }
            initialModel={state.roomSession.model}
            initialEffort={state.roomSession.effort as never}
            initialProviderId={state.roomSession.providerId ?? null}
            fastMode={state.roomSession.fastMode}
            showFolderPicker={false}
            disabled={room.status !== 'active'}
            attachmentState={attachmentState}
            messages={messages.map(({ value }) => ({ role: value.kind === 'user' ? 'user' : 'assistant', content: value.text }))}
            botMentions={room.members.map((member) => {
              const profile = memberBots.find((bot) => bot.id === member.botId);
              return {
                id: member.botId,
                name: member.name,
                ...(profile?.description ? { description: profile.description } : {}),
              };
            })}
            placeholder={t('bots.groups.placeholder')}
            onModelDidChange={(model) => {
              void applyRoomRuntimePatch({ model });
            }}
            onEffortDidChange={(effort) => {
              void applyRoomRuntimePatch({ effort });
            }}
            onProviderDidChange={(providerId) => {
              void applyRoomRuntimePatch({ providerId });
            }}
            onFastModeChange={(enabled) => {
              void applyRoomRuntimePatch({ fastMode: enabled });
            }}
            onSend={async (message, _model, _effort, _permission, files, mentions, opts) => {
              if ((mentions?.length ?? 0) > 0) {
                setSendError(t('bots.groups.referencesUnsupported'));
                return false;
              }
              const groupMentions = room.members.map((member) => ({
                id: member.botId,
                name: member.name,
              }));
              const normalizedMessage = normalizeBotGroupReferences(
                message,
                opts?.agentReferences,
                groupMentions,
              );
              if (normalizedMessage === null) {
                setSendError(t('bots.groups.referencesUnsupported'));
                return false;
              }
              setSendError(null);
              try {
                await window.electronAPI.maker.botGroups.send(room.id, normalizedMessage, {
                  ...(replyThreadId ? { threadId: replyThreadId } : {}),
                  ...(files?.length ? { files: serializeAttachedFiles(files) } : {}),
                });
                setReplyThreadId(null);
                await load();
                return true;
              } catch (error) {
                setSendError(error instanceof Error ? error.message : String(error));
                return false;
              }
            }}
          /> : null}
        </div>
      </footer>

      <Dialog.Root open={manageOpen} onOpenChange={(open) => !manageBusy && setManageOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-16 font-semibold text-[var(--text-primary)]">
                  {t('bots.groups.manageTitle')}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                  {t('bots.groups.manageDescription')}
                </Dialog.Description>
              </div>
              <Dialog.Close disabled={manageBusy} className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
                <X size={16} />
              </Dialog.Close>
            </div>
            <div className="mt-5 grid grid-cols-[72px_1fr] gap-3">
              <label className="text-12 font-medium text-[var(--text-primary)]">
                {t('bots.groups.avatarLabel')}
                <input
                  value={editAvatar}
                  onChange={(event) => setEditAvatar(event.target.value)}
                  maxLength={16}
                  className="mt-2 h-10 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-2 text-center text-18 text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
                />
              </label>
              <label className="text-12 font-medium text-[var(--text-primary)]">
                {t('bots.groups.nameLabel')}
                <input
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  maxLength={120}
                  className="mt-2 h-10 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 text-13 text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
                />
              </label>
            </div>
            {manageError ? (
              <p className="mt-3 rounded-lg bg-[var(--status-danger-soft-bg)] px-3 py-2 text-12 text-[var(--text-danger)]">
                {manageError}
              </p>
            ) : null}
            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => void archiveRoom()}
                disabled={manageBusy || room.status === 'archived'}
                className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-12 text-[var(--text-danger)] hover:bg-[var(--status-danger-soft-bg)] disabled:opacity-45"
              >
                <Archive size={14} />
                {t('bots.groups.archive')}
              </button>
              <div className="flex gap-2">
                <Dialog.Close disabled={manageBusy} className="h-9 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-45">
                  {t('bots.cancel')}
                </Dialog.Close>
                <button
                  type="button"
                  onClick={() => void saveIdentity()}
                  disabled={manageBusy || !editName.trim() || !editAvatar.trim() || room.status !== 'active'}
                  className="h-9 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-45"
                >
                  {manageBusy ? t('bots.autosave.saving') : t('bots.save')}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
