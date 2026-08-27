import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, MessageCircleMore, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { canonicalBotSessionId, useBotProfiles } from './botStore';
import { createBotGroupRoom, useBotGroupRooms } from './botGroupStore';
import { formatBotGroupDefaultName } from './botGroupChatPresentation';

export function BotGroupRoomsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rooms = useBotGroupRooms();
  const bots = useBotProfiles().filter(
    (bot) => bot.status === 'active' && Boolean(canonicalBotSessionId(bot)),
  );
  const createRequested = searchParams.get('create') === '1';
  const [open, setOpen] = useState(createRequested);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = selected.length >= 2 && selected.length <= 6 && !creating;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    if (createRequested || rooms.length === 0) return;
    const recent = rooms.reduce((latest, room) =>
      room.updatedAt > latest.updatedAt ? room : latest,
    );
    navigate(`/bots/groups/${recent.id}`, { replace: true });
  }, [createRequested, navigate, rooms]);

  useEffect(() => {
    if (createRequested) setOpen(true);
  }, [createRequested]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next && createRequested) {
      setSearchParams({}, { replace: true });
    }
  };

  const toggle = (botId: string) => {
    setSelected((current) =>
      current.includes(botId)
        ? current.filter((id) => id !== botId)
        : current.length < 6
          ? [...current, botId]
          : current,
    );
  };

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const room = await createBotGroupRoom({
        name: name.trim() || formatBotGroupDefaultName(
          selected.map((id) => bots.find((bot) => bot.id === id)?.name ?? ''),
        ),
        memberBotIds: selected,
      });
      setOpen(false);
      setName('');
      setSelected([]);
      navigate(`/bots/groups/${room.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-[var(--surface)] px-6 py-8">
      <div className="mx-auto w-full max-w-4xl">
        {rooms.length === 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-8 flex w-full flex-col items-center rounded-xl border border-dashed border-[var(--border-default)] px-6 py-12 text-center hover:bg-[var(--surface-hover)]"
          >
            <MessageCircleMore size={28} className="text-[var(--text-tertiary)]" />
            <span className="mt-3 text-15 font-medium text-[var(--text-primary)]">
              {t('bots.groups.emptyTitle')}
            </span>
            <span className="mt-1 max-w-md text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.groups.emptyDescription')}
            </span>
          </button>
        ) : null}
      </div>

      <Dialog.Root open={open} onOpenChange={changeOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[82vh] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-16 font-semibold text-[var(--text-primary)]">
                  {t('bots.groups.createTitle')}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                  {t('bots.groups.createDescription')}
                </Dialog.Description>
              </div>
              <Dialog.Close className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]">
                <X size={16} />
              </Dialog.Close>
            </div>

            <label className="mt-5 block text-12 font-medium text-[var(--text-primary)]">
              {t('bots.groups.nameLabel')}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('bots.groups.namePlaceholder')}
                className="mt-2 h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 text-13 text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
              />
            </label>

            <div className="mt-5 text-12 font-medium text-[var(--text-primary)]">
              {t('bots.groups.membersLabel', { count: selected.length })}
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {bots.map((bot) => {
                const checked = selectedSet.has(bot.id);
                return (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => toggle(bot.id)}
                    className={cn(
                      'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left',
                      checked
                        ? 'border-[var(--accent-cta-bg)] bg-[var(--surface-selected)]'
                        : 'border-transparent hover:bg-[var(--surface-hover)]',
                    )}
                  >
                    <BotAvatar bot={bot} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
                        {bot.name}
                      </span>
                      <span className="block truncate text-11 text-[var(--text-tertiary)]">
                        {bot.description || t('bots.noDescription')}
                      </span>
                    </span>
                    <span className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full border',
                      checked
                        ? 'border-[var(--accent-cta-bg)] bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]'
                        : 'border-[var(--border-default)]',
                    )}>
                      {checked ? <Check size={13} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {bots.length < 2 ? (
              <p className="mt-3 text-12 text-[var(--text-danger)]">
                {t('bots.groups.needBots')}
              </p>
            ) : null}
            {error ? (
              <p className="mt-3 break-words text-12 text-[var(--text-danger)]">{error}</p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="h-9 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                {t('bots.cancel')}
              </Dialog.Close>
              <button
                type="button"
                disabled={!canCreate}
                onClick={() => void create()}
                className="h-9 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-40"
              >
                {creating ? t('bots.groups.creating') : t('bots.groups.create')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
