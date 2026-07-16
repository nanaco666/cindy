import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { providerSecretStorageKey } from '../../shared/providerSecrets';

const log = createLogger('UseApiKey');

/** XD 网关 key 的本机 safeStorage 存储键名(SSoT,见 shared/providerSecrets)。 */
const XD_STORAGE_KEY = providerSecretStorageKey('xd');

/**
 * 统一 tag —— 所有 api-key 链路的日志都挂这个前缀,
 * 排查时只需 `grep [apikey-trace] main.log` 一把抓出全链路。
 *
 * 隐私设计:XD 网关 key 是 **本地 only**,从不同步 / 上传到服务器
 * (Electron safeStorage,委托 OS keychain/DPAPI 加密)。旧服务端同步端点已删除,
 * 这里只读写本地密钥。
 */
const TAG = '[apikey-trace]';

/**
 * 取 key 末 4 位用于排查日志 ——
 * 只用于本地排查日志里的同 key 识别。单独看任何一条都不能还原 key。
 */
function keyTail(k: string | null | undefined): string {
  if (!k) return '<empty>';
  if (k.length <= 4) return '<short>';
  return k.slice(-4);
}

/**
 * 模块级 reconcile 去重 ——
 * useApiKey 现在被 Settings / useVendorReadiness 消费,
 * 没有去重的话每个 mount 都会各自 safeStorageRead, 同时 mount 时还会打两份
 * [apikey-trace] reconcile 日志, 制造噪音。
 *
 * 设计:
 * - 第一个 mount 启动 reconcile (本地 safeStorage 读), promise 缓存到 module 级
 * - 后续 mount 拿同一个 promise (resolve 后立即拿到结果, 不再重复 IPC)
 * - saveKey / clearKey 成功后 invalidate, 下次 mount 重新读一次保险
 *
 * 不缓存最终值本身 —— 跨 consumer 同步 (saveKey 后 useVendorReadiness 的
 * hasSavedKey 自动刷新) 走 broadcastApiKeyChange, 这里只解决重复读。
 */
type ReconcileResult = { savedKey: string | null };
let initialReconcileInFlight: Promise<ReconcileResult> | null = null;

/**
 * 本地 only —— 只读 Electron safeStorage,不再向服务器 GET。XD 网关 key 从不
 * 上云,新设备 / 新登录不会自动继承别处配过的 key,用户需在本机重新填入。
 */
async function performReconcile(): Promise<ReconcileResult> {
  let localKey: string | null = null;
  try {
    localKey = await window.electronAPI.safeStorageRead(XD_STORAGE_KEY);
  } catch (err) {
    log.error(TAG, 'reconcile.local.read.failed', 'err=' + String(err));
  }
  log.info(
    TAG,
    'reconcile.local',
    'localKey=' + (localKey ? 'present' : 'absent'),
    'tail=' + keyTail(localKey),
  );
  return { savedKey: localKey };
}

function reconcileSavedKeyOnce(): Promise<ReconcileResult> {
  if (initialReconcileInFlight) return initialReconcileInFlight;
  initialReconcileInFlight = performReconcile();
  return initialReconcileInFlight;
}

function invalidateReconcileCache(): void {
  initialReconcileInFlight = null;
}

/**
 * 跨 useApiKey() 实例的同步广播。
 *
 * 背景:useApiKey 是普通 React hook,每个 consumer (ApiKeySection / ProvidersSection /
 * ChatInput pre-check 等) 都有独立的 useState。某个实例 saveKey/clearKey 成功只
 * 改自己的 state,其它已挂载的实例不会感知 —— 典型症状:在一处保存/断开成功了,
 * 但另一处的 hasSavedKey 还是旧值、UI 不刷新,用户看着像"按钮没反应"。
 *
 * invalidateReconcileCache 只对"未来 mount"起效,救不了"已经挂着但还没
 * unmount"的 consumer。这里加一个 module 级 listener 集合:每个 hook 实例
 * 订阅,save/clear 成功广播新值,所有实例同步刷新本地 state。
 */
type ApiKeyChangeListener = (newKey: string | null) => void;
const apiKeyChangeListeners = new Set<ApiKeyChangeListener>();
function broadcastApiKeyChange(newKey: string | null): void {
  apiKeyChangeListeners.forEach((fn) => {
    try {
      fn(newKey);
    } catch (err) {
      log.error(TAG, 'broadcast.listener.threw', 'err=' + String(err));
    }
  });
}

/**
 * 切账号防污染 —— logout / login 不重启 renderer 进程(见 schedulesStore.ts),
 * 模块级 reconcile 缓存 + 各实例 state 会残留上一个账号的 key。main 端已在
 * login / 冷启动 reconcileOwner 对账过本机文件(换账号清、同账号留),这里只负责让
 * renderer 丢弃缓存并重读后广播,确保切到另一个账号后 UI 不显示上一个账号的残留 key。
 *
 * 模块加载时挂一次(进程级,不卸载,与 schedulesStore 范式一致)。
 */
function handleAuthStateChangeForApiKey(state: AuthStateChangePayload): void {
  invalidateReconcileCache();
  if (!state.isAuthenticated) {
    // 登出:立即把所有挂载实例重置为 needs-config,不再显示旧账号的 key。
    broadcastApiKeyChange(null);
    return;
  }
  // 登录:重新 reconcile(读 main 已对账后的本地文件)并广播给所有挂载实例。
  void reconcileSavedKeyOnce().then(({ savedKey }) => {
    broadcastApiKeyChange(savedKey);
  });
}

if (typeof window !== 'undefined' && window.electronAPI?.onAuthStateChange) {
  window.electronAPI.onAuthStateChange(handleAuthStateChangeForApiKey);
}

export type ApiKeyStatus = 'needs-config' | 'saved' | 'connected' | 'error';

export interface UseApiKeyReturn {
  key: string;
  setKey: (value: string) => void;
  savedKey: string | null;
  status: ApiKeyStatus;
  errorMessage: string | null;
  isSaving: boolean;
  isTesting: boolean;
  isClearing: boolean;
  hasSavedKey: boolean;
  /**
   * mount 时 reconcile (safeStorage 读) 还没完成时为 true。
   * consumer 用它避免在 reconcile 完成前误判为"没 Key"——reconcile 完成后才能
   * 区分"本地真没 Key"和"还没读到"。
   */
  isReconciling: boolean;
  /** 返回保存是否成功：true=已存盘，false=校验/测试/本地存储任一失败。 */
  saveKey: () => Promise<boolean>;
  testConnection: () => Promise<void>;
  clearKey: () => Promise<boolean>;
  validationError: string | null;
  saveSuccess: boolean;
}

export function useApiKey(): UseApiKeyReturn {
  const { t } = useTranslation();
  const [key, setKeyState] = useState('');
  const [status, setStatus] = useState<ApiKeyStatus>('needs-config');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [isReconciling, setIsReconciling] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const saveSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedKeyRef = useRef<string>('');
  const isClearingRef = useRef(false);

  // Initialize: 多个 useApiKey() consumer 共享同一份 reconcile 结果, 不重复
  // safeStorageRead (见模块顶部 reconcileSavedKeyOnce 注释)。
  // mount 阶段 cancelled 标志位防卸载后 setState (StrictMode 重挂 / 路由切换)。
  useEffect(() => {
    let cancelled = false;
    void reconcileSavedKeyOnce().then(({ savedKey }) => {
      if (cancelled) return;
      if (savedKey) {
        setKeyState(savedKey);
        savedKeyRef.current = savedKey;
        setHasSavedKey(true);
        setStatus('saved');
      } else {
        setKeyState('');
        savedKeyRef.current = '';
        setHasSavedKey(false);
        setStatus('needs-config');
      }
      setIsReconciling(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cleanup saveSuccess timer on unmount
  useEffect(() => {
    return () => {
      if (saveSuccessTimerRef.current) {
        clearTimeout(saveSuccessTimerRef.current);
      }
    };
  }, []);

  // 订阅跨实例广播 —— 别的 useApiKey() 实例 save/clear 成功后通过
  // broadcastApiKeyChange 通知所有挂载中的实例,直接同步本地 state,
  // 不必等下次 mount 或 reconcile。
  useEffect(() => {
    const listener: ApiKeyChangeListener = (newKey) => {
      if (newKey) {
        setKeyState(newKey);
        savedKeyRef.current = newKey;
        setHasSavedKey(true);
        setStatus('saved');
        setErrorMessage(null);
        setValidationError(null);
      } else {
        setKeyState('');
        savedKeyRef.current = '';
        setHasSavedKey(false);
        setStatus('needs-config');
        setErrorMessage(null);
        setValidationError(null);
      }
    };
    apiKeyChangeListeners.add(listener);
    return () => {
      apiKeyChangeListeners.delete(listener);
    };
  }, []);

  const setKey = useCallback((value: string) => {
    setKeyState(value);
    setValidationError(null);
  }, []);

  const saveKey = useCallback(async (): Promise<boolean> => {
    setValidationError(null);
    setErrorMessage(null);

    // If key is empty, remove saved key
    if (key.trim() === '') {
      let result: { success: boolean; error?: string };
      try {
        result = await window.electronAPI.safeStorageRemove(XD_STORAGE_KEY);
      } catch {
        setErrorMessage(t('logic.errors.apiKeySafeStorageFailed'));
        return false;
      }
      if (!result.success) {
        setErrorMessage(t('logic.errors.apiKeySafeStorageFailed'));
        return false;
      }
      savedKeyRef.current = '';
      setHasSavedKey(false);
      setStatus('needs-config');
      broadcastApiKeyChange(null);
      return true;
    }

    // Validate sk- prefix
    if (!key.startsWith('sk-')) {
      setValidationError(t('logic.validation.apiKeyFormat'));
      return false;
    }

    setIsSaving(true);
    try {
      // Test connection first — only save if test passes
      const testResult = await window.electronAPI.testApiKeyConnection(key);
      if (!testResult.success) {
        log.warn(
          TAG,
          'saveKey.test.failed',
          'tail=' + keyTail(key),
          'err=' + (testResult.error ?? '<no message>'),
        );
        setErrorMessage(testResult.error ?? t('logic.errors.apiKeyTestFailedNotSaved'));
        setStatus('error');
        return false;
      }

      const success = await window.electronAPI.safeStorageStore(XD_STORAGE_KEY, key);
      if (success) {
        log.info(TAG, 'saveKey.local.write.ok', 'tail=' + keyTail(key));
        // 本地 only:写入 safeStorage 即完成,不再 PUT 到服务器。
        // 让下次 mount 重新读一遍 — 当前 hook 实例的 state 已是最新, 但其他 consumer
        // (e.g. CCAgentSessionView) 重挂时若拿旧 cached promise 会读不到最新值。
        invalidateReconcileCache();
        savedKeyRef.current = key;
        setStatus('connected');
        setHasSavedKey(true);
        setSaveSuccess(true);
        // 通知所有已挂载的 useApiKey 实例同步 (如设置页 ApiKeySection / 供应商页),
        // 各自拿到新值后刷新 UI (连接态 / 按钮),不必重新 mount。
        broadcastApiKeyChange(key);
        toast.success(t('logic.toasts.apiKeySaved'));

        if (saveSuccessTimerRef.current) {
          clearTimeout(saveSuccessTimerRef.current);
        }
        saveSuccessTimerRef.current = setTimeout(() => {
          setSaveSuccess(false);
        }, 1500);
        return true;
      } else {
        log.error(TAG, 'saveKey.local.write.failed', 'tail=' + keyTail(key), 'storeOk=false');
        setErrorMessage(t('logic.errors.apiKeySafeStorageFailed'));
        setStatus('error');
        return false;
      }
    } catch (err) {
      log.error(TAG, 'saveKey.threw', 'tail=' + keyTail(key), 'err=' + String(err));
      setErrorMessage(t('logic.errors.apiKeySafeStorageFailed'));
      setStatus('error');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [key, t]);

  const testConnection = useCallback(async () => {
    if (!key.startsWith('sk-')) return;

    setIsTesting(true);
    // 不在这里清 errorMessage —— 保持上次的状态可见，等结果回来再更新
    try {
      const result = await window.electronAPI.testApiKeyConnection(key);
      if (result.success) {
        setStatus('connected');
        setErrorMessage(null); // 成功才清错误
        toast.success(t('logic.toasts.apiKeyConnectionTestSuccess'));
      } else {
        setStatus('error');
        setErrorMessage(result.error ?? t('logic.errors.apiKeyTestFailed'));
      }
    } catch {
      setStatus('error');
      setErrorMessage(t('logic.errors.apiKeyNetworkFailed'));
    } finally {
      setIsTesting(false);
    }
  }, [key, t]);

  const clearKey = useCallback(async (): Promise<boolean> => {
    if (isClearingRef.current) return false;
    isClearingRef.current = true;
    setIsClearing(true);
    try {
      // (a) safeStorage — the primary encrypted store.
      const result = await window.electronAPI.safeStorageRemove(XD_STORAGE_KEY);
      if (!result.success) {
        return false;
      }
      // 下次 mount 重新走一遍 reconcile —— cached promise 若仍指向旧值,
      // 重挂的 consumer 会以为还有 key, 跟实际状态不符。
      invalidateReconcileCache();
      // 本地 only:移除 safeStorage 即完成,不再 DELETE 服务器。
      log.info(TAG, 'clearKey.local.remove.ok');

      // (b) In-memory state — fully reset so the Source row returns to
      // "needs-config" and the trash icon disappears.
      savedKeyRef.current = '';
      setKeyState(''); // (d) Input display → sk-... placeholder
      setHasSavedKey(false);
      setStatus('needs-config'); // (e) Badge → "Needs configuration"
      setErrorMessage(null);
      setValidationError(null);
      setSaveSuccess(false);
      if (saveSuccessTimerRef.current) {
        clearTimeout(saveSuccessTimerRef.current);
        saveSuccessTimerRef.current = null;
      }
      // 通知所有已挂载的 useApiKey 实例同步 —— Settings 清完后,Gate / 其它
      // consumer 立刻感知 hasSavedKey=false, 拦截后续操作。
      broadcastApiKeyChange(null);

      return true;
    } catch (err) {
      log.error('clearKey failed', err);
      return false;
    } finally {
      isClearingRef.current = false;
      setIsClearing(false);
    }
  }, []);

  return {
    key,
    setKey,
    savedKey: savedKeyRef.current || null,
    status,
    errorMessage,
    isSaving,
    isTesting,
    isClearing,
    hasSavedKey,
    isReconciling,
    saveKey,
    testConnection,
    clearKey,
    validationError,
    saveSuccess,
  };
}
