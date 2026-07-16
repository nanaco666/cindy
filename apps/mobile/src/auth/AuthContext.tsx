import * as WebBrowser from "expo-web-browser";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Linking } from "react-native";
import { apiFetchRaw, ApiError, type ApiFetchOptions } from "@/api/client";
import {
  API_BASE_URL,
  FEISHU_APP_ID,
  MOBILE_OAUTH_STATE_PREFIX,
  MOBILE_REDIRECT_URL,
  NATIVE_FEISHU_LOGIN_ENABLED,
  OAUTH_SCOPE,
} from "@/config/env";
import { ensureDeviceId } from "@/auth/deviceId";
import { parseOAuthCallbackUrl } from "@/auth/oauthCallback";
import { createPkcePair, createState } from "@/auth/pkce";
import { isAccessTokenExpiring } from "@/auth/jwt";
import { isFeishuAppInstalled, requestFeishuAuthCode } from "@/auth/feishuNativeLogin";
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from "@/auth/secureStorage";
import { clearAllMobileVoiceCredentials } from "@/session/mobileVoiceCredentialStore";
import { clearAllMobileVoiceInputHistories } from "@/session/mobileVoiceHistoryStore";
import { clearCachedHomeListSnapshot } from "@/session/mobileHomeListCache";
import { resetComposerPaletteCache } from "@/session/composerPaletteCache";
import { resetAgentCapabilitiesCache } from "@/session/agentCapabilitiesCache";
import { clearCachedSessionMessages } from "@/session/mobileSessionMessageCache";
import { clearMobileVoiceLiteLlmSettings } from "@/session/mobileVoiceLiteLlmSettings";
import { clearTapdbUser, setTapdbUser } from "@/analytics/mobileTapdb";

WebBrowser.maybeCompleteAuthSession();

const REFRESH_TOKEN_KEY = "xdt.mobile.refreshToken";
const USER_PROFILE_KEY = "xdt.mobile.userProfile";
const PENDING_OAUTH_KEY = "xdt.mobile.pendingOAuth";
const PENDING_OAUTH_MAX_AGE_MS = 10 * 60 * 1000;
const NATIVE_FEISHU_LOGIN_FOREGROUND_TIMEOUT_MS = 8 * 1000;

export interface MobileUser {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  role?: "user" | "admin";
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: MobileUser;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

interface MeResponse {
  user: MobileUser;
}

interface PendingOAuth {
  codeVerifier: string;
  deviceId: string;
  state: string;
  createdAt: number;
}

function createNativeFeishuLoginTimeout(): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let activeStartedAt: number | null = AppState.currentState === "active" ? Date.now() : null;
  let foregroundElapsedMs = 0;
  let cleanup = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const clearTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
    };
    const rejectTimeout = () => {
      cleanup();
      reject(new Error("native-feishu-login-timeout"));
    };
    const armTimer = () => {
      clearTimer();
      if (activeStartedAt == null) return;
      const remaining = NATIVE_FEISHU_LOGIN_FOREGROUND_TIMEOUT_MS - foregroundElapsedMs;
      if (remaining <= 0) {
        rejectTimeout();
        return;
      }
      timeoutId = setTimeout(rejectTimeout, remaining);
    };
    const pauseTimer = () => {
      if (activeStartedAt != null) {
        foregroundElapsedMs += Date.now() - activeStartedAt;
        activeStartedAt = null;
      }
      clearTimer();
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        activeStartedAt = Date.now();
        armTimer();
      } else {
        pauseTimer();
      }
    });
    cleanup = () => {
      clearTimer();
      subscription.remove();
    };
    armTimer();
  });
  return { promise, cleanup };
}

async function requestFeishuAuthCodeWithTimeout(appId: string): Promise<string> {
  const timeout = createNativeFeishuLoginTimeout();
  try {
    const result = await Promise.race([
      requestFeishuAuthCode({ appId }),
      timeout.promise,
    ]);
    return result.code;
  } finally {
    timeout.cleanup();
  }
}

export interface OAuthLoginRequest {
  authUrl: string;
  redirectUri: string;
}

export interface AuthContextValue {
  initialized: boolean;
  isBusy: boolean;
  isAuthenticated: boolean;
  user: MobileUser | null;
  deviceId: string | null;
  prepareOAuthLogin(): Promise<OAuthLoginRequest>;
  loginWithFeishu(): Promise<void>;
  authError: string | null;
  clearAuthError(): void;
  devLogin(): Promise<void>;
  completeOAuthCallback(callbackUrl: string): Promise<void>;
  logout(): Promise<void>;
  getAccessToken(): Promise<string | null>;
  apiFetch<T>(path: string, opts?: Omit<ApiFetchOptions, "token">): Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [initialized, setInitialized] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const [user, setUser] = useState<MobileUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Dedupe concurrent refreshes: the server rotates (deletes) the refresh token on use, so two
  // callers racing with the same token would have only the first succeed and the rest fail with
  // an invalid token. Concurrent callers share this single in-flight promise instead.
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  // Bumped on logout so an in-flight refresh that resolves afterwards discards its result instead
  // of writing a fresh token back and resurrecting the just-logged-out session.
  const authGenerationRef = useRef(0);

  const setToken = useCallback((token: string | null) => {
    accessTokenRef.current = token;
    setAccessToken(token);
  }, []);

  // 用户资料的唯一写入口:同步 state + 持久化快照。快照让弱网冷启动能先以
  // 缓存资料恢复"已登录"视图(isAuthenticated 以 user 为准),token 由后台刷新
  // 补齐;没有快照时,冷启动的任何一次网络失败都会把有效会话误判成未登录。
  const applyUser = useCallback((next: MobileUser | null) => {
    setUser(next);
    void writeCachedUserProfile(next);
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const refresh = useCallback(
    (knownDeviceId?: string): Promise<string | null> => {
      if (refreshInFlightRef.current) return refreshInFlightRef.current;
      // Snapshot the auth generation: if a logout happens while this refresh is in flight, the
      // bumped generation tells us to discard the rotated token rather than resurrect the session.
      const generation = authGenerationRef.current;
      let run: Promise<string | null>;
      const clearIfCurrent = () => {
        if (refreshInFlightRef.current === run) refreshInFlightRef.current = null;
      };
      run = (async (): Promise<string | null> => {
        const did = knownDeviceId ?? deviceId ?? (await ensureDeviceId());
        const refreshToken = await getSecureItem(REFRESH_TOKEN_KEY).catch(
          () => null,
        );
        if (!refreshToken) return null;
        try {
          const result = await apiFetchRaw<RefreshResponse>("/api/auth/refresh", {
            method: "POST",
            body: { refreshToken, deviceId: did },
          });
          if (authGenerationRef.current !== generation) return null; // logged out mid-refresh
          await setSecureItem(REFRESH_TOKEN_KEY, result.refreshToken);
          setToken(result.accessToken);
          return result.accessToken;
        } catch (err) {
          if (authGenerationRef.current !== generation) return null;
          // Refresh token rejected (rotated away / expired) → drop to logged-out so the UI
          // re-prompts, instead of leaving isAuthenticated stuck true with every call failing.
          if (err instanceof ApiError && err.status === 401) {
            await deleteSecureItem(REFRESH_TOKEN_KEY).catch(() => undefined);
            setToken(null);
            applyUser(null);
            return null;
          }
          throw err; // transient (network / 5xx): keep the session so callers can retry
        }
      })();
      refreshInFlightRef.current = run;
      run.then(clearIfCurrent, clearIfCurrent);
      return run;
    },
    [applyUser, deviceId, setToken],
  );

  const loadMe = useCallback(async (token: string) => {
    const me = await apiFetchRaw<MeResponse>("/api/user/me", { token });
    applyUser(me.user);
  }, [applyUser]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsBusy(true);
      try {
        const did = await ensureDeviceId();
        if (cancelled) return;
        setDeviceId(did);
        // 弱网冷启动:先用本地会话痕迹(refresh token + 用户资料快照)恢复
        // "已登录"视图,再走网络刷新 token。refresh 的瞬时失败(网络断开 / 5xx /
        // 超时)绝不能把持有效凭证的用户踢回登录页——只有 401(凭证真失效)才
        // 降级为未登录,那条路径在 refresh 内部已清 token + user。
        const [storedRefreshToken, cachedUser] = await Promise.all([
          getSecureItem(REFRESH_TOKEN_KEY).catch(() => null),
          readCachedUserProfile(),
        ]);
        if (cancelled) return;
        if (storedRefreshToken && cachedUser) setUser(cachedUser);
        try {
          const token = await refresh(did);
          if (token) await loadMe(token).catch(() => undefined);
        } catch {
          // transient:保留降级会话(user 已从快照恢复),由下方自愈 effect
          // 按退避 + 回前台时机自动补刷 token。
        }
      } finally {
        if (!cancelled) {
          setIsBusy(false);
          setInitialized(true);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [loadMe, refresh]);

  // 降级会话自愈:已用快照恢复登录视图(user 非空)但 accessToken 还没拿到时,
  // 以退避节奏 + 回前台时机自动重试 refresh。成功(setToken)或凭证真失效
  // (401 清 user)都会让本 effect 的条件失效并自动停止。
  useEffect(() => {
    if (!initialized || !user || accessToken) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const scheduleNext = () => {
      if (cancelled) return;
      attempt += 1;
      const delay = Math.min(5_000 * 2 ** attempt, 60_000);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tryRefresh(), delay);
    };
    const tryRefresh = async () => {
      if (cancelled) return;
      try {
        const token = await refresh();
        if (cancelled) return;
        if (token) {
          await loadMe(token).catch(() => undefined);
          return;
        }
        // refresh 无异常返回 null 但不是 401(401 会清 user 让本 effect 停止):
        // 典型是 secure store 读取瞬时失败。凭证若确已不在,降级会话没有恢复
        // 可能,按登出收敛;凭证还在(读取抖动)则继续退避重试——两种情况都
        // 不能静默停止,否则降级态永远卡死(review P1)。注意读取异常不能与
        // 「读到空值」折叠:异常时无从判定凭证是否存在,只能继续退避,绝不能
        // 据此登出(二次 review P1)。
        let storedRefreshToken: string | null;
        try {
          storedRefreshToken = await getSecureItem(REFRESH_TOKEN_KEY);
        } catch {
          scheduleNext();
          return;
        }
        if (cancelled) return;
        if (!storedRefreshToken) {
          applyUser(null);
          return;
        }
        scheduleNext();
      } catch {
        scheduleNext();
      }
    };
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void tryRefresh();
    });
    void tryRefresh();
    return () => {
      cancelled = true;
      sub.remove();
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, applyUser, initialized, loadMe, refresh, user]);

  useEffect(() => {
    if (!initialized) return;
    if (user?.id) {
      void setTapdbUser(user.id);
    } else {
      void clearTapdbUser();
    }
  }, [initialized, user?.id]);

  const prepareOAuthLogin =
    useCallback(async (): Promise<OAuthLoginRequest> => {
      if (!FEISHU_APP_ID) throw new Error("缺少 EXPO_PUBLIC_FEISHU_APP_ID");
      setAuthError(null);
      const did = deviceId ?? (await ensureDeviceId());
      setDeviceId(did);
      const { codeVerifier, codeChallenge } = await createPkcePair();
      const state = `${MOBILE_OAUTH_STATE_PREFIX}${createState()}`;
      await setSecureItem(
        PENDING_OAUTH_KEY,
        JSON.stringify({
          codeVerifier,
          deviceId: did,
          state,
          createdAt: Date.now(),
        } satisfies PendingOAuth),
      );
      const redirectUri = `${API_BASE_URL}/api/auth/callback`;
      const params = new URLSearchParams({
        client_id: FEISHU_APP_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: OAUTH_SCOPE,
      });
      return {
        authUrl: `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`,
        redirectUri,
      };
    }, [deviceId]);

  const completeOAuthCallback = useCallback(
    async (callbackUrl: string) => {
      setIsBusy(true);
      try {
        const pending = await readPendingOAuth();
        await finishOAuthLogin(callbackUrl, pending, setToken, applyUser);
        setDeviceId(pending.deviceId);
      } finally {
        setIsBusy(false);
      }
    },
    [applyUser, setToken],
  );

  const loginWithFeishu = useCallback(async () => {
    if (!FEISHU_APP_ID) throw new Error("缺少 EXPO_PUBLIC_FEISHU_APP_ID");
    setAuthError(null);
    setIsBusy(true);
    try {
      const did = deviceId ?? (await ensureDeviceId());
      setDeviceId(did);
      // Only the native SDK detection / launch is allowed to fall back to the browser.
      // The server token exchange must NOT live inside this catch: once we already have a
      // code from Feishu, a login failure (expired/rejected code, network, server 5xx) has
      // to surface to the caller — otherwise it gets swallowed and the user is silently
      // re-prompted with a second (browser) login.
      let nativeCode: string | null = null;
      try {
        if (NATIVE_FEISHU_LOGIN_ENABLED && await isFeishuAppInstalled()) {
          nativeCode = await requestFeishuAuthCodeWithTimeout(FEISHU_APP_ID);
        }
      } catch {
        // Feishu not installed / native SDK launch failed or never returned (for example
        // a migration-period callback collision with an old installed app) → browser fallback.
        nativeCode = null;
      }

      if (nativeCode) {
        await finishOAuthLoginWithCode(nativeCode, did, setToken, applyUser);
        return;
      }

      const request = await prepareOAuthLogin();
      const result = await WebBrowser.openAuthSessionAsync(request.authUrl, MOBILE_REDIRECT_URL);
      if (result.type === "success") {
        await completeOAuthCallback(result.url);
      } else if (result.type === "cancel") {
        throw new Error("已取消飞书登录");
      } else {
        throw new Error("飞书登录未完成");
      }
    } finally {
      setIsBusy(false);
    }
  }, [applyUser, completeOAuthCallback, deviceId, prepareOAuthLogin, setToken]);

  // Complete OAuth when the app is re-opened via the lizcn://auth deep link. This is the
  // return path for the browser OAuth flow: the server bounces Feishu's https callback
  // to lizcn://auth?code=..., iOS re-opens the app, and we finish the PKCE exchange using
  // the pending state saved before the browser opened (survives an app restart). Double
  // completion is guarded by completeOAuthCallback clearing the pending key on success.
  useEffect(() => {
    const handleDeepLink = (url: string | null) => {
      if (!url || !url.startsWith(MOBILE_REDIRECT_URL)) return;
      // Surface failures (expired/mismatched state, OAuth error, network) — unlike the in-WebView
      // path there's no visible flow here, so a swallowed error would just strand the user on the
      // login screen with no feedback. The login screen renders auth.authError.
      void completeOAuthCallback(url).catch((err) => {
        setAuthError(err instanceof Error ? err.message : String(err));
      });
    };
    const sub = Linking.addEventListener("url", ({ url }) => handleDeepLink(url));
    void Linking.getInitialURL().then(handleDeepLink).catch(() => undefined);
    return () => sub.remove();
  }, [completeOAuthCallback]);

  const devLogin = useCallback(async () => {
    const did = deviceId ?? (await ensureDeviceId());
    setDeviceId(did);
    setIsBusy(true);
    try {
      const loginResult = await apiFetchRaw<LoginResponse>(
        "/api/auth/dev-login",
        {
          method: "POST",
          body: { deviceId: did },
        },
      );
      await setSecureItem(REFRESH_TOKEN_KEY, loginResult.refreshToken);
      await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
      setToken(loginResult.accessToken);
      applyUser(loginResult.user);
    } finally {
      setIsBusy(false);
    }
  }, [applyUser, deviceId, setToken]);

  const logout = useCallback(async () => {
    // Invalidate any in-flight refresh so it can't write a rotated token back after we log out.
    authGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    const token = accessTokenRef.current;
    const did = deviceId;
    setToken(null);
    applyUser(null);
    await clearAllMobileVoiceCredentials().catch(() => undefined);
    await clearMobileVoiceLiteLlmSettings().catch(() => undefined);
    await clearAllMobileVoiceInputHistories().catch(() => undefined);
    await clearCachedSessionMessages().catch(() => undefined);
    // 首页设备+会话快照与消息缓存一样属于账号数据,登出必须清掉,避免下个账号冷启动画出上个账号的列表。
    await clearCachedHomeListSnapshot().catch(() => undefined);
    // 内存缓存同步清:@ 资源(含文件路径)/ slash / 能力表按账号隔离,防止换号短暂串数据。
    resetComposerPaletteCache();
    resetAgentCapabilitiesCache();
    await deleteSecureItem(REFRESH_TOKEN_KEY).catch(() => undefined);
    if (token && did) {
      await apiFetchRaw("/api/auth/logout", {
        method: "POST",
        token,
        body: { deviceId: did },
      }).catch(() => undefined);
    }
  }, [deviceId, setToken]);

  const getAccessToken = useCallback(async () => {
    // Refresh proactively when the cached token is expired/near-expiry. Callers like the
    // device-link WS upgrade have no 401-retry, so handing them a stale JWT gets rejected.
    const cached = accessTokenRef.current;
    if (cached && !isAccessTokenExpiring(cached)) return cached;
    return refresh();
  }, [refresh]);

  const apiFetch = useCallback(
    async <T,>(path: string, opts: Omit<ApiFetchOptions, "token"> = {}) => {
      const token = await getAccessToken();
      if (!token) throw new Error("未登录");
      try {
        return await apiFetchRaw<T>(path, { ...opts, token });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          const fresh = await refresh();
          if (fresh) return apiFetchRaw<T>(path, { ...opts, token: fresh });
        }
        throw err;
      }
    },
    [getAccessToken, refresh],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      initialized,
      isBusy,
      // 以 user 为准而非 accessToken:弱网冷启动下 token 可能尚未刷到
      // (降级会话,由自愈 effect 补),但会话仍然有效,不能闪回登录页。
      // 凭证真失效(refresh 401)与登出都会把 user 清空,语义仍然收敛。
      isAuthenticated: user !== null,
      user,
      deviceId,
      prepareOAuthLogin,
      loginWithFeishu,
      authError,
      clearAuthError,
      devLogin,
      completeOAuthCallback,
      logout,
      getAccessToken,
      apiFetch,
    }),
    [
      accessToken,
      apiFetch,
      authError,
      clearAuthError,
      completeOAuthCallback,
      devLogin,
      deviceId,
      getAccessToken,
      initialized,
      isBusy,
      loginWithFeishu,
      logout,
      prepareOAuthLogin,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

async function readCachedUserProfile(): Promise<MobileUser | null> {
  try {
    const raw = await getSecureItem(USER_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MobileUser>;
    if (typeof parsed.id !== "string" || typeof parsed.name !== "string") return null;
    return parsed as MobileUser;
  } catch {
    return null;
  }
}

async function writeCachedUserProfile(user: MobileUser | null): Promise<void> {
  try {
    if (user) await setSecureItem(USER_PROFILE_KEY, JSON.stringify(user));
    else await deleteSecureItem(USER_PROFILE_KEY);
  } catch {
    // 快照是尽力而为的加速缓存,写失败不影响登录流程本身
  }
}

async function readPendingOAuth(): Promise<PendingOAuth> {
  const raw = await getSecureItem(PENDING_OAUTH_KEY);
  if (!raw) throw new Error("没有待完成的飞书登录，请先点一次飞书登录");

  const parsed = JSON.parse(raw) as Partial<PendingOAuth>;
  if (
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.deviceId !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.createdAt !== "number"
  ) {
    throw new Error("待完成的登录状态无效，请重新发起飞书登录");
  }
  if (Date.now() - parsed.createdAt > PENDING_OAUTH_MAX_AGE_MS) {
    await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
    throw new Error("飞书登录已过期，请重新发起登录");
  }
  return parsed as PendingOAuth;
}

async function finishOAuthLogin(
  callbackUrl: string,
  pending: Pick<PendingOAuth, "codeVerifier" | "deviceId" | "state">,
  setToken: (token: string | null) => void,
  setUser: (user: MobileUser | null) => void,
): Promise<void> {
  const callback = parseOAuthCallbackUrl(callbackUrl);
  if (callback.state !== pending.state) throw new Error("登录状态校验失败");

  const loginResult = await apiFetchRaw<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: {
      code: callback.code,
      codeVerifier: pending.codeVerifier,
      deviceId: pending.deviceId,
      // 手机是远程控制端:只需身份,不直接调飞书数据 API,故声明 mobile 让服务端放宽
      // scope / refresh_token 校验。浏览器兜底与原生 SDK 两条路径都声明,保持一致。
      clientType: "mobile",
    },
  });
  await persistLoginResult(loginResult, setToken, setUser);
}

async function finishOAuthLoginWithCode(
  code: string,
  deviceId: string,
  setToken: (token: string | null) => void,
  setUser: (user: MobileUser | null) => void,
): Promise<void> {
  const loginResult = await apiFetchRaw<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: {
      code,
      deviceId,
      // 原生 LarkSSO 登录:无 codeVerifier;声明 mobile 让服务端放宽 scope / refresh_token 校验。
      clientType: "mobile",
    },
  });
  await persistLoginResult(loginResult, setToken, setUser);
}

async function persistLoginResult(
  loginResult: LoginResponse,
  setToken: (token: string | null) => void,
  setUser: (user: MobileUser | null) => void,
): Promise<void> {
  await setSecureItem(REFRESH_TOKEN_KEY, loginResult.refreshToken);
  await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
  setToken(loginResult.accessToken);
  setUser(loginResult.user);
}
