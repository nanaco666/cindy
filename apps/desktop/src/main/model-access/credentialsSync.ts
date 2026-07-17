import type { ModelAccessStatus } from '../../shared/modelAccess.js';
import type { ModelAccessCredentialsStore } from './credentialsStore.js';

/**
 * credentialsSync.ts — 网关凭据自动下发的同步状态机(纯逻辑,依赖注入)。
 * ---------------------------------------------------------------------------
 * 职责:登录后向 model-access-server 拉取 {endpoint, apiKey},成功则落
 * safeStorage + endpoint 元数据;失败按错误语义进入 failed / disabled /
 * unsupported 态。所有 IO(HTTP / safeStorage / codex 重启副作用 / 广播)
 * 经 deps 注入,可用内存 harness 单测(规则 14)。
 *
 * 状态语义(shared/modelAccess.ts):
 *  - disabled(503):灰度未启用,不覆盖本地任何东西,UI 走手填兜底;
 *  - unsupported(403 ORG_NOT_SUPPORTED):企业未接入,终态不重试,UI 无手填入口;
 *  - failed:有限重试(指数退避)后停在 failed,**绝不因同步失败清本地 key**
 *    ——既有 key(无论手填还是旧下发)继续工作,新会话无感。
 *
 * 并发:single-flight——同步进行中再触发(登录三入口并发 / 手动重试)复用在途
 * Promise。写 key 仅在值变化时发生,避免每次登录都触发 codex env-key 重启抖动。
 */

/** 服务端错误的最小切片(serverApiClient.ServerApiError 的结构子集)。 */
export interface CredentialsFetchError {
  code: string;
  statusCode: number;
}

function asFetchError(err: unknown): CredentialsFetchError {
  if (
    err &&
    typeof err === 'object' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number'
  ) {
    return err as CredentialsFetchError;
  }
  return { code: 'UNKNOWN', statusCode: 0 };
}

export interface CredentialsPayload {
  endpoint: string;
  apiKey: string;
}

export interface CredentialsSyncDeps {
  /** GET /api/model-access/credentials(失败抛 ServerApiError 形状)。 */
  fetchCredentials(): Promise<CredentialsPayload>;
  /** POST /api/model-access/credentials/rotate。 */
  rotateCredentials(): Promise<CredentialsPayload>;
  /** 读本机 XD key(providerSecretStore 'xd')。 */
  readXdKey(): string | null;
  /** 写本机 XD key,含 codex env-key 重启副作用;false = 落盘失败。 */
  writeXdKey(key: string): Promise<boolean>;
  store: ModelAccessCredentialsStore;
  /** 状态变化回调(index.ts 接 broadcast)。 */
  onStatusChange(status: ModelAccessStatus): void;
  /** 自动重试退避(默认 [2s, 8s];首次尝试不算)。 */
  retryDelaysMs?: number[];
  sleep?(ms: number): Promise<void>;
  log?: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

export interface CredentialsSync {
  getStatus(): ModelAccessStatus;
  /**
   * 登录触发的同步(fire-and-forget 语义,返回的 Promise 仅供测试/重试入口等待)。
   * unsupported 终态下不再发起(切换账号会先经 handleAuthChange 复位)。
   */
  sync(): Promise<ModelAccessStatus>;
  /** UI 手动重试:复位终态限制后重新同步。 */
  retry(): Promise<ModelAccessStatus>;
  /** 轮换:成功返回新状态;失败抛 CredentialsFetchError 形状(IPC 层映射错误码)。 */
  rotate(): Promise<ModelAccessStatus>;
  /** 登录/登出/切账号入口(authManager.onAuthStateChange)。 */
  handleAuthChange(state: { isAuthenticated: boolean }): void;
  /** 手填保存成功(safe-storage IPC 层通知):source 翻 manual。 */
  noteManualKeySaved(): void;
  /** 手填 key 被删除:清来源标记。 */
  noteManualKeyRemoved(): void;
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000];

export function createCredentialsSync(deps: CredentialsSyncDeps): CredentialsSync {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  let status: ModelAccessStatus = snapshot('idle');
  let inflight: Promise<ModelAccessStatus> | null = null;
  /** 本轮登录期内的世代号:登出/换账号自增,作废在途重试循环。 */
  let epoch = 0;

  function snapshot(
    state: ModelAccessStatus['state'],
    errorCode?: string,
  ): ModelAccessStatus {
    return {
      state,
      ...(errorCode ? { errorCode } : {}),
      source: deps.store.getSource(),
      endpoint: deps.store.getServerEndpoint(),
    };
  }

  function setStatus(state: ModelAccessStatus['state'], errorCode?: string): ModelAccessStatus {
    status = snapshot(state, errorCode);
    deps.onStatusChange(status);
    return status;
  }

  /** 单次拉取 + 落盘。返回终局状态;'retryable' 表示可进入下一次退避重试。 */
  async function attemptOnce(): Promise<ModelAccessStatus | 'retryable'> {
    let payload: CredentialsPayload;
    try {
      payload = await deps.fetchCredentials();
    } catch (err) {
      const e = asFetchError(err);
      if (e.statusCode === 503 || e.code === 'MODEL_ACCESS_DISABLED') {
        deps.log?.info('model-access disabled on server, falling back to manual key flow');
        return setStatus('disabled');
      }
      if (e.statusCode === 403 || e.code === 'ORG_NOT_SUPPORTED') {
        deps.log?.info('org not supported by model-access, xd provider unavailable');
        return setStatus('unsupported');
      }
      deps.log?.warn(`model-access credentials fetch failed: ${e.code} (${e.statusCode})`);
      return 'retryable';
    }
    return applyPayload(payload);
  }

  /** 下发结果落盘(sync 与 rotate 共用)。值未变不写 key,不触发 codex 重启。 */
  async function applyPayload(payload: CredentialsPayload): Promise<ModelAccessStatus> {
    const current = deps.readXdKey();
    if (current !== payload.apiKey) {
      const ok = await deps.writeXdKey(payload.apiKey);
      if (!ok) {
        deps.log?.warn('model-access key write failed (safeStorage unavailable?)');
        return setStatus('failed', 'SAFE_STORAGE_UNAVAILABLE');
      }
    }
    deps.store.setServerCredentials(payload.endpoint);
    return setStatus('ok');
  }

  async function runSync(): Promise<ModelAccessStatus> {
    const myEpoch = epoch;
    setStatus('syncing');
    for (let attempt = 0; ; attempt++) {
      const result = await attemptOnce();
      if (myEpoch !== epoch) return status; // 登出/换账号,放弃本轮
      if (result !== 'retryable') return result;
      if (attempt >= retryDelays.length) {
        return setStatus('failed', 'SYNC_FAILED');
      }
      await sleep(retryDelays[attempt]);
      if (myEpoch !== epoch) return status;
    }
  }

  function startSync(): Promise<ModelAccessStatus> {
    if (inflight) return inflight;
    inflight = runSync().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    getStatus() {
      return status;
    },

    sync() {
      // unsupported / disabled 是本轮登录期内的终态:重复触发(refresh 等)不再打服务端。
      if (status.state === 'unsupported' || status.state === 'disabled') {
        return Promise.resolve(status);
      }
      return startSync();
    },

    retry() {
      if (inflight) return inflight;
      // 手动重试允许从任何状态(含 disabled——灰度可能刚打开)重新发起。
      return startSync();
    },

    async rotate() {
      // rotate 不与 sync 合并:等待在途同步完成后执行,语义上必须真的轮换。
      if (inflight) await inflight.catch(() => undefined);
      const payload = await deps.rotateCredentials(); // 失败原样抛给 IPC 层映射
      return applyPayload(payload);
    },

    handleAuthChange(state) {
      if (state.isAuthenticated) {
        void startSync().catch(() => undefined);
      } else {
        // 登出/会话失效:复位状态机(含 unsupported 终态),不动本地 key/元数据。
        epoch++;
        setStatus('idle');
      }
    },

    noteManualKeySaved() {
      deps.store.setManualSource();
      // 手填即视为用户显式选择手动模式;同步状态保持现状(disabled/failed 下手填是兜底)。
      setStatus(status.state, status.errorCode);
    },

    noteManualKeyRemoved() {
      deps.store.clear();
      setStatus(status.state, status.errorCode);
    },
  };
}
