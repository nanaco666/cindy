import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Linking } from 'react-native';
import {
  AuthApiError,
  CindyAuthClient,
  reduceAuthFlow,
  ssoOrgDiscoveryToMethods,
  type AuthFlowState,
  type AuthMembership,
  type LoginOutcome,
  type SocialProvider,
  type VerificationKind,
} from '@cindy/auth-client';

import { apiFetchRaw, ApiError, type ApiFetchOptions } from '@/api/client';
import {
  AUTH_API_BASE_URL,
  AUTH_REGION,
  IS_OTA_SELFHOST,
  MOBILE_VISUAL_MOCK_ENABLED,
  MOBILE_REDIRECT_URL,
  OAUTH_BROKER_API_BASE_URL,
} from '@/config/env';
import { syncCanaryChannelAfterAuth } from '@/auth/canaryChannelSync';
import { ensureDeviceId } from '@/auth/deviceId';
import { isAccessTokenExpiring } from '@/auth/jwt';
import { getAuthLocale } from '@/auth/loginMessages';
import { acquireNativeSocialCredential } from '@/auth/nativeSocial';
import {
  matchesOAuthCallbackUrl,
  parseOAuthCallbackUrl,
} from '@/auth/oauthCallback';
import { createPkcePair, createState } from '@/auth/pkce';
import { mergeMembershipWithExisting } from '@/auth/profileMerge';
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/auth/secureStorage';
import { clearTapdbUser, setTapdbUser } from '@/analytics/mobileTapdb';
import { resetAgentCapabilitiesCache } from '@/session/agentCapabilitiesCache';
import { resetComposerPaletteCache } from '@/session/composerPaletteCache';
import { clearCachedHomeListSnapshot } from '@/session/mobileHomeListCache';
import { clearCachedSessionMessages } from '@/session/mobileSessionMessageCache';
import { clearAllMobileVoiceCredentials } from '@/session/mobileVoiceCredentialStore';
import { clearAllMobileVoiceInputHistories } from '@/session/mobileVoiceHistoryStore';
import { clearMobileVoiceLiteLlmSettings } from '@/session/mobileVoiceLiteLlmSettings';
import { visualMockApiFetch, visualMockUser } from '@/debug/visualMock';
import {
  clearCanaryChannel,
  syncCanaryChannel,
} from '@/update/canaryChannelStore';

WebBrowser.maybeCompleteAuthSession();

const REFRESH_TOKEN_KEY = 'cindy.mobile.auth.refreshToken';
const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY =
  'cindy.mobile.auth.accountRefreshToken';
const LEGACY_REFRESH_TOKEN_KEY = 'xdt.mobile.refreshToken';
const USER_PROFILE_KEY = 'cindy.mobile.auth.userProfile';
const LEGACY_USER_PROFILE_KEY = 'xdt.mobile.userProfile';
const PENDING_OAUTH_KEY = 'cindy.mobile.auth.pendingOAuth';
const LEGACY_PENDING_OAUTH_KEY = 'xdt.mobile.pendingOAuth';
const PENDING_OAUTH_MAX_AGE_MS = 10 * 60 * 1000;
const AUTH_STARTUP_GATE_TIMEOUT_MS = 20 * 1000;
// 2026-07 产品 /api/user/me 退役:身份完全以 auth-server membership 为准,
// 原产品增强字段(role/isCanary/feishuId)一并下线(与 desktop 同步)。
export interface MobileUser {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  passportId: string;
}

export type MobileLoginAction =
  | { type: 'reset' }
  | { type: 'discover'; email: string }
  | { type: 'discover-sso-org'; org: string }
  | { type: 'request-code'; kind: VerificationKind; identifier: string }
  | {
      type: 'verify-code';
      kind: VerificationKind;
      identifier: string;
      code: string;
    }
  | { type: 'start-sso'; connectionId: string; label: string }
  | { type: 'native-social'; provider: SocialProvider }
  | { type: 'select-account'; accountId: string }
  | { type: 'request-sso-verification-code' }
  | { type: 'verify-sso-verification'; code: string }
  | { type: 'request-binding-code'; contact: string }
  | { type: 'verify-binding'; contact: string; code: string };

interface PendingOAuth {
  codeVerifier: string;
  deviceId: string;
  state: string;
  createdAt: number;
  label: string;
}

export interface AuthContextValue {
  initialized: boolean;
  isBusy: boolean;
  isAuthenticated: boolean;
  user: MobileUser | null;
  deviceId: string | null;
  loginState: AuthFlowState | null;
  authError: string | null;
  clearAuthError(): void;
  dispatchLoginAction(action: MobileLoginAction): Promise<boolean>;
  completeOAuthCallback(callbackUrl: string): Promise<void>;
  logout(): Promise<void>;
  getAccessToken(): Promise<string | null>;
  apiFetch<T>(path: string, opts: Omit<ApiFetchOptions, 'token'>): Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Owns auth-server credentials and login tickets for the mobile process. */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (MOBILE_VISUAL_MOCK_ENABLED) {
    const value: AuthContextValue = {
      initialized: true,
      isBusy: false,
      isAuthenticated: true,
      user: visualMockUser,
      deviceId: 'visual-mock-phone',
      loginState: null,
      authError: null,
      clearAuthError: () => undefined,
      dispatchLoginAction: async () => true,
      completeOAuthCallback: async () => undefined,
      logout: async () => undefined,
      getAccessToken: async () => 'visual-mock-token',
      apiFetch: visualMockApiFetch,
    };
    return (
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    );
  }

  const [initialized, setInitialized] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  // Account token 只在本次登录的 Membership 选择阶段存活；成功兑换
  // resource token 后清空，不写 SecureStore、不续期、不参与业务请求或登出。
  const pendingAccountTokenRef = useRef<string | null>(null);
  const [user, setUser] = useState<MobileUser | null>(null);
  const userRef = useRef<MobileUser | null>(null);
  const [loginState, setLoginState] = useState<AuthFlowState | null>(null);
  const loginStateRef = useRef<AuthFlowState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const pendingLoginTicketRef = useRef<string | null>(null);
  const pendingBindTicketRef = useRef<string | null>(null);
  const pendingSsoVerificationTicketRef = useRef<string | null>(null);
  const loginActionInFlightRef = useRef<Promise<boolean> | null>(null);
  const browserCompletionRef = useRef<Promise<void> | null>(null);
  // auth-server rotates refresh tokens, so every caller must share one request.
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  // Logout bumps this generation so a late refresh cannot resurrect the session.
  const authGenerationRef = useRef(0);
  // SecureStore operations are asynchronous. Serialize mutations so logout always
  // wins over a refresh/login write that was already inside the native storage call.
  const refreshTokenMutationRef = useRef<Promise<void>>(Promise.resolve());
  const userProfileMutationRef = useRef<Promise<void>>(Promise.resolve());

  /** 登录态落地后异步刷新灰度标记；失败保留旧值，迟到响应按 auth generation 丢弃。 */
  const scheduleCanaryChannelSync = useCallback(
    (token: string, expectedAuthGeneration: number) => {
      // EAS/TestFlight 仍走 Expo 官方更新通道，不参与自建线 canary flag 请求；
      // 这样自建灰度新增的状态机不会改变 EAS 登录/发版流程。
      if (!IS_OTA_SELFHOST) return;
      void syncCanaryChannelAfterAuth(
        { token, expectedAuthGeneration },
        {
          fetchFeatureFlags: (accessToken) =>
            apiFetchRaw('/api/user/feature-flags', {
              baseUrl: OAUTH_BROKER_API_BASE_URL,
              token: accessToken,
            }),
          readCurrentAuthGeneration: () => authGenerationRef.current,
          persistFlag: syncCanaryChannel,
        },
      ).catch(() => undefined);
    },
    [],
  );

  const serializeRefreshTokenMutation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const run = refreshTokenMutationRef.current.then(operation, operation);
      refreshTokenMutationRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  const serializeUserProfileMutation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const run = userProfileMutationRef.current.then(operation, operation);
      userProfileMutationRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  const updateLoginState = useCallback((next: AuthFlowState | null) => {
    loginStateRef.current = next;
    setLoginState(next);
  }, []);

  const setToken = useCallback((token: string | null) => {
    accessTokenRef.current = token;
    setAccessToken(token);
  }, []);

  // 用户资料的唯一写入口:同步 state + 持久化快照。快照让弱网冷启动能先以
  // 缓存资料恢复“已登录”视图,token 由后台刷新补齐。
  const applyUser = useCallback(
    (next: MobileUser | null) => {
      userRef.current = next;
      setUser(next);
      void serializeUserProfileMutation(() => writeCachedUserProfile(next));
    },
    [serializeUserProfileMutation],
  );

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const loadMe = useCallback(
    async (
      token: string,
      did: string,
      expectedGeneration = authGenerationRef.current,
    ): Promise<void> => {
      // 2026-07 起只拉 auth-server 身份(产品 /api/user/me 已退役)。
      const identityResult = await authClientFor(did)
        .getMe(token)
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          () => ({ status: 'rejected' as const }),
        );
      if (authGenerationRef.current !== expectedGeneration) return;

      if (identityResult.status === 'fulfilled') {
        const next = mergeMembershipWithExisting(
          identityResult.value.membership,
          userRef.current,
          identityResult.value.passportId,
        );
        applyUser(next);
      }
    },
    [applyUser],
  );

  const acceptOutcome = useCallback(
    async (outcome: LoginOutcome, did: string): Promise<void> => {
      await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);

      pendingAccountTokenRef.current =
        outcome.status === 'select_account'
          ? (outcome.accountToken ?? null)
          : null;

      if (outcome.status === 'select_account') {
        pendingLoginTicketRef.current = outcome.loginTicket;
        pendingBindTicketRef.current = null;
        pendingSsoVerificationTicketRef.current = null;
        updateLoginState(
          reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
        );
        return;
      }
      if (outcome.status === 'binding_required') {
        pendingBindTicketRef.current = outcome.bindTicket;
        pendingLoginTicketRef.current = null;
        pendingSsoVerificationTicketRef.current = null;
        updateLoginState(
          reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
        );
        return;
      }
      if (outcome.status === 'sso_verification_required') {
        pendingSsoVerificationTicketRef.current = outcome.verificationTicket;
        pendingLoginTicketRef.current = null;
        pendingBindTicketRef.current = null;
        updateLoginState(
          reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
        );
        return;
      }

      const generation = ++authGenerationRef.current;
      refreshInFlightRef.current = null;
      const persisted = await serializeRefreshTokenMutation(async () => {
        if (authGenerationRef.current !== generation) return false;
        await setSecureItem(REFRESH_TOKEN_KEY, outcome.refreshToken);
        return authGenerationRef.current === generation;
      });
      if (!persisted) throw authCodeError('AUTH_FLOW_SUPERSEDED');
      if (authGenerationRef.current !== generation)
        throw authCodeError('AUTH_FLOW_SUPERSEDED');

      pendingLoginTicketRef.current = null;
      pendingBindTicketRef.current = null;
      pendingSsoVerificationTicketRef.current = null;
      setToken(outcome.accessToken);
      applyUser(
        mergeMembershipWithExisting(outcome.membership, userRef.current),
      );
      scheduleCanaryChannelSync(outcome.accessToken, generation);
      updateLoginState(
        reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
      );
      // Identity is already durable. Product preferences/profile hydration is best effort
      // and must not turn a successful login into an error on a transient downstream outage.
      void loadMe(outcome.accessToken, did, generation).catch(() => undefined);
    },
    [
      applyUser,
      loadMe,
      scheduleCanaryChannelSync,
      serializeRefreshTokenMutation,
      setToken,
      updateLoginState,
    ],
  );

  const refresh = useCallback(
    (knownDeviceId?: string): Promise<string | null> => {
      if (refreshInFlightRef.current) return refreshInFlightRef.current;
      const generation = authGenerationRef.current;
      let run: Promise<string | null>;
      const clearIfCurrent = () => {
        if (refreshInFlightRef.current === run)
          refreshInFlightRef.current = null;
      };
      run = (async () => {
        const did =
          knownDeviceId ?? deviceIdRef.current ?? (await ensureDeviceId());
        deviceIdRef.current = did;
        const refreshToken = await serializeRefreshTokenMutation(() =>
          getSecureItem(REFRESH_TOKEN_KEY).catch(() => null),
        );
        if (!refreshToken) {
          await clearCanaryChannel().catch(() => undefined);
          return null;
        }
        try {
          const pair = await authClientFor(did).refresh(refreshToken);
          if (authGenerationRef.current !== generation) return null;
          const persisted = await serializeRefreshTokenMutation(async () => {
            if (authGenerationRef.current !== generation) return false;
            await setSecureItem(REFRESH_TOKEN_KEY, pair.refreshToken);
            return authGenerationRef.current === generation;
          });
          if (!persisted) return null;
          if (authGenerationRef.current !== generation) return null;
          setToken(pair.accessToken);
          applyUser(
            mergeMembershipWithExisting(pair.membership, userRef.current),
          );
          scheduleCanaryChannelSync(pair.accessToken, generation);
          void loadMe(pair.accessToken, did, generation).catch(() => undefined);
          return pair.accessToken;
        } catch (error) {
          if (authGenerationRef.current !== generation) return null;
          if (isRejectedRefresh(error)) {
            const cleared = await serializeRefreshTokenMutation(async () => {
              if (authGenerationRef.current !== generation) return false;
              await deleteSecureItem(REFRESH_TOKEN_KEY).catch(() => undefined);
              return authGenerationRef.current === generation;
            });
            if (!cleared) return null;
            setToken(null);
            applyUser(null);
            await clearCanaryChannel().catch(() => undefined);
            updateLoginState(null);
            pendingLoginTicketRef.current = null;
            pendingBindTicketRef.current = null;
            return null;
          }
          throw error;
        }
      })();
      refreshInFlightRef.current = run;
      run.then(clearIfCurrent, clearIfCurrent);
      return run;
    },
    [
      applyUser,
      loadMe,
      scheduleCanaryChannelSync,
      serializeRefreshTokenMutation,
      setToken,
      updateLoginState,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsBusy(true);
      try {
        const did = await ensureDeviceId();
        if (cancelled) return;
        deviceIdRef.current = did;
        setDeviceId(did);
        // Old Feishu refresh tokens are not valid in auth-server. Purge them explicitly
        // instead of sending them to the new endpoint or restoring an unrelated profile.
        await Promise.all([
          // 早期测试版曾持久化 account refresh token；现在仅保留登录期内存 token。
          deleteSecureItem(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY).catch(
            () => undefined,
          ),
          deleteSecureItem(LEGACY_REFRESH_TOKEN_KEY).catch(() => undefined),
          deleteSecureItem(LEGACY_PENDING_OAUTH_KEY).catch(() => undefined),
          deleteSecureItem(LEGACY_USER_PROFILE_KEY).catch(() => undefined),
        ]);
        const [storedRefreshToken, cachedUser] = await Promise.all([
          getSecureItem(REFRESH_TOKEN_KEY).catch(() => null),
          readCachedUserProfile(),
        ]);
        // 弱网冷启动:先用本地会话痕迹恢复已登录视图,再走网络刷新。
        if (storedRefreshToken && cachedUser) {
          userRef.current = cachedUser;
          setUser(cachedUser);
        }
        if (!storedRefreshToken)
          await deleteSecureItem(USER_PROFILE_KEY).catch(() => undefined);
        try {
          await awaitAuthStartupGate(
            refresh(did),
            AUTH_STARTUP_GATE_TIMEOUT_MS,
          );
        } catch {
          // transient:保留降级会话,由下方自愈 effect 自动补刷 token。
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
  }, [refresh]);

  // 降级会话自愈:有缓存用户但尚未取得 access token 时,以退避节奏和回前台时机重试。
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
        if (token) return;
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
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void tryRefresh();
    });
    void tryRefresh();
    return () => {
      cancelled = true;
      subscription.remove();
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, applyUser, initialized, refresh, user]);

  useEffect(() => {
    if (!initialized) return;
    if (user?.id) void setTapdbUser(user.id);
    else void clearTapdbUser();
  }, [initialized, user?.id]);

  const completeOAuthCallback = useCallback(
    (callbackUrl: string): Promise<void> => {
      if (browserCompletionRef.current) return browserCompletionRef.current;
      const run = (async () => {
        setIsBusy(true);
        try {
          if (!matchesOAuthCallbackUrl(callbackUrl, MOBILE_REDIRECT_URL)) {
            throw authCodeError('INVALID_AUTH_CODE');
          }
          const pending = await readPendingOAuth();
          const callback = parseOAuthCallbackUrl(callbackUrl);
          if (callback.state !== pending.state)
            throw authCodeError('STATE_MISMATCH');
          const outcome = await authClientFor(
            pending.deviceId,
          ).exchangeAuthorizationCode(callback.code, pending.codeVerifier);
          deviceIdRef.current = pending.deviceId;
          setDeviceId(pending.deviceId);
          await acceptOutcome(outcome, pending.deviceId);
          setAuthError(null);
        } catch (error) {
          const code = authErrorCode(error);
          if (code === 'INVALID_AUTH_CODE') {
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            updateLoginState(null);
          }
          setAuthError(code);
          throw error;
        } finally {
          setIsBusy(false);
        }
      })();
      browserCompletionRef.current = run;
      run.then(
        () => {
          if (browserCompletionRef.current === run)
            browserCompletionRef.current = null;
        },
        () => {
          if (browserCompletionRef.current === run)
            browserCompletionRef.current = null;
        },
      );
      return run;
    },
    [acceptOutcome, updateLoginState],
  );

  // SSO returns through cindycn://auth or cindy://auth. The pending PKCE verifier
  // lives in SecureStore so a browser-triggered app restart can still finish safely.
  useEffect(() => {
    const handleDeepLink = (url: string | null) => {
      if (!url || !matchesOAuthCallbackUrl(url, MOBILE_REDIRECT_URL)) return;
      void completeOAuthCallback(url).catch(() => undefined);
    };
    const subscription = Linking.addEventListener('url', ({ url }) =>
      handleDeepLink(url),
    );
    void Linking.getInitialURL()
      .then(handleDeepLink)
      .catch(() => undefined);
    return () => subscription.remove();
  }, [completeOAuthCallback]);

  const dispatchLoginAction = useCallback(
    (action: MobileLoginAction): Promise<boolean> => {
      if (loginActionInFlightRef.current) return loginActionInFlightRef.current;
      let run: Promise<boolean>;
      const clearIfCurrent = () => {
        if (loginActionInFlightRef.current === run)
          loginActionInFlightRef.current = null;
      };
      run = (async () => {
        setIsBusy(true);
        setAuthError(null);
        try {
          const did = deviceIdRef.current ?? (await ensureDeviceId());
          deviceIdRef.current = did;
          setDeviceId(did);
          const client = authClientFor(did);

          if (action.type === 'reset') {
            pendingAccountTokenRef.current = null;
            pendingLoginTicketRef.current = null;
            pendingBindTicketRef.current = null;
            pendingSsoVerificationTicketRef.current = null;
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            const providers = await client.getProviders();
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'providers-loaded',
                providers,
              }),
            );
            return true;
          }
          if (action.type === 'discover') {
            const email = action.email.trim().toLowerCase();
            const methods = await client.discover(email);
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'discovery-loaded',
                email,
                methods,
              }),
            );
            return true;
          }
          // 企业 SSO 入口（按组织 ID/slug/已验证域名）：结果映射进 method-choice，
          // 复用连接选择 UI 与 start-sso 流程。
          if (action.type === 'discover-sso-org') {
            const discovery = await client.discoverSsoOrg(
              action.org.trim().toLowerCase(),
            );
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'discovery-loaded',
                email: '',
                methods: ssoOrgDiscoveryToMethods(discovery),
              }),
            );
            return true;
          }
          if (action.type === 'request-code') {
            const identifier = action.identifier.trim();
            await client.requestCode(action.kind, identifier);
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'code-requested',
                kind: action.kind,
                identifier,
              }),
            );
            return true;
          }
          if (action.type === 'verify-code') {
            await acceptOutcome(
              await client.verifyCode(
                action.kind,
                action.identifier.trim(),
                action.code,
              ),
              did,
            );
            return true;
          }
          if (action.type === 'native-social') {
            const credential = await acquireNativeSocialCredential(
              action.provider,
            );
            await acceptOutcome(
              await client.exchangeNativeSocial(action.provider, credential),
              did,
            );
            return true;
          }
          if (action.type === 'start-sso') {
            const previousState = loginStateRef.current;
            const { codeVerifier, codeChallenge } = await createPkcePair();
            const state = createState();
            await setSecureItem(
              PENDING_OAUTH_KEY,
              JSON.stringify({
                codeVerifier,
                deviceId: did,
                state,
                createdAt: Date.now(),
                label: action.label,
              } satisfies PendingOAuth),
            );
            updateLoginState(
              reduceAuthFlow(previousState, {
                type: 'browser-started',
                label: action.label,
              }),
            );
            const authUrl = client.buildAuthorizeUrl({
              kind: 'sso',
              providerOrConnectionId: action.connectionId,
              redirectUri: MOBILE_REDIRECT_URL,
              codeChallenge,
              state,
            });
            const result = await WebBrowser.openAuthSessionAsync(
              authUrl,
              MOBILE_REDIRECT_URL,
            );
            if (result.type === 'success') {
              await completeOAuthCallback(result.url);
              return true;
            }
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            updateLoginState(previousState);
            throw authCodeError('USER_CANCELLED');
          }
          if (action.type === 'select-account') {
            const accountToken = pendingAccountTokenRef.current;
            if (accountToken) {
              const pair = await client.exchangeAccountMembership(
                accountToken,
                action.accountId,
              );
              pendingAccountTokenRef.current = null;
              await acceptOutcome({ status: 'ok', ...pair }, did);
              return true;
            }
            const ticket = pendingLoginTicketRef.current;
            if (!ticket) throw authCodeError('INVALID_LOGIN_TICKET');
            await acceptOutcome(
              await client.selectAccount(ticket, action.accountId),
              did,
            );
            return true;
          }

          if (action.type === 'request-sso-verification-code') {
            const ticket = pendingSsoVerificationTicketRef.current;
            const state = loginStateRef.current;
            if (!ticket || state?.step !== 'sso-verification') {
              throw authCodeError('INVALID_SSO_VERIFICATION_TICKET');
            }
            await client.requestSsoVerificationCode(ticket);
            updateLoginState(
              reduceAuthFlow(state, {
                type: 'sso-verification-code-requested',
                channel: state.channel,
                targetMasked: state.targetMasked,
              }),
            );
            return true;
          }

          if (action.type === 'verify-sso-verification') {
            const ticket = pendingSsoVerificationTicketRef.current;
            if (!ticket || loginStateRef.current?.step !== 'sso-verification') {
              throw authCodeError('INVALID_SSO_VERIFICATION_TICKET');
            }
            await acceptOutcome(
              await client.verifySsoVerification(ticket, action.code),
              did,
            );
            return true;
          }

          const bindTicket = pendingBindTicketRef.current;
          const state = loginStateRef.current;
          if (!bindTicket || state?.step !== 'binding')
            throw authCodeError('INVALID_BIND_TICKET');
          if (action.type === 'request-binding-code') {
            const contact = action.contact.trim();
            await client.requestBindingCode(
              bindTicket,
              state.bindType,
              contact,
            );
            updateLoginState(
              reduceAuthFlow(state, {
                type: 'binding-code-requested',
                bindType: state.bindType,
                contact,
              }),
            );
            return true;
          }
          await acceptOutcome(
            await client.verifyBinding(
              bindTicket,
              state.bindType,
              action.contact.trim(),
              action.code,
            ),
            did,
          );
          return true;
        } catch (error) {
          const code = authErrorCode(error);
          if (
            code === 'INVALID_LOGIN_TICKET' ||
            code === 'INVALID_BIND_TICKET' ||
            code === 'INVALID_SSO_VERIFICATION_TICKET' ||
            code === 'INVALID_TOKEN' ||
            code === 'TOKEN_EXPIRED'
          ) {
            pendingAccountTokenRef.current = null;
            pendingLoginTicketRef.current = null;
            pendingBindTicketRef.current = null;
            pendingSsoVerificationTicketRef.current = null;
            updateLoginState(null);
          }
          setAuthError(code);
          return false;
        } finally {
          setIsBusy(false);
        }
      })();
      loginActionInFlightRef.current = run;
      run.then(clearIfCurrent, clearIfCurrent);
      return run;
    },
    [acceptOutcome, completeOAuthCallback, updateLoginState],
  );

  const logout = useCallback(async () => {
    authGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    const token = accessTokenRef.current;
    const did = deviceIdRef.current;
    setToken(null);
    applyUser(null);
    updateLoginState(null);
    pendingAccountTokenRef.current = null;
    pendingLoginTicketRef.current = null;
    pendingBindTicketRef.current = null;
    pendingSsoVerificationTicketRef.current = null;
    await clearAllMobileVoiceCredentials().catch(() => undefined);
    await clearMobileVoiceLiteLlmSettings().catch(() => undefined);
    await clearAllMobileVoiceInputHistories().catch(() => undefined);
    await clearCachedSessionMessages().catch(() => undefined);
    // 首页设备+会话快照与消息缓存一样属于账号数据,登出必须清掉。
    await clearCachedHomeListSnapshot().catch(() => undefined);
    resetComposerPaletteCache();
    resetAgentCapabilitiesCache();
    await clearCanaryChannel().catch(() => undefined);
    await serializeRefreshTokenMutation(() =>
      deleteSecureItem(REFRESH_TOKEN_KEY).catch(() => undefined),
    );
    await Promise.all([
      serializeUserProfileMutation(() =>
        deleteSecureItem(USER_PROFILE_KEY).catch(() => undefined),
      ),
      deleteSecureItem(LEGACY_REFRESH_TOKEN_KEY).catch(() => undefined),
      deleteSecureItem(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY).catch(() => undefined),
      deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined),
      deleteSecureItem(LEGACY_PENDING_OAUTH_KEY).catch(() => undefined),
      deleteSecureItem(LEGACY_USER_PROFILE_KEY).catch(() => undefined),
    ]);
    if (token && did)
      await authClientFor(did)
        .logout(token)
        .catch(() => undefined);
  }, [
    applyUser,
    serializeRefreshTokenMutation,
    serializeUserProfileMutation,
    setToken,
    updateLoginState,
  ]);

  const getAccessToken = useCallback(async () => {
    const cached = accessTokenRef.current;
    if (cached && !isAccessTokenExpiring(cached)) return cached;
    return refresh();
  }, [refresh]);

  // 带 Bearer + 401 自动 refresh 的业务请求封装;目标服务由调用方经
  // opts.baseUrl 显式指定(老主 server xdt-api 已退役,没有默认业务 server)。
  const apiFetch = useCallback(
    async <T,>(
      path: string,
      opts: Omit<ApiFetchOptions, 'token'>,
    ): Promise<T> => {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHENTICATED');
      try {
        return await apiFetchRaw<T>(path, { ...opts, token });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          const fresh = await refresh();
          if (fresh) return apiFetchRaw<T>(path, { ...opts, token: fresh });
        }
        throw error;
      }
    },
    [getAccessToken, refresh],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      initialized,
      isBusy,
      // 以 user 为准:弱网冷启动 token 可能尚未刷到,但会话仍可降级恢复。
      isAuthenticated: user !== null,
      user,
      deviceId,
      loginState,
      authError,
      clearAuthError,
      dispatchLoginAction,
      completeOAuthCallback,
      logout,
      getAccessToken,
      apiFetch,
    }),
    [
      apiFetch,
      authError,
      clearAuthError,
      completeOAuthCallback,
      deviceId,
      dispatchLoginAction,
      getAccessToken,
      initialized,
      isBusy,
      loginState,
      logout,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

function authClientFor(deviceId: string): CindyAuthClient {
  return new CindyAuthClient({
    baseUrl: AUTH_API_BASE_URL,
    // auth 协议只有 cn/global 两条线;dev 目标行为语义归 cn 系(实际连的
    // dev-auth 服务器由 AUTH_API_BASE_URL 决定,与线别参数正交)。
    region: AUTH_REGION === 'global' ? 'global' : 'cn',
    deviceId,
    clientType: 'mobile',
    locale: getAuthLocale(),
    fetch: async (input, init) => fetch(input, init),
  });
}

// mapMembershipToMobileUser / mergeMembershipWithExisting
// 已抽至 @/auth/profileMerge(纯函数,便于单测)。

/** Unblocks initial rendering without aborting a rotating refresh-token request. */
function awaitAuthStartupGate<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
    operation.then(
      (value) => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRejectedRefresh(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    (error.statusCode === 401 ||
      error.code.includes('REFRESH_TOKEN') ||
      error.code === 'MEMBERSHIP_DISABLED')
  );
}

function authErrorCode(error: unknown): string {
  if (error instanceof AuthApiError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (
        [
          'ERR_REQUEST_CANCELED',
          'ERR_WECHAT_CANCELLED',
          'SIGN_IN_CANCELLED',
        ].includes(code)
      ) {
        return 'USER_CANCELLED';
      }
      return code;
    }
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message))
    return error.message;
  return 'AUTH_REQUEST_FAILED';
}

function authCodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function readCachedUserProfile(): Promise<MobileUser | null> {
  try {
    const raw = await getSecureItem(USER_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MobileUser>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string' ||
      (parsed.membershipKind !== 'personal' && parsed.membershipKind !== 'org')
    )
      return null;
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
    // Snapshot persistence is best effort and never blocks the auth flow.
  }
}

async function readPendingOAuth(): Promise<PendingOAuth> {
  const raw = await getSecureItem(PENDING_OAUTH_KEY);
  if (!raw) throw authCodeError('INVALID_AUTH_CODE');
  let parsed: Partial<PendingOAuth>;
  try {
    parsed = JSON.parse(raw) as Partial<PendingOAuth>;
  } catch {
    throw authCodeError('INVALID_AUTH_CODE');
  }
  if (
    typeof parsed.codeVerifier !== 'string' ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.state !== 'string' ||
    typeof parsed.createdAt !== 'number' ||
    typeof parsed.label !== 'string'
  )
    throw authCodeError('INVALID_AUTH_CODE');
  if (Date.now() - parsed.createdAt > PENDING_OAUTH_MAX_AGE_MS) {
    await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
    throw authCodeError('INVALID_AUTH_CODE');
  }
  return parsed as PendingOAuth;
}
