/** Desktop 端的 Claude 只读工具白名单与 Codex MCP 审批策略。 */

import type { McpToolApprovalContext, McpToolApprovalPolicy } from '@lizi/maker-core';
import { canAutoApproveContactsMcpTool } from 'lizi-mcps';

/**
 * Claude Code `options.allowedTools` 的第一方只读白名单。
 *
 * 这里只收录工具整体都无写副作用、且不外发数据的精确名称，禁止 wildcard / 前缀匹配：
 * progressive `call_tool`、`ghost_call` 等聚合入口的风险取决于内层 action，不能
 * 因 server 属于第一方就粗粒度放行。`WebSearch` / `WebFetch` 虽只读但会把搜索词 / URL
 * 发往外部服务（exfiltration 面），与 maker-core `READ_ONLY_CLAUDE_TOOLS` 的既有边界
 * 保持一致，不列入免审批。新增工具默认继续走原权限链，必须 review 后显式加入。
 */
const DESKTOP_CLAUDE_READ_ONLY_ALLOWED_TOOLS = [
  'mcp__cindy__ghost_list',
  'mcp__cindy__ghost_forge_guide',
  'mcp__lizi_browser__list_tools',
  'mcp__lizi_android__list_tools',
  'mcp__lizi_computer__list_tools',
  'mcp__lizi_feishu_bot__list_tools',
  'mcp__cindy_scheduler__list_tools',
  'mcp__lizi_ssh__list_tools',
  'mcp__cindy_helper__list_tools',
  'mcp__cindy_memory__list_tools',
  'mcp__lizi_contacts__list_tools',
  'mcp__lizi_slack__slack_status',
] as const;

/** 返回副本，避免 SDK / 调用方原地改写 host 的白名单真源。 */
export function getDesktopClaudeReadOnlyAllowedTools(): string[] {
  return [...DESKTOP_CLAUDE_READ_ONLY_ALLOWED_TOOLS];
}

/**
 * 保持可信内置 MCP 安静执行，同时让 destructive / external contacts action 每次确认。
 */
export function getDesktopMcpToolApprovalPolicy(
  context: McpToolApprovalContext,
): McpToolApprovalPolicy {
  const { serverName, toolName, toolParams } = context;
  if (serverName === 'lizi_contacts') {
    return canAutoApproveContactsMcpTool({ toolName, toolParams })
      ? 'auto-approve'
      : 'prompt-each-time';
  }
  // `<平台>_lizi` 显式白名单分支已随 gitlab_lizi 于 2026-07-14 退役清空
  // (github_lizi / gitlab_lizi 先后迁入内置意识 cindy-github / cindy-gitlab)。
  if (
    serverName === 'cindy_scheduler'
    || serverName === 'cindy_memory'
    || (serverName.startsWith('lizi_') && serverName !== 'lizi_ssh')
  ) {
    return 'auto-approve';
  }
  return 'prompt';
}
