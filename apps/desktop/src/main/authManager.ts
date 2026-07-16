/**
 * authManager.ts
 * ---------------------------------------------------------------------------
 * All authentication logic lives here in the main process:
 *
 * - auth-server login flow (verification codes, PKCE browser redirects, account selection)
 * - Token storage (safeStorage for refresh token, in-memory for access token)
 * - Automatic access token refresh scheduling
 * - Logout (API + state cleanup)
 * - Auth state notification to renderer via IPC
 *
 * The renderer never touches tokens directly — it calls IPC endpoints
 * exposed by this module and receives state updates via 'auth:state-change'.
 */

import { BrowserWindow, net, safeStorage, app, shell } from 'electron';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { machineIdSync } from 'node-machine-id';
import {
  AuthApiError,
  CindyAuthClient,
  reduceAuthFlow,
  type AuthFlowState,
  type AuthMembership,
  type AuthRegion,
  type AuthTokenPair,
  type LoginMethod,
  type LoginOutcome,
  type ProviderConfig,
  type SocialProvider,
} from '@cindy/auth-client';
import { getFeishuService } from './mcp-integrations/feishu.js';
import { closeDb as closeLocalDb } from './localDb';
import { readReloginFlag, clearReloginFlag } from './updateService';
import * as canaryFlagStore from './canaryFlagStore';
import { getProviderSecretStore } from './secrets/providerSecretStore.js';
import {
  runRefreshWithReplacementRetry,
  type RefreshFailureAction,
  type RefreshFailureInfo,
  type RefreshFetchResult,
} from './authRefreshFailure';
import { awaitWithStartupTimeout } from './authStartupGate';
import {
  createAuthBrowserAuthorizationSlot,
  parseAuthLoopbackCallback,
} from './authLoopbackCallback';

import { applyProfileOverride, readOverride } from './profileOverrideStore';
import { createLogger } from './logger';
import { getResolvedMainLocale } from './i18n';
import { API_BASE_URL_DEV_FALLBACK, AUTH_BASE_URL_DEV_FALLBACK } from '../shared/endpoints';
import {
  parseDesktopLoginAction,
  type DesktopLoginAction,
  type DesktopLoginActionResult,
} from '../shared/authIpc';

const log = createLogger('authManager');

// ── Config ──────────────────────────────────────────────────────────────────

const AUTH_REGION: AuthRegion =
  import.meta.env.VITE_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn';
const AUTH_SERVER_URL = import.meta.env.VITE_CINDY_AUTH_BASE_URL || AUTH_BASE_URL_DEV_FALLBACK;
const PRODUCT_SERVER_URL = import.meta.env.VITE_API_BASE_URL || API_BASE_URL_DEV_FALLBACK;
const REFRESH_TOKEN_KEY = 'cindy_auth_refresh_token';
const LEGACY_REFRESH_TOKEN_KEY = 'refresh_token';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_EFFORT = 'medium';

// ── Types ───────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  /** canary-release V0.1: server-side gray-release flag; mirrored to canaryFlagStore. */
  isCanary?: boolean;
  /**
   * 当前登录用户的飞书 open_id（来自 xdt 服务端的 feishu app, cli_a94d4cf642381cd4)。
   * 从 server `/me` 的 `feishuId` 字段映射来——server DB `user.feishuId` 存的是
   * feishu open_id（auth.ts L91）。
   *
   * 注意：**不**用于 lizi-im 的 bot 白名单——bot 用的是用户自己的 feishu app，
   * open_id 跨 app 不通用，所以白名单走 TOFU（feishu/ownerGuard.ts）。这个字段
   * 仅供未来跨服务身份关联（如 SkillHub 部门同步）使用。
   *
   * **可能 null**：auth-server 登录不要求飞书身份；仅当产品 server 已关联飞书账号时，
   * `/api/user/me` 才会返回该字段。
   */
  feishuOpenId?: string | null;
  /**
   * 服务器侧用户角色。'user' 默认；'admin' 有额外权限。
   * 登录与 initialize() 时从 server 拉一次后缓存到进程生命周期内。
   * 不实时同步 —— promote/demote 后用户重启 app 才生效（按设计）。
   */
  role?: 'user' | 'admin';
  /** auth-server membership context. This is not the product-admin role above. */
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  passportId: string;
}

/**
 * chat-data-localization V0.5: 2-state migration snapshot.
 * V0.4 之前的 'migrated_elsewhere' 已删除——按 (userId, deviceId) 切片隔离后该状态自洽不再需要。
 */
export type MigrationStatus =
  | { status: 'none' }
  | { status: 'pending'; totalSessions: number; totalMessages: number };

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  /** chat-data-localization V0.5: latest migration snapshot from login/refresh response. */
  migration?: MigrationStatus;
  /** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都会有值 */
  deviceId: string;
}

type RefreshResponse = AuthTokenPair;

interface AuthErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

type AuthRefreshResult = RefreshFetchResult<RefreshResponse | AuthErrorResponse>;

type AccountSwitchTeardown = (context: {
  previousUserId: string;
  nextUserId: string;
}) => void | Promise<void>;

let accountSwitchTeardown: AccountSwitchTeardown | null = null;

interface ProductMeResponse {
  user: {
    id: string;
    name: string;
    avatar: string | null;
    email: string | null;
    defaultModel: string;
    defaultEffort: string;
    isCanary?: boolean;
    feishuId?: string | null;
    role?: 'user' | 'admin';
  };
}

// ── Module-level state ──────────────────────────────────────────────────────

let accessToken: string | null = null;
let currentUser: User | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<boolean> | null = null;
/**
 * 设备标识。默认绑定物理机(machineIdSync)。
 *
 * dev-only 覆盖:设了 `XDT_DEVICE_ID_OVERRIDE` 则用它——用于在同一台机器上跑多个
 * desktop 实例模拟「多设备」(device-link 跨设备远程控制本地联调)。deviceId 只是
 * 同账号下区分设备的标识、非鉴权凭证(鉴权走 auth-server 签发的 JWT),覆盖无安全风险。
 */
const deviceId = process.env.XDT_DEVICE_ID_OVERRIDE?.trim() || machineIdSync();
/** chat-data-localization V0.5: most recent migration snapshot from server. */
let currentMigration: MigrationStatus | undefined;

let loginFlowState: AuthFlowState | null = null;
let providerConfig: ProviderConfig | null = null;
let discoveredMethods: LoginMethod[] = [];
let pendingLoginTicket: string | null = null;
let pendingBindTicket: string | null = null;
let loginActionPromise: Promise<DesktopLoginActionResult> | null = null;

function createAuthClient(): CindyAuthClient {
  return new CindyAuthClient({
    baseUrl: AUTH_SERVER_URL,
    region: AUTH_REGION,
    deviceId,
    clientType: 'desktop',
    locale: getResolvedMainLocale(),
    fetch: async (input, init) => net.fetch(input, init as RequestInit),
  });
}

// ── safeStorage helpers ─────────────────────────────────────────────────────

const SAFE_STORAGE_DIR = () => path.join(app.getPath('userData'), 'safe-storage');

function readSafe(key: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const filepath = path.join(SAFE_STORAGE_DIR(), `${key}.enc`);
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath, 'utf-8');
    return safeStorage.decryptString(Buffer.from(content, 'base64'));
  } catch {
    return null;
  }
}

function writeSafe(key: string, value: string): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const dir = SAFE_STORAGE_DIR();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${key}.enc`),
      safeStorage.encryptString(value).toString('base64'),
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

function removeSafe(key: string): void {
  try {
    fs.unlinkSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc`));
  } catch {
    // ENOENT is fine
  }
}

// ── PKCE (Node.js native crypto) ────────────────────────────────────────────

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ── net.fetch helper ────────────────────────────────────────────────────────

/**
 * Per-request timeout for auth API calls (ms). Prevents net.fetch from hanging
 * indefinitely on black-hole / captive-portal networks. Pass `timeoutMs: 0` to
 * disable (required for token-rotating endpoints where aborting mid-flight can
 * cause permanent logout).
 */
const API_FETCH_TIMEOUT_MS = 15_000;

async function apiFetch<T>(
  apiPath: string,
  options?: {
    method?: string;
    body?: unknown;
    token?: string | null;
    timeoutMs?: number;
    baseUrl?: string;
  },
): Promise<{ ok: boolean; status: number; data: T }> {
  const url = (options?.baseUrl ?? AUTH_SERVER_URL) + apiPath;
  const method = options?.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.token) {
    headers['Authorization'] = 'Bearer ' + options.token;
  }
  const effectiveTimeout = options?.timeoutMs ?? API_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = effectiveTimeout > 0
    ? setTimeout(() => controller.abort(), effectiveTimeout)
    : undefined;
  try {
    const response = await net.fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: effectiveTimeout > 0 ? controller.signal : undefined,
    });
    const data = (await response.json()) as T;
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: null as T };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function productApiFetch<T>(
  apiPath: string,
  options?: { method?: string; body?: unknown; token?: string | null; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; data: T }> {
  return apiFetch<T>(apiPath, { ...options, baseUrl: PRODUCT_SERVER_URL });
}

function requestAuthRefresh(refreshToken: string): Promise<AuthRefreshResult> {
  // refresh 是 token-rotating 端点,禁用 abort timeout——若服务端已轮换但
  // 客户端 abort,重试旧 token 会触发 INVALID_REFRESH_TOKEN。
  return apiFetch<RefreshResponse | AuthErrorResponse>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken, deviceId },
    timeoutMs: 0,
  });
}

function getRefreshErrorCode(result: { data: unknown }): string | undefined {
  return (result.data as AuthErrorResponse | null)?.error?.code;
}

function mapMembershipToAuthUser(membership: AuthMembership, passportId?: string): User {
  return {
    id: membership.id,
    name: membership.displayName || membership.email || 'Cindy',
    avatar: null,
    email: membership.email,
    defaultModel: DEFAULT_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    isCanary: false,
    feishuOpenId: null,
    membershipKind: membership.kind,
    membershipRole: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    passportId: passportId ?? membership.passportId ?? '',
  };
}

function mergeMembershipWithExisting(membership: AuthMembership, existing: User | null): User {
  const mapped = mapMembershipToAuthUser(membership);
  if (!existing || existing.id !== mapped.id) return mapped;
  return {
    ...mapped,
    avatar: existing.avatar,
    defaultModel: existing.defaultModel,
    defaultEffort: existing.defaultEffort,
    isCanary: existing.isCanary,
    feishuOpenId: existing.feishuOpenId,
    role: existing.role,
    passportId: mapped.passportId || existing.passportId,
  };
}

function mergeProductProfile(membership: AuthMembership, response: ProductMeResponse): User {
  const identity = mapMembershipToAuthUser(membership);
  const product = response.user;
  return {
    ...identity,
    name: product.name || identity.name,
    avatar: product.avatar,
    email: product.email ?? identity.email,
    defaultModel: product.defaultModel || identity.defaultModel,
    defaultEffort: product.defaultEffort || identity.defaultEffort,
    isCanary: product.isCanary === true,
    feishuOpenId: product.feishuId ?? null,
    role: product.role === 'admin' ? 'admin' : product.role === 'user' ? 'user' : undefined,
  };
}

export function setAccountSwitchTeardown(teardown: AccountSwitchTeardown | null): void {
  accountSwitchTeardown = teardown;
}

// ── User-level API key sync ─────────────────────────────────────────────────
//
// 已移除。XD 网关 key / Mivo key 均为 **本地 only**(Electron safeStorage),
// 从不同步到服务器,因此登录 / 冷启动不再从服务器拉 key 写本地。新设备 / 新登录
// 需用户在本机重新填入 key。renderer 侧 useApiKey / useMivoApiKey 同为本地 only。

// ── System-browser OAuth / SSO (RFC 8252 loopback callback) ────────────────

const BROWSER_AUTH_TIMEOUT_MS = 5 * 60_000;
const browserAuthorizationSlot = createAuthBrowserAuthorizationSlot();

async function openSystemBrowserAuthorization(input: {
  kind: 'social' | 'sso';
  providerOrConnectionId: string;
  codeChallenge: string;
  state: string;
}): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let deactivateCancellation: (() => void) | null = null;
    const server = createServer((req, res) => {
      if (settled || !req.url) {
        res.writeHead(404).end();
        return;
      }
      const result = parseAuthLoopbackCallback(req.url, input.state);
      if (!result) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Cindy</title><p>You can return to Cindy.</p>',
      );
      finish(result);
    });

    const finish = (result: { code: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      deactivateCancellation?.();
      deactivateCancellation = null;
      if (timeout !== null) clearTimeout(timeout);
      server.close(() => resolve(result));
    };

    deactivateCancellation = browserAuthorizationSlot.activate(() =>
      finish({ error: 'USER_CANCELLED' }),
    );

    server.once('error', (error) => {
      log.warn('auth loopback listener failed', error);
      finish({ error: 'CALLBACK_LISTENER_FAILED' });
    });
    server.listen(0, '127.0.0.1', () => {
      if (settled) {
        server.close();
        return;
      }
      const address = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const authUrl = createAuthClient().buildAuthorizeUrl({ ...input, redirectUri });
      timeout = setTimeout(() => finish({ error: 'USER_CANCELLED' }), BROWSER_AUTH_TIMEOUT_MS);
      void shell.openExternal(authUrl).catch((error) => {
        log.warn('open auth URL in system browser failed', error);
        finish({ error: 'BROWSER_OPEN_FAILED' });
      });
    });
  });
}

// ── Refresh scheduling ──────────────────────────────────────────────────────

function scheduleRefresh(token: string): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf-8'),
    );
    const delay = (payload.exp - 300) * 1000 - Date.now();
    if (delay <= 0) {
      refresh();
    } else {
      refreshTimer = setTimeout(() => refresh(), delay);
    }
  } catch {
    // Invalid JWT format — skip scheduling
  }
}

/**
 * 运行时 refresh 瞬时失败后的补救重排。
 *
 * 正常路径的 refreshTimer 在触发时即消耗;若这次 refresh 因网络抖动 / 429 / 5xx 失败,
 * 不重排的话就再没有下一次尝试,access token 会在几分钟后静默过期(下一次自愈要等
 * 系统 resume 或冷启动)。access token 有 5 分钟的提前刷新余量,60s 间隔在过期前还有
 * 数次机会;确定性凭据失效不走这里(直接 clearAuth + 弹重登)。
 */
const RUNTIME_REFRESH_RETRY_MS = 60_000;
const REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
const COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [100, 250] as const;
const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000] as const;
const REPLACEMENT_INTEGRATION_RELOAD_RETRY_DELAYS_MS = [250, 1000, 3000] as const;

// 运行时 replacement refresh 成功后,会先持久化新 refresh token 再做 /me 身份核对。
// 如果 /me 或账号切换 teardown 瞬时失败,下一轮 refresh 读到的 token 已不再表现为
// replacementRetries > 0;用这个进程内标记强制下一轮继续 /me,避免 accessToken 切到 B
// 但 currentUser/renderer 仍停在 A。
let persistedRefreshTokenNeedsIdentityCheck = false;
// 当前进程最后一次接受/写入的 refresh token。运行时 refresh 开始前如果磁盘 token
// 已经被另一个共享 userData 实例换掉,即使本轮没有走 replacement-retry,也必须 /me
// 核对身份,避免 currentUser 仍是 A 但 accessToken 已切到 B。
let lastAcceptedRefreshToken: string | null = null;
let replacementIntegrationReloadTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * 冷启动 auth 流程最多阻塞 splash 的时长。refresh 是 token-rotating 端点,禁止
 * per-request abort(见 requestAuthRefresh),黑洞 / captive-portal 网络下请求会
 * 无限挂起——没有这道闸,initialize() 永不 resolve,splash 永不淡出。超时后先以
 * 未登录返回解锁 UI,流程继续后台跑:迟到成功会正常广播登录态,renderer 的
 * GuestRoute 自动把用户从登录页带回主界面。20s 覆盖正常慢网(transient retry
 * 1s+2s 退避 × 3 次请求 + /me 的 15s 上限之内的绝大多数组合)。
 */
const COLD_START_AUTH_GATE_TIMEOUT_MS = 20_000;

/**
 * auth 状态代际计数:login / clearAuth(logout、会话过期、账号切换)
 * 每次改写全局登录态时 +1。冷启动流程在开跑时快照代际,超时转后台后的每个状态
 * 写入点都先核对代际——用户在流程挂起期间手动登录 / 登出过,则迟到结果整体丢弃,
 * 绝不覆盖更新的登录态或删除新写入的 refresh token。
 */
let authStateEpoch = 0;

/**
 * 冷启动流程的进程内去重:主窗超时转后台之后,副窗 / 右侧栏窗口 mount 再调
 * initialize() 时复用同一个 in-flight promise(各自套各自的超时),避免两条流程
 * 并发轮换同一枚 refresh token 互相打成 INVALID_REFRESH_TOKEN。
 */
let coldStartAuthInFlight: Promise<AuthState> | null = null;

function scheduleRefreshRetryAfterTransientFailure(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => void refresh(), RUNTIME_REFRESH_RETRY_MS);
}

function clearReplacementIntegrationReloadTimers(): void {
  for (const timer of replacementIntegrationReloadTimers) {
    clearTimeout(timer);
  }
  replacementIntegrationReloadTimers = [];
}

async function runAuthRefreshWithReplacementRetry(
  initialRefreshToken: string,
  opts: {
    phase: 'cold-start' | 'runtime';
    withTransientRetry: boolean;
    rateLimitDelayMs?: number;
    onFailure?: (info: RefreshFailureInfo) => void;
  },
): Promise<{
  result: AuthRefreshResult;
  attempts: number;
  requestedToken: string;
  replacementRetries: number;
  replacementRetryExhausted: boolean;
  failureAction?: RefreshFailureAction;
}> {
  const run = await runRefreshWithReplacementRetry(initialRefreshToken, {
    doRefresh: requestAuthRefresh,
    readLatestStoredToken: () => readSafe(REFRESH_TOKEN_KEY),
    transientRetry: opts.withTransientRetry
      ? {
          rateLimitDelayMs: opts.rateLimitDelayMs,
          onFailure: opts.onFailure,
        }
      : undefined,
    maxReplacementRetries: REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT,
    replacementRecheck: {
      delaysMs:
        opts.phase === 'cold-start'
          ? COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS
          : RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS,
      onBeforeRecheck: ({ status, code, delayMs }) =>
        log.warn(
          `${opts.phase} refresh: stale refresh token failed status=${status} code=${code ?? '<none>'}, no replacement token on disk yet — re-reading after ${delayMs}ms before clearing auth`,
        ),
    },
    onReplacementRetry: ({ status, code }) =>
      log.warn(
        `${opts.phase} refresh: replacement-retry supersedes definitive failure status=${status} code=${code ?? '<none>'} — retrying with token written by another app instance`,
      ),
  });

  if (run.replacementRetryExhausted) {
    log.warn(
      `${opts.phase} refresh: stale refresh token kept being replaced after ${run.replacementRetries} replacement retries; keeping latest token on disk`,
    );
  }

  return run;
}

// ── Renderer notification ───────────────────────────────────────────────────

/**
 * 广播到所有未销毁的 BrowserWindow。
 *
 * 不能用 `BrowserWindow.getAllWindows()[0]` —— voice-input overlay
 * (`voice-input/global.ts:prewarmGlobalVoiceInputOverlay`) 启动期就 prewarm
 * 出一个 hidden + skipTaskbar + focusable:false 的 BrowserWindow,[0] 经常
 * 是它。这条踩坑在 `bootstrap-electron.ts:557-559` 已经为 `focusMainWindow`
 * 显式记录过;这里曾经用 [0] 发 'auth:state-change',结果是登出后真正的
 * 主窗 renderer 永远收不到 state-change,`isAuthenticated` 留在 true,
 * ProtectedRoute 不跳 /login —— 表现就是"settings 里点退出后界面没反应"。
 *
 * 项目内 IM / spend / maker / mcp-integrations 等广播器都是 forEach 全部
 * 窗口,本函数沿用同样语义;overlay 等无 listener 的窗口会忽略该事件,无副作用。
 */
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

/**
 * 当前登录态快照(所有状态出口共用)。
 *
 * `currentUser` 永远保持服务端真值;用户在本机自定义的名字 / 头像
 * (profileOverrideStore)只在这里出口处合并——login / refresh / /me 水合
 * 怎么覆写 currentUser 都不会把本地自定义冲掉,反之本地自定义也永远
 * 不会回写进服务端真值(规则 20:默认值与 override 分离)。
 */
function snapshotAuthState(): AuthState {
  const user =
    currentUser !== null
      ? applyProfileOverride(currentUser, readOverride(currentUser.id))
      : null;
  return {
    user,
    isAuthenticated: accessToken !== null && currentUser !== null,
    migration: currentMigration,
    deviceId,
  };
}

function notifyRenderer(): void {
  broadcastToRenderers('auth:state-change', snapshotAuthState());
}

function notifyRendererAuthBoundaryPending(): void {
  const state: AuthState = {
    user: null,
    isAuthenticated: false,
    deviceId,
  };
  broadcastToRenderers('auth:state-change', state);
}

function notifySessionExpired(message: string): void {
  broadcastToRenderers('auth:session-expired', { message });
}

// ── In-process auth state subscription ─────────────────────────────────────
//
// In addition to renderer broadcast (auth:state-change), main-process modules
// can subscribe to auth state transitions here. Used by main/im to
// disconnect the IM channel on logout and re-init / re-sync whitelist on
// login. Listeners are called synchronously after `currentUser` is updated;
// they MUST NOT throw.

type AuthListener = (state: AuthState) => void;
const authStateListeners = new Set<AuthListener>();

export function onAuthStateChange(listener: AuthListener): () => void {
  authStateListeners.add(listener);
  return () => authStateListeners.delete(listener);
}

function notifyAuthListeners(): void {
  const state = snapshotAuthState();
  for (const l of authStateListeners) {
    try {
      l(state);
    } catch (err) {
      log.error('auth state listener threw (non-fatal)', err);
    }
  }
}

// ── Auth state management ───────────────────────────────────────────────────

async function clearPerAccountIntegrations(): Promise<void> {
  // canary-release V0.1: 登出清理灰度标记，下次未登录直接走 stable manifest
  canaryFlagStore.clear();
  const errors: unknown[] = [];
  const clearOne = async (name: string, clear: () => Promise<void>): Promise<void> => {
    try {
      await clear();
    } catch (err) {
      log.error(`clear ${name} integration failed`, err);
      errors.push(err);
    }
  };

  await clearOne('feishu', () => getFeishuService().token.clearFeishuTokens());
  // Jira/Confluence 的 per-account 清理已随 lizi_jira 退役(2026-07-14):
  // Atlassian 账号迁入 xd-atlassian 意识保险库,是机器级而非登录账号级凭证,
  // 与 Google 意识同语义,登出不清。
  // Slack 官方 MCP 的 per-account 清理已随 slack-official 退役(2026-07-15):
  // Slack 账号迁入 cindy-slack 意识保险库,是机器级而非登录账号级凭证,与
  // Atlassian / Google 意识同语义,登出不清。

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `failed to clear ${errors.length} per-account integration(s)`,
    );
  }
}

function clearPerAccountIntegrationsInBackground(): void {
  void clearPerAccountIntegrations().catch((err) => {
    log.error('clear per-account integrations failed', err);
  });
}

/** Clear renderer-safe login progress and all main-only login tickets. */
function resetLoginFlowState(): void {
  loginFlowState = null;
  providerConfig = null;
  discoveredMethods = [];
  pendingLoginTicket = null;
  pendingBindTicket = null;
}

async function reloadPerAccountIntegrationsFromDisk(feishuJwt: string | null): Promise<void> {
  const errors: unknown[] = [];
  const reloadOne = async (name: string, reload: () => Promise<void>): Promise<void> => {
    try {
      await reload();
    } catch (err) {
      log.error(`reload ${name} integration from disk failed`, err);
      errors.push(err);
    }
  };

  await reloadOne('feishu', async () => {
    const feishuAuth = getFeishuService().token;
    feishuAuth.dispose();
    await feishuAuth.init();
    if (feishuJwt) {
      feishuAuth.setJwt(feishuJwt);
    }
  });

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `failed to reload ${errors.length} per-account integration(s) from disk`,
    );
  }
}

function scheduleReplacementIntegrationReloadRetries(userId: string): void {
  clearReplacementIntegrationReloadTimers();
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const delayMs of REPLACEMENT_INTEGRATION_RELOAD_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      replacementIntegrationReloadTimers = replacementIntegrationReloadTimers.filter(
        (candidate) => candidate !== timer,
      );
      void (async () => {
        if (currentUser?.id !== userId || !accessToken) return;
        await reloadPerAccountIntegrationsFromDisk(accessToken);
      })().catch((err) => {
        log.error(
          `delayed integration reload after replacement account switch failed delayMs=${delayMs}`,
          err,
        );
      });
    }, delayMs);
    timers.push(timer);
  }
  replacementIntegrationReloadTimers = timers;
}

function clearAuth(opts: { notify?: boolean } = {}): void {
  const notify = opts.notify ?? true;
  authStateEpoch += 1; // 迟到的冷启动流程从此作废(见 authStateEpoch 注释)
  accessToken = null;
  currentUser = null;
  currentMigration = undefined;
  resetLoginFlowState();
  persistedRefreshTokenNeedsIdentityCheck = false;
  lastAcceptedRefreshToken = null;
  clearReplacementIntegrationReloadTimers();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  removeSafe(REFRESH_TOKEN_KEY);
  removeSafe(LEGACY_REFRESH_TOKEN_KEY);
  // provider key(XD / Mivo)是绑定账号的本机密钥,**不在登出时清** —— 同账号重新登录 /
  // 会话过期重登需保留,避免每次都重填(本地 only 后服务器已无副本可拉回)。换账号导致的
  // 串号边界改由 login / 冷启动时 providerSecretStore.reconcileOwner 处理:owner 变了才清。
  // clearAuth 必须保持同步(大量调用方依赖立即 notify),但 promise rejection 仍要吞掉并记日志。
  clearPerAccountIntegrationsInBackground();
  if (notify) {
    notifyRenderer();
    notifyAuthListeners();
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getAccessToken(): string | null {
  return accessToken;
}

/** SkillHub v0.2.1: 返回当前登录用户 id（cuid），未登录时返回 null */
export function getCurrentUserId(): string | null {
  return currentUser?.id ?? null;
}

/**
 * 返回当前登录用户的 role。未登录或缺字段视为 'user'。
 */
export function getCurrentUserRole(): 'user' | 'admin' {
  return currentUser?.role === 'admin' ? 'admin' : 'user';
}

/** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都可用 */
export function getDeviceId(): string {
  return deviceId;
}

export function getAuthState(): AuthState {
  return snapshotAuthState();
}

/**
 * 服务端资料真值(profileEdit 判断「输入值 == 默认值 → 清 override 而非存快照」用)。
 * 未登录返回 null。
 */
export function getServerProfile(): { name: string; avatar: string | null } | null {
  if (!currentUser) return null;
  return { name: currentUser.name, avatar: currentUser.avatar };
}

/**
 * 本地资料覆写变更后的重广播口(profileEdit 保存成功时调用):
 * 把合并了最新覆写的登录态推给所有 renderer 窗口与 main 内订阅者。
 */
export function notifyProfileOverrideChanged(): void {
  if (!currentUser) return;
  notifyRenderer();
  notifyAuthListeners();
}

/** chat-data-localization V0.5: snapshot getter for IPC return paths. */
export function getMigrationSnapshot(): MigrationStatus | undefined {
  return currentMigration;
}

export async function initialize(): Promise<AuthState> {
  // 进程内已登录快路径:auth 状态是 main 进程全局的,主窗登录后其它 renderer
  // (会话多开副窗 / 右侧栏子窗口)mount 时各自都会调一次 auth:initialize ——
  // 没有这条快路径,每个新窗口都会重跑一整轮网络 refresh(token 轮换 + /me),
  // 期间该窗口 isAuthenticated=false,慢网/瞬时失败会闪现登录页;且冗余的
  // refresh 轮换还有并发失效风险。已登录时直接回缓存态,零网络、无闪屏。
  // 冷启动时 accessToken/currentUser 必为空,不影响下方完整初始化流程
  // (relogin marker 消费、持久化 refresh_token 校验)。
  if (accessToken && currentUser) {
    return snapshotAuthState();
  }

  // release-relogin-on-update: if the auto-updater dropped a relogin marker
  // for *this* version, wipe persisted auth and force the user back to the
  // OAuth flow. The flag is one-shot: once consumed, subsequent launches
  // see no marker and no refresh_token, so the user stays logged out
  // naturally until they sign in (rather than getting kicked every launch).
  const reloginFlag = readReloginFlag();
  if (reloginFlag && reloginFlag.version === app.getVersion()) {
    log.info(
      'relogin marker hit for v%s — clearing persisted auth',
      reloginFlag.version,
    );
    lastAcceptedRefreshToken = null;
    removeSafe(REFRESH_TOKEN_KEY);
    removeSafe(LEGACY_REFRESH_TOKEN_KEY);
    void getFeishuService().token.clearFeishuTokens();
    clearReloginFlag();
    return { user: null, isAuthenticated: false, deviceId };
  }

  // Old Feishu-auth refresh tokens are intentionally not portable to auth-server.
  removeSafe(LEGACY_REFRESH_TOKEN_KEY);
  const storedToken = readSafe(REFRESH_TOKEN_KEY);
  if (!storedToken) {
    return { user: null, isAuthenticated: false, deviceId };
  }

  // 进程内去重:主窗流程还挂着(黑洞网络)时,副窗 / 右侧栏窗口 mount 触发的
  // initialize() 复用同一个 in-flight promise,避免并发轮换同一枚 refresh token。
  if (coldStartAuthInFlight === null) {
    coldStartAuthInFlight = runColdStartRefreshFlow(storedToken).finally(() => {
      coldStartAuthInFlight = null;
    });
  }
  // 黑洞 / captive-portal 网络护栏:限时等待,超时先以未登录返回解锁 splash,
  // 流程继续后台跑;迟到成功由流程内部广播登录态(renderer 自动跳回主界面)。
  return awaitWithStartupTimeout(coldStartAuthInFlight, {
    timeoutMs: COLD_START_AUTH_GATE_TIMEOUT_MS,
    onTimeout: () => {
      log.warn(
        `cold-start auth still pending after ${COLD_START_AUTH_GATE_TIMEOUT_MS}ms — unblocking startup as logged out, flow continues in background`,
      );
      return { user: null, isAuthenticated: false, deviceId };
    },
    onLateResult: (state) =>
      log.info(
        `cold-start auth settled after startup gate timeout — isAuthenticated=${state.isAuthenticated}`,
      ),
    onLateError: (err) =>
      log.error('cold-start auth flow threw after startup gate timeout', err),
  });
}

/**
 * 冷启动 refresh 流程本体(从 initialize() 提取)。超时护栏可能把它转入后台继续
 * 执行——彼时用户已能操作登录页,因此每个全局状态写入点之前都必须核对
 * authStateEpoch:用户手动登录 / 登出过就整体丢弃迟到结果,绝不覆盖更新的登录态、
 * 不删除新登录写入的 refresh token(见 authStateEpoch 常量注释)。
 */
async function runColdStartRefreshFlow(storedToken: string): Promise<AuthState> {
  const epochAtStart = authStateEpoch;
  const epochChanged = (point: string): boolean => {
    if (authStateEpoch === epochAtStart) return false;
    log.warn(
      `cold-start refresh flow superseded by manual auth change (${point}) — discarding late result`,
    );
    return true;
  };

  try {
    // 瞬时失败(断网 / 5xx)短暂退避后重试,而不是一次失败就以未登录进登录页——
    // 否则冷启动撞上一次网络抖动,用户看到的就是「重启莫名被登出、重开一次又好了」。
    // 注意:
    //  - refresh 是 token-rotating 端点,不设 per-request timeout(timeoutMs:0)——
    //    若服务端已轮换但客户端 abort,重试以旧 token 触发 INVALID_REFRESH_TOKEN 永久登出。
    //  - 429 不重试(rateLimitDelayMs:0):服务端窗口 60s,短退避必然还在同一窗口内失败,
    //    长退避(60s)则会把 splash 阻塞分钟级——两种都不合适;直接放弃本次保留 token,
    //    下次启动或运行时 refresh(非阻塞)自愈。
    const {
      result: refreshResult,
      attempts,
      failureAction,
    } = await runAuthRefreshWithReplacementRetry(storedToken, {
      phase: 'cold-start',
      withTransientRetry: true,
      rateLimitDelayMs: 0,
      onFailure: ({ attempt, status, code, definitive, willRetry }) =>
        log.warn(
          `cold-start refresh attempt ${attempt} failed status=${status} code=${code ?? '<none>'} definitive=${definitive} transientWillRetry=${willRetry}`,
        ),
    });
    // 迟到守卫①:refresh 期间用户手动登录 / 登出过 → 丢弃结果。成功也丢
    // (旧 token family 已被新登录取代);失败更不能把新登录的 token 删掉。
    if (epochChanged('after-refresh')) {
      return { user: null, isAuthenticated: false, deviceId };
    }
    if (!refreshResult.ok) {
      // 只在「确定性凭据失效」时清除 token。429 限流 / 5xx / 断网等瞬时失败保留 token,
      // 让下次启动(或后续 refresh)能恢复登录,避免冷启动撞限流 / 网络抖动即被永久登出。
      // 与运行时 refresh() 的清除条件保持一致(共用 authRefreshFailure)。
      const action: RefreshFailureAction = failureAction ?? { kind: 'transient-failure' };
      if (action.kind === 'definitive-failure') {
        log.warn(
          'cold-start refresh: definitive credential failure — clearing persisted refresh token',
        );
        lastAcceptedRefreshToken = null;
        removeSafe(REFRESH_TOKEN_KEY);
      } else if (action.kind === 'replacement-retry') {
        log.warn(
          `cold-start refresh failed for a stale token after ${attempts} attempt(s) — keeping latest refresh token, starting logged out`,
        );
      } else {
        log.warn(
          `cold-start refresh still failing after ${attempts} attempt(s) — keeping refresh token, starting logged out`,
        );
      }
      return { user: null, isAuthenticated: false, deviceId };
    }

    const refreshData = refreshResult.data as RefreshResponse;
    writeSafe(REFRESH_TOKEN_KEY, refreshData.refreshToken);
    lastAcceptedRefreshToken = refreshData.refreshToken;
    const meResult = await productApiFetch<ProductMeResponse>('/api/user/me', {
      token: refreshData.accessToken,
    });
    // 迟到守卫②:产品资料请求期间用户手动登录 / 登出过 → 不再提交本轮身份。
    if (epochChanged('after-me')) {
      return { user: null, isAuthenticated: false, deviceId };
    }
    if (!meResult.ok) {
      // Product profile is an enhancement over the auth-server membership. Keep
      // the valid identity online and retry profile hydration on a later refresh.
      log.warn(
        `cold-start product /api/user/me failed status=${meResult.status} — using auth membership fallback`,
      );
    }

    accessToken = refreshData.accessToken;
    currentUser = meResult.ok
      ? mergeProductProfile(refreshData.membership, meResult.data)
      : mapMembershipToAuthUser(refreshData.membership);
    currentMigration = { status: 'none' };
    persistedRefreshTokenNeedsIdentityCheck = false;
    clearReplacementIntegrationReloadTimers();
    // canary-release V0.1: 用 server 返回的状态覆盖本地标记（true 写、false 清）
    canaryFlagStore.sync(currentUser.isCanary === true);
    getFeishuService().token.setJwt(refreshData.accessToken);
    scheduleRefresh(refreshData.accessToken);
    // XD / Mivo key 均为本地 only,不再在冷启动从服务器同步到本地。
    // 账号边界对账:换账号则清掉上一个账号留在本机的 provider key,同账号保留(不必重填)。
    getProviderSecretStore().reconcileOwner(refreshData.membership.id);
    // 自动登录(冷启动)也广播到 renderer,和 login() / refresh() / clearAuth() 一致。
    // AuthContext 是从 service.initialize() 的 IPC return value 拿初始 state 的,这条
    // 广播对它是"幂等的重复事件";但 renderer 侧晚到的订阅者(如 tapdb 上报)只能从
    // 广播拿到冷启动状态——不广播就永远收不到 auto-login 事件。
    notifyRenderer();
    notifyAuthListeners();
    return snapshotAuthState();
  } catch (err) {
    // 网络类失败都在 apiFetch 内部消化(返回 status 0),能走到这里的是 refresh 成功
    // **之后**的本地状态同步代码(writeSafe / feishu token / canary sync 等)抛异常——
    // 此时新 refresh token 已轮换并落盘,删除它只会把有效凭据丢掉。保留 token、记录
    // 错误,本次以未登录返回,留待下次启动自愈。
    log.error('cold-start auth initialize threw after refresh — keeping persisted refresh token', err);
    // 迟到守卫③:异常清理同样不能覆盖用户手动登录后的状态。
    if (!epochChanged('catch')) {
      accessToken = null;
      currentUser = null;
      currentMigration = undefined;
      getFeishuService().token.setJwt(null);
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    }
    return { user: null, isAuthenticated: false, deviceId };
  }
}

async function loadLoginProviders(): Promise<AuthFlowState> {
  providerConfig = await createAuthClient().getProviders();
  discoveredMethods = [];
  pendingLoginTicket = null;
  pendingBindTicket = null;
  loginFlowState = reduceAuthFlow(loginFlowState, {
    type: 'providers-loaded',
    providers: providerConfig,
  });
  return loginFlowState;
}

export async function getLoginState(): Promise<DesktopLoginActionResult> {
  try {
    return { success: true, state: loginFlowState ?? (await loadLoginProviders()) };
  } catch (error) {
    const code = error instanceof AuthApiError ? error.code : 'AUTH_SERVICE_UNAVAILABLE';
    log.warn(`load login providers failed code=${code}`);
    loginFlowState = { step: 'error', code, recoverTo: 'identifier' };
    return { success: false, code, state: loginFlowState };
  }
}

async function hydrateCurrentProductProfile(
  token: string,
  membership: AuthMembership,
  expectedEpoch: number,
): Promise<void> {
  const result = await productApiFetch<ProductMeResponse>('/api/user/me', { token });
  if (!result.ok) {
    log.warn(`product profile hydration failed status=${result.status}`);
    return;
  }
  if (authStateEpoch !== expectedEpoch || currentUser?.id !== membership.id) return;
  currentUser = mergeProductProfile(membership, result.data);
  canaryFlagStore.sync(currentUser.isCanary === true);
  notifyRenderer();
}

async function completeLogin(
  outcome: Extract<LoginOutcome, { status: 'ok' }>,
): Promise<AuthFlowState> {
  const loginEpoch = ++authStateEpoch;
  try {
    await getFeishuService().token.clearFeishuTokens();
  } catch (error) {
    // Legacy integration cleanup is independent from Cindy identity.
    log.error('clear legacy Feishu integration before login failed (non-fatal)', error);
  }
  if (authStateEpoch !== loginEpoch) {
    throw new AuthApiError(
      'AUTH_FLOW_SUPERSEDED',
      409,
      'Login was superseded by a newer auth action',
    );
  }

  accessToken = outcome.accessToken;
  persistedRefreshTokenNeedsIdentityCheck = false;
  clearReplacementIntegrationReloadTimers();
  writeSafe(REFRESH_TOKEN_KEY, outcome.refreshToken);
  removeSafe(LEGACY_REFRESH_TOKEN_KEY);
  lastAcceptedRefreshToken = outcome.refreshToken;
  clearReloginFlag();
  currentUser = mapMembershipToAuthUser(outcome.membership);
  currentMigration = { status: 'none' };
  canaryFlagStore.sync(false);
  getFeishuService().token.setJwt(outcome.accessToken);
  scheduleRefresh(outcome.accessToken);
  getProviderSecretStore().reconcileOwner(outcome.membership.id);
  pendingLoginTicket = null;
  pendingBindTicket = null;
  loginFlowState = reduceAuthFlow(loginFlowState, { type: 'outcome', outcome });
  notifyRenderer();
  notifyAuthListeners();
  void hydrateCurrentProductProfile(outcome.accessToken, outcome.membership, loginEpoch).catch(
    (error) => log.error('product profile hydration after login failed', error),
  );
  return loginFlowState;
}

async function acceptLoginOutcome(outcome: LoginOutcome): Promise<AuthFlowState> {
  if (outcome.status === 'ok') return completeLogin(outcome);
  if (outcome.status === 'select_account') {
    pendingLoginTicket = outcome.loginTicket;
    pendingBindTicket = null;
  } else {
    pendingBindTicket = outcome.bindTicket;
    pendingLoginTicket = null;
  }
  loginFlowState = reduceAuthFlow(loginFlowState, { type: 'outcome', outcome });
  return loginFlowState;
}

async function runLoginAction(action: DesktopLoginAction): Promise<DesktopLoginActionResult> {
  const client = createAuthClient();
  const stateBeforeAction = loginFlowState?.step === 'error' ? null : loginFlowState;
  try {
    // Cancellation is intercepted by dispatchLoginAction so it can settle the
    // already-running browser action instead of starting a second action.
    if (action.type === 'cancel-browser') {
      throw new AuthApiError('INVALID_AUTH_ACTION', 400, 'Unexpected browser cancellation');
    }
    if (action.type === 'reset') {
      return { success: true, state: await loadLoginProviders() };
    }
    if (!providerConfig) await loadLoginProviders();

    if (action.type === 'discover') {
      const email = action.email.trim().toLowerCase();
      discoveredMethods = await client.discover(email);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'discovery-loaded',
        email,
        methods: discoveredMethods,
      });
      return { success: true, state: loginFlowState };
    }

    if (action.type === 'request-code') {
      if (action.kind === 'phone' && !providerConfig?.phone) {
        throw new AuthApiError('PHONE_LOGIN_DISABLED', 400, 'Phone login is disabled');
      }
      await client.requestCode(action.kind, action.identifier);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'code-requested',
        kind: action.kind,
        identifier: action.identifier,
      });
      return { success: true, state: loginFlowState };
    }

    if (action.type === 'verify-code') {
      return {
        success: true,
        state: await acceptLoginOutcome(
          await client.verifyCode(action.kind, action.identifier, action.code),
        ),
      };
    }

    if (action.type === 'start-browser') {
      if (action.kind === 'social') {
        const provider = action.providerOrConnectionId as SocialProvider;
        if (!providerConfig?.social.includes(provider)) {
          throw new AuthApiError('SOCIAL_PROVIDER_DISABLED', 400, 'Provider is disabled');
        }
      } else if (
        !discoveredMethods.some(
          (method) =>
            method.type === 'sso' && method.connectionId === action.providerOrConnectionId,
        )
      ) {
        throw new AuthApiError('CONNECTION_NOT_FOUND', 404, 'SSO connection is unavailable');
      }
      const { codeVerifier, codeChallenge } = generatePKCE();
      const state = crypto.randomUUID();
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'browser-started',
        label: action.label,
      });
      const callback = await openSystemBrowserAuthorization({
        kind: action.kind,
        providerOrConnectionId: action.providerOrConnectionId,
        codeChallenge,
        state,
      });
      if ('error' in callback) {
        throw new AuthApiError(callback.error, 0, 'Browser authorization did not complete');
      }
      return {
        success: true,
        state: await acceptLoginOutcome(
          await client.exchangeAuthorizationCode(callback.code, codeVerifier),
        ),
      };
    }

    if (action.type === 'select-account') {
      if (!pendingLoginTicket)
        throw new AuthApiError('INVALID_LOGIN_TICKET', 401, 'Missing login ticket');
      return {
        success: true,
        state: await acceptLoginOutcome(
          await client.selectAccount(pendingLoginTicket, action.accountId),
        ),
      };
    }

    if (action.type === 'request-binding-code') {
      if (!pendingBindTicket || loginFlowState?.step !== 'binding') {
        throw new AuthApiError('INVALID_BIND_TICKET', 401, 'Missing binding ticket');
      }
      await client.requestBindingCode(pendingBindTicket, loginFlowState.bindType, action.contact);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'binding-code-requested',
        bindType: loginFlowState.bindType,
        contact: action.contact,
      });
      return { success: true, state: loginFlowState };
    }

    if (!pendingBindTicket || loginFlowState?.step !== 'binding') {
      throw new AuthApiError('INVALID_BIND_TICKET', 401, 'Missing binding ticket');
    }
    return {
      success: true,
      state: await acceptLoginOutcome(
        await client.verifyBinding(
          pendingBindTicket,
          loginFlowState.bindType,
          action.contact,
          action.code,
        ),
      ),
    };
  } catch (error) {
    const code = error instanceof AuthApiError ? error.code : 'AUTH_REQUEST_FAILED';
    const status = error instanceof AuthApiError ? error.statusCode : 0;
    log.warn(`login action failed action=${action.type} status=${status} code=${code}`);
    const flowCannotRetry = [
      'INVALID_LOGIN_TICKET',
      'INVALID_BIND_TICKET',
      'INVALID_AUTH_CODE',
    ].includes(code);
    if (flowCannotRetry) {
      pendingLoginTicket = null;
      pendingBindTicket = null;
    }
    // Keep the last usable screen so validation/network failures can be retried
    // without discarding the entered identifier or requesting another code.
    loginFlowState = flowCannotRetry
      ? { step: 'error', code, recoverTo: 'identifier' }
      : (stateBeforeAction ?? { step: 'error', code, recoverTo: 'identifier' });
    return { success: false, code, state: loginFlowState };
  }
}

export async function dispatchLoginAction(action: unknown): Promise<DesktopLoginActionResult> {
  const parsedAction = parseDesktopLoginAction(action);
  if (!parsedAction) {
    return { success: false, code: 'INVALID_AUTH_ACTION', state: loginFlowState };
  }
  if (parsedAction.type === 'cancel-browser') {
    const pendingAction = loginActionPromise;
    const cancelled = browserAuthorizationSlot.cancelActive();
    if (!cancelled && !pendingAction) {
      return { success: false, code: 'NO_BROWSER_AUTH_IN_PROGRESS', state: loginFlowState };
    }
    const settled = pendingAction ? await pendingAction : null;
    const state = settled?.state ?? loginFlowState ?? (await loadLoginProviders());
    return { success: true, state };
  }
  if (loginActionPromise) {
    return { success: false, code: 'LOGIN_BUSY', state: loginFlowState };
  }
  loginActionPromise = runLoginAction(parsedAction);
  try {
    return await loginActionPromise;
  } finally {
    loginActionPromise = null;
  }
}

export async function refresh(): Promise<boolean> {
  if (refreshPromise !== null) return refreshPromise;

  refreshPromise = (async () => {
    const refreshEpoch = authStateEpoch;
    const refreshWasSuperseded = (point: string): boolean => {
      if (authStateEpoch === refreshEpoch) return false;
      log.warn(
        `runtime refresh superseded by logout or a newer login (${point}) — discarding late result`,
      );
      return true;
    };
    const storedToken = readSafe(REFRESH_TOKEN_KEY);
    if (!storedToken) {
      log.debug('runtime refresh skipped: no persisted refresh token');
      return false;
    }
    const diskTokenChangedBeforeRefresh =
      currentUser !== null &&
      lastAcceptedRefreshToken !== null &&
      storedToken !== lastAcceptedRefreshToken;
    if (diskTokenChangedBeforeRefresh) {
      log.warn(
        'runtime refresh detected refresh token changed on disk before request; will verify identity before accepting result',
      );
    }

    try {
      const { result, failureAction, replacementRetries } =
        await runAuthRefreshWithReplacementRetry(storedToken, {
          phase: 'runtime',
          withTransientRetry: false,
        });
      if (refreshWasSuperseded('after-refresh')) return false;
      if (!result.ok) {
        const action: RefreshFailureAction = failureAction ?? { kind: 'transient-failure' };
        const code = getRefreshErrorCode(result);
        if (action.kind === 'definitive-failure') {
          const error = result.data as AuthErrorResponse | null;
          log.warn(
            `runtime refresh: definitive credential failure code=${code} — clearing auth, notifying session expired`,
          );
          const message = error?.error?.message ?? '登录已过期，请重新登录';
          clearAuth({ notify: false });
          notifySessionExpired(message);
        } else if (action.kind === 'replacement-retry') {
          log.warn(
            `runtime refresh failed for a stale token after replacement retries status=${result.status} code=${code ?? '<none>'} — retrying in ${RUNTIME_REFRESH_RETRY_MS / 1000}s`,
          );
          scheduleRefreshRetryAfterTransientFailure();
        } else {
          log.warn(
            `runtime refresh failed transiently status=${result.status} code=${code ?? '<none>'} — retrying in ${RUNTIME_REFRESH_RETRY_MS / 1000}s`,
          );
          scheduleRefreshRetryAfterTransientFailure();
        }
        return false;
      }

      const data = result.data as RefreshResponse;
      const needsIdentityCheck =
        replacementRetries > 0 ||
        persistedRefreshTokenNeedsIdentityCheck ||
        diskTokenChangedBeforeRefresh;
      if (needsIdentityCheck) {
        // The replacement token may have been written by another shared-userData
        // instance. Verify / reconcile the account before accepting its access token,
        // otherwise renderer state could still show account A while API calls use B.
        persistedRefreshTokenNeedsIdentityCheck = true;
        writeSafe(REFRESH_TOKEN_KEY, data.refreshToken);
        lastAcceptedRefreshToken = data.refreshToken;
        const meResult = await productApiFetch<ProductMeResponse>('/api/user/me', {
          token: data.accessToken,
        });
        if (refreshWasSuperseded('after-product-me')) return false;
        if (!meResult.ok) {
          log.warn(
            `runtime replacement refresh product /api/user/me failed status=${meResult.status} — using auth membership fallback`,
          );
        }

        const previousUserId = currentUser?.id ?? null;
        const nextUser = meResult.ok
          ? mergeProductProfile(data.membership, meResult.data)
          : mergeMembershipWithExisting(data.membership, currentUser);
        const accountSwitched = previousUserId !== null && previousUserId !== nextUser.id;
        if (accountSwitched) {
          log.warn(
            `runtime replacement refresh switched authenticated user from ${previousUserId} to ${nextUser.id}; reconciling auth state`,
          );
          notifyRendererAuthBoundaryPending();
          try {
            if (accountSwitchTeardown) {
              await accountSwitchTeardown({ previousUserId, nextUserId: nextUser.id });
            } else {
              log.warn(
                'runtime replacement account switch teardown hook is not registered; falling back to localDb close only',
              );
            }
            closeLocalDb();
          } catch (err) {
            log.error('runtime replacement account switch teardown failed', err);
            notifyRenderer();
            scheduleRefreshRetryAfterTransientFailure();
            return false;
          }
          if (refreshWasSuperseded('after-account-switch-teardown')) return false;
        }

        accessToken = data.accessToken;
        currentUser = nextUser;
        currentMigration = { status: 'none' };
        persistedRefreshTokenNeedsIdentityCheck = false;
        getProviderSecretStore().reconcileOwner(currentUser.id);
        if (accountSwitched) {
          try {
            await clearPerAccountIntegrations();
            await reloadPerAccountIntegrationsFromDisk(accessToken);
          } catch (err) {
            log.error('reload per-account integrations after replacement account switch failed', err);
          }
          if (refreshWasSuperseded('after-integration-reload')) return false;
          scheduleReplacementIntegrationReloadRetries(currentUser.id);
        }
        canaryFlagStore.sync(currentUser.isCanary === true);
        getFeishuService().token.setJwt(data.accessToken);
        scheduleRefresh(data.accessToken);
        notifyRenderer();
        if (previousUserId !== currentUser.id) {
          notifyAuthListeners();
        }
        return true;
      }

      accessToken = data.accessToken;
      currentUser = mergeMembershipWithExisting(data.membership, currentUser);
      persistedRefreshTokenNeedsIdentityCheck = false;
      writeSafe(REFRESH_TOKEN_KEY, data.refreshToken);
      lastAcceptedRefreshToken = data.refreshToken;
      currentMigration = { status: 'none' };
      getFeishuService().token.setJwt(data.accessToken);
      scheduleRefresh(data.accessToken);
      const hydrationEpoch = authStateEpoch;
      void hydrateCurrentProductProfile(data.accessToken, data.membership, hydrationEpoch).catch(
        (error) => log.error('product profile hydration after refresh failed', error),
      );
      // Push updated migration snapshot down to renderer via auth:state-change
      notifyRenderer();
      return true;
    } catch (err) {
      if (refreshWasSuperseded('catch')) return false;
      // apiFetch 消化了网络错误(status 0 走上面 !ok 分支),这里是本地状态同步异常;
      // 与瞬时失败同等对待:记录并重排,避免刷新链就此断掉。
      log.error('runtime refresh threw — retrying later', err);
      scheduleRefreshRetryAfterTransientFailure();
      return false;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function logout(): Promise<void> {
  const currentAccessToken = accessToken;
  // 注意:真实登出入口(bootstrap auth:logout handler)在调用本函数**之前**已
  // dispose DbClient 并释放 device-link 持有权(releaseDeviceLinkOwnershipBeforeLogout);
  // 需要在 DB 关闭前收尾写入的逻辑应挂在那条链路上,而不是本函数内(此时已太晚)。
  // chat-data-localization: drop the per-user db connection so the next
  // login (potentially a different user) opens a fresh file via ensureReady.
  try {
    closeLocalDb();
  } catch (err) {
    log.error('closeLocalDb on logout failed', err);
  }
  clearAuth();

  if (currentAccessToken) {
    apiFetch('/api/auth/logout', {
      method: 'POST',
      body: { deviceId },
      token: currentAccessToken,
    }).catch(() => {});
  }
}

/**
 * Called on system resume (powerMonitor 'resume' event).
 * If the app JWT is expired or expiring within 5 minutes, trigger a refresh.
 */
export function handleResume(): void {
  if (accessToken === null) return;
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64').toString('utf-8'),
    );
    if (payload.exp * 1000 - Date.now() <= 5 * 60 * 1000) {
      refresh();
    }
  } catch {
    // Invalid JWT format — skip
  }
}

export function dispose(): void {
  browserAuthorizationSlot.cancelActive();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  clearReplacementIntegrationReloadTimers();
}
