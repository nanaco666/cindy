import { describe, expect, it } from 'vitest';
import {
  buildMobileMessageRenderItems,
  type MobileMessageRenderItem,
} from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';
import {
  buildMessageLoadEarlierAction,
  buildSearchLoadEarlierAction,
  DEFAULT_NEAR_BOTTOM_THRESHOLD,
  findMobileRenderItemKeyByClientId,
  firstNonEmptyMessageLine,
  isNearMessageListBottom,
  isNearMobileMessageListBottom,
  isNearMessageListTop,
  MOBILE_MESSAGE_LIST_BOTTOM_PADDING,
  MOBILE_NEAR_BOTTOM_THRESHOLD,
  mobileMessageListEndOffset,
  mobileMessageListBottomPadding,
  mobileMessageListNearBottomThreshold,
  previousUserMessageJumpTarget,
  shouldAutoFollowMessages,
  shouldAutoLoadEarlier,
  shouldShowNewMessageIndicator,
  mobileLoadEarlierPrefetchThreshold,
  mobileMessageListTopPadding,
  mobileTopPaddingCompensationOffset,
} from '@/session/messageScroll';

function remoteMessage(
  patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>,
): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
}

function toolUse(id: string, toolName: string, input: unknown, seconds: number): RemoteMessage {
  return remoteMessage({
    id,
    role: 'tool_use',
    toolUseId: id,
    content: { toolUseId: id, toolName, input },
    createdAt: at(seconds),
  });
}

function renderItems(messages: readonly RemoteMessage[]): MobileMessageRenderItem[] {
  return buildMobileMessageRenderItems(messages);
}

describe('messageScroll', () => {
  it('treats short content and threshold-close scroll as near bottom', () => {
    expect(isNearMessageListBottom({ contentHeight: 500, offsetY: 0, viewportHeight: 600 })).toBe(true);
    expect(isNearMessageListBottom({ contentHeight: 1000, offsetY: 850, viewportHeight: 100 })).toBe(true);
    expect(isNearMessageListBottom({ contentHeight: 1000, offsetY: 600, viewportHeight: 100 })).toBe(false);
  });

  it('treats a reader at the latest message as near bottom even with composer padding', () => {
    const metrics = {
      contentHeight: 1200,
      offsetY: 1200 - 600 - MOBILE_MESSAGE_LIST_BOTTOM_PADDING,
      viewportHeight: 600,
    };

    expect(MOBILE_NEAR_BOTTOM_THRESHOLD).toBeGreaterThan(MOBILE_MESSAGE_LIST_BOTTOM_PADDING);
    expect(isNearMessageListBottom(metrics)).toBe(false);
    expect(isNearMobileMessageListBottom(metrics)).toBe(true);
  });

  it('uses the measured bottom overlay height when it is larger than the fallback padding', () => {
    expect(mobileMessageListBottomPadding(320)).toBe(320);
    expect(mobileMessageListBottomPadding(80)).toBe(MOBILE_MESSAGE_LIST_BOTTOM_PADDING);
    expect(mobileMessageListNearBottomThreshold(320)).toBe(DEFAULT_NEAR_BOTTOM_THRESHOLD + 320);

    const metrics = {
      contentHeight: 1400,
      offsetY: 1400 - 600 - 320,
      viewportHeight: 600,
    };

    expect(isNearMobileMessageListBottom(metrics)).toBe(false);
    expect(isNearMobileMessageListBottom(metrics, 320)).toBe(true);
  });

  it('computes a deterministic content-end offset for native scroll follow', () => {
    expect(mobileMessageListEndOffset({
      contentHeight: 1800,
      offsetY: 0,
      viewportHeight: 700,
    })).toBe(1100);
    expect(mobileMessageListEndOffset({
      contentHeight: 500,
      offsetY: 0,
      viewportHeight: 700,
    })).toBe(0);
  });

  it('treats top overscroll as the automatic load-earlier trigger range', () => {
    expect(isNearMessageListTop({ offsetY: -20 })).toBe(true);
    expect(isNearMessageListTop({ offsetY: 96 })).toBe(true);
    expect(isNearMessageListTop({ offsetY: 120 })).toBe(false);
  });

  it('auto-follows initial load and new messages only when already near bottom', () => {
    expect(shouldAutoFollowMessages({
      previousLastKey: null,
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(true);
    expect(shouldAutoFollowMessages({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: true,
    })).toBe(true);
    expect(shouldAutoFollowMessages({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: false,
    })).toBe(false);
  });

  it('shows the new-message indicator only for new tail messages while away from bottom', () => {
    expect(shouldShowNewMessageIndicator({
      previousLastKey: null,
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(false);
    expect(shouldShowNewMessageIndicator({
      previousLastKey: 'm1',
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(false);
    expect(shouldShowNewMessageIndicator({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: false,
    })).toBe(true);
  });

  it('re-exports load-earlier action models for the native renderer', () => {
    expect(buildMessageLoadEarlierAction({
      hasOlderMessages: true,
      loading: false,
      visibleMessageCount: 2,
    })).toMatchObject({
      disabled: false,
      label: '加载更早消息',
      visible: true,
    });

    expect(buildSearchLoadEarlierAction({
      hasHits: false,
      hasOlderMessages: true,
      loading: false,
      query: 'status',
    })).toMatchObject({
      label: '加载更早继续搜索',
      visible: true,
    });
  });

  it('finds the previous user message above the first visible item', () => {
    const items = renderItems([
      remoteMessage({ id: 'u1', role: 'user', content: '\n  first question\nsecond line', createdAt: at(1) }),
      remoteMessage({ id: 'a1', role: 'assistant', content: 'answer', createdAt: at(2) }),
      remoteMessage({ id: 'u2', role: 'user', content: 'second question', createdAt: at(3) }),
      remoteMessage({ id: 'a2', role: 'assistant', content: 'answer 2', createdAt: at(4) }),
    ]);

    expect(firstNonEmptyMessageLine('\n  first question\nsecond line')).toBe('first question');
    expect(previousUserMessageJumpTarget(items, 3)).toMatchObject({
      clientId: 'u2',
      itemKey: 'message-u2',
      preview: 'second question',
    });
    expect(previousUserMessageJumpTarget(items, 1)).toMatchObject({
      clientId: 'u1',
      itemKey: 'message-u1',
      preview: 'first question',
    });
    expect(previousUserMessageJumpTarget(items, 0)).toBeNull();
  });

  it('maps client ids inside folded render items to the top-level scroll target', () => {
    const items = renderItems([
      remoteMessage({ id: 'user', role: 'user', content: 'run tests', createdAt: at(1) }),
      remoteMessage({
        id: 'thinking',
        role: 'thinking',
        content: { text: 'checking commands', durationMs: 1200, isRedacted: false },
        createdAt: at(2),
      }),
      toolUse('bash-1', 'Bash', { command: 'pnpm test:mobile' }, 3),
      remoteMessage({ id: 'answer', role: 'assistant', content: 'done', createdAt: at(8) }),
    ]);

    expect(findMobileRenderItemKeyByClientId(items, 'user')).toBe('message-user');
    expect(findMobileRenderItemKeyByClientId(items, 'thinking')).toBe('work-thinking');
    expect(findMobileRenderItemKeyByClientId(items, 'bash-1')).toBe('work-thinking');
    expect(findMobileRenderItemKeyByClientId(items, 'missing')).toBeNull();
  });
});

describe('mobileLoadEarlierPrefetchThreshold', () => {
  it('prefetches about two viewports before reaching the top', () => {
    expect(mobileLoadEarlierPrefetchThreshold(800)).toBe(1600);
    expect(mobileLoadEarlierPrefetchThreshold(931.5)).toBe(1863);
  });

  it('falls back to the legacy 96px threshold when viewport height is unknown', () => {
    expect(mobileLoadEarlierPrefetchThreshold(0)).toBe(96);
    expect(mobileLoadEarlierPrefetchThreshold(Number.NaN)).toBe(96);
    expect(mobileLoadEarlierPrefetchThreshold(-10)).toBe(96);
    // 极小视口也不低于旧默认。
    expect(mobileLoadEarlierPrefetchThreshold(20)).toBe(96);
  });
});

// 「自动加载更早」电平触发判定:回归背景是 LegendList onStartReached 的边沿被业务 guard 吞掉后,
// 用户停在顶部、入口亮着却永远不自动加载(短加载窗口会话冷开即中招)。判定必须是纯电平语义:
// 任一输入翻转到就绪态时重评估即可触发,不依赖「再来一次边沿」。
describe('shouldAutoLoadEarlier', () => {
  const eligible = {
    actionDisabled: false,
    actionVisible: true,
    atEnd: false,
    firstItemKey: 'message-a',
    lastAttemptedFirstItemKey: null,
    nearStart: true,
    userScrolledForOlder: true,
  };

  it('fires when the user rests near the top with the affordance ready', () => {
    expect(shouldAutoLoadEarlier(eligible)).toBe(true);
  });

  it('recovers after a swallowed start-reached edge once loading finishes (level semantics)', () => {
    // 上一页在途时到达顶部:disabled 吞掉边沿 → 不触发;
    expect(shouldAutoLoadEarlier({ ...eligible, actionDisabled: true })).toBe(false);
    // 加载结束(disabled 翻 false)重评估:无需新边沿即可续拉。
    expect(shouldAutoLoadEarlier(eligible)).toBe(true);
  });

  it('recovers when the affordance lights up while already resting near the top', () => {
    expect(shouldAutoLoadEarlier({ ...eligible, actionVisible: false })).toBe(false);
    expect(shouldAutoLoadEarlier(eligible)).toBe(true);
  });

  it('never fires without a real upward user intent (cold-open guard)', () => {
    expect(shouldAutoLoadEarlier({ ...eligible, userScrolledForOlder: false })).toBe(false);
  });

  it('never fires while pinned at the end so streaming follow keeps its end pin', () => {
    // 短会话整窗都在近顶阈值内:nearStart 与贴底可同时成立,贴底跟流优先。
    expect(shouldAutoLoadEarlier({ ...eligible, atEnd: true })).toBe(false);
  });

  it('does not fire outside the prefetch zone', () => {
    expect(shouldAutoLoadEarlier({ ...eligible, nearStart: false })).toBe(false);
  });

  it('requires progress between attempts to avoid hammering a host that returns no new rows', () => {
    // 上次尝试后首项没变(加载失败 / host cursor 未命中拉回重复页)→ 不自动重试;
    expect(shouldAutoLoadEarlier({ ...eligible, lastAttemptedFirstItemKey: 'message-a' })).toBe(false);
    // prepend 真落地(首项变化)→ 允许级联拉下一页(小页填满预取区);
    expect(shouldAutoLoadEarlier({ ...eligible, lastAttemptedFirstItemKey: 'message-z' })).toBe(true);
    // 空列表无进展信号,不触发。
    expect(shouldAutoLoadEarlier({ ...eligible, firstItemKey: null })).toBe(false);
  });
});

describe('mobileMessageListTopPadding', () => {
  it('clears the absolute top chrome plus a breathing gap', () => {
    expect(mobileMessageListTopPadding(104)).toBe(112);
    expect(mobileMessageListTopPadding(50.4)).toBe(59);
  });

  it('adds nothing when the chrome height is unknown', () => {
    expect(mobileMessageListTopPadding(undefined)).toBe(0);
    expect(mobileMessageListTopPadding(0)).toBe(0);
    expect(mobileMessageListTopPadding(Number.NaN)).toBe(0);
  });
});

describe('mobileTopPaddingCompensationOffset', () => {
  const midReadBase = {
    offsetY: 2400,
    stickToLatest: false,
    preserveVisibleContentPosition: false,
    listVisible: true,
  };

  it('keeps the viewport in place when top padding grows or shrinks mid-read', () => {
    // 连接横幅出现:padding 112→160,视口顺移 +48 保持可见内容不动。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, previousTopPadding: 112, nextTopPadding: 160,
    })).toBe(2448);
    // 横幅消失:反向 -48。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, previousTopPadding: 160, nextTopPadding: 112,
    })).toBe(2352);
  });

  it('clamps the compensated offset at zero', () => {
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, offsetY: 20, previousTopPadding: 160, nextTopPadding: 112,
    })).toBe(0);
  });

  it('skips compensation whenever another positioning mechanism owns the viewport', () => {
    const change = { previousTopPadding: 112, nextTopPadding: 160 };
    // 贴底跟随:contentSize follow 分支自行重锚。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, ...change, stickToLatest: true,
    })).toBeNull();
    // preserve 窗口(load-earlier / open-settle):mVCP 锚点自行吸收,手动补偿会双重位移。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, ...change, preserveVisibleContentPosition: true,
    })).toBeNull();
    // 列表尚未揭开:揭开路径自己定位。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, ...change, listVisible: false,
    })).toBeNull();
  });

  it('does not compensate at the very top or when padding is unchanged', () => {
    // 停在最顶:让位本来就该把内容推下来给横幅腾位。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, offsetY: 0, previousTopPadding: 112, nextTopPadding: 160,
    })).toBeNull();
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, previousTopPadding: 112, nextTopPadding: 112,
    })).toBeNull();
  });
});
