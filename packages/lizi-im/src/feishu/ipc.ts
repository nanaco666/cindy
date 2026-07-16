/**
 * feishu/ipc.ts
 * ---------------------------------------------------------------------------
 * IPC handlers for the Settings UI (renderer ↔ main). Channel names preserved
 * verbatim from the legacy `feishuBot:*` shape so renderer code is unchanged.
 *
 * Push channels:
 *   - feishuBot:status-change   每次状态变化都广播
 *   - feishuBot:conflict        判定冲突时广播一次
 *
 * Invoke channels:
 *   - feishuBot:get-state       一次性拉取当前状态
 *   - feishuBot:save            保存凭证 + 启动连接
 *   - feishuBot:clear           断开 + 清除所有
 */

import { getHost, getLog } from './moduleScope.js';
import { feishuEvents } from './events.js';
import * as wsClient from './wsClient.js';
import * as storage from './storage.js';
import * as ownerGuard from './ownerGuard.js';
import {
  pollAppRegistration,
  requestAppRegistration,
  type AppRegistrationPollResult,
} from './appRegistration.js';
import type { FeishuPublicState } from './internal-types.js';

let registered = false;
let registrationRunId = 0;

export function registerFeishuIpc(): void {
  if (registered) return;
  registered = true;

  const log = getLog();
  const host = getHost();

  host.ipc.handle('feishuBot:get-state', async () => getPublicState());

  host.ipc.handle('feishuBot:save', async (payload) => {
    const p = payload as { appId?: unknown; appSecret?: unknown } | undefined;
    if (
      !p ||
      typeof p.appId !== 'string' ||
      typeof p.appSecret !== 'string' ||
      p.appId.length === 0 ||
      p.appSecret.length === 0
    ) {
      throw new Error('[INVALID_PAYLOAD] appId and appSecret required');
    }
    return saveAndConnect(p.appId.trim(), p.appSecret.trim());
  });

  host.ipc.handle('feishuBot:clear', async () => {
    await clearAndDisconnect();
    return { ok: true };
  });

  host.ipc.handle('feishuBot:set-lifecycle-announcement', async (payload) => {
    const p = payload as { enabled?: unknown } | undefined;
    const enabled = typeof p?.enabled === 'boolean' ? p.enabled : true;
    storage.writeLifecycleAnnouncement(enabled);
    wsClient.setLifecycleAnnouncement(enabled);
    return { ok: true };
  });

  host.ipc.handle('feishuBot:registration-begin', async () => {
    registrationRunId++;
    const runId = registrationRunId;
    try {
      const begin = await requestAppRegistration(host.httpPostForm, 'feishu');
      pollRegistrationInBackground(runId, begin.deviceCode, begin.interval, begin.expiresIn);
      return { ok: true, ...begin };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/ipc] registration begin failed: ${error}`);
      return { ok: false, error };
    }
  });

  host.ipc.handle('feishuBot:registration-cancel', async () => {
    registrationRunId++;
    host.ipc.broadcast('feishuBot:registration-status', { status: 'cancelled' });
    return { ok: true };
  });

  feishuEvents.on('status', (update) => {
    host.ipc.broadcast('feishuBot:status-change', update);
  });

  feishuEvents.on('conflict', (payload) => {
    host.ipc.broadcast('feishuBot:conflict', payload);
  });

  log.info('[feishu/ipc] handlers registered');
}

// ── public state shape (preserved for renderer compatibility) ─────────────────

export function getPublicState(): FeishuPublicState {
  const creds = storage.readCredentials();
  // Read owner directly from disk — renderer may query this before
  // FeishuIM.init has populated the in-memory cache (no ordering guarantee
  // across get-state ↔ init). storage.readOwnerOpenId is the source of truth.
  return {
    status: wsClient.getCurrentStatus(),
    appId: creds?.appId ?? null,
    appSecret: creds?.appSecret ?? null,
    hasSecret: creds != null,
    ownerOpenId: storage.readOwnerOpenId(),
    lifecycleAnnouncement: storage.readLifecycleAnnouncement(),
  };
}

export async function saveAndConnect(
  appId: string,
  appSecret: string,
): Promise<{ verdict: 'connected' | 'conflict' | 'error' }> {
  await wsClient.stop();
  const ok = storage.writeCredentials({ appId, appSecret });
  if (!ok) return { verdict: 'error' };
  const verdict = await wsClient.start({ appId, appSecret });
  return { verdict };
}

async function pollRegistrationInBackground(
  runId: number,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<void> {
  const host = getHost();
  const log = getLog();
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = Math.max(interval, 1);

  while (Date.now() < deadline && runId === registrationRunId) {
    await delay(currentInterval * 1000);
    if (runId !== registrationRunId) return;

    let result: AppRegistrationPollResult;
    try {
      result = await pollAppRegistration(host.httpPostForm, 'feishu', deviceCode, currentInterval);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      host.ipc.broadcast('feishuBot:registration-status', { status: 'error', error });
      return;
    }

    if (result.status === 'pending') {
      host.ipc.broadcast('feishuBot:registration-status', { status: 'pending' });
      continue;
    }

    if (result.status === 'slow_down') {
      currentInterval = result.interval;
      host.ipc.broadcast('feishuBot:registration-status', { status: 'pending' });
      continue;
    }

    if (result.status === 'success') {
      let success = result.result;
      if (success.tenantBrand === 'lark' && !success.clientSecret) {
        const larkResult = await pollAppRegistration(
          host.httpPostForm,
          'lark',
          deviceCode,
          currentInterval,
        );
        if (larkResult.status === 'success') success = larkResult.result;
      }

      if (!success.clientId || !success.clientSecret) {
        host.ipc.broadcast('feishuBot:registration-status', {
          status: 'error',
          error: 'app registration succeeded but missing client_id or client_secret',
        });
        return;
      }

      if (success.ownerOpenId) {
        storage.writeOwnerOpenId(success.ownerOpenId);
        ownerGuard.loadFromDisk();
      }
      const { verdict } = await saveAndConnect(success.clientId, success.clientSecret);
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'success',
        appId: success.clientId,
        ownerOpenId: success.ownerOpenId,
        verdict,
      });
      return;
    }

    if (result.status === 'expired') {
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'expired',
        error: result.message,
      });
      return;
    }

    if (result.status === 'denied' || result.status === 'error') {
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'error',
        error: result.message,
      });
      return;
    }
  }

  if (runId === registrationRunId) {
    log.info('[feishu/ipc] registration expired');
    host.ipc.broadcast('feishuBot:registration-status', { status: 'expired' });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function clearAndDisconnect(): Promise<void> {
  await wsClient.stop();
  ownerGuard.clear();
  storage.clearAll();
}
