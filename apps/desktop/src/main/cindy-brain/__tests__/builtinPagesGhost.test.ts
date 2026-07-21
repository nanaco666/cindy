import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type HostMessageHandler = (message: Record<string, unknown>) => Promise<void>;

interface CindyMessage {
  type: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  message?: string;
}

const pagesSource = readFileSync(
  new URL('../../../../resources/builtin-ghosts/xd-pages/main.js', import.meta.url),
  'utf8',
);

function createPagesHarness(response: Record<string, unknown>) {
  let handler: HostMessageHandler | undefined;
  const messages: CindyMessage[] = [];
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: JSON.stringify(response),
  }));
  const cindy = {
    onHostMessage: vi.fn((nextHandler: HostMessageHandler) => {
      handler = nextHandler;
    }),
    send: vi.fn((message: CindyMessage) => messages.push(message)),
    fetch,
  };

  new Script(pagesSource, { filename: 'builtin-ghosts/xd-pages/main.js' }).runInContext(
    createContext({ cindy }),
  );
  if (!handler) throw new Error('XD Pages did not register its host-message handler');

  return {
    fetch,
    async call(tool: string, args: Record<string, unknown>): Promise<CindyMessage> {
      messages.length = 0;
      await handler!({ type: 'tool-call', tool, callId: 'call-1', args });
      const result = messages.findLast((message) => message.type === 'tool-result');
      if (!result) throw new Error('XD Pages did not return a tool-result');
      return JSON.parse(JSON.stringify(result)) as CindyMessage;
    },
  };
}

const deposit = {
  token: 'deposit-token',
  rel_paths: ['_worker.js'],
  file_count: 1,
};

describe('内置意识 XD Pages 部署访问范围', () => {
  it('worker 不把服务端 IP 限制误报为站点已受保护', async () => {
    const harness = createPagesHarness({
      status: 'ok',
      url: 'https://demo.workers.xd.team',
      preset: 'worker',
      ipRestrict: true,
      warning: 'worker preset 需要自行调用 ip-guard',
    });

    const result = await harness.call('pages_deploy', { name: 'demo', dir_deposit: deposit });
    expect(result.ok).toBe(true);
    const payload = result.result as unknown as { user_facing_markdown?: string };
    const markdown = String(payload.user_facing_markdown);
    expect(markdown).toContain('Worker 代码自行决定');
    expect(markdown).not.toContain('访问范围: 仅公司内网可访问');
    expect(markdown).toContain('worker preset 需要自行调用 ip-guard');
  });

  it('static 使用服务端返回的 IP 限制状态', async () => {
    const harness = createPagesHarness({
      status: 'ok',
      url: 'https://demo.workers.xd.team',
      preset: 'static',
      ipRestrict: true,
    });

    const result = await harness.call('pages_deploy', {
      name: 'demo',
      dir_deposit: { ...deposit, rel_paths: ['index.html'] },
    });
    expect(result.ok).toBe(true);
    const payload = result.result as unknown as { user_facing_markdown?: string };
    const markdown = String(payload.user_facing_markdown);
    expect(markdown).toContain('访问范围: 仅公司内网可访问');
  });

  it('拒绝服务端不接受的 public=true', async () => {
    const harness = createPagesHarness({});
    const result = await harness.call('pages_deploy', {
      name: 'demo',
      public: true,
      dir_deposit: deposit,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('public=true');
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('worker 模板使用服务端注入的 env.IP_ALLOWLIST', async () => {
    const harness = createPagesHarness({});
    const result = await harness.call('pages_get_worker_template', { type: 'ip-guard' });
    expect(result.ok).toBe(true);
    const template = result.result?.data as unknown as { source: string; usage: string };
    expect(template.source).toContain('env.IP_ALLOWLIST');
    expect(template.source).toContain('checkIP(request, env)');
    expect(template.usage).toContain('checkIP(request, env)');
  });
});
