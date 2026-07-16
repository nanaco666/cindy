export const SESSION_SOURCES = [
  'desktop',
  'feishu',
  'slack',
  'discord',
  'scheduler',
  'learn',
  'shared',
] as const;

export type SessionSource = (typeof SESSION_SOURCES)[number];

// desktop sidebar 展示的会话 source 白名单。
// slack: IM 渠道自动建的会话——用户在 Slack 发消息后 desktop 同步可见。
// discord: IM 渠道自动建的会话——用户在 Discord 发消息后 desktop 同步可见。
// feishu 刻意排除——飞书会话由 bot 持有、用户在飞书端操作,不进 desktop sidebar
// (2026-07-06 曾短暂加入,按 Lizi 要求回退,只保留 slack)。
// scheduler / learn: 本机自动化会话,可见可点开看过程。
// shared: .xdtshare 导入的分享会话,按 workingDir 归组。
export const DESKTOP_VISIBLE_SESSION_SOURCES: SessionSource[] = [
  'desktop',
  'slack',
  'discord',
  'scheduler',
  'learn',
  'shared',
];

export function normalizeSessionSource(source: unknown): SessionSource {
  return source === 'feishu' ||
    source === 'slack' ||
    source === 'discord' ||
    source === 'scheduler' ||
    source === 'learn' ||
    source === 'shared'
    ? source
    : 'desktop';
}
