/**
 * 伙伴对话皮肤的接线契约。
 *
 * 这三处判定都长在超大组件里(CCAgentSessionView 5k 行 / MessageStream 5.8k 行 /
 * ChatInput 8k 行),在 jsdom 里整棵挂起来既慢又脆。真正要锁死的是**判定条件本身**:
 * 头像与收控件只能对 Bot 会话生效,普通任务的渲染必须一字不改。所以这里锁源码契约,
 * 纯逻辑部分(占位符选词、欢迎语幂等)另有真实单测。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string =>
  readFileSync(resolve(__dirname, '..', '..', '..', relativePath), 'utf8').replace(/\r\n/g, '\n');

const sessionView = read('features/cc-agent/CCAgentSessionView.tsx');
const messageStream = read('components/chat/MessageStream.tsx');
const chatInput = read('components/new-chat/ChatInput.tsx');

describe('Bot 对话的判定条件', () => {
  it('「这是跟伙伴的对话」需要路由身份与 session.source 同时成立', () => {
    // URL 只是导航投影。少了 source 这一半,任何 /bots/... 链接都能把普通任务
    // 伪装成伙伴对话。
    expect(sessionView).toContain(
      "botIdentity && session?.source === 'bot' ? botIdentity : null",
    );
  });

  it('气泡头像只在 Bot 对话下传给消息流', () => {
    expect(sessionView).toContain('assistantAvatar={botAssistantAvatar}');
    expect(sessionView).toContain('botChatIdentity ? (\n        <BotAvatar bot={botChatIdentity}');
  });

  it('伙伴对话隐藏权限与模型入口,普通任务仍走原占位符', () => {
    expect(sessionView).toContain('botComposerPlaceholderKey(botChatIdentity.name)');
    // 普通任务仍走原来的占位符。
    expect(sessionView).toContain("t('ccAgent.layout.chatPlaceholder')");
    expect(sessionView).toContain('hideRuntimeControls={Boolean(botChatIdentity)}');
  });

  it('伙伴对话换掉任务顶栏,而不是在它旁边再加一个', () => {
    expect(sessionView).toContain(
      '<BotSessionContentHeaderRegistration bot={botChatIdentity} sessionId={sessionId} />',
    );
    expect(sessionView).toContain('<SessionContentHeaderRegistration');
  });
});

describe('消息流的头像挂载', () => {
  it('没有头像时原样返回气泡,不多包一层 DOM', () => {
    const helper = messageStream.match(
      /function withAssistantAvatar\([\s\S]*?\n}/,
    )?.[0];
    expect(helper).toBeTruthy();
    expect(helper).toContain('if (!avatar) return bubble;');
  });

  it('只有 assistant 分支挂头像', () => {
    expect(messageStream).toContain('return withAssistantAvatar(\n        assistantAvatar,');
    // 全文只有「定义 + 一处调用」两次出现:user 气泡、工具卡、工作组里的中间
    // 过程文字都不经过它。
    expect(messageStream.match(/withAssistantAvatar\(/g)?.length).toBe(2);
  });
});

describe('输入框的运行时控件门控', () => {
  it('ChatInput 支持隐藏权限与模型入口', () => {
    expect(chatInput).toContain('hideRuntimeControls?: boolean;');
    expect(chatInput).toContain('hideRuntimeControls = false,');
    expect(chatInput).toContain('{!hideRuntimeControls && (');
  });

  it('隐藏入口时也禁用权限快捷键轮切', () => {
    expect(chatInput).toContain(
      'settingsLocked || hideRuntimeControls\n        ? []\n        : (activeAgentCapabilities?.permissionModes ?? []),',
    );
  });
});

/**
 * 伙伴会话仍由 Profile 的默认模型 / 权限驱动,这里只是不把运行时切换入口暴露在 composer。
 */
describe('伙伴对话的运行时选择回写 Profile', () => {
  it('模型 / effort / 权限 / 供应商 / fast 五个入口都接上了回写', () => {
    expect(sessionView).toContain('mirrorBotComposerRuntime({ model: newModelId })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ effort: newEffort })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ permissionMode: newMode })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ providerId: newProviderId })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ fastMode: next })');
    expect(sessionView).toContain('onProviderDidChange={handleProviderDidChange}');
    expect(sessionView).toContain('onFastModeChange={handleFastModeChange}');
  });

  it('普通任务一行都不写:没有伙伴身份就直接返回', () => {
    expect(sessionView).toContain('const botId = botChatIdentityRef.current?.id;\n      if (!botId) return;');
  });
});

/**
 * 批次 ε:成长尾注。判定层(botGrowth.ts)有真实单测,这里只锁**接线**——尾注
 * 是否真的只对伙伴对话生效、是否只挂在收尾正文上。
 */
describe('成长尾注的接线', () => {
  it('只有伙伴对话把 botId 传进消息流,普通任务连判定都不跑', () => {
    expect(sessionView).toContain('botGrowthBotId={botChatIdentity?.id}');
    // 普通任务拿模块级空表,不遍历消息,也不产生新对象引用。
    expect(messageStream).toContain('if (!botGrowthBotId) {');
    expect(messageStream).toContain('return EMPTY_BOT_GROWTH_NOTES;');
    expect(messageStream).toContain('const EMPTY_BOT_GROWTH_NOTES');
  });

  it('尾注挂在 assistant 收尾正文上,判定复用 action bar 那套 turn 口径', () => {
    expect(messageStream).toContain(
      'collectBotGrowthNotes(visibleMessages, turnFinalAssistantClientIds)',
    );
    expect(messageStream).toContain('<BotGrowthNote botId={growthBotId} note={growthNote} />');
  });

  it('两个条件都成立才渲染:是伙伴对话,且这轮真的写了记忆', () => {
    expect(messageStream).toContain('{growthBotId && growthNote ? (');
  });

  it('工作组里的中间过程文字不挂尾注(与头像同一条口径)', () => {
    // MessageItem 有两个调用点,只有对话流那处传 growth 相关 prop。
    expect(messageStream.match(/growthNote=\{/g)?.length).toBe(1);
    expect(messageStream.match(/growthBotId=\{/g)?.length).toBe(1);
  });
});
