import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_FEED_COLLECTION_ID_LENGTH,
  MAX_FEED_COLLECTIONS_PER_FILTER_GROUP,
  MAX_FEED_FILTER_DIGEST_LENGTH,
  MAX_FEED_FILTER_GROUPS,
  MAX_FEED_SUBSCRIPTION_ID_LENGTH,
  MAX_FEED_SUBSCRIPTIONS,
  mergeFeedSubscriptions,
  routeMergedFeedEvents,
  type FeedSubscription,
  type MergedFeedRequest,
} from '../../src/feed/client-merge.js';
import type { FeedEvent } from '../../src/types/index.js';

const evidence = 'feed.client-merge';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

function subscription(
  id: string,
  collectionId: string | null,
  filterDigest?: string,
): FeedSubscription {
  return filterDigest === undefined
    ? { id, collectionId }
    : { id, collectionId, filterDigest };
}

function mergedRequests(
  subscriptions: readonly FeedSubscription[],
): readonly MergedFeedRequest[] {
  const result = mergeFeedSubscriptions(subscriptions);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected merge failure: ${result.code}`);
  return result.requests;
}

function largeSubscriptions(count: number): readonly FeedSubscription[] {
  return Array.from({ length: count }, (_unused, index) => subscription(
    `subscription-${index.toString().padStart(5, '0')}`,
    `collection-${index % MAX_FEED_COLLECTIONS_PER_FILTER_GROUP}`,
    'shared-filter',
  ));
}

function performanceSubscriptions(count: number): readonly FeedSubscription[] {
  const commonIdPrefix = 'subscription-'.padEnd(
    MAX_FEED_SUBSCRIPTION_ID_LENGTH - 8,
    'x',
  );
  return Array.from({ length: count }, (_unused, index) => subscription(
    `${commonIdPrefix}${index.toString().padStart(8, '0')}`,
    `collection-${index % MAX_FEED_COLLECTIONS_PER_FILTER_GROUP}`,
    'shared-filter',
  ));
}

function fastestWorkload(
  subscriptions: readonly FeedSubscription[],
  repetitions: number,
  samples = 3,
): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      const result = mergeFeedSubscriptions(subscriptions);
      if (!result.ok) throw new Error(`performance input rejected: ${result.code}`);
    }
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

function trappedProxy<T extends object>(target: T, onTrap: () => never): T {
  return new Proxy(target, {
    get: onTrap,
    getOwnPropertyDescriptor: onTrap,
    getPrototypeOf: onTrap,
    has: onTrap,
    ownKeys: onTrap,
  });
}

async function publicFeedEvent(): Promise<FeedEvent> {
  const feed = JSON.parse(await readFile(resolve(fixturesRoot, 'public-feed.json'), 'utf8')) as {
    readonly events: readonly FeedEvent[];
  };
  return structuredClone(feed.events[0]!);
}

describe(`CFI-009 Feed merge limits and complexity [evidence:${evidence}]`, () => {
  it('publishes fixed, non-input-controlled merge budgets', () => {
    expect({
      subscriptions: MAX_FEED_SUBSCRIPTIONS,
      subscriptionId: MAX_FEED_SUBSCRIPTION_ID_LENGTH,
      collectionId: MAX_FEED_COLLECTION_ID_LENGTH,
      filterDigest: MAX_FEED_FILTER_DIGEST_LENGTH,
      collectionsPerFilter: MAX_FEED_COLLECTIONS_PER_FILTER_GROUP,
      filterGroups: MAX_FEED_FILTER_GROUPS,
    }).toEqual({
      subscriptions: 10_000,
      subscriptionId: 256,
      collectionId: 256,
      filterDigest: 256,
      collectionsPerFilter: 1_000,
      filterGroups: 100,
    });
  });

  it('accepts one subscription and preserves its normalized scope', () => {
    const requests = mergedRequests([subscription('only', 'collection-one')]);

    expect(requests).toEqual([{
      endpoint: 'instanceFeed',
      filterDigest: null,
      collectionIds: ['collection-one'],
      subscriptionIds: ['only'],
      instanceWide: false,
    }]);
  });

  it('accepts the inclusive subscription limit', () => {
    const result = mergeFeedSubscriptions(largeSubscriptions(MAX_FEED_SUBSCRIPTIONS));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.subscriptionIds).toHaveLength(MAX_FEED_SUBSCRIPTIONS);
      expect(result.requests[0]?.collectionIds).toHaveLength(
        MAX_FEED_COLLECTIONS_PER_FILTER_GROUP,
      );
    }
  });

  it('rejects the subscription limit plus one before planning', () => {
    expect(mergeFeedSubscriptions(
      largeSubscriptions(MAX_FEED_SUBSCRIPTIONS + 1),
    )).toEqual({ ok: false, code: 'too_many_subscriptions' });
  });

  it('has a stable near-limit linear-growth performance baseline', () => {
    const nearLimitCount = MAX_FEED_SUBSCRIPTIONS - 100;
    const eighthCount = Math.floor(nearLimitCount / 8);
    const nearLimit = performanceSubscriptions(nearLimitCount);
    const eighth = nearLimit.slice(0, eighthCount);

    // Warm descriptor checks and JIT paths before comparing equal total item counts.
    mergeFeedSubscriptions(nearLimit.slice(0, 1_000));
    const eighthWorkloadMs = fastestWorkload(eighth, 8);
    const nearLimitWorkloadMs = fastestWorkload(nearLimit, 1);

    expect(nearLimitWorkloadMs).toBeLessThan(2_000);
    expect(nearLimitWorkloadMs / Math.max(eighthWorkloadMs, 0.01)).toBeLessThan(3);
  });
});

describe(`CFI-009 Feed merge identity and grouping [evidence:${evidence}]`, () => {
  it('folds the same id only when its normalized Collection and filter scope match', () => {
    const requests = mergedRequests([
      subscription('duplicate', 'collection-a', 'filter-a'),
      subscription('duplicate', 'collection-a', 'filter-a'),
    ]);

    expect(requests).toEqual([{
      endpoint: 'instanceFeed',
      filterDigest: 'filter-a',
      collectionIds: ['collection-a'],
      subscriptionIds: ['duplicate'],
      instanceWide: false,
    }]);
  });

  it('normalizes null and star as the same instance-wide Collection scope', () => {
    const requests = mergedRequests([
      subscription('instance', null, 'filter-a'),
      subscription('instance', '*', 'filter-a'),
    ]);

    expect(requests[0]).toMatchObject({
      filterDigest: 'filter-a',
      collectionIds: [],
      subscriptionIds: ['instance'],
      instanceWide: true,
    });
  });

  it('normalizes a missing and explicit undefined filter as the same null group', () => {
    const explicitUndefined = {
      id: 'same',
      collectionId: 'collection-a',
      filterDigest: undefined,
    } as unknown as FeedSubscription;
    const requests = mergedRequests([
      subscription('same', 'collection-a'),
      explicitUndefined,
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      filterDigest: null,
      subscriptionIds: ['same'],
    });
  });

  it.each([
    [
      'Collection',
      subscription('conflict', 'collection-a', 'filter-a'),
      subscription('conflict', 'collection-b', 'filter-a'),
    ],
    [
      'filter',
      subscription('conflict', 'collection-a', 'filter-a'),
      subscription('conflict', 'collection-a', 'filter-b'),
    ],
    [
      'missing versus present filter',
      subscription('conflict', 'collection-a'),
      subscription('conflict', 'collection-a', 'filter-a'),
    ],
  ] as const)('rejects a duplicate id with conflicting %s scope', (_label, first, second) => {
    expect(mergeFeedSubscriptions([first, second])).toEqual({
      ok: false,
      code: 'conflicting_subscription_id',
    });
  });

  it('groups different ids by server filter with deterministic, frozen requests', () => {
    const result = mergeFeedSubscriptions([
      subscription('z-first', 'collection-z', 'filter-z'),
      subscription('none-first', 'collection-b'),
      subscription('z-all', null, 'filter-z'),
      subscription('a-first', 'collection-c', 'filter-a'),
      subscription('none-second', 'collection-a'),
      subscription('z-last', 'collection-a', 'filter-z'),
      subscription('a-second', 'collection-b', 'filter-a'),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests).toEqual([
      {
        endpoint: 'instanceFeed',
        filterDigest: 'filter-z',
        collectionIds: [],
        subscriptionIds: ['z-first', 'z-all', 'z-last'],
        instanceWide: true,
      },
      {
        endpoint: 'instanceFeed',
        filterDigest: null,
        collectionIds: ['collection-a', 'collection-b'],
        subscriptionIds: ['none-first', 'none-second'],
        instanceWide: false,
      },
      {
        endpoint: 'instanceFeed',
        filterDigest: 'filter-a',
        collectionIds: ['collection-b', 'collection-c'],
        subscriptionIds: ['a-first', 'a-second'],
        instanceWide: false,
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.requests)).toBe(true);
    for (const request of result.requests) {
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.collectionIds)).toBe(true);
      expect(Object.isFrozen(request.subscriptionIds)).toBe(true);
    }
  });

  it('keeps instance-wide behavior local to its filter group', () => {
    const requests = mergedRequests([
      subscription('all-red', '*', 'red'),
      subscription('blue-b', 'collection-b', 'blue'),
      subscription('blue-a', 'collection-a', 'blue'),
    ]);

    expect(requests[0]).toMatchObject({
      filterDigest: 'red',
      instanceWide: true,
      collectionIds: [],
    });
    expect(requests[1]).toMatchObject({
      filterDigest: 'blue',
      instanceWide: false,
      collectionIds: ['collection-a', 'collection-b'],
    });
  });
});

describe(`CFI-009 Feed merge scalar and cardinality budgets [evidence:${evidence}]`, () => {
  it('accepts each scalar length limit', () => {
    const requests = mergedRequests([subscription(
      's'.repeat(MAX_FEED_SUBSCRIPTION_ID_LENGTH),
      'c'.repeat(MAX_FEED_COLLECTION_ID_LENGTH),
      'f'.repeat(MAX_FEED_FILTER_DIGEST_LENGTH),
    )]);

    expect(requests[0]?.subscriptionIds[0]).toHaveLength(MAX_FEED_SUBSCRIPTION_ID_LENGTH);
    expect(requests[0]?.collectionIds[0]).toHaveLength(MAX_FEED_COLLECTION_ID_LENGTH);
    expect(requests[0]?.filterDigest).toHaveLength(MAX_FEED_FILTER_DIGEST_LENGTH);
  });

  it.each([
    ['subscription id', subscription(
      's'.repeat(MAX_FEED_SUBSCRIPTION_ID_LENGTH + 1),
      'collection',
    )],
    ['Collection id', subscription(
      'subscription',
      'c'.repeat(MAX_FEED_COLLECTION_ID_LENGTH + 1),
    )],
    ['filter digest', subscription(
      'subscription',
      'collection',
      'f'.repeat(MAX_FEED_FILTER_DIGEST_LENGTH + 1),
    )],
  ] as const)('rejects an overlong %s', (_label, item) => {
    expect(mergeFeedSubscriptions([item])).toEqual({
      ok: false,
      code: 'malformed_subscription',
    });
  });

  it('rejects an empty filter digest', () => {
    expect(mergeFeedSubscriptions([
      subscription('subscription', 'collection', ''),
    ])).toEqual({ ok: false, code: 'malformed_subscription' });
  });

  it('accepts the distinct Collection limit within one filter group', () => {
    const items = Array.from(
      { length: MAX_FEED_COLLECTIONS_PER_FILTER_GROUP },
      (_unused, index) => subscription(`sub-${index}`, `collection-${index}`, 'filter'),
    );

    const requests = mergedRequests(items);
    expect(requests[0]?.collectionIds).toHaveLength(MAX_FEED_COLLECTIONS_PER_FILTER_GROUP);
  });

  it('rejects the distinct Collection limit plus one within one filter group', () => {
    const items = Array.from(
      { length: MAX_FEED_COLLECTIONS_PER_FILTER_GROUP + 1 },
      (_unused, index) => subscription(`sub-${index}`, `collection-${index}`, 'filter'),
    );

    expect(mergeFeedSubscriptions(items)).toEqual({
      ok: false,
      code: 'too_many_collections',
    });
  });

  it('accepts the distinct filter group limit', () => {
    const items = Array.from(
      { length: MAX_FEED_FILTER_GROUPS },
      (_unused, index) => subscription(`sub-${index}`, 'collection', `filter-${index}`),
    );

    expect(mergedRequests(items)).toHaveLength(MAX_FEED_FILTER_GROUPS);
  });

  it('rejects the distinct filter group limit plus one', () => {
    const items = Array.from(
      { length: MAX_FEED_FILTER_GROUPS + 1 },
      (_unused, index) => subscription(`sub-${index}`, 'collection', `filter-${index}`),
    );

    expect(mergeFeedSubscriptions(items)).toEqual({
      ok: false,
      code: 'too_many_filter_groups',
    });
  });
});

describe(`CFI-009 hostile subscription input boundary [evidence:${evidence}]`, () => {
  it('rejects an array Proxy without invoking any trap', () => {
    let traps = 0;
    const hostile = trappedProxy([subscription('sub', 'collection')], () => {
      traps += 1;
      throw new Error('array trap must not run');
    });

    expect(() => mergeFeedSubscriptions(hostile)).toThrow(TypeError);
    expect(traps).toBe(0);
  });

  it('rejects an element Proxy without invoking any trap', () => {
    let traps = 0;
    const hostile = trappedProxy({ id: 'sub', collectionId: 'collection' }, () => {
      traps += 1;
      throw new Error('element trap must not run');
    });

    expect(mergeFeedSubscriptions([hostile])).toEqual({
      ok: false,
      code: 'malformed_subscription',
    });
    expect(traps).toBe(0);
  });

  it('rejects an accessor element without invoking its getter', () => {
    let getters = 0;
    const hostile = { collectionId: 'collection' } as Record<string, unknown>;
    Object.defineProperty(hostile, 'id', {
      enumerable: true,
      get() {
        getters += 1;
        return 'sub';
      },
    });

    expect(mergeFeedSubscriptions([hostile as unknown as FeedSubscription])).toEqual({
      ok: false,
      code: 'malformed_subscription',
    });
    expect(getters).toBe(0);
  });

  it.each([
    ['unknown field', { id: 'sub', collectionId: 'collection', unknown: true }],
    ['symbol key', { id: 'sub', collectionId: 'collection', [Symbol('hidden')]: true }],
    ['symbol value', { id: 'sub', collectionId: 'collection', filterDigest: Symbol('filter') }],
  ])('rejects an element with an %s', (_label, hostile) => {
    expect(mergeFeedSubscriptions([hostile as unknown as FeedSubscription])).toEqual({
      ok: false,
      code: 'malformed_subscription',
    });
  });

  it('rejects non-enumerable input state', () => {
    const hostile = subscription('sub', 'collection') as FeedSubscription & {
      hidden?: boolean;
    };
    Object.defineProperty(hostile, 'hidden', {
      enumerable: false,
      value: true,
    });

    expect(mergeFeedSubscriptions([hostile])).toEqual({
      ok: false,
      code: 'malformed_subscription',
    });
  });

  it.each([
    ['sparse array', new Array<FeedSubscription>(1)],
    ['symbol array property', Object.assign([subscription('sub', 'collection')], {
      [Symbol('hidden')]: true,
    })],
    ['unknown array property', Object.assign([subscription('sub', 'collection')], {
      unknown: true,
    })],
  ] as const)('rejects a structurally abnormal %s', (_label, hostile) => {
    expect(() => mergeFeedSubscriptions(hostile)).toThrow(TypeError);
  });

  it('rejects an accessor array slot without invoking its getter', () => {
    let getters = 0;
    const hostile: FeedSubscription[] = [];
    Object.defineProperty(hostile, '0', {
      enumerable: true,
      get() {
        getters += 1;
        return subscription('sub', 'collection');
      },
    });
    Object.defineProperty(hostile, 'length', { value: 1 });

    expect(() => mergeFeedSubscriptions(hostile)).toThrow(TypeError);
    expect(getters).toBe(0);
  });

  it('rejects a non-enumerable array property', () => {
    const hostile = [subscription('sub', 'collection')];
    Object.defineProperty(hostile, 'hidden', {
      enumerable: false,
      value: true,
    });

    expect(() => mergeFeedSubscriptions(hostile)).toThrow(TypeError);
  });
});

describe(`CFI-009 filter-bound fan-out [evidence:${evidence}]`, () => {
  it('rejects a field-identical clone of an issued request capability', async () => {
    const event = await publicFeedEvent();
    const item = subscription('sub', event.data.collectionId, 'filter');
    const request = mergedRequests([item])[0]!;
    const forgedClone = {
      endpoint: request.endpoint,
      filterDigest: request.filterDigest,
      collectionIds: request.collectionIds,
      subscriptionIds: request.subscriptionIds,
      instanceWide: request.instanceWide,
    } as MergedFeedRequest;

    expect(forgedClone).toEqual(request);
    expect(() => routeMergedFeedEvents([event], item, forgedClone)).toThrow(
      'request must be an issued Feed merge request',
    );
  });

  it('routes a server-filtered page only through its matching request group', async () => {
    const event = await publicFeedEvent();
    const red = subscription('red-sub', event.data.collectionId, 'red-filter');
    const blue = subscription('blue-sub', event.data.collectionId, 'blue-filter');
    const requests = mergedRequests([red, blue]);

    const routedRed = routeMergedFeedEvents([event], red, requests[0]!);
    const routedBlue = routeMergedFeedEvents([event], blue, requests[1]!);

    expect(routedRed.map((item) => item.id)).toEqual([event.id]);
    expect(routedBlue.map((item) => item.id)).toEqual([event.id]);
    expect(() => routeMergedFeedEvents([event], red, requests[1]!)).toThrow(TypeError);
    expect(() => routeMergedFeedEvents([event], blue, requests[0]!)).toThrow(TypeError);
  });

  it('rejects a request group that does not contain the subscription id', async () => {
    const event = await publicFeedEvent();
    const first = subscription('first', event.data.collectionId, 'shared-filter');
    const second = subscription('second', event.data.collectionId, 'shared-filter');
    const firstRequest = mergedRequests([first])[0]!;

    expect(() => routeMergedFeedEvents([event], second, firstRequest)).toThrow(TypeError);
  });

  it('rejects a same-id and same-filter group for the wrong Collection scope', async () => {
    const event = await publicFeedEvent();
    const item = subscription('sub', event.data.collectionId, 'shared-filter');
    const request = mergedRequests([item])[0]!;
    const wrongCollection = {
      ...request,
      collectionIds: ['another-collection'],
    };

    expect(() => routeMergedFeedEvents([event], item, wrongCollection)).toThrow(TypeError);
  });

  it('normalizes an omitted subscription filter to the null request group', async () => {
    const event = await publicFeedEvent();
    const unfiltered = subscription('unfiltered', event.data.collectionId);
    const request = mergedRequests([unfiltered])[0]!;

    expect(request.filterDigest).toBeNull();
    expect(routeMergedFeedEvents([event], unfiltered, request)).toHaveLength(1);
    expect(() => routeMergedFeedEvents(
      [event],
      { ...unfiltered, filterDigest: 'other' },
      request,
    )).toThrow(TypeError);
  });

  it('rejects hostile request and subscription records with zero trap/getter calls', async () => {
    const event = await publicFeedEvent();
    const validSubscription = subscription('sub', event.data.collectionId, 'filter');
    const request = mergedRequests([validSubscription])[0]!;
    let traps = 0;
    const trap = (): never => {
      traps += 1;
      throw new Error('trap must not run');
    };
    const requestProxy = trappedProxy({ ...request }, trap);
    const subscriptionProxy = trappedProxy({ ...validSubscription }, trap);
    const eventArrayProxy = trappedProxy([event], trap);
    const collectionIdsProxy = trappedProxy([...request.collectionIds], trap);

    expect(() => routeMergedFeedEvents(
      [event],
      validSubscription,
      requestProxy,
    )).toThrow(TypeError);
    expect(() => routeMergedFeedEvents(
      [event],
      subscriptionProxy,
      request,
    )).toThrow(TypeError);
    expect(() => routeMergedFeedEvents(
      eventArrayProxy,
      validSubscription,
      request,
    )).toThrow(TypeError);
    expect(() => routeMergedFeedEvents(
      [event],
      validSubscription,
      { ...request, collectionIds: collectionIdsProxy },
    )).toThrow(TypeError);
    expect(traps).toBe(0);

    let getters = 0;
    const requestAccessor = { ...request } as Record<string, unknown>;
    Object.defineProperty(requestAccessor, 'filterDigest', {
      enumerable: true,
      get() {
        getters += 1;
        return 'filter';
      },
    });
    expect(() => routeMergedFeedEvents(
      [event],
      validSubscription,
      requestAccessor as unknown as MergedFeedRequest,
    )).toThrow(TypeError);
    expect(getters).toBe(0);
  });

  it.each([
    ['unknown field', (request: MergedFeedRequest) => ({ ...request, unknown: true })],
    ['symbol key', (request: MergedFeedRequest) => ({
      ...request,
      [Symbol('hidden')]: true,
    })],
    ['sparse subscriptionIds', (request: MergedFeedRequest) => ({
      ...request,
      subscriptionIds: new Array<string>(1),
    })],
    ['proxied collectionIds', (request: MergedFeedRequest) => ({
      ...request,
      collectionIds: new Proxy([...request.collectionIds], {}),
    })],
  ] as const)('rejects a request with %s', async (_label, mutate) => {
    const event = await publicFeedEvent();
    const item = subscription('sub', event.data.collectionId, 'filter');
    const request = mergedRequests([item])[0]!;

    expect(() => routeMergedFeedEvents(
      [event],
      item,
      mutate(request) as MergedFeedRequest,
    )).toThrow(TypeError);
  });

  it('rejects non-enumerable request state', async () => {
    const event = await publicFeedEvent();
    const item = subscription('sub', event.data.collectionId, 'filter');
    const request = { ...mergedRequests([item])[0]! } as MergedFeedRequest & {
      hidden?: boolean;
    };
    Object.defineProperty(request, 'hidden', {
      enumerable: false,
      value: true,
    });

    expect(() => routeMergedFeedEvents(
      [event],
      item,
      request,
    )).toThrow(TypeError);
  });
});
