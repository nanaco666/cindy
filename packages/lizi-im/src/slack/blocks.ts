/**
 * slack/blocks.ts
 * ---------------------------------------------------------------------------
 * InteractiveCardSpec → Slack Block Kit 映射 + messageId 编解码。
 *
 * messageId codec: Slack 消息由 (channel, ts) 二元组定位, lizi-im 的
 * StreamingTextHandle / 卡片 API 只有单个 messageId 字符串 — 编码成
 * `${channelId}|${ts}`(channel id 不含 '|')。
 *
 * 按钮映射:
 *   - action_id = `${button.id}#${序号}` — Slack 要求 action_id 在消息内唯一,
 *     而我们的 buttonId 会重复(如 /model picker 每行都是 'model:pick');
 *     回流时 decodeActionId 剥掉 `#n` 后缀还原 buttonId
 *   - value = JSON.stringify(payload)(Slack 上限 2000 字符 — 我们的 payload
 *     都是短结构, cardBuilders 不放长文本进 payload)
 *   - 每个 actions block 最多 5 个按钮(Slack 限制), 超出自动分块
 */

import type { InteractiveCardSpec } from '../types.js';

export function encodeMessageId(channelId: string, ts: string): string {
  return `${channelId}|${ts}`;
}

export function decodeMessageId(messageId: string): { channelId: string; ts: string } {
  const idx = messageId.indexOf('|');
  if (idx <= 0) throw new Error(`invalid slack messageId: ${messageId}`);
  return { channelId: messageId.slice(0, idx), ts: messageId.slice(idx + 1) };
}

export function encodeActionId(buttonId: string, index: number): string {
  return `${buttonId}#${index}`;
}

/** `model:pick#3` → `model:pick`;无后缀(防御)原样返回。 */
export function decodeActionId(actionId: string): string {
  const idx = actionId.lastIndexOf('#');
  if (idx < 0) return actionId;
  return /^\d+$/.test(actionId.slice(idx + 1)) ? actionId.slice(0, idx) : actionId;
}

/** Slack section text 上限 3000 字符 — 长 body 切多个 section。 */
const SECTION_MAX = 3000;
const BUTTONS_PER_BLOCK = 5;

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * InteractiveCardSpec → blocks。`bodyMrkdwn` 由 caller 先过 markdownToMrkdwn
 * (blocks 层不做文本转换, 保持单一职责)。
 */
export function buildCardBlocks(
  spec: InteractiveCardSpec,
  bodyMrkdwn: string,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  if (spec.title) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: spec.title.slice(0, 150), emoji: true },
    });
  }

  const body = bodyMrkdwn.length > 0 ? bodyMrkdwn : ' ';
  for (let i = 0; i < body.length; i += SECTION_MAX) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: body.slice(i, i + SECTION_MAX) },
    });
  }

  for (let i = 0; i < spec.buttons.length; i += BUTTONS_PER_BLOCK) {
    const chunk = spec.buttons.slice(i, i + BUTTONS_PER_BLOCK);
    blocks.push({
      type: 'actions',
      elements: chunk.map((btn, j) => ({
        type: 'button',
        action_id: encodeActionId(btn.id, i + j),
        text: { type: 'plain_text', text: btn.label.slice(0, 75), emoji: true },
        value: JSON.stringify(btn.payload ?? {}),
        ...(btn.type === 'primary'
          ? { style: 'primary' }
          : btn.type === 'danger'
            ? { style: 'danger' }
            : {}),
      })),
    });
  }

  return blocks;
}

/** 纯 mrkdwn 文本消息的 blocks(sendMarkdownText / patchMarkdownCard 用)。 */
export function buildMrkdwnBlocks(mrkdwn: string): SlackBlock[] {
  const body = mrkdwn.length > 0 ? mrkdwn : ' ';
  const blocks: SlackBlock[] = [];
  for (let i = 0; i < body.length; i += SECTION_MAX) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: body.slice(i, i + SECTION_MAX) },
    });
  }
  return blocks;
}
