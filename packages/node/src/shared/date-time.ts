const rfc3339DateTime = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/u;
const fractionalSecond = /\.(\d+)(?:[Zz]|[+-]\d{2}:\d{2})$/u;
const unknownLocalOffset = /-00:00$/u;

/** Exact RFC 3339 date-time assertion, including a mandatory UTC offset. */
export function isRfc3339DateTime(value: string): boolean {
  const match = rfc3339DateTime.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetSign = match[7] === '-' ? -1 : 1;
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  if (second <= 59) return true;
  if (second !== 60) return false;

  const localMinuteOfDay = hour * 60 + minute;
  const offset = offsetSign * (offsetHour * 60 + offsetMinute);
  const unnormalizedUtcMinute = localMinuteOfDay - offset;
  const utcDayDelta = Math.floor(unnormalizedUtcMinute / (24 * 60));
  const utcMinuteOfDay = unnormalizedUtcMinute - utcDayDelta * 24 * 60;
  if (utcMinuteOfDay !== 23 * 60 + 59) return false;

  let utcYear = year;
  let utcMonth = month;
  let utcDay = day + utcDayDelta;
  if (utcDay === 0) {
    utcMonth -= 1;
    if (utcMonth === 0) {
      utcMonth = 12;
      utcYear -= 1;
    }
    const utcLeapYear = utcYear % 4 === 0 && (utcYear % 100 !== 0 || utcYear % 400 === 0);
    utcDay = [31, utcLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      utcMonth - 1
    ]!;
  } else if (utcDay > (daysInMonth[month - 1] ?? 0)) {
    utcDay = 1;
    utcMonth += 1;
    if (utcMonth === 13) {
      utcMonth = 1;
      utcYear += 1;
    }
  }
  const utcLeapYear = utcYear % 4 === 0 && (utcYear % 100 !== 0 || utcYear % 400 === 0);
  const utcDaysInMonth = [31, utcLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return utcDay === utcDaysInMonth[utcMonth - 1];
}

/** Serializes a representable instant as an RFC 3339 UTC date-time with an uppercase `Z`. */
export function formatCanonicalDateTime(value: Date | string): string {
  let instant: Date;

  if (typeof value === 'string') {
    if (!isRfc3339DateTime(value)) {
      throw new TypeError('Date-time must be a valid RFC 3339 string.');
    }
    if (unknownLocalOffset.test(value)) {
      throw new RangeError('Date-time with an unknown local offset cannot be normalized to UTC.');
    }

    const fraction = fractionalSecond.exec(value)?.[1];
    if (fraction !== undefined && fraction.length > 3 && /[^0]/u.test(fraction.slice(3))) {
      throw new RangeError('Date-time precision cannot be represented without losing the instant.');
    }
    instant = new Date(value);
  } else if (value instanceof Date) {
    instant = new Date(value.getTime());
  } else {
    throw new TypeError('Date-time must be a Date or RFC 3339 string.');
  }

  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError('Date-time cannot be represented as a JavaScript instant.');
  }

  const canonical = instant.toISOString();
  if (!isRfc3339DateTime(canonical)) {
    throw new RangeError('Date-time is outside the RFC 3339 four-digit year range.');
  }
  return canonical;
}
