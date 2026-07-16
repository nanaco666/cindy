import { describe, expect, it } from 'vitest';

import { parseFeishuTimestampSeconds } from '../mcp/time.js';

describe('parseFeishuTimestampSeconds', () => {
  it('keeps Unix timestamp seconds unchanged', () => {
    expect(parseFeishuTimestampSeconds('1778040000')).toEqual({
      ok: true,
      value: '1778040000',
    });
  });

  it('converts Unix timestamp milliseconds to seconds', () => {
    expect(parseFeishuTimestampSeconds('1778040000000')).toEqual({
      ok: true,
      value: '1778040000',
    });
  });

  it('converts RFC3339 times with explicit timezone to Unix seconds', () => {
    expect(parseFeishuTimestampSeconds('2026-05-06T12:00:00+08:00')).toEqual({
      ok: true,
      value: '1778040000',
    });
    expect(parseFeishuTimestampSeconds('2026-05-06T04:00:00Z')).toEqual({
      ok: true,
      value: '1778040000',
    });
  });

  it('uses an explicit IANA timezone for timezone-less date-times', () => {
    expect(
      parseFeishuTimestampSeconds('2026-05-06 12:00:00', {
        timeZone: 'Asia/Shanghai',
      }),
    ).toEqual({
      ok: true,
      value: '1778040000',
    });
    expect(
      parseFeishuTimestampSeconds('2026-05-06 12:00:00', {
        timeZone: 'America/Los_Angeles',
      }),
    ).toEqual({
      ok: true,
      value: '1778094000',
    });
  });

  it('uses an explicit fixed offset for timezone-less date-times', () => {
    expect(
      parseFeishuTimestampSeconds('2026-05-06 12:00:00', {
        timeZone: '+08:00',
      }),
    ).toEqual({
      ok: true,
      value: '1778040000',
    });
  });

  it('treats date-only inputs as midnight in the selected timezone', () => {
    expect(
      parseFeishuTimestampSeconds('2026-05-06', {
        timeZone: 'Asia/Shanghai',
      }),
    ).toEqual({
      ok: true,
      value: '1777996800',
    });
  });

  it('rejects unparseable time values', () => {
    const result = parseFeishuTimestampSeconds('tomorrow noon');
    expect(result.ok).toBe(false);
  });
});
