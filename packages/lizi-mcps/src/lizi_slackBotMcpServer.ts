/**
 * lizi_slackBotMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server,只在 Slack bot session(source='slack')里注入。
 * 与 lizi_feishuBotMcpServer 同构(bot↔user 通道工具, 目前只有
 * send_file_to_user);复用 FeishuBotToolRegistry(纯工具注册表, 与渠道无关)。
 *
 * 故意不与 feishu 版合并工厂 —— lizi_feishu_bot 的 tool 面对在跑的飞书会话是
 * prompt/cache 相邻物, 不动它;slack 是新 source, 工具只出现在新 session 里。
 *
 * chatId 注入方式:工厂签名 `createSlackBotMcpServer({ getChatId })`,
 * `getChatId` 是闭包返回当前 LiveSession.slackChatId(运行时可变)。
 * 桌面端 session 永远不会构造这个 MCP,所以模型在桌面端看不到这些工具。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from './json-object-arg.js';

import {
  FeishuBotToolRegistry,
  type FeishuBotToolResult,
} from './lizi_feishuBotToolRegistry';
import type { FeishuBotMcpHostDeps } from './types.js';

import descListTools from './prompts/lizi_slack_bot/tools/list_tools.md?raw';
import descCallTool from './prompts/lizi_slack_bot/tools/call_tool.md?raw';
import descSendFileToUser from './prompts/lizi_slack_bot/tools/send_file_to_user.md?raw';

const D = {
  list_tools: descListTools.trim(),
  call_tool: descCallTool.trim(),
  send_file_to_user: descSendFileToUser.trim(),
} as const;

// ── 共享规则:暂无,留空 map 占位,加新规则时直接塞进来 ────────────────────────
const RULES: Record<string, string> = {};

/** Host deps — sendFile 比 feishu 版多一个 threadTs 末位参数(thread = session)。 */
export interface SlackBotMcpDeps {
  /**
   * 返回当前 session 的 slack chat 标识(vendorOptions.slackChatId)。
   * null/undefined 表示当前不是 Slack 上下文, 工具一律返回 NO_CHAT_CONTEXT。
   */
  getChatId: () => string | null | undefined;
  /** 当前 session 对应的 thread root ts(vendorOptions.slackThreadTs;可缺省)。 */
  getThreadTs: () => string | null | undefined;
  /** 文件出站 — threadTs 存在时文件消息发进对应 thread。 */
  sendFile: (
    chatId: string,
    absPath: string,
    displayName?: string,
    threadTs?: string,
  ) => ReturnType<FeishuBotMcpHostDeps['sendFile']>;
  logger?: FeishuBotMcpHostDeps['logger'];
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildJsonResult(payload: unknown, isError = false): FeishuBotToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function isImageExt(absPath: string): boolean {
  const m = absPath.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return false;
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(m[1]);
}

// ── 细粒度工具:send_file_to_user ───────────────────────────────────────────

function registerSendFileToUser(
  registry: FeishuBotToolRegistry,
  deps: SlackBotMcpDeps,
): void {
  registry.register({
    name: 'send_file_to_user',
    category: 'bot',
    description: D.send_file_to_user,
    inputShape: {
      absPath: z
        .string()
        .min(1)
        .describe(
          '本地绝对路径(必填)。Windows 反斜杠或正斜杠都行;Unix 必须 / 开头',
        ),
      displayName: z
        .string()
        .optional()
        .describe('发送给用户看到的文件名,默认用 basename(absPath)'),
    },
    handler: async ({ absPath, displayName }) => {
      const chatId = deps.getChatId();
      if (!chatId) {
        return buildJsonResult(
          {
            ok: false,
            errorCode: 'NO_CHAT_CONTEXT',
            error:
              '当前 session 不在 Slack bot 上下文,无法发文件给用户。请检查 session.source。',
          },
          true,
        );
      }

      const result = await deps.sendFile(
        chatId,
        absPath,
        displayName,
        deps.getThreadTs() ?? undefined,
      );

      if (!result.ok) {
        const codeMap: Record<string, string> = {
          NOT_FOUND: 'FILE_NOT_FOUND',
          EMPTY: 'FILE_EMPTY',
          TOO_LARGE: 'FILE_TOO_LARGE',
          UPLOAD_FAIL: 'UPLOAD_FAILED',
          SEND_FAIL: 'SEND_FAILED',
        };
        const errorCode = codeMap[result.reason ?? ''] ?? 'SEND_FAILED';
        return buildJsonResult(
          {
            ok: false,
            errorCode,
            error: result.reason ?? 'unknown',
            request: { absPath, displayName },
          },
          true,
        );
      }

      return buildJsonResult({
        ok: true,
        sent: {
          absPath,
          displayName: result.reason ?? displayName,
          kind: isImageExt(absPath) ? 'image' : 'file',
        },
      });
    },
  });
}

// ── Entry tools ────────────────────────────────────────────────────────────

const CATEGORY_ENUM = ['bot'] as const;

function registerListToolsEntry(
  server: McpServer,
  registry: FeishuBotToolRegistry,
): void {
  server.tool(
    'list_tools',
    D.list_tools,
    {
      category: z
        .enum(CATEGORY_ENUM)
        .optional()
        .describe('工具类目。不传时返回所有类目概览。'),
    },
    async ({ category }) => {
      if (category) {
        const tools = registry.list(category);
        const ruleKeys = registry.collectRuleKeys(category);
        const bundledRules: Record<string, string> = {};
        for (const key of ruleKeys) {
          const body = RULES[key];
          if (body) bundledRules[key] = body;
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category,
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
                })),
                ...(Object.keys(bundledRules).length > 0
                  ? { rules: bundledRules }
                  : {}),
                hint: '调用具体工具用 call_tool({name, args})。每个 tool 的 rules 数组列出它必须遵守的共享规则键,完整规则在顶层 rules 字段。',
              }),
            },
          ],
        };
      }
      const counts: Record<string, number> = {};
      for (const t of registry.list()) {
        counts[t.category] = (counts[t.category] ?? 0) + 1;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().map((c) => ({
                name: c,
                tool_count: counts[c] ?? 0,
              })),
              hint: '用 list_tools({category}) 查看某类目下的工具列表',
            }),
          },
        ],
      };
    },
  );
}

function registerCallToolEntry(
  server: McpServer,
  registry: FeishuBotToolRegistry,
): void {
  server.tool(
    'call_tool',
    D.call_tool,
    {
      name: z
        .string()
        .describe('工具名,从 list_tools 获取(如 send_file_to_user)'),
      args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => registry.call(name, args),
  );
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createSlackBotMcpServer(deps: SlackBotMcpDeps): McpServer {
  const server = new McpServer({
    name: 'lizi_slack_bot',
    version: '1.0.0',
  });

  const registry = new FeishuBotToolRegistry();
  registerSendFileToUser(registry, deps);

  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry);

  return server;
}
