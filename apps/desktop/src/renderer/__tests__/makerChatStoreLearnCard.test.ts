/**
 * learn 状态卡的 store 行为:runId 幂等插入 + 提案就绪时移到消息流末尾
 * (卡片在 /learn 发出时插入,长叙述后停在顶部会被用户错过 —— Chris 实测反馈)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'cc',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));
vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';

const sessionIds: string[] = [];
function sid(label: string): string {
  const value = `${label}-${Math.random().toString(36).slice(2, 8)}`;
  sessionIds.push(value);
  return value;
}

afterEach(() => {
  for (const id of sessionIds.splice(0)) makerChatStore.purgeSession(id);
});

describe('learn 状态卡 store 行为', () => {
  it('runId 幂等:重复 insert 不产生第二张卡', () => {
    const id = sid('learn-card');
    makerChatStore.insertSystemCard(id, 'learn', { runId: 'r1' });
    makerChatStore.insertSystemCard(id, 'learn', { runId: 'r1' });
    const cards = makerChatStore
      .getSnapshot(id)
      .messages.filter((m) => m.systemCardType === 'learn');
    expect(cards).toHaveLength(1);
  });

  it('moveLearnCardToEnd:提案就绪时卡片移到末尾,保持同一 clientId;已在末尾不动', () => {
    const id = sid('learn-move');
    const cardClientId = makerChatStore.insertSystemCard(id, 'learn', { runId: 'r1' });
    makerChatStore.insertSystemCard(id, 'status', { label: 'narration-1' });
    makerChatStore.insertSystemCard(id, 'status', { label: 'narration-2' });

    makerChatStore.moveLearnCardToEnd(id, 'r1');
    let msgs = makerChatStore.getSnapshot(id).messages;
    expect(msgs.at(-1)?.systemCardType).toBe('learn');
    expect(msgs.at(-1)?.clientId).toBe(cardClientId);

    // 幂等:已在末尾时引用不变(不触发无谓重渲染)
    const before = makerChatStore.getSnapshot(id).messages;
    makerChatStore.moveLearnCardToEnd(id, 'r1');
    expect(makerChatStore.getSnapshot(id).messages).toBe(before);

    // 未命中 runId 不动
    makerChatStore.moveLearnCardToEnd(id, 'r-missing');
    msgs = makerChatStore.getSnapshot(id).messages;
    expect(msgs.at(-1)?.systemCardType).toBe('learn');
  });
});
