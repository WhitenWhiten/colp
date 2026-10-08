/**
 * P1-11 Publisher internal mutation harness unit tests (in-memory ports).
 *
 * Production surface (modules/publisher public index):
 *   executePublisherCanonicalMutationHarness(ports, context, input)
 *     → executed | replay | in_progress | reused
 *   admitPublisherMutation(idempotency, { binding, fingerprint, execute })
 *   createMemoryPublisherIdempotencyPort(store?)
 *   publisherMutationFingerprint / projectPublisherInternalResult
 *   buildPublisherProductIsolationProbe / publisherProductReceiptIsolationContract
 *
 * Binding UNIQUE (fingerprint excluded from winner key):
 *   namespace + principalId + idempotencyKey
 *
 * Isolation:
 *   publisher_idempotency ≠ product_command_receipts
 *   Same string key/commandId must not collide across stores.
 *   Publisher admits Operation ID; Canonical Mutation does not re-own it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CANONICAL_MUTATION_WRITE_ORDER,
  createCanonicalMutationApplication,
  type AllocatedMutationState,
  type CanonicalMutationApplication,
  type CanonicalMutationInput,
  type CanonicalMutationPlan,
  type CanonicalMutationPorts,
  type LockedCollectionState,
} from '../../../src/modules/collections/index.js';
import {
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import {
  PRODUCT_COMMAND_RECEIPT_TABLE,
  PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE,
  PUBLISHER_IDEMPOTENCY_TABLE,
  PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
  PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION,
  PUBLISHER_PRINCIPAL_TYPE,
  createMemoryPublisherIdempotencyPort,
  executePublisherCanonicalMutationHarness,
  projectPublisherInternalResult,
  publisherCanonicalJson,
  publisherMutationFingerprint,
  publisherProductReceiptIsolationContract,
  buildPublisherProductIsolationProbe,
  type ExecutePublisherCanonicalMutationInput,
  type ExecutePublisherCanonicalMutationResult,
  type MemoryPublisherReceipt,
  type PublisherCanonicalMutationHarnessPorts,
  type PublisherIdempotencyBinding,
} from '../../../src/modules/publisher/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Tx = { readonly id: string };

const PRINCIPAL_A = 'principal-publisher-a';
const PRINCIPAL_B = 'principal-publisher-b';
const PRODUCT_PRINCIPAL = 'principal-product-a';

const NAMESPACE_A = 'colp.publisher.v0.1.nodes.update';
const NAMESPACE_B = 'colp.publisher.v0.1.collections.patch';
const IDEMPOTENCY_KEY = 'idem-key-shared-string';

const COLLECTION_ID = 'collection-pub-1';
const RESOURCE_ID = 'resource-pub-1';
const OTHER_RESOURCE_ID = 'resource-pub-2';
const OPERATION_ID = 'op-publisher-1';
const PRODUCT_OPERATION_ID = 'op-product-1';

const locked: LockedCollectionState = {
  collectionId: COLLECTION_ID,
  currentCommitOrdinal: 4n,
  resourceRevision: 'r-4',
  contentRevision: 'c-4',
  policyRevision: 'p-4',
};

const allocation: AllocatedMutationState = {
  commitOrdinal: 5n,
  resourceRevision: 'r-5',
  childrenRevisions: {},
  positionToken: 'pos-5',
};

function binding(
  overrides: Partial<PublisherIdempotencyBinding> = {},
): PublisherIdempotencyBinding {
  return {
    namespace: NAMESPACE_A,
    principalId: PRINCIPAL_A,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function basePayload(title = 'publisher-title'): Readonly<Record<string, unknown>> {
  return { title, kind: 'note' };
}

function mutationFields(resourceId = RESOURCE_ID, title = 'publisher-title') {
  return {
    action: 'update' as const,
    target: {
      collectionId: COLLECTION_ID,
      resourceId,
      resourceKind: 'note',
    },
    parentId: null as string | null,
    fields: {
      kindFields: { title },
      extensions: {},
    },
  };
}

function planFor(admitted: CanonicalMutationInput): CanonicalMutationPlan {
  return {
    operationId: admitted.operationId,
    collectionId: admitted.collectionId,
    mutation: {
      ...admitted.mutation,
      revisionEffects: { resource: true, content: false, policy: false, childrenOf: [] },
    },
  };
}

function baseInput(
  overrides: Partial<ExecutePublisherCanonicalMutationInput> = {},
): ExecutePublisherCanonicalMutationInput {
  const { binding: bindingOverrides, mutation: mutationOverrides, ...rest } = overrides;
  return {
    payload: basePayload(),
    collectionId: COLLECTION_ID,
    operationId: OPERATION_ID,
    ...rest,
    binding: {
      ...binding(),
      ...bindingOverrides,
    },
    mutation: {
      ...mutationFields(),
      ...mutationOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------

interface MutationMemoryState {
  mutationCalls: number;
  canonicalCalls: string[];
  operationsAppended: string[];
  seenTransactions: Tx[];
  failAfter?: 'mutation';
  publisherStore: Map<string, MemoryPublisherReceipt>;
}

function createState(overrides: Partial<MutationMemoryState> = {}): MutationMemoryState {
  return {
    mutationCalls: 0,
    canonicalCalls: [],
    operationsAppended: [],
    seenTransactions: [],
    publisherStore: new Map(),
    ...overrides,
  };
}

function createCanonicalApplication(
  state: MutationMemoryState,
  overrides: {
    readonly failAt?: 'resource' | 'operation' | 'audit' | 'outbox';
    readonly locked?: LockedCollectionState | null;
  } = {},
): CanonicalMutationApplication<Tx> {
  const failure = new Error(`injected fault at canonical ${overrides.failAt ?? 'none'}`);
  const ports: CanonicalMutationPorts<Tx> = {
    collectionLock: {
      async lockForCanonicalMutation(tx, collectionId) {
        state.seenTransactions.push(tx);
        state.canonicalCalls.push('collection-lock');
        if (overrides.locked === null) return null;
        const row = overrides.locked ?? locked;
        assert.equal(collectionId, row.collectionId);
        return row;
      },
    },
    planner: {
      async planCanonicalMutation(tx, admitted) {
        state.seenTransactions.push(tx);
        state.canonicalCalls.push('canonical-plan');
        return planFor(admitted);
      },
    },
    allocator: {
      async allocate(tx) {
        state.seenTransactions.push(tx);
        state.canonicalCalls.push('allocation');
        return allocation;
      },
    },
    resources: {
      async applyCanonicalMutation(tx) {
        state.seenTransactions.push(tx);
        state.canonicalCalls.push('resource');
        state.mutationCalls += 1;
        if (overrides.failAt === 'resource' || state.failAfter === 'mutation') {
          throw state.failAfter === 'mutation'
            ? new Error('injected fault at publisher mutation')
            : failure;
        }
      },
    },
    operations: {
      async appendCanonicalOperation(tx, operation) {
        state.seenTransactions.push(tx);
        state.canonicalCalls.push('operation');
        state.operationsAppended.push(operation.operationId);
        if (overrides.failAt === 'operation') throw failure;
      },
    },
    audit: {
      async appendAuditEvent(tx) {
        state.seenTransactions.push(tx);
        state.canonicalCalls.push('audit');
        if (overrides.failAt === 'audit') throw failure;
      },
    },
    outbox: {
      async appendDomainEvents(tx) {
        state.seenTransactions.push(tx);
        state.canonicalCalls.push('outbox');
        if (overrides.failAt === 'outbox') throw failure;
      },
    },
  };
  return createCanonicalMutationApplication(ports);
}

function buildPorts(state: MutationMemoryState): PublisherCanonicalMutationHarnessPorts<Tx> {
  return {
    publisherIdempotency: createMemoryPublisherIdempotencyPort(state.publisherStore),
    canonical: createCanonicalApplication(state),
  };
}

function cloneState(state: MutationMemoryState): MutationMemoryState {
  return {
    mutationCalls: state.mutationCalls,
    canonicalCalls: [...state.canonicalCalls],
    operationsAppended: [...state.operationsAppended],
    seenTransactions: [...state.seenTransactions],
    failAfter: state.failAfter,
    publisherStore: new Map(
      [...state.publisherStore.entries()].map(([k, v]) => [
        k,
        {
          fingerprint: v.fingerprint,
          status: v.status,
          result: v.result
            ? {
                status: v.result.status,
                body: v.result.body.slice(),
                stableHeaders: { ...v.result.stableHeaders },
                mediaType: v.result.mediaType,
                contractVersion: v.result.contractVersion,
                targetIdentity: v.result.targetIdentity,
              }
            : undefined,
        },
      ]),
    ),
  };
}

function restoreState(target: MutationMemoryState, snapshot: MutationMemoryState): void {
  target.mutationCalls = snapshot.mutationCalls;
  target.canonicalCalls = snapshot.canonicalCalls;
  target.operationsAppended = snapshot.operationsAppended;
  target.seenTransactions = snapshot.seenTransactions;
  target.failAfter = snapshot.failAfter;
  target.publisherStore.clear();
  for (const [k, v] of snapshot.publisherStore) {
    target.publisherStore.set(k, v);
  }
}

async function withUowRollback<T>(
  state: MutationMemoryState,
  work: () => Promise<T>,
): Promise<T> {
  const snapshot = cloneState(state);
  try {
    return await work();
  } catch (error) {
    restoreState(state, snapshot);
    throw error;
  }
}

function assertExecuted(
  outcome: ExecutePublisherCanonicalMutationResult,
): Extract<ExecutePublisherCanonicalMutationResult, { kind: 'executed' }> {
  assert.equal(outcome.kind, 'executed', `expected executed, got ${outcome.kind}`);
  return outcome as Extract<ExecutePublisherCanonicalMutationResult, { kind: 'executed' }>;
}

// ---------------------------------------------------------------------------
// Product receipt memory (isolation partner)
// ---------------------------------------------------------------------------

interface ProductReceiptRow {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
}

function productKey(b: ProductCommandBinding): string {
  return `${b.principalId}\0${b.commandScope}\0${b.commandId}`;
}

function createMemoryProductReceipts(
  store: Map<string, ProductReceiptRow>,
): ProductCommandReceiptPort & { claims: number; completes: number } {
  const port = {
    claims: 0,
    completes: 0,
    async claim(b: ProductCommandBinding, fingerprint: string): Promise<ProductCommandClaim> {
      port.claims += 1;
      const key = productKey(b);
      const existing = store.get(key);
      if (!existing) {
        store.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      assert.ok(existing.result);
      return { kind: 'replay', result: existing.result };
    },
    async complete(
      b: ProductCommandBinding,
      fingerprint: string,
      result: ProductCommandResult,
    ): Promise<void> {
      port.completes += 1;
      const key = productKey(b);
      const existing = store.get(key);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new Error('product complete without matching claim');
      }
      existing.status = 'completed';
      existing.result = {
        status: result.status,
        body: result.body.slice(),
        stableHeaders: { ...result.stableHeaders },
        mediaType: result.mediaType,
        contractVersion: result.contractVersion,
        targetIdentity: result.targetIdentity,
      };
    },
    async purgeExpired() {
      return 0;
    },
    async deletePrincipalReceipts() {
      return 0;
    },
  };
  return port;
}

// ---------------------------------------------------------------------------
// Fingerprint + internal result contract
// ---------------------------------------------------------------------------

describe('publisherMutationFingerprint', () => {
  test('includes namespace, principal, resource identity and payload with canonical key order', () => {
    const first = publisherMutationFingerprint({
      namespace: NAMESPACE_A,
      principalId: PRINCIPAL_A,
      principalType: PUBLISHER_PRINCIPAL_TYPE,
      resource: {
        collectionId: COLLECTION_ID,
        resourceId: RESOURCE_ID,
        resourceKind: 'note',
      },
      payload: { title: 'Known', kind: 'note' },
    });
    const same = publisherMutationFingerprint({
      namespace: NAMESPACE_A,
      principalId: PRINCIPAL_A,
      principalType: PUBLISHER_PRINCIPAL_TYPE,
      resource: {
        collectionId: COLLECTION_ID,
        resourceId: RESOURCE_ID,
        resourceKind: 'note',
      },
      payload: { kind: 'note', title: 'Known' },
    });
    assert.equal(first, same);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  test('changes when namespace, principal, resource, or payload differs', () => {
    const base = {
      namespace: NAMESPACE_A,
      principalId: PRINCIPAL_A,
      principalType: PUBLISHER_PRINCIPAL_TYPE,
      resource: {
        collectionId: COLLECTION_ID,
        resourceId: RESOURCE_ID,
        resourceKind: 'note',
      },
      payload: { title: 'Known' },
    } as const;
    const fingerprint = publisherMutationFingerprint(base);

    for (const changed of [
      { ...base, namespace: NAMESPACE_B },
      { ...base, principalId: PRINCIPAL_B },
      {
        ...base,
        resource: { ...base.resource, resourceId: OTHER_RESOURCE_ID },
      },
      { ...base, payload: { title: 'Changed' } },
    ]) {
      assert.notEqual(publisherMutationFingerprint(changed), fingerprint);
    }
  });
});

describe('projectPublisherInternalResult / response replay contract', () => {
  test('projects allocation into deterministic internal contract without HTTP status headers', () => {
    const contract = projectPublisherInternalResult({
      operationId: OPERATION_ID,
      collectionId: COLLECTION_ID,
      resourceId: RESOURCE_ID,
      action: 'update',
      allocation,
    });
    assert.equal(contract.schemaVersion, PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION);
    assert.equal(contract.mediaType, PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE);
    assert.equal(contract.outcome, 'applied');
    assert.equal(contract.operationId, OPERATION_ID);
    assert.equal(contract.allocation.commitOrdinal, '5');
    assert.equal(contract.allocation.resourceRevision, 'r-5');
    assert.equal(contract.allocation.positionToken, 'pos-5');
    assert.equal('status' in contract, false);
    assert.equal('headers' in contract, false);
    assert.equal(
      publisherCanonicalJson(contract),
      publisherCanonicalJson({
        action: 'update',
        allocation: {
          childrenRevisions: {},
          commitOrdinal: '5',
          positionToken: 'pos-5',
          resourceRevision: 'r-5',
        },
        collectionId: COLLECTION_ID,
        mediaType: PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
        operationId: OPERATION_ID,
        outcome: 'applied',
        resourceId: RESOURCE_ID,
        schemaVersion: PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Isolation contract
// ---------------------------------------------------------------------------

describe('publisher / product receipt isolation contract', () => {
  test('tables and primary keys are disjoint', () => {
    const contract = publisherProductReceiptIsolationContract();
    assert.equal(contract.productTable, PRODUCT_COMMAND_RECEIPT_TABLE);
    assert.equal(contract.publisherTable, PUBLISHER_IDEMPOTENCY_TABLE);
    assert.equal(contract.sharedTables, false);
    assert.equal(contract.nestedTransactions, false);
    assert.notEqual(contract.productTable, contract.publisherTable);
    assert.deepEqual(contract.publisherPrimaryKey, [
      'namespace',
      'principal_id',
      'idempotency_key',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Namespace / principal / resource isolation
// ---------------------------------------------------------------------------

describe('executePublisherCanonicalMutationHarness: namespace isolation', () => {
  test('different principal, namespace, or idempotency key isolate the same logical key material', async () => {
    const state = createState();
    const ports = buildPorts(state);
    const tx = { id: 'tx-1' };

    assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: tx },
        baseInput({ operationId: 'op-ns-1' }),
      ),
    );
    assert.equal(state.mutationCalls, 1);

    const variants: PublisherIdempotencyBinding[] = [
      binding({ principalId: PRINCIPAL_B }),
      binding({ namespace: NAMESPACE_B }),
      binding({ idempotencyKey: 'other-idem-key' }),
    ];

    let index = 0;
    for (const b of variants) {
      index += 1;
      const outcome = assertExecuted(
        await executePublisherCanonicalMutationHarness(
          ports,
          { transaction: tx },
          baseInput({ binding: b, operationId: `op-ns-variant-${index}` }),
        ),
      );
      assert.equal(outcome.operationId, `op-ns-variant-${index}`);
    }

    assert.equal(state.mutationCalls, 1 + variants.length);
    assert.equal(state.publisherStore.size, 1 + variants.length);
  });

  test('same binding + different payload fingerprint → reused without mutation', async () => {
    const state = createState();
    const ports = buildPorts(state);
    const tx = { id: 'tx-1' };

    assertExecuted(
      await executePublisherCanonicalMutationHarness(ports, { transaction: tx }, baseInput()),
    );
    const afterFirst = state.mutationCalls;

    const reused = await executePublisherCanonicalMutationHarness(
      ports,
      { transaction: tx },
      baseInput({
        payload: basePayload('different-title'),
        operationId: 'op-should-not-run',
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.mutationCalls, afterFirst);
    assert.equal(state.operationsAppended.includes('op-should-not-run'), false);
  });

  test('same binding + different resource identity fingerprint → reused without mutation', async () => {
    const state = createState();
    const ports = buildPorts(state);
    const tx = { id: 'tx-1' };

    assertExecuted(
      await executePublisherCanonicalMutationHarness(ports, { transaction: tx }, baseInput()),
    );
    const afterFirst = state.mutationCalls;

    const reused = await executePublisherCanonicalMutationHarness(
      ports,
      { transaction: tx },
      baseInput({
        mutation: mutationFields(OTHER_RESOURCE_ID),
        operationId: 'op-other-resource',
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.mutationCalls, afterFirst);
  });
});

// ---------------------------------------------------------------------------
// Exact replay
// ---------------------------------------------------------------------------

describe('executePublisherCanonicalMutationHarness: exact replay', () => {
  test('same binding + same payload returns exact body/contract and does not re-mutate', async () => {
    const state = createState();
    const ports = buildPorts(state);
    const tx = { id: 'tx-replay' };
    const input = baseInput();

    const first = assertExecuted(
      await executePublisherCanonicalMutationHarness(ports, { transaction: tx }, input),
    );
    const writeOrderAfterFirst = [...state.canonicalCalls];
    assert.deepEqual(
      writeOrderAfterFirst.slice(0, CANONICAL_MUTATION_WRITE_ORDER.length),
      [...CANONICAL_MUTATION_WRITE_ORDER],
    );

    assert.equal(first.contract.operationId, OPERATION_ID);
    assert.equal(first.contract.allocation.commitOrdinal, '5');
    assert.equal(first.contract.mediaType, PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE);
    assert.equal(first.result.mediaType, PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE);
    assert.equal(first.result.status, 200);
    assert.equal(
      first.result.stableHeaders['content-type'],
      PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
    );
    assert.equal(first.result.stableHeaders['cache-control'], 'private, no-store');
    // Dynamic transport headers must not be present on the durable envelope.
    assert.equal(first.result.stableHeaders['x-request-id'], undefined);
    assert.equal(first.result.stableHeaders.date, undefined);

    const second = await executePublisherCanonicalMutationHarness(
      ports,
      { transaction: tx },
      input,
    );
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;

    assert.equal(second.fingerprint, first.fingerprint);
    assert.deepEqual(second.contract, first.contract);
    assert.equal(
      Buffer.from(second.result.body).toString('hex'),
      Buffer.from(first.result.body).toString('hex'),
    );
    assert.deepEqual(second.result.stableHeaders, first.result.stableHeaders);
    assert.equal(state.mutationCalls, 1);
    assert.deepEqual(state.operationsAppended, [OPERATION_ID]);
    assert.equal(state.canonicalCalls.length, writeOrderAfterFirst.length);
  });
});

// ---------------------------------------------------------------------------
// Product ↔ Publisher isolation
// ---------------------------------------------------------------------------

describe('executePublisherCanonicalMutationHarness: Product receipt isolation', () => {
  test('identical command/idempotency string does not collide across Product and Publisher stores', async () => {
    const probe = buildPublisherProductIsolationProbe({
      principalId: PRINCIPAL_A,
      sharedKey: IDEMPOTENCY_KEY,
      publisherNamespace: NAMESPACE_A,
    });

    const productStore = new Map<string, ProductReceiptRow>();
    const product = createMemoryProductReceipts(productStore);
    const state = createState();
    const ports = buildPorts(state);

    const productClaim = await product.claim(probe.productBinding, 'p'.repeat(64));
    assert.equal(productClaim.kind, 'claimed');
    const productBody = new TextEncoder().encode(JSON.stringify({ path: 'product' }));
    await product.complete(probe.productBinding, 'p'.repeat(64), {
      status: 200,
      body: productBody,
      stableHeaders: { 'content-type': 'application/json', etag: '"product-etag"' },
      mediaType: 'application/json',
      contractVersion: '1.0.0',
      targetIdentity: RESOURCE_ID,
    });

    const publisherOutcome = assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        baseInput({ binding: probe.publisherBinding }),
      ),
    );

    assert.equal(state.mutationCalls, 1);
    assert.notEqual(
      Buffer.from(publisherOutcome.result.body).toString('hex'),
      Buffer.from(productBody).toString('hex'),
    );
    assert.equal(productStore.size, 1);
    assert.equal(state.publisherStore.size, 1);

    const productReplay = await product.claim(probe.productBinding, 'p'.repeat(64));
    assert.equal(productReplay.kind, 'replay');
    if (productReplay.kind === 'replay') {
      assert.equal(
        Buffer.from(productReplay.result.body).toString('hex'),
        Buffer.from(productBody).toString('hex'),
      );
    }
  });

  test('publisher path never invokes product command receipt port', async () => {
    const productStore = new Map<string, ProductReceiptRow>();
    const product = createMemoryProductReceipts(productStore);
    const state = createState();
    const ports = buildPorts(state);

    assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        baseInput(),
      ),
    );
    assert.equal(product.claims, 0);
    assert.equal(product.completes, 0);
    assert.equal(productStore.size, 0);
  });

  test('default create-owned-collection namespace is distinct from Product command scope shape', () => {
    assert.equal(
      PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE.startsWith('colp.publisher'),
      true,
    );
    assert.equal(PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE.includes('/api/v1/'), false);
  });
});

// ---------------------------------------------------------------------------
// Operation ID ownership
// ---------------------------------------------------------------------------

describe('executePublisherCanonicalMutationHarness: Operation ID ownership', () => {
  test('Publisher admits operationId and Canonical Mutation echoes it without reassignment', async () => {
    const state = createState();
    const ports = buildPorts(state);

    const outcome = assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        baseInput({ operationId: OPERATION_ID }),
      ),
    );

    assert.equal(outcome.operationId, OPERATION_ID);
    assert.equal(outcome.mutation.operationId, OPERATION_ID);
    assert.equal(outcome.contract.operationId, OPERATION_ID);
    assert.deepEqual(state.operationsAppended, [OPERATION_ID]);
  });

  test('product-owned operation id path remains separate from publisher-admitted id', async () => {
    const state = createState();
    const ports = buildPorts(state);

    await ports.canonical.execute(
      { transaction: { id: 'tx-product' } },
      {
        operationId: PRODUCT_OPERATION_ID,
        collectionId: COLLECTION_ID,
        actor: { principalId: PRODUCT_PRINCIPAL, principalType: 'account' },
        mutation: mutationFields(),
      },
    );
    assert.deepEqual(state.operationsAppended, [PRODUCT_OPERATION_ID]);

    const publisherOutcome = assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx-publisher' } },
        baseInput({ operationId: OPERATION_ID }),
      ),
    );
    assert.equal(publisherOutcome.operationId, OPERATION_ID);
    assert.deepEqual(state.operationsAppended, [PRODUCT_OPERATION_ID, OPERATION_ID]);
    assert.notEqual(PRODUCT_OPERATION_ID, OPERATION_ID);
  });

  test('publisher generates an operation id when not supplied', async () => {
    const state = createState();
    const ports = buildPorts(state);
    const input = baseInput();
    delete (input as { operationId?: string }).operationId;

    const outcome = assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        input,
      ),
    );
    assert.ok(outcome.operationId.length > 0);
    assert.deepEqual(state.operationsAppended, [outcome.operationId]);
  });
});

// ---------------------------------------------------------------------------
// Rollback / fault injection
// ---------------------------------------------------------------------------

describe('executePublisherCanonicalMutationHarness: rollback and fault injection', () => {
  test('fault during mutation rolls back publisher claim; retry can claim and commit', async () => {
    const state = createState({ failAfter: 'mutation' });
    const ports = buildPorts(state);

    await assert.rejects(
      () =>
        withUowRollback(state, () =>
          executePublisherCanonicalMutationHarness(
            ports,
            { transaction: { id: 'tx' } },
            baseInput(),
          ),
        ),
      /injected fault at publisher mutation/,
    );

    assert.equal(state.publisherStore.size, 0);
    assert.equal(state.mutationCalls, 0);
    assert.equal(state.operationsAppended.length, 0);

    state.failAfter = undefined;
    // Rebuild ports so canonical ports see cleared failAfter.
    const recoveredPorts = buildPorts(state);
    const outcome = assertExecuted(
      await withUowRollback(state, () =>
        executePublisherCanonicalMutationHarness(
          recoveredPorts,
          { transaction: { id: 'tx' } },
          baseInput(),
        ),
      ),
    );
    assert.equal(outcome.kind, 'executed');
    assert.equal(state.publisherStore.size, 1);
    assert.equal(state.mutationCalls, 1);
    assert.deepEqual(state.operationsAppended, [OPERATION_ID]);
  });

  test('does not open a nested transaction: uses caller-supplied transaction only', async () => {
    const state = createState();
    const ports = buildPorts(state);
    const outerTx = { id: 'caller-owned-tx' };

    assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: outerTx },
        baseInput(),
      ),
    );
    assert.ok(state.seenTransactions.length > 0);
    assert.ok(state.seenTransactions.every((tx) => tx === outerTx));
    assert.deepEqual(
      state.canonicalCalls.slice(0, CANONICAL_MUTATION_WRITE_ORDER.length),
      [...CANONICAL_MUTATION_WRITE_ORDER],
    );
  });
});

// ---------------------------------------------------------------------------
// in_progress / unknown-outcome recovery
// (expired: createMemoryPublisherIdempotencyPort does not model compact expiry)
// ---------------------------------------------------------------------------

describe('executePublisherCanonicalMutationHarness: in_progress and unknown outcome', () => {
  test('in_progress claim returns without running Canonical Mutation', async () => {
    const state = createState();
    state.publisherStore.set(`${NAMESPACE_A}\0${PRINCIPAL_A}\0${IDEMPOTENCY_KEY}`, {
      fingerprint: publisherMutationFingerprint({
        namespace: NAMESPACE_A,
        principalId: PRINCIPAL_A,
        principalType: PUBLISHER_PRINCIPAL_TYPE,
        resource: {
          collectionId: COLLECTION_ID,
          resourceId: RESOURCE_ID,
          resourceKind: 'note',
        },
        payload: basePayload(),
      }),
      status: 'in_progress',
    });
    const ports = buildPorts(state);

    const outcome = await executePublisherCanonicalMutationHarness(
      ports,
      { transaction: { id: 'tx' } },
      baseInput(),
    );
    assert.equal(outcome.kind, 'in_progress');
    if (outcome.kind === 'in_progress') {
      assert.ok(outcome.retryAfterSeconds >= 1);
    }
    assert.equal(state.mutationCalls, 0);
    assert.equal(state.canonicalCalls.length, 0);
    assert.equal(state.operationsAppended.length, 0);
  });

  test('unknown commit outcome recovery: same binding only replays completed receipt', async () => {
    const state = createState();
    const ports = buildPorts(state);
    const input = baseInput();

    const first = assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        input,
      ),
    );
    assert.equal(state.mutationCalls, 1);

    const recovered = await executePublisherCanonicalMutationHarness(
      ports,
      { transaction: { id: 'tx-retry' } },
      input,
    );
    assert.equal(recovered.kind, 'replay');
    if (recovered.kind !== 'replay') return;
    assert.deepEqual(recovered.contract, first.contract);
    assert.equal(
      Buffer.from(recovered.result.body).toString('hex'),
      Buffer.from(first.result.body).toString('hex'),
    );
    assert.equal(state.mutationCalls, 1);
    assert.deepEqual(state.operationsAppended, [OPERATION_ID]);
  });

  test('unknown outcome with different fingerprint still rejects as reused without mutation', async () => {
    const state = createState();
    const ports = buildPorts(state);

    assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        baseInput(),
      ),
    );
    const after = state.mutationCalls;

    const conflict = await executePublisherCanonicalMutationHarness(
      ports,
      { transaction: { id: 'tx' } },
      baseInput({ payload: basePayload('other') }),
    );
    assert.equal(conflict.kind, 'reused');
    assert.equal(state.mutationCalls, after);
  });
});

// ---------------------------------------------------------------------------
// Happy path composition
// ---------------------------------------------------------------------------

describe('executePublisherCanonicalMutationHarness: composition with Canonical Mutation', () => {
  test('claimed publisher write runs full canonical write order once and stores projected contract', async () => {
    const state = createState();
    const ports = buildPorts(state);

    const outcome = assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        baseInput(),
      ),
    );

    assert.equal(outcome.mutation.allocation.commitOrdinal, 5n);
    assert.equal(outcome.operationId, OPERATION_ID);
    assert.deepEqual(
      state.canonicalCalls.slice(0, CANONICAL_MUTATION_WRITE_ORDER.length),
      [...CANONICAL_MUTATION_WRITE_ORDER],
    );
    assert.equal(state.mutationCalls, 1);

    assert.equal(outcome.contract.resourceId, RESOURCE_ID);
    assert.equal(outcome.contract.operationId, OPERATION_ID);
    assert.equal(outcome.contract.allocation.commitOrdinal, '5');
    assert.equal(outcome.contract.allocation.resourceRevision, 'r-5');
    assert.equal(outcome.result.contractVersion, PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION);
    assert.equal(
      outcome.result.targetIdentity,
      `update:${COLLECTION_ID}/${RESOURCE_ID}`,
    );
  });

  test('actor principal type on canonical path is publisher_client', async () => {
    const state = createState();
    let seenPrincipalType: string | undefined;
    const ports: PublisherCanonicalMutationHarnessPorts<Tx> = {
      publisherIdempotency: createMemoryPublisherIdempotencyPort(state.publisherStore),
      canonical: createCanonicalMutationApplication({
        collectionLock: {
          async lockForCanonicalMutation() {
            return locked;
          },
        },
        planner: {
          async planCanonicalMutation(_tx, admitted) {
            seenPrincipalType = admitted.actor.principalType;
            return planFor(admitted);
          },
        },
        allocator: {
          async allocate() {
            return allocation;
          },
        },
        resources: {
          async applyCanonicalMutation() {
            state.mutationCalls += 1;
          },
        },
        operations: {
          async appendCanonicalOperation(_tx, operation) {
            state.operationsAppended.push(operation.operationId);
          },
        },
        audit: { async appendAuditEvent() {} },
        outbox: { async appendDomainEvents() {} },
      }),
    };

    assertExecuted(
      await executePublisherCanonicalMutationHarness(
        ports,
        { transaction: { id: 'tx' } },
        baseInput(),
      ),
    );
    assert.equal(seenPrincipalType, PUBLISHER_PRINCIPAL_TYPE);
  });
});
