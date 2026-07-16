/**
 * ghostCommand.ts — 意识触发的发送期展开。
 *
 * `$` 与技能的 `/` 分流(2026-07-09 Lizi 定案):`/` 归技能,`$` 归意识。
 * 触发发生在发送期、只影响本条用户消息(per-call 内容,不碰系统提示词,
 * 缓存前缀零影响;规则 9 确定性,规则 11 零 prompt 面):
 *
 * **显式指令(硬)**:消息以 `$画图 ...` 开头且命中「已唤醒且声明了该
 * 指令」的意识 → 追加机器指令,"该用哪段意识"从模型自由发挥变成确定性
 * 约束("必须调用,不得代替")。
 *
 * 历史上还有第二级「语言提及软提示」(2026-07-11 C 方案:正文提到意识的
 * 名字/指令词/keywords 就追加软提示 + 气泡下挂「提及意识」胶囊),
 * 2026-07-14 Lizi 定案移除——普通用户无法理解这个凭空出现的胶囊。发送期
 * 不再生成软提示;mention 模板与解析(splitGhostDirective 的 mention 分支、
 * mentionDirectiveSegments)保留,仅服务历史消息的渲染(旧消息尾部已固化
 * 追加文本,不拆出来会以裸文本刷在气泡里)。
 *
 * 追加文本对用户可见(气泡里如实显示),不做暗改。
 */

import type { InstalledGhost } from '../../shared/ghost';

/**
 * `$` 后紧跟指令词(与 ghost.json command 约束同宽:无空白,≤32 字符)。
 * 触发符同时认全角变体(＄ U+FF04 / ¥ U+00A5 / ￥ U+FFE5):中文输入法下
 * Shift+4 产出的是 ￥,不切输入法也能触发——与 ChatInput 的
 * GHOST_SIGIL_CHARS 是同一字符集,两端必须保持一致。
 */
const COMMAND_RE = /^[$＄¥￥](\S{1,32})(?:\s|$)/;

/** 解析消息开头的意识指令词;非 `$`(含全角变体)开头或形状不合返回 null。 */
export function parseGhostCommandWord(text: string): string | null {
  const m = COMMAND_RE.exec(text);
  return m ? m[1] : null;
}

/** 按指令词(大小写折叠)找已唤醒的意识;找不到 → null(消息原样发送)。 */
export function findGhostByCommand(
  ghosts: InstalledGhost[],
  word: string,
): InstalledGhost | null {
  const fold = word.toLowerCase();
  return (
    ghosts.find(
      (g) => g.enabled && g.manifest.command !== undefined && g.manifest.command.toLowerCase() === fold,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// 指令文本模板(生成端与渲染端解析必须严格同源):expandGhostCommand 用下面
// 的模板函数生成追加文本;splitGhostDirective 把同一模板经 escapeRegExp 反推
// 成正则,从消息正文里把机器指令拆出来交给「意识召唤卡片」渲染。模板一改,
// 解析自动跟随;历史消息里对不上模板的文本按普通正文原样显示,绝不误伤
// 用户的字(规则 9 确定性——解析是纯代码模板匹配,不做启发式)。
// ---------------------------------------------------------------------------

/** 指令段的来源标注(injected = 值来自意识身份卡;否则是系统固定模板文字)。 */
export interface GhostDirectiveSegment {
  text: string;
  injected: boolean;
}

/**
 * 硬指令追加段——分段形态(单一事实源):发送文本 = 各段 text 相连;
 * 召唤卡片展开区用同一份分段按来源双色渲染(意识注入值高亮),保证
 * "展示的来源标注"与"实际发送的字节"永不漂移。
 */
export function commandDirectiveSegments(d: {
  command: string;
  name: string;
  ghostId: string;
}): GhostDirectiveSegment[] {
  return [
    { text: '[意识指令] 用户以 ', injected: false },
    { text: `$${d.command}`, injected: true },
    { text: ' 显式点名意识「', injected: false },
    { text: d.name, injected: true },
    { text: '」(id: ', injected: false },
    { text: d.ghostId, injected: true },
    {
      text:
        ')。必须通过 cindy 总机的 ghost_call 调用该意识完成本请求:先用 ghost_list 查它声明的工具与参数,' +
        '$指令后面的文字就是给它的输入;不得改用其它工具代替。',
      injected: false,
    },
  ];
}

/** 硬指令追加段的纯文本(发送用,由分段拼接)。 */
const buildCommandDirective = (command: string, name: string, id: string): string =>
  commandDirectiveSegments({ command, name, ghostId: id })
    .map((s) => s.text)
    .join('');

/** 软提示模板的头/尾(已停止生成,仅供历史消息解析/渲染反推同源模板)。 */
const MENTION_HEAD = '[意识提示] 本机装有意识 ';
const MENTION_TAIL =
  ',消息里提到了相关词。' +
  '若本请求正需要这类能力,优先通过 cindy 总机的 ghost_call 调用它(先用 ghost_list 查工具与参数),' +
  '不要改用其它同类工具;若只是顺带提及、与本请求无关,忽略本提示即可。';

/** 软提示 roster 单项——分段形态。 */
const rosterItemSegments = (g: {
  name: string;
  ghostId: string;
  command?: string;
}): GhostDirectiveSegment[] => [
  { text: '「', injected: false },
  { text: g.name, injected: true },
  { text: '」(id: ', injected: false },
  { text: g.ghostId, injected: true },
  ...(g.command
    ? [
        { text: ',指令 ', injected: false },
        { text: `$${g.command}`, injected: true },
      ]
    : []),
  { text: ')', injected: false },
];

/** 软提示追加段——分段形态(历史消息召唤卡展开区的双色渲染用)。 */
export function mentionDirectiveSegments(
  ghosts: Array<{ name: string; ghostId: string; command?: string }>,
): GhostDirectiveSegment[] {
  const segs: GhostDirectiveSegment[] = [{ text: MENTION_HEAD, injected: false }];
  ghosts.forEach((g, i) => {
    if (i > 0) segs.push({ text: '、', injected: false });
    segs.push(...rosterItemSegments(g));
  });
  segs.push({ text: MENTION_TAIL, injected: false });
  return segs;
}

/** 软提示追加段的纯文本模板(仅供解析正则反推,不再用于发送)。 */
const buildMentionDirective = (roster: string): string => `${MENTION_HEAD}${roster}${MENTION_TAIL}`;

/**
 * 发送期展开:
 * - `$指令` 命中 → 追加硬机器指令(必须调用该意识);
 * - 未命中(没这个指令 / 意识沉睡 / 非 `$` 开头)原样返回——绝不吞掉用户的字。
 */
export function expandGhostCommand(text: string, ghosts: InstalledGhost[]): string {
  const word = parseGhostCommandWord(text);
  if (!word) return text;
  const ghost = findGhostByCommand(ghosts, word);
  if (!ghost) return text;
  const { id, name, command } = ghost.manifest;
  return `${text}\n\n${buildCommandDirective(command as string, name, id)}`;
}

// ---------------------------------------------------------------------------
// 渲染层解析:把 expandGhostCommand 追加的机器指令从消息正文尾部拆出来。
// ---------------------------------------------------------------------------

/** 「意识召唤卡片」的结构化展示数据(raw 保留原文,卡片展开时如实展示)。 */
export type GhostDirectiveDisplay =
  | { kind: 'command'; command: string; name: string; ghostId: string; raw: string }
  | {
      kind: 'mention';
      ghosts: Array<{ name: string; ghostId: string; command?: string }>;
      raw: string;
    };

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 模板占位符(控制字符,不可能出现在正常消息里)。 */
const P1 = '\u0001';
const P2 = '\u0002';
const P3 = '\u0003';

/** 由生成模板反推的解析正则——锚定消息末尾,只认完整模板。 */
const COMMAND_DIRECTIVE_RE = new RegExp(
  `\\n\\n(${escapeRegExp(buildCommandDirective(P1, P2, P3))
    .replace(P1, '(\\S{1,32})')
    .replace(P2, '(.+?)')
    .replace(P3, '(.+?)')})$`,
);

const MENTION_DIRECTIVE_RE = new RegExp(
  `\\n\\n(${escapeRegExp(buildMentionDirective(P1)).replace(P1, '(.+?)')})$`,
);

/** roster 单项解析(id 不含 `,` / `)`,与生成端的 manifest 约束一致)。 */
const ROSTER_ITEM_RE = /「(.+?)」\(id: ([^,)]+)(?:,指令 \$(\S{1,32}))?\)/g;

/**
 * 从消息内容尾部拆出意识指令/提示段。命中返回 { 剥离后的正文, 结构化指令 };
 * 未命中(普通消息 / 旧格式 / 用户手打的形似文本不在末尾)返回 null,调用方
 * 按原样渲染。
 */
export function splitGhostDirective(
  content: string,
): { body: string; directive: GhostDirectiveDisplay } | null {
  const cmd = COMMAND_DIRECTIVE_RE.exec(content);
  if (cmd) {
    return {
      body: content.slice(0, cmd.index),
      directive: { kind: 'command', raw: cmd[1], command: cmd[2], name: cmd[3], ghostId: cmd[4] },
    };
  }
  const mention = MENTION_DIRECTIVE_RE.exec(content);
  if (mention) {
    const ghosts: Array<{ name: string; ghostId: string; command?: string }> = [];
    for (const m of mention[2].matchAll(ROSTER_ITEM_RE)) {
      ghosts.push({ name: m[1], ghostId: m[2], ...(m[3] ? { command: m[3] } : {}) });
    }
    if (ghosts.length === 0) return null;
    return {
      body: content.slice(0, mention.index),
      directive: { kind: 'mention', ghosts, raw: mention[1] },
    };
  }
  return null;
}
