/**
 * generic-oauth —— 目录 `auth.oauth` 描述符驱动的通用 OAuth Runner。
 *
 * 把 grok-oauth-login.ts 的五件同构事泛化成 per-provider 实例：
 *   ① PKCE 授权页拉起（回环回调端口来自描述符，缺省随机高位端口）；
 *   ② 回调捕获（state 校验）；
 *   ③ form-encoded token 交换（PKCE challenge 二次回发，兼容严格校验的端点）；
 *   ④ 凭证 blob 存 safeStorage `provider_oauth_<id>`（IO 注入，见 providerSecretStore
 *      的 genericOAuthSecretIo）+ 内存缓存（路由热路径同步读，规则 10）；
 *   ⑤ 临期单飞刷新（per-provider mutex 链 + 15s 超时 + 登出/重登竞态复核）。
 *
 * 深度定制供应商（anthropic / openai / xai）**不走本模块**——它们没有目录描述符，
 * 保持各自 bespoke 实现。本模块新增供应商 = OSS 目录推一段 auth.oauth 数据。
 *
 * 可测试性：storage / fetch / 开浏览器 / 时钟全部可注入（`configureGenericOAuth`），
 * 默认实现由 host 启动期接线（createDesktopProviderService）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

import type { AgentKind, OAuthProviderDescriptor } from '@lizi/model-providers';

import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('generic-oauth');

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** access_token 剩余寿命低于此(ms)就触发后台刷新。 */
const REFRESH_MARGIN_MS = 120_000;
/** 刷新 fetch 超时 —— 在 per-provider mutex 链内，必须有界。 */
const REFRESH_FETCH_TIMEOUT_MS = 15_000;
/** 授权码换 token 的 fetch 超时——没有它,tokenUrl 挂起会让登录 spinner 永久卡死(只能手动取消)。 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
/** 响应缺 expires_in 时的兜底 TTL（不能沿用旧 expires_at，防刷新自打转，同 grok）。 */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

// ── 注入点（默认 no-op，host 启动期接线；测试注入内存实现）──────────────────────
export interface GenericOAuthStorage {
  read(providerId: string): string | null;
  write(providerId: string, value: string): boolean;
  remove(providerId: string): void;
}

interface GenericOAuthIo {
  storage: GenericOAuthStorage;
  fetchImpl: typeof fetch;
  /** 拉起系统浏览器（生产 = electron shell.openExternal）。 */
  openExternal: (url: string) => Promise<void>;
  now: () => number;
}

let io: GenericOAuthIo = {
  storage: { read: () => null, write: () => false, remove: () => {} },
  fetchImpl: fetch,
  openExternal: async () => {
    throw new Error('generic-oauth openExternal not configured');
  },
  now: Date.now,
};

/** host 启动期 / 测试注入依赖（部分覆盖）。 */
export function configureGenericOAuth(partial: Partial<GenericOAuthIo>): void {
  io = { ...io, ...partial };
}

// ── PKCE 工具（同 grok）─────────────────────────────────────────────────────────
function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
const genVerifier = (): string => base64URLEncode(randomBytes(32));
const genChallenge = (v: string): string => base64URLEncode(createHash('sha256').update(v).digest());
const genState = (): string => base64URLEncode(randomBytes(16));

// ── 凭证 blob ───────────────────────────────────────────────────────────────────
interface OAuthTokenBlob {
  access_token: string;
  refresh_token?: string;
  /** epoch ms。 */
  expires_at?: number;
  obtained_at?: number;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function blobFromTokenResponse(t: TokenResponse, prev?: OAuthTokenBlob | null): OAuthTokenBlob {
  const now = io.now();
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? prev?.refresh_token,
    expires_at: now + (t.expires_in ? t.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
    obtained_at: now,
    scope: t.scope ?? prev?.scope,
  };
}

// blob 内存缓存（safeStorage 解密是同步 keychain/DPAPI 往返，路由热路径不能每请求读盘）。
// undefined = 尚未从磁盘读过；null = 确认无凭证。凭证只经本模块读写，失效点精确。
const blobCache = new Map<string, OAuthTokenBlob | null>();

function readBlob(providerId: string): OAuthTokenBlob | null {
  const cached = blobCache.get(providerId);
  if (cached !== undefined) return cached;
  const raw = io.storage.read(providerId);
  let blob: OAuthTokenBlob | null = null;
  if (raw) {
    try {
      const b = JSON.parse(raw) as OAuthTokenBlob;
      blob = typeof b.access_token === 'string' && b.access_token.length > 0 ? b : null;
    } catch {
      blob = null;
    }
  }
  blobCache.set(providerId, blob);
  return blob;
}

/**
 * 落盘凭证 blob 并同步内存缓存,返回落盘是否成功。
 * 落盘失败时**内存缓存仍更新**:刷新场景丢弃新 blob 更危险——IdP 可能已轮换
 * refresh_token,丢弃后缓存里的旧 refresh_token 立即失效,当场断链;由调用方
 * 按场景决策(登录硬失败并回滚内存态、刷新保留内存态只记 warn)。
 */
function writeBlob(providerId: string, b: OAuthTokenBlob): boolean {
  const persisted = io.storage.write(providerId, JSON.stringify(b));
  blobCache.set(providerId, b);
  return persisted;
}

/** 该供应商本机是否已登录（有 access_token）。连接态判定用。 */
export function hasGenericOAuthLogin(providerId: string): boolean {
  return readBlob(providerId) !== null;
}

/** 登出：清凭证 + 缓存（含 per-provider 刷新链条目，防长期运行下 Map 积累）。 */
export function logoutGenericOAuth(providerId: string): void {
  io.storage.remove(providerId);
  blobCache.set(providerId, null);
  // 链上若有 in-flight 刷新也安全:doRefresh 落盘前会复核 blob 已清则不回写。
  refreshChains.delete(providerId);
}

/**
 * 清空全部内存缓存。生产用于「账号切换清空本机密钥」后失效缓存
 * （providerSecretStore 的 secretsClearedListener 接线），测试用于切换注入 storage。
 */
export function resetGenericOAuthMemoryCache(): void {
  blobCache.clear();
  refreshChains.clear();
}

function isExpiringSoon(b: OAuthTokenBlob): boolean {
  if (!b.expires_at) return false; // 无 expiry 信息 → 不主动刷，靠 401 暴露
  return io.now() >= b.expires_at - REFRESH_MARGIN_MS;
}

// ── 刷新（per-provider 单飞链，同 grok 的 _refreshChain 语义）──────────────────────
const refreshChains = new Map<string, Promise<void>>();

async function doRefresh(providerId: string, oauth: OAuthProviderDescriptor): Promise<void> {
  const fresh = readBlob(providerId);
  if (fresh === null || !isExpiringSoon(fresh) || !fresh.refresh_token) return;
  const refreshToken = fresh.refresh_token;
  let res: Response;
  try {
    res = await io.fetchImpl(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: oauth.clientId,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn('generic oauth token 刷新请求失败', {
      providerId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!res.ok) {
    log.warn('generic oauth token 刷新失败', { providerId, status: res.status });
    return;
  }
  let tok: TokenResponse;
  try {
    tok = (await res.json()) as TokenResponse;
  } catch {
    return;
  }
  if (!tok.access_token) return;
  // 落盘前复核（同 grok）：刷新期间用户可能已登出（blob 被清）或已重登（refresh_token 变了）。
  const beforeWrite = readBlob(providerId);
  if (beforeWrite === null || beforeWrite.refresh_token !== refreshToken) return;
  if (!writeBlob(providerId, blobFromTokenResponse(tok, beforeWrite))) {
    // 内存态已更新(本次会话可继续用新 token),只是重启后需重新登录。
    log.warn('generic oauth 刷新凭证落盘失败,仅内存态生效', { providerId });
  }
}

/** 单飞刷新：同 provider 的并发刷新排队串行，链头异常不断链。 */
export function refreshGenericOAuthIfNeeded(
  providerId: string,
  oauth: OAuthProviderDescriptor,
): Promise<void> {
  const prev = refreshChains.get(providerId) ?? Promise.resolve();
  const run = prev.then(() => doRefresh(providerId, oauth));
  refreshChains.set(
    providerId,
    run.catch((err) => {
      log.warn('generic oauth 刷新异常', {
        providerId,
        err: err instanceof Error ? err.message : String(err),
      });
    }),
  );
  return run;
}

/**
 * 路由热路径的**同步** token 读取（provider-route 的 oauthTokenReader 接线到这里）。
 * 读内存缓存；发现临期时**后台**触发单飞刷新（不阻塞本次路由——首个请求可能仍用旧
 * token，401 后下一请求即拿到新 token）。descriptor 由调用方现查目录传入。
 */
export function readCachedGenericOAuthAccessToken(
  providerId: string,
  oauth: OAuthProviderDescriptor | undefined,
): string | null {
  const blob = readBlob(providerId);
  if (!blob) return null;
  if (oauth && isExpiringSoon(blob) && blob.refresh_token) {
    void refreshGenericOAuthIfNeeded(providerId, oauth);
  }
  return blob.access_token;
}

// ── 登录流 ─────────────────────────────────────────────────────────────────────
/** 回环回调监听（端口来自描述符；缺省 0 = OS 随机分配）。 */
class CallbackListener {
  private server: Server;
  private expectedState = '';
  private pendingRes: ServerResponse | null = null;
  private resolve: ((code: string) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;
  port = 0;

  constructor() {
    this.server = createServer();
  }

  async start(fixedPort: number | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', (err: NodeJS.ErrnoException) =>
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `OAuth 回调端口 ${fixedPort} 被占用，请关闭占用进程后重试`
              : `OAuth callback server failed: ${err.message}`,
          ),
        ),
      );
      this.server.listen(fixedPort ?? 0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : (fixedPort ?? 0);
        resolve();
      });
    });
  }

  waitForCode(state: string): Promise<string> {
    this.expectedState = state;
    return new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.server.on('request', (req, res) => this.onRequest(req, res));
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const parsed = new URL(req.url || '', `http://127.0.0.1:${this.port}`);
    if (parsed.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = parsed.searchParams.get('code') ?? undefined;
    const state = parsed.searchParams.get('state') ?? undefined;
    if (!code) {
      res.writeHead(400);
      res.end('Authorization code not found');
      this.reject?.(new Error('No authorization code received'));
      return;
    }
    if (state !== this.expectedState) {
      res.writeHead(400);
      res.end('Invalid state parameter');
      this.reject?.(new Error('Invalid state parameter'));
      return;
    }
    this.pendingRes = res;
    this.resolve?.(code);
  }

  succeed(providerName: string): void {
    if (!this.pendingRes) return;
    // 与 close() 同口径包 try/catch:用户重定向后立刻关标签页,writeHead/end 可能同步抛
    // (ERR_STREAM_DESTROYED 等)。此时凭证已落盘、登录已成功,回执页写失败绝不能把
    // 结果翻转成 { ok: false }(否则 UI 报失败但连接态又显示已连接,自相矛盾)。
    try {
      this.pendingRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // 浏览器页面够不到 renderer i18n，双语兜底（同 grok）。
      this.pendingRes.end(
        `<html><body style="font-family:sans-serif">${providerName} 登录成功，可以关闭此页面回到 XDMaker。<br/>`
        + `${providerName} login successful — you can close this page and return to XDMaker.</body></html>`,
      );
    } catch {
      /* 回执页写失败无害:登录结果以凭证落盘为准 */
    }
    this.pendingRes = null;
  }

  close(): void {
    if (this.pendingRes) {
      try {
        this.pendingRes.writeHead(200);
        this.pendingRes.end('done');
      } catch {
        /* no-op */
      }
      this.pendingRes = null;
    }
    try {
      this.server.removeAllListeners();
      this.server.close();
    } catch {
      /* no-op */
    }
  }
}

export interface GenericOAuthLoginResult {
  ok: boolean;
  reason?: string;
}

// 同一时刻每个 provider 只允许一个登录流。
const activeLogins = new Map<string, { listener: CallbackListener; abort: AbortController }>();

/** 取消某供应商进行中的登录。 */
export function cancelGenericOAuthLogin(providerId: string): void {
  const cur = activeLogins.get(providerId);
  if (!cur) return;
  cur.abort.abort();
  cur.listener.close();
  activeLogins.delete(providerId);
}

/**
 * 跑一次描述符驱动的 OAuth 浏览器登录。成功后凭证 blob 写 safeStorage（provider_oauth_<id>）。
 */
export async function runGenericOAuthLogin(
  provider: { id: string; name: string },
  oauth: OAuthProviderDescriptor,
): Promise<GenericOAuthLoginResult> {
  cancelGenericOAuthLogin(provider.id);

  const verifier = genVerifier();
  const challenge = genChallenge(verifier);
  const state = genState();
  const listener = new CallbackListener();
  const abort = new AbortController();
  activeLogins.set(provider.id, { listener, abort });

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await listener.start(oauth.redirectPort);
    if (abort.signal.aborted) throw new Error('login_cancelled');
    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;

    const authUrl = new URL(oauth.authorizeUrl);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', oauth.clientId);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('scope', oauth.scopes);
    authUrl.searchParams.append('code_challenge', challenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');
    authUrl.searchParams.append('state', state);
    for (const [k, v] of Object.entries(oauth.extraAuthParams ?? {})) {
      authUrl.searchParams.append(k, v);
    }

    // 先注册 code 等待再开浏览器（已授权的浏览器可能在 openExternal 返回前就完成重定向，同 grok）。
    const codePromise = new Promise<string>((resolve, reject) => {
      if (abort.signal.aborted) { reject(new Error('login_cancelled')); return; }
      timer = setTimeout(() => reject(new Error('timeout')), LOGIN_TIMEOUT_MS);
      abort.signal.addEventListener('abort', () => reject(new Error('login_cancelled')), { once: true });
      listener.waitForCode(state).then(resolve, reject);
    });
    codePromise.catch(() => { /* handled at await site */ });

    log.info('opening browser for generic oauth', { providerId: provider.id, port: listener.port });
    await io.openExternal(authUrl.toString());

    const code = await codePromise;

    // form-encoded、严格按 RFC 7636 §4.5:token 端点只回发 code_verifier。
    // （code_challenge/method 属 /authorize 参数,带到 token 端点会被严格校验的 IdP
    // 拒为 invalid_request;需要非标参数的供应商走 bespoke 实现,不进通用 Runner。）
    // 超时与用户取消双保险:授权页等待的 LOGIN_TIMEOUT_MS 管不到这一步。
    const res = await io.fetchImpl(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: oauth.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Token exchange failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const tok = (await res.json()) as TokenResponse;
    if (!tok.access_token) throw new Error('token 响应缺 access_token');

    // 落盘前最后检查：已取消的登录绝不写凭证（同 grok）。
    if (abort.signal.aborted) throw new Error('login_cancelled');
    if (!writeBlob(provider.id, blobFromTokenResponse(tok))) {
      // 落盘失败必须硬失败并回滚内存态:否则 UI 显示已连接、路由能用,重启/刷新后
      // 授权静默消失(safeStorage 不可用或 .enc 写不进磁盘的机器上尤其致命)。
      blobCache.set(provider.id, null);
      throw new Error('凭证写入本机安全存储失败,请检查系统钥匙串/加密服务后重试');
    }
    listener.succeed(provider.name);
    log.info('generic oauth login success', { providerId: provider.id, scope: tok.scope });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('generic oauth login failed', { providerId: provider.id, error: msg });
    return { ok: false, reason: abort.signal.aborted ? 'login_cancelled' : msg };
  } finally {
    if (timer) clearTimeout(timer);
    listener.close();
    if (activeLogins.get(provider.id)?.listener === listener) activeLogins.delete(provider.id);
  }
}

// ── 动态模型发现（additions-only，消费方 merge 进 active-catalog）───────────────────
/**
 * 由 runtime baseUrl 推导默认的模型发现端点（描述符未显式声明 modelsDiscoveryUrl 时用）。
 * 约定：Anthropic 兼容端点为 `{base}/v1/models`；OpenAI 兼容 baseUrl 常以 `/v1` 结尾，
 * 此时只追加 `/models`。自定义 OAuth 供应商靠这条推导免去用户手填发现端点。
 */
export function deriveModelsDiscoveryUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/i.test(u) ? `${u}/models` : `${u}/v1/models`;
}

/**
 * 拉取 models 发现端点（带 Bearer），解析 OpenAI / Anthropic `GET /models` 形状
 * （`{data:[{id}]}` 或 `{models:[{id}]}` / 字符串数组）。失败返回 null（调用方保持纯静态兜底）。
 * 端点取 `discoveryUrl`（调用方按 runtime baseUrl 推导）?? 描述符显式声明的 modelsDiscoveryUrl。
 * `agent` 决定 wire 专属请求头：Anthropic wire（claude-code runtime）的**所有**端点
 * （含 GET /v1/models）都强制要求 `anthropic-version`，缺失直接 400 → 发现静默失败；
 * 与 provider-diagnostics.buildProbeRequest 的 cc 分支同口径。
 */
export async function discoverGenericOAuthModels(
  providerId: string,
  oauth: OAuthProviderDescriptor,
  discoveryUrl?: string,
  agent?: AgentKind,
): Promise<{ id: string; name: string }[] | null> {
  const url = discoveryUrl ?? oauth.modelsDiscoveryUrl;
  if (!url) return null;
  const token = readCachedGenericOAuthAccessToken(providerId, oauth);
  if (!token) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (agent === 'claude-code') headers['anthropic-version'] = '2023-06-01';
  let res: Response;
  try {
    res = await io.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  const list = (() => {
    if (!json || typeof json !== 'object') return null;
    const o = json as { data?: unknown; models?: unknown };
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.models)) return o.models;
    return null;
  })();
  if (!list) return null;
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
          ? (item as { id: string }).id
          : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: id });
  }
  return out;
}
