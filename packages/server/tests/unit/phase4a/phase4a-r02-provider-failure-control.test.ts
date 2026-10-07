/**
 * P4A-R02 contract suite: the `provider_throttle_timeout` negative control.
 *
 * Covers the provider failure-classification matrix (plan §6 P4A-R02, §4.3
 * mutation control "429/timeout 归类为 permanent/denied"): 429, 5xx,
 * connection timeout, connection drop, denied, not-found and unknown-status
 * responses are served by a CONTROLLED transport and observed through the
 * PRODUCTION I06 adapter (`R2GenerationStore` + `@aws-sdk` real HTTP
 * exchange) and the PRODUCTION module adapter (`GenerationObjectStorePort`),
 * plus the I01 `classifyProviderFailure` cross-check on the observed provider
 * status. Every observation is preceded by the recorded deterministic
 * per-run request marker (the key embedded in the request path) and the
 * served status; classifications are mutually exclusive — transient inputs
 * are never permanent, permanent inputs are never transient, and unknown
 * stays unknown. Timeouts use a controllable AbortSignal barrier, never
 * public-network jitter.
 *
 * The in-run control (`executeR02ProviderThrottleTimeoutControl`) additionally
 * proves the adapter happy path BEFORE and AFTER the fault phase on the same
 * store in the same run, deletes and confirms absence, and completes the
 * fixed executor contract with the catalog facts.
 *
 * No PostgreSQL, no browser, no real R2.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  BlobStoreError,
  createGenerationObjectStoreAdapter,
  createR2GenerationStore,
} from '../../../src/infrastructure/object-storage/index.js';
import type {
  BlobStorePort,
  GenerationHandle,
} from '../../../src/infrastructure/object-storage/index.js';
import type { GenerationObjectStorePort } from '../../../src/modules/attachments/index.js';
import {
  I16_NEGATIVE_CONTROL_CATALOG,
  I16NegativeControlExecutor,
  assertCompleteNegativeControls,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  executeR02ProviderThrottleTimeoutControl,
  r02ProviderFaultScript,
} from '../../../scripts/evidence/phase4a-r02-controls.js';
import {
  r02S3ErrorBody,
  startR02FaultTransport,
} from '../../../scripts/evidence/phase4a-r02-fault-transport.js';
import type {
  R02FaultScript,
  R02FaultTransport,
} from '../../../scripts/evidence/phase4a-r02-fault-transport.js';
import {
  i16Config,
  i16ExecutionEvidence,
  i16ExecutionLedger,
  i16NegativeControls,
} from '../../support/phase4a-i16-test-helpers.js';

const CONFIG = i16Config();
const NONCE = 'r02-provider-nonce-0001';
const FAULT_ETAG = '"r02-fault-etag"';
const READ_CEILING = CONFIG.singlePutMaxBytes;

type FaultKind = 'http-429' | 'http-5xx' | 'connection-timeout' | 'connection-drop' | 'denied' | 'not-found' | 'unknown-status';

interface FaultExpectation {
  readonly read: boolean;
  readonly module: readonly string[];
  readonly blobStore: readonly string[];
  readonly served: readonly number[];
}

const EXPECTED: Readonly<Record<FaultKind, FaultExpectation>> = {
  'http-429': { read: true, module: ['retryable'], blobStore: ['retryable'], served: [429] },
  'http-5xx': { read: true, module: ['retryable'], blobStore: ['retryable'], served: [500] },
  'connection-timeout': { read: true, module: ['retryable'], blobStore: ['aborted', 'retryable'], served: [0] },
  'connection-drop': { read: true, module: ['retryable', 'unknown'], blobStore: ['retryable', 'unknown'], served: [0] },
  denied: { read: false, module: ['denied'], blobStore: ['denied'], served: [403] },
  'not-found': { read: false, module: ['not_found'], blobStore: ['not_found'], served: [404] },
  'unknown-status': { read: false, module: ['unknown'], blobStore: ['unknown'], served: [400] },
};

const TRANSIENT_FAULTS: readonly FaultKind[] = [
  'http-429', 'http-5xx', 'connection-timeout', 'connection-drop', 'unknown-status',
];
const PERMANENT_CLASSES = ['denied', 'not_found', 'etag_mismatch', 'precondition', 'contract_drift', 'ok'];

function storeOptions(endpoint: string) {
  return {
    endpoint,
    region: 'auto',
    bucket: CONFIG.r2.bucket,
    livePrefix: CONFIG.r2.livePrefix,
    probePrefix: 'capability-probes/r02/',
    rwCredential: { accessKeyId: 'r02-fault-write-access-key-0001', secretAccessKey: 'r02-fault-write-secret-marker-0001' }, // secret-scan: allow 'r02-fault-write-secret-marker-0001'
    roCredential: { accessKeyId: 'r02-fault-read-access-key-0001', secretAccessKey: 'r02-fault-read-secret-marker-0001' }, // secret-scan: allow 'r02-fault-read-secret-marker-0001'
    grantTtlSeconds: CONFIG.grantTtlSeconds,
    singlePutMaxBytes: READ_CEILING,
  };
}

function faultKey(kind: FaultKind): string {
  return `${CONFIG.r2.livePrefix}r02-provider-fault-${kind}-${NONCE}`;
}

function handleFor(kind: FaultKind): GenerationHandle {
  return { generationId: `r02-matrix-${kind}-${NONCE}`, key: faultKey(kind) };
}

/** One scripted fault kind served by the transport for the marker key. */
function scriptFor(kind: FaultKind): R02FaultScript {
  return (request) => {
    if (request.path.includes(`r02-provider-fault-${kind}-${NONCE}`)) {
      switch (kind) {
        case 'http-429': return { status: 429, headers: {}, body: r02S3ErrorBody('SlowDown') };
        case 'http-5xx': return { status: 500, headers: {}, body: r02S3ErrorBody('InternalError') };
        case 'connection-timeout': return { status: 200, headers: {}, holdSilent: true };
        case 'connection-drop': return { status: 200, headers: {}, dropConnection: true };
        case 'denied': return { status: 403, headers: {}, body: r02S3ErrorBody('AccessDenied') };
        case 'not-found': return { status: 404, headers: {}, body: r02S3ErrorBody('NoSuchKey') };
        case 'unknown-status': return { status: 400, headers: {}, body: r02S3ErrorBody('InvalidRequest') };
      }
    }
    return { status: 404, headers: {}, body: '' };
  };
}

async function withFault(
  script: R02FaultScript,
  run: (store: BlobStorePort, adapter: GenerationObjectStorePort, fault: R02FaultTransport) => Promise<void>,
): Promise<void> {
  const fault = await startR02FaultTransport(script);
  const store = createR2GenerationStore(storeOptions(fault.url));
  const adapter = createGenerationObjectStoreAdapter(store);
  try {
    await run(store, adapter, fault);
  } finally {
    await adapter.close();
    await store.close();
    await fault.close();
  }
}

async function observeKind(
  store: BlobStorePort,
  adapter: GenerationObjectStorePort,
  fault: R02FaultTransport,
  kind: FaultKind,
  timeoutMs = 150,
): Promise<{ blobStoreClass: string; moduleClass: string; reached: boolean; served: number }> {
  const handle = handleFor(kind);
  let blobStoreClass: string;
  let moduleClass: string;
  if (EXPECTED[kind]!.read) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('r02 controlled timeout barrier')), timeoutMs);
    try {
      try {
        const read = await store.readBounded(handle, { expectedEtag: FAULT_ETAG, byteCeiling: READ_CEILING, signal: controller.signal });
        blobStoreClass = read.found ? 'ok' : 'not_found';
      } catch (error) {
        blobStoreClass = error instanceof BlobStoreError ? error.class : 'unknown';
      }
      const moduleOutcome = await adapter.readBounded(handle, {
        expectedEtag: FAULT_ETAG,
        byteCeiling: READ_CEILING,
        signal: controller.signal,
      });
      moduleClass = moduleOutcome.class;
    } finally {
      clearTimeout(timer);
    }
  } else {
    try {
      const head = await store.headExact(handle);
      blobStoreClass = head.found ? 'ok' : 'not_found';
    } catch (error) {
      blobStoreClass = error instanceof BlobStoreError ? error.class : 'unknown';
    }
    const headOutcome = await adapter.headExact(handle);
    moduleClass = headOutcome.class;
  }
  const matched = fault.requests.filter((request) => request.path.includes(faultKey(kind)));
  return {
    blobStoreClass,
    moduleClass,
    reached: matched.length >= 1,
    served: matched.length > 0 ? matched[matched.length - 1]!.status : 0,
  };
}

describe('P4A-R02 provider failure classification matrix (production adapter over controlled transport)', () => {
  for (const kind of Object.keys(EXPECTED) as FaultKind[]) {
    test(`${kind} classifies through the production adapter with the marker recorded at the transport`, async () => {
      await withFault(scriptFor(kind), async (store, adapter, fault) => {
        const observed = await observeKind(store, adapter, fault, kind);
        assert.equal(observed.reached, true, 'the fault must reach the transport before the outcome is asserted');
        assert.ok(EXPECTED[kind]!.served.includes(observed.served), `served status ${observed.served} for ${kind}`);
        assert.ok(EXPECTED[kind]!.blobStore.includes(observed.blobStoreClass),
          `blob-store class ${observed.blobStoreClass} for ${kind}`);
        assert.ok(EXPECTED[kind]!.module.includes(observed.moduleClass),
          `module class ${observed.moduleClass} for ${kind}`);
      });
    });
  }

  test('transient provider responses are never permanent, permanent ones are never transient (mutual exclusion)', async () => {
    await withFault(r02ProviderFaultScript(NONCE), async (store, adapter, fault) => {
      for (const kind of Object.keys(EXPECTED) as FaultKind[]) {
        const observed = await observeKind(store, adapter, fault, kind);
        assert.equal(observed.reached, true, `${kind} must reach the transport`);
        if (TRANSIENT_FAULTS.includes(kind)) {
          assert.ok(!PERMANENT_CLASSES.includes(observed.moduleClass),
            `${kind} must never be written as a permanent class, got ${observed.moduleClass}`);
          assert.ok(!PERMANENT_CLASSES.includes(observed.blobStoreClass),
            `${kind} must never be a permanent blob-store class, got ${observed.blobStoreClass}`);
        } else if (kind === 'denied') {
          assert.equal(observed.moduleClass, 'denied', 'denied must stay denied, never retryable/unknown');
          assert.equal(observed.blobStoreClass, 'denied');
        } else if (kind === 'not-found') {
          assert.equal(observed.moduleClass, 'not_found', 'not-found must stay not_found, never retryable');
          assert.equal(observed.blobStoreClass, 'not_found');
        } else {
          assert.equal(observed.moduleClass, 'unknown', 'unknown-status must stay unknown, never denied');
          assert.equal(observed.blobStoreClass, 'unknown');
        }
      }
    });
  });

  test('the connection timeout uses a controllable AbortSignal barrier, not wall-clock jitter', async () => {
    await withFault(scriptFor('connection-timeout'), async (store, adapter, fault) => {
      const controller = new AbortController();
      const started = Date.now();
      const readPromise = store.readBounded(handleFor('connection-timeout'), {
        expectedEtag: FAULT_ETAG,
        byteCeiling: READ_CEILING,
        signal: controller.signal,
      });
      await waitForCondition(
        () => fault.requests.some((request) => request.path.includes(faultKey('connection-timeout'))),
        { timeoutMs: 2_000, description: 'the controlled timeout request to reach the local provider' },
      );
      controller.abort(new Error('r02 controlled timeout barrier'));
      await assert.rejects(
          readPromise,
          (error: unknown) => error instanceof BlobStoreError
            && (error.class === 'aborted' || error.class === 'retryable')
            && error.class !== 'denied' && error.class !== 'not_found',
      );
      // A second drive with the already-aborted signal rejects immediately
      // (never hangs on the public network) and stays transient at the module
      // boundary.
      const moduleOutcome = await adapter.readBounded(handleFor('connection-timeout'), {
        expectedEtag: FAULT_ETAG,
        byteCeiling: READ_CEILING,
        signal: controller.signal,
      });
      assert.equal(moduleOutcome.class, 'retryable');
      assert.ok(Date.now() - started < 5000, 'the barrier must bound the observation');
    });
  });
});

describe('P4A-R02 provider_throttle_timeout in-run control (executor contract)', () => {
  /** Stateful happy transport: real PUT/HEAD/DELETE exchanges with the store. */
  async function withHappyStore(
    run: (store: BlobStorePort, transport: R02FaultTransport, objects: Map<string, { body: Buffer; etag: string }>) => Promise<void>,
  ): Promise<void> {
    const objects = new Map<string, { body: Buffer; etag: string }>();
    const script: R02FaultScript = (request) => {
      const key = (request.path.split('?')[0] ?? '').split('/').slice(2).join('/');
      if (request.method === 'PUT') {
        objects.set(key, { body: request.body, etag: '"r02-happy-etag"' });
        return { status: 200, headers: { etag: '"r02-happy-etag"' }, body: '' };
      }
      if (request.method === 'HEAD') {
        const object = objects.get(key);
        return object
          ? { status: 200, headers: { 'content-length': String(object.body.byteLength), etag: object.etag }, body: '' }
          : { status: 404, headers: {}, body: '' };
      }
      if (request.method === 'DELETE') {
        objects.delete(key);
        return { status: 204, headers: {}, body: '' };
      }
      return { status: 404, headers: {}, body: '' };
    };
    const transport = await startR02FaultTransport(script);
    const store = createR2GenerationStore(storeOptions(transport.url));
    try {
      await run(store, transport, objects);
    } finally {
      await store.close();
      await transport.close();
    }
  }

  function controlDeps(executor: I16NegativeControlExecutor, realStore: BlobStorePort, extra: {
    readonly candidates?: GenerationHandle[];
    readonly forbiddenValues?: string[];
    readonly timeoutMs?: number;
    readonly script?: R02FaultScript;
  } = {}) {
    return {
      executionLedger: executor,
      config: CONFIG,
      nonce: NONCE,
      realStore,
      candidates: extra.candidates ?? [],
      forbiddenValues: extra.forbiddenValues ?? [],
      script: extra.script,
      timeoutMs: extra.timeoutMs ?? 200,
    };
  }

  test('proves happy-before -> fault matrix -> happy-after -> cleanup and completes the receipt', async () => {
    const executor = new I16NegativeControlExecutor('r02-provider-run-0001');
    const candidates: GenerationHandle[] = [];
    const forbiddenValues: string[] = [];
    await withHappyStore(async (store, transport, objects) => {
      const facts = await executeR02ProviderThrottleTimeoutControl(
        controlDeps(executor, store, { candidates, forbiddenValues }),
      );

      assert.equal(facts.stableCode, 'not_misclassified');
      assert.equal(facts.happyBefore.found, true, 'the adapter must work on the happy path BEFORE the faults');
      assert.ok(facts.happyBefore.size > 0);
      assert.equal(facts.happyAfter.found, true, 'the adapter must still work AFTER the faults');
      assert.equal(facts.happyAfter.size, facts.happyBefore.size);
      assert.equal(facts.cleanupReceipt, 'confirmed_absent');

      assert.equal(facts.observations.length, 7);
      const byFault = new Map(facts.observations.map((observation) => [observation.fault, observation]));
      for (const kind of Object.keys(EXPECTED) as FaultKind[]) {
        const observation = byFault.get(kind)!;
        assert.ok(observation, `observation for ${kind}`);
        assert.equal(observation.requestReachedTransport, true, `${kind} must be recorded at the transport`);
        assert.ok(observation.requestMarker.includes(`r02-provider-fault-${kind}-${NONCE}`),
          `${kind} must carry the deterministic per-run marker`);
        assert.ok(EXPECTED[kind]!.served.includes(observation.servedStatus), `${kind} served ${observation.servedStatus}`);
        assert.ok(EXPECTED[kind]!.module.includes(observation.moduleClass), `${kind} module ${observation.moduleClass}`);
        assert.ok(EXPECTED[kind]!.blobStore.includes(observation.blobStoreClass), `${kind} blob-store ${observation.blobStoreClass}`);
      }
      // both catalog transient codes are observed
      assert.ok(facts.observations.some((observation) => observation.moduleClass === 'retryable'));
      assert.ok(facts.observations.some((observation) => observation.moduleClass === 'unknown'));

      assert.equal(objects.size, 0, 'the happy object must be deleted and confirmed absent');

      const definition = I16_NEGATIVE_CONTROL_CATALOG.find((entry) => entry.control === 'provider_throttle_timeout')!;
      assert.ok(definition.intendedCode.includes(facts.stableCode));
      const record = executor.recordFor('provider_throttle_timeout');
      assert.equal(record.owningTarget, definition.intendedTarget);
      assert.equal(record.verificationSource, definition.primarySource);
      assert.equal(record.targetHit, true);
      assert.equal(record.stableCode, 'not_misclassified');
      assert.equal(record.cleanupReceipt, 'confirmed_absent');
      const receipt = executor.receiptFor('provider_throttle_timeout');
      assert.equal(receipt.runId, executor.runId);
      assert.equal(receipt.exitClass, 'clean');
      assert.equal(receipt.verificationSource, definition.primarySource);
    });

    assert.equal(candidates.length, 1, 'the happy handle must be registered for run cleanup');
    assert.equal(forbiddenValues.length, 1, 'the happy key must be registered as a forbidden evidence value');
  });

  test('the full I16 evidence gate accepts the migrated provider receipt', () => {
    const executor = i16ExecutionLedger(i16NegativeControls(), 'r02-provider-gate-run');
    const provider = executor.receiptFor('provider_throttle_timeout');
    assert.equal(provider.stableCode, 'not_misclassified');
    assert.equal(provider.cleanupReceipt, 'confirmed_absent');
    assert.doesNotThrow(() => assertCompleteNegativeControls(
      i16NegativeControls(),
      i16ExecutionEvidence(i16NegativeControls(), executor.runId),
    ));
  });

  test('the control fails closed when a transient provider response is misclassified', async () => {
    const executor = new I16NegativeControlExecutor('r02-provider-run-0002');
    const badScript: R02FaultScript = (request) => {
      if (request.path.includes('r02-provider-fault-http-429-' + NONCE)) {
        // A 200 "success" for the throttled key: transient must never be
        // treated as a successful read (which would write stored facts).
        return { status: 200, headers: { 'content-length': '4', etag: 'r02-wrong-etag' }, body: 'ok!!' };
      }
      return r02ProviderFaultScript(NONCE)(request);
    };
    await withHappyStore(async (store) => {
      await assert.rejects(
        executeR02ProviderThrottleTimeoutControl(
          controlDeps(executor, store, { script: badScript }),
        ),
        // The scripted 200-instead-of-429 corruption can fail the control at
        // the served-status check or the class check; both are stable
        // fail-closed codes and both must leave the receipt unissued.
        /provider_fault_(misclassified|served_status_mismatch)/,
      );
    });
    assert.throws(() => executor.receiptFor('provider_throttle_timeout'), /negative_control_not_executed/);
  });
});
