import { legacyPullOperation, legacyPullConflict } from '../support/legacy-pull-fixtures.js';
import { describe, expect, it } from 'vitest';

import * as publicSyncApi from '../../src/sync/index.js';
import {
  coordinateSyncPull,
} from '../../src/sync/unsafe.js';
import {
  SyncPullLogTruncatedError,
  type SyncPullCommittedEvent,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullRequestContext,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.pull-order]';
const currentReplicaId = 'replica-current';

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

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

function cursorRecord(
  cursor: string,
  commitOrdinal: string,
  overrides: Partial<SyncPullCursorRecord> = {},
): SyncPullCursorRecord {
  return {
    cursor,
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    commitOrdinal,
    state: 'active',
    ...overrides,
  };
}

function operationEntry(
  commitOrdinal: string,
  cursor: string,
  operationId: string,
  replicaId = 'replica-other',
): SyncPullCommittedEvent {
  return {
    commitOrdinal,
    event: {
      cursor,
      kind: 'operation',
      operation: legacyPullOperation(operationId, replicaId),
    },
  };
}

function conflictEntry(
  commitOrdinal: string,
  cursor: string,
  conflictId: string,
): SyncPullCommittedEvent {
  return {
    commitOrdinal,
    event: {
      cursor,
      kind: 'conflict',
      conflict: legacyPullConflict(conflictId),
    },
  };
}

function page(
  entries: readonly SyncPullCommittedEvent[],
  overrides: Partial<SyncPullEventPage> = {},
): SyncPullEventPage {
  return {
    entries,
    hasMore: false,
    collectionRevision: 'revision-7',
    recommendedPullAfterSeconds: 30,
    ...overrides,
  };
}

class SharedPullBackend {
  readonly cursors = new Map<string, SyncPullCursorRecord>();
  readonly pages = new Map<string, SyncPullEventPage>();
}

class DurableCursorHandle implements SyncPullCursorStore {
  resolveCalls = 0;

  constructor(readonly backend: SharedPullBackend) {}

  async resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null> {
    const record = this.backend.cursors.get(cursor);
    const snapshot = record === undefined ? null : copy(record);
    await Promise.resolve();
    this.resolveCalls += 1;
    return snapshot;
  }
}

class DurableEventHandle implements SyncPullEventStore {
  readonly reads: SyncPullEventReadRequest[] = [];

  constructor(readonly backend: SharedPullBackend) {}

  async readCommittedAfter(candidate: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    await Promise.resolve();
    this.reads.push(copy(candidate));
    const stored = this.backend.pages.get(candidate.afterCommitOrdinal);
    if (stored === undefined) throw new Error('missing test page');
    return copy(stored);
  }
}

function backendWithStart(startOrdinal = '100'): SharedPullBackend {
  const backend = new SharedPullBackend();
  backend.cursors.set('cursor-start', cursorRecord('cursor-start', startOrdinal));
  return backend;
}

function addEntries(backend: SharedPullBackend, entries: readonly SyncPullCommittedEvent[]): void {
  for (const entry of entries) {
    backend.cursors.set(entry.event.cursor, cursorRecord(entry.event.cursor, entry.commitOrdinal));
  }
}

function accessorPage(): SyncPullEventPage {
  const candidate = page([]) as { hasMore: boolean };
  Object.defineProperty(candidate, 'hasMore', {
    enumerable: true,
    configurable: true,
    get: () => false,
  });
  return candidate as SyncPullEventPage;
}

function inheritedPage(): SyncPullEventPage {
  return Object.assign(Object.create({ injected: true }) as object, page([])) as SyncPullEventPage;
}

describe('SYNC-0005 authoritative Pull order', () => {
  it.each([
    ['operation', '0.1'], ['conflict', '0.1'], ['conflict', '0.2'],
  ] as const)('rejects a cross-Collection %s payload with otherwise valid %s cursors', async (kind, protocolVersion) => {
    const backend = backendWithStart('0');
    const entry = kind === 'operation'
      ? operationEntry('1', 'cursor-next', 'operation-1')
      : conflictEntry('1', 'cursor-next', 'conflict-1');
    Object.assign(kind === 'operation' ? entry.event.operation! : entry.event.conflict!, { collectionId: 'collection-other' });
    addEntries(backend, [entry]);
    for (const record of backend.cursors.values()) Object.assign(record, { protocolVersion });
    backend.pages.set('0', page([entry]));
    await expect(coordinateSyncPull(request({ protocolVersion }),
      new DurableCursorHandle(backend), new DurableEventHandle(backend),
    )).rejects.toThrow('payload does not match the requested Collection');
  });

  it(`delivers a populated maximum-size page without shrinking per-event budgets ${evidence}`, async () => {
    const backend = backendWithStart('0');
    const entries = Array.from({ length: 1000 }, (_, index) =>
      operationEntry(String(index + 1), `cursor-${index + 1}`, `operation-${index + 1}`, `replica-${index + 1}`));
    addEntries(backend, entries);
    backend.pages.set('0', page(entries));
    const result = await coordinateSyncPull(request({ limit: 1000 }),
      new DurableCursorHandle(backend), new DurableEventHandle(backend));
    if (!result.ok) throw new Error('expected full Pull page');
    expect(result.body.events).toHaveLength(1000);
    expect(result.body.nextCursor).toBe('cursor-1000');
    expect(Object.isFrozen(result.body.events[999]?.operation)).toBe(true);
    expect(Object.isFrozen(result.body.events)).toBe(true);
  });

  it(`preserves real Operation and Conflict commit interleaving, including current Replica echo, without leaking ordinals ${evidence}`, async () => {
    const backend = backendWithStart('1');
    const entries = [
      operationEntry('2', 'cursor-z', 'operation-echo', currentReplicaId),
      conflictEntry('10', 'cursor-a', 'conflict-1'),
      operationEntry('11', 'cursor-m', 'operation-remote'),
    ];
    addEntries(backend, entries);
    backend.pages.set('1', page(entries));

    const result = await coordinateSyncPull(
      request({ limit: 3 }),
      new DurableCursorHandle(backend),
      new DurableEventHandle(backend),
    );

    expect(result).toMatchObject({ ok: true, status: 200 });
    if (!result.ok) throw new Error('expected Pull success');
    expect(result.body.events.map((event) => [
      event.kind,
      event.kind === 'operation' ? event.operation?.opId : event.conflict?.id,
      event.cursor,
    ])).toEqual([
      ['operation', 'operation-echo', 'cursor-z'],
      ['conflict', 'conflict-1', 'cursor-a'],
      ['operation', 'operation-remote', 'cursor-m'],
    ]);
    expect(result.body.events[0]?.operation).toMatchObject({ replicaId: currentReplicaId });
    expect(result.body.nextCursor).toBe('cursor-m');
    expect(JSON.stringify(result.body)).not.toContain('commitOrdinal');
    expect(Object.keys(result.body.events[0]!)).not.toContain('commitOrdinal');
  });

  it.each([
    ['reverse order', ['102', '101']],
    ['duplicate order', ['101', '101']],
    ['equal to starting order', ['100']],
    ['below starting order', ['99']],
  ] as const)(`rejects %s from the durable event store ${evidence}`, async (_label, ordinals) => {
    const backend = backendWithStart();
    const entries = ordinals.map((ordinal, index) => operationEntry(
      ordinal,
      `cursor-${index}`,
      `operation-${index}`,
    ));
    addEntries(backend, entries);
    backend.pages.set('100', page(entries));

    await expect(coordinateSyncPull(
      request({ limit: entries.length }),
      new DurableCursorHandle(backend),
      new DurableEventHandle(backend),
    )).rejects.toThrow(/unique and strictly increasing/);
  });

  it.each([
    ['leading zero', '01'],
    ['negative', '-1'],
    ['exponent notation', '1e3'],
    ['leading whitespace', ' 101'],
    ['excessive decimal length', '9'.repeat(100_001)],
  ])(
    `rejects invalid or malicious event ordinal: %s ${evidence}`,
    async (_label, ordinal) => {
      const backend = backendWithStart();
      const entry = operationEntry(ordinal, 'cursor-next', 'operation-1');
      addEntries(backend, [entry]);
      backend.pages.set('100', page([entry]));

      await expect(coordinateSyncPull(
        request(),
        new DurableCursorHandle(backend),
        new DurableEventHandle(backend),
      )).rejects.toThrow(/commitOrdinal|decimal|string|ordinal/i);
    },
  );

  it.each([
    ['leading zero', '01'],
    ['negative', '-1'],
    ['exponent notation', '1e3'],
    ['excessive decimal length', '9'.repeat(100_001)],
  ])(
    `rejects invalid or malicious starting ordinal: %s before reading events ${evidence}`,
    async (_label, ordinal) => {
      const backend = backendWithStart(ordinal);
      const events = new DurableEventHandle(backend);
      await expect(coordinateSyncPull(
        request(),
        new DurableCursorHandle(backend),
        events,
      )).rejects.toThrow(/commitOrdinal|decimal|string|ordinal/i);
      expect(events.reads).toHaveLength(0);
    },
  );

  it(`continues across pages by the last event ordinal and Cursor while preserving hasMore ${evidence}`, async () => {
    const backend = backendWithStart();
    const firstEntries = [
      operationEntry('101', 'opaque-z', 'operation-1'),
      conflictEntry('102', 'opaque-a', 'conflict-1'),
    ];
    const secondEntries = [operationEntry('103', 'opaque-m', 'operation-2')];
    addEntries(backend, [...firstEntries, ...secondEntries]);
    backend.pages.set('100', page(firstEntries, { hasMore: true }));
    backend.pages.set('102', page(secondEntries, { hasMore: false }));

    const firstEvents = new DurableEventHandle(backend);
    const first = await coordinateSyncPull(request(), new DurableCursorHandle(backend), firstEvents);
    expect(first).toMatchObject({ ok: true, body: { nextCursor: 'opaque-a', hasMore: true } });
    expect(firstEvents.reads).toEqual([{
      sessionId: 'session-1',
      principal: { type: 'user', id: 'alice' },
      collectionId: 'collection-1',
      protocolVersion: '0.1',
      afterCommitOrdinal: '100',
      limit: 2,
      maxMembers: 100_000,
      maxBytes: 1_048_576,
    }]);

    const secondEvents = new DurableEventHandle(backend);
    const second = await coordinateSyncPull(
      request({ cursor: 'opaque-a' }),
      new DurableCursorHandle(backend),
      secondEvents,
    );
    expect(second).toMatchObject({ ok: true, body: { nextCursor: 'opaque-m', hasMore: false } });
    expect(secondEvents.reads).toEqual([{
      sessionId: 'session-1',
      principal: { type: 'user', id: 'alice' },
      collectionId: 'collection-1',
      protocolVersion: '0.1',
      afterCommitOrdinal: '102',
      limit: 2,
      maxMembers: 100_000,
      maxBytes: 1_048_576,
    }]);
  });

  it(`orders ordinals beyond the safe-integer lifetime without exposing them ${evidence}`, async () => {
    const start = '9007199254740992';
    const backend = backendWithStart(start);
    const entry = operationEntry('9007199254740993', 'cursor-next', 'operation-1');
    addEntries(backend, [entry]);
    backend.pages.set(start, page([entry]));

    const result = await coordinateSyncPull(
      request(),
      new DurableCursorHandle(backend),
      new DurableEventHandle(backend),
    );
    expect(result).toMatchObject({ ok: true, body: { nextCursor: 'cursor-next' } });
    expect(JSON.stringify(result)).not.toContain('9007199254740993');
  });

  it(`keeps the requested Cursor on an empty page ${evidence}`, async () => {
    const backend = backendWithStart();
    backend.pages.set('100', page([]));
    const result = await coordinateSyncPull(
      request(),
      new DurableCursorHandle(backend),
      new DurableEventHandle(backend),
    );
    expect(result).toMatchObject({
      ok: true,
      body: { events: [], nextCursor: 'cursor-start', hasMore: false },
    });
  });

  it(`answers 410 when the event store reports the log was truncated after cursor resolution ${evidence}`, async () => {
    const backend = backendWithStart();
    const truncated = (snapshotUrl?: string): SyncPullEventStore => ({
      readCommittedAfter: async () => { throw new SyncPullLogTruncatedError(snapshotUrl); },
    });
    const withoutUrl = await coordinateSyncPull(request(), new DurableCursorHandle(backend), truncated());
    expect(withoutUrl).toMatchObject({ ok: false, status: 410, problem: { code: 'sync_cursor_expired' } });
    expect(withoutUrl.ok ? undefined : 'snapshotUrl' in withoutUrl.problem).toBe(false);

    const withUrl = await coordinateSyncPull(
      request(), new DurableCursorHandle(backend), truncated('https://sync.example/snapshot'),
    );
    expect(withUrl).toMatchObject({
      ok: false, status: 410, problem: { snapshotUrl: 'https://sync.example/snapshot' },
    });
    await expect(coordinateSyncPull(
      request(), new DurableCursorHandle(backend), truncated('http://sync.example/snapshot'),
    )).rejects.toThrow('HTTPS');
    const failure = new Error('storage offline');
    await expect(coordinateSyncPull(request(), new DurableCursorHandle(backend), {
      readCommittedAfter: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it.each([
    ['Session', (record: SyncPullCursorRecord): SyncPullCursorRecord => ({ ...record, sessionId: 'session-2' })],
    ['Principal type', (record: SyncPullCursorRecord): SyncPullCursorRecord => ({
      ...record,
      principal: { ...record.principal, type: 'service' },
    })],
    ['Principal id', (record: SyncPullCursorRecord): SyncPullCursorRecord => ({
      ...record,
      principal: { ...record.principal, id: 'mallory' },
    })],
    ['Collection', (record: SyncPullCursorRecord): SyncPullCursorRecord => ({ ...record, collectionId: 'collection-2' })],
    ['protocol version', (record: SyncPullCursorRecord): SyncPullCursorRecord => ({ ...record, protocolVersion: '0.2' })],
  ] as const)(`returns invalid_cursor_scope for a mismatched %s without reading events ${evidence}`, async (_label, change) => {
    const backend = backendWithStart();
    backend.cursors.set('cursor-start', change(backend.cursors.get('cursor-start')!));
    const events = new DurableEventHandle(backend);

    const result = await coordinateSyncPull(request(), new DurableCursorHandle(backend), events);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      problem: { status: 400, code: 'invalid_cursor_scope', retryable: false },
    });
    expect(events.reads).toHaveLength(0);
  });

  it(`returns sync_cursor_expired with snapshotUrl without reading events ${evidence}`, async () => {
    const backend = backendWithStart();
    backend.cursors.set('cursor-start', cursorRecord('cursor-start', '100', {
      state: 'expired',
      snapshotUrl: 'https://sync.example/snapshots/latest',
    }));
    const events = new DurableEventHandle(backend);

    const result = await coordinateSyncPull(request(), new DurableCursorHandle(backend), events);

    expect(result).toMatchObject({
      ok: false,
      status: 410,
      problem: {
        status: 410,
        code: 'sync_cursor_expired',
        snapshotUrl: 'https://sync.example/snapshots/latest',
        retryable: false,
      },
    });
    expect(events.reads).toHaveLength(0);
  });

  it(`validates cursor scope before returning expiry ${evidence}`, async () => {
    const backend = backendWithStart();
    backend.cursors.set('cursor-start', cursorRecord('cursor-start', '100', {
      state: 'expired',
      collectionId: 'collection-2',
      snapshotUrl: 'https://sync.example/snapshots/latest',
    }));
    const events = new DurableEventHandle(backend);

    const result = await coordinateSyncPull(request(), new DurableCursorHandle(backend), events);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      problem: { code: 'invalid_cursor_scope' },
    });
    expect(events.reads).toHaveLength(0);
  });

  it(`reads events for an active Cursor ${evidence}`, async () => {
    const backend = backendWithStart();
    backend.pages.set('100', page([]));
    const events = new DurableEventHandle(backend);
    await expect(coordinateSyncPull(
      request(),
      new DurableCursorHandle(backend),
      events,
    )).resolves.toMatchObject({ ok: true, status: 200 });
    expect(events.reads).toHaveLength(1);
  });

  it.each(['cursor', 'events'] as const)(
    `rejects a synchronous %s store method ${evidence}`,
    async (boundary) => {
      const backend = backendWithStart();
      backend.pages.set('100', page([]));
      const cursorStore: SyncPullCursorStore = boundary === 'cursor'
        ? { resolveCursor: (() => copy(backend.cursors.get('cursor-start')!)) as never }
        : new DurableCursorHandle(backend);
      const eventStore: SyncPullEventStore = boundary === 'events'
        ? { readCommittedAfter: (() => page([])) as never }
        : new DurableEventHandle(backend);
      await expect(coordinateSyncPull(request(), cursorStore, eventStore))
        .rejects.toThrow('must return a Promise');
    },
  );

  it.each([
    ['non-object page', null],
    ['non-array entries', { ...page([]), entries: {} }],
    ['more entries than requested', page([
      operationEntry('101', 'cursor-1', 'operation-1'),
      operationEntry('102', 'cursor-2', 'operation-2'),
      operationEntry('103', 'cursor-3', 'operation-3'),
    ])],
    ['non-boolean hasMore', { ...page([]), hasMore: 'false' }],
    ['empty collectionRevision', { ...page([]), collectionRevision: '' }],
    ['negative recommended delay', { ...page([]), recommendedPullAfterSeconds: -1 }],
    ['unknown member', { ...page([]), injected: true }],
    ['symbol member', Object.assign(page([]), { [Symbol('injected')]: true })],
    ['accessor member', accessorPage()],
    ['inherited member', inheritedPage()],
  ] as const)(`rejects malicious event page: %s ${evidence}`, async (_label, maliciousPage) => {
    const backend = backendWithStart();
    const eventStore: SyncPullEventStore = {
      readCommittedAfter: async () => maliciousPage as unknown as SyncPullEventPage,
    };
    await expect(coordinateSyncPull(
      request(),
      new DurableCursorHandle(backend),
      eventStore,
    )).rejects.toThrow();
  });

  it.each([
    ['event Cursor differs from lookup record', cursorRecord('different-cursor', '101')],
    ['event ordinal differs from Cursor ordinal', cursorRecord('cursor-next', '102')],
    ['event Cursor is expired', cursorRecord('cursor-next', '101', { state: 'expired' })],
  ] as const)(`rejects event Cursor-to-next mismatch: %s ${evidence}`, async (_label, nextRecord) => {
    const backend = backendWithStart();
    const entry = operationEntry('101', 'cursor-next', 'operation-1');
    backend.cursors.set('cursor-next', nextRecord);
    backend.pages.set('100', page([entry]));
    await expect(coordinateSyncPull(
      request(),
      new DurableCursorHandle(backend),
      new DurableEventHandle(backend),
    )).rejects.toThrow(/Cursor record|durable Cursor/);
  });

  it(`rejects an event Cursor from another scope ${evidence}`, async () => {
    const backend = backendWithStart();
    const entry = operationEntry('101', 'cursor-next', 'operation-1');
    backend.cursors.set('cursor-next', cursorRecord('cursor-next', '101', {
      principal: { type: 'user', id: 'mallory' },
    }));
    backend.pages.set('100', page([entry]));

    await expect(coordinateSyncPull(
      request(),
      new DurableCursorHandle(backend),
      new DurableEventHandle(backend),
    )).rejects.toThrow(/Cursor record/);
  });

  it(`shares one durable contract across independent Cursor and event handles ${evidence}`, async () => {
    const backend = backendWithStart();
    const entry = operationEntry('101', 'cursor-next', 'operation-1');
    addEntries(backend, [entry]);
    backend.pages.set('100', page([entry]));

    const result = await coordinateSyncPull(
      request(),
      new DurableCursorHandle(backend),
      new DurableEventHandle(backend),
    );
    expect(result).toMatchObject({ ok: true, body: { nextCursor: 'cursor-next' } });
    expect(new DurableCursorHandle(backend).backend.cursors.get('cursor-next'))
      .toEqual(cursorRecord('cursor-next', '101'));
  });

  it(`detaches and freezes request, store boundary, durable records, and output ${evidence}`, async () => {
    const backend = backendWithStart();
    const entry = operationEntry('101', 'cursor-next', 'operation-original');
    addEntries(backend, [entry]);
    backend.pages.set('100', page([entry]));
    const candidate = request();
    let readRequestFrozen = false;
    const eventStore: SyncPullEventStore = {
      readCommittedAfter: async (readRequest) => {
        readRequestFrozen = Object.isFrozen(readRequest);
        return copy(backend.pages.get(readRequest.afterCommitOrdinal)!);
      },
    };

    const pending = coordinateSyncPull(candidate, new DurableCursorHandle(backend), eventStore);
    (candidate.principal as { id: string }).id = 'caller-mutated';
    (backend.cursors.get('cursor-start')!.principal as { id: string }).id = 'storage-mutated';
    const result = await pending;
    if (!result.ok) throw new Error('expected Pull success');

    (backend.pages.get('100')!.entries[0]!.event.operation as unknown as { opId: string }).opId = 'stored-mutated';
    expect(readRequestFrozen).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.body)).toBe(true);
    expect(Object.isFrozen(result.body.events)).toBe(true);
    expect(Object.isFrozen(result.body.events[0])).toBe(true);
    expect(result.body.events[0]?.operation).toMatchObject({ opId: 'operation-original' });
    expect(() => ((result.body.events[0] as { cursor: string }).cursor = 'output-mutated')).toThrow();
  });

  it(`exports the coordinator from the Sync public entry ${evidence}`, () => {
    expect('coordinateSyncPull' in publicSyncApi).toBe(false);
  });
});
