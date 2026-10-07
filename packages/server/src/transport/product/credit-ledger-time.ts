/** Preserve fractional seconds for PostgreSQL predicates and signed filters. */
export function validCreditInstant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]!
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function compareCreditInstants(left: string, right: string): number {
  const parts = (value: string) => {
    const fraction = /\.(\d+)/u.exec(value)?.[1] ?? '';
    return { seconds: Date.parse(value.replace(/\.\d+/u, '')), fraction };
  };
  const a = parts(left), b = parts(right);
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const af = a.fraction.padEnd(width, '0'), bf = b.fraction.padEnd(width, '0');
  return af === bf ? 0 : af < bf ? -1 : 1;
}
