import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

export type CopyMessageStatus = 'copied' | 'empty' | 'failed';

export type MobileMessageControlActionId = 'copy' | 'rewind' | 'fork';

export interface MobileMessageControlInput {
  canCopy: boolean;
  canFork: boolean;
  canRewind: boolean;
  isStreaming: boolean;
}

type ClipboardNavigator = {
  clipboard?: {
    writeText?: (text: string) => Promise<void>;
  };
};

export function buildMobileMessageCopyText(message: NormalizedRemoteMessage): string {
  const parts = [message.body];
  if (message.secondaryBody) parts.push(message.secondaryBody);
  const attachments = message.attachments?.map((item) => item.name).filter(Boolean) ?? [];
  if (attachments.length > 0) {
    parts.push(`附件：${attachments.join(', ')}`);
  }
  return parts.filter((part) => part.trim().length > 0).join('\n\n');
}

export function buildMobileMessageControlItems(
  input: MobileMessageControlInput,
): MobileMessageControlActionId[] {
  if (input.isStreaming) return [];
  const items: MobileMessageControlActionId[] = [];
  if (input.canCopy) items.push('copy');
  if (input.canRewind) items.push('rewind');
  if (input.canFork) items.push('fork');
  return items;
}

export async function copyMessageText(
  text: string,
  write: (value: string) => Promise<void> = writeClipboardText,
): Promise<CopyMessageStatus> {
  if (!text.trim()) return 'empty';
  try {
    await write(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  let nativeError: unknown;
  try {
    const clipboard = await import('expo-clipboard');
    if (typeof clipboard.setStringAsync === 'function') {
      await clipboard.setStringAsync(text);
      return;
    }
  } catch (err) {
    nativeError = err;
  }

  const nav = globalThis.navigator as ClipboardNavigator | undefined;
  if (typeof nav?.clipboard?.writeText === 'function') {
    await nav.clipboard.writeText(text);
    return;
  }

  throw nativeError instanceof Error ? nativeError : new Error('Clipboard is unavailable');
}

export function formatMessageRelativeTime(createdAt: string, now = Date.now()): string {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const diffMs = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return '刚刚';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;

  const date = new Date(timestamp);
  const current = new Date(now);
  const prefix = date.getFullYear() === current.getFullYear()
    ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${prefix} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatMessageAbsoluteTime(createdAt: string): string {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ');
}

export function formatMessageTurnCostUsd(costUsd: number, isEstimate = false): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return '';
  const value = formatTurnCostUsd(costUsd);
  return isEstimate ? `价值 ${value}` : value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTurnCostUsd(value: number): string {
  if (value >= 10) return formatCompactUsd(value);
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value >= 0.001) return `$${value.toFixed(3)}`;
  return '<$0.001';
}

function formatCompactUsd(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}
