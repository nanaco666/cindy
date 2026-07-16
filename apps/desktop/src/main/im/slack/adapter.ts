/**
 * main/im/slack/adapter.ts
 * ---------------------------------------------------------------------------
 * Slack 渠道的 ImChannelAdapter — 渠道差异收敛:
 *   - session 行策略: id `slack_{teamId}_{slackUserId}` / source='slack' /
 *     IM 通用列(imBotContextId/imUserId)/ im-working-dir/slack-{teamId}
 *   - vendorOptions: { slackChatId, source:'slack' } → 注入 lizi_slack_bot
 *     MCP (send_file_to_user)
 *   - ack emoji: 'eyes'(👀 — Slack 语境里"看到了"的惯用回应)
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { SlackIM } from 'lizi-im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ui, PROCESSING_EMOJI } from './uiText';

/**
 * slack bot 的 workingDir = `userData/im-working-dir/slack-{teamId}/`
 * 同 workspace 下所有 slack session 共享(与 feishu 的 per-botAppId 共享目录
 * 同语义);`slack-` 前缀避免与 feishu botAppId 目录名理论撞名。
 */
function ensureWorkingDir(teamId: string): string {
  const dir = path.join(app.getPath('userData'), 'im-working-dir', `slack-${teamId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildSlackAdapter(
  slackIm: SlackIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'slack',
    im: slackIm,
    config,
    ui,
    // thread = session 模型: 每个 thread(scopeKey = root ts)一个独立 session,
    // 多 thread 并行、/ctr 多重接管。
    threadScoped: true,
    sessions: {
      source: 'slack',
      /**
       * 确定性 id `slack_{teamId}_{slackUserId}_{rootTs}` — 跨重启稳定,
       * thread 回复续上同一会话。rootTs 的 '.' 换 '_': sessionId 会进文件路径
       * (imageCacheStore/logger)并作为 xdt-image:// 的 URL host, 纯数字 + '_'
       * 无歧义。scopeKey 缺省(理论上 threadScoped 渠道不会发生)退回旧格式。
       */
      sessionIdFor: (teamId, slackUserId, scopeKey) =>
        scopeKey
          ? `slack_${teamId}_${slackUserId}_${scopeKey.replace(/\./g, '_')}`
          : `slack_${teamId}_${slackUserId}`,
      defaultTitle: (slackUserId) => `Slack · ${slackUserId.slice(-6)}`,
      // 首条消息 oneshot 起名后的正式标题前缀(thread 名片卡 + sidebar 同款)
      generatedTitlePrefix: 'Slack · ',
      ensureWorkingDir,
      extraInsertColumns: (teamId, slackUserId) => ({
        imBotContextId: teamId,
        imUserId: slackUserId,
      }),
    },
    processingEmoji: PROCESSING_EMOJI,
    buildVendorOptions: (slackUserId, scopeKey) => ({
      slackChatId: slackUserId,
      // send_file_to_user 等 MCP 出站按此定位 thread(organic session 专属;
      // attached session vendorOptions 恒 undefined, 不经这里)
      ...(scopeKey ? { slackThreadTs: scopeKey } : {}),
      source: 'slack',
    }),
  };
}
