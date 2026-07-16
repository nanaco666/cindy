/**
 * 「智能纪要 docx」定位的纯逻辑层 —— 不依赖飞书 client,便于单测。
 *
 * 背景:飞书一场会开了妙记后,内容会落成两样东西,可见性规则不同:
 *   1. 妙记对象(Minutes):`minutes_search` 只返回"你自己妙记列表里"的妙记
 *      (本人创建 / 被单独分享妙记 / 被识别为妙记参会成员)。
 *   2. 智能纪要 docx:飞书把妙记自动生成成一篇云文档,分发给全体参会人 ——
 *      参会人都能读,但这条妙记不进你的 minutes_search。
 * 大型例会(如「小镇周会」38 人)典型就是"妙记归组织者、纪要 docx 发全员",
 * 于是 `minutes_search` 搜空、内容其实一直躺在 docx 里(假阴性)。
 *
 * 本模块封装"按会议名 + 日期确定性地定位那篇智能纪要 docx"的逻辑:
 *   - 构造飞书 docx 搜索 query(会议名 + 中文完整日期,匹配飞书标题格式);
 *   - 解析智能纪要标题里的会议名/日期;
 *   - 代码侧严格按"会议名匹配 + 日期完全一致"筛选,避免把同系列别的日期那篇误当结果。
 *
 * 实测结论:用"会议名 + YYYY年M月D日"搜,目标纪要会被飞书排到第一;
 * 但搜索 ranking 不保证,所以一律用下面的 `pickMatchingNotes` 做代码侧二次校验。
 */

/** 飞书 docx 搜索类型码:22 = docx。 */
export const DOCX_SEARCH_TYPE = 22;

/** 一条候选智能纪要(来自搜索结果 或 某篇纪要的「相关会议纪要」)。 */
export interface NotesCandidate {
  title: string;
  token: string;
  url: string;
}

/** 解析后的智能纪要标题。 */
export interface ParsedNotesTitle {
  /** 去掉「MM-DD |」前缀后的会议名,如「小镇周会」。 */
  meetingName: string;
  year: number;
  month: number;
  day: number;
}

/** 归一化的目标日期(纯数字,不含时区语义)。 */
export interface TargetDate {
  year: number;
  month: number;
  day: number;
}

// 智能纪要标题形如:
//   智能纪要：06-18 | 小镇周会 2026年6月18日
//   智能纪要：小镇周会 2025年9月11日
// 中间「MM-DD |」前缀时有时无;分隔符可能是 ASCII `|` 或全角 `｜`;冒号半角/全角都可能。
const TITLE_RE =
  /^智能纪要[:：]\s*(?:\d{1,2}-\d{1,2}\s*[|｜]\s*)?(.+?)\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*$/;

/** 解析智能纪要标题 → 会议名 + 日期;非该格式返回 null。 */
export function parseNotesTitle(title: string): ParsedNotesTitle | null {
  const m = TITLE_RE.exec(title.trim());
  if (!m) return null;
  const meetingName = m[1].trim();
  if (!meetingName) return null;
  return {
    meetingName,
    year: Number(m[2]),
    month: Number(m[3]),
    day: Number(m[4]),
  };
}

// 目标日期接受:2026-06-18 / 2026/6/18 / 2026年6月18日。
const TARGET_DATE_RE = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/;

/** 归一化目标日期;非法(格式错 / 月日越界)返回 null。 */
export function parseTargetDate(date: string): TargetDate | null {
  const m = TARGET_DATE_RE.exec(date.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * 构造飞书 docx 搜索 query:`智能纪要 <会议名> <YYYY年M月D日>`。
 * 月/日**不补零**(飞书标题是「2026年6月18日」而非「2026年06月18日」),
 * 完整中文日期能把目标纪要在搜索结果里显著提权。
 */
export function buildNotesQuery(meetingName: string, d: TargetDate): string {
  return `智能纪要 ${meetingName.trim()} ${d.year}年${d.month}月${d.day}日`;
}

/** 会议名是否匹配:去空格后双向子串容错(目标含标题名 或 标题名含目标)。 */
export function nameMatches(titleName: string, targetName: string): boolean {
  const a = titleName.replace(/\s+/g, '');
  const b = targetName.replace(/\s+/g, '');
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * 从候选 docx 里挑出"会议名匹配 + 日期完全一致"的智能纪要,按 token 去重。
 * 这是确定性闸门:即便搜索把同系列别的日期那篇排在前面,日期对不上也不会被返回。
 */
export function pickMatchingNotes(
  candidates: NotesCandidate[],
  targetName: string,
  target: TargetDate,
): NotesCandidate[] {
  const out: NotesCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.token || seen.has(c.token)) continue;
    const parsed = parseNotesTitle(c.title);
    if (!parsed) continue;
    if (parsed.year !== target.year || parsed.month !== target.month || parsed.day !== target.day) {
      continue;
    }
    if (!nameMatches(parsed.meetingName, targetName)) continue;
    seen.add(c.token);
    out.push(c);
  }
  return out;
}

/**
 * 是否存在"同系列、但日期不一定一致"的候选(会议名匹配即可)。
 * 用于交叉链兜底判定:直搜没命中确切日期、但搜到了同名纪要时,
 * 可读其一从「相关会议纪要」里继续找目标日期那篇。
 */
export function hasSameSeriesCandidate(candidates: NotesCandidate[], targetName: string): boolean {
  return candidates.some((c) => {
    const parsed = parseNotesTitle(c.title);
    return parsed != null && nameMatches(parsed.meetingName, targetName);
  });
}

// ── 「按天枚举会议实例」纯逻辑(meeting_content 统一入口用)──────────────────────
//
// meeting_content 以 date 为核心:用 calendarEvent.instanceView 展开当天实例
// (含重复日程当天那次),逐场枚举内容获取状态,绝不静默漏会。下面是这套流程里
// 不依赖飞书 client 的纯逻辑部分,便于单测。

/** instanceView 单条实例里 meeting_content 关心的字段子集(由 handler 从 SDK item 摘出)。 */
export interface RawCalendarInstance {
  summary?: string;
  /** 'confirmed' | 'tentative' | 'cancelled' | … */
  status?: string;
  /** start_time.timestamp(Unix 秒字符串);普通定时会才有。 */
  startTimestamp?: string;
  /** start_time.date('YYYY-MM-DD');全天事件(请假/生日等)才有。 */
  startDate?: string;
  endTimestamp?: string;
  /** 'can_modify_event' | 'can_invite_others' | 'can_see_others' | 'none' */
  attendeeAbility?: string;
  organizerUserId?: string;
  organizerDisplayName?: string;
  vchatUrl?: string;
}

/** 归一化后的「当天一场真实会议」。 */
export interface DayMeetingInstance {
  summary: string;
  /** Unix 秒(数值)。 */
  startSeconds: number;
  endSeconds: number | null;
  attendeeAbility: string | null;
  organizerUserId: string | null;
  organizerDisplayName: string | null;
  vchatUrl: string | null;
}

/**
 * 从 instanceView 返回的实例里挑出「当天真实会议」并按开始时间升序:
 *   - 排除全天事件(只有 start_time.date、无 start_time.timestamp,如请假/生日);
 *   - 排除 status === 'cancelled';
 *   - 排除空 summary(占位事件)。
 * instanceView 已按时间窗展开重复日程,窗口正确性由 handler 的时区换算保证;
 * 这里只做「是不是一场真实会议」的归一化,不再做日期判断。
 */
export function pickDayMeetingInstances(items: RawCalendarInstance[]): DayMeetingInstance[] {
  const out: DayMeetingInstance[] = [];
  for (const it of items) {
    if (it.status === 'cancelled') continue;
    const startSeconds = Number(it.startTimestamp);
    // 无 timestamp(全天事件只有 date)或非法 → 不是定时会议,排除。
    if (!it.startTimestamp || !Number.isFinite(startSeconds)) continue;
    const summary = (it.summary ?? '').trim();
    if (!summary) continue;
    const endNum = Number(it.endTimestamp);
    const endSeconds = it.endTimestamp && Number.isFinite(endNum) ? endNum : null;
    out.push({
      summary,
      startSeconds,
      endSeconds,
      attendeeAbility: it.attendeeAbility ?? null,
      organizerUserId: it.organizerUserId ?? null,
      organizerDisplayName: it.organizerDisplayName ?? null,
      vchatUrl: it.vchatUrl ?? null,
    });
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * 仅凭 instanceView 自带的 attendee_ability 启发式判断「这场会本人是否可管理/组织」。
 * can_modify_event ≈ 本人是组织者或有编辑权;其余(can_invite_others / can_see_others /
 * none)≈ 受邀参会人。独立成函数:未来若改用 event_organizer.user_id == 本人 open_id
 * 的精确判定,只需替换这里。
 */
export function isSelfOrganizerHeuristic(attendeeAbility: string | null | undefined): boolean {
  return attendeeAbility === 'can_modify_event';
}

/** 一场会的内容获取状态。 */
export type MeetingContentStatus =
  | 'got_notes_doc' // 命中智能纪要 docx(发全员,内容最全)
  | 'got_minutes' // docx 没命中、本人妙记命中
  | 'missing_not_organizer' // 都没命中且本人非组织者 → 妙记归组织者,飞书限制拿不到
  | 'missing_no_record'; // 都没命中且本人可管理 → 这场大概率没开妙记/没生成纪要

/**
 * 由「docx 是否命中 / 妙记是否命中 / 本人是否组织者」定状态标签。
 * docx 优先于妙记;都没命中再按组织者分两类 missing,以便给出准确的「拿不到原因」。
 */
export function classifyMeetingContentStatus(input: {
  docHit: boolean;
  minutesHit: boolean;
  isSelfOrganizer: boolean;
}): MeetingContentStatus {
  if (input.docHit) return 'got_notes_doc';
  if (input.minutesHit) return 'got_minutes';
  return input.isSelfOrganizer ? 'missing_no_record' : 'missing_not_organizer';
}

// ── VC meeting_list 相关纯逻辑 ─────────────────────────────────────────────────

/** VC meeting_list API 返回的一条会议记录（归一化后）。 */
export interface VcMeetingRecord {
  meetingId: string;
  topic: string;
  startSeconds: number;
  endSeconds: number;
  hasAiNote: boolean;
  hasRelatedDocument: boolean;
  organizer: string | null;
}

/**
 * 从飞书录制 URL 解析 minutes_token。
 * URL 格式: https://meetings.feishu.cn/minutes/obcn37dxcftoc3656rgyejm7
 */
export function parseMinutesTokenFromUrl(url: string): string | null {
  const match = url.match(/\/minutes\/([a-z0-9]+)\/?(?:\?.*)?$/);
  return match ? match[1] : null;
}

/**
 * 解析 VC meeting_list 返回的时间字符串为 Unix 秒。
 * 两种格式都处理:
 *   - 纯数字字符串(Unix 秒)
 *   - "2022.12.23 11:16:59 (GMT+08:00)" 人类可读格式
 */
export function parseVcMeetingTime(timeStr: string): number | null {
  const trimmed = timeStr.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const m = trimmed.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;

  const tzMatch = trimmed.match(/\(GMT([+-])(\d{2}):(\d{2})\)/);
  let offsetMs = 8 * 60 * 60_000; // 默认 +08:00
  if (tzMatch) {
    const sign = tzMatch[1] === '+' ? 1 : -1;
    offsetMs = sign * (parseInt(tzMatch[2]) * 60 + parseInt(tzMatch[3])) * 60_000;
  }

  const utcMs =
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMs;
  return Math.floor(utcMs / 1000);
}
