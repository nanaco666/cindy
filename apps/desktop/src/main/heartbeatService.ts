/**
 * heartbeatService.ts — Desktop main 进程的心跳 host 适配层。
 *
 * 职责:
 *  - 从 import.meta.env 读 endpoint (VITE_HEARTBEAT_URL,默认指向生产域名)
 *  - 把 @lizi/heartbeat-client 接入 authManager:
 *      · 已登录 → uid = currentUser.id
 *      · 未登录 → uid = deviceId (machineIdSync,App 一打开就有)
 *      这保证了"打开 App 即在线"的产品语义,不依赖登录流程完成
 *  - App 退出时显式 stop,确保不留 dangling timer
 *
 * 设计原则:
 *  - 跟主 server / IM / scheduler 一样,纯 host 层,不写任何业务逻辑
 *  - 任何异常都被 @lizi/heartbeat-client 内部静默吃掉,不会抛到 init
 *  - 即便 heartbeat-server 完全挂了,这里也不会影响 App 启动或任何业务
 */

import { app, BrowserWindow } from 'electron';
import { createHeartbeatClient, type HeartbeatHandle } from '@lizi/heartbeat-client';
import * as authManager from './authManager';
import { createLogger } from './logger';
import { onQuit } from './lifecycle';
import { HEARTBEAT_DEFAULT_ENDPOINT } from '../shared/endpoints';

const log = createLogger('heartbeat');

// 默认走生产域名;dev / staging 想覆盖就改 apps/desktop/.env
const DEFAULT_ENDPOINT = HEARTBEAT_DEFAULT_ENDPOINT;
const DEFAULT_INTERVAL_MS = 60_000;
const TAPDB_DAILY_ACTIVE_CHANNEL = 'tapdb:daily-active';

let handle: HeartbeatHandle | null = null;
let lastTapdbActiveDate = getLocalDateKey();

export function initHeartbeatService(): void {
  if (handle) {
    log.warn('initHeartbeatService called twice, ignoring');
    return;
  }

  // import.meta.env 在 Electron main 的 Vite bundle 里可用
  const endpoint = (import.meta.env.VITE_HEARTBEAT_URL as string | undefined) || DEFAULT_ENDPOINT;

  handle = createHeartbeatClient({
    endpoint,
    intervalMs: DEFAULT_INTERVAL_MS,
    host: {
      getUid: () => {
        // 优先用登录 user.id;未登录回落到 deviceId,
        // 这样未登录态(包括登录中、token 刷新失败暂时无登录态)也算在线
        const userId = authManager.getCurrentUserId();
        if (userId) return userId;
        try {
          return authManager.getDeviceId();
        } catch {
          // deviceId 极小概率拿不到 (machineIdSync 抛),跳过本次而不是 crash
          return null;
        }
      },
      getPlatform: () => process.platform,
      getVersion: () => app.getVersion(),
      // 用主进程统一 logger,失败走 warn (与 client 契约一致)
      logger: {
        debug: (...args) => log.debug(...args),
        warn: (...args) => log.warn(...args),
      },
    },
    onTick: () => {
      emitTapdbDailyActiveIfNeeded();
    },
  });

  log.info(`heartbeat client started → ${endpoint} (interval=${DEFAULT_INTERVAL_MS}ms)`);

  // App quit 时显式停掉,虽然进程退出 timer 自然消亡,但保留一个干净的 shutdown 路径
  onQuit('heartbeat', () => {
    handle?.stop();
    handle = null;
  });
}

function emitTapdbDailyActiveIfNeeded(): void {
  const today = getLocalDateKey();
  if (lastTapdbActiveDate === today) return;

  lastTapdbActiveDate = today;
  broadcastToRenderers(TAPDB_DAILY_ACTIVE_CHANNEL, { date: today });
  log.info(`tapdb daily active tick ${today}`);
}

function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log.warn(`broadcast '${channel}' to window failed (non-fatal)`, err);
    }
  }
}

function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
