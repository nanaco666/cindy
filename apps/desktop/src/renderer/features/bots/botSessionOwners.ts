/**
 * sessionId → 它属于哪个伙伴。
 *
 * 会话行本身不带 botId(归属存在 `bot_session_links` 里),而侧栏分组要按伙伴分组,
 * 所以需要这样一张表。它从 botStore 已有的会话投影现拼 —— **不走新的 IPC、不给
 * 会话列表那条热路径加 join**:伙伴数量是个位数,投影本来就在内存里。
 *
 * 主对话、渠道任务、归档历史三种都算进来:用户要找"小柴昨天干的那件事",不会先
 * 想清楚那是主对话还是 Telegram 里的对话。
 */

import type { BotSessionOwner } from '@/features/cc-agent/lib/projectGrouping';
import type { BotProfile } from './botStore';

export function buildBotSessionOwners(
  profiles: readonly BotProfile[],
): Map<string, BotSessionOwner> {
  const map = new Map<string, BotSessionOwner>();
  for (const profile of profiles) {
    const owner: BotSessionOwner = {
      botId: profile.id,
      displayName: profile.name,
      avatar: profile.avatar,
      avatarColor: profile.avatarColor,
    };
    // canonicalSessionId 与 sessions[] 通常重合,但投影迟到时前者可能先到 ——
    // 两个都收,以先写入的为准(同一个伙伴,内容一样)。
    if (profile.canonicalSessionId) map.set(profile.canonicalSessionId, owner);
    for (const session of profile.sessions) {
      if (session.id) map.set(session.id, owner);
    }
  }
  return map;
}
