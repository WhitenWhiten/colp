import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  mergeFeedSubscriptions,
  routeMergedFeedEvents,
  type FeedSubscription,
  type MergedFeedRequest,
} from '../../src/feed/client-merge.js';
import type { FeedEvent } from '../../src/types/index.js';

const evidence = 'feed.client-merge';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

interface StandardRouteCase {
  readonly type:
    | 'org.collectionprotocol.collection.created.v1'
    | 'org.collectionprotocol.collection.updated.v1'
    | 'org.collectionprotocol.collection.deleted.v1'
    | 'org.collectionprotocol.release.published.v1'
    | 'org.collectionprotocol.node.created.v1'
    | 'org.collectionprotocol.node.updated.v1'
    | 'org.collectionprotocol.node.moved.v1'
    | 'org.collectionprotocol.node.deleted.v1'
    | 'org.collectionprotocol.annotation.published.v1'
    | 'org.collectionprotocol.access.publication_changed.v1';
  readonly data: (
    collectionId: string,
    fixture: FeedEvent,
  ) => Record<string, unknown>;
}

const collectionData = (collectionId: string): Record<string, unknown> => ({
  collectionId,
  revision: 'revision-1',
  summary: 'Public change summary',
});

const nodeData = (collectionId: string): Record<string, unknown> => ({
  collectionId,
  revision: 'revision-1',
  node: {
    id: 'node-9',
    kind: 'folder',
    title: 'Public folder',
  },
});

const standardRouteCases: readonly StandardRouteCase[] = [
  {
    type: 'org.collectionprotocol.collection.created.v1',
    data: collectionData,
  },
  {
    type: 'org.collectionprotocol.collection.updated.v1',
    data: collectionData,
  },
  {
    type: 'org.collectionprotocol.collection.deleted.v1',
    data: collectionData,
  },
  {
    type: 'org.collectionprotocol.release.published.v1',
    data: (collectionId, fixture) => ({
      ...structuredClone(fixture.data),
      collectionId,
      snapshotUrl: `https://alice.example/collections/c/${collectionId}/releases/release-r_1042/snapshot`,
    }),
  },
  {
    type: 'org.collectionprotocol.node.created.v1',
    data: nodeData,
  },
  {
    type: 'org.collectionprotocol.node.updated.v1',
    data: nodeData,
  },
  {
    type: 'org.collectionprotocol.node.moved.v1',
    data: nodeData,
  },
  {
    type: 'org.collectionprotocol.node.deleted.v1',
    data: (collectionId) => ({
      collectionId,
      revision: 'revision-1',
      nodeId: 'node-9',
      summary: 'Node removed',
    }),
  },
  {
    type: 'org.collectionprotocol.annotation.published.v1',
    data: collectionData,
  },
  {
    type: 'org.collectionprotocol.access.publication_changed.v1',
    data: (collectionId) => ({
      collectionId,
      revision: 'revision-1',
      visibility: 'public',
    }),
  },
];

async function publicFeedEvent(): Promise<FeedEvent> {
  const feed = JSON.parse(await readFile(resolve(fixturesRoot, 'public-feed.json'), 'utf8')) as {
    readonly events: readonly FeedEvent[];
  };
  return structuredClone(feed.events[0]!);
}

function feedEvent(
  fixture: FeedEvent,
  type: string,
  data: Record<string, unknown>,
  id = fixture.id,
): FeedEvent {
  return {
    ...structuredClone(fixture),
    id,
    type,
    data,
  } as unknown as FeedEvent;
}

function eventId(index: number): string {
  return `019b3d0b-efcf-7fa7-9778-${index.toString(16).padStart(12, '0')}`;
}

function requestFor(subscription: FeedSubscription): MergedFeedRequest {
  const result = mergeFeedSubscriptions([subscription]);
  if (!result.ok) throw new Error(`unexpected merge failure: ${result.code}`);
  return result.requests[0]!;
}

describe(`FEED-0009 multi-subscription merge [evidence:${evidence}]`, () => {
  it(`[success] merges multiple collection subscriptions into one instance request [evidence:${evidence}]`, () => {
    const result = mergeFeedSubscriptions([
      { id: 'sub-a', collectionId: 'collection-1' },
      { id: 'sub-b', collectionId: 'collection-2' },
      { id: 'sub-c', collectionId: 'collection-1' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toEqual({
        endpoint: 'instanceFeed',
        filterDigest: null,
        instanceWide: false,
        collectionIds: ['collection-1', 'collection-2'],
        subscriptionIds: ['sub-a', 'sub-b', 'sub-c'],
      });
    }
  });

  it(`[success] instance-wide subscription collapses to full instance read [evidence:${evidence}]`, () => {
    const result = mergeFeedSubscriptions([
      { id: 'sub-a', collectionId: 'collection-1' },
      { id: 'sub-all', collectionId: null },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requests[0]?.instanceWide).toBe(true);
      expect(result.requests[0]?.collectionIds).toEqual([]);
      expect(result.requests[0]?.subscriptionIds).toContain('sub-all');
    }
  });

  it(`[success] star collection id is instance-wide [evidence:${evidence}]`, () => {
    const result = mergeFeedSubscriptions([{ id: 's', collectionId: '*' }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requests[0]?.instanceWide).toBe(true);
  });

  it(`[success] routes the public-feed fixture by data.collectionId [evidence:${evidence}]`, async () => {
    const event = await publicFeedEvent();
    const subscription = {
      id: 'sub-a',
      collectionId: event.data.collectionId,
    };
    const routed = routeMergedFeedEvents([event], subscription, requestFor(subscription));
    expect(routed.map((item) => item.id)).toEqual([event.id]);
    expect(routed[0]?.type).toBe('org.collectionprotocol.release.published.v1');
  });

  it.each(standardRouteCases)(
    `[success] routes standard $type data by its nested collection id [evidence:${evidence}]`,
    async ({ type, data }) => {
      const fixture = await publicFeedEvent();
      const collectionId = fixture.data.collectionId;
      const event = feedEvent(fixture, type, data(collectionId, fixture));

      const subscription = { id: 'sub-standard', collectionId };
      const routed = routeMergedFeedEvents([event], subscription, requestFor(subscription));

      expect(routed).toHaveLength(1);
      expect(routed[0]?.type).toBe(type);
      expect(routed[0]?.data.collectionId).toBe(collectionId);
    },
  );

  it(`[success] routes an HTTPS Extension Event by data.collectionId [evidence:${evidence}]`, async () => {
    const fixture = await publicFeedEvent();
    const collectionId = fixture.data.collectionId;
    const extension = feedEvent(fixture, 'https://vendor.example/events/future.v1', {
      collectionId,
      extensions: {
        'https://vendor.example/ns': { note: 'ok' },
      },
    });

    const subscription = { id: 'sub-extension', collectionId };
    const routed = routeMergedFeedEvents([extension], subscription, requestFor(subscription));

    expect(routed.map((event) => event.id)).toEqual([extension.id]);
    expect(routed[0]?.type).toBe('https://vendor.example/events/future.v1');
  });

  it(`[success] fans out a real multi-Collection page in input order [evidence:${evidence}]`, async () => {
    const fixture = await publicFeedEvent();
    const collectionA = fixture.data.collectionId;
    const collectionB = 'collection-2';
    const events: readonly FeedEvent[] = [
      feedEvent(
        fixture,
        'org.collectionprotocol.node.created.v1',
        nodeData(collectionA),
        eventId(1),
      ),
      feedEvent(
        fixture,
        'https://vendor.example/events/future.v1',
        {
          collectionId: collectionB,
          extensions: { 'https://vendor.example/ns': { note: 'second' } },
        },
        eventId(2),
      ),
      feedEvent(
        fixture,
        'org.collectionprotocol.access.publication_changed.v1',
        {
          collectionId: collectionA,
          revision: 'revision-3',
          visibility: 'public',
        },
        eventId(3),
      ),
      feedEvent(
        fixture,
        'org.collectionprotocol.collection.updated.v1',
        collectionData(collectionB),
        eventId(4),
      ),
    ];

    const subscriptionA = { id: 'sub-a', collectionId: collectionA };
    const subscriptionB = { id: 'sub-b', collectionId: collectionB };
    const routedA = routeMergedFeedEvents(events, subscriptionA, requestFor(subscriptionA));
    const routedB = routeMergedFeedEvents(events, subscriptionB, requestFor(subscriptionB));

    expect(routedA.map((event) => event.id)).toEqual([eventId(1), eventId(3)]);
    expect(routedB.map((event) => event.id)).toEqual([eventId(2), eventId(4)]);
    expect(Object.isFrozen(routedA)).toBe(true);
    expect(Object.isFrozen(routedA[0])).toBe(true);
    expect(Object.isFrozen(routedA[0]?.data)).toBe(true);
    expect(routedA[0]).not.toBe(events[0]);

    const routedSnapshot = JSON.stringify(routedA);
    const callerOwnedData = events[0]!.data as unknown as { node: { title: string } };
    callerOwnedData.node.title = 'Tampered after routing';
    expect(JSON.stringify(routedA)).toBe(routedSnapshot);
  });

  it.each([
    ['missing standard collectionId', 'org.collectionprotocol.collection.updated.v1', {
      revision: 'revision-1',
      summary: 'Missing owner',
    }],
    ['wrong-type standard collectionId', 'org.collectionprotocol.node.deleted.v1', {
      collectionId: 42,
      revision: 'revision-1',
      nodeId: 'node-9',
    }],
    ['missing extension collectionId', 'https://vendor.example/events/future.v1', {
      extensions: { 'https://vendor.example/ns': {} },
    }],
    ['wrong-type extension collectionId', 'https://vendor.example/events/future.v1', {
      collectionId: ['collection-1'],
      extensions: { 'https://vendor.example/ns': {} },
    }],
  ] as const)(
    `[negative] rejects %s for scoped and instance-wide routing [evidence:${evidence}]`,
    async (_name, type, data) => {
      const fixture = await publicFeedEvent();
      const malformed = feedEvent(fixture, type, structuredClone(data));
      const page = [fixture, malformed] as readonly FeedEvent[];

      const scoped = {
        id: 'scoped',
        collectionId: fixture.data.collectionId,
      };
      const instanceWide = { id: 'all', collectionId: null };
      expect(() => routeMergedFeedEvents(page, scoped, requestFor(scoped))).toThrow(TypeError);
      expect(() => routeMergedFeedEvents(
        page,
        instanceWide,
        requestFor(instanceWide),
      )).toThrow(TypeError);
    },
  );

  it.each([
    ['unknown non-HTTPS type', 'org.collectionprotocol.future.v1', collectionData('collection-1')],
    ['invalid standard data shape', 'org.collectionprotocol.node.created.v1', {
      collectionId: 'collection-1',
      revision: 'revision-1',
    }],
    ['excess standard data field', 'org.collectionprotocol.collection.updated.v1', {
      ...collectionData('collection-1'),
      privateKey: 'must-not-pass',
    }],
    ['invalid extension data shape', 'https://vendor.example/events/future.v1', {
      collectionId: 'collection-1',
      revision: 'not-an-extension-field',
      extensions: { 'https://vendor.example/ns': {} },
    }],
  ] as const)(
    `[negative] rejects contract-invalid event: %s [evidence:${evidence}]`,
    async (_name, type, data) => {
      const fixture = await publicFeedEvent();
      const malformed = feedEvent(fixture, type, structuredClone(data));

      const subscription = { id: 'all', collectionId: '*' };
      expect(() => routeMergedFeedEvents(
        [fixture, malformed],
        subscription,
        requestFor(subscription),
      )).toThrow(TypeError);
    },
  );

  it(`[success] instance-wide routing validates then freezes the complete ordered page [evidence:${evidence}]`, async () => {
    const fixture = await publicFeedEvent();
    const events = [
      feedEvent(
        fixture,
        'org.collectionprotocol.collection.created.v1',
        collectionData(fixture.data.collectionId),
        eventId(5),
      ),
      feedEvent(
        fixture,
        'org.collectionprotocol.collection.updated.v1',
        collectionData('collection-2'),
        eventId(6),
      ),
    ];

    const subscription = { id: 'all', collectionId: null };
    const routed = routeMergedFeedEvents(events, subscription, requestFor(subscription));

    expect(routed.map((event) => event.id)).toEqual([eventId(5), eventId(6)]);
    expect(Object.isFrozen(routed)).toBe(true);
    expect(routed.every((event) => Object.isFrozen(event) && Object.isFrozen(event.data))).toBe(true);
  });

  it(`[negative] empty subscriptions rejected [evidence:${evidence}]`, () => {
    expect(mergeFeedSubscriptions([])).toEqual({ ok: false, code: 'empty_subscriptions' });
  });

  it(`[negative] malformed subscriptions fail closed [evidence:${evidence}]`, () => {
    expect(mergeFeedSubscriptions([{ id: '', collectionId: 'c1' }])).toEqual({
      ok: false,
      code: 'malformed_subscription',
    });
    expect(mergeFeedSubscriptions([{ id: 's', collectionId: '' }])).toEqual({
      ok: false,
      code: 'malformed_subscription',
    });
  });

  it(`[boundary] identical duplicate subscriptions collapse without N+1 [evidence:${evidence}]`, () => {
    const result = mergeFeedSubscriptions([
      { id: 'dup', collectionId: 'c1' },
      { id: 'dup', collectionId: 'c1' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requests[0]?.subscriptionIds).toEqual(['dup']);
      expect(result.requests[0]?.collectionIds).toEqual(['c1']);
    }
  });

  it(`[regression] one merged request covers N subscriptions (no per-sub endpoint) [evidence:${evidence}]`, () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `sub-${i}`,
      collectionId: `collection-${i % 5}`,
    }));
    const result = mergeFeedSubscriptions(many);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.endpoint).toBe('instanceFeed');
      expect(result.requests[0]?.subscriptionIds).toHaveLength(25);
      expect(result.requests[0]?.collectionIds).toHaveLength(5);
    }
  });
});
