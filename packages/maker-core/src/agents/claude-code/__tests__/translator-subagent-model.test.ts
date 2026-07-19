import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../../types/events.js';
import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    pushedTerminalError: false,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

function createCtx() {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'claude-opus-4-6',
    getEffort: () => 'medium',
    getPermissionMode: () => 'auto',
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker: new UsageTracker(),
  };
}

async function collect(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('Claude Code translator subagent model attribution', () => {
  it('keeps two concurrent subagent stream models isolated from the parent agent', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    for (const parentToolUseId of ['toolu_agent_a', 'toolu_agent_b']) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid: `stream-${parentToolUseId}`,
          session_id: 'sdk-session',
          parent_tool_use_id: parentToolUseId,
          event: {
            type: 'message_start',
            message: { model: 'gpt-5.6-sol', usage: { input_tokens: 0 } },
          },
        },
        queue,
        ctx,
      );
    }

    // 父 agent 的 assistant 事件插进两个 child stream 之间，模拟真实并发交错。
    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'parent-assistant',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        message: { model: 'claude-opus-4-6', content: [] },
      },
      queue,
      ctx,
    );

    for (const [parentToolUseId, text] of [
      ['toolu_agent_a', 'answer A'],
      ['toolu_agent_b', 'answer B'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid: `stream-${parentToolUseId}`,
          session_id: 'sdk-session',
          parent_tool_use_id: parentToolUseId,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        },
        queue,
        ctx,
      );
    }

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents.map((event) => event.agentMeta)).toEqual([
      expect.objectContaining({ parentUuid: 'toolu_agent_a', model: 'gpt-5.6-sol' }),
      expect.objectContaining({ parentUuid: 'toolu_agent_b', model: 'gpt-5.6-sol' }),
    ]);
  });

  it('projects async Agent resolvedModel into the task update as the authoritative label', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_agent_a',
              content: [{ type: 'text', text: 'Async agent launched successfully.' }],
            },
          ],
        },
        tool_use_result: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'agent-a',
          resolvedModel: 'codex/gpt-5.6-sol',
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data).toEqual({
      provider: 'claude-code',
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      status: 'running',
      model: 'codex/gpt-5.6-sol',
    });
  });
});
