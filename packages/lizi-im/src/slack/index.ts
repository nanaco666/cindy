/**
 * slack/index.ts
 * ---------------------------------------------------------------------------
 * SlackIM — ChannelIM 的 Slack 实现(共享 App / server 中继模式)。
 *
 * 与 FeishuIM 的关键差异:
 *   - 不直连 Slack: 入站走 server SSE(SlackRelayTransport.subscribe), 出站走
 *     server /proxy /upload(bot token 仅 server 持有)
 *   - 身份不是 TOFU: server 端 SlackUserLink 是权威, hello 事件下发
 *     (teamId / slackUserId / dmChannelId / botUserId)
 *   - p2p 单用户: 所有出站消息都发到自己的 dmChannelId(ChannelIM 的 userId
 *     入参用于契约一致性, 实际路由按 DM channel)
 *   - messageId = `${channelId}|${ts}`(blocks.ts codec)
 *   - reaction token = emoji 名(Slack 撤回应按 channel+ts+name, 无 reaction_id)
 */

import fs from 'node:fs';
import path from 'node:path';

import { BaseIM } from '../BaseIM.js';
import type { ChannelIM } from '../channelIM.js';
import type {
  IMHost,
  IMAttachment,
  IMCardActionEvent,
  IMMessageEvent,
  IMStatus,
  IMUnsupportedEntry,
  InteractiveCardSpec,
  SendFileResult,
  StreamingTextHandle,
} from '../types.js';
import { markdownToMrkdwn } from './mrkdwn.js';
import {
  buildCardBlocks,
  buildMrkdwnBlocks,
  decodeActionId,
  decodeMessageId,
  encodeMessageId,
} from './blocks.js';
import { startStreaming } from './streamingText.js';
import type {
  SlackLinkStatus,
  SlackRelayInboundEvent,
  SlackRelayStatus,
  SlackRelayTransport,
} from './transport.js';

export type {
  SlackRelayTransport,
  SlackRelayInboundEvent,
  SlackRelayStatus,
  SlackLinkStatus,
  SlackProxyMethod,
} from './transport.js';

/** 入站附件大小上限 — 与飞书侧策略对齐(超限不下载, 进 unsupported)。 */
const MAX_INBOUND_FILE_BYTES = 50 * 1024 * 1024;

export interface SlackIMOptions {
  /**
   * xdt-image:// URL → 本地 absPath 的解析器(desktop 注入 imageCacheStore
   * 的 resolveSafe)。未注入时流式 finalize 跳过文内图片(仅 warn)。
   */
  resolveImageUrl?: (url: string) => string;
}

type MessageHandler = (e: IMMessageEvent) => void;
type CardActionHandler = (e: IMCardActionEvent) => void;
type StatusHandler = (s: IMStatus) => void;

export class SlackIM extends BaseIM implements ChannelIM {
  private readonly transport: SlackRelayTransport;
  private readonly opts: SlackIMOptions;

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly cardActionHandlers = new Set<CardActionHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();

  private unsubscribe: (() => void) | null = null;
  private status: IMStatus = { kind: 'idle' };

  // hello 事件下发的身份(server SlackUserLink 为权威)
  private teamId = '';
  private slackUserId = '';
  private dmChannelId: string | null = null;
  private botUserId = '';
  private slackName: string | null = null;

  constructor(host: IMHost, transport: SlackRelayTransport, opts: SlackIMOptions = {}) {
    super('slack', host);
    this.transport = transport;
    this.opts = opts;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.log.info('init starting');
    // 先查一次绑定状态 — 未绑定也照常订阅(绑定完成后 server 会在下次重连的
    // hello 里带上身份;desktop 设置页绑定后会触发 SSE 重连)。
    try {
      const link = await this.transport.getLinkStatus();
      if (link.linked) {
        this.teamId = link.teamId ?? '';
        this.slackUserId = link.slackUserId ?? '';
        this.dmChannelId = link.dmChannelId ?? null;
        this.slackName = link.slackName ?? null;
      }
      this.log.info(`link status: linked=${link.linked}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`getLinkStatus failed (will rely on hello): ${msg}`);
    }

    this.setStatus({ kind: 'connecting' });
    this.unsubscribe = this.transport.subscribe({
      onEvent: (e) => this.handleRelayEvent(e),
      onStatus: (s, detail) => this.handleRelayStatus(s, detail),
    });
  }

  async dispose(): Promise<void> {
    this.log.info('dispose');
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setStatus({ kind: 'idle' });
  }

  registerIpc(): void {
    // renderer 设置页的绑定操作(oauth / link / unlink)直接走通用
    // api:request 通道打 server, 不经 lizi-im;这里只暴露 transport 状态。
    this.host.ipc.handle('slackBot:get-status', () => ({
      status: this.status,
      linked: !!this.slackUserId,
      teamId: this.teamId || null,
      slackUserId: this.slackUserId || null,
      slackName: this.slackName,
    }));
  }

  // ── inbound subscriptions ───────────────────────────────────────────────────

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onCardAction(handler: CardActionHandler): () => void {
    this.cardActionHandlers.add(handler);
    return () => this.cardActionHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  // ── relay event handling ────────────────────────────────────────────────────

  private setStatus(s: IMStatus): void {
    this.status = s;
    this.host.ipc.broadcast('slackBot:status-change', {
      status: s,
      linked: !!this.slackUserId,
      slackName: this.slackName,
    });
    for (const h of this.statusHandlers) {
      try {
        h(s);
      } catch {
        /* swallow */
      }
    }
  }

  private handleRelayStatus(s: SlackRelayStatus, detail?: string): void {
    if (s === 'connected') {
      // hello 还没到时先报 connecting;hello 到达后报 connected(带身份)
      return;
    }
    if (s === 'connecting') this.setStatus({ kind: 'connecting' });
    else if (s === 'replaced') this.setStatus({ kind: 'conflict', appId: this.teamId });
    else if (s === 'error') this.setStatus({ kind: 'error', reason: detail ?? 'relay error' });
    else if (s === 'closed') this.setStatus({ kind: 'idle' });
  }

  private handleRelayEvent(e: SlackRelayInboundEvent): void {
    switch (e.kind) {
      case 'hello':
        this.teamId = e.teamId;
        this.slackUserId = e.slackUserId;
        this.dmChannelId = e.dmChannelId;
        this.botUserId = e.botUserId;
        this.slackName = e.slackName;
        this.setStatus({ kind: 'connected', appId: e.teamId });
        this.log.info(
          `hello: team=${e.teamId} user=...${e.slackUserId.slice(-6)} dm=${e.dmChannelId ?? '<none>'} bot=${this.botUserId}`,
        );
        return;
      case 'unlinked':
        this.slackUserId = '';
        this.dmChannelId = null;
        this.setStatus({ kind: 'connected', appId: this.teamId });
        this.log.info('hello: not linked yet');
        return;
      case 'replaced':
        this.setStatus({ kind: 'conflict', appId: this.teamId });
        return;
      case 'message':
        void this.handleInboundMessage(e);
        return;
      case 'card_action':
        this.handleInboundCardAction(e);
        return;
    }
  }

  private async handleInboundMessage(
    e: Extract<SlackRelayInboundEvent, { kind: 'message' }>,
  ): Promise<void> {
    // dmChannelId 滞后兜底 — 首条 DM 先于 hello 回填时从消息上学习
    if (!this.dmChannelId) this.dmChannelId = e.channelId;

    const attachments: IMAttachment[] = [];
    const unsupported: IMUnsupportedEntry[] = [];
    for (const f of e.files) {
      if (f.size > MAX_INBOUND_FILE_BYTES) {
        unsupported.push({ type: 'oversize', label: `${f.name} (超过 50MB)` });
        continue;
      }
      const destDir = this.host.paths.slackMediaDir;
      if (!destDir) {
        unsupported.push({ type: 'media-dir-missing', label: f.name });
        continue;
      }
      try {
        fs.mkdirSync(destDir, { recursive: true });
        // fileId 前缀防重名;保留原始扩展名便于 agent 识别类型
        const dest = path.join(destDir, `${f.id}_${sanitizeFilename(f.name)}`);
        const r = await this.transport.downloadFile(f.id, dest);
        if (!r.ok) {
          unsupported.push({ type: 'download-failed', label: f.name });
          continue;
        }
        const kind = f.mimetype.startsWith('image/') ? ('image' as const) : ('file' as const);
        let absPath = dest;
        let cindyUrl: string | undefined;
        // 图片提升进 host 媒体总仓(迁移第 3 步):transport 只会写文件,先落
        // 老目录再读字节入仓、删临时副本;失败回落老路径(附件不能丢)。
        const media = this.host.media;
        if (kind === 'image' && media) {
          try {
            const promoted = await media.cacheImage({
              integration: 'slack',
              token: f.id,
              buffer: fs.readFileSync(dest),
              mimeType: f.mimetype.toLowerCase(),
            });
            absPath = promoted.absPath;
            cindyUrl = promoted.url;
            fs.rmSync(dest, { force: true });
          } catch {
            // host 仓拒收(白名单外 mime / DB 未就绪):保留老目录副本。
          }
        }
        attachments.push({
          kind,
          absPath,
          originalName: f.name,
          mimeType: f.mimetype,
          ...(cindyUrl ? { url: cindyUrl } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`attachment download failed for ${f.name}: ${msg}`);
        unsupported.push({ type: 'download-failed', label: f.name });
      }
    }

    const event: IMMessageEvent = {
      channelName: 'slack',
      senderId: this.slackUserId,
      chatId: e.channelId,
      contextId: this.teamId,
      messageId: encodeMessageId(e.channelId, e.ts),
      text: e.text,
      attachments,
      unsupported,
      // thread = session 模型: 顶层消息 scopeKey = 自身 ts(即新 thread root),
      // thread 回复 scopeKey = root ts — shared 层按 scopeKey 路由会话
      threadTs: e.threadTs,
      scopeKey: e.threadTs ?? e.ts,
    };
    for (const h of this.messageHandlers) {
      try {
        h(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`message handler threw: ${msg}`);
      }
    }
  }

  private handleInboundCardAction(
    e: Extract<SlackRelayInboundEvent, { kind: 'card_action' }>,
  ): void {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(e.value || '{}');
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      this.log.warn(`card_action value is not JSON: ${e.value.slice(0, 80)}`);
    }
    const event: IMCardActionEvent = {
      channelName: 'slack',
      senderId: this.slackUserId,
      chatId: e.channelId,
      messageId: encodeMessageId(e.channelId, e.messageTs),
      buttonId: decodeActionId(e.actionId),
      payload,
      // 顶层卡片(如接管 root 卡)无 thread_ts — scopeKey 回退卡片自身 ts,
      // 恰为该卡所开 thread 的 root, 退出接管按钮据此反查 binding
      threadTs: e.threadTs,
      scopeKey: e.threadTs ?? e.messageTs,
    };
    for (const h of this.cardActionHandlers) {
      try {
        h(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`card action handler threw: ${msg}`);
      }
    }
  }

  // ── outbound ────────────────────────────────────────────────────────────────

  /** 出站目标恒为自己的 DM channel;未知时经代理 conversations.open 现开。 */
  private async requireDmChannel(): Promise<string> {
    if (this.dmChannelId) return this.dmChannelId;
    if (!this.slackUserId) throw new Error('slack not linked');
    const r = await this.transport.call('conversations.open', { users: this.slackUserId });
    const channel = (r.data?.channel as { id?: string } | undefined)?.id;
    if (!r.ok || !channel) throw new Error(r.error ?? 'conversations.open failed');
    this.dmChannelId = channel;
    return channel;
  }

  async sendText(
    _userId: string,
    text: string,
    opts?: { threadTs?: string },
  ): Promise<{ messageId: string }> {
    const channel = await this.requireDmChannel();
    const r = await this.transport.call('chat.postMessage', {
      channel,
      text,
      ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
    if (!r.ok || !r.data?.ts) throw new Error(r.error ?? 'chat.postMessage failed');
    return { messageId: encodeMessageId(channel, String(r.data.ts)) };
  }

  async sendMarkdownText(
    _userId: string,
    markdown: string,
    opts?: { threadTs?: string },
  ): Promise<{ messageId: string }> {
    const channel = await this.requireDmChannel();
    const mrkdwn = markdownToMrkdwn(markdown);
    const r = await this.transport.call('chat.postMessage', {
      channel,
      text: mrkdwn,
      blocks: buildMrkdwnBlocks(mrkdwn),
      ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
    if (!r.ok || !r.data?.ts) throw new Error(r.error ?? 'chat.postMessage failed');
    return { messageId: encodeMessageId(channel, String(r.data.ts)) };
  }

  async sendInteractiveCard(
    _userId: string,
    spec: InteractiveCardSpec,
    opts?: { threadTs?: string },
  ): Promise<{ messageId: string }> {
    const channel = await this.requireDmChannel();
    const bodyMrkdwn = markdownToMrkdwn(spec.body);
    const r = await this.transport.call('chat.postMessage', {
      channel,
      text: spec.title ?? bodyMrkdwn.slice(0, 150),
      blocks: buildCardBlocks(spec, bodyMrkdwn),
      ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
    if (!r.ok || !r.data?.ts) throw new Error(r.error ?? 'chat.postMessage failed');
    return { messageId: encodeMessageId(channel, String(r.data.ts)) };
  }

  async updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void> {
    const { channelId, ts } = decodeMessageId(messageId);
    const bodyMrkdwn = markdownToMrkdwn(spec.body);
    const r = await this.transport.call('chat.update', {
      channel: channelId,
      ts,
      text: spec.title ?? bodyMrkdwn.slice(0, 150),
      blocks: buildCardBlocks(spec, bodyMrkdwn),
    });
    if (!r.ok) throw new Error(r.error ?? 'chat.update failed');
  }

  async patchMarkdownCard(messageId: string, markdown: string): Promise<void> {
    const { channelId, ts } = decodeMessageId(messageId);
    const mrkdwn = markdownToMrkdwn(markdown);
    const r = await this.transport.call('chat.update', {
      channel: channelId,
      ts,
      text: mrkdwn,
      blocks: buildMrkdwnBlocks(mrkdwn),
    });
    if (!r.ok) throw new Error(r.error ?? 'chat.update failed');
  }

  async startStreamingText(
    _userId: string,
    initial?: string,
    opts?: { threadTs?: string },
  ): Promise<StreamingTextHandle> {
    const channel = await this.requireDmChannel();
    return startStreaming(
      channel,
      {
        transport: this.transport,
        log: this.log,
        resolveImageUrl: (url) => {
          if (!this.opts.resolveImageUrl) {
            throw new Error('resolveImageUrl not configured');
          }
          return this.opts.resolveImageUrl(url);
        },
      },
      initial,
      opts?.threadTs,
    );
  }

  async sendFile(
    _userId: string,
    absPath: string,
    displayName?: string,
    opts?: { threadTs?: string },
  ): Promise<SendFileResult> {
    try {
      const stat = fs.statSync(absPath);
      if (stat.size === 0) return { ok: false, reason: 'EMPTY' };
      if (stat.size > MAX_INBOUND_FILE_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    } catch {
      return { ok: false, reason: 'NOT_FOUND' };
    }
    await this.requireDmChannel();
    const r = await this.transport.uploadFile({
      absPath,
      filename: path.basename(absPath),
      title: displayName,
      threadTs: opts?.threadTs,
    });
    if (!r.ok) return { ok: false, reason: 'UPLOAD_FAIL' };
    return { ok: true };
  }

  /** messageId(`channelId|ts`)→ thread root 键 = ts。 */
  threadKeyForMessage(messageId: string): string {
    return decodeMessageId(messageId).ts;
  }

  /** reaction token = emoji 名(Slack 按 channel+ts+name 撤, 无 reaction_id)。 */
  async reactToMessage(messageId: string, emoji: string): Promise<string | null> {
    try {
      const { channelId, ts } = decodeMessageId(messageId);
      const r = await this.transport.call('reactions.add', {
        channel: channelId,
        timestamp: ts,
        name: emoji,
      });
      return r.ok ? emoji : null;
    } catch {
      return null;
    }
  }

  async removeMessageReaction(messageId: string, reactionToken: string): Promise<void> {
    try {
      const { channelId, ts } = decodeMessageId(messageId);
      await this.transport.call('reactions.remove', {
        channel: channelId,
        timestamp: ts,
        name: reactionToken,
      });
    } catch {
      /* 清理是尽力而为 */
    }
  }

  // ── status ──────────────────────────────────────────────────────────────────

  getStatus(): IMStatus {
    return this.status;
  }

  getLinkedSlackUserId(): string | null {
    return this.slackUserId || null;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

export function createSlackIM(
  host: IMHost,
  transport: SlackRelayTransport,
  opts: SlackIMOptions = {},
): SlackIM {
  return new SlackIM(host, transport, opts);
}
