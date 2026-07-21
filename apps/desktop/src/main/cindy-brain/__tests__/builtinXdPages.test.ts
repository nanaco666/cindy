import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

type HostMessageHandler = (message: Record<string, unknown>) => Promise<void>;

interface CindyMessage {
  type: string;
  ok?: boolean;
  errorCode?: string;
  message?: string;
  result?: unknown;
}

const pagesSource = readFileSync(
  new URL('../../../../resources/builtin-ghosts/xd-pages/main.js', import.meta.url),
  'utf8',
);

function createPagesHarness(response: Record<string, unknown>) {
  let handler: HostMessageHandler | undefined;
  const messages: CindyMessage[] = [];
  const cindy = {
    onHostMessage(nextHandler: HostMessageHandler) {
      handler = nextHandler;
    },
    send(message: CindyMessage) {
      messages.push(message);
    },
    fetch: vi.fn(async () => response),
  };
  new Script(pagesSource, { filename: 'builtin-ghosts/xd-pages/main.js' }).runInContext(
    createContext({ cindy, setTimeout, clearTimeout, URL, encodeURIComponent }),
  );
  if (!handler) throw new Error('XD Pages did not register its host-message handler');
  return {
    fetch: cindy.fetch,
    async call(tool: string, args: Record<string, unknown>) {
      messages.length = 0;
      await handler!({ type: 'tool-call', tool, callId: 'call-1', args });
      const result = messages.findLast((message) => message.type === 'tool-result');
      if (!result) throw new Error('XD Pages did not return a tool-result');
      return result;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('内置意识 xd-pages 错误码映射', () => {
  it('HTTP 状态优先于响应体中的通用错误码', async () => {
    const forbidden = createPagesHarness({
      ok: true,
      status: 403,
      body: JSON.stringify({ errorCode: 'PAGES_API_ERROR', message: 'forbidden' }),
    });
    await expect(forbidden.call('pages_info', { name: 'test-site' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });

    const notFound = createPagesHarness({
      ok: true,
      status: 404,
      body: JSON.stringify({ errorCode: 'PAGES_API_ERROR', message: 'missing' }),
    });
    await expect(notFound.call('pages_info', { name: 'test-site' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });
  });

  it('429 仍返回 RATE_LIMITED 并走一次重试', async () => {
    vi.useFakeTimers();
    const rateLimited = createPagesHarness({
      ok: true,
      status: 429,
      body: JSON.stringify({ errorCode: 'PAGES_API_ERROR', message: 'busy' }),
    });
    const result = rateLimited.call('pages_info', { name: 'test-site' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    expect(rateLimited.fetch).toHaveBeenCalledTimes(2);
  });
});
