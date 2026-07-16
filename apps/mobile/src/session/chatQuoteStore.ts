/**
 * chatQuoteStore — 会话级「选中文字引用」暂存 store(chat-text-quote)。
 *
 * 对应桌面端 composerDraftStore 的 `quotes` 字段:手机端草稿 store 是纯
 * string,装不下结构化引用,故独立成 sessionId → ChatQuote[] 的单例 store。
 * 聊天流选区浮动按钮 / 文件预览页写入,会话页 composer 胶囊经
 * `useSessionQuotes` 订阅渲染,发送时经 `formatQuotesForSend` 拼进消息正文。
 *
 * 持久化:AsyncStorage(JSON 数组),debounce + cleared 标记 + 每会话串行
 * 写队列——全套模式与 composerDraftStore 一致,保证「切走会话 / 杀 app 再
 * 回来引用仍在」的桌面 parity。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useSyncExternalStore } from 'react';
import type { ChatQuote } from '@lizi/maker-shared/chat-quotes';

export type { ChatQuote };

/** 单条引用长度上限(与桌面 SelectionQuoteButton 一致,防误选长文撑爆 prompt)。 */
export const QUOTE_MAX_CHARS = 4000;

/** 采集侧截断助手:超限截断并追加省略号。 */
export function truncateQuoteText(text: string): string {
  return text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS)}…` : text;
}

const STORAGE_KEY_PREFIX = 'xdt.chatQuotes.v1';
const PERSIST_DEBOUNCE_MS = 400;
const EMPTY_QUOTES: readonly ChatQuote[] = Object.freeze([]);

const quotesBySession = new Map<string, readonly ChatQuote[]>();
const clearedSessions = new Set<string>();
const hydratedSessions = new Set<string>();
const listenersBySession = new Map<string, Set<() => void>>();
const pendingPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingStorageOperations = new Map<string, Promise<void>>();

/** 追加一条引用(采集入口)。文本在此处不截断——调用方负责 truncateQuoteText。 */
export function appendQuote(sessionId: string, quote: ChatQuote): void {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized || !quote.text) return;
  const next = [...(quotesBySession.get(normalized) ?? []), quote];
  setQuotesInternal(normalized, next);
}

export function getQuotes(sessionId: string): readonly ChatQuote[] {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return EMPTY_QUOTES;
  return quotesBySession.get(normalized) ?? EMPTY_QUOTES;
}

/** 整组覆写(发送失败恢复用)。空数组等价于 clearQuotes。 */
export function setQuotes(sessionId: string, quotes: readonly ChatQuote[]): void {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  if (quotes.length === 0) {
    clearQuotesInternal(normalized);
    return;
  }
  setQuotesInternal(normalized, [...quotes]);
}

export function clearQuotes(sessionId: string): void {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  clearQuotesInternal(normalized);
}

export function subscribeQuotes(sessionId: string, listener: () => void): () => void {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return () => undefined;
  let set = listenersBySession.get(normalized);
  if (!set) {
    set = new Set();
    listenersBySession.set(normalized, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listenersBySession.delete(normalized);
  };
}

/**
 * 冷启动回填:AsyncStorage 读一次进内存(幂等;内存已有值 / 已清除时不覆盖,
 * 内存态是唯一事实源)。会话页 mount 时调用。
 */
export async function hydrateQuotes(sessionId: string): Promise<void> {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized || hydratedSessions.has(normalized)) return;
  hydratedSessions.add(normalized);
  if (quotesBySession.has(normalized) || clearedSessions.has(normalized)) return;

  const stored = await AsyncStorage.getItem(storageKeyForSession(normalized)).catch(() => null);
  if (!stored) return;
  if (quotesBySession.has(normalized) || clearedSessions.has(normalized)) return;
  const parsed = parseStoredQuotes(stored);
  if (parsed.length === 0) return;
  quotesBySession.set(normalized, Object.freeze(parsed));
  notify(normalized);
}

/** React hook:订阅某会话的引用列表(snapshot 为稳定数组引用)。 */
export function useSessionQuotes(sessionId: string | null | undefined): readonly ChatQuote[] {
  const normalized = sessionId ? normalizeSessionId(sessionId) : '';
  const subscribe = useCallback(
    (listener: () => void) => (normalized ? subscribeQuotes(normalized, listener) : () => undefined),
    [normalized],
  );
  const getSnapshot = useCallback(
    () => (normalized ? (quotesBySession.get(normalized) ?? EMPTY_QUOTES) : EMPTY_QUOTES),
    [normalized],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function setQuotesInternal(normalized: string, quotes: ChatQuote[]): void {
  const frozen = Object.freeze(quotes);
  quotesBySession.set(normalized, frozen);
  clearedSessions.delete(normalized);
  schedulePersist(normalized, frozen);
  notify(normalized);
}

function clearQuotesInternal(normalized: string): void {
  cancelPendingPersist(normalized);
  const hadValue = quotesBySession.delete(normalized);
  clearedSessions.add(normalized);
  enqueueStorageOperation(normalized, () =>
    AsyncStorage.removeItem(storageKeyForSession(normalized)),
  );
  if (hadValue) notify(normalized);
}

function notify(normalized: string): void {
  const set = listenersBySession.get(normalized);
  if (!set) return;
  for (const listener of [...set]) listener();
}

function parseStoredQuotes(stored: string): ChatQuote[] {
  try {
    const raw: unknown = JSON.parse(stored);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is ChatQuote =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string' &&
        ((item as { sourcePath?: unknown }).sourcePath === undefined ||
          typeof (item as { sourcePath?: unknown }).sourcePath === 'string'),
    );
  } catch {
    return [];
  }
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim();
}

function storageKeyForSession(normalized: string): string {
  return `${STORAGE_KEY_PREFIX}.${encodeURIComponent(normalized)}`;
}

function schedulePersist(normalized: string, quotes: readonly ChatQuote[]): void {
  cancelPendingPersist(normalized);
  const timer = setTimeout(() => {
    pendingPersistTimers.delete(normalized);
    void persistIfCurrent(normalized, quotes);
  }, PERSIST_DEBOUNCE_MS);
  pendingPersistTimers.set(normalized, timer);
}

function cancelPendingPersist(normalized: string): void {
  const timer = pendingPersistTimers.get(normalized);
  if (!timer) return;
  clearTimeout(timer);
  pendingPersistTimers.delete(normalized);
}

async function persistIfCurrent(normalized: string, quotes: readonly ChatQuote[]): Promise<void> {
  if (clearedSessions.has(normalized)) return;
  if (quotesBySession.get(normalized) !== quotes) return;
  await enqueueStorageOperation(normalized, () =>
    AsyncStorage.setItem(storageKeyForSession(normalized), JSON.stringify(quotes)),
  );
}

function enqueueStorageOperation(
  normalized: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = pendingStorageOperations.get(normalized) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .catch(() => undefined);
  pendingStorageOperations.set(normalized, next);
  void next.finally(() => {
    if (pendingStorageOperations.get(normalized) === next) {
      pendingStorageOperations.delete(normalized);
    }
  });
  return next;
}

export const __testing = {
  persistDebounceMs: PERSIST_DEBOUNCE_MS,
  storageKeyForSession,
  storageKeyPrefix: STORAGE_KEY_PREFIX,
  reset(): void {
    for (const timer of pendingPersistTimers.values()) clearTimeout(timer);
    pendingPersistTimers.clear();
    pendingStorageOperations.clear();
    quotesBySession.clear();
    clearedSessions.clear();
    hydratedSessions.clear();
    listenersBySession.clear();
  },
};
