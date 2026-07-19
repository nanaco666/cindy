import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Regression guard for login progress that is intentionally owned by Electron main. */
describe('auth login-flow reset', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('clears renderer state, provider cache, and private tickets whenever auth is cleared', () => {
    const resetStart = source.indexOf('function resetLoginFlowState(): void {');
    const resetEnd = source.indexOf('\n}', resetStart);
    const resetBody = source.slice(resetStart, resetEnd);
    expect(resetBody).toContain('loginFlowState = null;');
    expect(resetBody).toContain('providerConfig = null;');
    expect(resetBody).toContain('discoveredMethods = [];');
    expect(resetBody).toContain('pendingLoginTicket = null;');
    expect(resetBody).toContain('pendingBindTicket = null;');

    const clearStart = source.indexOf('function clearAuth(');
    const clearEnd = source.indexOf('\n}\n\n// ── Public API', clearStart);
    const clearBody = source.slice(clearStart, clearEnd);
    expect(clearBody).toContain('resetLoginFlowState();');
    expect(clearBody).toContain('canaryFlagStore.clear();');
  });

  it('keeps the login-epoch guard and does not resurrect the legacy feishu token chain', () => {
    const completeStart = source.indexOf('async function completeLogin(');
    const completeEnd = source.indexOf('\n}\n\nasync function acceptLoginOutcome', completeStart);
    const completeBody = source.slice(completeStart, completeEnd);
    expect(completeBody).toContain('if (authStateEpoch !== loginEpoch)');
    expect(completeBody).toContain('notifyRenderer();');
    // 防复活:主机飞书 token 链已随 refresh-feishu 退役(2026-07-17),
    // authManager 不得再接 FeishuTokenManager(飞书授权归 xd-feishu 意识
    // 的 OAuth broker 通道)。
    expect(source).not.toContain('getFeishuService');
    expect(source).not.toContain('setJwt(');
  });

  it('registers enterprise-id SSO discovery into the start-browser connection whitelist', () => {
    // 企业 ID discovery 的连接必须写入 discoveredMethods:start-browser 的
    // connectionId 校验以它为白名单,漏写会让该入口发起的 SSO 全部 404。
    const start = source.indexOf("if (action.type === 'discover-sso-org') {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n    }', start));
    expect(body).toContain('discoveredMethods = ssoOrgDiscoveryToMethods(discovery)');
    expect(body).toContain("type: 'discovery-loaded'");
    expect(body).toContain("email: ''");
  });

  it('does not leave expired private tickets on a screen that can only reuse them', () => {
    expect(source).toContain("'INVALID_LOGIN_TICKET',");
    expect(source).toContain("'INVALID_BIND_TICKET',");
    expect(source).toContain("? { step: 'error', code, recoverTo: 'identifier' }");
  });

  it('drops a runtime refresh result after logout or a newer login changes auth generation', () => {
    const refreshStart = source.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    expect(refreshBody).toContain('const refreshEpoch = authStateEpoch;');
    expect(refreshBody).toContain("refreshWasSuperseded('after-refresh')");
    // 'after-product-me' 守卫点已随产品 /api/user/me 退役(2026-07):refresh
    // 与提交之间不再有产品资料网络往返,该迟到窗口不存在了。
    expect(refreshBody).not.toContain('/api/user/me');
    expect(refreshBody).toContain("refreshWasSuperseded('after-account-switch-teardown')");
    expect(refreshBody).toContain("refreshWasSuperseded('after-integration-reload')");
    expect(refreshBody).toContain("refreshWasSuperseded('catch')");
  });

  it('synchronizes canary flags on every path that establishes a new auth identity', () => {
    expect(source).not.toContain('canaryFlagStore.sync(false)');
    expect(source.match(/scheduleCanaryFlagSync\(\{/g)).toHaveLength(3);
    expect(source).toContain("getClientEndpoint('oauthBrokerApiBaseUrl')");
    expect(source).toContain("apiFetch('/api/user/feature-flags'");

    const syncStart = source.indexOf('function scheduleCanaryFlagSync(');
    const syncEnd = source.indexOf('\n}\n\n/**\n * 冷启动流程的进程内去重', syncStart);
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBody = source.slice(syncStart, syncEnd);
    expect(syncBody).toContain("if (outcome.kind === 'synced')");
    expect(syncBody).toContain('notifyRenderer();');

    const clearIntegrationsStart = source.indexOf('async function clearPerAccountIntegrations(');
    const clearIntegrationsEnd = source.indexOf('\n}', clearIntegrationsStart);
    expect(source.slice(clearIntegrationsStart, clearIntegrationsEnd)).not.toContain(
      'canaryFlagStore.clear()',
    );
  });
});
