export const PUBLISHING_INSIGHTS_WINDOW_DAYS = 30;
export const PUBLISHING_INSIGHTS_WEEKLY_DAYS = 28;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PublishingInsightsWindowBounds {
  readonly fromDayInclusive: string;
  readonly toDayExclusive: string;
  readonly weeklyStarts: readonly [string, string, string, string];
}

export function utcDayString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function publishingInsightsWindowBounds(now: Date): PublishingInsightsWindowBounds {
  const today = utcDayString(now);
  const weeklyFromInclusive = addUtcDays(today, 1 - PUBLISHING_INSIGHTS_WEEKLY_DAYS);
  return Object.freeze({
    fromDayInclusive: addUtcDays(today, 1 - PUBLISHING_INSIGHTS_WINDOW_DAYS),
    toDayExclusive: addUtcDays(today, 1),
    weeklyStarts: Object.freeze([
      weeklyFromInclusive,
      addUtcDays(weeklyFromInclusive, 7),
      addUtcDays(weeklyFromInclusive, 14),
      addUtcDays(weeklyFromInclusive, 21),
    ] as [string, string, string, string]),
  });
}
