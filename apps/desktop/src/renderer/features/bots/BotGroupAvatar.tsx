import { cn } from '@/lib/utils';
import {
  botAvatarArtworkSrc,
  botAvatarHueToken,
  botAvatarInitial,
  isCindyAvatarSentinel,
} from './BotAvatar';

interface BotGroupAvatarMember {
  id?: string;
  name: string;
  avatar?: string | null;
  avatarColor?: string | null;
}

interface BotGroupAvatarProps {
  members: BotGroupAvatarMember[];
  className?: string;
}

/**
 * Group identity mark: the same 40px round footprint as a regular sidebar Bot,
 * with up to four member portraits composed inside the circle.
 */
export function BotGroupAvatar({ members, className }: BotGroupAvatarProps) {
  const visibleMembers = members.slice(0, 4);
  const memberCount = visibleMembers.length;

  return (
    <span
      aria-hidden
      data-testid="bot-group-avatar"
      data-member-count={memberCount}
      className={cn(
        'grid h-10 w-10 shrink-0 select-none overflow-hidden rounded-full bg-[var(--border-default)]',
        memberCount === 1 && 'grid-cols-1',
        memberCount === 2 && 'grid-cols-2 gap-px',
        memberCount >= 3 && 'grid-cols-2 grid-rows-2 gap-px',
        className,
      )}
    >
      {visibleMembers.map((member, index) => {
        const emoji = (member.avatar ?? '').trim();
        const artwork = botAvatarArtworkSrc(emoji);
        const glyph = artwork || isCindyAvatarSentinel(emoji) ? '' : emoji;
        return (
          <span
            key={`${member.id ?? member.name}:${index}`}
            data-testid="bot-group-avatar-member"
            className={cn(
              'flex min-h-0 min-w-0 items-center justify-center overflow-hidden leading-none',
              memberCount === 3 && index === 0 && 'row-span-2',
              memberCount <= 2 ? 'text-12' : 'text-10',
            )}
            style={{ backgroundColor: botAvatarHueToken(member.avatarColor) }}
          >
            {artwork ? (
              <img
                src={artwork}
                alt=""
                draggable={false}
                className="pointer-events-none h-full w-full select-none object-cover"
              />
            ) : glyph ? (
              <span>{glyph}</span>
            ) : (
              <span className="font-medium text-[var(--text-primary)]">
                {botAvatarInitial(member.name)}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
