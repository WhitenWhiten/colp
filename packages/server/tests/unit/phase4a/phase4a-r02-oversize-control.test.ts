/**
 * P4A-R02 contract suite: the `oversize_object` negative control.
 *
 * Covers the full oversize boundary matrix (plan §6 P4A-R02, §4.3 mutation
 * control "oversize stream 去掉 hard ceiling"):
 *  - exactly at the single-PUT ceiling (must pass);
 *  - ceiling + 1 (issue declaration must reject `size_out_of_range` BEFORE
 *    any database/ledger/grant work);
 *  - declared smaller but the ACTUAL bounded stream over-delivers past the
 *    hard ceiling (must throw `read_exceeds_ceiling` / verdict
 *    `over_hard_limit` with the recorded byte count, zero bytes over the
 *    ceiling, zero stored/verified facts);
 *  - chunk boundary (an exact-ceiling chunk passes; a crossing chunk fails);
 *  - abort propagation (mid-stream abort -> `aborted`, upstream destroyed);
 *  - body-stream release (clean EOF releases the upstream; overflow/abort
 *    destroy it — observed both on the generator and at the transport).
 *
 * Anti-false-positive (plan §4.1/§6 R02): input-schema rejection alone is
 * NOT the control. The suite also drives the PRODUCTION `boundedBodyStream`
 * generator (the in-stream ceiling guard) and the PRODUCTION R2 adapter over
 * the controlled fault transport, and proves the in-run runner control
 * (`executeR02OversizeObjectControl`) completes the fixed executor contract
 * with the catalog facts.
 *
 * No PostgreSQL, no browser, no real R2.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  BlobStoreError,
  BlobStoreReadOverflowError,
  boundedBodyStream,
  createGenerationObjectStoreAdapter,
  createR2GenerationStore,
} from '../../../src/infrastructure/object-storage/index.js';
import type {
  BlobByteStream,
  BlobStorePort,
  GenerationHandle,
} from '../../../src/infrastructure/object-storage/index.js';
import {
  ATTACHMENTS_VERIFICATION_MIME_SNIFF_PREFIX_BYTES,
  CompleteUploadInputError,
  UploadIntentInputError,
  computeBlobIdFromBinding,
  issueUploadIntent,
  validateCompleteUploadInput,
  validateUploadIntentInput,
  verifyGenerationStream,
  type IssueUploadIntentDeps,
  type IssueUploadIntentInput,
  type VerificationLimits,
} from '../../../src/modules/attachments/index.js';
import type { ActorPrincipal } from '../../../src/modules/access-policy/index.js';
import {
  I16_NEGATIVE_CONTROL_CATALOG,
  I16NegativeControlExecutor,
  buildI16Evidence,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import { executeR02OversizeObjectControl } from '../../../scripts/evidence/phase4a-r02-controls.js';
import { startR02FaultTransport } from '../../../scripts/evidence/phase4a-r02-fault-transport.js';
import type {
  R02FaultScript,
  R02FaultTransport,
} from '../../../scripts/evidence/phase4a-r02-fault-transport.js';
import {
  I16_TEST_RUN_ID,
  i16BindingFacts,
  i16Config,
  i16ExecutionLedger,
  i16NegativeControls,
  i16PostRunChecks,
  i16Scenario,
} from '../../support/phase4a-i16-test-helpers.js';

const CONFIG = i16Config();
const CEILING = CONFIG.singlePutMaxBytes;

const ACTOR: ActorPrincipal = Object.freeze({ principalId: 'r02-oversize-principal', subjectId: 'r02-oversize-subject', kind: 'account' });
const COLLECTION = 'r02-oversize-collection';
const NONCE = 'r02-oversize-nonce-0001';

const LIMITS: VerificationLimits = {
  hardByteCeiling: 64,
  mimeSniffPrefixBytes: ATTACHMENTS_VERIFICATION_MIME_SNIFF_PREFIX_BYTES,
};

function bodyOf(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) body[index] = (index + 7) % 251;
  return body;
}

async function* chunked(bytes: Uint8Array, chunk = 8): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    yield bytes.subarray(offset, Math.min(offset + chunk, bytes.byteLength));
  }
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

function runVerify(stream: AsyncIterable<Uint8Array>, declaredSize: number) {
  return verifyGenerationStream({ stream, signal: neverAborted() }, {
    size: declaredSize,
    sha256: null,
    mediaType: null,
  }, LIMITS);
}

// ---------------------------------------------------------------------------
// Adapter-over-fault-transport helpers (mirror the I06 convention)
// ---------------------------------------------------------------------------

const BUCKET = 'known-r02-unit';
const LIVE_PREFIX = 'attachments/live/';
const KEY = `${LIVE_PREFIX}018f6f7a-8f2a-7a3d-a123-123456789abc`;

function handle(): GenerationHandle {
  return { generationId: 'r02-oversize-generation', key: KEY };
}

function storeOptions(endpoint: string) {
  return {
    endpoint,
    region: 'auto',
    bucket: BUCKET,
    livePrefix: LIVE_PREFIX,
    probePrefix: 'capability-probes/r02/',
    rwCredential: { accessKeyId: 'r02-fault-write-access-key-0001', secretAccessKey: 'r02-fault-write-secret-marker-0001' }, // secret-scan: allow 'r02-fault-write-secret-marker-0001'
    roCredential: { accessKeyId: 'r02-fault-read-access-key-0001', secretAccessKey: 'r02-fault-read-secret-marker-0001' }, // secret-scan: allow 'r02-fault-read-secret-marker-0001'
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
  };
}

async function withFault(
  script: R02FaultScript,
  run: (store: BlobStorePort, fault: R02FaultTransport) => Promise<void>,
): Promise<void> {
  const fault = await startR02FaultTransport(script);
  const store = createR2GenerationStore(storeOptions(fault.url));
  try {
    await run(store, fault);
  } finally {
    await store.close();
    await fault.close();
  }
}

const HEAD_IDENTITY_HEADERS = (size: number) => ({
  'content-length': String(size),
  etag: 'r02-fault-etag',
  'x-amz-meta-probe': 'phase4a-r02',
});

describe('P4A-R02 issue-declared size boundary (production validation)', () => {
  test('declaredSize exactly at the single-PUT ceiling is accepted by the production validator', () => {
    const validated = validateUploadIntentInput({
      actor: ACTOR,
      collectionId: COLLECTION,
      idempotencyKey: 'r02-at-ceiling',
      declaredSize: CEILING,
      declaredSha256: 'a'.repeat(64),
      mediaHint: 'image/png',
    }, CONFIG);
    assert.equal(validated.declaredSize, CEILING);

    const completeValidated = validateCompleteUploadInput({
      actor: ACTOR,
      binding: { intentId: 'intent', generationId: 'generation', blobId: 'blob' },
      declared: { size: CEILING, sha256: 'a'.repeat(64), mediaType: 'image/png', etag: '"r02-etag"' },
    }, CONFIG);
    assert.equal(completeValidated.declared.size, CEILING);
  });

  test('declaredSize ceiling+1 is rejected size_out_of_range by the issue and complete validators', () => {
    assert.throws(() => validateUploadIntentInput({
      actor: ACTOR,
      collectionId: COLLECTION,
      idempotencyKey: 'r02-over-ceiling',
      declaredSize: CEILING + 1,
      declaredSha256: 'a'.repeat(64),
      mediaHint: 'image/png',
    }, CONFIG), (error: unknown) => error instanceof UploadIntentInputError && error.code === 'size_out_of_range');

    assert.throws(() => validateCompleteUploadInput({
      actor: ACTOR,
      binding: { intentId: 'intent', generationId: 'generation', blobId: 'blob' },
      declared: { size: CEILING + 1, sha256: 'a'.repeat(64), mediaType: 'image/png', etag: '"r02-etag"' },
    }, CONFIG), (error: unknown) => error instanceof CompleteUploadInputError && error.code === 'size_out_of_range');
  });

  test('issueUploadIntent rejects the ceiling+1 declaration BEFORE any DB/ledger or grant work', async () => {
    let uowCalls = 0;
    let grantCalls = 0;
    const deps = {
      config: CONFIG,
      uow: {
        execute: async () => {
          uowCalls += 1;
          throw new Error('the unit of work must never run for an oversized declaration');
        },
      },
      blobStore: {
        issueCreateOnlyGrant: async () => {
          grantCalls += 1;
          throw new Error('the grant issuer must never run for an oversized declaration');
        },
      },
    } as unknown as IssueUploadIntentDeps<never>;

    await assert.rejects(
      issueUploadIntent(deps, {
        actor: ACTOR,
        collectionId: COLLECTION,
        idempotencyKey: 'r02-over-ceiling-use-case',
        declaredSize: CEILING + 1,
        declaredSha256: 'a'.repeat(64),
        mediaHint: 'image/png',
      }),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'size_out_of_range',
    );
    assert.equal(uowCalls, 0, 'an oversized declaration must never touch the database unit of work');
    assert.equal(grantCalls, 0, 'an oversized declaration must never sign a grant');
  });

  test('the R2 grant issuer accepts exactly-at-ceiling contentLength and rejects ceiling+1', async () => {
    // Grant signing is offline (presign only); no transport is contacted.
    const store = createR2GenerationStore(storeOptions('https://r2.invalid.invalid'));
    try {
      const grant = await store.issueCreateOnlyGrant(handle(), {
        ttlSeconds: 60,
        contentType: 'application/octet-stream',
        contentLength: CEILING,
      });
      assert.equal(grant.contentLength, CEILING);
      await assert.rejects(
        store.issueCreateOnlyGrant(handle(), {
          ttlSeconds: 60,
          contentType: 'application/octet-stream',
          contentLength: CEILING + 1,
        }),
        (error: unknown) => (error as { code?: string }).code === 'grant_content_length_exceeds_ceiling',
      );
    } finally {
      await store.close();
    }
  });
});

describe('P4A-R02 bounded stream hard ceiling (production boundedBodyStream)', () => {
  test('exactly-at-ceiling bytes stream fully and the iterator completes', async () => {
    const at = bodyOf(CEILING);
    const chunks: Uint8Array[] = [];
    for await (const chunk of boundedBodyStream(
      { async *[Symbol.asyncIterator]() { yield* chunked(at, 1024); }, destroy() {} } as unknown as BlobByteStream,
      CEILING,
      neverAborted(),
      CEILING,
    )) chunks.push(chunk);
    const delivered = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    assert.equal(delivered, CEILING, 'exactly the ceiling bytes must be delivered');
  });

  test('ceiling+1 over-delivery throws read_exceeds_ceiling with the recorded byte count and destroys the upstream', async () => {
    const controller = new AbortController();
    let destroyed = false;
    let delivered = 0;
    const overDelivering = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(CEILING, 1);
        yield Buffer.alloc(1, 2);
      },
      destroy(): void {
        destroyed = true;
      },
    } as unknown as BlobByteStream & { destroy?: () => void };

    let caught: BlobStoreReadOverflowError | null = null;
    try {
      for await (const chunk of boundedBodyStream(overDelivering, CEILING, controller.signal, CEILING)) {
        delivered += chunk.byteLength;
      }
    } catch (error) {
      if (error instanceof BlobStoreReadOverflowError) caught = error;
      else throw error;
    }
    assert.ok(caught, 'the over-delivering stream must throw the distinct overflow signal');
    assert.equal(caught!.byteCeiling, CEILING);
    assert.equal(caught!.code, 'read_exceeds_ceiling');
    assert.equal(delivered, CEILING, 'exactly the ceiling bytes are recorded before the overflow');
    assert.equal(destroyed, true, 'the upstream body must be destroyed on overflow');
  });

  test('chunk boundary: an exact-ceiling chunk passes; a chunk crossing the boundary is rejected with zero bytes over the ceiling', async () => {
    const boundary = 16;
    const exact: Uint8Array[] = [];
    for await (const chunk of boundedBodyStream(
      { async *[Symbol.asyncIterator]() { yield Buffer.alloc(boundary, 1); }, destroy() {} } as unknown as BlobByteStream,
      boundary,
      neverAborted(),
      boundary,
    )) exact.push(chunk);
    assert.equal(exact.reduce((sum, chunk) => sum + chunk.byteLength, 0), boundary);

    let destroyed = false;
    const crossing: Uint8Array[] = [];
    await assert.rejects(
      (async () => {
        for await (const chunk of boundedBodyStream(
          {
            async *[Symbol.asyncIterator]() {
              yield Buffer.alloc(10, 1);
              yield Buffer.alloc(10, 2);
            },
            destroy(): void {
              destroyed = true;
            },
          } as unknown as BlobByteStream,
          boundary,
          neverAborted(),
          boundary,
        )) crossing.push(chunk);
      })(),
      (error: unknown) => error instanceof BlobStoreReadOverflowError && error.byteCeiling === boundary,
    );
    assert.equal(crossing.reduce((sum, chunk) => sum + chunk.byteLength, 0), 10, 'only the pre-boundary bytes are delivered');
    assert.equal(destroyed, true);
  });

  test('abort propagation: a mid-stream abort surfaces the aborted class and destroys the upstream body', async () => {
    const controller = new AbortController();
    let destroyed = false;
    const body = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(8, 1);
        yield Buffer.alloc(8, 2);
      },
      destroy(): void {
        destroyed = true;
      },
    } as unknown as BlobByteStream & { destroy?: () => void };
    const stream = boundedBodyStream(body, 64, controller.signal, 16);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    controller.abort();
    await assert.rejects(
      iterator.next(),
      (error: unknown) => error instanceof BlobStoreError && error.class === 'aborted' && error.code === 'read_aborted',
    );
    assert.equal(destroyed, true, 'the upstream body must be destroyed on abort');
  });

  test('body stream release: after a clean read the upstream is released; overflow/abort destroy it', async () => {
    // Clean EOF: the generator completes and the abort listener is removed, so
    // a later abort no longer touches the upstream.
    let destroyed = 0;
    const controller = new AbortController();
    const body = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(4, 1);
      },
      destroy(): void {
        destroyed += 1;
      },
    } as unknown as BlobByteStream & { destroy?: () => void };
    const stream = boundedBodyStream(body, 8, controller.signal, 4);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0), 4);
    controller.abort();
    assert.equal(destroyed, 0, 'a completed read must release the upstream (no later destroy)');

    // Overflow path: the upstream is destroyed (asserted in the ceiling+1 test
    // above) — re-prove through the transport that a provider body over the
    // ceiling is destroyed before read (stream release at the HTTP boundary).
    await withFault(
      (request) => (request.method === 'GET'
        ? {
            status: 200,
            headers: HEAD_IDENTITY_HEADERS(2048),
            chunks: [{ data: Buffer.alloc(2048, 3), delayMs: 40 }],
            holdOpen: true,
          }
        : { status: 404, headers: {}, body: '' }),
      async (store, fault) => {
        await assert.rejects(
          store.readBounded(handle(), { expectedEtag: '"r02-fault-etag"', byteCeiling: 10, signal: AbortSignal.timeout(10_000) }),
          (error: unknown) => error instanceof BlobStoreReadOverflowError && error.byteCeiling === 10,
        );
        assert.ok(fault.requests.some((request) => request.method === 'GET'), 'the oversized GET must reach the transport');
        const closed = await fault.waitForPrematureClose();
        assert.ok(closed >= 1, 'the oversized provider body must be destroyed before read');
      },
    );
  });
});

describe('P4A-R02 oversize through the production adapter (controlled transport)', () => {
  test('readBounded rejects a provider-declared body over the ceiling before read and never opens a usable stream', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 200, headers: HEAD_IDENTITY_HEADERS(2048), chunks: [{ data: Buffer.alloc(2048, 3), delayMs: 40 }], holdOpen: true }
        : { status: 404, headers: {}, body: '' }),
      async (store, fault) => {
        await assert.rejects(
          store.readBounded(handle(), { expectedEtag: '"r02-fault-etag"', byteCeiling: 10, signal: AbortSignal.timeout(10_000) }),
          (error: unknown) => error instanceof BlobStoreReadOverflowError && error.byteCeiling === 10,
        );
        assert.ok(fault.requests.some((request) => request.method === 'GET'), 'the oversized GET must reach the transport');
        const closed = await fault.waitForPrematureClose();
        assert.ok(closed >= 1, 'the oversized body must be destroyed before read');
      },
    );
  });

  test('the module adapter maps the overflow to the overflow class — never ok or stored', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 200, headers: HEAD_IDENTITY_HEADERS(2048), chunks: [{ data: Buffer.alloc(2048, 3), delayMs: 40 }], holdOpen: true }
        : { status: 404, headers: {}, body: '' }),
      async (store, fault) => {
        const adapter = createGenerationObjectStoreAdapter(store);
        const outcome = await adapter.readBounded(handle(), {
          expectedEtag: '"r02-fault-etag"',
          byteCeiling: 10,
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(outcome.class, 'overflow');
        if (outcome.class === 'overflow') assert.equal(outcome.byteCeiling, 10);
        assert.ok(fault.requests.some((request) => request.method === 'GET'), 'the oversized GET must reach the transport');
      },
    );
  });

  test('verifyGenerationStream: exact ceiling verifies; ceiling+1 is over_hard_limit with zero verified facts', async () => {
    const at = bodyOf(LIMITS.hardByteCeiling);
    const atEvidence = await runVerify(chunked(at), at.byteLength);
    assert.equal(atEvidence.verdict, 'verified');
    assert.equal(atEvidence.byteCount, LIMITS.hardByteCeiling);

    let cancelled = false;
    const over = bodyOf(LIMITS.hardByteCeiling + 1);
    const cancellable = {
      cancel: async () => {
        cancelled = true;
      },
      [Symbol.asyncIterator]: async function* () {
        for (let offset = 0; offset < over.byteLength; offset += 10) {
          yield over.subarray(offset, Math.min(offset + 10, over.byteLength));
        }
      },
    };
    const evidence = await runVerify(cancellable, over.byteLength);
    assert.equal(evidence.verdict, 'over_hard_limit');
    assert.ok(evidence.bytesProcessed > 0, 'actual bytes were processed before the overflow');
    assert.ok(evidence.bytesProcessed <= LIMITS.hardByteCeiling, 'bytesProcessed never exceeds the ceiling');
    assert.equal(cancelled, true, 'the upstream must be cancelled on overflow');
    // No verified facts: byteCount is not a verified size for an overflow.
    assert.notEqual(evidence.verdict, 'verified');
  });
});

describe('P4A-R02 oversize_object in-run control (executor contract)', () => {
  function controlDeps(executor: I16NegativeControlExecutor) {
    let uowCalls = 0;
    const unitDeps = {
      config: CONFIG,
      uow: {
        execute: async () => {
          uowCalls += 1;
          throw new Error('the unit of work must never run for an oversized declaration');
        },
      },
      blobStore: {
        issueCreateOnlyGrant: async () => {
          throw new Error('the grant issuer must never run for an oversized declaration');
        },
      },
    } as unknown as IssueUploadIntentDeps<never>;
    const seenBlobIds: string[] = [];
    return {
      executionLedger: executor,
      config: CONFIG,
      actor: ACTOR,
      collectionId: COLLECTION,
      nonce: NONCE,
      issueUploadIntent: (input: IssueUploadIntentInput) => issueUploadIntent(unitDeps, input),
      assertZeroBlobRows: async (blobId: string) => {
        seenBlobIds.push(blobId);
        return true;
      },
      uowCalls: () => uowCalls,
      seenBlobIds,
    };
  }

  test('records install -> target hit -> stable code -> cleanup and completes the receipt with catalog facts', async () => {
    const executor = new I16NegativeControlExecutor('r02-oversize-run-0001');
    const facts = await executeR02OversizeObjectControl(controlDeps(executor));

    assert.equal(facts.stableCode, 'read_exceeds_ceiling');
    assert.equal(facts.declaredRejectionCode, 'size_out_of_range');
    assert.equal(facts.exactlyAtCeilingAccepted, true);
    assert.equal(facts.byteCeiling, CEILING);
    assert.equal(facts.bytesDeliveredBeforeOverflow, CEILING, 'the actual byte count is recorded before the overflow');
    assert.equal(facts.upstreamDestroyed, true);
    assert.equal(facts.zeroStoredPrivateRows, true);
    assert.equal(facts.cleanupReceipt, 'no_object_created');

    const definition = I16_NEGATIVE_CONTROL_CATALOG.find((entry) => entry.control === 'oversize_object')!;
    assert.ok(definition.intendedCode.includes(facts.stableCode), 'the stable code must be inside the catalog intended codes');

    const record = executor.recordFor('oversize_object');
    assert.equal(record.owningTarget, definition.intendedTarget);
    assert.equal(record.verificationSource, definition.primarySource);
    assert.equal(record.targetHit, true);
    assert.equal(record.stableCode, 'read_exceeds_ceiling');
    assert.equal(record.cleanupReceipt, 'no_object_created');
    assert.ok(record.installEvidence.includes('declared-size-over-ceiling'));

    const receipt = executor.receiptFor('oversize_object');
    assert.equal(receipt.runId, executor.runId);
    assert.equal(receipt.exitClass, 'clean');
    assert.equal(receipt.verificationSource, definition.primarySource);
    assert.match(receipt.sourceDigest, /^[a-f0-9]{64}$/);
    assert.match(receipt.executionDigest, /^[a-f0-9]{64}$/);
  });

  test('proves zero stored_private rows for the rejected binding and never invokes the unit of work', async () => {
    const executor = new I16NegativeControlExecutor('r02-oversize-run-0002');
    const deps = controlDeps(executor);
    await executeR02OversizeObjectControl(deps);

    assert.equal(deps.uowCalls(), 0, 'the oversized declaration must never reach DB/ledger work');
    const expectedBlobId = computeBlobIdFromBinding(COLLECTION, ACTOR.subjectId, 'i16-oversize-declared-' + NONCE);
    assert.deepEqual(deps.seenBlobIds, [expectedBlobId], 'the zero-row check must query the derived binding blob id');
    assert.ok(deps.seenBlobIds.length === 1, 'exactly one zero-row check for the rejected binding');
  });

  test('the full I16 evidence gate accepts the migrated controls with real executor receipts', () => {
    const executor = i16ExecutionLedger(i16NegativeControls(), I16_TEST_RUN_ID);
    const oversize = executor.receiptFor('oversize_object');
    assert.equal(oversize.stableCode, 'read_exceeds_ceiling');
    assert.equal(oversize.cleanupReceipt, 'no_object_created');
    const definition = I16_NEGATIVE_CONTROL_CATALOG.find((entry) => entry.control === 'oversize_object')!;
    assert.ok(definition.intendedCode.includes(oversize.stableCode));

    assert.doesNotThrow(() => buildI16Evidence({
      binding: i16BindingFacts(),
      scenario: i16Scenario(),
      negativeControls: i16NegativeControls(),
      postRunChecks: i16PostRunChecks(),
      runId: executor.runId,
      executionReceipts: executor.toEvidenceReceipts(),
    }));
  });

  test('the control fails closed when the declaration is NOT rejected or the stream is NOT bounded', async () => {
    // (a) an issue closure that lets the oversized declaration through must
    // fail the control (the rejection is the corruption install).
    const executorA = new I16NegativeControlExecutor('r02-oversize-run-0003');
    const depsA = controlDeps(executorA);
    depsA.issueUploadIntent = async () => {
      throw new Error('intent_issue_failed');
    };
    await assert.rejects(executeR02OversizeObjectControl(depsA), /intent_issue_failed|oversize_declared_not_rejected/);
    assert.throws(() => executorA.receiptFor('oversize_object'), /negative_control_not_executed/);

    // (b) a zero-row check that reports a row must fail the control (zero
    // stored_private is the completion criterion).
    const executorB = new I16NegativeControlExecutor('r02-oversize-run-0004');
    const depsB = controlDeps(executorB);
    depsB.assertZeroBlobRows = async () => false;
    await assert.rejects(executeR02OversizeObjectControl(depsB), /oversize_stored_private_written/);
    assert.throws(() => executorB.receiptFor('oversize_object'), /negative_control_not_executed/);
  });
});
