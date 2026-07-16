import { describe, expect, it } from 'vitest';

import { getDesktopMcpToolApprovalPolicy } from '../mcp-tool-approval-policy.js';

describe('desktop MCP approval policy', () => {
  it('keeps known safe contacts calls trusted', () => {
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'lizi_contacts',
        toolParams: { name: 'contacts_search', args: { query: 'Dash' } },
      }),
    ).toBe('auto-approve');
  });

  it('prompts each time for destructive and malformed contacts calls', () => {
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'lizi_contacts',
        toolParams: { name: 'contacts_merge', args: { target_id: 'a', source_id: 'b' } },
      }),
    ).toBe('prompt-each-time');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'lizi_contacts' })).toBe(
      'prompt-each-time',
    );
  });

  it('preserves the existing built-in allowlist and lizi_ssh exception', () => {
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'lizi_memory' })).toBe('auto-approve');
    // gitlab_lizi 已于 2026-07-14 退役(迁入内置意识 cindy-gitlab):
    // `<平台>_lizi` 显式白名单清空后,该名字回落到默认 prompt,不再自动放行。
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'gitlab_lizi' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'lizi_ssh' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'third_party' })).toBe('prompt');
  });
});
