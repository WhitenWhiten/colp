import type { InsightEventType } from './record-insight-event.js';

export const PUBLISHING_INSIGHTS_WINDOW_DAYS = 30;
export const PUBLISHING_INSIGHTS_WEEKLY_DAYS = 28;
export const PUBLISHING_INSIGHTS_TOP_LIMIT = 3;
export const PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES = Object.freeze(
  ['collection_view', 'preview_open'] as const,
);
export type PublishingInsightsFunnelEventType = (typeof PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FUNNEL_LABELS = ['Collection views', 'Preview opens'] as const;
const WEEKLY_LABELS = ['W1', 'W2', 'W3', 'W4'] as const;

export interface PublishingInsightsActor {
  readonly subjectId: string;
}

export interface PublishingInsightsCollectionFacts {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly publicationSlug: string | null;
  readonly publishedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface PublishingInsightsDailyCount {
  readonly collectionId: string;
  readonly day: string;
  readonly eventType: InsightEventType;
  readonly nodeId: string;
  readonly count: number;
}

export interface PublishingInsightsTopResourceRow {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly title: string;
  readonly opens: number;
}

export interface PublishingInsightsWindowBounds {
  readonly fromDayInclusive: string;
  readonly toDayExclusive: string;
  readonly weeklyStarts: readonly [string, string, string, string];
}

export interface PublishingInsightsDashboardPort {
  listDailyCounts(input: {
    readonly ownerSubjectId: string;
    readonly fromDayInclusive: string;
    readonly toDayExclusive: string;
    readonly eventTypes: readonly PublishingInsightsFunnelEventType[];
  }): Promise<readonly PublishingInsightsDailyCount[]>;
  listTopResourceOpens(input: {
    readonly ownerSubjectId: string;
    readonly fromDayInclusive: string;
    readonly toDayExclusive: string;
    readonly limit: number;
  }): Promise<readonly PublishingInsightsTopResourceRow[]>;
}

export interface PublishingInsightsFunnelItem {
  readonly label: (typeof FUNNEL_LABELS)[number];
  readonly value: number;
}

export interface PublishingInsightsWeeklyItem {
  readonly w: (typeof WEEKLY_LABELS)[number];
  readonly views: number;
}

export interface PublishingInsightsTopResource {
  readonly id: string;
  readonly collectionId: string;
  readonly title: string;
  readonly opens: number;
}

export interface PublishingInsights {
  readonly window: { readonly days: typeof PUBLISHING_INSIGHTS_WINDOW_DAYS };
  readonly funnel: readonly [PublishingInsightsFunnelItem, PublishingInsightsFunnelItem];
  readonly weekly: readonly [
    PublishingInsightsWeeklyItem,
    PublishingInsightsWeeklyItem,
    PublishingInsightsWeeklyItem,
    PublishingInsightsWeeklyItem,
  ];
  readonly topResources: readonly PublishingInsightsTopResource[];
}

export interface GetPublishingInsightsPorts {
  readonly dashboard: PublishingInsightsDashboardPort;
}

export function utcDayString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function publishingInsightsWindowBounds(now: Date): PublishingInsightsWindowBounds {
  // Funnel is exactly PUBLISHING_INSIGHTS_WINDOW_DAYS UTC calendar days including today:
  // today = utcDayString(now)
  // fromDayInclusive = addUtcDays(today, 1 - PUBLISHING_INSIGHTS_WINDOW_DAYS)  // today - 29
  // toDayExclusive = addUtcDays(today, 1)
  // Inclusive range today-29 … today = 30 dates.
  // Weekly does NOT share funnel from. Weekly is exactly 28 UTC days including today
  // (4×7 buckets): weeklyStarts = [today-27, today-20, today-13, today-6] via addUtcDays
  // (not now.getTime() - N*ms, which recreates the off-by-one).
  // W1 = [today-27, today-21], W2 = [today-20, today-14], W3 = [today-13, today-7],
  // W4 = [today-6, today] (all inclusive). window.days stays 30 (funnel).
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

export function isPublishingInsightsEligibleCollection(
  collection: PublishingInsightsCollectionFacts,
  ownerSubjectId: string,
): boolean {
  if (collection.ownerSubjectId !== ownerSubjectId) return false;
  if (collection.deletedAt !== null) return false;
  if (collection.visibility !== 'public' && collection.visibility !== 'unlisted') return false;
  if (typeof collection.publicationSlug !== 'string' || collection.publicationSlug.length === 0) return false;
  return collection.publishedAt !== null;
}

export async function getPublishingInsights(
  ports: GetPublishingInsightsPorts,
  actor: PublishingInsightsActor,
  now: Date,
): Promise<PublishingInsights> {
  const window = publishingInsightsWindowBounds(now);
  const [daily, topRows] = await Promise.all([
    ports.dashboard.listDailyCounts({
      ownerSubjectId: actor.subjectId,
      fromDayInclusive: window.fromDayInclusive,
      toDayExclusive: window.toDayExclusive,
      eventTypes: PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES,
    }),
    ports.dashboard.listTopResourceOpens({
      ownerSubjectId: actor.subjectId,
      fromDayInclusive: window.fromDayInclusive,
      toDayExclusive: window.toDayExclusive,
      limit: PUBLISHING_INSIGHTS_TOP_LIMIT,
    }),
  ]);
  let collectionViews = 0;
  let previewOpens = 0;
  const weeklyViews = [0, 0, 0, 0];
  for (const row of daily) {
    if (row.eventType === 'collection_view') {
      collectionViews += row.count;
      const bucket = weeklyBucket(row.day, window);
      if (bucket !== null) weeklyViews[bucket] = (weeklyViews[bucket] ?? 0) + row.count;
    } else if (row.eventType === 'preview_open') {
      previewOpens += row.count;
    }
  }
  const topResources = [...topRows]
    .sort((left, right) => right.opens - left.opens || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0))
    .slice(0, PUBLISHING_INSIGHTS_TOP_LIMIT)
    .map((row) => Object.freeze({
      id: row.nodeId,
      collectionId: row.collectionId,
      title: row.title,
      opens: row.opens,
    }));
  const funnel = Object.freeze([
    Object.freeze({ label: FUNNEL_LABELS[0], value: collectionViews }),
    Object.freeze({ label: FUNNEL_LABELS[1], value: previewOpens }),
  ] as const);
  const weekly = Object.freeze([
    Object.freeze({ w: WEEKLY_LABELS[0], views: weeklyViews[0]! }),
    Object.freeze({ w: WEEKLY_LABELS[1], views: weeklyViews[1]! }),
    Object.freeze({ w: WEEKLY_LABELS[2], views: weeklyViews[2]! }),
    Object.freeze({ w: WEEKLY_LABELS[3], views: weeklyViews[3]! }),
  ] as const);
  return Object.freeze({
    window: Object.freeze({ days: PUBLISHING_INSIGHTS_WINDOW_DAYS }),
    funnel,
    weekly,
    topResources: Object.freeze(topResources),
  });
}

function weeklyBucket(
  day: string,
  window: PublishingInsightsWindowBounds,
): 0 | 1 | 2 | 3 | null {
  if (day < window.weeklyStarts[0] || day >= window.toDayExclusive) return null;
  if (day >= window.weeklyStarts[3]) return 3;
  if (day >= window.weeklyStarts[2]) return 2;
  if (day >= window.weeklyStarts[1]) return 1;
  return 0;
}
