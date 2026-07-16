import type { MobileSlashCommand } from '@/device-link/mobileMakerTransport';
import type { InputProjection, RemoteSession } from '@/session/types';
import {
  DEFAULT_LOCAL_SYSTEM_COMMANDS,
  buildSystemCardData,
  formatSystemCard,
  mergeLocalSlashCommands,
  parseLocalSystemCommand,
  type SystemCardPresentation,
  type SystemCardType,
} from '@lizi/maker-shared/system-card';

/**
 * 手机端系统卡类型 = 共享 slash 命令卡 + goal 持久记录卡 + silent-stop 自动续跑卡。
 * goal 两种不来自 slash 命令(桌面 goal-host 落库 agentMeta.goalCompletion /
 * goalNotice,读侧派生),shared 的 formatSystemCard 不认识它们,由本模块特判
 * 格式化。历史上手机端不认这两种卡,/goal 达成与用量恢复记录被渲染成空白
 * assistant 气泡(2026-07 排查发现)。auto-resume 同为读侧派生(user 行
 * agentMeta.autoResume,桌面 silent-stop 守卫落库),历史上被手机渲染成一条
 * 用户没发过的「继续」气泡(2026-07 排查发现)。
 */
export type MobileSystemCardType = SystemCardType | 'goal-complete' | 'goal-resumed' | 'auto-resume';
export type MobileSystemCardPresentation = SystemCardPresentation;

/** goal 达成记录文案(对齐桌面 GoalCompleteCard 的 goal.complete.record)。 */
function formatGoalCompleteCard(data: Record<string, unknown> | undefined): SystemCardPresentation {
  const turns = typeof data?.turnsUsed === 'number' ? data.turnsUsed : 0;
  const elapsedMs = typeof data?.elapsedMs === 'number' ? data.elapsedMs : 0;
  const reason = typeof data?.reason === 'string' ? data.reason : '';
  return {
    title: `目标已达成 · ${turns} 轮 · 耗时 ${formatGoalDuration(elapsedMs)}`,
    ...(reason ? { body: reason } : {}),
    rows: [],
  };
}

function formatGoalDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export const MOBILE_LOCAL_SYSTEM_COMMANDS = DEFAULT_LOCAL_SYSTEM_COMMANDS as MobileSlashCommand[];

export function parseMobileLocalSystemCommand(text: string): MobileSystemCardType | null {
  return parseLocalSystemCommand(text, MOBILE_LOCAL_SYSTEM_COMMANDS);
}

export function mergeMobileLocalSlashCommands(
  remoteCommands: readonly MobileSlashCommand[],
): MobileSlashCommand[] {
  return mergeLocalSlashCommands(remoteCommands, MOBILE_LOCAL_SYSTEM_COMMANDS) as MobileSlashCommand[];
}

export function buildMobileSystemCardData(
  type: MobileSystemCardType,
  options: {
    contextUsage?: unknown;
    contextError?: string;
    projection?: InputProjection;
    remoteCommands?: readonly MobileSlashCommand[];
    session: RemoteSession | null;
  },
): Record<string, unknown> {
  // goal / auto-resume 卡的数据由桌面落库的 agentMeta 派生,不走本地 slash 命令的数据组装。
  if (type === 'goal-complete' || type === 'goal-resumed' || type === 'auto-resume') return {};
  return buildSystemCardData(type, {
    ...options,
    localCommands: MOBILE_LOCAL_SYSTEM_COMMANDS,
    remoteCommands: options.remoteCommands,
  });
}

export function formatMobileSystemCard(
  type: MobileSystemCardType,
  data: Record<string, unknown> | undefined,
): MobileSystemCardPresentation {
  if (type === 'goal-complete') return formatGoalCompleteCard(data);
  if (type === 'goal-resumed') return { title: '用量已恢复，继续目标', rows: [] };
  if (type === 'auto-resume') return { title: '连接中断，已自动继续', rows: [] };
  return formatSystemCard(type, data);
}
