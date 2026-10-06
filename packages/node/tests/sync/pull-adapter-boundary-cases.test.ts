import { describe, expect, it } from 'vitest';

import {
  rejectPrivateOrLocalSnapshotUrl,
  withRecommendedSnapshotUrlHostPolicy,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventStore,
  type SyncPullRequestContext,
} from '../../src/sync/index.js';
import {
  coordinateSyncPull,
} from '../../src/sync/unsafe.js';

const coverage = '[coverage:sync-completion]';

function request(overrides: Partial<SyncPullRequestContext> = {}): SyncPullRequestContext {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    cursor: 'cursor-start',
    limit: 2,
    ...overrides,
  };
}

function record(overrides: Partial<SyncPullCursorRecord> = {}): SyncPullCursorRecord {
  return {
    cursor: 'cursor-start',
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    commitOrdinal: '100',
    state: 'active',
    ...overrides,
  };
}

function page(overrides: Partial<SyncPullEventPage> = {}): SyncPullEventPage {
  return {
    entries: [],
    hasMore: false,
    collectionRevision: 'revision-1',
    recommendedPullAfterSeconds: 0,
    ...overrides,
  };
}

class CursorStore implements SyncPullCursorStore {
  constructor(private readonly value: unknown) {}

  async resolveCursor(): Promise<SyncPullCursorRecord | null> {
    return this.value as SyncPullCursorRecord | null;
  }
}

class EventStore implements SyncPullEventStore {
  constructor(private readonly value: unknown) {}

  async readCommittedAfter(): Promise<SyncPullEventPage> {
    return this.value as SyncPullEventPage;
  }
}

describe(`Sync coverage boundary completion ${coverage}`, () => {
  it(`rejects malformed requests and URL options before touching stores ${coverage}`, async () => {
    const stores = [new CursorStore(record()), new EventStore(page())] as const;
    for (const candidate of [null, [], { ...request(), principal: { type: 'unknown', id: 'alice' } }, { ...request(), extra: true }]) {
      await expect(coordinateSyncPull(candidate as never, ...stores)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(coordinateSyncPull({ ...request(), limit: 0 }, ...stores)).rejects.toBeInstanceOf(RangeError);
    for (const options of [null, [], { allowInsecureSnapshotUrl: 'yes' }, { assertSnapshotUrlSafe: 'not-a-function' }, { extra: true }]) {
      await expect(coordinateSyncPull(request(), ...stores, options as never)).rejects.toBeInstanceOf(TypeError);
    }
  });

  it(`rejects malformed starting Cursor records and states ${coverage}`, async () => {
    const invalidRecords: unknown[] = [
      null,
      [],
      { ...record(), state: 'retired' },
      { ...record(), principal: { type: 'bad', id: 'alice' } },
      { ...record(), injected: true },
    ];
    for (const [index, value] of invalidRecords.entries()) {
      const operation = coordinateSyncPull(request(), new CursorStore(value), new EventStore(page()));
      if (index === 0 || index === 1 || index === 3) {
        await expect(operation).resolves.toMatchObject({ ok: false, status: 400 });
      } else {
        await expect(operation).rejects.toBeInstanceOf(TypeError);
      }
    }
  });

  it(`rejects malformed pages, Cursor records, and event payloads ${coverage}`, async () => {
    const start = record();
    const malformedPages: unknown[] = [
      { ...page(), hasMore: true },
      { ...page(), entries: [null] },
      { ...page(), entries: [{ bad: true }] },
      { ...page(), entries: [{ commitOrdinal: '101', event: { cursor: 'cursor-next', kind: 'unknown' } }] },
      { ...page(), entries: [{ commitOrdinal: '101', event: { cursor: 'cursor-next', kind: 'operation' } }] },
      { ...page(), entries: [{ commitOrdinal: '101', event: { cursor: 'cursor-next', kind: 'conflict' } }] },
    ];
    for (const malformed of malformedPages) {
      const cursorStore: SyncPullCursorStore = {
        resolveCursor: async (cursor) => cursor === 'cursor-next'
          ? record({ cursor: 'cursor-next', commitOrdinal: '101' })
          : start,
      };
      await expect(coordinateSyncPull(request(), cursorStore, new EventStore(malformed))).rejects.toBeInstanceOf(TypeError);
    }

    const missingEventCursor: SyncPullCursorStore = {
      resolveCursor: async (cursor) => cursor === start.cursor ? start : null,
    };
    await expect(coordinateSyncPull(request(), missingEventCursor, new EventStore(page({
      entries: [{ commitOrdinal: '101', event: { cursor: 'cursor-next', kind: 'operation', operation: {} as never } }],
    })))).rejects.toThrow(new TypeError('Committed Sync Pull event has no durable Cursor record.'));
  });

  it(`rejects malformed durable records for committed event Cursors ${coverage}`, async () => {
    const cursorStore: SyncPullCursorStore = {
      resolveCursor: async (cursor) => cursor === 'cursor-next'
        ? [] as never
        : record(),
    };
    const eventStore = new EventStore(page({
      entries: [{
        commitOrdinal: '101',
        event: { cursor: 'cursor-next', kind: 'conflict', conflict: {} as never },
      }],
    }));
    await expect(coordinateSyncPull(request(), cursorStore, eventStore))
      .rejects.toThrow(/invalid record/i);
  });

  it(`normalizes 0.2 effect-page discovery and validates the final response ${coverage}`, async () => {
    const authority = 'https://sync.example';
    const template = `${authority}/effects/{effectId}/pages/{pageNumber}`;
    const candidate = request({
      protocolVersion: '0.2',
      effectPageAuthority: authority,
      effectPageTemplate: template,
    });
    const cursor = new CursorStore(record({ protocolVersion: '0.2' }));
    await expect(coordinateSyncPull(candidate, cursor, new EventStore(page())))
      .resolves.toMatchObject({ ok: true, status: 200 });
    await expect(coordinateSyncPull(candidate, cursor, new EventStore(page({
      collectionRevision: 'bad revision?',
    })))).rejects.toThrow(/invalid for COLP 0\.2/i);
  });

  it(`covers private/local IPv6 and special IPv4 host forms ${coverage}`, () => {
    for (const host of [
      '::', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1',
      '::ffff:192.168.1.1', '0.0.0.0', '172.31.0.1', '169.254.1.1',
    ]) {
      const url = new URL('https://example.test/x');
      Object.defineProperty(url, 'hostname', { value: host });
      expect(() => rejectPrivateOrLocalSnapshotUrl(url)).toThrow(TypeError);
    }
    expect(() => rejectPrivateOrLocalSnapshotUrl({} as never)).toThrow(TypeError);
    expect(withRecommendedSnapshotUrlHostPolicy({ allowInsecureSnapshotUrl: true })).toMatchObject({
      allowInsecureSnapshotUrl: true,
      assertSnapshotUrlSafe: rejectPrivateOrLocalSnapshotUrl,
    });
  });
});
