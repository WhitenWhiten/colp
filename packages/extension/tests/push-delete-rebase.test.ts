import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rebaseStaleDelete } from '../src/push-delete-rebase.js';
import type { JsonObject, QueueOperation, SyncScope } from '../src/sync-state-store.js';
import type { ParsedColpProblem } from '../src/sync-push-wire.js';

const scope = { collectionId: 'collection' } as SyncScope;

function queue(): QueueOperation {
  return {
    scopeKey: 'scope', sequence: 1, opId: 'op-delete', batchId: 'batch', idempotencyKey: 'key',
    digest: 'sha256:op', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'rev-1', operationRevision: 'rev-1', status: 'claimed',
    retry: { attempt: 1, notBefore: 0 },
    payload: { type: 'delete_subtree', targetId: 'folder', baseRevision: 'rev-1', source: {}, payload: {} },
  };
}

function problem(memberIdsDigest: string): ParsedColpProblem {
  return {
    code: 'revision_conflict', status: 409, currentRevision: 'rev-2',
    currentSubtree: { version: 1, count: 1, digest: 'digest', memberIdsDigest },
  };
}

function indexed(events: ReadonlyArray<{ ordinal: number; opId: string; kind: string; digest?: string }>) {
  const logStarts: number[] = [];
  const opReads: Array<{ opId: string; after: number }> = [];
  let aside = 0;
  const store = {
    rebaseClaimedPush: async () => queue(),
    setAsideClaimedPush: async () => { aside += 1; },
    settleClaimedPush: async () => undefined,
    async listBookmarkEvents(_scope: unknown, after = 0, limit = 100) {
      logStarts.push(after);
      return events.filter((row) => row.ordinal > after).slice(0, limit);
    },
    async listBookmarkEventsByOperation(_scope: unknown, opId: string, after = 0, limit = 100) {
      opReads.push({ opId, after });
      return events.filter((row) => row.opId === opId && row.ordinal > after).slice(0, limit)
        .map((row) => ({ ...row, details: row.digest ? { subtreeMemberIdsDigest: row.digest } : {} }));
    },
  };
  return { store, logStarts, opReads, aside: () => aside };
}

test('delete rebase reads the earliest remove for that op id and skips earlier unrelated events', async () => {
  const noise = Array.from({ length: 160 }, (_, index) => ({
    ordinal: index + 1, opId: `noise-${index}`, kind: 'remove', digest: 'noise',
  }));
  const events = [
    ...noise,
    { ordinal: 200, opId: 'op-delete', kind: 'create' },
    { ordinal: 201, opId: 'op-delete', kind: 'remove', digest: 'ids-match' },
    { ordinal: 202, opId: 'op-delete', kind: 'remove', digest: 'ids-later' },
  ];
  const index = indexed(events);
  const result = await rebaseStaleDelete({
    store: index.store as never, scope, ownerId: 'owner', fence: 1, queue: queue(),
    problem: problem('ids-match'), digest: (payload: JsonObject) => `sha256:${payload.type}`,
  });
  assert.equal(result, 'rebased');
  assert.equal(index.aside(), 0);
  assert.deepEqual(index.logStarts, []);
  assert.deepEqual(index.opReads, [{ opId: 'op-delete', after: 0 }]);
});

test('delete rebase keeps the first remove when a later one would match, and returns held when none match', async () => {
  const events = [
    { ordinal: 1, opId: 'op-delete', kind: 'remove', digest: 'ids-first' },
    { ordinal: 2, opId: 'op-delete', kind: 'remove', digest: 'ids-match' },
  ];
  const earlier = indexed(events);
  const held = await rebaseStaleDelete({
    store: earlier.store as never, scope, ownerId: 'owner', fence: 1, queue: queue(),
    problem: problem('ids-match'), digest: () => 'sha256:payload',
  });
  assert.equal(held, 'held');
  assert.equal(earlier.aside(), 1);
  assert.deepEqual(earlier.logStarts, []);

  const missing = indexed([]);
  const absent = await rebaseStaleDelete({
    store: missing.store as never, scope, ownerId: 'owner', fence: 1, queue: queue(),
    problem: problem('ids-match'), digest: () => 'sha256:payload',
  });
  assert.equal(absent, 'held');
  assert.deepEqual(missing.logStarts, []);
  assert.deepEqual(missing.opReads, [{ opId: 'op-delete', after: 0 }]);
});
