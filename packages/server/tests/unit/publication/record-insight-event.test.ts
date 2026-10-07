import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  InsightConcealError,
  InsightEventCardinalityError,
  recordInsightEvent,
  type InsightEventType,
  type PublicationInsightCollectionFacts,
  type PublicationInsightFactsPort,
  type PublicationInsightStore,
  type RecordInsightEventInput,
  type RecordInsightEventPorts,
  type VisitorHashPort,
} from '../../../src/modules/publication/index.js';

const OCCURRED_AT = new Date('2026-08-18T12:00:00.000Z');
const HASH = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const PUBLIC_FACTS: PublicationInsightCollectionFacts = {
  collectionId: 'col-public',
  ownerSubjectId: 'owner-1',
  visibility: 'public',
  publicationSlug: 'public-notes',
  deletedAt: null,
};

describe('recordInsightEvent', () => {
  test('skips owner self-view without writing', async () => {
    const memory = createMemory();
    const result = await recordInsightEvent(memory.ports, input({
      visitor: { kind: 'subject', subjectId: 'owner-1' },
    }));
    assert.deepEqual(result, { kind: 'skipped', reason: 'owner' });
    assert.equal(memory.store.events.length, 0);
    assert.equal(memory.store.increments.length, 0);
    assert.equal(memory.store.purges.length, 0);
  });

  test('conceals private collections without writing', async () => {
    const memory = createMemory({
      collections: {
        'private-notes': {
          collectionId: 'col-private',
          ownerSubjectId: 'owner-1',
          visibility: 'private',
          publicationSlug: 'private-notes',
          deletedAt: null,
        },
      },
    });
    await assertConceal(memory, input({ slug: 'private-notes' }));
  });

  test('conceals protected, deleted, unpublished, and missing collections', async () => {
    const memory = createMemory({
      collections: {
        'protected-notes': {
          collectionId: 'col-protected',
          ownerSubjectId: 'owner-1',
          visibility: 'protected',
          publicationSlug: 'protected-notes',
          deletedAt: null,
        },
        'deleted-notes': {
          collectionId: 'col-deleted',
          ownerSubjectId: 'owner-1',
          visibility: 'public',
          publicationSlug: 'deleted-notes',
          deletedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
        'ghost-notes': {
          collectionId: 'col-ghost',
          ownerSubjectId: 'owner-1',
          visibility: 'public',
          publicationSlug: null,
          deletedAt: null,
        },
      },
    });
    await assertConceal(memory, input({ slug: 'protected-notes' }));
    await assertConceal(memory, input({ slug: 'deleted-notes' }));
    await assertConceal(memory, input({ slug: 'ghost-notes' }));
    await assertConceal(memory, input({ slug: 'missing-notes' }));
  });

  test('skips folder, root, and illegal resource_open nodes without writing', async () => {
    const memory = createMemory({
      liveBookmarks: ['col-public\0bm-live'],
    });
    for (const nodeId of ['folder-1', 'root-public', 'bm-other', 'bm-missing']) {
      const result = await recordInsightEvent(memory.ports, input({
        eventType: 'resource_open',
        nodeId,
      }));
      assert.deepEqual(result, { kind: 'skipped', reason: 'node' }, nodeId);
    }
    assert.equal(memory.store.events.length, 0);
    assert.equal(memory.store.increments.length, 0);
    assert.equal(memory.store.purges.length, 0);
  });

  test('throws on event type / node_id cardinality mismatch', async () => {
    const memory = createMemory();
    await assert.rejects(
      () => recordInsightEvent(memory.ports, input({ eventType: 'resource_open' })),
      (error: unknown) => error instanceof InsightEventCardinalityError,
    );
    await assert.rejects(
      () => recordInsightEvent(memory.ports, input({ eventType: 'collection_view', nodeId: 'bm-live' })),
      (error: unknown) => error instanceof InsightEventCardinalityError,
    );
    await assert.rejects(
      () => recordInsightEvent(memory.ports, input({ eventType: 'preview_open', nodeId: 'bm-live' })),
      (error: unknown) => error instanceof InsightEventCardinalityError,
    );
    await assert.rejects(
      () => recordInsightEvent(memory.ports, input({
        eventType: 'page_view' as InsightEventType,
      })),
      (error: unknown) => error instanceof InsightEventCardinalityError,
    );
    assert.equal(memory.facts.loads, 0);
    assert.equal(memory.store.events.length, 0);
  });

  test('writes a public collection_view without purging expired rows', async () => {
    const memory = createMemory();
    const result = await recordInsightEvent(memory.ports, input());
    assert.deepEqual(result, { kind: 'written' });
    assert.equal(memory.store.events.length, 1);
    assert.equal(memory.store.events[0]?.eventType, 'collection_view');
    assert.equal(memory.store.events[0]?.nodeId, null);
    assert.equal(memory.store.events[0]?.collectionId, 'col-public');
    assert.deepEqual(memory.store.events[0]?.visitorHash, HASH);
    assert.equal(memory.store.increments.length, 1);
    assert.equal(memory.store.increments[0]?.nodeId, null);
    assert.deepEqual(memory.store.purges, []);
  });

  test('counts editor and anonymous visitors on unlisted collections', async () => {
    const memory = createMemory({
      collections: {
        'unlisted-notes': {
          collectionId: 'col-unlisted',
          ownerSubjectId: 'owner-1',
          visibility: 'unlisted',
          publicationSlug: 'unlisted-notes',
          deletedAt: null,
        },
      },
      liveBookmarks: ['col-unlisted\0bm-live'],
    });
    const editor = await recordInsightEvent(memory.ports, input({
      slug: 'unlisted-notes',
      visitor: { kind: 'subject', subjectId: 'editor-9' },
    }));
    const anonymous = await recordInsightEvent(memory.ports, input({
      slug: 'unlisted-notes',
      eventType: 'preview_open',
      visitor: { kind: 'anonymous', cookie: 'cookie-2' },
    }));
    const resource = await recordInsightEvent(memory.ports, input({
      slug: 'unlisted-notes',
      eventType: 'resource_open',
      nodeId: 'bm-live',
    }));
    assert.deepEqual([editor, anonymous, resource], [
      { kind: 'written' },
      { kind: 'written' },
      { kind: 'written' },
    ]);
    assert.equal(memory.store.events.length, 3);
    assert.equal(memory.store.purges.length, 0);
  });
});

interface MemoryOptions {
  readonly collections?: Readonly<Record<string, PublicationInsightCollectionFacts>>;
  readonly liveBookmarks?: readonly string[];
}

function createMemory(options: MemoryOptions = {}): {
  readonly ports: RecordInsightEventPorts;
  readonly facts: { loads: number };
  readonly store: {
    readonly events: Array<{
      readonly eventType: InsightEventType;
      readonly nodeId: string | null;
      readonly collectionId: string;
      readonly visitorHash: Uint8Array;
    }>;
    readonly increments: Array<{ readonly nodeId: string | null }>;
    readonly purges: Array<{ readonly now: Date; readonly limit?: number }>;
  };
} {
  const collections = new Map(Object.entries(options.collections ?? {
    'public-notes': PUBLIC_FACTS,
  }));
  const liveBookmarks = new Set(options.liveBookmarks ?? []);
  const factsState = { loads: 0 };
  const storeState = {
    events: [] as Array<{
      eventType: InsightEventType;
      nodeId: string | null;
      collectionId: string;
      visitorHash: Uint8Array;
    }>,
    increments: [] as Array<{ nodeId: string | null }>,
    purges: [] as Array<{ now: Date; limit?: number }>,
  };
  const facts: PublicationInsightFactsPort = {
    async loadBySlug(slug) {
      factsState.loads += 1;
      return collections.get(slug) ?? null;
    },
    async liveBookmarkExists(collectionId, nodeId) {
      return liveBookmarks.has(`${collectionId}\0${nodeId}`);
    },
  };
  const store: PublicationInsightStore = {
    async insertEvent(event) {
      storeState.events.push({
        eventType: event.eventType,
        nodeId: event.nodeId,
        collectionId: event.collectionId,
        visitorHash: event.visitorHash,
      });
    },
    async incrementDaily(daily) {
      storeState.increments.push({ nodeId: daily.nodeId });
    },
    async purgeExpired(now, limit) {
      storeState.purges.push({ now, limit });
      return { events: 0, daily: 0 };
    },
  };
  const visitorHash: VisitorHashPort = {
    hashAnonymous() { return HASH; },
    hashSubject() { return HASH; },
  };
  return {
    ports: { facts, store, visitorHash },
    facts: factsState,
    store: storeState,
  };
}

function input(overrides: Partial<RecordInsightEventInput> = {}): RecordInsightEventInput {
  return {
    slug: 'public-notes',
    eventType: 'collection_view',
    visitor: { kind: 'anonymous', cookie: 'cookie-1' },
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

async function assertConceal(
  memory: ReturnType<typeof createMemory>,
  recordInput: RecordInsightEventInput,
): Promise<void> {
  const events = memory.store.events.length;
  const increments = memory.store.increments.length;
  const purges = memory.store.purges.length;
  await assert.rejects(
    () => recordInsightEvent(memory.ports, recordInput),
    (error: unknown) => {
      assert.ok(error instanceof InsightConcealError);
      assert.equal(error.code, 'conceal');
      return true;
    },
  );
  assert.equal(memory.store.events.length, events);
  assert.equal(memory.store.increments.length, increments);
  assert.equal(memory.store.purges.length, purges);
}
