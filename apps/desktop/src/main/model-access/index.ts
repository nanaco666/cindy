import { BrowserWindow, ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import * as authManager from '../authManager.js';
import { serverApiFetch, ServerApiError } from '../serverApiClient.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { getCodexProxyAuthInjectionState } from '../maker-host/codex-proxy-host.js';
import {
  prepareCodexForAuthModeChange,
  finalizeCodexAfterAuthModeChange,
  cancelCodexAuthModeChange,
  getMakerIfReady,
} from '../maker-host/index.js';
import { getActiveCatalog, setXdGatewayModels } from '../maker-host/active-catalog.js';
import { refreshCatalogDerivedModels } from '../maker-host/catalog-to-descriptors.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  MODEL_ACCESS_STATUS_CHANNEL,
  type ModelAccessGatewayModel,
  type ModelAccessStatus,
} from '../../shared/modelAccess.js';
import { getModelAccessCredentialsStore } from './credentialsStore.js';
import {
  createCredentialsSync,
  type CredentialsPayload,
  type CredentialsSync,
} from './credentialsSync.js';

const log = createLogger('modelAccess');

/**
 * model-access/index.ts — 网关凭据自动下发的 desktop 接线层。
 * ---------------------------------------------------------------------------
 * 组装 credentialsSync 的真实依赖并接入:
 *  - authManager.onAuthStateChange:登录(completeLogin / 冷启动 / refresh 换号)
 *    自动触发同步,登出复位;
 *  - serverApiFetch + 独立 base(clientEndpoints 'modelAccessApiBaseUrl'):
 *    自动带 Bearer access token + 401 refresh;
 *  - providerSecretStore('xd')写 key,值变化时复用 codex env-key 重启副作用
 *    (与 safe-storage IPC 层同一套 prepare/finalize,见 bootstrap-electron 注释)
 *    ——main 侧自动写 key 的副作用缺口在此补齐(providerSecretStore.ts 顶注预告过);
 *  - 状态经 MODEL_ACCESS_STATUS_CHANNEL 推给所有窗口,IPC 提供
 *    get-status / retry / rotate 三个通道(仅本机设置页使用,不进 device-link
 *    allowlist)。
 */

const CREDENTIALS_PATH = '/api/model-access/credentials';
const MODELS_PATH = '/api/model-access/models';

function fetchCredentials(): Promise<CredentialsPayload> {
  return serverApiFetch<CredentialsPayload>(CREDENTIALS_PATH, {
    baseUrl: getClientEndpoint('modelAccessApiBaseUrl'),
  });
}

function rotateCredentials(): Promise<CredentialsPayload> {
  return serverApiFetch<CredentialsPayload>(`${CREDENTIALS_PATH}/rotate`, {
    method: 'POST',
    baseUrl: getClientEndpoint('modelAccessApiBaseUrl'),
  });
}

/**
 * 写 XD key(main 侧自动下发路径),带 codex env-key 重启副作用:
 * env-key spawn 的 codex app-server 把 gateway key 冻在子进程 env 里,写盘后
 * 必须重建才生效——与 renderer 手填走的 safe-storage IPC 同一套语义。
 * 非 env-key 形态零副作用(Claude 每 session 现读 key,天然跟随)。
 */
async function writeXdKeyWithCodexSideEffect(key: string): Promise<boolean> {
  const needRestart = getCodexProxyAuthInjectionState() === 'env-key';
  if (!needRestart) {
    return getProviderSecretStore().set('xd', key);
  }
  try {
    await prepareCodexForAuthModeChange();
  } catch (err) {
    log.warn('prepare codex before auto key write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const ok = getProviderSecretStore().set('xd', key);
  if (!ok) {
    cancelCodexAuthModeChange();
    return false;
  }
  try {
    await finalizeCodexAfterAuthModeChange();
  } catch (err) {
    // key 已写盘(新值有效);codex 重建失败只记日志,下次 spawn 自然用新 key。
    log.warn('finalize codex after auto key write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

function broadcastStatus(status: ModelAccessStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MODEL_ACCESS_STATUS_CHANNEL, status);
    }
  }
}

// ─── XD 网关模型目录同步(网关为准,目录仅补元数据;fail-open)──────────────
// 凭据同步成功后从 model-access-server 拉 GET /models(AIGateway /model-groups
// 的 mode=chat 投影),整体重建 xd 供应商的模型列表(active-catalog
// setXdGatewayModels)。拉取失败保持现状(上次快照或目录静态清单),不影响主链路。
// 快照持久化在 credentialsStore:冷启动首帧即用上次目录,防「静态清单 → 网关
// 清单」的可见跳变(规则 7)。

let modelsSyncInflight: Promise<void> | null = null;

function applyGatewayModels(models: ModelAccessGatewayModel[]): void {
  setXdGatewayModels(models);
  // 已创建的 maker 会话持有 capabilities 引用,原地刷新;maker 未构建时目录
  // 惰性重算即可(下次 getActiveCatalog 自然生效)。
  const maker = getMakerIfReady();
  if (maker) refreshCatalogDerivedModels(maker, getActiveCatalog());
  // 让供应商页 / 模型选择器 refetch(与自定义供应商 CRUD 同一条刷新通道)。
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MAKER_PUSH.PROVIDER_CHANGED, {});
    }
  }
}

async function runModelsSync(): Promise<void> {
  let payload: { models: ModelAccessGatewayModel[] };
  try {
    payload = await serverApiFetch<{ models: ModelAccessGatewayModel[] }>(MODELS_PATH, {
      baseUrl: getClientEndpoint('modelAccessApiBaseUrl'),
    });
  } catch (err) {
    log.warn('xd gateway models fetch failed (keeping current list)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const models = (payload.models ?? []).filter((m) => typeof m?.id === 'string' && m.id);
  if (models.length === 0) {
    // 空目录按失败处理:清空会让供应商行整个消失,展示上次快照/静态清单伤害更小。
    log.warn('xd gateway models fetch returned empty list; keeping current list');
    return;
  }
  log.info(`xd gateway models synced: ${models.length}`);
  getModelAccessCredentialsStore().setGatewayModels(models);
  applyGatewayModels(models);
}

/** 触发一次模型目录同步(single-flight,fire-and-forget 语义)。 */
function scheduleModelsSync(): void {
  if (modelsSyncInflight) return;
  modelsSyncInflight = runModelsSync()
    .catch((err) => {
      log.warn('xd gateway models sync threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      modelsSyncInflight = null;
    });
}

let syncInstance: CredentialsSync | null = null;

function getSync(): CredentialsSync {
  if (!syncInstance) {
    syncInstance = createCredentialsSync({
      fetchCredentials,
      rotateCredentials,
      readXdKey: () => getProviderSecretStore().get('xd'),
      writeXdKey: writeXdKeyWithCodexSideEffect,
      store: getModelAccessCredentialsStore(),
      onStatusChange: (status) => {
        broadcastStatus(status);
        // 凭据就绪(下发/轮换成功)→ 拉取网关模型目录(XD 模型列表的权威来源)。
        if (status.state === 'ok') scheduleModelsSync();
      },
      log: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
      },
    });
  }
  return syncInstance;
}

/** 当前同步状态(renderer 首帧经 IPC 拉;main 内部也可直接读)。 */
export function getModelAccessStatus(): ModelAccessStatus {
  return getSync().getStatus();
}

/** 存量手填 key 场景的写入通知(safe-storage IPC 层保留的兼容钩子):来源标记翻 manual。 */
export function noteManualXdKeySaved(): void {
  getSync().noteManualKeySaved();
}

/** 手填 key 被删除(safe-storage IPC 层通知):清来源标记。 */
export function noteManualXdKeyRemoved(): void {
  getSync().noteManualKeyRemoved();
}

function mapServerError(err: unknown): never {
  if (err instanceof ServerApiError) {
    if (err.statusCode === 503 || err.code === 'MODEL_ACCESS_DISABLED') {
      throwIpcError('MODEL_ACCESS_DISABLED', '模型访问服务未启用');
    }
    if (err.statusCode === 403 || err.code === 'ORG_NOT_SUPPORTED') {
      throwIpcError('MODEL_ACCESS_UNSUPPORTED', '当前企业未开通模型访问');
    }
    throwIpcError('MODEL_ACCESS_FAILED', err.message);
  }
  throwIpcError('MODEL_ACCESS_FAILED', err instanceof Error ? err.message : String(err));
}

/**
 * 初始化:订阅登录态变化 + 注册 IPC。在 bootstrap 的 IPC 注册阶段调用一次。
 * onAuthStateChange 覆盖 completeLogin / 冷启动 initialize / refresh 换账号
 * 三条入口(authManager.notifyAuthListeners 的全部触发点),无需插桩 authManager。
 */
export function initModelAccess(): void {
  const sync = getSync();

  authManager.onAuthStateChange((state) => {
    sync.handleAuthChange({ isAuthenticated: state.isAuthenticated });
  });
  // 订阅挂载时可能已错过冷启动的首次 notify(初始化顺序取决于 bootstrap),补一次。
  if (authManager.getAuthState().isAuthenticated) {
    sync.handleAuthChange({ isAuthenticated: true });
  }
  // 冷启动首帧:直接应用上次持久化的网关模型目录快照(防「静态清单 → 网关清单」
  // 的可见跳变,规则 7);登录同步成功后会拉最新覆盖。
  const persistedModels = getModelAccessCredentialsStore().getGatewayModels();
  if (persistedModels && persistedModels.length > 0) {
    applyGatewayModels(persistedModels);
  }

  ipcMain.handle('model-access:get-status', () => sync.getStatus());

  ipcMain.handle('model-access:retry', async (): Promise<ModelAccessStatus> => {
    return sync.retry();
  });

  ipcMain.handle('model-access:rotate', async (): Promise<ModelAccessStatus> => {
    try {
      return await sync.rotate();
    } catch (err) {
      mapServerError(err);
    }
  });
}

/** 仅测试:重置单例。 */
export function resetModelAccessForTest(): void {
  syncInstance = null;
  modelsSyncInflight = null;
}
