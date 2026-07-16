/**
 * main/im/slack/transport.ts
 * ---------------------------------------------------------------------------
 * SlackRelayTransport 的 desktop 实现 — lizi-im SlackIM 与 apps/server
 * /api/slack 之间的传输层:
 *
 *   - subscribe: SSE(GET /api/slack/events)长连接, Electron net.fetch 流式
 *     读取;断线指数退避重连(1s → 2s → ... → 30s 封顶), 401 时先走
 *     authManager.refresh 再重试
 *   - call / uploadFile / downloadFile / getLinkStatus: 经 serverApiFetch /
 *     net.fetch 调 server 代理端点(bot token 不出 server)
 *
 * 与 FeishuIM 的 WSClient 对位 — 但连接对象是我们自己的 server, 不是 Slack。
 */

import fs from 'node:fs';
import os from 'node:os';
import { net } from 'electron';

import type {
  SlackLinkStatus,
  SlackProxyMethod,
  SlackRelayInboundEvent,
  SlackRelayTransport,
} from 'lizi-im';

import * as authManager from '../../authManager';
import { serverApiFetch, ServerApiError } from '../../serverApiClient';
import { createLogger } from '../../logger';
import { API_BASE_URL_DEV_FALLBACK } from '../../../shared/endpoints';

const log = createLogger('im:slack:transport');

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || API_BASE_URL_DEV_FALLBACK;

/**
 * 多设备支持: 本机稳定标识(machineIdSync)+ hostname, SSE 注册与出站代理都
 * 带上 — server 据此区分同一用户的多台 desktop, 并维护 thread → 设备路由。
 * hostname 可能含非 ASCII(中文机器名), header 值必须 encodeURIComponent;
 * proxy body 为对称也传编码值, server 端统一 decode。
 */
function deviceInfo(): { deviceId: string; deviceName: string } {
  return {
    deviceId: authManager.getDeviceId(),
    deviceName: encodeURIComponent(os.hostname()),
  };
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// 503 = server 未开通 Slack 集成 — 不是故障, 低频轮询即可(管理员可能随时开)
const DISABLED_RETRY_MS = 5 * 60_000;

/**
 * 二进制上传/下载用的裸 net.fetch + 401 自动刷新重试。
 * upload/download 不能走 serverApiFetch(它是 JSON 协议), 但必须复刻它的
 * token 过期处理 — 否则 desktop 跑过 access token 生命周期后, Slack 文件
 * 收发会一直失败直到别的请求触发刷新。
 */
async function fetchWithAuthRetry(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit },
): Promise<Response> {
  const attempt = (): Promise<Response> => {
    const token = authManager.getAccessToken();
    return net.fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  };
  let res = await attempt();
  if (res.status === 401) {
    const refreshed = await authManager.refresh();
    if (refreshed) res = await attempt();
  }
  return res;
}

export function createSlackRelayTransport(): SlackRelayTransport {
  return {
    subscribe(handlers) {
      let stopped = false;
      let attempt = 0;
      let abort: AbortController | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;

      const scheduleRetry = (overrideMs?: number): void => {
        if (stopped) return;
        const delay = overrideMs ?? Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
        attempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void connect();
        }, delay);
      };

      const connect = async (): Promise<void> => {
        if (stopped) return;
        handlers.onStatus('connecting');
        abort = new AbortController();
        try {
          const device = deviceInfo();
          const sseHeaders = (token: string | null): Record<string, string> => ({
            Accept: 'text/event-stream',
            'X-XDM-Device-Id': device.deviceId,
            'X-XDM-Device-Name': device.deviceName,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          });
          let res = await net.fetch(`${API_BASE_URL}/api/slack/events`, {
            headers: sseHeaders(authManager.getAccessToken()),
            signal: abort.signal,
          });
          if (res.status === 401) {
            // token 过期 — refresh 一次再连
            const refreshed = await authManager.refresh();
            if (refreshed) {
              res = await net.fetch(`${API_BASE_URL}/api/slack/events`, {
                headers: sseHeaders(authManager.getAccessToken()),
                signal: abort.signal,
              });
            }
          }
          if (!res.ok || !res.body) {
            // 503 = SLACK_DISABLED — 不是故障, 5 分钟低频轮询;其余按指数退避
            handlers.onStatus('error', `SSE HTTP ${res.status}`);
            scheduleRetry(res.status === 503 ? DISABLED_RETRY_MS : undefined);
            return;
          }

          attempt = 0; // 连接成功, 退避归零
          handlers.onStatus('connected');

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE 帧以空行分隔;心跳是 ": ping" 注释行, JSON.parse 不会碰到
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const event = JSON.parse(line.slice(6)) as SlackRelayInboundEvent;
                  if (event.kind === 'replaced') {
                    // 被新连接顶掉 — 不重连(避免两台 desktop 互相抢), 报状态由
                    // 用户决定在哪台机器继续
                    handlers.onStatus('replaced');
                    stopped = true;
                  }
                  handlers.onEvent(event);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  log.warn(`SSE frame parse failed: ${msg}`);
                }
              }
            }
          }
          // 流自然结束(server 重启 / 网络断) → 重连
          if (!stopped) {
            handlers.onStatus('connecting');
            scheduleRetry();
          }
        } catch (err) {
          if (stopped) return;
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`SSE connect failed: ${msg}`);
          handlers.onStatus('error', msg);
          scheduleRetry();
        }
      };

      void connect();

      return () => {
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
        abort?.abort();
        handlers.onStatus('closed');
      };
    },

    async call(method: SlackProxyMethod, args: Record<string, unknown>) {
      try {
        const data = await serverApiFetch<Record<string, unknown>>('/api/slack/proxy', {
          method: 'POST',
          // deviceId/deviceName: server 在顶层 chat.postMessage 成功后记
          // thread root → 本机 的路由(多设备支持);老 server 忽略多余字段
          body: { method, args, ...deviceInfo() },
        });
        // Slack Web API 自身的 ok 字段透传(server 200 但 Slack 层失败时为 false)
        const ok = data.ok !== false;
        return ok
          ? { ok: true, data }
          : { ok: false, data, error: String(data.error ?? 'slack api error') };
      } catch (err) {
        const msg =
          err instanceof ServerApiError ? `${err.code}: ${err.message}` : String(err);
        return { ok: false, error: msg };
      }
    },

    async uploadFile({ absPath, filename, title, threadTs }) {
      try {
        const bytes = fs.readFileSync(absPath);
        const qs = new URLSearchParams({ filename });
        if (title) qs.set('title', title);
        if (threadTs) qs.set('thread_ts', threadTs);
        const res = await fetchWithAuthRetry(`${API_BASE_URL}/api/slack/upload?${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(bytes),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; fileId?: string; error?: { message?: string } }
          | null;
        if (!res.ok || !data?.ok) {
          return { ok: false, error: data?.error?.message ?? `HTTP ${res.status}` };
        }
        return { ok: true, fileId: data.fileId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async downloadFile(fileId, destAbsPath) {
      try {
        const res = await fetchWithAuthRetry(
          `${API_BASE_URL}/api/slack/files/${encodeURIComponent(fileId)}`,
          {},
        );
        if (!res.ok || !res.body) {
          return { ok: false, error: `HTTP ${res.status}` };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(destAbsPath, buf);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async getLinkStatus(): Promise<SlackLinkStatus> {
      try {
        return await serverApiFetch<SlackLinkStatus>('/api/slack/link');
      } catch (err) {
        // SLACK_DISABLED / 网络异常等 → 视作未绑定, SlackIM 走 unlinked 路径
        const msg =
          err instanceof ServerApiError ? `${err.code}` : String(err);
        log.info(`getLinkStatus failed (treated as unlinked): ${msg}`);
        return { linked: false };
      }
    },
  };
}
