import { describe, expect, it } from 'vitest';

import { legacyPullOperation } from '../support/legacy-pull-fixtures.js';
import type { DeleteOperationPayload } from '../../src/types/index.js';
import {
  SYNC_PULL_MAX_LIMIT,
  type SyncPullCommittedEvent,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullRequestContext,
} from '../../src/sync/index.js';
import { SYNC_PULL_PAGE_MAX_BYTES, SYNC_PULL_PAGE_MAX_MEMBERS } from '../../src/sync/pull.js';
import { coordinateSyncPull } from '../../src/sync/unsafe.js';

const evidence = '[review:u17-pull-page-budget]';

function countMembers(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  let total = keys.length;
  if (Array.isArray(value)) {
    for (const item of value) total += countMembers(item, seen);
  } else {
    for (const key of keys) {
      if (typeof key === 'string') total += countMembers((value as Record<string, unknown>)[key], seen);
    }
  }
  seen.delete(value);
  return total;
}

function request(limit: number): SyncPullRequestContext {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    cursor: 'cursor-start',
    limit,
  };
}

function cursorRecord(cursor: string, commitOrdinal: string): SyncPullCursorRecord {
  return {
    cursor,
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    commitOrdinal,
    state: 'active',
  };
}

function entry(ordinal: number, reason?: string, payloadKeys = 0): SyncPullCommittedEvent {
  // Extra members deliberately exercise rejection budgets; legal events use
  // the delete operation's optional reason field.
  const payload: DeleteOperationPayload & Record<string, unknown> = {};
  if (reason !== undefined) payload.reason = reason;
  for (let index = 0; index < payloadKeys; index += 1) payload[`k${index}`] = index;
  return {
    commitOrdinal: String(ordinal),
    event: {
      cursor: `cursor-${ordinal}`,
      kind: 'operation',
      operation: {
        ...legacyPullOperation(`operation-${ordinal}`, `replica-${ordinal}`),
        payload,
      },
    },
  };
}

function page(entries: readonly SyncPullCommittedEvent[]): SyncPullEventPage {
  return {
    entries,
    hasMore: false,
    collectionRevision: 'revision-7',
    recommendedPullAfterSeconds: 30,
  };
}

class RecordingPullStore implements SyncPullCursorStore, SyncPullEventStore {
  resolveCalls = 0;
  readCalls = 0;
  persistedCursor = 'cursor-start';

  constructor(private readonly stored: SyncPullEventPage) {}

  async resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null> {
    this.resolveCalls += 1;
    if (cursor === 'cursor-start') return cursorRecord(cursor, '0');
    const match = this.stored.entries.find((item) => item.event.cursor === cursor);
    return match === undefined ? null : cursorRecord(cursor, match.commitOrdinal);
  }

  async readCommittedAfter(candidate: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    await Promise.resolve();
    expect(candidate.limit).toBeGreaterThan(0);
    this.readCalls += 1;
    const remaining = this.stored.entries.filter(entry => BigInt(entry.commitOrdinal) > BigInt(candidate.afterCommitOrdinal));
    const entries = remaining.slice(0, candidate.limit);
    return { ...this.stored, entries, hasMore: remaining.length > entries.length || this.stored.hasMore };
  }
}

async function pull(stored: SyncPullEventPage, limit = stored.entries.length || 1) {
  const store = new RecordingPullStore(stored);
  try {
    const result = await coordinateSyncPull(request(limit), store, store);
    if (result.ok) store.persistedCursor = result.body.nextCursor;
    return { result, store };
  } catch (error) {
    return { error, store };
  }
}

describe(`U-17 Pull whole-page budget ${evidence}`, () => {
  it(`keeps a measured in-budget page advancing and does not use the limit-scaled member cap ${evidence}`, async () => {
    const entries = Array.from({ length: SYNC_PULL_MAX_LIMIT }, (_, index) => entry(index + 1));
    const stored = page(entries);
    const members = countMembers(stored);
    const jsonBytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
    process.stdout.write(
      `U-17 pull page measurement entries=${entries.length} members=${members} jsonBytes=${jsonBytes} budgetMembers=${SYNC_PULL_PAGE_MAX_MEMBERS} budgetBytes=${SYNC_PULL_PAGE_MAX_BYTES}\n`,
    );
    expect(members).toBeLessThanOrEqual(SYNC_PULL_PAGE_MAX_MEMBERS);
    expect(jsonBytes).toBeLessThanOrEqual(SYNC_PULL_PAGE_MAX_BYTES);
    expect(SYNC_PULL_PAGE_MAX_MEMBERS).toBeLessThan(SYNC_PULL_MAX_LIMIT * (10_003) + 5);
    expect(SYNC_PULL_PAGE_MAX_BYTES).not.toBe(2 * 1024 * 1024);
    expect(SYNC_PULL_PAGE_MAX_BYTES).not.toBe(16 * 1024 * 1024);

    const { result, store } = await pull(stored, SYNC_PULL_MAX_LIMIT);
    expect(result).toMatchObject({ ok: true, status: 200 });
    if (result === undefined || !result.ok) throw new Error('expected in-budget Pull page');
    expect(result.body.events).toHaveLength(SYNC_PULL_MAX_LIMIT);
    expect(result.body.nextCursor).toBe(`cursor-${SYNC_PULL_MAX_LIMIT}`);
    expect(store.persistedCursor).toBe(`cursor-${SYNC_PULL_MAX_LIMIT}`);
  });

  it(`pages legal events over the byte budget from the same cut, including one large event ${evidence}`, async () => {
    const oversizedReason = 'x'.repeat(Math.floor(SYNC_PULL_PAGE_MAX_BYTES / 2) + 2_048);
    const oversized = page([entry(1, oversizedReason), entry(2, oversizedReason)]);
    const oversizedBytes = Buffer.byteLength(JSON.stringify(oversized), 'utf8');
    process.stdout.write(
      `U-17 pull over-byte page measurement entries=2 jsonBytes=${oversizedBytes} budgetBytes=${SYNC_PULL_PAGE_MAX_BYTES}\n`,
    );
    expect(oversizedBytes).toBeGreaterThan(SYNC_PULL_PAGE_MAX_BYTES);

    const first = await pull(oversized, SYNC_PULL_MAX_LIMIT);
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({ ok: true });
    if (!first.result?.ok) throw new Error('expected a bounded Pull prefix');
    expect(first.result.body.events).toHaveLength(1);
    expect(first.result.body).toMatchObject({ nextCursor: 'cursor-1', hasMore: true, collectionRevision: 'revision-7' });
    expect(first.store.readCalls).toBe(1);
    const second = await coordinateSyncPull({ ...request(SYNC_PULL_MAX_LIMIT), cursor: first.result.body.nextCursor },
      first.store, first.store);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected the remaining event');
    expect(second.body.events).toHaveLength(1);
    expect(second.body).toMatchObject({ nextCursor: 'cursor-2', hasMore: false, collectionRevision: 'revision-7' });

    const smaller = page([entry(1, oversizedReason)]);
    const smallerBytes = Buffer.byteLength(JSON.stringify(smaller), 'utf8');
    expect(smallerBytes).toBeLessThanOrEqual(SYNC_PULL_PAGE_MAX_BYTES);
    const advanced = await pull(smaller, SYNC_PULL_MAX_LIMIT);
    expect(advanced.error).toBeUndefined();
    expect(advanced.result).toMatchObject({ ok: true });
    expect(advanced.store.persistedCursor).toBe('cursor-1');

    const singleOverByte = page([entry(1, 'y'.repeat(SYNC_PULL_PAGE_MAX_BYTES))]);
    const singleBytes = Buffer.byteLength(JSON.stringify(singleOverByte), 'utf8');
    process.stdout.write(
      `U-17 pull single-event measurement jsonBytes=${singleBytes} budgetBytes=${SYNC_PULL_PAGE_MAX_BYTES}\n`,
    );
    expect(singleBytes).toBeGreaterThan(SYNC_PULL_PAGE_MAX_BYTES);
    const delivered = await pull(singleOverByte, SYNC_PULL_MAX_LIMIT);
    expect(delivered.error).toBeUndefined();
    expect(delivered.result).toMatchObject({ ok: true });
    if (delivered.result === undefined || !delivered.result.ok) throw new Error('expected one legal event');
    expect(delivered.result.body.events).toHaveLength(1);
    expect(delivered.store.persistedCursor).toBe('cursor-1');
  });

  it(`keeps malformed over-member events rejected by the per-event cap ${evidence}`, async () => {
    const crowded = page([entry(1, undefined, 55_000), entry(2, undefined, 55_000)]);
    const members = countMembers(crowded);
    process.stdout.write(
      `U-17 pull over-member page measurement entries=2 members=${members} budgetMembers=${SYNC_PULL_PAGE_MAX_MEMBERS}\n`,
    );
    expect(members).toBeGreaterThan(SYNC_PULL_PAGE_MAX_MEMBERS);
    const rejected = await pull(crowded, 2);
    expect(rejected.error).toBeInstanceOf(TypeError);
    expect(rejected.error).toMatchObject({ message: expect.stringMatching(/maximum JSON member count/) });
    expect(rejected.store.persistedCursor).toBe('cursor-start');

    const perEvent = page([entry(1, undefined, 10_001)]);
    const perEventResult = await pull(perEvent, 1);
    expect(perEventResult.error).toBeInstanceOf(TypeError);
    expect(perEventResult.error).toMatchObject({ message: expect.stringMatching(/maximum JSON member count/) });
    expect(perEventResult.store.persistedCursor).toBe('cursor-start');
    expect(String(perEventResult.error)).not.toMatch(/whole-page/);
  });

  it('selects a bounded prefix without copying or executing rejected tail accessors', async () => {
    const stored = page(Array.from({ length: 12 }, (_, index) => entry(index + 1, 'x'.repeat(140_000))));
    const { result, error, store } = await pull(stored, 12);
    expect(error).toBeUndefined();
    if (!result?.ok) throw new Error('expected bounded prefix');
    expect(result.body.events.length).toBeGreaterThan(1);
    expect(result.body.events.length).toBeLessThan(12);
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThan(SYNC_PULL_PAGE_MAX_BYTES);
    expect(result.body.hasMore).toBe(true);
    expect(store.readCalls).toBe(1);

    let calls = 0;
    const poisoned = page([entry(1), entry(2)]);
    Object.defineProperty(poisoned.entries, '1', { enumerable: true, get() { calls += 1; return entry(2); } });
    const poisonedStore = new RecordingPullStore(poisoned);
    await expect(coordinateSyncPull(request(2), poisonedStore, { readCommittedAfter: async () => poisoned }))
      .rejects.toBeInstanceOf(TypeError);
    expect(poisonedStore.persistedCursor).toBe('cursor-start');
    expect(poisonedStore.resolveCalls).toBe(1);
    expect(calls).toBe(0);
  });

  it('pages individually valid member-heavy events without relaxing per-event budgets', async () => {
    const value = Object.fromEntries(Array.from({ length: 9_000 }, (_, index) => [`k${index}`, 1]));
    const entries: SyncPullCommittedEvent[] = Array.from({ length: 12 }, (_, index) => {
      const { targetId: _target, ...operation } = legacyPullOperation(`create-${index}`, `replica-${index}`);
      return { commitOrdinal: String(index + 1), event: { cursor: `cursor-${index + 1}`, kind: 'operation',
        operation: { ...operation, type: 'create_node', baseRevision: null,
          payload: { parentId: 'root-1', node: { kind: 'folder', title: 'Folder', extensions: { 'https://example.test/data': value } } } } } };
    });
    const stored = page(entries);
    expect(countMembers(stored)).toBeGreaterThan(SYNC_PULL_PAGE_MAX_MEMBERS);
    const first = await pull(stored, 12);
    expect(first.error).toBeUndefined();
    if (!first.result?.ok) throw new Error('expected a valid member-bounded page');
    expect(first.result.body.events.length).toBeLessThan(12);
    expect(countMembers(first.result.body)).toBeLessThan(SYNC_PULL_PAGE_MAX_MEMBERS);
    expect(first.result.body.hasMore).toBe(true);
    const second = await coordinateSyncPull({ ...request(12), cursor: first.result.body.nextCursor }, first.store, first.store);
    if (!second.ok) throw new Error('expected remaining member-heavy events');
    expect(first.result.body.events.length + second.body.events.length).toBe(12);
    expect(second.body.hasMore).toBe(false);
  });
});
