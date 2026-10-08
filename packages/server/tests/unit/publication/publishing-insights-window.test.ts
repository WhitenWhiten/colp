import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  addUtcDays,
  getPublishingInsights,
  publishingInsightsWindowBounds,
  utcDayString,
  PUBLISHING_INSIGHTS_WINDOW_DAYS,
  type InsightEventType,
  type PublishingInsightsCollectionFacts,
  type PublishingInsightsDailyCount,
  type PublishingInsightsDashboardPort,
  type PublishingInsightsFunnelEventType,
  type PublishingInsightsTopResourceRow,
} from '../../../src/modules/publication/index.js';

const PINNED_NOW = new Date('2026-08-19T08:00:00.000Z');
const OWNER = 'owner-1';

describe('publishingInsightsWindowBounds', () => {
  test('pins 30 UTC days including today and 4×7 weekly buckets for 2026-08-19T08:00Z', () => {
    const bounds = publishingInsightsWindowBounds(PINNED_NOW);
    const today = utcDayString(PINNED_NOW);
    assert.equal(today, '2026-08-19');
    assert.equal(bounds.fromDayInclusive, '2026-07-21');
    assert.equal(bounds.toDayExclusive, '2026-08-20');
    assert.deepEqual(bounds.weeklyStarts, ['2026-07-23', '2026-07-30', '2026-08-06', '2026-08-13']);
    assert.equal(addUtcDays(today, 1 - 30), '2026-07-21');
    assert.equal(addUtcDays(today, -27), '2026-07-23');
    assert.equal(PUBLISHING_INSIGHTS_WINDOW_DAYS, 30);
  });
});

describe('getPublishingInsights window membership', () => {
  test('funnel includes fromDayInclusive and today and excludes the day before and toDayExclusive', async () => {
    const memory = createMemory({
      collections: [published('col-live')],
      daily: [
        row('col-live', '2026-07-20', 'collection_view', 11),
        row('col-live', '2026-07-21', 'collection_view', 3),
        row('col-live', '2026-08-19', 'collection_view', 5),
        row('col-live', '2026-08-20', 'collection_view', 17),
        row('col-live', '2026-07-20', 'preview_open', 11),
        row('col-live', '2026-07-21', 'preview_open', 2),
        row('col-live', '2026-08-19', 'preview_open', 4),
        row('col-live', '2026-08-20', 'preview_open', 17),
      ],
    });
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, PINNED_NOW);
    assert.equal(result.window.days, 30);
    assert.deepEqual(result.funnel, [
      { label: 'Collection views', value: 8 },
      { label: 'Preview opens', value: 6 },
    ]);
    assert.deepEqual(memory.listDailyCountsCalls[0], {
      ownerSubjectId: OWNER,
      fromDayInclusive: '2026-07-21',
      toDayExclusive: '2026-08-20',
      eventTypes: ['collection_view', 'preview_open'],
    });
  });

  test('weekly excludes today-28 even when that day is inside the 30-day funnel', async () => {
    const memory = createMemory({
      collections: [published('col-live')],
      daily: [
        row('col-live', '2026-07-22', 'collection_view', 9),
        row('col-live', '2026-07-23', 'collection_view', 1),
      ],
    });
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, PINNED_NOW);
    assert.equal(result.funnel[0]?.value, 10);
    assert.deepEqual(result.weekly, [
      { w: 'W1', views: 1 },
      { w: 'W2', views: 0 },
      { w: 'W3', views: 0 },
      { w: 'W4', views: 0 },
    ]);
  });

  test('W4 includes today and today-6 and excludes today-7', async () => {
    const memory = createMemory({
      collections: [published('col-live')],
      daily: [
        row('col-live', '2026-08-12', 'collection_view', 4),
        row('col-live', '2026-08-13', 'collection_view', 8),
        row('col-live', '2026-08-19', 'collection_view', 2),
      ],
    });
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, PINNED_NOW);
    assert.deepEqual(result.weekly, [
      { w: 'W1', views: 0 },
      { w: 'W2', views: 0 },
      { w: 'W3', views: 4 },
      { w: 'W4', views: 10 },
    ]);
    assert.equal(result.funnel[0]?.value, 14);
  });
});

function published(collectionId: string): PublishingInsightsCollectionFacts {
  return {
    collectionId,
    ownerSubjectId: OWNER,
    visibility: 'public',
    publicationSlug: `${collectionId}-slug`,
    publishedAt: PINNED_NOW,
    deletedAt: null,
  };
}

function row(
  collectionId: string,
  day: string,
  eventType: InsightEventType,
  count: number,
  nodeId = '',
): PublishingInsightsDailyCount {
  return { collectionId, day, eventType, nodeId, count };
}

function createMemory(options: {
  readonly collections?: readonly PublishingInsightsCollectionFacts[];
  readonly daily?: PublishingInsightsDailyCount[];
} = {}): {
  readonly ports: { readonly dashboard: PublishingInsightsDashboardPort };
  readonly listDailyCountsCalls: Array<{
    readonly ownerSubjectId: string;
    readonly fromDayInclusive: string;
    readonly toDayExclusive: string;
    readonly eventTypes: readonly PublishingInsightsFunnelEventType[];
  }>;
} {
  const collections = [...(options.collections ?? [])];
  const daily = [...(options.daily ?? [])];
  const listDailyCountsCalls: Array<{
    readonly ownerSubjectId: string;
    readonly fromDayInclusive: string;
    readonly toDayExclusive: string;
    readonly eventTypes: readonly PublishingInsightsFunnelEventType[];
  }> = [];
  const dashboard: PublishingInsightsDashboardPort = {
    async listDailyCounts(input) {
      listDailyCountsCalls.push(input);
      const allowed = new Set(input.eventTypes);
      const eligible = new Set(collections.map((collection) => collection.collectionId));
      return daily.filter((item) => (
        eligible.has(item.collectionId)
        && allowed.has(item.eventType)
        && item.day >= input.fromDayInclusive
        && item.day < input.toDayExclusive
      ));
    },
    async listTopResourceOpens(input) {
      const sums = new Map<string, PublishingInsightsTopResourceRow>();
      for (const item of daily) {
        if (item.eventType !== 'resource_open' || item.nodeId.length === 0) continue;
        if (item.day < input.fromDayInclusive || item.day >= input.toDayExclusive) continue;
        const current = sums.get(item.nodeId);
        sums.set(item.nodeId, {
          nodeId: item.nodeId,
          collectionId: item.collectionId,
          title: '',
          opens: (current?.opens ?? 0) + item.count,
        });
      }
      return [...sums.values()]
        .sort((left, right) => right.opens - left.opens || (left.nodeId < right.nodeId ? -1 : 1))
        .slice(0, input.limit);
    },
  };
  return { ports: { dashboard }, listDailyCountsCalls };
}
