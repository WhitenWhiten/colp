import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ExportJobCapacityError, processExportJobClaim } from '../../../src/modules/collections/index.js';

type ProcessPorts = Parameters<typeof processExportJobClaim>[0];
type Claim = Parameters<typeof processExportJobClaim>[1];

const NOW = new Date('2026-08-30T00:00:00.000Z');
const FUTURE = new Date('2026-08-31T00:00:00.000Z');
const PAST = new Date('2026-08-29T00:00:00.000Z');

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    jobId: 'export-job-1',
    ownerSubjectId: 'owner-1',
    status: 'pending',
    objectKey: null,
    expiresAt: FUTURE,
    leaseOwner: 'worker-1',
    ...overrides,
  };
}

function ports(overrides: {
  readonly deleteObject?: () => Promise<void>;
  readonly loadProjection?: () => Promise<never>;
  readonly markFailed?: ProcessPorts['worker']['markFailed'];
  readonly markExpired?: ProcessPorts['worker']['markExpired'];
  readonly markReady?: ProcessPorts['worker']['markReady'];
} = {}): ProcessPorts {
  return {
    clock: { now: () => NOW },
    projection: {
      loadOwnedLiveTree: overrides.loadProjection ?? (async () => []),
    },
    store: {
      async put() {},
      async get() { return null; },
      delete: overrides.deleteObject ?? (async () => {}),
    },
    worker: {
      markExpired: overrides.markExpired ?? (async () => true),
      async markRunning() { return true; },
      markFailed: overrides.markFailed ?? (async () => true),
      markReady: overrides.markReady ?? (async () => true),
    },
  };
}

test('expired export jobs remain retryable when object cleanup fails', async () => {
  const cleanupFailure = new Error('object delete unavailable');
  let markedExpired = false;
  await assert.rejects(processExportJobClaim(ports({
    deleteObject: async () => { throw cleanupFailure; },
    markExpired: async () => { markedExpired = true; return true; },
  }), claim({ objectKey: 'export-job-1', expiresAt: PAST })), cleanupFailure);
  assert.equal(markedExpired, false);
});

test('a lost ready lease surfaces object cleanup failure', async () => {
  const cleanupFailure = new Error('object delete unavailable');
  await assert.rejects(processExportJobClaim(ports({
    markReady: async () => false,
    deleteObject: async () => { throw cleanupFailure; },
  }), claim()), cleanupFailure);
});

test('failure persistence errors preserve the original export error', async () => {
  const projectionFailure = new Error('projection unavailable');
  const persistenceFailure = new Error('mark failed unavailable');
  await assert.rejects(processExportJobClaim(ports({
    loadProjection: async () => { throw projectionFailure; },
    markFailed: async () => { throw persistenceFailure; },
  }), claim()), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [projectionFailure, persistenceFailure]);
    return true;
  });
});

test('a lost failure-persistence lease surfaces the original export error', async () => {
  const projectionFailure = new Error('projection unavailable');
  await assert.rejects(processExportJobClaim(ports({
    loadProjection: async () => { throw projectionFailure; },
    markFailed: async () => false,
  }), claim()), projectionFailure);
});

test('early projection capacity failure is reported as over_capacity', async () => {
  let failure: string | undefined;
  await assert.rejects(processExportJobClaim(ports({
    loadProjection: async () => { throw new ExportJobCapacityError(); },
    markFailed: async input => { failure = input.errorClass; return true; },
  }), claim()), ExportJobCapacityError);
  assert.equal(failure, 'over_capacity');
});

test('persisted failures still surface the original exception to worker logging', async () => {
  const failure = new Error('R2 unavailable');
  let recorded = false;
  await assert.rejects(processExportJobClaim(ports({
    loadProjection: async () => { throw failure; },
    markFailed: async input => { recorded = input.errorClass === 'internal'; return true; },
  }), claim()), failure);
  assert.equal(recorded, true);
});

test('a stale lease cannot overwrite or delete a winning attempt artifact', async () => {
  const objects = new Map<string, Buffer>();
  let winningKey: string | undefined;
  const store: ProcessPorts['store'] = {
    async put(key, body) { objects.set(key, body); },
    async get(key) { return objects.get(key) ?? null; },
    async delete(key) { objects.delete(key); },
  };
  let releaseSlow!: () => void;
  let startedSlow!: () => void;
  const started = new Promise<void>(resolve => { startedSlow = resolve; });
  const released = new Promise<void>(resolve => { releaseSlow = resolve; });
  const stale = processExportJobClaim({
    ...ports({ markReady: async () => false }), store,
    projection: { async loadOwnedLiveTree() { startedSlow(); await released; return []; } },
  }, claim({ leaseOwner: 'old-worker' }));
  await started;
  await processExportJobClaim({
    ...ports({ markReady: async input => { winningKey = input.objectKey; return true; } }), store,
  }, claim({ leaseOwner: 'new-worker' }));
  const winningBody = objects.get(winningKey!);
  assert.ok(winningBody);
  releaseSlow();
  await stale;
  assert.equal(objects.size, 1);
  assert.equal(objects.get(winningKey!), winningBody);
});

test('expiry cleans the recorded artifact key rather than the public job ID', async () => {
  let deleted: string | undefined;
  const processPorts = ports();
  await processExportJobClaim({
    ...processPorts, store: { ...processPorts.store, async delete(key) { deleted = key; } },
  }, claim({ objectKey: 'winning-attempt-key', expiresAt: PAST }));
  assert.equal(deleted, 'winning-attempt-key');
});
