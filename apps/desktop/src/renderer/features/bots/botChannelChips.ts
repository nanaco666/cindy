/**
 * Chip descriptors for the concrete channel accounts returned by the runtime.
 *
 * Kept separate from the JSX so the channel-chip derivation (which accounts are
 * mountable, which kinds have no account at all) is unit-testable without
 * mounting the settings tree.
 */
import type { BotChannel, BotChannelConnection } from './botStore';

const IM_CHANNEL_KINDS = new Set<BotChannel>([
  'telegram',
  'feishu',
  'slack',
  'discord',
  'wechat',
  'dingtalk',
  'wecom',
]);

export interface BotChannelChip {
  /** Stable React key; connection id when an account exists. */
  id: string;
  kind: BotChannel;
  connection: BotChannelConnection;
  /** Display suffix for the chip title (account name / key). */
  accountLabel: string | null;
  mounted: boolean;
  /** A chip the user cannot flip right now: no account, or a non-routable one. */
  disabled: boolean;
  /**
   * Set by `applyImMutualExclusion` when a *different* channel is already
   * mounted: the chip is greyed out and the UI should explain "disconnect
   * that one first". `null` for chips that are not IM-gated (already mounted,
   * a non-IM kind, or the one IM kind that is currently connected).
   */
  blockedByImKind?: BotChannel | null;
}

/**
 * One chip per concrete account. Missing channel kinds are intentionally absent.
 */
export function buildBotChannelChips(
  connections: readonly BotChannelConnection[],
  isMounted: (connection: BotChannelConnection) => boolean,
): BotChannelChip[] {
  return connections
    .map((connection) => ({
      id: connection.id,
      kind: connection.kind,
      connection,
      accountLabel: connection.accountName || connection.accountKey || null,
      mounted: isMounted(connection),
      disabled: !connection.routable,
    }))
    .sort(
      (a, b) =>
        Number(b.mounted) - Number(a.mounted) ||
        a.kind.localeCompare(b.kind) ||
        (a.accountLabel ?? '').localeCompare(b.accountLabel ?? ''),
    );
}

/** Human channel name for chip titles; matches the Channels tab labeling. */
export function botChannelDisplayName(kind: BotChannel): string {
  return kind === 'local' ? 'Local' : kind[0].toUpperCase() + kind.slice(1);
}

/**
 * Single-channel mutual exclusion (UI-only gate; the engine still allows any mount).
 *
 * Product ruling: a teammate only ever has one *live* IM identity. Once any
 * IM-class channel is mounted, every other IM row greys out until that one is
 * disconnected. A row that is itself mounted is never blocked — the user can
 * always disconnect it — which also keeps pre-existing multi-IM bots (created
 * before this rule) showing every one of their real connections honestly,
 * each individually disconnectable, with no forced tear-apart.
 */
export function applyImMutualExclusion(chips: readonly BotChannelChip[]): BotChannelChip[] {
  const blockingKind = chips.find((chip) => chip.mounted && IM_CHANNEL_KINDS.has(chip.kind))?.kind;
  return chips.map((chip) => {
    if (
      !blockingKind ||
      !IM_CHANNEL_KINDS.has(chip.kind) ||
      chip.mounted ||
      chip.kind === blockingKind
    ) {
      return { ...chip, blockedByImKind: null };
    }
    return { ...chip, blockedByImKind: blockingKind };
  });
}
