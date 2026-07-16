import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

describe('chatQuoteStore', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    const { __testing } = await import('@/session/chatQuoteStore');
    __testing.reset();
    store.clear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { __testing } = await import('@/session/chatQuoteStore');
    __testing.reset();
    store.clear();
  });

  it('appends quotes, notifies subscribers, and clears all at once', async () => {
    const { appendQuote, clearQuotes, getQuotes, subscribeQuotes } = await import('@/session/chatQuoteStore');
    const seen: number[] = [];
    const unsubscribe = subscribeQuotes('s1', () => seen.push(getQuotes('s1').length));

    appendQuote('s1', { text: 'first' });
    appendQuote('s1', { text: 'second', sourcePath: 'docs/a.md' });
    expect(getQuotes('s1')).toEqual([
      { text: 'first' },
      { text: 'second', sourcePath: 'docs/a.md' },
    ]);
    expect(seen).toEqual([1, 2]);
    expect(getQuotes('s2')).toEqual([]);

    clearQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
    expect(seen).toEqual([1, 2, 0]);
    unsubscribe();
  });

  it('ignores empty-text quotes', async () => {
    const { appendQuote, getQuotes } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: '' });
    expect(getQuotes('s1')).toEqual([]);
  });

  it('persists after the debounce window and hydrates on cold start', async () => {
    vi.useFakeTimers();
    const { __testing, appendQuote } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: 'kept', sourcePath: 'src/x.ts' });
    vi.advanceTimersByTime(__testing.persistDebounceMs + 10);
    vi.useRealTimers();
    await flushMicrotasks();
    expect(JSON.parse(store.get(__testing.storageKeyForSession('s1')) ?? '[]')).toEqual([
      { text: 'kept', sourcePath: 'src/x.ts' },
    ]);

    // 冷启动:内存清空后 hydrate 从 AsyncStorage 回填并通知订阅方。
    __testing.reset();
    const { getQuotes, hydrateQuotes, subscribeQuotes } = await import('@/session/chatQuoteStore');
    const seen: number[] = [];
    subscribeQuotes('s1', () => seen.push(getQuotes('s1').length));
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([{ text: 'kept', sourcePath: 'src/x.ts' }]);
    expect(seen).toEqual([1]);
  });

  it('does not resurrect cleared quotes on hydrate (cleared marker wins)', async () => {
    const { __testing, appendQuote, clearQuotes, getQuotes, hydrateQuotes } = await import('@/session/chatQuoteStore');
    store.set(__testing.storageKeyForSession('s1'), JSON.stringify([{ text: 'stale' }]));
    appendQuote('s1', { text: 'live' });
    clearQuotes('s1');
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
  });

  it('setQuotes restores a snapshot (send-failure recovery) and empty array clears', async () => {
    const { appendQuote, clearQuotes, getQuotes, setQuotes } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: 'a' });
    const snapshot = [...getQuotes('s1')];
    clearQuotes('s1');
    setQuotes('s1', snapshot);
    expect(getQuotes('s1')).toEqual([{ text: 'a' }]);
    setQuotes('s1', []);
    expect(getQuotes('s1')).toEqual([]);
  });

  it('drops malformed persisted payloads on hydrate', async () => {
    const { __testing, getQuotes, hydrateQuotes } = await import('@/session/chatQuoteStore');
    store.set(__testing.storageKeyForSession('s1'), '{"not":"an array"}');
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
  });

  it('truncateQuoteText caps at QUOTE_MAX_CHARS with an ellipsis', async () => {
    const { QUOTE_MAX_CHARS, truncateQuoteText } = await import('@/session/chatQuoteStore');
    const long = 'x'.repeat(QUOTE_MAX_CHARS + 20);
    const truncated = truncateQuoteText(long);
    expect(truncated).toHaveLength(QUOTE_MAX_CHARS + 1);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncateQuoteText('short')).toBe('short');
  });
});
