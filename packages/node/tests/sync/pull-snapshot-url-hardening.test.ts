import { describe, expect, it } from 'vitest';

import {
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullRequestContext,
  type SyncPullSnapshotUrlOptions,
} from '../../src/sync/index.js';
import {
  coordinateSyncPull,
} from '../../src/sync/unsafe.js';

/**
 * SYNC-V-007 — Expired Pull recovery Snapshot URL transport hardening.
 *
 * Exercises the real expired-cursor recovery path in `coordinateSyncPull`
 * (not a pure helper stub). Default policy must reject cleartext `http:`
 * Snapshot URLs; `https:` remains valid; explicit insecure opt-in is the only
 * escape hatch for `http:`.
 */

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

function request(overrides: Partial<SyncPullRequestContext> = {}): SyncPullRequestContext {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    cursor: 'cursor-expired',
    limit: 10,
    ...overrides,
  };
}

function expiredCursor(snapshotUrl?: string): SyncPullCursorRecord {
  return {
    cursor: 'cursor-expired',
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    commitOrdinal: '100',
    state: 'expired',
    ...(snapshotUrl === undefined ? {} : { snapshotUrl }),
  };
}

class MemoryCursorStore implements SyncPullCursorStore {
  constructor(private readonly record: SyncPullCursorRecord) {}

  async resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null> {
    await Promise.resolve();
    return cursor === this.record.cursor ? copy(this.record) : null;
  }
}

class TrackingEventStore implements SyncPullEventStore {
  readonly reads: SyncPullEventReadRequest[] = [];

  async readCommittedAfter(candidate: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    await Promise.resolve();
    this.reads.push(copy(candidate));
    return {
      entries: [],
      hasMore: false,
      collectionRevision: 'revision-1',
      recommendedPullAfterSeconds: 0,
    };
  }
}

describe('SYNC-V-007 expired Pull Snapshot URL hardening', () => {
  it('rejects cleartext http Snapshot URL on expired cursor recovery by default', async () => {
    const events = new TrackingEventStore();
    const cursors = new MemoryCursorStore(
      expiredCursor('http://sync.example/snapshots/latest'),
    );

    await expect(coordinateSyncPull(request(), cursors, events)).rejects.toThrow(
      /http|insecure|Snapshot URL|snapshotUrl|HTTPS/i,
    );
    expect(events.reads).toHaveLength(0);
  });

  it('returns sync_cursor_expired with an https Snapshot URL without reading events', async () => {
    const snapshotUrl = 'https://sync.example/snapshots/latest';
    const events = new TrackingEventStore();
    const cursors = new MemoryCursorStore(expiredCursor(snapshotUrl));

    const result = await coordinateSyncPull(request(), cursors, events);

    expect(result).toMatchObject({
      ok: false,
      status: 410,
      problem: {
        status: 410,
        code: 'sync_cursor_expired',
        snapshotUrl,
        retryable: false,
      },
    });
    expect(events.reads).toHaveLength(0);
  });

  it('returns sync_cursor_expired without snapshotUrl when the durable record has none', async () => {
    const events = new TrackingEventStore();
    const cursors = new MemoryCursorStore(expiredCursor());

    const result = await coordinateSyncPull(request(), cursors, events);

    // F027: snapshotUrl is optional on the wire — a host that cannot publish a
    // Snapshot must still get the deterministic 410 problem, never a TypeError.
    expect(result).toMatchObject({
      ok: false,
      status: 410,
      problem: {
        status: 410,
        code: 'sync_cursor_expired',
        retryable: false,
      },
    });
    expect(result.ok === false && 'snapshotUrl' in result.problem).toBe(false);
    expect(events.reads).toHaveLength(0);
  });

  it('allows http Snapshot URL only when explicit insecure opt-in is set', async () => {
    const snapshotUrl = 'http://sync.example/snapshots/insecure';
    const events = new TrackingEventStore();
    const cursors = new MemoryCursorStore(expiredCursor(snapshotUrl));

    const result = await coordinateSyncPull(request(), cursors, events, {
      allowInsecureSnapshotUrl: true,
    } satisfies SyncPullSnapshotUrlOptions);

    expect(result).toMatchObject({
      ok: false,
      status: 410,
      problem: {
        status: 410,
        code: 'sync_cursor_expired',
        snapshotUrl,
        retryable: false,
      },
    });
    expect(events.reads).toHaveLength(0);
  });

  it('still rejects non-HTTP(S) schemes even with insecure opt-in', async () => {
    const events = new TrackingEventStore();
    const cursors = new MemoryCursorStore(
      expiredCursor('file:///var/sync/snapshots/latest'),
    );

    await expect(
      coordinateSyncPull(request(), cursors, events, { allowInsecureSnapshotUrl: true }),
    ).rejects.toThrow(/absolute HTTP|Snapshot URL|snapshotUrl|scheme/i);
    expect(events.reads).toHaveLength(0);
  });

  it('rejects Snapshot URLs that embed userinfo credentials', async () => {
    const events = new TrackingEventStore();
    const cursors = new MemoryCursorStore(
      expiredCursor('https://alice:secret@sync.example/snapshots/latest'),
    );

    await expect(coordinateSyncPull(request(), cursors, events)).rejects.toThrow(
      /userinfo|user information|credentials|username|password/i,
    );
    expect(events.reads).toHaveLength(0);
  });

  it('does not treat allowInsecureSnapshotUrl=false as an opt-in', async () => {
    const events = new TrackingEventStore();
    const cursors = new MemoryCursorStore(
      expiredCursor('http://sync.example/snapshots/latest'),
    );

    await expect(
      coordinateSyncPull(request(), cursors, events, { allowInsecureSnapshotUrl: false }),
    ).rejects.toThrow(/http|insecure|Snapshot URL|snapshotUrl|HTTPS/i);
    expect(events.reads).toHaveLength(0);
  });
});
