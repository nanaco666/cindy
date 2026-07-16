/** Desktop policy for Codex MCP approval elicitations. */

import type { McpToolApprovalContext, McpToolApprovalPolicy } from '@lizi/maker-core';
import { canAutoApproveContactsMcpTool } from 'lizi-mcps';

/**
 * Keep trusted built-ins quiet while requiring a fresh prompt for every
 * destructive or external lizi_contacts action.
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
  if (serverName.startsWith('lizi_') && serverName !== 'lizi_ssh') {
    return 'auto-approve';
  }
  return 'prompt';
}
