import { describe, expect, it } from 'vitest';

import { parseImBotPersonalChannel } from '../botChannelConnectRoutes';

describe('?imChannel= 的解析', () => {
  it('认得每一张个人分区卡片', () => {
    for (const value of ['wechat', 'wecom', 'feishu', 'discord', 'telegram', 'dingtalk']) {
      expect(parseImBotPersonalChannel(value)).toBe(value);
    }
  });

  it('未知值一律 null,不抛 —— 深链是用户可以随手改的东西', () => {
    expect(parseImBotPersonalChannel('slack')).toBeNull();
    expect(parseImBotPersonalChannel('')).toBeNull();
    expect(parseImBotPersonalChannel(null)).toBeNull();
    expect(parseImBotPersonalChannel(undefined)).toBeNull();
  });
});
