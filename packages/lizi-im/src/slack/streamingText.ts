/**
 * slack/streamingText.ts
 * ---------------------------------------------------------------------------
 * Slack 渠道的流式文本 handle(与 feishu/streamingText 同语义, 经 server
 * 代理实现):
 *
 *   start            → chat.postMessage 占位("思考中..."), 返回 handle
 *   append/replace   → 节流 chat.update(1300ms — chat.update 是 Tier 3
 *                      ~50/min/频道, 1 msg/s 通则;比 feishu 的 1.5s 略紧但
 *                      仍在安全水位)。中间帧 xdt-* 引用替换为占位文本。
 *   finalize         → xdt-image / tool_result 图片与 xdt-file 经 server
 *                      /upload 作为独立文件消息发出(Slack 无法把上传图片拼
 *                      进被编辑的文本消息 — 与 feishu mixed card 的差异),
 *                      正文剥掉 file 链接后最终 chat.update;超 3900 字符的
 *                      final 文本切块, 首块 update、其余 postMessage 续发。
 *   close            → 取消节流, 不再 patch。
 */

import path from 'node:path';

import type { Logger } from '../logger.js';
import type { StreamingTextHandle } from '../types.js';
import {
  stripXdtForStreaming,
  classifyXdtOnly,
  stripXdtFileLinks,
  collectXdtFileLinks,
  collectXdtImageUrls,
} from '../xdtRefs.js';
import { markdownToMrkdwn } from './mrkdwn.js';
import { buildMrkdwnBlocks, decodeMessageId, encodeMessageId } from './blocks.js';
import { streaming as streamingMessages } from './messages.js';
import type { SlackRelayTransport } from './transport.js';

const UPDATE_THROTTLE_MS = 1300;
/** Slack 单条消息保守长度上限(text 字段 4000, 留余量给 mrkdwn 转换膨胀)。 */
const MESSAGE_MAX = 3900;

interface Deps {
  transport: SlackRelayTransport;
  log: Logger;
  /** xdt-image:// URL → 本地 absPath 解析(host 注入;失败抛错)。 */
  resolveImageUrl: (url: string) => string;
}

function truncateForFrame(text: string): string {
  return text.length <= MESSAGE_MAX ? text : `${text.slice(0, MESSAGE_MAX - 2)}…`;
}

function splitChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MESSAGE_MAX) {
    chunks.push(text.slice(i, i + MESSAGE_MAX));
  }
  return chunks.length > 0 ? chunks : [''];
}

class SlackStreamingTextHandle implements StreamingTextHandle {
  readonly messageId: string;
  private readonly channelId: string;
  private readonly ts: string;
  /** thread root ts(thread=session 模型);文件/续块消息都发进该 thread。 */
  private readonly threadTs?: string;
  private readonly deps: Deps;
  private buffer = '';
  private flushed: string;
  private pending: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private finalized = false;
  /** tool_result 带来的图片 absPath(host 已解析), finalize 时作为文件发出。 */
  private extraImageAbsPaths: string[] = [];

  constructor(messageId: string, initial: string, deps: Deps, threadTs?: string) {
    this.messageId = messageId;
    const { channelId, ts } = decodeMessageId(messageId);
    this.channelId = channelId;
    this.ts = ts;
    this.threadTs = threadTs;
    this.flushed = initial;
    this.deps = deps;
  }

  append(delta: string): void {
    if (this.finalized) return;
    this.buffer += delta;
    this.scheduleFlush();
  }

  replace(fullText: string): void {
    if (this.finalized) return;
    this.buffer = fullText;
    this.scheduleFlush();
  }

  addExtraImageAbsPath(absPath: string): void {
    if (this.finalized || !absPath) return;
    if (this.extraImageAbsPaths.includes(absPath)) return;
    this.extraImageAbsPaths.push(absPath);
  }

  close(): void {
    this.finalized = true;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }

  private scheduleFlush(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.flushIntermediate();
    }, UPDATE_THROTTLE_MS);
  }

  private async update(text: string): Promise<void> {
    const mrkdwn = truncateForFrame(markdownToMrkdwn(text));
    const r = await this.deps.transport.call('chat.update', {
      channel: this.channelId,
      ts: this.ts,
      text: mrkdwn,
      blocks: buildMrkdwnBlocks(mrkdwn),
    });
    if (!r.ok) throw new Error(r.error ?? 'chat.update failed');
  }

  private async flushIntermediate(): Promise<void> {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }
    if (this.finalized) return;
    if (this.buffer === this.flushed) return;
    const klass = classifyXdtOnly(this.buffer);
    let text: string;
    if (klass === 'image-only') text = streamingMessages.preparingImage;
    else if (klass === 'file-only') text = streamingMessages.preparingFile;
    else text = stripXdtForStreaming(this.buffer);

    this.inFlight = (async () => {
      try {
        await this.update(text);
        this.flushed = this.buffer;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.log.warn(
          `[slack/streamingText] intermediate update failed (will retry): ${msg}`,
        );
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  async finalize(finalText: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }
    this.buffer = finalText;
    await this.doFinalize();
  }

  private async doFinalize(): Promise<void> {
    const { transport, log, resolveImageUrl } = this.deps;
    const text = this.buffer;

    // 1. 文本里的 xdt-image → 解析 absPath → 经 /upload 作为文件消息发出。
    //    Slack 的编辑消息无法内嵌新上传图片(无 feishu mixed card 等价物),
    //    图片一律走独立文件消息, 正文里的引用替换成提示。
    const imageUrls = collectXdtImageUrls(text);
    const sentImageCount = { n: 0 };
    // 正文图 absPath 集合:1b 用它对 extras 求差——同一张图既被模型 markdown
    // 内联进正文、又经 tool_result 账本 sidechannel 送来时(ghost 读文档
    // xdt_media_inline 内联场景),只传一份,不发两条重复文件消息。
    const bodyImageAbsPaths = new Set<string>();
    if (imageUrls.length > 0) {
      log.debug(`[slack/streamingText] uploading ${imageUrls.length} xdt-image(s)`);
      await Promise.all(
        imageUrls.map(async (url) => {
          let absPath: string;
          try {
            absPath = resolveImageUrl(url);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[slack/streamingText] resolve xdt-image failed for ${url}: ${msg}`);
            return;
          }
          bodyImageAbsPaths.add(absPath);
          const r = await transport.uploadFile({
            absPath,
            filename: path.basename(absPath),
            threadTs: this.threadTs,
          });
          if (r.ok) sentImageCount.n += 1;
          else log.warn(`[slack/streamingText] image upload failed: ${r.error}`);
        }),
      );
    }

    // 1b. tool_result 带来的图片 — 同一上传通道;正文里已内联的同图跳过。
    const extrasToUpload = this.extraImageAbsPaths.filter((p) => !bodyImageAbsPaths.has(p));
    if (extrasToUpload.length > 0) {
      log.debug(
        `[slack/streamingText] uploading ${extrasToUpload.length} extra image(s) from tool_result`,
      );
      await Promise.all(
        extrasToUpload.map(async (absPath) => {
          const r = await transport.uploadFile({
            absPath,
            filename: path.basename(absPath),
            threadTs: this.threadTs,
          });
          if (r.ok) sentImageCount.n += 1;
          else log.warn(`[slack/streamingText] extra image upload failed: ${r.error}`);
        }),
      );
    }

    // 2. xdt-file → 独立文件消息。
    const fileLinks = collectXdtFileLinks(text);
    if (fileLinks.length > 0) {
      log.debug(`[slack/streamingText] sending ${fileLinks.length} xdt-file(s)`);
      await Promise.all(
        fileLinks.map(async (link) => {
          const r = await transport.uploadFile({
            absPath: link.absPath,
            filename: path.basename(link.absPath),
            title: link.alt || undefined,
            threadTs: this.threadTs,
          });
          if (!r.ok) {
            log.warn(`[slack/streamingText] sendFile ${link.absPath} failed: ${r.error}`);
          }
        }),
      );
    }

    // 3. 正文: 剥 file 链接;image 引用替换为"图片已作为附件发送"提示。
    //    双协议(老 xdt-image + 媒体总仓 cindy-media,与 xdtRefs 口径一致)——
    //    只认 xdt-image 会让 cindy-media 引用残留字面量 markdown。
    let cardText = stripXdtFileLinks(text).replace(
      /!\[([^\]]*)\]\((?:xdt-image|cindy-media):\/\/[^)]+\)/g,
      (_m, alt) => (alt ? `🖼️ _${alt}(已作为附件发送)_` : ''),
    );
    const trimmed = cardText.trim();
    if (trimmed.length === 0) {
      if (fileLinks.length > 0 && sentImageCount.n === 0) {
        cardText = streamingMessages.fileSentDone(fileLinks.length);
      } else if (sentImageCount.n > 0) {
        cardText = ''; // 图片自己说话 — 占位消息直接删
      } else {
        cardText = streamingMessages.emptyReply;
      }
    }

    // 4. 收尾: 空文本 + 有图 → 删掉占位消息(图片消息已在下方);否则首块
    //    update、超长的余块 postMessage 续发。
    try {
      if (cardText.trim().length === 0) {
        await transport.call('chat.delete', { channel: this.channelId, ts: this.ts });
        return;
      }
      const chunks = splitChunks(markdownToMrkdwn(cardText));
      const first = chunks[0];
      await transport.call('chat.update', {
        channel: this.channelId,
        ts: this.ts,
        text: first,
        blocks: buildMrkdwnBlocks(first),
      });
      for (const rest of chunks.slice(1)) {
        await transport.call('chat.postMessage', {
          channel: this.channelId,
          text: rest,
          blocks: buildMrkdwnBlocks(rest),
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
      }
      this.flushed = this.buffer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[slack/streamingText] finalize update failed: ${msg}`);
    }
  }
}

export async function startStreaming(
  channelId: string,
  deps: Deps,
  initial: string = streamingMessages.randomThinking(),
  threadTs?: string,
): Promise<StreamingTextHandle> {
  const r = await deps.transport.call('chat.postMessage', {
    channel: channelId,
    text: initial,
    blocks: buildMrkdwnBlocks(initial),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  if (!r.ok || !r.data?.ts) {
    throw new Error(r.error ?? 'chat.postMessage failed (no ts)');
  }
  const messageId = encodeMessageId(channelId, String(r.data.ts));
  return new SlackStreamingTextHandle(messageId, initial, deps, threadTs);
}
