/**
 * feishu/client.ts — lark.Client lifecycle + safeCall error normaliser.
 *
 * `createFeishuClient(opts)` returns a lazy SDK client + a `safeCall` wrapper
 * that maps SDK responses / network errors to the package-wide `FeishuApiResult`
 * shape. appId/appSecret are intentionally empty: every API call must pass
 * `lark.withUserAccessToken()` (token management lives in feishu/token).
 *
 * Pure (no Electron deps); host injects only an optional logger.
 * Originally lived in apps/desktop/src/main/feishuClient.ts.
 */

import * as lark from '@larksuiteoapi/node-sdk';

import type { FeishuApiResult, LiziMcpLogger } from '../types.js';
import type { FeishuClientFacade } from './types.js';

export interface CreateFeishuClientOptions {
  logger?: LiziMcpLogger;
}

// Feishu rate-limit code. Comes back either as `{ code: 99991400 }` in a normal
// response, OR thrown as an axios 400 with the same code in `err.response.data`.
const RATE_LIMIT_CODE = 99991400;
// 3 retries → max ~7s of backoff before giving up. Wiki tree scans can fire
// dozens of node-list calls; without this, one transient 5-QPS burst aborts
// the whole scan.
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull a Feishu business code out of a thrown SDK error. The lark SDK wraps
 * axios, so rate-limit errors surface as `err.response.data.code === 99991400`.
 */
function extractFeishuCodeFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; response?: { data?: { code?: unknown } } };
  const dataCode = e.response?.data?.code;
  if (typeof dataCode === 'number') return dataCode;
  if (typeof e.code === 'number') return e.code;
  return undefined;
}

export function createFeishuClient(
  opts: CreateFeishuClientOptions = {},
): FeishuClientFacade {
  const log = opts.logger;
  let _client: lark.Client | null = null;

  function getClient(): lark.Client {
    if (!_client) {
      _client = new lark.Client({
        appId: '',
        appSecret: '',
        domain: lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.warn,
      });
    }
    return _client;
  }

  function toResult(response: {
    code?: number;
    msg?: string;
    data?: unknown;
  }): FeishuApiResult {
    if (response.code === 0 || response.code === undefined) {
      return { ok: true, data: response.data };
    }
    const code = response.code;
    const msg = response.msg ?? '<no-msg>';

    if (code === 99991668 || code === 99991672) {
      log?.warn(
        `[feishuClient] toResult AUTH_EXPIRED feishuCode=${code} msg=${msg}`,
      );
      return { ok: false, errorCode: 'AUTH_EXPIRED' };
    }
    if (code === RATE_LIMIT_CODE) {
      log?.warn(
        `[feishuClient] toResult RATE_LIMITED feishuCode=${code} msg=${msg}`,
      );
      return { ok: false, errorCode: 'RATE_LIMITED', data: { code, msg } };
    }

    log?.warn(
      `[feishuClient] toResult UNMAPPED feishuCode=${code} msg=${msg} → returning FEISHU_API_ERROR (consider mapping if this is auth-related)`,
    );
    return {
      ok: false,
      errorCode: 'FEISHU_API_ERROR',
      data: { code, msg: response.msg },
    };
  }

  async function safeCall<
    T extends { code?: number; msg?: string; data?: unknown },
  >(fn: () => Promise<T>): Promise<FeishuApiResult> {
    let lastResult: FeishuApiResult | undefined;
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
      try {
        const res = await fn();
        const result = toResult(res);
        if (result.ok || result.errorCode !== 'RATE_LIMITED') return result;
        lastResult = result;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errName = err instanceof Error ? err.name : 'Unknown';
        const feishuCode = extractFeishuCodeFromError(err);

        if (feishuCode === RATE_LIMIT_CODE) {
          lastResult = {
            ok: false,
            errorCode: 'RATE_LIMITED',
            data: { code: feishuCode, msg: 'request trigger frequency limit' },
          };
        } else {
          // lark SDK throws axios errors for non-2xx; the real Feishu code/msg
          // lives in err.response.data. Without surfacing it, all 4xx collapse
          // to a useless "Request failed with status code 400" — debugging
          // permission/scope/payload issues becomes guesswork.
          const responseBody = (err as { response?: { data?: unknown } })?.response?.data;
          log?.error(
            `safeCall error: ${errName}: ${errMsg}${
              responseBody ? ` body=${JSON.stringify(responseBody)}` : ''
            }`,
          );
          if (err instanceof Error) {
            if (err.message?.includes('timeout') || err.name === 'AbortError') {
              return { ok: false, errorCode: 'TIMEOUT' };
            }
            if (
              err.message?.includes('ECONNREFUSED') ||
              err.message?.includes('ENOTFOUND')
            ) {
              return { ok: false, errorCode: 'NETWORK_ERROR' };
            }
          }
          return {
            ok: false,
            errorCode: 'NETWORK_ERROR',
            data: { detail: errMsg, ...(responseBody ? { response: responseBody } : {}) },
          };
        }
      }

      if (attempt >= RATE_LIMIT_MAX_RETRIES) break;
      const delay = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
      log?.warn(
        `[feishuClient] RATE_LIMITED, backing off ${delay}ms before retry ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}`,
      );
      await sleep(delay);
    }
    return lastResult ?? { ok: false, errorCode: 'RATE_LIMITED' };
  }

  async function resolveP2pChatId(
    client: lark.Client,
    openId: string,
    authOpts: ReturnType<typeof lark.withUserAccessToken>,
  ): Promise<FeishuApiResult> {
    const result = await safeCall(() =>
      client.request<{ code: number; msg?: string; data?: unknown }>(
        {
          method: 'POST',
          url: '/open-apis/im/v1/chat_p2p/batch_query',
          params: { chatter_id_type: 'open_id' },
          data: { chatter_ids: [openId] },
        },
        authOpts,
      ),
    );
    if (!result.ok) return result;

    const chats =
      (result.data as { p2p_chats?: Array<{ chat_id?: string }> } | undefined)
        ?.p2p_chats ?? [];
    const chatId = chats.find((chat) => chat.chat_id)?.chat_id;
    if (!chatId) {
      return {
        ok: false,
        errorCode: 'P2P_CHAT_NOT_FOUND',
        data: {
          open_id: openId,
          message:
            '未找到与该用户的单聊会话。通常表示当前登录用户与对方没有历史单聊记录。',
        },
      };
    }
    return { ok: true, data: { chat_id: chatId } };
  }

  return { getClient, safeCall, resolveP2pChatId };
}
