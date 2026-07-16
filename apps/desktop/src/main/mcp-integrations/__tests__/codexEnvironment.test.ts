import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger, McpProvider } from '@lizi/maker-core';
import {
  getCodexExtraSpawnConfig,
  shutdownCodexEnvironment,
} from '../codexEnvironment.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function testProvider(): McpProvider {
  return {
    name: 'lizi_test',
    toClaudeSdkConfig: () => ({
      type: 'sdk',
      name: 'lizi_test',
      instance: new McpServer({ name: 'lizi_test', version: '1.0.0' }),
    }),
  };
}

/** 远程 HTTP MCP provider(无 in-process SDK server),带自定义 header。 */
function remoteHttpProvider(): McpProvider {
  return {
    name: 'themis',
    toCodexMcpConfig: () => ({
      type: 'http',
      url: 'https://themis.example/mcp',
      envHttpHeaders: { 'xd-themis-sk': 'CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK' },
    }),
    getExtraEnv: () => ({ CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK: 'sk-123' }),
  };
}

function extractUrl(args: string[]): URL {
  const value = args.find((arg) => arg.startsWith('mcp_servers.lizi_test.url='));
  if (!value) throw new Error('missing lizi_test URL arg');
  const raw = value.slice('mcp_servers.lizi_test.url='.length);
  return new URL(raw.replace(/^"|"$/g, ''));
}

describe('codexEnvironment', () => {
  afterEach(async () => {
    await shutdownCodexEnvironment();
  });

  it('reuses one bridge and exposes unbound MCP server URLs', async () => {
    const logger = noopLogger();
    const providers = [testProvider()];

    const first = await getCodexExtraSpawnConfig({
      mcpProviders: providers,
      logger,
    });
    const second = await getCodexExtraSpawnConfig({
      mcpProviders: providers,
      logger,
    });

    const firstUrl = extractUrl(first.extraArgs);
    const secondUrl = extractUrl(second.extraArgs);

    expect(first).toBe(second);
    expect(first.bridge).toBe(second.bridge);
    expect(first.extraEnv).toEqual(second.extraEnv);
    expect(firstUrl.origin).toBe(secondUrl.origin);
    expect(firstUrl.pathname).toBe('/mcp/lizi_test');
    expect(secondUrl.pathname).toBe('/mcp/lizi_test');
  });

  it('serializes remote HTTP custom headers as env_http_headers -c overrides (no bridge)', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [remoteHttpProvider()],
      logger: noopLogger(),
    });

    // 纯远程 MCP，不需要 in-process bridge。
    expect(cfg.bridge).toBeNull();
    // header 值走 env，env var 名进 -c，实际值进 extraEnv（不暴露在 process args）。
    expect(cfg.extraArgs).toContain(
      'mcp_servers.themis.env_http_headers.xd-themis-sk="CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK"',
    );
    expect(cfg.extraEnv).toMatchObject({
      CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK: 'sk-123',
    });
    // 密钥明文绝不出现在 spawn 参数里。
    expect(cfg.extraArgs.some((a) => a.includes('sk-123'))).toBe(false);
  });
});
