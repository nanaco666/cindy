export type FeishuTimestampParseResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export interface FeishuTimestampParseOptions {
  timeZone?: string;
}

const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;
const DATE_TIME_WITH_ZONE_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)\s*(Z|[+-]\d{2}:?\d{2})$/i;

function normalizeOffset(offset: string): string {
  if (offset.toUpperCase() === 'Z') return 'Z';
  if (/^[+-]\d{2}:\d{2}$/.test(offset)) return offset;
  if (/^[+-]\d{4}$/.test(offset)) return `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return offset;
}

function isFixedOffset(timeZone: string): boolean {
  return /^(Z|UTC|[+-]\d{2}:?\d{2})$/i.test(timeZone.trim());
}

function parseMilliseconds(fraction: string | undefined): number {
  if (!fraction) return 0;
  return Number(fraction.slice(1).padEnd(3, '0').slice(0, 3));
}

function normalizeDateTimeInput(input: string): string | null {
  const value = input.trim();

  const explicitZone = DATE_TIME_WITH_ZONE_RE.exec(value);
  if (explicitZone) {
    return `${explicitZone[1]}T${explicitZone[2]}${normalizeOffset(explicitZone[3])}`;
  }

  return null;
}

function parseLocalDateTimeParts(input: string):
  | {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      second: number;
      millisecond: number;
    }
  | null {
  const dateOnly = DATE_ONLY_RE.exec(input);
  if (dateOnly) {
    const [year, month, day] = dateOnly[1].split('-').map(Number);
    return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
  }

  const dateTime = DATE_TIME_RE.exec(input);
  if (!dateTime) return null;

  const [year, month, day] = dateTime[1].split('-').map(Number);
  const time = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/.exec(dateTime[2]);
  if (!time) return null;

  return {
    year,
    month,
    day,
    hour: Number(time[1]),
    minute: Number(time[2]),
    second: time[3] ? Number(time[3]) : 0,
    millisecond: parseMilliseconds(time[4]),
  };
}

function getTimeZoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')),
    Number(values.get('minute')),
    Number(values.get('second')),
  );

  return zonedAsUtc - utcMs;
}

function localTimeInZoneToUtcMs(
  parts: NonNullable<ReturnType<typeof parseLocalDateTimeParts>>,
  timeZone: string,
): FeishuTimestampParseResult {
  const zone = timeZone.trim();
  if (!zone) {
    return { ok: false, error: 'time_zone is empty' };
  }

  if (isFixedOffset(zone)) {
    const offset = zone.toUpperCase() === 'UTC' ? 'Z' : normalizeOffset(zone);
    const timestamp = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}.${String(parts.millisecond).padStart(3, '0')}${offset}`;
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) {
      return { ok: false, error: `invalid time_zone: ${timeZone}` };
    }
    return { ok: true, value: String(Math.floor(ms / 1000)) };
  }

  try {
    const localAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    );

    let utcMs = localAsUtc;
    for (let i = 0; i < 3; i++) {
      utcMs = localAsUtc - getTimeZoneOffsetMs(zone, utcMs);
    }
    return { ok: true, value: String(Math.floor(utcMs / 1000)) };
  } catch {
    return { ok: false, error: `invalid time_zone: ${timeZone}` };
  }
}

function localTimeInHostZoneToUtcMs(
  parts: NonNullable<ReturnType<typeof parseLocalDateTimeParts>>,
): string {
  const ms = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  ).getTime();
  return String(Math.floor(ms / 1000));
}

export function parseFeishuTimestampSeconds(
  input: string,
  options: FeishuTimestampParseOptions = {},
): FeishuTimestampParseResult {
  const value = input.trim();
  if (!value) {
    return { ok: false, error: 'time value is empty' };
  }

  if (/^\d+$/.test(value)) {
    if (value.length >= 13) {
      return { ok: true, value: String(BigInt(value) / 1000n) };
    }
    return { ok: true, value };
  }

  const normalized = normalizeDateTimeInput(value);
  if (normalized) {
    const ms = Date.parse(normalized);
    if (!Number.isFinite(ms)) {
      return {
        ok: false,
        error:
          'expected Unix timestamp seconds, Unix timestamp milliseconds, or RFC3339/ISO date-time',
      };
    }

    return { ok: true, value: String(Math.floor(ms / 1000)) };
  }

  const localParts = parseLocalDateTimeParts(value);
  if (!localParts) {
    return {
      ok: false,
      error:
        'expected Unix timestamp seconds, Unix timestamp milliseconds, or RFC3339/ISO date-time',
    };
  }

  if (options.timeZone) {
    return localTimeInZoneToUtcMs(localParts, options.timeZone);
  }

  return { ok: true, value: localTimeInHostZoneToUtcMs(localParts) };
}
