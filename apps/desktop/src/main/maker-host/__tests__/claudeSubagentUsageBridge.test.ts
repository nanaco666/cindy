import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';

import {
  ClaudeSubagentUsageBridge,
  createClaudeSubagentUsageResponseObserver,
} from '../claude-subagent-usage-bridge.js';

function requestBody(model: string, prompt: string): Buffer {
  return Buffer.from(JSON.stringify({
    model,
    messages: [
      { role: 'user', content: '<system-reminder>context</system-reminder>' },
      { role: 'user', content: prompt },
    ],
  }));
}

function sse(inputTokens: number, outputTokens: number, cacheReadTokens = 0): Buffer {
  const frames = [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
    { type: 'message_delta', usage: { input_tokens: 0, output_tokens: outputTokens } },
    { type: 'message_stop' },
  ];
  return Buffer.from(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
}

function observe(
  bridge: ClaudeSubagentUsageBridge,
  reqId: number,
  model: string,
  prompt: string,
  response: Buffer,
): void {
  const observer = createClaudeSubagentUsageResponseObserver(bridge);
  const sink = observer({
    reqId,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://example.com',
    status: 200,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'text/event-stream' },
    requestBody: requestBody(model, prompt),
  });
  expect(sink).toBeTruthy();
  sink?.onData?.(response);
  sink?.onEnd?.();
}

describe('ClaudeSubagentUsageBridge', () => {
  it('attributes concurrent responses by prompt and uses latest input plus cumulative output', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-a',
      parentToolUseId: 'toolu-a',
      prompt: 'Solve calculator problem A',
      model: 'codex/gpt-5.6-terra',
    });
    bridge.registerTask({
      taskId: 'agent-b',
      parentToolUseId: 'toolu-b',
      prompt: 'Solve calculator problem B',
      model: 'codex/gpt-5.6-terra',
    });

    observe(bridge, 1, 'codex/gpt-5.6-terra', 'Solve calculator problem A', sse(100, 10, 20));
    observe(bridge, 2, 'codex/gpt-5.6-terra', 'Solve calculator problem B', sse(200, 30));
    observe(bridge, 3, 'codex/gpt-5.6-terra', 'Solve calculator problem A', sse(150, 5, 20));

    expect(bridge.getTaskUsage('agent-a')).toEqual({ totalTokens: 185 });
    expect(bridge.getTaskUsage('agent-b')).toEqual({ totalTokens: 230 });
  });

  it('does not observe unrelated parent-agent requests', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-a',
      parentToolUseId: 'toolu-a',
      prompt: 'Solve calculator problem A',
      model: 'codex/gpt-5.6-terra',
    });
    const observer = createClaudeSubagentUsageResponseObserver(bridge);
    const sink = observer({
      reqId: 1,
      method: 'POST',
      url: '/v1/messages',
      upstreamBase: 'https://example.com',
      status: 200,
      requestHeaders: {},
      responseHeaders: { 'content-type': 'text/event-stream' },
      requestBody: requestBody('claude-opus-4-6', 'Parent prompt'),
    });

    expect(sink).toBeNull();
    expect(bridge.getTaskUsage('agent-a')).toBeUndefined();
  });
});
