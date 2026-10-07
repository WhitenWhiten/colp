import assert from 'node:assert/strict';
import { test } from 'vitest';
import { verifyUploadedGeneration } from '../../../src/modules/attachments/verification-worker-coordinator.js';
import { runCleanupBatch } from '../../../src/modules/attachments/cleanup-coordinator.js';
import { createAttachmentsCleanupScheduler } from '../../../src/bootstrap/attachments-worker-composition.js';
import { InMemoryCleanupLedger, InMemoryCleanupObjectStore, InMemoryCleanupUow,
  identityFor, makeI14Config } from '../../support/phase4a-i14-test-helpers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const phase of ['head', 'read', 'body'] as const) {
  for (const mode of ['deadline', 'shutdown'] as const) {
    test(`verification ${phase} is bounded by ${mode}, including abort-ignoring providers`, async () => {
      const entered = deferred<void>();
      const never = deferred<never>();
      const abort = new AbortController();
      let providerSignal: AbortSignal | undefined;
      let terminalWrites = 0;
      const task = verifyUploadedGeneration({
        config: { singlePutMaxBytes: 1024, verification: { leaseMs: 1000, timeoutMs: mode === 'deadline' ? 20 : 1000 } },
        uow: { execute: async (work: (context: object) => unknown) => work({ transaction: {} }) },
        ledger: {
          claimVerification: async () => ({ outcome: 'claimed', facts: { key: 'fixture', observedEtag: 'etag', expectedSha256: '0'.repeat(64) } }),
          completeVerification: async () => { terminalWrites += 1; throw new Error('unexpected completion'); },
        },
        blobStore: {
          headExact: async (_handle: unknown, options: { signal: AbortSignal }) => {
            providerSignal = options.signal;
            if (phase === 'head') { entered.resolve(); return never.promise; }
            return { class: 'ok', identity: { etag: 'etag', size: 1 } };
          },
          readBounded: async (_handle: unknown, options: { signal: AbortSignal }) => {
            providerSignal = options.signal;
            if (phase === 'read') { entered.resolve(); return never.promise; }
            return { class: 'ok', identity: { etag: 'etag', size: 1 }, stream: (async function* () {
              entered.resolve(); await never.promise; yield new Uint8Array([1]);
            })() };
          },
        },
      } as never, { blobId: 'blob', generationId: 'generation', intentId: 'intent' },
      { outboxId: 'outbox', leaseGeneration: 1n }, abort.signal);
      await entered.promise;
      if (mode === 'shutdown') abort.abort();
      assert.equal((await task).outcome, 'retryable');
      assert.equal(providerSignal?.aborted, true);
      assert.equal(terminalWrites, 0);
    }, 1000);
  }
}

function cleanupFixture(phase: 'head' | 'delete' | 'confirm') {
  const id = identityFor(51);
  const ledger = new InMemoryCleanupLedger();
  const store = new InMemoryCleanupObjectStore();
  ledger.seed({ generationId: id.generationId, blobId: id.blobId, key: id.key,
    fingerprint: id.fingerprint, observedEtag: 'etag', observedSize: 7, state: 'retired',
    createdAt: new Date('2025-01-01'), retiredAt: new Date('2025-01-01'), orphanedAt: null,
    currentGenerationId: 'successor' });
  store.seed(id.key, 'etag', 7);
  const entered = deferred<void>();
  const never = deferred<never>();
  let observed: AbortSignal | undefined;
  let heads = 0;
  const objectStore = {
    ...store,
    async headExact(handle: typeof id, options?: { signal?: AbortSignal }) {
      heads += 1;
      if (phase === 'head' || (phase === 'confirm' && heads === 2)) {
        observed = options?.signal; entered.resolve(); return never.promise;
      }
      return store.headExact(handle);
    },
    async deleteExact(handle: typeof id, options?: { signal?: AbortSignal }) {
      if (phase === 'delete') { observed = options?.signal; entered.resolve(); return never.promise; }
      return store.deleteExact(handle);
    },
  };
  const options = { ledger, objectStore, uow: new InMemoryCleanupUow(ledger), config: makeI14Config(), leaseOwner: 'fixture' };
  return { options, entered, signal: () => observed };
}

test.each(['head', 'delete', 'confirm'] as const)('cleanup %s deadline releases only an unknown claim', async phase => {
  const f = cleanupFixture(phase);
  const task = runCleanupBatch({ ...f.options, providerTimeoutMs: 20 } as never);
  await f.entered.promise;
  const result = await task;
  assert.equal(result.outcomes[0]?.kind, 'unknown_retryable');
  assert.equal(f.signal()?.aborted, true);
}, 1000);

test('scheduler stop aborts a pending provider operation and refuses new work', async () => {
  const f = cleanupFixture('head');
  const scheduler = createAttachmentsCleanupScheduler({ ...f.options, intervalMs: 100 } as never);
  const task = scheduler.runOnce();
  await f.entered.promise;
  await scheduler.stop();
  assert.equal((await task).outcomes[0]?.kind, 'unknown_retryable');
  assert.equal(f.signal()?.aborted, true);
  assert.equal((await scheduler.runOnce()).claimed, 0);
}, 1000);
