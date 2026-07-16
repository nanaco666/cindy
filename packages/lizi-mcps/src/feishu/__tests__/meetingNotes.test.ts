import { describe, expect, it } from 'vitest';

import {
  buildNotesQuery,
  classifyMeetingContentStatus,
  hasSameSeriesCandidate,
  isSelfOrganizerHeuristic,
  nameMatches,
  parseMinutesTokenFromUrl,
  parseNotesTitle,
  parseTargetDate,
  parseVcMeetingTime,
  pickDayMeetingInstances,
  pickMatchingNotes,
  type NotesCandidate,
  type RawCalendarInstance,
} from '../mcp/meetingNotes.js';
import { FEISHU_DOC_LINK_BASE, FEISHU_MINUTES_LINK_BASE } from '../docLinks.js';

describe('parseNotesTitle', () => {
  it('解析带「MM-DD |」前缀的标题', () => {
    expect(parseNotesTitle('智能纪要：06-18 | 小镇周会 2026年6月18日')).toEqual({
      meetingName: '小镇周会',
      year: 2026,
      month: 6,
      day: 18,
    });
  });

  it('解析不带前缀的标题', () => {
    expect(parseNotesTitle('智能纪要：小镇周会 2025年9月11日')).toEqual({
      meetingName: '小镇周会',
      year: 2025,
      month: 9,
      day: 11,
    });
  });

  it('会议名含空格/符号也能解析(取日期前的全部为会议名)', () => {
    expect(parseNotesTitle('智能纪要：12-25 | 小镇 周会(201) 2025年12月25日')).toEqual({
      meetingName: '小镇 周会(201)',
      year: 2025,
      month: 12,
      day: 25,
    });
  });

  it('非智能纪要标题返回 null', () => {
    expect(parseNotesTitle('近期会议速递｜要点概览 2025年12月30日')).toBeNull();
    expect(parseNotesTitle('小镇周会 2026年6月18日')).toBeNull();
    expect(parseNotesTitle('')).toBeNull();
  });
});

describe('parseTargetDate', () => {
  it('接受多种日期写法', () => {
    expect(parseTargetDate('2026-06-18')).toEqual({ year: 2026, month: 6, day: 18 });
    expect(parseTargetDate('2026/6/18')).toEqual({ year: 2026, month: 6, day: 18 });
    expect(parseTargetDate('2026年6月18日')).toEqual({ year: 2026, month: 6, day: 18 });
  });

  it('非法日期返回 null', () => {
    expect(parseTargetDate('2026-13-01')).toBeNull();
    expect(parseTargetDate('2026-06-40')).toBeNull();
    expect(parseTargetDate('not-a-date')).toBeNull();
  });
});

describe('buildNotesQuery', () => {
  it('月/日不补零,拼成中文完整日期', () => {
    expect(buildNotesQuery('小镇周会', { year: 2026, month: 6, day: 18 })).toBe(
      '智能纪要 小镇周会 2026年6月18日',
    );
  });
});

describe('nameMatches', () => {
  it('双向子串 + 去空格容错', () => {
    expect(nameMatches('小镇周会', '小镇周会')).toBe(true);
    expect(nameMatches('06-18 小镇周会', '小镇周会')).toBe(true); // 标题名含目标
    expect(nameMatches('小镇周会', '小镇周会(201)')).toBe(true); // 目标含标题名
    expect(nameMatches('小 镇 周 会', '小镇周会')).toBe(true); // 去空格
    expect(nameMatches('海底玩法概念会', '小镇周会')).toBe(false);
  });
});

describe('pickMatchingNotes —— 确定性闸门', () => {
  const target = { year: 2026, month: 6, day: 18 };

  it('命中会议名 + 日期完全一致的那篇', () => {
    const candidates: NotesCandidate[] = [
      { title: '智能纪要：06-18 | 小镇周会 2026年6月18日', token: 'TOK_618', url: 'u618' },
    ];
    expect(pickMatchingNotes(candidates, '小镇周会', target)).toEqual([
      { title: '智能纪要：06-18 | 小镇周会 2026年6月18日', token: 'TOK_618', url: 'u618' },
    ]);
  });

  it('关键:同系列但日期不一致的纪要绝不被误返回(搜索 ranking 把 9/11、8/7 排在前也没用)', () => {
    const candidates: NotesCandidate[] = [
      { title: '智能纪要：小镇周会 2025年9月11日', token: 'TOK_911', url: 'u911' },
      { title: '智能纪要：08-07 | 小镇周会 2025年8月7日', token: 'TOK_807', url: 'u807' },
    ];
    expect(pickMatchingNotes(candidates, '小镇周会', target)).toEqual([]);
  });

  it('会议名不匹配的同日期纪要也不返回', () => {
    const candidates: NotesCandidate[] = [
      { title: '智能纪要：海底玩法概念会 2026年6月18日', token: 'TOK_X', url: 'ux' },
    ];
    expect(pickMatchingNotes(candidates, '小镇周会', target)).toEqual([]);
  });

  it('混合候选里只挑出正确那篇,并按 token 去重', () => {
    const candidates: NotesCandidate[] = [
      { title: '智能纪要：小镇周会 2025年9月11日', token: 'TOK_911', url: 'u911' },
      { title: '智能纪要：06-18 | 小镇周会 2026年6月18日', token: 'TOK_618', url: 'u618' },
      { title: '智能纪要：06-18 | 小镇周会 2026年6月18日', token: 'TOK_618', url: 'u618' }, // 重复
    ];
    expect(pickMatchingNotes(candidates, '小镇周会', target)).toEqual([
      { title: '智能纪要：06-18 | 小镇周会 2026年6月18日', token: 'TOK_618', url: 'u618' },
    ]);
  });
});

describe('hasSameSeriesCandidate —— 交叉链兜底判定', () => {
  it('搜到同名(不同日期)纪要时为 true', () => {
    const candidates: NotesCandidate[] = [
      { title: '智能纪要：小镇周会 2025年9月11日', token: 'TOK_911', url: 'u911' },
    ];
    expect(hasSameSeriesCandidate(candidates, '小镇周会')).toBe(true);
  });

  it('完全不相关的候选时为 false', () => {
    const candidates: NotesCandidate[] = [
      { title: '智能纪要：海底玩法概念会 2026年6月18日', token: 'TOK_X', url: 'ux' },
    ];
    expect(hasSameSeriesCandidate(candidates, '小镇周会')).toBe(false);
  });
});

describe('pickDayMeetingInstances —— 当天真实会议枚举(不漏)', () => {
  // 实测 2026-06-25 当天三场会的 Unix 秒(Asia/Shanghai):14:00 / 16:00 / 17:30。
  const TOWN = '1782367200'; // 小镇周会 14:00
  const NPC = '1782374400'; // NPC 16:00
  const INTERVIEW = '1782379800'; // 技术访谈 17:30

  it('空 items 返回 []', () => {
    expect(pickDayMeetingInstances([])).toEqual([]);
  });

  it('排除全天事件(只有 startDate、无 startTimestamp,如请假)', () => {
    const items: RawCalendarInstance[] = [
      { summary: '休假中(5 天)', status: 'confirmed', startDate: '2026-06-25' },
      { summary: '小镇周会', status: 'confirmed', startTimestamp: TOWN },
    ];
    const out = pickDayMeetingInstances(items);
    expect(out.map((m) => m.summary)).toEqual(['小镇周会']);
  });

  it('排除已取消(cancelled)与空标题占位事件', () => {
    const items: RawCalendarInstance[] = [
      { summary: '已取消的会', status: 'cancelled', startTimestamp: NPC },
      { summary: '   ', status: 'confirmed', startTimestamp: NPC },
      { summary: '技术访谈沟通', status: 'confirmed', startTimestamp: INTERVIEW },
    ];
    expect(pickDayMeetingInstances(items).map((m) => m.summary)).toEqual(['技术访谈沟通']);
  });

  it('乱序输入 → 按开始时间升序;归一化字段正确', () => {
    const items: RawCalendarInstance[] = [
      { summary: '技术访谈沟通', status: 'confirmed', startTimestamp: INTERVIEW },
      {
        summary: '小镇周会',
        status: 'confirmed',
        startTimestamp: TOWN,
        endTimestamp: '1782370800',
        attendeeAbility: 'can_modify_event',
        organizerDisplayName: '柳晗宇',
        organizerUserId: 'ou_self',
        vchatUrl: 'https://vc.feishu.cn/j/887885499',
      },
      { summary: 'NPC可行性', status: 'confirmed', startTimestamp: NPC },
    ];
    const out = pickDayMeetingInstances(items);
    expect(out.map((m) => m.summary)).toEqual(['小镇周会', 'NPC可行性', '技术访谈沟通']);
    expect(out[0]).toMatchObject({
      summary: '小镇周会',
      startSeconds: 1782367200,
      endSeconds: 1782370800,
      attendeeAbility: 'can_modify_event',
      organizerDisplayName: '柳晗宇',
    });
    // 无 endTimestamp 的会 endSeconds 为 null
    expect(out[1].endSeconds).toBeNull();
  });
});

describe('isSelfOrganizerHeuristic', () => {
  it('can_modify_event 视为本人可管理/组织', () => {
    expect(isSelfOrganizerHeuristic('can_modify_event')).toBe(true);
  });

  it('其余权限视为受邀参会人', () => {
    expect(isSelfOrganizerHeuristic('can_invite_others')).toBe(false);
    expect(isSelfOrganizerHeuristic('can_see_others')).toBe(false);
    expect(isSelfOrganizerHeuristic('none')).toBe(false);
    expect(isSelfOrganizerHeuristic(null)).toBe(false);
    expect(isSelfOrganizerHeuristic(undefined)).toBe(false);
  });
});

describe('classifyMeetingContentStatus —— 内容获取状态', () => {
  it('命中智能纪要 docx → got_notes_doc(优先于妙记)', () => {
    expect(
      classifyMeetingContentStatus({ docHit: true, minutesHit: true, isSelfOrganizer: false }),
    ).toBe('got_notes_doc');
  });

  it('docx 没命中、妙记命中 → got_minutes', () => {
    expect(
      classifyMeetingContentStatus({ docHit: false, minutesHit: true, isSelfOrganizer: false }),
    ).toBe('got_minutes');
  });

  it('都没命中 + 非组织者 → missing_not_organizer', () => {
    expect(
      classifyMeetingContentStatus({ docHit: false, minutesHit: false, isSelfOrganizer: false }),
    ).toBe('missing_not_organizer');
  });

  it('都没命中 + 本人可管理 → missing_no_record', () => {
    expect(
      classifyMeetingContentStatus({ docHit: false, minutesHit: false, isSelfOrganizer: true }),
    ).toBe('missing_no_record');
  });
});

describe('parseMinutesTokenFromUrl', () => {
  it('标准 recording URL 提取 token', () => {
    expect(
      parseMinutesTokenFromUrl(`${FEISHU_MINUTES_LINK_BASE}/minutes/obcn37dxcftoc3656rgyejm7`),
    ).toBe('obcn37dxcftoc3656rgyejm7');
  });

  it('带尾部斜杠', () => {
    expect(
      parseMinutesTokenFromUrl(`${FEISHU_MINUTES_LINK_BASE}/minutes/obcn37dxcftoc3656rgyejm7/`),
    ).toBe('obcn37dxcftoc3656rgyejm7');
  });

  it('带 query 参数', () => {
    expect(
      parseMinutesTokenFromUrl(
        `${FEISHU_MINUTES_LINK_BASE}/minutes/obcneo8zg8634f744j11fe88?from=recording`,
      ),
    ).toBe('obcneo8zg8634f744j11fe88');
  });

  it('非 minutes URL 返回 null', () => {
    expect(parseMinutesTokenFromUrl(`${FEISHU_DOC_LINK_BASE}/docx/abc123`)).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(parseMinutesTokenFromUrl('')).toBeNull();
  });
});

describe('parseVcMeetingTime', () => {
  it('纯数字 Unix 秒', () => {
    expect(parseVcMeetingTime('1719129600')).toBe(1719129600);
  });

  it('解析 "2022.12.23 11:16:59 (GMT+08:00)" 格式', () => {
    const result = parseVcMeetingTime('2022.12.23 11:16:59 (GMT+08:00)');
    // 2022-12-23 11:16:59 +08:00 = 2022-12-23 03:16:59 UTC
    const expected = Math.floor(Date.UTC(2022, 11, 23, 3, 16, 59) / 1000);
    expect(result).toBe(expected);
  });

  it('解析 GMT+00:00', () => {
    const result = parseVcMeetingTime('2026.06.25 09:27:00 (GMT+00:00)');
    const expected = Math.floor(Date.UTC(2026, 5, 25, 9, 27, 0) / 1000);
    expect(result).toBe(expected);
  });

  it('解析 GMT-05:00', () => {
    const result = parseVcMeetingTime('2026.01.15 14:30:00 (GMT-05:00)');
    // 14:30 at -05:00 = 19:30 UTC
    const expected = Math.floor(Date.UTC(2026, 0, 15, 19, 30, 0) / 1000);
    expect(result).toBe(expected);
  });

  it('非法格式返回 null', () => {
    expect(parseVcMeetingTime('invalid time')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(parseVcMeetingTime('')).toBeNull();
  });
});
