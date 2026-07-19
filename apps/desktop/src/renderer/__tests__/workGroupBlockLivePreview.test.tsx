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

// The work-group interaction is under test. Keep direct tool rows lightweight
// while exposing the raw-command flag and status forwarded by WorkGroupBlock.
vi.mock('@/components/chat/AgentActionRow', () => ({
  AgentActionRow: (props: {
    message: ChatMessage;
    showRawCommand?: boolean;
    status?: 'running' | 'done';
    toolResult?: string;
  }) => {
    const toolInput = props.message.toolInput as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string'
      ? toolInput.command
      : props.message.clientId;
    return createElement(
      'div',
      {
        'data-testid': 'direct-tool',
        'data-show-raw': String(Boolean(props.showRawCommand)),
        'data-result': props.toolResult,
        'aria-label': `chat.agentActionRow.status.${props.status ?? 'done'}`,
      },
      command,
    );
  },
}));

vi.mock('@/components/chat/ThinkingCard', () => ({
  ThinkingCard: (props: { content: string; isRedacted?: boolean }) =>
    createElement(
      'div',
      {
        'data-testid': 'redacted-thinking',
        'data-content': props.content,
        'data-redacted': String(Boolean(props.isRedacted)),
      },
      'chat.thinking.redacted',
    ),
  formatDuration: (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`,
}));

import {
  WorkGroupBlock,
  collectLiveWorkActivities,
  type WorkGroupChild,
} from '@/components/chat/WorkGroupBlock';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';
import type { ChatMessage } from '@/lib/makerChatStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
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

const rendered = (key: string, text: string): WorkGroupChild => ({
  kind: 'rendered',
  key,
  renderNode: () => createElement('div', { 'data-testid': 'assistant-progress' }, text),
});

const group = (
  key: string,
  durationMs: number,
  childItems: WorkGroupChild[],
  isStreaming = false,
): WorkGroupChild => ({
  kind: 'group',
  key,
  blockId: `work:${key}`,
  durationMs,
  isStreaming,
  childItems,
});

function clickGroup(label: string) {
  const button = screen.getByText(label).closest('button');
  if (!button) throw new Error(`Missing work-group button: ${label}`);
  fireEvent.click(button);
}

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
    clickGroup('chat.workGroup.working');
    expect(screen.getAllByTestId('direct-tool')[0].textContent).toBe('t1');
  });

  it('renders one reasoning row that updates in place as the same block receives deltas', () => {
    const { rerender } = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', '**inspecting**'))],
      }),
    );
    expect(screen.getAllByText('inspecting')).toHaveLength(1);
    expect(screen.queryByText('**inspecting**')).toBeNull();

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', '**inspecting the renderer**'))],
      }),
    );
    expect(screen.queryByText('inspecting')).toBeNull();
    expect(screen.getAllByText('inspecting the renderer')).toHaveLength(1);
    expect(document.querySelectorAll('[data-live-work-activity="thinking"]')).toHaveLength(1);
  });

  it('expands running actions directly and keeps the same detail after completion', () => {
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

    clickGroup('chat.workGroup.working');
    expect(document.querySelector('[data-live-work-preview="true"]')).toBeNull();
    expect(screen.getByTestId('direct-tool').textContent).toBe('git status');
    expect(screen.getByTestId('direct-tool').getAttribute('data-show-raw')).toBe('true');
    expect(screen.getByText('checking the current state')).toBeTruthy();

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: false,
        durationMs: 12_000,
        childItems,
      }),
    );
    expect(screen.getByText('chat.workGroup.worked:12s')).toBeTruthy();
    expect(screen.getByTestId('direct-tool').textContent).toBe('git status');
    expect(screen.getByText('checking the current state')).toBeTruthy();
  });

  it('keeps outer assistant text visible while nested actions need one more expansion', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:summary-t1',
        durationMs: 20_000,
        childItems: [
          rendered('msg-progress', 'I checked the current state.'),
          group('inner-t1', 12_000, [
            tools('seg-1', [mkTool('t1', 'git status')]),
            thinking(mkThinking('th1', 'checking the current state')),
          ]),
        ],
      }),
    );

    expect(screen.queryByTestId('assistant-progress')).toBeNull();
    clickGroup('chat.workGroup.worked:20s');
    expect(screen.getByTestId('assistant-progress').textContent).toBe('I checked the current state.');
    expect(screen.getByText('chat.workGroup.worked:12s')).toBeTruthy();
    expect(screen.queryByTestId('direct-tool')).toBeNull();
    expect(screen.queryByText('checking the current state')).toBeNull();

    clickGroup('chat.workGroup.worked:12s');
    expect(screen.getByTestId('direct-tool').textContent).toBe('git status');
    expect(screen.getByText('checking the current state')).toBeTruthy();
  });

  it('expands multi-line thinking from its compact single-line row', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        durationMs: 3_000,
        childItems: [thinking(mkThinking('th1', 'first line\nsecond line'))],
      }),
    );

    clickGroup('chat.workGroup.worked:3s');
    const compactText = screen.getByText('first line second line');
    const thinkingButton = compactText.closest('button');
    expect(thinkingButton?.getAttribute('aria-expanded')).toBe('false');
    if (!thinkingButton) throw new Error('Missing expandable thinking row');
    fireEvent.click(thinkingButton);
    expect(thinkingButton.getAttribute('aria-expanded')).toBe('true');
    expect(thinkingButton.textContent).toContain('first line\nsecond line');
  });

  it('drops empty thinking and renders redacted thinking directly', () => {
    const redacted = { ...mkThinking('hidden', ''), thinkingRedacted: true };
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        childItems: [thinking(mkThinking('empty', '')), thinking(redacted)],
      }),
    );

    clickGroup('chat.workGroup.workDetails');
    expect(document.querySelectorAll('[data-live-work-activity="thinking"]')).toHaveLength(0);
    expect(screen.getAllByTestId('redacted-thinking')).toHaveLength(1);
    expect(screen.getByTestId('redacted-thinking').getAttribute('data-redacted')).toBe('true');
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
