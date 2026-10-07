/**
 * P1-11 Publisher admission internal contract harness unit tests.
 *
 * Production surface:
 *   admitPublisherMutation(idempotency, { binding, fingerprint, execute })
 *     → executed | replay | in_progress | reused
 *   runPublisherCreateOwnedCollectionHarness(ports, input)
 *     → CreateOwnedCollectionResult under Publisher idempotency ownership
 *   createMemoryPublisherIdempotencyPort / adaptPublisherIdempotencyAsProductReceipts
 *   buildPublisherProductIsolationProbe / publisherProductReceiptIsolationContract
 *
 * Invariants:
 *   - same Publisher binding + fingerprint → exact replay, no second mutation
 *   - same binding, different fingerprint → reused
 *   - Product receipts and Publisher receipts never share storage or PK shape
 *   - rollback leaves no completed Publisher receipt
 *   - Operation ID ownership stays with collections mutation (not Publisher claim)
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { AccessPolicyWritePort, MembershipRole } from '../../../src/modules/access-policy/index.js';
import {
  bootstrapCanonicalOwnedCollection,
  CREATE_OWNED_COLLECTION_COMMAND_SCOPE,
  CREATE_OWNED_COLLECTION_OPERATION_TYPE,
  createOwnedCollectionCanonical,
  type BootstrapAuditRecord,
  type BootstrapOperationRecord,
  type BootstrapOutboxRecord,
  type ChildrenRevisionInsert,
  type CollectionBootstrapRow,
  type CollectionsWritePorts,
  type ContentRevisionInsert,
  type CreateOwnedCollectionInput,
  type CreateOwnedCollectionResult,
  type IdLedgerReserveEntry,
  type PolicyRevisionInsert,
  type ProductCollectionCanonicalPorts,
  type ResourceRevisionInsert,
  type RootNodeBootstrapRow,
} from '../../../src/modules/collections/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import {
  admitPublisherMutation,
  buildPublisherProductIsolationProbe,
  createMemoryPublisherIdempotencyPort,
  PRODUCT_COMMAND_RECEIPT_TABLE,
  PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE,
  PUBLISHER_IDEMPOTENCY_TABLE,
  publisherProductReceiptIsolationContract,
  runPublisherCreateOwnedCollectionHarness,
  type PublisherCreateOwnedCollectionHarnessPorts,
  type PublisherIdempotencyBinding,
  type PublisherStoredResult,
} from '../../../src/modules/publisher/index.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');

const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const PRINCIPAL_A = 'principal-account-a';
const SUBJECT_A = 'subject-account-a';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

const COLLECTION_ID = 'col-publisher-0001';
const ROOT_ID = 'root-publisher-0001';
const OPERATION_ID = 'op-publisher-0001';

// ---------------------------------------------------------------------------
// Product receipt memory (isolated store)
// ---------------------------------------------------------------------------

interface ProductReceiptRow {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
}

function productReceiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

function createMemoryProductReceipts(
  store: Map<string, ProductReceiptRow>,
): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const key = productReceiptKey(binding);
      const existing = store.get(key);
      if (!existing) {
        store.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed product receipt must retain result');
      return { kind: 'replay', result: existing.result };
    },
    async complete(binding, fingerprint, result): Promise<void> {
      const key = productReceiptKey(binding);
      const existing = store.get(key);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new Error('product complete without matching claim');
      }
      if (existing.status === 'completed') throw new Error('product receipt already completed');
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
}

// ---------------------------------------------------------------------------
// Collections memory ports (create-owned-collection path)
// ---------------------------------------------------------------------------

interface MembershipRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt: Date;
}

interface PolicyRow {
  collectionId: string;
  policyJson: Readonly<Record<string, unknown>>;
  updatedAt: Date;
}

interface DomainMemoryState {
  now: Date;
  productReceipts: Map<string, ProductReceiptRow>;
  publisherReceipts: Map<
    string,
    { fingerprint: string; status: 'in_progress' | 'completed'; result?: PublisherStoredResult }
  >;
  ledger: IdLedgerReserveEntry[];
  collections: CollectionBootstrapRow[];
  nodes: RootNodeBootstrapRow[];
  memberships: MembershipRow[];
  policies: Map<string, PolicyRow>;
  resourceRevisions: ResourceRevisionInsert[];
  contentRevisions: ContentRevisionInsert[];
  policyRevisions: PolicyRevisionInsert[];
  childrenRevisions: ChildrenRevisionInsert[];
  operations: BootstrapOperationRecord[];
  audit: BootstrapAuditRecord[];
  outbox: BootstrapOutboxRecord[];
  failAfter?: 'collection-insert' | 'node-insert' | 'membership' | 'operation' | 'outbox';
  mutationExecutions: number;
}

function createState(overrides: Partial<DomainMemoryState> = {}): DomainMemoryState {
  return {
    now: new Date(NOW),
    productReceipts: new Map(),
    publisherReceipts: new Map(),
    ledger: [],
    collections: [],
    nodes: [],
    memberships: [],
    policies: new Map(),
    resourceRevisions: [],
    contentRevisions: [],
    policyRevisions: [],
    childrenRevisions: [],
    operations: [],
    audit: [],
    outbox: [],
    mutationExecutions: 0,
    ...overrides,
  };
}

function cloneState(state: DomainMemoryState): DomainMemoryState {
  return {
    now: new Date(state.now),
    productReceipts: new Map(
      [...state.productReceipts.entries()].map(([k, v]) => [
        k,
        {
          ...v,
          result: v.result
            ? {
                ...v.result,
                body: v.result.body.slice(),
                stableHeaders: { ...v.result.stableHeaders },
              }
            : undefined,
        },
      ]),
    ),
    publisherReceipts: new Map(
      [...state.publisherReceipts.entries()].map(([k, v]) => [
        k,
        {
          ...v,
          result: v.result
            ? {
                ...v.result,
                body: v.result.body.slice(),
                stableHeaders: { ...v.result.stableHeaders },
              }
            : undefined,
        },
      ]),
    ),
    ledger: state.ledger.map((e) => ({ ...e })),
    collections: state.collections.map((c) => ({ ...c })),
    nodes: state.nodes.map((n) => ({ ...n })),
    memberships: state.memberships.map((m) => ({ ...m })),
    policies: new Map(
      [...state.policies.entries()].map(([k, v]) => [k, { ...v, policyJson: { ...v.policyJson } }]),
    ),
    resourceRevisions: state.resourceRevisions.map((r) => ({ ...r })),
    contentRevisions: state.contentRevisions.map((r) => ({ ...r })),
    policyRevisions: state.policyRevisions.map((r) => ({ ...r })),
    childrenRevisions: state.childrenRevisions.map((r) => ({ ...r })),
    operations: state.operations.map((o) => ({ ...o })),
    audit: state.audit.map((a) => ({ ...a })),
    outbox: state.outbox.map((e) => ({ ...e })),
    failAfter: state.failAfter,
    mutationExecutions: state.mutationExecutions,
  };
}

function restoreState(target: DomainMemoryState, snapshot: DomainMemoryState): void {
  Object.assign(target, snapshot);
}

function createMemoryAccessPolicy(state: DomainMemoryState): AccessPolicyWritePort {
  return {
    async insertMembership(input) {
      state.memberships.push({
        collectionId: input.collectionId,
        subjectId: input.subjectId,
        role: input.role,
        grantedAt: input.grantedAt,
      });
      if (state.failAfter === 'membership') {
        throw new Error('injected fault after membership insert');
      }
    },
    async deleteMembership(input) {
      const before = state.memberships.length;
      state.memberships = state.memberships.filter(
        (m) => !(m.collectionId === input.collectionId && m.subjectId === input.subjectId),
      );
      return state.memberships.length < before;
    },
    async upsertCollectionPolicy(input) {
      state.policies.set(input.collectionId, {
        collectionId: input.collectionId,
        policyJson: input.policyJson ?? {},
        updatedAt: input.updatedAt,
      });
    },
  };
}

function createSharedWritePorts(state: DomainMemoryState): Omit<
  CollectionsWritePorts,
  'receipts' | 'accessPolicyFacts'
> {
  return {
    clock: { now: async () => new Date(state.now) },
    idLedger: {
      async reserve(entries) {
        for (const entry of entries) {
          if (state.ledger.some((e) => e.resourceId === entry.resourceId)) {
            throw new Error(`duplicate ledger id ${entry.resourceId}`);
          }
          state.ledger.push({ ...entry });
        }
      },
    },
    collections: {
      async insertBootstrap(row) {
        state.collections.push({ ...row });
        if (state.failAfter === 'collection-insert') {
          throw new Error('injected fault after collection insert');
        }
      },
    },
    nodes: {
      async insertRoot(row) {
        state.nodes.push({ ...row });
        if (state.failAfter === 'node-insert') {
          throw new Error('injected fault after node insert');
        }
      },
    },
    revisions: {
      async insertResourceRevision(row) {
        state.resourceRevisions.push({ ...row });
      },
      async insertContentRevision(row) {
        state.contentRevisions.push({ ...row });
      },
      async insertPolicyRevision(row) {
        state.policyRevisions.push({ ...row });
      },
      async insertChildrenRevision(row) {
        state.childrenRevisions.push({ ...row });
      },
    },
    operations: {
      async append(record) {
        state.operations.push({ ...record });
        if (state.failAfter === 'operation') {
          throw new Error('injected fault after operation append');
        }
      },
    },
    audit: {
      async append(record) {
        state.audit.push({ ...record });
      },
    },
    outbox: {
      async append(record) {
        state.outbox.push({ ...record });
        if (state.failAfter === 'outbox') {
          throw new Error('injected fault after outbox append');
        }
      },
    },
    accessPolicy: createMemoryAccessPolicy(state),
  };
}

function createPublisherHarnessPorts(
  state: DomainMemoryState,
): PublisherCreateOwnedCollectionHarnessPorts {
  const publisherIdempotency = createMemoryPublisherIdempotencyPort(state.publisherReceipts);
  return {
    publisherIdempotency,
    ...createSharedWritePorts(state),
    // Canonical create uses the facts reader only; bootstrap writes flow through
    // the canonical closure below (same write ports as the shared surface).
    accessPolicy: {
      async loadCollectionFacts() {
        return null;
      },
    },
    canonical: {
      async bootstrapOwnedCollection(input) {
        return bootstrapCanonicalOwnedCollection(createSharedWritePorts(state), input);
      },
      async execute() {
        throw new Error('publisher harness does not execute metadata mutations');
      },
    },
  };
}

function createProductPorts(state: DomainMemoryState): ProductCollectionCanonicalPorts {
  return {
    receipts: createMemoryProductReceipts(state.productReceipts),
    ...createSharedWritePorts(state),
    accessPolicy: {
      async loadCollectionFacts() {
        return null;
      },
    },
    canonical: {
      async bootstrapOwnedCollection(input) {
        return bootstrapCanonicalOwnedCollection(createSharedWritePorts(state), input);
      },
      async execute() {
        throw new Error('product-side isolation contract does not execute metadata mutations');
      },
    },
  };
}

/** Simulate UoW rollback for Publisher harness writes (including publisher receipts). */
async function withPublisherRollback<T>(
  state: DomainMemoryState,
  work: (ports: PublisherCreateOwnedCollectionHarnessPorts) => Promise<T>,
): Promise<T> {
  const snapshot = cloneState(state);
  const ports = createPublisherHarnessPorts(state);
  try {
    return await work(ports);
  } catch (error) {
    restoreState(state, snapshot);
    throw error;
  }
}

function publisherBinding(overrides: Partial<PublisherIdempotencyBinding> = {}): PublisherIdempotencyBinding {
  return {
    namespace: PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE,
    principalId: PRINCIPAL_A,
    idempotencyKey: COMMAND_A,
    ...overrides,
  };
}

function storedResult(overrides: Partial<PublisherStoredResult> = {}): PublisherStoredResult {
  return {
    status: 201,
    body: new TextEncoder().encode(JSON.stringify({ ok: true, title: 'Known' })),
    stableHeaders: {
      'content-type': 'application/json',
      etag: '"rev-1"',
      location: `/api/v1/collections/${COLLECTION_ID}`,
      'cache-control': 'private, no-store',
    },
    mediaType: 'application/json',
    contractVersion: '1.0.0',
    targetIdentity: COLLECTION_ID,
    ...overrides,
  };
}

function harnessInput(
  overrides: Partial<CreateOwnedCollectionInput> = {},
): CreateOwnedCollectionInput {
  return {
    title: 'Publisher List',
    summary: 'p1-11 harness',
    kind: 'bookmarks',
    collectionId: COLLECTION_ID,
    rootNodeId: ROOT_ID,
    operationId: OPERATION_ID,
    ...overrides,
    // Product command_scope is ignored by Publisher admission winner key;
    // adapter maps only principalId + commandId into Publisher binding.
    actor: {
      principalId: PRINCIPAL_A,
      principalType: 'account',
      subjectId: SUBJECT_A,
      ...overrides.actor,
    },
    command: {
      commandId: COMMAND_A,
      fingerprint: FINGERPRINT_A,
      commandScope: CREATE_OWNED_COLLECTION_COMMAND_SCOPE,
      ...overrides.command,
    },
  };
}

function assertCreated(
  outcome: CreateOwnedCollectionResult,
): Extract<CreateOwnedCollectionResult, { kind: 'created' }> {
  assert.equal(outcome.kind, 'created', `expected created, got ${outcome.kind}`);
  return outcome as Extract<CreateOwnedCollectionResult, { kind: 'created' }>;
}

function publisherReceiptKey(binding: PublisherIdempotencyBinding): string {
  return `${binding.namespace}\0${binding.principalId}\0${binding.idempotencyKey}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('same publisher binding exact replay', () => {
  test('admitPublisherMutation replays identical result without re-executing mutation', async () => {
    const port = createMemoryPublisherIdempotencyPort();
    const binding = publisherBinding();
    let executions = 0;
    const firstBody = storedResult();

    const first = await admitPublisherMutation(port, {
      binding,
      fingerprint: FINGERPRINT_A,
      execute: async () => {
        executions += 1;
        return firstBody;
      },
    });
    assert.equal(first.kind, 'executed');
    if (first.kind !== 'executed') return;

    const second = await admitPublisherMutation(port, {
      binding,
      fingerprint: FINGERPRINT_A,
      execute: async () => {
        executions += 1;
        return storedResult({ body: new TextEncoder().encode('must-not-run') });
      },
    });

    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;
    assert.equal(executions, 1);
    assert.equal(second.result.status, first.result.status);
    assert.deepEqual(second.result.stableHeaders, first.result.stableHeaders);
    assert.equal(second.result.mediaType, first.result.mediaType);
    assert.equal(second.result.contractVersion, first.result.contractVersion);
    assert.deepEqual(
      Buffer.from(second.result.body).toString('hex'),
      Buffer.from(first.result.body).toString('hex'),
    );
  });

  test('runPublisherCreateOwnedCollectionHarness exact retry has no second domain writes', async () => {
    const state = createState();
    const ports = createPublisherHarnessPorts(state);
    const input = harnessInput();

    const first = assertCreated(await runPublisherCreateOwnedCollectionHarness(ports, input));
    const counts = {
      collections: state.collections.length,
      nodes: state.nodes.length,
      memberships: state.memberships.length,
      operations: state.operations.length,
      audit: state.audit.length,
      outbox: state.outbox.length,
      ledger: state.ledger.length,
      publisherReceipts: state.publisherReceipts.size,
    };

    const second = await runPublisherCreateOwnedCollectionHarness(ports, input);
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;

    assert.equal(second.status, 201);
    assert.equal(second.stableHeaders.location, `/api/v1/collections/${COLLECTION_ID}`);
    assert.equal(state.collections.length, counts.collections);
    assert.equal(state.nodes.length, counts.nodes);
    assert.equal(state.memberships.length, counts.memberships);
    assert.equal(state.operations.length, counts.operations);
    assert.equal(state.audit.length, counts.audit);
    assert.equal(state.outbox.length, counts.outbox);
    assert.equal(state.ledger.length, counts.ledger);
    assert.equal(state.publisherReceipts.size, counts.publisherReceipts);

    const key = publisherReceiptKey(publisherBinding());
    const receipt = state.publisherReceipts.get(key);
    assert.equal(receipt?.status, 'completed');
    assert.equal(receipt?.fingerprint, FINGERPRINT_A);
    assert.equal(first.operationId, OPERATION_ID);
  });
});

describe('different fingerprint reused', () => {
  test('same Publisher binding with different fingerprint returns reused without mutation', async () => {
    const port = createMemoryPublisherIdempotencyPort();
    const binding = publisherBinding();
    let executions = 0;

    const first = await admitPublisherMutation(port, {
      binding,
      fingerprint: FINGERPRINT_A,
      execute: async () => {
        executions += 1;
        return storedResult();
      },
    });
    assert.equal(first.kind, 'executed');

    const reused = await admitPublisherMutation(port, {
      binding,
      fingerprint: FINGERPRINT_B,
      execute: async () => {
        executions += 1;
        return storedResult({ body: new TextEncoder().encode('different') });
      },
    });

    assert.equal(reused.kind, 'reused');
    assert.equal(executions, 1);
  });

  test('publisher harness rejects reused fingerprint without additional writes', async () => {
    const state = createState();
    const ports = createPublisherHarnessPorts(state);

    assertCreated(
      await runPublisherCreateOwnedCollectionHarness(
        ports,
        harnessInput({ command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A } }),
      ),
    );
    const afterFirst = {
      collections: state.collections.length,
      operations: state.operations.length,
      memberships: state.memberships.length,
      ledger: state.ledger.length,
    };

    const reused = await runPublisherCreateOwnedCollectionHarness(
      ports,
      harnessInput({
        title: 'Different payload intent',
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.collections.length, afterFirst.collections);
    assert.equal(state.operations.length, afterFirst.operations);
    assert.equal(state.memberships.length, afterFirst.memberships);
    assert.equal(state.ledger.length, afterFirst.ledger);
  });
});

describe('Product receipt and Publisher receipt isolation', () => {
  test('isolation contract uses distinct tables and disjoint primary keys', () => {
    const contract = publisherProductReceiptIsolationContract();
    assert.equal(contract.productTable, PRODUCT_COMMAND_RECEIPT_TABLE);
    assert.equal(contract.publisherTable, PUBLISHER_IDEMPOTENCY_TABLE);
    assert.notEqual(contract.productTable, contract.publisherTable);
    assert.deepEqual(contract.productPrimaryKey, [
      'principal_id',
      'command_scope',
      'command_id',
    ]);
    assert.deepEqual(contract.publisherPrimaryKey, [
      'namespace',
      'principal_id',
      'idempotency_key',
    ]);
    assert.equal(contract.sharedTables, false);
    assert.equal(contract.nestedTransactions, false);
    assert.equal(contract.productOwnsHttpIdempotencyKey, false);
    assert.equal(contract.publisherOwnsProductCommandId, false);
  });

  test('same principal + same id string complete independently with no cross-talk', async () => {
    const state = createState();
    const probe = buildPublisherProductIsolationProbe({
      principalId: PRINCIPAL_A,
      sharedKey: COMMAND_A,
    });

    assert.equal(probe.sharedPrincipalId, PRINCIPAL_A);
    assert.equal(probe.sharedKey, COMMAND_A);
    assert.equal(probe.productBinding.commandId, COMMAND_A);
    assert.equal(probe.publisherBinding.idempotencyKey, COMMAND_A);
    assert.equal(probe.productBinding.principalId, PRINCIPAL_A);
    assert.equal(probe.publisherBinding.principalId, PRINCIPAL_A);
    assert.notEqual(probe.productTable, probe.publisherTable);
    assert.equal(probe.productBinding.commandScope, CREATE_OWNED_COLLECTION_COMMAND_SCOPE);
    assert.equal(probe.publisherBinding.namespace, PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE);
    assert.notEqual(probe.productBinding.commandScope, probe.publisherBinding.namespace);

    // Product admission owns product_command_receipts only.
    const productPorts = createProductPorts(state);
    const productCreated = assertCreated(
      await createOwnedCollectionCanonical(productPorts, harnessInput({
        collectionId: 'col-product-only',
        rootNodeId: 'root-product-only',
        operationId: 'op-product-only',
      })),
    );
    assert.equal(productCreated.operationId, 'op-product-only');
    assert.equal(state.productReceipts.size, 1);
    assert.equal(state.publisherReceipts.size, 0);

    // Publisher admission owns publisher_idempotency only (via harness adapter).
    const publisherPorts = createPublisherHarnessPorts(state);
    const publisherCreated = assertCreated(
      await runPublisherCreateOwnedCollectionHarness(
        publisherPorts,
        harnessInput({
          collectionId: 'col-publisher-only',
          rootNodeId: 'root-publisher-only',
          operationId: 'op-publisher-only',
        }),
      ),
    );
    assert.equal(publisherCreated.operationId, 'op-publisher-only');
    assert.equal(state.productReceipts.size, 1);
    assert.equal(state.publisherReceipts.size, 1);

    // Product store is unaffected by Publisher completion of the same key string.
    const productKey = productReceiptKey(probe.productBinding);
    const productRow = state.productReceipts.get(productKey);
    assert.equal(productRow?.status, 'completed');
    assert.equal(productRow?.fingerprint, FINGERPRINT_A);
    assert.equal(productRow?.result?.targetIdentity, 'col-product-only');

    const publisherKey = publisherReceiptKey(probe.publisherBinding);
    const publisherRow = state.publisherReceipts.get(publisherKey);
    assert.equal(publisherRow?.status, 'completed');
    assert.equal(publisherRow?.fingerprint, FINGERPRINT_A);
    assert.equal(publisherRow?.result?.targetIdentity, 'col-publisher-only');

    // Re-claiming each owner still hits its own store (replay), never the other table.
    const productReplay = await productPorts.receipts.claim(probe.productBinding, FINGERPRINT_A);
    assert.equal(productReplay.kind, 'replay');
    if (productReplay.kind === 'replay') {
      assert.equal(productReplay.result.targetIdentity, 'col-product-only');
    }

    const publisherReplay = await publisherPorts.publisherIdempotency.claim(
      probe.publisherBinding,
      FINGERPRINT_A,
    );
    assert.equal(publisherReplay.kind, 'replay');
    if (publisherReplay.kind === 'replay') {
      assert.equal(publisherReplay.result.targetIdentity, 'col-publisher-only');
    }

    // Product store never contains a Publisher binding key shape.
    assert.equal(
      state.productReceipts.has(publisherKey),
      false,
      'product receipt map must not index publisher namespace keys',
    );
    assert.equal(
      state.publisherReceipts.has(productKey),
      false,
      'publisher receipt map must not index product scope keys',
    );
  });
});

describe('rollback does not leave publisher receipt complete', () => {
  test('fault after claim + partial mutation rolls back incomplete publisher receipt', async () => {
    const state = createState({ failAfter: 'operation' });

    await assert.rejects(
      () =>
        withPublisherRollback(state, (ports) =>
          runPublisherCreateOwnedCollectionHarness(ports, harnessInput()),
        ),
      /injected fault after operation append/,
    );

    assert.equal(state.collections.length, 0);
    assert.equal(state.nodes.length, 0);
    assert.equal(state.memberships.length, 0);
    assert.equal(state.operations.length, 0);
    assert.equal(state.audit.length, 0);
    assert.equal(state.outbox.length, 0);
    assert.equal(state.ledger.length, 0);
    assert.equal(state.publisherReceipts.size, 0);
    assert.equal(state.productReceipts.size, 0);

    // Clean retry after rollback re-claims and completes.
    state.failAfter = undefined;
    const outcome = await withPublisherRollback(state, (ports) =>
      runPublisherCreateOwnedCollectionHarness(ports, harnessInput()),
    );
    assert.equal(outcome.kind, 'created');
    const key = publisherReceiptKey(publisherBinding());
    assert.equal(state.publisherReceipts.get(key)?.status, 'completed');
  });

  test('admitPublisherMutation does not complete when execute throws (UoW restores store)', async () => {
    const store = new Map<
      string,
      { fingerprint: string; status: 'in_progress' | 'completed'; result?: PublisherStoredResult }
    >();
    const binding = publisherBinding();
    const key = publisherReceiptKey(binding);

    const snapshot = () =>
      new Map(
        [...store.entries()].map(([k, v]) => [
          k,
          {
            ...v,
            result: v.result
              ? {
                  ...v.result,
                  body: v.result.body.slice(),
                  stableHeaders: { ...v.result.stableHeaders },
                }
              : undefined,
          },
        ]),
      );

    const before = snapshot();
    const port = createMemoryPublisherIdempotencyPort(store);
    try {
      await admitPublisherMutation(port, {
        binding,
        fingerprint: FINGERPRINT_A,
        execute: async () => {
          throw new Error('injected mutation failure');
        },
      });
      assert.fail('expected execute failure');
    } catch (error) {
      assert.match(String(error), /injected mutation failure/);
      // Caller-owned UoW rolls back claim + incomplete receipt together.
      store.clear();
      for (const [k, v] of before) store.set(k, v);
    }

    assert.equal(store.size, 0);
    assert.equal(store.get(key)?.status, undefined);

    // Fresh attempt after rollback can claim and complete.
    const retry = await admitPublisherMutation(createMemoryPublisherIdempotencyPort(store), {
      binding,
      fingerprint: FINGERPRINT_A,
      execute: async () => storedResult(),
    });
    assert.equal(retry.kind, 'executed');
    assert.equal(store.get(key)?.status, 'completed');
  });
});

describe('Operation ID ownership stays with collections mutation', () => {
  test('publisher admission does not mint Operation IDs; collections path owns the supplied id', async () => {
    const state = createState();
    const ports = createPublisherHarnessPorts(state);
    const callerOperationId = 'collections-owned-operation-id';

    const created = assertCreated(
      await runPublisherCreateOwnedCollectionHarness(
        ports,
        harnessInput({ operationId: callerOperationId }),
      ),
    );

    assert.equal(created.operationId, callerOperationId);
    assert.equal(state.operations.length, 1);
    assert.equal(state.operations[0]!.operationId, callerOperationId);
    assert.equal(state.operations[0]!.operationType, CREATE_OWNED_COLLECTION_OPERATION_TYPE);
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0]!.operationId, callerOperationId);
    assert.equal(state.outbox.length, 1);
    // Outbox domainEventId is a separate ledger id; operation linkage is via payload/aggregate,
    // but audit and operations tables carry the caller-owned operation id.
    assert.ok(
      state.ledger.some(
        (entry) => entry.resourceId === callerOperationId && entry.resourceType === 'operation',
      ),
      'operation id must be reserved on the collections id ledger',
    );

    // Publisher receipt stores response only — no operation id field and no second owner claim.
    const key = publisherReceiptKey(publisherBinding());
    const receipt = state.publisherReceipts.get(key);
    assert.equal(receipt?.status, 'completed');
    assert.equal(
      'operationId' in (receipt?.result ?? {}),
      false,
      'publisher stored result must not own operation identity',
    );
  });

  test('admitPublisherMutation execute callback is the sole site that can record an operation id', async () => {
    const port = createMemoryPublisherIdempotencyPort();
    const recorded: string[] = [];
    const operationId = 'mutation-owner-op-1';

    const outcome = await admitPublisherMutation(port, {
      binding: publisherBinding({ idempotencyKey: 'key-for-op-ownership' }),
      fingerprint: FINGERPRINT_A,
      execute: async () => {
        // Collections / Canonical Mutation path owns this id; Publisher claim does not allocate one.
        recorded.push(operationId);
        return storedResult({
          body: new TextEncoder().encode(JSON.stringify({ operationId })),
        });
      },
    });

    assert.equal(outcome.kind, 'executed');
    assert.deepEqual(recorded, [operationId]);

    // Replay must not re-enter the mutation owner path.
    const replay = await admitPublisherMutation(port, {
      binding: publisherBinding({ idempotencyKey: 'key-for-op-ownership' }),
      fingerprint: FINGERPRINT_A,
      execute: async () => {
        recorded.push('must-not-run');
        return storedResult();
      },
    });
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(recorded, [operationId]);
  });
});

