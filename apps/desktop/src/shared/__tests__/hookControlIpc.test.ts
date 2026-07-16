/**
 * slackHookInstallUrl: WS 地址 → Slack App 安装链接的纯函数推导。
 * 受控域名不写字面量(check-endpoint-literals):协议转换语义用中性域名断言,
 * 内置默认地址用 SLACK_HOOK_DEFAULT_URL 常量推导预期。
 */
import { describe, expect, it } from 'vitest';

import { SLACK_HOOK_DEFAULT_URL, slackHookInstallUrl } from '../hookControlIpc';

describe('slackHookInstallUrl', () => {
  it('wss 转 https 并拼 /slack/install', () => {
    expect(slackHookInstallUrl('wss://example.com')).toBe('https://example.com/slack/install');
  });

  it('ws 转 http(本地自部署调试)', () => {
    expect(slackHookInstallUrl('ws://localhost:8787')).toBe('http://localhost:8787/slack/install');
  });

  it('尾斜杠不产生双斜杠', () => {
    expect(slackHookInstallUrl('wss://example.com/')).toBe('https://example.com/slack/install');
  });

  it('内置默认地址可用', () => {
    // 完整字符串断言(而非拆 protocol/host/pathname):意外追加 query/hash 也要能测出来,
    // 该结果会被设置页直接交给 openExternal。转换语义本身由上面的中性域名用例钉住。
    expect(slackHookInstallUrl(SLACK_HOOK_DEFAULT_URL)).toBe(
      `${SLACK_HOOK_DEFAULT_URL.replace(/^wss:\/\//, 'https://').replace(/\/+$/, '')}/slack/install`,
    );
  });
});
