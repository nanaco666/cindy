/**
 * botSystemPrompt —— 伙伴系统提示词的三层装配。
 * ---------------------------------------------------------------------------
 * 结构照搬 Hermes Agent(MIT, Nous Research)的 system-prompt 装配法,文本全部
 * 是 Cindy 自己的。照搬的是这三条机制,不是它的 prompt 内容:
 *
 *   1. **三层分离**:stable(身份 + 长期不变的行为准则与能力说明) /
 *      context(本次会话的上下文) / volatile(技能索引、记忆快照这些会变的)。
 *      易变的排在最后,前缀缓存才不会被一次技能改动整段冲掉。
 *   2. **能力说明按「实际挂载的工具」逐块注入**:有文档工具才讲怎么做文档,
 *      有记忆才讲怎么记。伙伴不需要先去「发现」自己会什么 —— 开局就写在
 *      提示词里。判定信号用 runtime 已解析的 toolset id(等价于 Hermes 的
 *      valid_tool_names)。
 *   3. **技能索引整份进提示词**:每个技能的名字与一句话描述都可见,不靠
 *      模型自己翻目录。
 *
 * 为什么必须这么做(2026-08-21 真机实证):伙伴会话里 cindy_docs 明明挂载成功
 * (日志 instance_resolved),但 make_pptx / list_tools 的调用次数是 0 —— 模型
 * 不知道自己有这套工具,于是去找 python 库、没找到、回了句「做不了」。工具
 * 挂载 ≠ 能力可用;能力必须写进提示词才算数。
 */

/** 伙伴运行时已解析的能力信号(plugin id),等价于 Hermes 的 valid_tool_names。 */
export interface BotPromptCapabilitySignals {
  /** 已生效的 toolset(内置插件 id):'docs' | 'memory' | 'scheduler' | … */
  toolsets: readonly string[];
  /** 记忆引擎是否真的可用(挂了 toolset 不等于引擎起得来)。 */
  memoryEnabled: boolean;
  /** 是否允许把活委派给别的伙伴。 */
  delegationEnabled: boolean;
  /** 伙伴自有技能是否可写入(save_bot_skill 是否在工具面里)。 */
  ownSkillsEnabled: boolean;
}

/** 技能索引的一行:名字 + 一句话描述(描述缺省时只列名字)。 */
export interface BotPromptSkillIndexEntry {
  name: string;
  description?: string;
}

export interface BotSystemPromptInput {
  displayName: string;
  /** SOUL:身份正本。空则由调用方兜底。 */
  identity: string;
  capabilities: BotPromptCapabilitySignals;
  /** 伙伴自有技能索引(全部,不截断)。 */
  skillIndex: readonly BotPromptSkillIndexEntry[];
  /** 用户档案(USER.md 对应物)。 */
  userProfile?: string;
  /** 记忆快照正文。 */
  memorySnapshot?: string;
  /** 会话控制说明等由调用方给的上下文段。 */
  contextSections?: readonly string[];
  /**
   * `system_prompt.md` 的整段覆盖。有内容时**取代**默认组装出来的稳定层
   * (身份 + 纪律 + 能力说明),空则完全不影响。
   *
   * 与 Hermes 同义:那是给「我要完全自己写这个 agent 的提示词」准备的逃生口,
   * 不是又一个可以叠加的段落 —— 叠加只会让两套说法在同一份上下文里打架。
   */
  systemPromptOverride?: string;
  /**
   * 伙伴自己那个文件夹的绝对路径。给了才会告诉它「你有个家」——
   * 远端会话没有本机 userData,这时不给,也就一个字都不提。
   */
  homeDir?: string;
}

/**
 * 「把活干完」的纪律。放在能力说明之前:它约束的是**所有**能力的交付形态,
 * 而不是某一个工具的用法。两条真实事故各对应一句 ——
 *   · 伙伴拿不到工具就回「做不了」,而没有先看自己手上有什么;
 *   · 伙伴把「我准备怎么做」当成交付物讲完就收尾。
 */
const TASK_COMPLETION_GUIDANCE = [
  '## 把活干完',
  '用户要的是能打开、能用的东西,不是对它的描述。写完计划不算完成,给出一段"可以这样做"也不算完成 —— 真的做出来、真的跑过、把结果给出去才算。',
  '动手前先看自己手上有哪些工具。你的能力写在下面「你会做什么」里,不要凭印象断定自己做不到某件事;工具在不在手边,看工具列表,不靠猜。',
  '真的被挡住时(工具报错、缺少授权、路径不通),直说卡在哪、试了什么、需要什么,然后换一条路继续。绝不编造看起来合理的结果 —— 不编文件内容、不编数据、不编"已完成"。如实说卡住了,永远比伪造一个交付物好。',
].join('\n');

/**
 * 文档能力。工具名与参数以 list_tools 实时返回为准,这里只保证「知道自己会做」
 * 与「知道该用哪个」。产物一律进作品集,所以这段也讲落点。
 */
const DOCS_GUIDANCE = [
  '## 你会做文件',
  '你可以直接做出真文件,不需要用户装任何软件,也不要去找 python-pptx / LibreOffice 这类外部依赖 —— 宿主已经内置好了:',
  '- `make_pptx` 做 PPT(.pptx):传 slides 数组,有封面/分节/内容三套版式与配色主题。',
  '- `make_docx` 做 Word(.docx):传 Markdown,标题层级、表格、封面都会排好。',
  '- `make_xlsx` 做 Excel(.xlsx):传 sheets + rows,表头、冻结、数字格式自动处理;公式要连缓存值一起给。',
  '- `render_pdf` 出 PDF:传一份自包含 HTML(或文件路径),用宿主的排版引擎渲染。',
  '- `read_sheet` 读表格(xlsx / csv / tsv),`inspect_pdf` 体检刚做出来的 PDF(页数、纸型、有没有空白页)。',
  // 工序正文由 cindy_docs 的工具描述提供同一份 —— 那边是所有会话(含普通会话、
  // 三种 harness)唯一都会读到的位置,这里只是把同一段话在伙伴的能力说明里再讲一次,
  // 不另写一版免得两处漂移。
  // 具体工序不在这里重复:每个工具的描述里都带着它自己的做法(先定版式、PPT 要不要
  // 先写 HTML 设计稿、PDF 怎么排),那份说明会一字不差进模型上下文。这里只提醒一句
  // 「照工具说明做」,免得同一段话两处各写一版、日后必然漂移。
  '做正式文档(PDF / PPT / Word)前,先看一眼对应工具说明里写的排版工序,照着做 —— 那一步决定成品好不好看。',
  '文件写进当前工作目录的 documents/ 下,文件名用「日期-主题」。做完 PDF 一定用 `inspect_pdf` 看一眼再交付:页数对不对、有没有空白页。做完表格用 `read_sheet` 读回核对。',
  '交付时把文件当作品交出去,不要只甩一条路径给用户。',
].join('\n');

/** 记忆。写法上强调「陈述事实」而不是「给自己下指令」。 */
const MEMORY_GUIDANCE = [
  '## 你记得住事',
  '你有一份跨会话的长期记忆,只属于你自己。值得记的是以后还用得上的东西:用户的偏好与习惯、他纠正过你的做法、长期有效的约定与背景。',
  '记成陈述句,不要写成给自己的命令 —— 「他喜欢先看几版再定」是好记忆,「以后都先给三版」不是。',
  '不要记流水账:今天做完的事、临时状态、过几天就过期的进度,都不进记忆。',
  '记下一件事后,在回复末尾轻描淡写地带一句,让用户知道你记住了什么。',
].join('\n');

/**
 * 回看历史。
 *
 * 这一段补的是一个真实缺口:伙伴的主对话会翻篇(到点换代 / 用户手动),旧的那段
 * 归档后只读 —— 而**伙伴手上一直有翻回去查的工具**,提示词里却一个字都没提。
 * 于是用户说「上次那个方案」时,它只能顺着当前上下文猜,或者干脆说不记得了。
 *
 * 对齐 Hermes 的做法:它把长期对话召回做成一个 agent 随时能用的工具(搜 / 翻 /
 * 读 / 浏览四种用法,零模型开销,直接读数据库),而不是给用户一个「恢复那段对话」
 * 的按钮。**能自己回去查的 agent,不需要用户替它搬运上下文。**
 *
 * 与记忆的分工要讲清楚,否则模型会把两者混着用:记忆是**已经提炼过的结论**,
 * 历史是**原始记录**。想不起细节就去翻历史,而不是硬从记忆里挤。
 */
const HISTORY_GUIDANCE = [
  '## 你能翻回去查',
  '你和用户以前的对话都还在,包括已经翻篇归档的那些。用户提到「上次」「之前」「我们聊过」,或者你需要某件事的原始经过时,去查,不要凭印象答、更不要说自己不记得了。',
  '按内容找用 `search_chat_history`(不确定在哪次聊的时候用它);知道大概是哪段时间、哪个目录,先 `list_sessions` 缩小范围再 `get_chat_history` 取原文。这些工具在 `cindy_helper` 的 history 类目里,用 `list_tools` 就能看到它们当前的参数。',
  '这跟你的记忆是两回事:记忆是你提炼过的结论,历史是原始记录。细节想不起来就去翻原文,别硬从记忆里挤。',
  '翻到之后把有用的那部分讲出来,不要把整段记录复述给用户。',
].join('\n');

/** 自有技能:与记忆的分工是「做法」vs「事实」。 */
const OWN_SKILLS_GUIDANCE = [
  '## 你能把做法沉淀成本事',
  '做完一件以前没做过的多步骤任务后,把「这类事该怎么做」用 `save_bot_skill` 存成你自己的技能 —— 写可复用的步骤,不写这一次的结论。存之前先用 `list_bot_skills` 看有没有同类的,有就在原来那份上改进后同名覆盖。',
  '技能从下一个任务开始生效,这一次不用指望它。',
  '再遇到同类任务时先照自己的技能做;发现技能过时或不好用,当场改掉,别等人提醒。',
].join('\n');

/** 协作:强调这是「把一段活交出去并拿回结果」,不是指挥别人。 */
const DELEGATION_GUIDANCE = [
  '## 你可以叫别的伙伴帮忙',
  '遇到别人更擅长的一段活,可以把它交出去:说清楚要什么、给足背景,对方做完结果会自动回到这个对话里。你不需要守着等,也不要反复去催。',
  '这是把一段有边界的活交出去并拿回结果,不是命令对方、也不会改变对方是谁。用户如果要求"让某个伙伴听话",说明这条边界,然后直接给出可以协作的做法。',
].join('\n');

/** 日程/自动化。 */
const SCHEDULE_GUIDANCE = [
  '## 你能定时干活',
  '需要按时重复做的事(每天的简报、每周的整理、到点提醒),可以给自己排一条日程,到点你会被叫起来做。',
  '排之前先把「做什么」和「什么时候」跟用户确认清楚,不要替他假定频率。',
].join('\n');

/**
 * 「你有个家」—— 照抄 Hermes 唯一真做的那件事。
 *
 * Hermes 从不把家里的文件列进提示词,它只是让 agent 知道 `~/.hermes` 在哪、
 * 手上有文件工具,剩下自己翻。而 agent 会**改自己的 SOUL.md** 不是理论可能:
 * Hermes 为此写了跨 profile 的写入保护(容器里写到镜像副本上会被拦),提示词
 * 缓存也专门处理「SOUL.md 被改了」导致的前缀失配 —— 都是给真实场景写的。
 *
 * 所以这里给的是**路径**,不是清单。清单会开出模型打不开的空头支票,路径不会。
 */
function buildHomeGuidance(homeDir: string): string {
  return [
    '## 你有个自己的文件夹',
    `\`${homeDir}\` 是你的家,你读得到也改得动。里面几样是固定的:`,
    '- `SOUL.md` —— 你是谁。用户要调整你的性格、说话方式、做事风格,就改这一份。',
    '- `memories/USER.md` —— 你对用户的了解。',
    '- `skills/` —— 你会的本事,一样一个目录。',
    '- `system_prompt.md` —— 用户想整段自己写你的提示词时放这里。',
    '',
    '其余想放什么放什么:整理好的资料、常用的模板、给自己记的规矩,都可以摊在这个',
    '文件夹里,下次开新对话它们还在。用户也能直接用编辑器打开来改。',
    '',
    '改 `SOUL.md` 是改你自己:动手前先跟用户讲清楚要改成什么样,他点头了再写。',
    '写完当前这轮对话仍然按旧的走,下一轮才换成新的 —— 这是正常的,照实告诉他。',
  ].join('\n');
}

/** 作品集:所有能给用户看的产物都在这里,不只文档。 */
const PORTFOLIO_GUIDANCE = [
  '## 你做出来的东西会进作品集',
  '你产出的文件、图片、视频都会作为「作品」出现在对话里,并自动收进你的作品集,用户随时能翻回去。',
  '所以交付时讲清楚这份作品是什么、包含哪些内容(几页、几张表、什么结论),不要复述路径,也不要把工具的原始返回值粘给他。',
].join('\n');

function has(signals: BotPromptCapabilitySignals, toolset: string): boolean {
  return signals.toolsets.includes(toolset);
}

/**
 * 稳定层:身份 → 交付纪律 → 按实际能力逐块注入的说明。
 * 这一层在整个会话里逐字节不变,前缀缓存靠它。
 */
export function buildBotStableTier(input: BotSystemPromptInput): string {
  // 整段覆盖:用户自己写了 system_prompt.md 就完全听他的,不在后面偷偷再叠
  // 一份我们的说法 —— 两套说法在同一份上下文里只会打架。
  const override = input.systemPromptOverride?.trim();
  if (override) return override;
  const parts: string[] = [];
  const identity = input.identity.trim();
  if (identity) parts.push(identity);
  parts.push(TASK_COMPLETION_GUIDANCE);

  // 能力说明按「这个伙伴真的挂了什么」注入 —— 没挂的能力一个字都不提,
  // 免得模型去调一个不存在的工具(Hermes 同款 valid_tool_names 门)。
  const capabilityParts: string[] = [];
  // 家排在最前:它不是某个工具的用法,是「你有身份、有积累、能改自己」这件事本身。
  const homeDir = input.homeDir?.trim();
  if (homeDir) capabilityParts.push(buildHomeGuidance(homeDir));
  if (has(input.capabilities, 'docs')) capabilityParts.push(DOCS_GUIDANCE);
  if (input.capabilities.memoryEnabled) capabilityParts.push(MEMORY_GUIDANCE);
  // 历史检索住在 cindy_helper 里(essential 插件、恒挂),判据与委派同一个 —— 
  // 工具面里有它,才说得出「你能翻回去查」。
  if (input.capabilities.delegationEnabled) capabilityParts.push(HISTORY_GUIDANCE);
  if (input.capabilities.ownSkillsEnabled) capabilityParts.push(OWN_SKILLS_GUIDANCE);
  if (input.capabilities.delegationEnabled) capabilityParts.push(DELEGATION_GUIDANCE);
  if (has(input.capabilities, 'scheduler')) capabilityParts.push(SCHEDULE_GUIDANCE);
  // 作品集不依赖某个 toolset:只要能产出文件/图片/视频就成立,而任何伙伴
  // 都可能产出图片(出图能力在别处),所以恒挂。
  capabilityParts.push(PORTFOLIO_GUIDANCE);
  if (capabilityParts.length > 0) {
    parts.push(['# 你会做什么', ...capabilityParts].join('\n\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * 技能索引:全部技能的名字 + 一句话描述。
 *
 * 照搬 Hermes 的口径 —— 索引里**不省略任何技能名**。模型看得见名字才知道
 * 自己有这份本事;正文按需再读。
 */
export function buildBotSkillIndex(entries: readonly BotPromptSkillIndexEntry[]): string {
  const rows = entries
    .map((entry) => {
      const name = entry.name.trim();
      if (!name) return '';
      const description = entry.description?.trim();
      return description ? `- ${name}:${description}` : `- ${name}`;
    })
    .filter(Boolean);
  if (rows.length === 0) return '';
  return ['## 你已经会的本事', ...rows].join('\n');
}

/**
 * 易变层:技能索引在最前(它随会话内的 save_bot_skill 变),记忆与用户档案随后。
 * 放在整份提示词末尾,变化时只从这里往后重新计算。
 */
export function buildBotVolatileTier(input: BotSystemPromptInput): string {
  const parts: string[] = [];
  const skillIndex = buildBotSkillIndex(input.skillIndex);
  if (skillIndex) parts.push(skillIndex);
  const memory = input.memorySnapshot?.trim();
  if (memory) parts.push(memory);
  const userProfile = input.userProfile?.trim();
  if (userProfile) parts.push(userProfile);
  return parts.join('\n\n');
}

/**
 * 换代之后,把**上一段对话的会话 id** 直接交到伙伴手里。
 *
 * 为什么需要:伙伴的主对话每天早上六点换代(用户也能手动重开)。新会话是干净的,
 * 它不知道昨天聊过什么。用户第二天说「上次那个方案」,伙伴要么顺着当前上下文猜,
 * 要么说自己不记得 —— 两种都不对,因为那段记录明明还在,只是它不知道去哪儿找。
 *
 * 「你能翻回去查」那段讲的是**有这个能力**;这一段讲的是**具体去查哪一段**。
 * 换代那一刻上一个会话 id 是现成的,不交出去就白丢了。
 *
 * 抄的是 Hermes 的换代提示(hermes-agent gateway/session.py 1010–1046):
 *
 *   [System note: This channel had an earlier Hermes session (session_id: …) that
 *    was auto-reset. If the user refers to earlier work here, or the request depends
 *    on this channel's history, use the session_search tool to recall that prior
 *    session before acting — **do not assume an unrelated recent session is the
 *    right context**.]
 *
 * 它的前提条件照抄:**那次换代确实有过真实对话**、上一个会话 id 已知。
 * 零额外查询、零模型开销 —— 换代时本来就知道这两样。
 *
 * 一处适配:Hermes 那段只对 Slack / Discord 这类长命频道生效(它的主对话永不换代,
 * `/new` 会被改写成 `/compact`)。Cindy 是全体伙伴每天换代,所以对所有伙伴主对话
 * 生效。这是适配,不是照抄。
 */
export function buildBotRenewalHandoff(input: {
  previousSessionId?: string | null;
  /** 上一段有没有真的聊过。空会话不值得让伙伴专门去翻。 */
  hadActivity?: boolean;
}): string {
  const previous = input.previousSessionId?.trim();
  if (!previous || !input.hadActivity) return '';
  return [
    '## 你们之前那段对话',
    `你和用户之前有一段对话(会话 id \`${previous}\`),已经翻篇了 —— 记录都还在,只是不在你眼前。`,
    '他要是提到「上次」「之前」「我们聊过」,或者这次的请求依赖那段历史,**先把那段找回来再动手**:',
    '按内容找用 `search_chat_history`;已经知道是哪一段就用 `get_chat_history` 取原文。',
    '不要拿一段不相干的近期对话当上下文,也不要说自己不记得了。',
  ].join('\n');
}

/** 上下文层:调用方给的会话级段落(会话控制模式等)。 */
export function buildBotContextTier(input: BotSystemPromptInput): string {
  return (input.contextSections ?? []).map((s) => s.trim()).filter(Boolean).join('\n\n');
}

/**
 * 三层合并。调用方通常分开取(身份段与上下文段走不同注入位),
 * 这里给一个整体形态便于测试与调试。
 */
export function buildBotSystemPrompt(input: BotSystemPromptInput): {
  stable: string;
  context: string;
  volatile: string;
  full: string;
} {
  const stable = buildBotStableTier(input);
  const context = buildBotContextTier(input);
  const volatile = buildBotVolatileTier(input);
  return {
    stable,
    context,
    volatile,
    full: [stable, context, volatile].filter(Boolean).join('\n\n'),
  };
}
