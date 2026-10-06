/**
 * Batch event-cursor resolution through the public host: a full page uses a
 * bounded number of Cursor store calls, malformed batch answers fail closed,
 * and the sequential `resolveCursor` fallback keeps working.
 */
import { describe, expect, it } from 'vitest';

import { legacyPullOperation } from '../support/legacy-pull-fixtures.js';
import { alice, verifiedSession } from './verified-session-fixture.js';
import {
  createSyncHost,
  SYNC_PULL_MAX_LIMIT,
  type SyncPullCommittedEvent,
  type SyncPullCursorHandoffRequest,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullRequestContext,
} from '../../src/sync/index.js';

function record(cursor: string, sessionId: string, commitOrdinal: string): SyncPullCursorRecord {
  return {
    cursor, sessionId, principal: alice, collectionId: 'collection-1', protocolVersion: '0.1',
    commitOrdinal, state: 'active',
  };
}

/** Durable model with a batch lookup and call counters. */
class BatchBackend implements SyncPullCursorStore, SyncPullEventStore {
  readonly cursors = new Map<string, SyncPullCursorRecord>();
  readonly log: SyncPullCommittedEvent[] = [];
  singleCalls = 0;
  batchCalls: string[][] = [];
  eventReads = 0;
  lineage = new Map<string, string>();

  async resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null> {
    this.singleCalls += 1;
    return structuredClone(this.cursors.get(cursor) ?? null);
  }

  async resolveCursors(cursors: readonly string[]): Promise<readonly SyncPullCursorRecord[]> {
    this.batchCalls.push([...cursors]);
    return cursors.flatMap(cursor => {
      const found = this.cursors.get(cursor);
      return found === undefined ? [] : [structuredClone(found)];
    });
  }

  async authorizeCursorHandoff(request: SyncPullCursorHandoffRequest) {
    if (this.lineage.get(request.fromSessionId) !== request.toSessionId) return null;
    const { cursor, fromSessionId, toSessionId, commitOrdinal } = request;
    return { cursor, fromSessionId, toSessionId, commitOrdinal };
  }

  async readCommittedAfter(request: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    this.eventReads += 1;
    const after = BigInt(request.afterCommitOrdinal);
    const matching = this.log.filter(entry => BigInt(entry.commitOrdinal) > after);
    return structuredClone({
      entries: matching.slice(0, request.limit), hasMore: matching.length > request.limit,
      collectionRevision: 'revision-1', recommendedPullAfterSeconds: 30,
    });
  }

  seed(count: number, sessionId = 'session-1'): void {
    this.cursors.set('start', record('start', sessionId, '0'));
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const cursor = `event-${ordinal}`;
      this.log.push({
        commitOrdinal: String(ordinal),
        event: { cursor, kind: 'operation', operation: legacyPullOperation(`op-${ordinal}`, 'replica-other') },
      });
      this.cursors.set(cursor, record(cursor, 'session-1', String(ordinal)));
    }
  }
}

function pullRequest(cursor: string, limit: number): SyncPullRequestContext {
  return {
    sessionId: 'session-1', principal: alice, collectionId: 'collection-1', protocolVersion: '0.1', cursor, limit,
  };
}

async function pull(cursorStore: SyncPullCursorStore, eventStore: SyncPullEventStore, cursor = 'start', limit = 200) {
  const session = await verifiedSession('session-1');
  const host = createSyncHost({ owner: 'push', session });
  return (await host.pull(pullRequest(cursor, limit), cursorStore, eventStore)).result;
}

describe('batch event-cursor resolution', () => {
  it('resolves a 200-event page with one start lookup and one batch call', async () => {
    const backend = new BatchBackend();
    backend.seed(200);
    const result = await pull(backend, backend);
    if (!result.ok) throw new Error('expected a page');
    expect(result.body.events).toHaveLength(200);
    expect(result.body.nextCursor).toBe('event-200');
    expect(backend.singleCalls).toBe(1);
    expect(backend.batchCalls).toHaveLength(1);
    expect(backend.batchCalls[0]).toHaveLength(200);
    expect(backend.eventReads).toBe(1);
  });

  it('never asks the batch call for more cursors than the maximum page limit', async () => {
    const backend = new BatchBackend();
    backend.seed(SYNC_PULL_MAX_LIMIT + 5);
    const result = await pull(backend, backend, 'start', SYNC_PULL_MAX_LIMIT);
    expect(result).toMatchObject({ ok: true, body: { hasMore: true } });
    expect(backend.batchCalls.map(call => call.length)).toEqual([SYNC_PULL_MAX_LIMIT]);
  });

  it('makes no cursor batch call for an empty page and echoes the start cursor', async () => {
    const backend = new BatchBackend();
    backend.seed(0);
    expect(await pull(backend, backend)).toMatchObject({ ok: true, body: { events: [], nextCursor: 'start' } });
    expect(backend.batchCalls).toEqual([]);
  });

  it('keeps handoff semantics: the batch sees only current-Session event cursors', async () => {
    const backend = new BatchBackend();
    backend.seed(2, 'session-0');
    backend.lineage.set('session-0', 'session-1');
    expect(await pull(backend, backend)).toMatchObject({ ok: true, body: { nextCursor: 'event-2' } });
    expect(backend.batchCalls).toEqual([['event-1', 'event-2']]);
  });

  it('keeps the sequential resolveCursor fallback for stores without a batch method', async () => {
    const backend = new BatchBackend();
    backend.seed(3);
    const sequential: SyncPullCursorStore = { resolveCursor: cursor => backend.resolveCursor(cursor) };
    expect(await pull(sequential, backend)).toMatchObject({ ok: true, body: { nextCursor: 'event-3' } });
    expect(backend.singleCalls).toBe(4);
    expect(backend.batchCalls).toEqual([]);
  });

  const malformed: ReadonlyArray<readonly [string, (records: SyncPullCursorRecord[]) => unknown, string]> = [
    ['missing', records => records.slice(1), 'has no durable Cursor record'],
    ['duplicate', records => [records[0], records[0]], 'duplicate Cursor'],
    ['extra', records => [...records, record('event-9', 'session-1', '9')], 'more records than requested'],
    ['unrequested', records => [record('event-9', 'session-1', '9'), records[1]], 'unrequested Cursor'],
    ['wrong position', records => [{ ...records[0]!, commitOrdinal: '7' }, records[1]], 'does not match its durable Cursor record'],
    ['wrong Session', records => [{ ...records[0]!, sessionId: 'session-9' }, records[1]], 'does not match its durable Cursor record'],
    ['expired', records => [{ ...records[0]!, state: 'expired' }, records[1]], 'does not match its durable Cursor record'],
    ['unknown member', records => [{ ...records[0]!, extra: true }, records[1]], 'unknown or non-data member'],
    ['non-array', () => ({}), 'must return an array'],
  ];

  it.each(malformed)('fails closed on a %s batch answer', async (_label, mutate, message) => {
    const backend = new BatchBackend();
    backend.seed(2);
    const store: SyncPullCursorStore = {
      resolveCursor: cursor => backend.resolveCursor(cursor),
      resolveCursors: async cursors => mutate(await backend.resolveCursors(cursors) as SyncPullCursorRecord[]) as never,
    };
    await expect(pull(store, backend)).rejects.toThrow(message);
  });

  it('rejects a page that repeats an event cursor before any batch call', async () => {
    const backend = new BatchBackend();
    backend.seed(2);
    backend.log[1]!.event.cursor = 'event-1';
    await expect(pull(backend, backend)).rejects.toThrow('repeats an event Cursor');
    expect(backend.batchCalls).toEqual([]);
  });
});
