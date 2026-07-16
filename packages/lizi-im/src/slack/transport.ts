/**
 * slack/transport.ts
 * ---------------------------------------------------------------------------
 * SlackIM 的传输注入接口。
 *
 * 与 FeishuIM 直连飞书不同, 共享 Slack App 模式下 desktop 不直连 Slack
 * (Socket Mode 全 App 10 连接上限):
 *   - 入站事件: server Socket Mode 收 → SSE 推给 desktop
 *   - 出站调用: desktop → server /api/slack/proxy|upload|files(bot token
 *     仅 server 持有)
 *
 * lizi-im 包保持 host 无关 — 这里只定义接口, 具体实现(serverApiFetch +
 * net.fetch SSE)由 apps/desktop 注入。
 */

/** server → desktop 的中继事件(与 apps/server slackConnections 的定义对齐)。 */
export type SlackRelayInboundEvent =
  | {
      kind: 'hello';
      teamId: string;
      slackUserId: string;
      dmChannelId: string | null;
      botUserId: string;
      slackName: string | null;
    }
  | {
      kind: 'message';
      channelId: string;
      ts: string;
      /** thread 内回复时为 thread root ts;顶层消息无此字段 */
      threadTs?: string;
      text: string;
      files: Array<{ id: string; name: string; mimetype: string; size: number }>;
    }
  | {
      kind: 'card_action';
      channelId: string;
      messageTs: string;
      /** 卡片在 thread 内时为 thread root ts */
      threadTs?: string;
      actionId: string;
      value: string;
    }
  | { kind: 'replaced' }
  | { kind: 'unlinked' };

export type SlackRelayStatus = 'connecting' | 'connected' | 'replaced' | 'error' | 'closed';

/** /api/slack/proxy 的方法白名单(server 侧同名集合是权威, 这里是类型收口)。 */
export type SlackProxyMethod =
  | 'chat.postMessage'
  | 'chat.update'
  | 'chat.delete'
  | 'reactions.add'
  | 'reactions.remove'
  | 'conversations.open';

export interface SlackLinkStatus {
  linked: boolean;
  teamId?: string;
  slackUserId?: string;
  slackName?: string | null;
  dmChannelId?: string | null;
}

export interface SlackRelayTransport {
  /**
   * 订阅 SSE 事件流。实现负责断线重连(带退避);每次(重)连成功后 server 会
   * 先发 hello/unlinked。返回取消订阅函数。
   */
  subscribe(handlers: {
    onEvent(e: SlackRelayInboundEvent): void;
    onStatus(s: SlackRelayStatus, detail?: string): void;
  }): () => void;

  /** 经 server 代理调 Slack Web API(白名单内方法)。 */
  call(
    method: SlackProxyMethod,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>;

  /** 上传文件并分享到自己的 DM(server 走 getUploadURLExternal 三步)。
   *  threadTs 存在时文件消息发进对应 thread(completeUploadExternal 原生支持)。 */
  uploadFile(opts: {
    absPath: string;
    filename: string;
    title?: string;
    threadTs?: string;
  }): Promise<{ ok: boolean; fileId?: string; error?: string }>;

  /** 下载入站文件(server 归属校验 + bot token 拉 url_private)到本地路径。 */
  downloadFile(
    fileId: string,
    destAbsPath: string,
  ): Promise<{ ok: boolean; error?: string }>;

  /** 查询绑定状态(GET /api/slack/link)。 */
  getLinkStatus(): Promise<SlackLinkStatus>;
}
