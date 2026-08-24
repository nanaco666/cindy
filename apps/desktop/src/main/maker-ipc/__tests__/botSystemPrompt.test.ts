/**
 * 伙伴系统提示词三层装配的行为锁。
 *
 * 这些断言存在的理由是一次真机事故:cindy_docs 明明挂载成功(日志
 * instance_resolved),伙伴却从没调用过 make_pptx —— 提示词里一个字都没写它会
 * 做文件,只写了「自己用 list_tools 去发现」。所以这里锁的不是措辞,而是
 * **能力有没有被写进提示词**,以及**没挂的能力有没有被闭嘴**。
 */
import { describe, expect, it } from 'vitest';

import {
  buildBotRenewalHandoff,
  buildBotTeammateRoster,
  buildBotSkillIndex,
  buildBotStableTier,
  buildBotSystemPrompt,
  buildBotVolatileTier,
  type BotSystemPromptInput,
} from '../botSystemPrompt';

function input(overrides: Partial<BotSystemPromptInput> = {}): BotSystemPromptInput {
  return {
    displayName: '小满',
    identity: '你是小满,设计师。',
    capabilities: {
      toolsets: [],
      memoryEnabled: false,
      delegationEnabled: false,
      ownSkillsEnabled: false,
    },
    skillIndex: [],
    ...overrides,
  };
}

describe('稳定层:能力必须写进提示词', () => {
  it('挂了 docs 就点名文档工具,并写清 PDF 要自检', () => {
    const stable = buildBotStableTier(
      input({
        capabilities: {
          toolsets: ['docs'],
          memoryEnabled: false,
          delegationEnabled: false,
          ownSkillsEnabled: false,
        },
      }),
    );
    for (const tool of ['make_pptx', 'make_docx', 'make_xlsx', 'render_pdf', 'read_sheet']) {
      expect(stable).toContain(tool);
    }
    expect(stable).toContain('inspect_pdf');
    // 真机事故的直接对策:不许再去找外部库。
    expect(stable).toContain('python-pptx');
  });

  it('没挂 docs 就一个文档工具名都不提(免得调一个不存在的工具)', () => {
    const stable = buildBotStableTier(input());
    expect(stable).not.toContain('make_pptx');
    expect(stable).not.toContain('render_pdf');
  });

  it('记忆 / 技能 / 协作 / 日程各自按信号出现', () => {
    const all = buildBotStableTier(
      input({
        capabilities: {
          toolsets: ['docs', 'scheduler'],
          memoryEnabled: true,
          delegationEnabled: true,
          ownSkillsEnabled: true,
        },
      }),
    );
    expect(all).toContain('你记得住事');
    expect(all).toContain('save_bot_skill');
    expect(all).toContain('叫别的伙伴帮忙');
    expect(all).toContain('定时干活');

    const none = buildBotStableTier(input());
    expect(none).not.toContain('save_bot_skill');
    expect(none).not.toContain('定时干活');
  });

  it('交付纪律恒在:要真做出来,被挡住说实话,不许编', () => {
    const stable = buildBotStableTier(input());
    expect(stable).toContain('把活干完');
    expect(stable).toContain('绝不编造');
    // 「自己去发现有什么工具」那句话必须已经不在了 —— 它正是事故的根源。
    expect(stable).not.toContain('list_tools');
  });

  it('作品集恒挂:任何伙伴都可能产出文件 / 图片 / 视频', () => {
    expect(buildBotStableTier(input())).toContain('作品集');
  });
});

describe('易变层:技能索引全部可见', () => {
  it('每个技能的名字都在索引里,不截断', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }));
    const index = buildBotSkillIndex(entries);
    for (const entry of entries) expect(index).toContain(entry.name);
  });

  it('没有技能时不产出空标题', () => {
    expect(buildBotSkillIndex([])).toBe('');
  });

  it('技能索引排在记忆快照之前(易变层内部顺序)', () => {
    const volatile = buildBotVolatileTier(
      input({
        skillIndex: [{ name: 'weekly-report', description: '周报怎么写' }],
        memorySnapshot: '## 记忆\n他偏好先看两版',
      }),
    );
    expect(volatile.indexOf('weekly-report')).toBeLessThan(volatile.indexOf('## 记忆'));
  });
});

describe('三层顺序', () => {
  it('身份在最前、易变层在最后', () => {
    const built = buildBotSystemPrompt(
      input({
        skillIndex: [{ name: 'deck-layout' }],
        contextSections: ['## 会话控制\n只读'],
      }),
    );
    expect(built.full.indexOf('你是小满')).toBe(0);
    expect(built.full.indexOf('## 会话控制')).toBeLessThan(built.full.indexOf('deck-layout'));
  });
});

/*
  伙伴的家怎么进提示词。

  这是整个文件夹化的理由:Hermes 的 agent 改得动自己的 SOUL.md —— 它为此写了跨
  profile 的写入保护,也处理了「灵魂被改」导致的提示词前缀失配,都是给真实场景写
  的代码。而 Hermes **从不把家里的文件名列进提示词**,它只让 agent 知道路径。

  早前这里锁的是反过来的行为(把 knowledge/preferences 的文件名列成索引),那是
  照着目录清单自己发明的,而且只给名字不给路径 —— 模型照着读只会拿到一串打不开。
  现在锁的是:给了路径就说,没给就一个字不提(远端会话够不到本机 userData)。
*/
describe('伙伴的家', () => {
  const base = {
    displayName: '小柴',
    identity: '你是小柴。',
    capabilities: { toolsets: [], memoryEnabled: false, delegationEnabled: false, ownSkillsEnabled: false },
    skillIndex: [],
  };

  it('写了 system_prompt.md 就完全听它的,不在后面偷偷再叠一份我们的说法', () => {
    const stable = buildBotStableTier({ ...base, systemPromptOverride: '  我自己写的全部  ' });
    expect(stable).toBe('我自己写的全部');
    // 默认组装里的东西一样都不该漏进来。
    expect(stable).not.toContain('你是小柴。');
    expect(stable).not.toContain('# 你会做什么');
  });

  it('没写覆盖时行为逐字不变', () => {
    expect(buildBotStableTier({ ...base, systemPromptOverride: '   ' })).toBe(
      buildBotStableTier(base),
    );
  });

  it('给了路径才说,而且说的是路径不是文件清单', () => {
    const stable = buildBotStableTier({ ...base, homeDir: '/data/bots/bot-a' });
    expect(stable).toContain('## 你有个自己的文件夹');
    expect(stable).toContain('/data/bots/bot-a');
    // 固定成员讲清楚,改灵魂的规矩讲清楚。
    expect(stable).toContain('SOUL.md');
    expect(stable).toContain('memories/USER.md');
  });

  it('没有家就一个字都不提 —— 远端会话够不到本机目录', () => {
    const stable = buildBotStableTier(base);
    expect(stable).not.toContain('你有个自己的文件夹');
    expect(buildBotStableTier({ ...base, homeDir: '   ' })).toBe(stable);
  });

  it('用户整段自己写提示词时,这段跟其它能力说明一起让位', () => {
    const stable = buildBotStableTier({
      ...base,
      homeDir: '/data/bots/bot-a',
      systemPromptOverride: '你只回一个字。',
    });
    expect(stable).toBe('你只回一个字。');
  });
});

/*
  「你能翻回去查」。

  盯的是一个真实缺口:伙伴的主对话会翻篇,旧的那段归档后只读 —— 而伙伴手上一直
  有翻回去查的工具,提示词里却一个字都没提。于是用户说「上次那个方案」时,它只能
  顺着当前上下文猜,或者说自己不记得了。

  对齐 Hermes:它把长期对话召回做成 agent 随时能用的工具,而不是给用户一个
  「恢复那段对话」的按钮 —— 能自己回去查的 agent,不需要用户替它搬运上下文。
*/
describe('回看历史', () => {
  const base = {
    displayName: '小柴',
    identity: '你是小柴。',
    skillIndex: [],
  };

  it('工具面里有 helper 才说得出「你能翻回去查」', () => {
    const withHelper = buildBotStableTier({
      ...base,
      capabilities: {
        toolsets: ['xdt_helper'],
        memoryEnabled: false,
        delegationEnabled: true,
        ownSkillsEnabled: false,
      },
    });
    expect(withHelper).toContain('你能翻回去查');
    expect(withHelper).toContain('search_chat_history');
  });

  it('没有 helper 就一个字都不提 —— 不让它去调一个不存在的工具', () => {
    const without = buildBotStableTier({
      ...base,
      capabilities: {
        toolsets: [],
        memoryEnabled: false,
        delegationEnabled: false,
        ownSkillsEnabled: false,
      },
    });
    expect(without).not.toContain('你能翻回去查');
    expect(without).not.toContain('search_chat_history');
  });

  it('讲清楚历史与记忆的分工 —— 否则模型会把两者混着用', () => {
    const prompt = buildBotStableTier({
      ...base,
      capabilities: {
        toolsets: ['xdt_helper'],
        memoryEnabled: true,
        delegationEnabled: true,
        ownSkillsEnabled: false,
      },
    });
    // 记忆是提炼过的结论,历史是原始记录:想不起细节该去翻原文,不该硬从记忆里挤。
    expect(prompt).toContain('记忆是你提炼过的结论,历史是原始记录');
  });

  it('明说归档的那些也还在 —— 换代之后用户最可能问的正是那部分', () => {
    const prompt = buildBotStableTier({
      ...base,
      capabilities: {
        toolsets: ['xdt_helper'],
        memoryEnabled: false,
        delegationEnabled: true,
        ownSkillsEnabled: false,
      },
    });
    expect(prompt).toContain('包括已经翻篇归档的那些');
  });
});

/**
 * 换代之后的历史交接。
 *
 * 伙伴的主对话每天早上六点换代。新会话是干净的,不知道昨天聊过什么 —— 用户第二天
 * 说「上次那个方案」,伙伴要么顺着当前上下文猜,要么说自己不记得,两种都不对:那段
 * 记录明明还在,只是它不知道去哪儿找。换代那一刻上一个会话 id 是现成的,不交出去
 * 就白丢了。
 *
 * 判据照抄 Hermes(gateway/session.py 1010–1046):有上一段、且那一段**真的聊过**,
 * 才值得让伙伴专门去翻。
 */
describe('buildBotRenewalHandoff', () => {
  it('把上一段的会话 id 明着交出去', () => {
    const section = buildBotRenewalHandoff({ previousSessionId: 'sess-昨天', hadActivity: true });
    expect(section).toContain('sess-昨天');
    expect(section).toContain('search_chat_history');
    expect(section).toContain('get_chat_history');
  });

  it('空对话不值得让伙伴专门去翻一趟', () => {
    expect(buildBotRenewalHandoff({ previousSessionId: 'sess-空', hadActivity: false })).toBe('');
  });

  it('还没换过代就一个字都不提', () => {
    expect(buildBotRenewalHandoff({ previousSessionId: null, hadActivity: true })).toBe('');
    expect(buildBotRenewalHandoff({ previousSessionId: '   ', hadActivity: true })).toBe('');
    expect(buildBotRenewalHandoff({})).toBe('');
  });

  it('明确要求不要拿不相干的近期对话顶替,也不许说不记得', () => {
    const section = buildBotRenewalHandoff({ previousSessionId: 'sess-1', hadActivity: true });
    expect(section).toContain('不相干');
    expect(section).toContain('不记得');
  });
});

/**
 * 队友名册。
 *
 * 提示词里原先只有「你可以叫别的伙伴帮忙」,却从不说队友是谁。工具面里确实有
 * list_bots 能查,但模型得先想到去查 —— 而它没有任何理由想到,因为提示词里一个
 * 队友的名字都没出现过。结果是这条能力挂着基本不触发,或者瞎猜一个名字然后失败。
 *
 * 抄 Hermes 的 _roster_lines(tools/bot_mode_probe.py):名字 + 角色进系统提示词,
 * 「这样 bot 在挑收件人之前就知道谁管什么」。
 */
describe('buildBotTeammateRoster', () => {
  it('每个队友一行,带上委派工具真正认的那个 id', () => {
    const roster = buildBotTeammateRoster([
      { id: 'bot-fin', name: '财务助理', description: '管账、对账、报销' },
      { id: 'bot-doc', name: '文档助手', description: '写方案和周报' },
    ]);
    expect(roster).toContain('财务助理');
    expect(roster).toContain('bot-fin');
    expect(roster).toContain('管账、对账、报销');
    expect(roster).toContain('文档助手');
    expect(roster).toContain('bot-doc');
  });

  it('没写描述的队友只列名字,不编一个角色出来', () => {
    const roster = buildBotTeammateRoster([{ id: 'bot-x', name: '小助手' }]);
    expect(roster).toContain('小助手');
    expect(roster).toContain('bot-x');
    expect(roster).not.toContain('——');
  });

  it('就它一个的时候一个字都不提', () => {
    expect(buildBotTeammateRoster([])).toBe('');
  });

  it('名字或 id 缺一不可 —— 拼不出可用的目标就不列这一行', () => {
    expect(buildBotTeammateRoster([{ id: '', name: '没有 id' }])).toBe('');
    expect(buildBotTeammateRoster([{ id: 'bot-y', name: '   ' }])).toBe('');
  });

  it('描述压成单行并截断 —— 名册是索引,不是简介', () => {
    const roster = buildBotTeammateRoster([
      { id: 'bot-z', name: '话痨', description: `第一行\n第二行   还有   很多空格${'长'.repeat(400)}` },
    ]);
    expect(roster).not.toContain('\n第二行');
    expect(roster).toContain('第一行 第二行 还有 很多空格');
    const line = roster.split('\n').find((row) => row.includes('话痨')) ?? '';
    expect(line.length).toBeLessThan(260);
  });

  it('明确告诉伙伴不确定就别猜', () => {
    const roster = buildBotTeammateRoster([{ id: 'bot-a', name: 'A' }]);
    expect(roster).toContain('别猜');
  });
});
