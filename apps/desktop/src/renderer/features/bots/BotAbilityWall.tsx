import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';

import {
  applyImMutualExclusion,
  botChannelDisplayName,
  buildBotChannelChips,
} from './botChannelChips';
import type { BotChannelConnection } from './botStore';

/**
 * 只展示运行时实际返回的账号连接。不存在的能力和未配置的渠道不在前端补占位。
 */
export function BotAbilityWall({
  connections,
  isChannelMounted,
  channelBusyId,
  onToggleChannel,
}: {
  connections: readonly BotChannelConnection[];
  isChannelMounted: (connection: BotChannelConnection) => boolean;
  channelBusyId: string | null;
  onToggleChannel: (connection: BotChannelConnection) => void;
}) {
  const { t } = useBotTranslation();
  const chips = applyImMutualExclusion(buildBotChannelChips(connections, isChannelMounted));
  if (chips.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-tertiary)]">
        {t('bots.abilityWall.empty')}
      </p>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {chips.map((chip) => {
        const channelName = botChannelDisplayName(chip.kind);
        const label = chip.accountLabel ? `${channelName} · ${chip.accountLabel}` : channelName;
        const blocked = Boolean(chip.blockedByImKind);
        /*
          「先断开 X」只对原本可连接、但被 IM 互斥阻断的账号有意义。
          不可路由的账号即使断开 X 仍无法连接，不应给出无效补救提示。
        */
        const blockedHint =
          blocked && !chip.disabled && chip.blockedByImKind
            ? t('bots.abilityWall.imBlocked', {
                channel: botChannelDisplayName(chip.blockedByImKind),
              })
            : null;
        return (
          <div
            key={chip.id}
            className={cn(
              'flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3 py-2',
              (chip.disabled || blocked) && 'opacity-60',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-primary)]">
              {label}
            </span>
            <button
              type="button"
              title={blockedHint ?? undefined}
              disabled={chip.disabled || blocked || channelBusyId !== null}
              onClick={() => {
                onToggleChannel(chip.connection);
              }}
              className="h-7 shrink-0 rounded-full border border-[var(--border-default)] px-2.5 text-10 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:opacity-70"
            >
              {channelBusyId === chip.connection.id
                ? '…'
                : chip.mounted
                  ? t('bots.channelDisconnect')
                  : t('bots.channelConnect')}
            </button>
          </div>
        );
      })}
    </div>
  );
}
