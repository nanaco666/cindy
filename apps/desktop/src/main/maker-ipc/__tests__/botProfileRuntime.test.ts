import { describe, expect, it } from 'vitest';

import {
  buildBotCapabilityContextPrompt,
  buildBotProfileContextPrompt,
  buildBotProfilePrompt,
  resolveBotMcpReferences,
  resolveBotSkillReferences,
  resolveInheritedBotSkills,
  resolveBotToolsetReferences,
  withBotHomeDir,
} from '../botProfileRuntime';
import { buildDefaultBotIdentity } from '../../../shared/botProfileDefaults';
import { BOT_TEMPLATES } from '../../../renderer/features/bots/botTemplates';

describe('Bot Profile runtime prompt', () => {
  it('uses the SOUL source verbatim as the complete identity slot', () => {
    const prompt = buildBotProfilePrompt({
      displayName: 'Kitchen helper',
      identitySource: 'A calm chef who explains recipes clearly.',
    });
    expect(prompt).toBe('A calm chef who explains recipes clearly.');
    expect(prompt).not.toContain('Cindy Bot Profile');
    expect(prompt).not.toContain('Profile version');
    expect(prompt).not.toContain('Configured skill');
    expect(prompt).not.toContain('tool/MCP');
    expect(prompt).not.toContain('memory policy');
    expect(prompt).not.toContain('Automation policy');
  });

  it('seeds a useful Hermes-style identity when the SOUL source is empty', () => {
    const prompt = buildBotProfilePrompt({
      displayName: 'Research helper',
      identitySource: '',
    });
    expect(prompt).toContain('You are Research helper');
  });

  it('uses the same persisted default SOUL as the runtime fallback', () => {
    const soul = buildDefaultBotIdentity('Research helper');
    expect(
      buildBotProfilePrompt({ displayName: 'Research helper', identitySource: soul }),
    ).toBe(soul);
  });

  it('keeps the active profile marker separate from SOUL', () => {
    expect(buildBotProfileContextPrompt('Kitchen helper')).toBe(
      'Active Cindy Bot profile: Kitchen helper.',
    );
  });

  it('teaches every Bot to discover its live collaboration surface before denying it', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('You are running as a Cindy Bot');
    expect(prompt).toContain('Use `list_tools`');
    expect(prompt).toContain('discover other available Bots');
    expect(prompt).toContain('receive the result back in this task');
    expect(prompt).toContain('inspect ongoing or completed handoffs');
    expect(prompt).toContain('cancel a handoff that is still active');
    expect(prompt).toContain('does not rewrite another Bot\'s identity');
    expect(prompt).toContain('offer the available delegation path');
    expect(prompt).not.toContain('delegate_to_bot');
    expect(prompt).not.toContain('list_bot_delegations');
  });

  /**
   * 批次 ε:设置页的「TA 学会的」按 `learned-` slug 前缀切片。前缀只有在这条约定
   * 还在 prompt 里时才会被写出来 —— 删掉它,那个列表就永远是空的。
   */
  it('teaches the learned- naming convention that feeds "TA 学会的"', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('`learned-` name prefix');
    // 判断"什么值得记成可复用做法"留给模型;代码只做确定性的前缀检出。
    expect(prompt).toContain('a reusable way of working');
    // 不许暗示这是另一个存储:它就是同一份记忆,只是名字不同。
    expect(prompt).toContain('Both stay in your memory');
  });

  /**
   * 批次 ζ:「TA 学会的」列的是**真技能**,来源是伙伴自己调 `save_bot_skill`。
   * 这条约定掉了,技能就永远长不出来 —— 判断「这次做法值不值得沉淀」是语言理解
   * 问题,代码判不了(maker-core-and-agent-behavior.md §2 的分界)。
   */
  it('tells the Bot to distil a finished multi-step task into a real skill', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('`save_bot_skill`');
    // 先查再存 —— 否则同一件事会被反复学成好几条。
    expect(prompt).toContain('`list_bot_skills`');
    expect(prompt).toContain('save it again under the same name');
    // 存的是步骤,不是这一次的结论。
    expect(prompt).toContain('repeatable steps');
    // 诚实标注生效时机:harness 的技能面在 spawn 时冻结。
    expect(prompt).toContain('mounted from your next task onward');
  });

  it('keeps the same affirmative delegation guidance beside the default and every preset SOUL', () => {
    const identities = [
      { name: 'Default Bot', identitySource: buildDefaultBotIdentity('Default Bot') },
      ...BOT_TEMPLATES.map((template) => ({
        name: template.id,
        identitySource: template.identitySource,
      })),
    ];
    for (const identity of identities) {
      const runtimePrompt = [
        buildBotProfilePrompt({
          displayName: identity.name,
          identitySource: identity.identitySource,
        }),
        buildBotProfileContextPrompt(identity.name),
        buildBotCapabilityContextPrompt(),
      ].join('\n\n');
      expect(runtimePrompt).toContain('can discover other available Bots');
      expect(runtimePrompt).toContain('hand off a bounded objective');
      expect(runtimePrompt).toContain('receive the result back in this task');
      expect(runtimePrompt).toContain('offer the available delegation path');
      expect(runtimePrompt).not.toContain('redirecting them to a separate team workflow.\n\nYou are');
    }
  });

  it('admits only Skills proven by the selected harness catalog', () => {
    expect(
      resolveBotSkillReferences(
        ['recipe-planner', 'missing', 'broken'],
        [
          { name: 'recipe-planner', runtimeCommandName: 'recipe', enabled: true },
          { name: 'broken', runtimeStatus: 'failed' },
        ],
      ),
    ).toEqual({
      resolvedSkills: ['recipe'],
      unavailableSkills: ['missing', 'broken'],
      resolvedSkillEntries: [
        { name: 'recipe-planner', runtimeCommandName: 'recipe', enabled: true },
      ],
    });
  });

  it('keeps builtin MCP outside the custom MCP allowlist', () => {
    expect(
      resolveBotMcpReferences({
        mode: 'allowlist',
        configured: ['search', 'missing', 'cindy_memory'],
        catalog: [
          { name: 'search', source: 'custom', available: true },
          { name: 'cindy_memory', source: 'builtin', available: true },
        ],
      }),
    ).toEqual({
      resolved: ['search'],
      unavailable: ['missing', 'cindy_memory'],
    });
  });

  it('combines Bot toolset policy with project availability', () => {
    expect(
      resolveBotToolsetReferences({
        mode: 'allowlist',
        configured: ['browser', 'contacts', 'missing'],
        catalog: [
          { id: 'core', name: 'Core', essential: true, available: true },
          { id: 'browser', name: 'Browser', available: true },
          { id: 'contacts', name: 'Contacts', available: false },
          { id: 'calendar', name: 'Calendar', available: true },
        ],
      }),
    ).toEqual({
      resolved: ['browser'],
      unavailable: ['contacts', 'missing'],
      disabled: ['contacts', 'calendar'],
    });
  });
});

/*
  伙伴够不够得到自己的家。

  这是文件夹化那句理由(「伙伴自己也读得到、改得动自己的灵魂」)的技术前提。它
  曾经整条断在这里:提示词里列了家里的文件名,可路径没给、目录也没挂进工具面 ——
  伙伴看得见名字,一个都打不开。锁死两件事:家一定会被挂上去,而且不会踩掉用户
  自己加的引用目录。
*/
describe('伙伴的家进不进工具面', () => {
  const HOME = '/data/bots/bot-a';

  it('用户没加过引用目录时,家就是唯一那一个', () => {
    expect(withBotHomeDir(undefined, HOME)).toEqual([HOME]);
    expect(withBotHomeDir([], HOME)).toEqual([HOME]);
  });

  it('用户自己加的目录原样保留,家补在后面', () => {
    expect(withBotHomeDir(['/work/design', '/work/docs'], HOME)).toEqual([
      '/work/design',
      '/work/docs',
      HOME,
    ]);
  });

  it('重复挂载去重 —— 同一轮里补两次不会挂出两份', () => {
    const once = withBotHomeDir(['/work/design'], HOME)!;
    expect(withBotHomeDir(once, HOME)).toEqual(once);
  });

  it('没有家(远端会话)时不动用户的设置,也不凭空造出一个空数组', () => {
    expect(withBotHomeDir(undefined, '')).toBeUndefined();
    expect(withBotHomeDir(undefined, '   ')).toBeUndefined();
    expect(withBotHomeDir(['/work/design'], '')).toEqual(['/work/design']);
  });
});

/**
 * 关掉一个技能,不等于把这个伙伴的能力面冻结在今天。
 *
 * 原先设置页里取消勾选任何一项,都会把 skillMode 切成 allowlist 并把**当下的目录整个
 * 快照**写死。用户的心理动作只是「我不想要这一个」,系统实际做的却是「以后 Cindy 内置
 * 新技能、用户装新插件,这个伙伴一个都吃不到」,而且没有任何提示。
 *
 * 改成存排除项(Hermes 的 disabled_skills 存法)之后,减法每次都对着**当时**的目录做,
 * 所以新技能自动进得来。
 */
describe('跟随全局时关掉某几项技能', () => {
  const item = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, runtimeCommandName: name, ...extra }) as never;

  it('只关掉点名的那一项,其余照常', () => {
    const catalog = [item('写周报'), item('查天气'), item('订会议室')];
    const resolved = resolveInheritedBotSkills(catalog, new Set(['查天气']));
    expect(resolved.map((entry) => entry.name)).toEqual(['写周报', '订会议室']);
  });

  it('关掉一项之后,后来新增的技能仍然进得来', () => {
    const excluded = new Set(['查天气']);
    const before = resolveInheritedBotSkills([item('写周报'), item('查天气')], excluded);
    expect(before.map((entry) => entry.name)).toEqual(['写周报']);

    // 用户装了个新插件 —— 目录长出一项,伙伴的配置一个字没改。
    const after = resolveInheritedBotSkills(
      [item('写周报'), item('查天气'), item('刚装的新技能')],
      excluded,
    );
    expect(after.map((entry) => entry.name)).toEqual(['写周报', '刚装的新技能']);
  });

  it('排除项用 name 或 runtimeCommandName 写都认', () => {
    const catalog = [item('周报', { runtimeCommandName: 'weekly-report' })];
    expect(resolveInheritedBotSkills(catalog, new Set(['周报']))).toHaveLength(0);
    expect(resolveInheritedBotSkills(catalog, new Set(['weekly-report']))).toHaveLength(0);
  });

  it('禁用与加载失败的技能本来就不进,与排除项无关', () => {
    const catalog = [
      item('关着的', { enabled: false }),
      item('坏了的', { runtimeStatus: 'failed' }),
      item('好的'),
    ];
    expect(resolveInheritedBotSkills(catalog, new Set()).map((entry) => entry.name)).toEqual([
      '好的',
    ]);
  });

  it('没有排除项时就是目录里可用的全部', () => {
    const catalog = [item('a'), item('b')];
    expect(resolveInheritedBotSkills(catalog, new Set())).toHaveLength(2);
  });
});
