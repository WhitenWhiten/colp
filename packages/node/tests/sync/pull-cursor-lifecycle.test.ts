/**
 * Pull cursor lifecycle through the public host (03-sync.md §8): initial
 * issuance, same-Session continuation, adapter-verified cross-Session handoff,
 * and fail-closed lineage, principal, Collection and protocol bindings.
 */
import { describe, expect, it } from 'vitest';

import { legacyPullOperation } from '../support/legacy-pull-fixtures.js';
import { alice, verifiedSession } from './verified-session-fixture.js';
import {
  SyncSessionGateDeniedError,
  createSyncHost,
  type SyncPullCommittedEvent,
  type SyncPullCursorHandoffAuthorization,
  type SyncPullCursorHandoffRequest,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullInitialCursorRequest,
  type SyncPullRequestContext,
} from '../../src/sync/index.js';

function record(
  cursor: string,
  sessionId: string,
  commitOrdinal: string,
  overrides: Partial<SyncPullCursorRecord> = {},
): SyncPullCursorRecord {
  return {
    cursor, sessionId, principal: alice, collectionId: 'collection-1', protocolVersion: '0.1',
    commitOrdinal, state: 'active', ...overrides,
  };
}

function entry(commitOrdinal: string, cursor: string): SyncPullCommittedEvent {
  return {
    commitOrdinal,
    event: { cursor, kind: 'operation', operation: legacyPullOperation(`op-${commitOrdinal}`, 'replica-other') },
  };
}

/**
 * Durable adapter model. Lineage is only what the backend recorded when the
 * successor Session was negotiated; the coordinator never infers it.
 */
class PullBackend implements SyncPullCursorStore, SyncPullEventStore {
  readonly cursors = new Map<string, SyncPullCursorRecord>();
  readonly lineage = new Map<string, string>();
  readonly log: SyncPullCommittedEvent[] = [];
  readonly reads: SyncPullEventReadRequest[] = [];
  readonly handoffRequests: SyncPullCursorHandoffRequest[] = [];
  readonly issued: SyncPullInitialCursorRequest[] = [];
  initialOrdinal = '0';
  issueCounter = 0;

  async resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null> {
    const found = this.cursors.get(cursor);
    return found === undefined ? null : structuredClone(found);
  }

  async issueInitialCursor(request: SyncPullInitialCursorRequest): Promise<SyncPullCursorRecord> {
    this.issued.push(structuredClone(request));
    this.issueCounter += 1;
    const issued = record(`initial-${this.issueCounter}`, request.sessionId, this.initialOrdinal);
    this.cursors.set(issued.cursor, issued);
    return structuredClone(issued);
  }

  async authorizeCursorHandoff(
    request: SyncPullCursorHandoffRequest,
  ): Promise<SyncPullCursorHandoffAuthorization | null> {
    this.handoffRequests.push(structuredClone(request));
    if (this.lineage.get(request.fromSessionId) !== request.toSessionId) return null;
    return {
      cursor: request.cursor,
      fromSessionId: request.fromSessionId,
      toSessionId: request.toSessionId,
      commitOrdinal: request.commitOrdinal,
    };
  }

  /** Append a committed event and mint its cursor for the reading Session. */
  commit(commitOrdinal: string, readerSessionId: string): void {
    const cursor = `${readerSessionId}-event-${commitOrdinal}`;
    this.log.push(entry(commitOrdinal, cursor));
    this.cursors.set(cursor, record(cursor, readerSessionId, commitOrdinal));
  }

  async readCommittedAfter(request: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    this.reads.push(structuredClone(request));
    const after = BigInt(request.afterCommitOrdinal);
    const matching = this.log.filter(item => BigInt(item.commitOrdinal) > after
      && this.cursors.get(item.event.cursor)?.sessionId === request.sessionId);
    return structuredClone({
      entries: matching.slice(0, request.limit),
      hasMore: matching.length > request.limit,
      collectionRevision: 'revision-1',
      recommendedPullAfterSeconds: 30,
    });
  }
}

function pullRequest(
  sessionId: string,
  cursor: string | null,
  overrides: Partial<SyncPullRequestContext> = {},
): SyncPullRequestContext {
  return {
    sessionId, principal: alice, collectionId: 'collection-1', protocolVersion: '0.1', cursor, limit: 10,
    ...overrides,
  };
}

async function pull(sessionId: string, backend: PullBackend, cursor: string | null) {
  const session = await verifiedSession(sessionId);
  const host = createSyncHost({ owner: 'push', session });
  return (await host.pull(pullRequest(sessionId, cursor), backend, backend)).result;
}

describe('Pull initial cursor issuance', () => {
  it('issues a cursor bound to the current Session at the initial exclusive position', async () => {
    const backend = new PullBackend();
    backend.initialOrdinal = '5';
    const result = await pull('session-1', backend, null);
    expect(result).toMatchObject({ ok: true, body: { events: [], nextCursor: 'initial-1', hasMore: false } });
    expect(backend.issued).toEqual([{
      sessionId: 'session-1', principal: alice, collectionId: 'collection-1', protocolVersion: '0.1',
    }]);
    expect(backend.reads[0]?.afterCommitOrdinal).toBe('5');
    expect(backend.cursors.get('initial-1')).toMatchObject({ sessionId: 'session-1', commitOrdinal: '5' });
  });

  it('ends a nonempty initial page with the final event cursor', async () => {
    const backend = new PullBackend();
    backend.commit('1', 'session-1');
    backend.commit('2', 'session-1');
    const result = await pull('session-1', backend, null);
    if (!result.ok) throw new Error('expected a page');
    expect(result.body.events.map(event => event.cursor)).toEqual(['session-1-event-1', 'session-1-event-2']);
    expect(result.body.nextCursor).toBe('session-1-event-2');
  });

  it('continues from the issued cursor in the same Session', async () => {
    const backend = new PullBackend();
    const first = await pull('session-1', backend, null);
    if (!first.ok) throw new Error('expected a page');
    backend.commit('1', 'session-1');
    const next = await pull('session-1', backend, first.body.nextCursor);
    expect(next).toMatchObject({ ok: true, body: { nextCursor: 'session-1-event-1' } });
    expect(backend.issued).toHaveLength(1);
  });

  it('fails closed when the store cannot issue a Session-bound active cursor', async () => {
    const withoutIssuer: SyncPullCursorStore = { resolveCursor: async () => null };
    const session = await verifiedSession('session-1');
    const host = createSyncHost({ owner: 'push', session });
    const backend = new PullBackend();
    await expect(host.pull(pullRequest('session-1', null), withoutIssuer, backend))
      .rejects.toThrow('requires a Cursor store with issueInitialCursor');

    for (const override of [{ sessionId: 'session-other' }, { state: 'expired' as const }, { collectionId: 'c2' }]) {
      const wrong: SyncPullCursorStore = {
        resolveCursor: async () => null,
        issueInitialCursor: async request => record('issued', request.sessionId, '0', override),
      };
      await expect(host.pull(pullRequest('session-1', null), wrong, backend))
        .rejects.toThrow('must be active and bound to the current Session');
    }
    expect(backend.reads).toEqual([]);
  });
});

describe('Pull cross-Session handoff', () => {
  function handedOffBackend(): PullBackend {
    const backend = new PullBackend();
    backend.cursors.set('old-cursor', record('old-cursor', 'session-1', '7'));
    backend.lineage.set('session-1', 'session-2');
    return backend;
  }

  it('echoes the exact input cursor on an empty page after a verified handoff', async () => {
    const backend = handedOffBackend();
    const result = await pull('session-2', backend, 'old-cursor');
    expect(result).toMatchObject({ ok: true, body: { events: [], nextCursor: 'old-cursor', hasMore: false } });
    expect(backend.handoffRequests).toEqual([{
      cursor: 'old-cursor', fromSessionId: 'session-1', toSessionId: 'session-2',
      principal: alice, collectionId: 'collection-1', protocolVersion: '0.1', commitOrdinal: '7',
    }]);
    expect(backend.reads[0]).toMatchObject({ sessionId: 'session-2', afterCommitOrdinal: '7' });
    expect(backend.issued).toEqual([]);
  });

  it('enters the new Session authority through the final event cursor of a nonempty page', async () => {
    const backend = handedOffBackend();
    backend.commit('8', 'session-2');
    const result = await pull('session-2', backend, 'old-cursor');
    if (!result.ok) throw new Error('expected a page');
    expect(result.body.nextCursor).toBe('session-2-event-8');
    expect(backend.cursors.get(result.body.nextCursor)?.sessionId).toBe('session-2');
    const continued = await pull('session-2', backend, result.body.nextCursor);
    expect(continued).toMatchObject({ ok: true, body: { events: [], nextCursor: 'session-2-event-8' } });
    expect(backend.handoffRequests).toHaveLength(1);
  });

  it('rejects a handoff page whose event cursor still belongs to the old Session', async () => {
    const backend = handedOffBackend();
    backend.log.push(entry('8', 'stale-event'));
    backend.cursors.set('stale-event', record('stale-event', 'session-1', '8'));
    const session = await verifiedSession('session-2');
    const host = createSyncHost({ owner: 'push', session });
    const staleReader: SyncPullEventStore = {
      readCommittedAfter: async () => ({
        entries: [structuredClone(backend.log[0]!)], hasMore: false,
        collectionRevision: 'revision-1', recommendedPullAfterSeconds: 30,
      }),
    };
    await expect(host.pull(pullRequest('session-2', 'old-cursor'), backend, staleReader))
      .rejects.toThrow('does not match its durable Cursor record');
  });

  it('returns invalid_cursor_scope without reading events when lineage is not proven', async () => {
    const backend = handedOffBackend();
    backend.lineage.clear();
    backend.commit('8', 'session-2');
    const result = await pull('session-2', backend, 'old-cursor');
    expect(result).toMatchObject({ ok: false, status: 400, problem: { code: 'invalid_cursor_scope' } });
    expect(backend.handoffRequests).toHaveLength(1);
    expect(backend.reads).toEqual([]);
  });

  it('treats a store without authorizeCursorHandoff as refusing every cross-Session cursor', async () => {
    const backend = handedOffBackend();
    const session = await verifiedSession('session-2');
    const host = createSyncHost({ owner: 'push', session });
    const resolveOnly: SyncPullCursorStore = { resolveCursor: cursor => backend.resolveCursor(cursor) };
    const { result } = await host.pull(pullRequest('session-2', 'old-cursor'), resolveOnly, backend);
    expect(result).toMatchObject({ ok: false, problem: { code: 'invalid_cursor_scope' } });
    expect(backend.reads).toEqual([]);
  });

  it.each([
    ['principal', { principal: { type: 'user', id: 'mallory' } }],
    ['Collection', { collectionId: 'collection-2' }],
    ['protocol version', { protocolVersion: '0.2' }],
  ] as const)('never asks for a handoff when the %s binding differs', async (_label, override) => {
    const backend = handedOffBackend();
    backend.cursors.set('old-cursor', record('old-cursor', 'session-1', '7', override));
    const result = await pull('session-2', backend, 'old-cursor');
    expect(result).toMatchObject({ ok: false, problem: { code: 'invalid_cursor_scope' } });
    expect(backend.handoffRequests).toEqual([]);
    expect(backend.reads).toEqual([]);
  });

  it.each([
    ['cursor', { cursor: 'other' }],
    ['fromSessionId', { fromSessionId: 'session-9' }],
    ['toSessionId', { toSessionId: 'session-9' }],
    ['commitOrdinal', { commitOrdinal: '0' }],
  ] as const)('fails closed when the authorization rebinds %s', async (_label, override) => {
    const backend = handedOffBackend();
    const session = await verifiedSession('session-2');
    const host = createSyncHost({ owner: 'push', session });
    const rebinding: SyncPullCursorStore = {
      resolveCursor: cursor => backend.resolveCursor(cursor),
      authorizeCursorHandoff: async request => ({
        cursor: request.cursor, fromSessionId: request.fromSessionId,
        toSessionId: request.toSessionId, commitOrdinal: request.commitOrdinal, ...override,
      }),
    };
    await expect(host.pull(pullRequest('session-2', 'old-cursor'), rebinding, backend))
      .rejects.toThrow('does not match the requested lineage');
    expect(backend.reads).toEqual([]);
  });
});

describe('Pull cursor expiry across the lifecycle', () => {
  const snapshotUrl = 'https://snapshots.example.com/collection-1';

  it('returns 410 for an expired same-Session cursor without consulting lineage', async () => {
    const backend = new PullBackend();
    backend.cursors.set('old', record('old', 'session-1', '3', { state: 'expired', snapshotUrl }));
    const result = await pull('session-1', backend, 'old');
    expect(result).toMatchObject({ ok: false, status: 410, problem: { code: 'sync_cursor_expired', snapshotUrl } });
    expect(backend.handoffRequests).toEqual([]);
  });

  it('discloses expiry of a cross-Session cursor only after lineage is proven', async () => {
    const backend = new PullBackend();
    backend.cursors.set('old', record('old', 'session-1', '3', { state: 'expired', snapshotUrl }));
    expect(await pull('session-2', backend, 'old'))
      .toMatchObject({ ok: false, status: 400, problem: { code: 'invalid_cursor_scope' } });
    backend.lineage.set('session-1', 'session-2');
    expect(await pull('session-2', backend, 'old'))
      .toMatchObject({ ok: false, status: 410, problem: { code: 'sync_cursor_expired', snapshotUrl } });
    expect(backend.reads).toEqual([]);
  });
});

describe('Pull requires a Collection-bound Session', () => {
  it('denies an Instance Session holding sync:pull before any cursor or event store access', async () => {
    const session = await verifiedSession('instance-1', {
      sessionScope: 'instance', collectionId: null, purpose: 'create_collection',
      authorizationScopes: ['sync:bootstrap', 'sync:push', 'sync:pull', 'collections:create'],
    });
    expect(session.authorizationScopes).toContain('sync:pull');
    const host = createSyncHost({ owner: 'push', session });
    const backend = new PullBackend();
    backend.cursors.set('any', record('any', 'instance-1', '0'));
    const denied = host.pull(pullRequest('instance-1', 'any'), backend, backend);
    await expect(denied).rejects.toBeInstanceOf(SyncSessionGateDeniedError);
    await expect(denied).rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    const initial = host.pull(pullRequest('instance-1', null), backend, backend);
    await expect(initial).rejects.toBeInstanceOf(SyncSessionGateDeniedError);
    expect(backend.issued).toEqual([]);
    expect(backend.reads).toEqual([]);
  });

  it('denies a Collection mismatch before any store access', async () => {
    const session = await verifiedSession('session-1');
    const host = createSyncHost({ owner: 'push', session });
    let storeCalls = 0;
    const counting: SyncPullCursorStore & SyncPullEventStore = {
      resolveCursor: async () => { storeCalls += 1; return null; },
      issueInitialCursor: async () => { storeCalls += 1; throw new Error('unreachable'); },
      readCommittedAfter: async () => { storeCalls += 1; throw new Error('unreachable'); },
    };
    for (const cursor of ['any', null]) {
      await expect(host.pull(pullRequest('session-1', cursor, { collectionId: 'collection-2' }), counting, counting))
        .rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    }
    expect(storeCalls).toBe(0);
  });

  it('serves a matching Collection-bound request', async () => {
    const backend = new PullBackend();
    backend.commit('1', 'session-1');
    expect(await pull('session-1', backend, null))
      .toMatchObject({ ok: true, body: { nextCursor: 'session-1-event-1' } });
  });
});
