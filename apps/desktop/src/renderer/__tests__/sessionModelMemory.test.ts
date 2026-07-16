/**
 * sessionModelMemory.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/sessionModelMemory.ts 的核心约定(以及它与 providerModelMemory 的隔离):
 *   1. 默认无记录 → get 返回 undefined
 *   2. effort / fast set/get 往返(运行期、进程内)
 *   3. 按 sessionId **完全隔离**:session A 的预设不影响 session B
 *   4. 按 (agent, providerId) 分槽:同一来源在 cc / codex 下互不覆盖
 *   5. 空 sessionId / providerId / model 入参被静默忽略
 *   6. pickMemoryScope 路由:有 sessionId(含 device-link 会话)→session / device-link 草稿→none / 本地草稿→draft
 *   7. 【bug 回归】写 sessionModelMemory 绝不污染 providerModelMemory(草稿记忆),反之亦然
 *      —— 这正是「草稿默认值被会话内 effort/fast 修改影响」那个 bug 的隔离边界。
 *
 * 项目 vitest env=node,无 window。providerModelMemory 走 localStorage,沿用
 * providerModelMemory.test.ts 的最小 localStorage stub;sessionModelMemory 本身不落盘。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadSession() {
  return await import('@/state/sessionModelMemory');
}

describe('sessionModelMemory store', () => {
  it('默认无记录:get 返回 undefined', async () => {
    const m = await loadSession();
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getSessionModelFast('sess-1', 'codex', 'openai', 'gpt-5.5')).toBeUndefined();
  });

  it('effort set/get 往返', async () => {
    const m = await loadSession();
    m.setSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
  });

  it('fast set/get 往返', async () => {
    const m = await loadSession();
    m.setSessionModelFast('sess-1', 'codex', 'openai', 'gpt-5.5', true);
    expect(m.getSessionModelFast('sess-1', 'codex', 'openai', 'gpt-5.5')).toBe(true);
  });

  it('effort / fast 同槽并存,互不覆盖', async () => {
    const m = await loadSession();
    m.setSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8', 'max');
    m.setSessionModelFast('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8', true);
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('max');
    expect(m.getSessionModelFast('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
  });

  it('按 sessionId 完全隔离:session A 的预设不影响 session B', async () => {
    const m = await loadSession();
    m.setSessionModelEffort('sess-A', 'claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setSessionModelFast('sess-A', 'claude-code', 'anthropic', 'claude-opus-4-8', true);
    // session B 同样的 (agent, provider, model) 仍是空
    expect(m.getSessionModelEffort('sess-B', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getSessionModelFast('sess-B', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    // 给 B 写不同值,A 不受影响
    m.setSessionModelEffort('sess-B', 'claude-code', 'anthropic', 'claude-opus-4-8', 'low');
    expect(m.getSessionModelEffort('sess-A', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getSessionModelEffort('sess-B', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('low');
  });

  it('按 (agent, providerId) 分槽:同来源 cc / codex 互不覆盖', async () => {
    const m = await loadSession();
    m.setSessionModelEffort('sess-1', 'claude-code', 'xd', 'claude-opus-4-8', 'high');
    m.setSessionModelEffort('sess-1', 'codex', 'xd', 'claude-opus-4-8', 'low');
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'xd', 'claude-opus-4-8')).toBe('high');
    expect(m.getSessionModelEffort('sess-1', 'codex', 'xd', 'claude-opus-4-8')).toBe('low');
  });

  it('同来源不同 model 各记各的 effort', async () => {
    const m = await loadSession();
    m.setSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-haiku-4-5', 'low');
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-haiku-4-5')).toBe('low');
  });

  it('空 sessionId / providerId / model 入参被静默忽略', async () => {
    const m = await loadSession();
    m.setSessionModelEffort('', 'claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setSessionModelEffort('sess-1', 'claude-code', '', 'claude-opus-4-8', 'high');
    m.setSessionModelEffort('sess-1', 'claude-code', 'anthropic', '', 'high');
    expect(m.getSessionModelEffort('', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getSessionModelEffort('sess-1', 'claude-code', '', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', '')).toBeUndefined();
  });

  it('__resetForTest 清空整个 store', async () => {
    const m = await loadSession();
    m.setSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.__resetForTest();
    expect(m.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
  });
});

describe('pickMemoryScope —— 记忆作用域路由', () => {
  it('device-link 草稿(无 sessionId)→ none;device-link 已创建会话(有 sessionId)→ session', async () => {
    const { pickMemoryScope } = await loadSession();
    // 草稿期(无 sessionId)能力 / 记忆以被控端为准 → none
    expect(pickMemoryScope({ deviceLinkDeviceId: 'dev-1' })).toBe('none');
    // 已创建远程会话与本地会话同口径 → session(预设在选中时经隧道推给被控端)
    expect(pickMemoryScope({ sessionId: 'sess-1', deviceLinkDeviceId: 'dev-1' })).toBe('session');
  });

  it('已创建会话(有 sessionId、非 device-link)→ session', async () => {
    const { pickMemoryScope } = await loadSession();
    expect(pickMemoryScope({ sessionId: 'sess-1' })).toBe('session');
    expect(pickMemoryScope({ sessionId: 'sess-1', deviceLinkDeviceId: null })).toBe('session');
  });

  it('草稿(无 sessionId)→ draft', async () => {
    const { pickMemoryScope } = await loadSession();
    expect(pickMemoryScope({})).toBe('draft');
    expect(pickMemoryScope({ sessionId: undefined })).toBe('draft');
  });
});

describe('bug 回归:会话记忆与草稿记忆物理隔离', () => {
  it('写 sessionModelMemory 不污染 providerModelMemory(草稿记忆)', async () => {
    const session = await loadSession();
    const draft = await import('@/state/providerModelMemory');
    draft.__resetForTest();

    // 模拟「会话内把 Opus 的 effort/fast 改了」
    session.setSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8', 'low');
    session.setSessionModelFast('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8', true);

    // 草稿记忆(providerModelMemory)不应被触达 —— 草稿页仍是空,选到 Opus 显示模型默认
    expect(draft.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(draft.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
  });

  it('写 providerModelMemory(草稿)不污染 sessionModelMemory', async () => {
    const session = await loadSession();
    const draft = await import('@/state/providerModelMemory');
    draft.__resetForTest();

    // 模拟「草稿页为 Opus 配置了 high + fast」
    draft.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    draft.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);

    // 任意会话的记忆仍是空 —— 会话不读草稿这份(运行期、按 sessionId 隔离)
    expect(session.getSessionModelEffort('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(session.getSessionModelFast('sess-1', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
  });
});

describe('copy-on-create —— 建 session 时把草稿快照种进会话', () => {
  it('snapshotForSeed 深拷贝草稿全部槽的 effort/fast(丢 lastModel)', async () => {
    const draft = await import('@/state/providerModelMemory');
    draft.__resetForTest();
    draft.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    draft.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    draft.setProviderModelChoice('codex', 'openai', 'gpt-5.5', 'low');

    const snap = draft.snapshotForSeed();
    expect(snap['claude-code:anthropic'].effortByModel['claude-opus-4-8']).toBe('high');
    expect(snap['claude-code:anthropic'].fastByModel['claude-opus-4-8']).toBe(true);
    expect(snap['codex:openai'].effortByModel['gpt-5.5']).toBe('low');
    // lastModel 不在快照里
    expect((snap['claude-code:anthropic'] as Record<string, unknown>).lastModel).toBeUndefined();
  });

  it('round-trip:草稿快照种进会话后,会话读到草稿当时的 effort/fast', async () => {
    const session = await loadSession();
    const draft = await import('@/state/providerModelMemory');
    draft.__resetForTest();
    draft.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    draft.setProviderModelFast('claude-code', 'anthropic', 'claude-haiku-4-5', true);

    session.seedSession('sess-new', draft.snapshotForSeed());

    expect(session.getSessionModelEffort('sess-new', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(session.getSessionModelFast('sess-new', 'claude-code', 'anthropic', 'claude-haiku-4-5')).toBe(true);
  });

  it('种子是深拷贝:种后改草稿不影响已种的会话,会话内改也不回写草稿', async () => {
    const session = await loadSession();
    const draft = await import('@/state/providerModelMemory');
    draft.__resetForTest();
    draft.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    session.seedSession('sess-new', draft.snapshotForSeed());

    // 种之后改草稿 → 已种的会话纹丝不动
    draft.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'low');
    expect(session.getSessionModelEffort('sess-new', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');

    // 会话内改 → 草稿纹丝不动
    session.setSessionModelEffort('sess-new', 'claude-code', 'anthropic', 'claude-opus-4-8', 'max');
    expect(draft.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('low');
  });

  it('已有记忆的会话不会被种子覆盖(防重复 / 防覆盖已有编辑)', async () => {
    const session = await loadSession();
    const draft = await import('@/state/providerModelMemory');
    draft.__resetForTest();
    draft.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');

    // 会话里先有一条编辑
    session.setSessionModelEffort('sess-x', 'claude-code', 'anthropic', 'claude-opus-4-8', 'max');
    // 再种(模拟重复调用)→ 不覆盖
    session.seedSession('sess-x', draft.snapshotForSeed());
    expect(session.getSessionModelEffort('sess-x', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('max');
  });

  it('空快照不种(不占坑)', async () => {
    const session = await loadSession();
    const draft = await import('@/state/providerModelMemory');
    draft.__resetForTest();
    session.seedSession('sess-empty', draft.snapshotForSeed());
    // 仍是空,后续 set 正常工作
    expect(session.getSessionModelEffort('sess-empty', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    session.setSessionModelEffort('sess-empty', 'claude-code', 'anthropic', 'claude-opus-4-8', 'low');
    expect(session.getSessionModelEffort('sess-empty', 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('low');
  });
});
