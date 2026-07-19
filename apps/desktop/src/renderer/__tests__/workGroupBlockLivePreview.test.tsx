// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.duration ? `${key}:${String(options.duration)}` : key,
  }),
}));

// The work-group interaction is under test, not the second-level tool cards.
// Lightweight stubs make their mount state and forwarded streaming props visible;
// ThinkingCard remains only as the redacted fallback after normal thinking becomes a direct row.
vi.mock('@/components/chat/AgentActionsBlock', () => ({
  AgentActionsBlock: (props: { toolCalls: ChatMessage[]; isSessionStreaming?: boolean }) =>
    createElement(
      'div',
      {
        'data-testid': 'expanded-tools',
        'data-streaming': String(Boolean(props.isSessionStreaming)),
      },
      props.toolCalls.map((message) => message.clientId).join(','),
    ),
}));

vi.mock('@/components/chat/ThinkingCard', () => ({
  ThinkingCard: (props: { content: string }) =>
    createElement('div', { 'data-testid': 'expanded-thinking' }, props.content),
  formatDuration: (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`,
}));

import {
  WorkGroupBlock,
  collectLiveWorkActivities,
  type WorkGroupChild,
} from '@/components/chat/WorkGroupBlock';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';
import type { ChatMessage } from '@/lib/makerChatStore';

afterEach(cleanup);
beforeEach(() => expandMemory.reset());

const mkTool = (id: string, command = id): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: 'exec',
  toolInput: { command },
});

const mkThinking = (id: string, content: string): ChatMessage => ({
  clientId: id,
  role: 'thinking',
  content,
  isStreaming: true,
  thinkingDurationMs: content ? 1000 : 2000,
});

const tools = (
  key: string,
  toolCalls: ChatMessage[],
  resultMap = new Map<string, string>(),
  settledIds = new Set<string>(),
): WorkGroupChild => ({ kind: 'tools', key, toolCalls, resultMap, settledIds });

const thinking = (message: ChatMessage): WorkGroupChild => ({
  kind: 'thinking',
  key: `msg-${message.clientId}`,
  message,
});

describe('WorkGroupBlock — running latest-five preview', () => {
  it('keeps the latest five tools/reasoning rows in chronological order and drops empty thinking', () => {
    const children: WorkGroupChild[] = [
      tools('seg-1', [mkTool('t1'), mkTool('t2')]),
      thinking(mkThinking('th1', 'first reasoning summary')),
      thinking(mkThinking('empty', '')),
      tools('seg-2', [mkTool('t3'), mkTool('t4')]),
      thinking(mkThinking('th2', 'latest reasoning summary')),
    ];

    const activities = collectLiveWorkActivities(children, true);
    expect(activities.map((activity) => activity.key)).toEqual(['t2', 'th1', 't3', 't4', 'th2']);
    expect(activities.some((activity) => activity.key === 'empty')).toBe(false);

    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: children,
      }),
    );
    expect(document.querySelectorAll('[data-live-work-activity]')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByTestId('expanded-tools')[0].textContent).toBe('t1,t2');
  });

  it('renders one reasoning row that updates in place as the same block receives deltas', () => {
    const { rerender } = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', 'inspecting'))],
      }),
    );
    expect(screen.getAllByText('inspecting')).toHaveLength(1);

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', 'inspecting the renderer'))],
      }),
    );
    expect(screen.queryByText('inspecting')).toBeNull();
    expect(screen.getAllByText('inspecting the renderer')).toHaveLength(1);
    expect(document.querySelectorAll('[data-live-work-activity="thinking"]')).toHaveLength(1);
  });

  it('shows the collapsed live preview, then reveals full children and keeps expansion on completion', () => {
    const childItems = [
      tools('seg-1', [mkTool('t1', 'git status')]),
      thinking(mkThinking('th1', 'checking the current state')),
    ];
    const { rerender } = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems,
      }),
    );

    expect(screen.getByText('chat.workGroup.working')).toBeTruthy();
    expect(document.querySelector('[data-live-work-preview="true"]')).toBeTruthy();
    expect(screen.queryByTestId('expanded-tools')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(document.querySelector('[data-live-work-preview="true"]')).toBeNull();
    expect(screen.getByTestId('expanded-tools').getAttribute('data-streaming')).toBe('true');
    expect(screen.queryByTestId('expanded-thinking')).toBeNull();
    expect(screen.getByText('checking the current state')).toBeTruthy();
    expect(document.querySelectorAll('[data-live-work-activity="thinking"]')).toHaveLength(1);

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: false,
        durationMs: 12_000,
        childItems,
      }),
    );
    expect(screen.getByText('chat.workGroup.worked:12s')).toBeTruthy();
    expect(screen.getByTestId('expanded-tools').getAttribute('data-streaming')).toBe('false');
    expect(screen.getByText('checking the current state')).toBeTruthy();
  });

  it('drops empty thinking from expanded history and keeps the redacted fallback', () => {
    const redacted = { ...mkThinking('hidden', ''), thinkingRedacted: true };
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        childItems: [thinking(mkThinking('empty', '')), thinking(redacted)],
      }),
    );

    fireEvent.click(screen.getByRole('button'));
    expect(document.querySelectorAll('[data-live-work-activity="thinking"]')).toHaveLength(0);
    expect(screen.getByTestId('expanded-thinking')).toBeTruthy();
  });

  it('marks result/settled tools done and only unresolved tools running', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [
          tools(
            'seg-1',
            [mkTool('result'), mkTool('settled'), mkTool('pending')],
            new Map([['result', 'ok']]),
            new Set(['settled']),
          ),
        ],
      }),
    );

    expect(screen.getAllByLabelText('chat.agentActionRow.status.done')).toHaveLength(2);
    expect(screen.getAllByLabelText('chat.agentActionRow.status.running')).toHaveLength(1);
  });
});
