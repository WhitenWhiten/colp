import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  getPublishingInsights,
  PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES,
  type InsightEventType,
  type PublishingInsightsCollectionFacts,
  type PublishingInsightsDailyCount,
  type PublishingInsightsDashboardPort,
  type PublishingInsightsFunnelEventType,
  type PublishingInsightsTopResourceRow,
} from '../../../src/modules/publication/index.js';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OWNER = 'owner-1';
const OTHER = 'owner-2';

function utcDay(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

describe('getPublishingInsights', () => {
  test('excludes daily rows from 30 days ago from the 30-day funnel', async () => {
    const memory = createMemory({
      collections: [published('col-live', OWNER)],
      daily: [
        row('col-live', utcDay(-31), 'collection_view', 9),
        row('col-live', utcDay(-30), 'collection_view', 9),
        row('col-live', utcDay(-30), 'preview_open', 9),
        row('col-live', utcDay(-29), 'collection_view', 2),
        row('col-live', utcDay(-29), 'preview_open', 4),
        row('col-live', utcDay(0), 'collection_view', 1),
        row('col-live', utcDay(0), 'preview_open', 1),
      ],
    });
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, NOW);
    assert.equal(result.window.days, 30);
    assert.deepEqual(memory.listDailyCountsCalls[0]?.eventTypes, [...PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES]);
    assert.equal((memory.listDailyCountsCalls[0]?.eventTypes as readonly string[]).includes('resource_open'), false);
    assert.deepEqual(result.funnel, [
      { label: 'Collection views', value: 3 },
      { label: 'Preview opens', value: 5 },
    ]);
  });

  test('unpublished, private, and other-owner collections vanish from aggregation', async () => {
    const memory = createMemory({
      collections: [
        published('col-live', OWNER),
        published('col-unlisted', OWNER, { visibility: 'unlisted' }),
        {
          collectionId: 'col-ghost',
          ownerSubjectId: OWNER,
          visibility: 'public',
          publicationSlug: null,
          publishedAt: null,
          deletedAt: null,
        },
        {
          collectionId: 'col-draft',
          ownerSubjectId: OWNER,
          visibility: 'public',
          publicationSlug: 'draft-notes',
          publishedAt: null,
          deletedAt: null,
        },
        {
          collectionId: 'col-private',
          ownerSubjectId: OWNER,
          visibility: 'private',
          publicationSlug: 'private-notes',
          publishedAt: NOW,
          deletedAt: null,
        },
        {
          collectionId: 'col-protected',
          ownerSubjectId: OWNER,
          visibility: 'protected',
          publicationSlug: 'protected-notes',
          publishedAt: NOW,
          deletedAt: null,
        },
        {
          collectionId: 'col-deleted',
          ownerSubjectId: OWNER,
          visibility: 'public',
          publicationSlug: 'deleted-notes',
          publishedAt: NOW,
          deletedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
        published('col-other', OTHER),
      ],
      daily: [
        row('col-live', utcDay(-1), 'collection_view', 3),
        row('col-unlisted', utcDay(-1), 'collection_view', 2),
        row('col-unlisted', utcDay(-1), 'preview_open', 1),
        row('col-ghost', utcDay(-1), 'collection_view', 50),
        row('col-draft', utcDay(-1), 'collection_view', 50),
        row('col-private', utcDay(-1), 'collection_view', 50),
        row('col-protected', utcDay(-1), 'collection_view', 50),
        row('col-deleted', utcDay(-1), 'collection_view', 50),
        row('col-other', utcDay(-1), 'collection_view', 50),
        row('col-other', utcDay(-1), 'preview_open', 50),
      ],
    });
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, NOW);
    assert.deepEqual(result.funnel, [
      { label: 'Collection views', value: 5 },
      { label: 'Preview opens', value: 1 },
    ]);
  });

  test('tied resource_open sums break with nodeId ASC', async () => {
    const memory = createMemory({
      collections: [published('col-live', OWNER)],
      daily: [
        row('col-live', utcDay(-1), 'resource_open', 5, 'node-b'),
        row('col-live', utcDay(-2), 'resource_open', 5, 'node-a'),
        row('col-live', utcDay(-3), 'resource_open', 9, 'node-c'),
        row('col-live', utcDay(-1), 'resource_open', 1, 'node-d'),
      ],
      nodes: [
        bookmark('node-b', 'col-live', 'Beta'),
        bookmark('node-a', 'col-live', 'Alpha'),
        bookmark('node-c', 'col-live', 'Gamma'),
        bookmark('node-d', 'col-live', 'Delta'),
        { nodeId: 'node-gone', collectionId: 'col-live', kind: 'bookmark', title: 'Gone', deletedAt: NOW },
        { nodeId: 'node-folder', collectionId: 'col-live', kind: 'folder', title: 'Folder', deletedAt: null },
      ],
    });
    memory.daily.push(row('col-live', utcDay(-1), 'resource_open', 100, 'node-gone'));
    memory.daily.push(row('col-live', utcDay(-1), 'resource_open', 100, 'node-folder'));
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, NOW);
    assert.deepEqual(result.topResources, [
      { id: 'node-c', collectionId: 'col-live', title: 'Gamma', opens: 9 },
      { id: 'node-a', collectionId: 'col-live', title: 'Alpha', opens: 5 },
      { id: 'node-b', collectionId: 'col-live', title: 'Beta', opens: 5 },
    ]);
  });

  test('empty owner returns zeros and an empty topResources list', async () => {
    const memory = createMemory();
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, NOW);
    assert.deepEqual(result, {
      window: { days: 30 },
      funnel: [
        { label: 'Collection views', value: 0 },
        { label: 'Preview opens', value: 0 },
      ],
      weekly: [
        { w: 'W1', views: 0 },
        { w: 'W2', views: 0 },
        { w: 'W3', views: 0 },
        { w: 'W4', views: 0 },
      ],
      topResources: [],
    });
  });

  test('weekly W1 is the oldest 7-day bucket', async () => {
    const memory = createMemory({
      collections: [published('col-live', OWNER)],
      daily: [
        row('col-live', utcDay(-25), 'collection_view', 7),
        row('col-live', utcDay(-18), 'collection_view', 3),
        row('col-live', utcDay(-10), 'collection_view', 2),
        row('col-live', utcDay(-3), 'collection_view', 11),
      ],
    });
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, NOW);
    assert.deepEqual(result.weekly.map((item) => item.w), ['W1', 'W2', 'W3', 'W4']);
    assert.deepEqual(result.weekly, [
      { w: 'W1', views: 7 },
      { w: 'W2', views: 3 },
      { w: 'W3', views: 2 },
      { w: 'W4', views: 11 },
    ]);
    assert.equal(result.funnel[0]?.value, 23);
  });

  test('null bookmark titles map to an empty string', async () => {
    const memory = createMemory({
      collections: [published('col-live', OWNER)],
      daily: [row('col-live', utcDay(-1), 'resource_open', 4, 'node-null')],
      nodes: [{ nodeId: 'node-null', collectionId: 'col-live', kind: 'bookmark', title: null, deletedAt: null }],
    });
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, NOW);
    assert.equal(result.topResources[0]?.title, '');
    assert.equal(result.topResources[0]?.collectionId, 'col-live');
  });

  test('listDailyCounts is invoked with funnel types and never returns resource_open', async () => {
    const resourceRows = Array.from({ length: 220 }, (_, index) => (
      row('col-live', utcDay(-1), 'resource_open', 1, `node-flood-${index}`)
    ));
    const memory = createMemory({
      collections: [published('col-live', OWNER)],
      daily: [
        row('col-live', utcDay(-1), 'collection_view', 2),
        row('col-live', utcDay(-1), 'preview_open', 1),
        ...resourceRows,
      ],
      nodes: resourceRows.map((item, index) => bookmark(item.nodeId, 'col-live', `Flood ${index}`)),
    });
    const listed = await memory.ports.dashboard.listDailyCounts({
      ownerSubjectId: OWNER,
      fromDayInclusive: utcDay(-29),
      toDayExclusive: utcDay(1),
      eventTypes: PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES,
    });
    assert.equal(listed.some((item) => item.eventType === 'resource_open'), true);
    const result = await getPublishingInsights(memory.ports, { subjectId: OWNER }, NOW);
    assert.deepEqual(memory.listDailyCountsCalls.at(-1)?.eventTypes, [...PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES]);
    assert.equal(memory.listDailyCountsCalls.at(-1)?.eventTypes.includes('resource_open'), false);
    assert.deepEqual(result.funnel, [
      { label: 'Collection views', value: 2 },
      { label: 'Preview opens', value: 1 },
    ]);
    assert.equal(result.topResources.length, 3);
    assert.equal(result.topResources[0]?.opens, 1);
  });
});

function published(
  collectionId: string,
  ownerSubjectId: string,
  extra: Partial<PublishingInsightsCollectionFacts> = {},
): PublishingInsightsCollectionFacts {
  return {
    collectionId,
    ownerSubjectId,
    visibility: 'public',
    publicationSlug: `${collectionId}-slug`,
    publishedAt: NOW,
    deletedAt: null,
    ...extra,
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

function bookmark(
  nodeId: string,
  collectionId: string,
  title: string,
): {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly kind: 'bookmark' | 'folder';
  readonly title: string | null;
  readonly deletedAt: Date | null;
} {
  return { nodeId, collectionId, kind: 'bookmark', title, deletedAt: null };
}

function createMemory(options: {
  readonly collections?: readonly PublishingInsightsCollectionFacts[];
  readonly daily?: PublishingInsightsDailyCount[];
  readonly nodes?: ReadonlyArray<{
    readonly nodeId: string;
    readonly collectionId: string;
    readonly kind: 'bookmark' | 'folder';
    readonly title: string | null;
    readonly deletedAt: Date | null;
  }>;
} = {}): {
  readonly ports: { readonly dashboard: PublishingInsightsDashboardPort };
  readonly daily: PublishingInsightsDailyCount[];
  readonly listDailyCountsCalls: Array<{
    readonly ownerSubjectId: string;
    readonly fromDayInclusive: string;
    readonly toDayExclusive: string;
    readonly eventTypes: readonly PublishingInsightsFunnelEventType[];
  }>;
} {
  const collections = [...(options.collections ?? [])];
  const daily = [...(options.daily ?? [])];
  const nodes = [...(options.nodes ?? [])];
  const listDailyCountsCalls: Array<{
    readonly ownerSubjectId: string;
    readonly fromDayInclusive: string;
    readonly toDayExclusive: string;
    readonly eventTypes: readonly PublishingInsightsFunnelEventType[];
  }> = [];
  const dashboard: PublishingInsightsDashboardPort = {
    async listDailyCounts(input) {
      listDailyCountsCalls.push(input);
      const eligible = eligibleIds(collections, input.ownerSubjectId);
      return daily.filter((item) => (
        eligible.has(item.collectionId)
        && item.day >= input.fromDayInclusive
        && item.day < input.toDayExclusive
      ));
    },
    async listTopResourceOpens(input) {
      const eligible = eligibleIds(collections, input.ownerSubjectId);
      const sums = new Map<string, PublishingInsightsTopResourceRow>();
      for (const item of daily) {
        if (item.eventType !== 'resource_open' || item.nodeId.length === 0) continue;
        if (!eligible.has(item.collectionId)) continue;
        if (item.day < input.fromDayInclusive || item.day >= input.toDayExclusive) continue;
        const node = nodes.find((candidate) => candidate.nodeId === item.nodeId);
        if (node === undefined || node.kind !== 'bookmark' || node.deletedAt !== null) continue;
        const current = sums.get(item.nodeId);
        if (current === undefined) {
          sums.set(item.nodeId, {
            nodeId: item.nodeId,
            collectionId: item.collectionId,
            title: node.title ?? '',
            opens: item.count,
          });
        } else {
          sums.set(item.nodeId, { ...current, opens: current.opens + item.count });
        }
      }
      return [...sums.values()]
        .sort((left, right) => right.opens - left.opens || (left.nodeId < right.nodeId ? -1 : 1))
        .slice(0, input.limit);
    },
  };
  return { ports: { dashboard }, daily, listDailyCountsCalls };
}

function eligibleIds(
  collections: readonly PublishingInsightsCollectionFacts[],
  ownerSubjectId: string,
): Set<string> {
  return new Set(collections.filter((collection) => (
    collection.ownerSubjectId === ownerSubjectId
    && collection.deletedAt === null
    && (collection.visibility === 'public' || collection.visibility === 'unlisted')
    && typeof collection.publicationSlug === 'string'
    && collection.publicationSlug.length > 0
    && collection.publishedAt !== null
  )).map((collection) => collection.collectionId));
}
