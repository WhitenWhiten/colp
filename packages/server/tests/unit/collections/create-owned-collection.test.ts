/**
 * P1-04 CreateOwnedCollection canonical application unit tests (in-memory canonical ports).
 *
 * Production surface:
 *   createOwnedCollectionCanonical(ports, input) → created | replay | in_progress | reused | expired
 *   Command scope default: collection:create
 *   Visibility always private; owner membership role owner; root is_root.
 *   The canonical bootstrap owns ID ledger, Collection+Root, membership/policy, revisions and
 *   Operation/Audit/Outbox; the application delegates exactly one canonical bootstrap and builds
 *   the Product snapshot + receipt from the returned bootstrap result.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CollectionsError,
  CREATE_OWNED_COLLECTION_COMMAND_SCOPE,
  CREATE_OWNED_COLLECTION_OPERATION_TYPE,
  createOwnedCollectionCanonical,
  type CanonicalOwnedCollectionBootstrapInput,
  type CollectionBootstrapRow,
  type CreateOwnedCollectionInput,
  type CreateOwnedCollectionResult,
  type BootstrapAuditRecord,
  type BootstrapOperationRecord,
  type BootstrapOutboxRecord,
  type ChildrenRevisionInsert,
  type ContentRevisionInsert,
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
import type { AccessPolicyWritePort, MembershipRole } from '../../../src/modules/access-policy/index.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');

/** Valid lowercase UUID v4 command IDs. */
const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const COMMAND_C = '11111111-2222-4333-8444-555555555555';

const PRINCIPAL_A = 'principal-account-a';
const PRINCIPAL_B = 'principal-account-b';
const SUBJECT_A = 'subject-account-a';
const SUBJECT_B = 'subject-account-b';

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

const COLLECTION_ID = 'col-test-0001';
const ROOT_ID = 'root-test-0001';
const OPERATION_ID = 'op-test-0001';

// ---------------------------------------------------------------------------
// Memory state + ports
// ---------------------------------------------------------------------------

interface ReceiptRow {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
  resultDigest?: string | null;
  expired?: boolean;
}

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

interface MemoryState {
  now: Date;
  receipts: Map<string, ReceiptRow>;
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
  /** Canonical bootstrap inputs delegated to the executor mock, in order. */
  bootstraps: CanonicalOwnedCollectionBootstrapInput[];
  /** Injected fault after the named write; throws after applying side effect. */
  failAfter?: 'collection-insert' | 'node-insert' | 'membership' | 'operation' | 'outbox';
  forceInProgress?: boolean;
}

function receiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    now: new Date(state.now),
    receipts: new Map(
      [...state.receipts.entries()].map(([k, v]) => [
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
    bootstraps: state.bootstraps.map((b) => ({ ...b })),
    failAfter: state.failAfter,
    forceInProgress: state.forceInProgress,
  };
}

function restoreState(target: MemoryState, snapshot: MemoryState): void {
  Object.assign(target, snapshot);
}

/** Simulate transaction rollback: discard writes if createOwnedCollectionCanonical throws. */
async function withRollback<T>(
  state: MemoryState,
  work: (ports: ProductCollectionCanonicalPorts) => Promise<T>,
): Promise<T> {
  const snapshot = cloneState(state);
  const ports = createMemoryPorts(state);
  try {
    return await work(ports);
  } catch (error) {
    restoreState(state, snapshot);
    throw error;
  }
}

function createMemoryReceipts(state: MemoryState): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      if (state.forceInProgress) {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      const key = receiptKey(binding);
      const existing = state.receipts.get(key);
      if (!existing) {
        state.receipts.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.expired) {
        return { kind: 'expired', resultDigest: existing.resultDigest ?? null };
      }
      if (existing.fingerprint !== fingerprint) {
        return { kind: 'reused' };
      }
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed receipt must retain result');
      return { kind: 'replay', result: existing.result };
    },
    async complete(binding, fingerprint, result): Promise<void> {
      const key = receiptKey(binding);
      const existing = state.receipts.get(key);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new Error('complete without matching claim');
      }
      if (existing.status === 'completed') {
        throw new Error('receipt already completed');
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
      existing.resultDigest = 'digest';
    },
    async purgeExpired() {
      return 0;
    },
    async deletePrincipalReceipts(principalId) {
      let count = 0;
      for (const [key] of state.receipts) {
        if (key.startsWith(`${principalId}\0`)) {
          state.receipts.delete(key);
          count += 1;
        }
      }
      return count;
    },
  };
}

function createMemoryAccessPolicy(state: MemoryState): AccessPolicyWritePort {
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

function createMemoryPorts(state: MemoryState): ProductCollectionCanonicalPorts {
  return {
    receipts: createMemoryReceipts(state),
    clock: {
      now: async () => new Date(state.now),
    },
    collections: {
      async lockForUpdate() {
        return null;
      },
    },
    nodes: {
      async getNode() {
        return null;
      },
      async listLiveSiblingPositions() {
        return [];
      },
    },
    accessPolicy: {
      async loadCollectionFacts() {
        return null;
      },
    },
    canonical: {
      async bootstrapOwnedCollection(input) {
        state.bootstraps.push(input);
        const now = new Date(state.now);
        state.ledger.push(
          { resourceId: input.collectionId, resourceType: 'collection' },
          { resourceId: input.rootNodeId, resourceType: 'node' },
          { resourceId: input.operationId, resourceType: 'operation' },
          { resourceId: input.domainEventId, resourceType: 'domain-event' },
          { resourceId: input.outboxId, resourceType: 'outbox' },
        );
        state.collections.push({
          id: input.collectionId,
          ownerSubjectId: input.actor.subjectId,
          title: input.title,
          summary: input.summary,
          kind: input.kind,
          visibility: 'private',
          rootNodeId: input.rootNodeId,
          resourceRevision: input.resourceRevision,
          contentRevision: input.contentRevision,
          policyRevision: input.policyRevision,
          commitOrdinal: 1n,
          createdAt: now,
          updatedAt: now,
        });
        if (state.failAfter === 'collection-insert') {
          throw new Error('injected fault after collection insert');
        }
        state.nodes.push({
          id: input.rootNodeId,
          collectionId: input.collectionId,
          title: input.title,
          resourceRevision: input.rootResourceRevision,
          childrenRevision: input.rootChildrenRevision,
          createdAt: now,
          updatedAt: now,
        });
        if (state.failAfter === 'node-insert') {
          throw new Error('injected fault after node insert');
        }
        state.memberships.push({
          collectionId: input.collectionId,
          subjectId: input.actor.subjectId,
          role: 'owner',
          grantedAt: now,
        });
        if (state.failAfter === 'membership') {
          throw new Error('injected fault after membership insert');
        }
        state.policies.set(input.collectionId, {
          collectionId: input.collectionId,
          policyJson: {},
          updatedAt: now,
        });
        state.resourceRevisions.push(
          {
            collectionId: input.collectionId,
            resourceId: input.collectionId,
            revision: input.resourceRevision,
            ordinal: 1n,
            createdAt: now,
          },
          {
            collectionId: input.collectionId,
            resourceId: input.rootNodeId,
            revision: input.rootResourceRevision,
            ordinal: 1n,
            createdAt: now,
          },
        );
        state.contentRevisions.push({
          collectionId: input.collectionId,
          revision: input.contentRevision,
          ordinal: 1n,
          createdAt: now,
        });
        state.policyRevisions.push({
          collectionId: input.collectionId,
          revision: input.policyRevision,
          ordinal: 1n,
          createdAt: now,
        });
        state.childrenRevisions.push({
          collectionId: input.collectionId,
          parentId: input.rootNodeId,
          revision: input.rootChildrenRevision,
          ordinal: 1n,
        });
        state.operations.push({
          operationId: input.operationId,
          collectionId: input.collectionId,
          commitOrdinal: 1n,
          operationType: CREATE_OWNED_COLLECTION_OPERATION_TYPE,
          payload: {},
          actorPrincipalId: input.actor.principalId,
          createdAt: now,
        });
        if (state.failAfter === 'operation') {
          throw new Error('injected fault after operation append');
        }
        state.audit.push({
          operationId: input.operationId,
          collectionId: input.collectionId,
          principalId: input.actor.principalId,
          eventType: 'collection.created',
          details: {},
          createdAt: now,
        });
        state.outbox.push({
          outboxId: input.outboxId,
          domainEventId: input.domainEventId,
          eventType: 'collection.created',
          eventVersion: 1,
          handlerName: 'collection_created_projection',
          handlerMode: 'projection_latest_only',
          aggregateType: 'collection',
          aggregateId: input.collectionId,
          aggregateScope: input.collectionId,
          aggregateRevision: input.resourceRevision,
          commitOrdinal: 1n,
          payload: {},
          occurredAt: now,
        });
        if (state.failAfter === 'outbox') {
          throw new Error('injected fault after outbox append');
        }
        return { createdAt: now, updatedAt: now, commitOrdinal: 1n };
      },
      async execute() {
        throw new Error('create harness does not execute metadata mutations');
      },
    },
  };
}

function createState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    now: new Date(NOW),
    receipts: new Map(),
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
    bootstraps: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<CreateOwnedCollectionInput> = {}): CreateOwnedCollectionInput {
  const { actor: actorOverrides, command: commandOverrides, ...rest } = overrides;
  return {
    title: 'Reading List',
    summary: 'phase-1 owned collection',
    kind: 'bookmarks',
    collectionId: COLLECTION_ID,
    rootNodeId: ROOT_ID,
    operationId: OPERATION_ID,
    ...rest,
    actor: {
      principalId: PRINCIPAL_A,
      principalType: 'account',
      subjectId: SUBJECT_A,
      ...actorOverrides,
    },
    command: {
      commandId: COMMAND_A,
      fingerprint: FINGERPRINT_A,
      commandScope: CREATE_OWNED_COLLECTION_COMMAND_SCOPE,
      ...commandOverrides,
    },
  };
}

function assertCreated(
  outcome: CreateOwnedCollectionResult,
): Extract<CreateOwnedCollectionResult, { kind: 'created' }> {
  assert.equal(outcome.kind, 'created', `expected created, got ${outcome.kind}`);
  return outcome as Extract<CreateOwnedCollectionResult, { kind: 'created' }>;
}

function completedReceipt(state: MemoryState, binding?: ProductCommandBinding): ProductCommandResult {
  const key = binding
    ? receiptKey(binding)
    : [...state.receipts.keys()][0];
  assert.ok(key, 'expected a receipt');
  const row = state.receipts.get(key!);
  assert.ok(row?.result, 'expected completed receipt result');
  return row!.result!;
}

function decodeBody(result: ProductCommandResult): {
  collection: Record<string, unknown>;
  root: Record<string, unknown>;
} {
  const parsed = JSON.parse(new TextDecoder().decode(result.body)) as {
    collection: Record<string, unknown>;
    root: Record<string, unknown>;
  };
  assert.ok(parsed.collection && parsed.root);
  return parsed;
}

function expectCollectionsCode(error: unknown, code: string): void {
  assert.ok(error instanceof CollectionsError, `expected CollectionsError, got ${String(error)}`);
  assert.equal(error.code, code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOwnedCollectionCanonical: happy path', () => {
  test('delegates one canonical bootstrap; builds private collection + root snapshot and receipt 201', async () => {
    const state = createState();
    const ports = createMemoryPorts(state);
    const input = baseInput();

    const created = assertCreated(await createOwnedCollectionCanonical(ports, input));

    assert.equal(created.commitOrdinal, 1n);
    assert.equal(created.operationId, OPERATION_ID);
    assert.equal(created.collection.id, COLLECTION_ID);
    assert.equal(created.collection.visibility, 'private');
    assert.equal(created.collection.title, 'Reading List');
    assert.equal(created.collection.summary, 'phase-1 owned collection');
    assert.equal(created.collection.kind, 'bookmarks');
    assert.equal(created.collection.rootNodeId, ROOT_ID);
    assert.equal(created.root.id, ROOT_ID);
    assert.equal(created.root.collectionId, COLLECTION_ID);
    assert.equal(created.root.kind, 'folder');
    assert.equal(created.root.folderRole, 'root');
    assert.equal(created.root.parentId, null);
    assert.equal(created.root.title, 'Reading List');
    assert.equal(created.root.readOnly, true);

    // Exactly one canonical bootstrap; the executor owns the persisted writes.
    assert.equal(state.bootstraps.length, 1);
    const bootstrap = state.bootstraps[0]!;
    assert.deepEqual(bootstrap.actor, {
      principalId: PRINCIPAL_A,
      principalType: 'account',
      subjectId: SUBJECT_A,
    });
    assert.equal(bootstrap.collectionId, COLLECTION_ID);
    assert.equal(bootstrap.rootNodeId, ROOT_ID);
    assert.equal(bootstrap.operationId, OPERATION_ID);
    assert.ok(bootstrap.domainEventId.length > 0);
    assert.ok(bootstrap.outboxId.length > 0);
    assert.equal(bootstrap.title, 'Reading List');
    assert.equal(bootstrap.summary, 'phase-1 owned collection');
    assert.equal(bootstrap.kind, 'bookmarks');
    assert.ok(bootstrap.resourceRevision.length > 0);
    assert.ok(bootstrap.contentRevision.length > 0);
    assert.ok(bootstrap.policyRevision.length > 0);
    assert.ok(bootstrap.rootResourceRevision.length > 0);
    assert.ok(bootstrap.rootChildrenRevision.length > 0);

    // Persisted rows (executor mock mirrors the canonical bootstrap write set)
    assert.equal(state.collections.length, 1);
    assert.equal(state.collections[0]!.visibility, 'private');
    assert.equal(state.collections[0]!.ownerSubjectId, SUBJECT_A);
    assert.equal(state.collections[0]!.commitOrdinal, 1n);
    assert.equal(state.collections[0]!.summary, 'phase-1 owned collection');
    assert.equal(state.nodes.length, 1);
    assert.equal(state.nodes[0]!.id, ROOT_ID);
    assert.equal(state.nodes[0]!.title, 'Reading List');

    // Owner membership with subjectId
    assert.equal(state.memberships.length, 1);
    assert.equal(state.memberships[0]!.role, 'owner');
    assert.equal(state.memberships[0]!.subjectId, SUBJECT_A);
    assert.equal(state.memberships[0]!.collectionId, COLLECTION_ID);
    assert.equal(state.policies.size, 1);

    // Revisions: collection+root resource, content, policy, children
    assert.equal(state.resourceRevisions.length, 2);
    assert.equal(state.contentRevisions.length, 1);
    assert.equal(state.policyRevisions.length, 1);
    assert.equal(state.childrenRevisions.length, 1);
    assert.equal(state.childrenRevisions[0]!.parentId, ROOT_ID);
    assert.equal(state.resourceRevisions[0]!.ordinal, 1n);

    // Operation + audit + outbox once
    assert.equal(state.operations.length, 1);
    assert.equal(state.operations[0]!.operationType, CREATE_OWNED_COLLECTION_OPERATION_TYPE);
    assert.equal(state.operations[0]!.commitOrdinal, 1n);
    assert.equal(state.operations[0]!.actorPrincipalId, PRINCIPAL_A);
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0]!.principalId, PRINCIPAL_A);
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0]!.aggregateId, COLLECTION_ID);
    assert.equal(state.outbox[0]!.commitOrdinal, 1n);

    // ID ledger: collection, node, operation, domain-event, outbox
    assert.equal(state.ledger.length, 5);
    const types = new Set(state.ledger.map((e) => e.resourceType));
    assert.ok(types.has('collection'));
    assert.ok(types.has('node'));
    assert.ok(types.has('operation'));
    assert.ok(types.has('domain-event'));
    assert.ok(types.has('outbox'));

    // Receipt completed with 201 + Location + ETag matching body
    const product = completedReceipt(state);
    assert.equal(product.status, 201);
    assert.equal(product.stableHeaders.location, `/api/v1/collections/${COLLECTION_ID}`);
    assert.equal(product.stableHeaders.etag, created.collection.etag);
    assert.equal(product.stableHeaders['cache-control'], 'private, no-store');
    assert.equal(product.stableHeaders['content-type'], 'application/json');
    assert.equal(product.targetIdentity, COLLECTION_ID);

    const body = decodeBody(product);
    assert.equal(body.collection.id, COLLECTION_ID);
    assert.equal(body.collection.visibility, 'private');
    assert.equal(body.collection.etag, created.collection.etag);
    assert.equal(body.root.folderRole, 'root');
    assert.equal(body.root.title, 'Reading List');
    assert.equal(product.stableHeaders.etag, body.collection.etag);
  });
});

describe('createOwnedCollectionCanonical: validation', () => {
  test('rejects empty title, whitespace title, too-long summary, and invalid kind without delegation', async () => {
    const state = createState();
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => createOwnedCollectionCanonical(ports, baseInput({ title: '' })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_title');
        return true;
      },
    );

    await assert.rejects(
      () => createOwnedCollectionCanonical(ports, baseInput({ title: '   ' })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_title');
        return true;
      },
    );

    await assert.rejects(
      () => createOwnedCollectionCanonical(ports, baseInput({ summary: 'x'.repeat(2001) })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_summary');
        return true;
      },
    );

    await assert.rejects(
      () => createOwnedCollectionCanonical(ports, baseInput({ kind: 'not-a-kind' })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_kind');
        return true;
      },
    );

    assert.equal(state.bootstraps.length, 0);
    assert.equal(state.collections.length, 0);
    assert.equal(state.nodes.length, 0);
    assert.equal(state.memberships.length, 0);
    assert.equal(state.operations.length, 0);
    assert.equal(state.receipts.size, 0);
    assert.equal(state.ledger.length, 0);
  });
});

describe('createOwnedCollectionCanonical: command receipt outcomes', () => {
  test('exact retry with same commandId+fingerprint returns replay with identical body/headers and no second bootstrap', async () => {
    const state = createState();
    const ports = createMemoryPorts(state);
    const input = baseInput();

    const first = assertCreated(await createOwnedCollectionCanonical(ports, input));
    const firstProduct = completedReceipt(state);

    const counts = {
      bootstraps: state.bootstraps.length,
      collections: state.collections.length,
      nodes: state.nodes.length,
      memberships: state.memberships.length,
      operations: state.operations.length,
      audit: state.audit.length,
      outbox: state.outbox.length,
      ledger: state.ledger.length,
    };

    const second = await createOwnedCollectionCanonical(ports, input);
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;

    assert.equal(second.status, 201);
    assert.equal(second.status, firstProduct.status);
    assert.deepEqual(second.stableHeaders, firstProduct.stableHeaders);
    assert.equal(second.mediaType, firstProduct.mediaType);
    assert.deepEqual(
      Buffer.from(second.body).toString('hex'),
      Buffer.from(firstProduct.body).toString('hex'),
    );

    assert.equal(state.bootstraps.length, counts.bootstraps);
    assert.equal(state.collections.length, counts.collections);
    assert.equal(state.nodes.length, counts.nodes);
    assert.equal(state.memberships.length, counts.memberships);
    assert.equal(state.operations.length, counts.operations);
    assert.equal(state.audit.length, counts.audit);
    assert.equal(state.outbox.length, counts.outbox);
    assert.equal(state.ledger.length, counts.ledger);
    void first;
  });

  test('different fingerprint with same commandId returns reused without additional bootstrap', async () => {
    const state = createState();
    const ports = createMemoryPorts(state);

    assertCreated(
      await createOwnedCollectionCanonical(
        ports,
        baseInput({ command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A } }),
      ),
    );
    const afterFirst = {
      bootstraps: state.bootstraps.length,
      collections: state.collections.length,
      operations: state.operations.length,
      memberships: state.memberships.length,
    };

    const reused = await createOwnedCollectionCanonical(
      ports,
      baseInput({
        title: 'Different intent',
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.bootstraps.length, afterFirst.bootstraps);
    assert.equal(state.collections.length, afterFirst.collections);
    assert.equal(state.operations.length, afterFirst.operations);
    assert.equal(state.memberships.length, afterFirst.memberships);
  });

  test('in_progress claim returns without delegation', async () => {
    const state = createState({ forceInProgress: true });
    const ports = createMemoryPorts(state);

    const outcome = await createOwnedCollectionCanonical(ports, baseInput());
    assert.equal(outcome.kind, 'in_progress');
    if (outcome.kind === 'in_progress') {
      assert.ok(outcome.retryAfterSeconds >= 1);
    }
    assert.equal(state.bootstraps.length, 0);
    assert.equal(state.collections.length, 0);
    assert.equal(state.nodes.length, 0);
    assert.equal(state.memberships.length, 0);
    assert.equal(state.operations.length, 0);
    assert.equal(state.audit.length, 0);
    assert.equal(state.outbox.length, 0);
    assert.equal(state.ledger.length, 0);
  });

  test('expired claim surfaces expired outcome without new delegation', async () => {
    const state = createState();
    state.receipts.set(
      `${PRINCIPAL_A}\0${CREATE_OWNED_COLLECTION_COMMAND_SCOPE}\0${COMMAND_A}`,
      {
        fingerprint: FINGERPRINT_A,
        status: 'completed',
        resultDigest: 'old-digest',
        expired: true,
        result: {
          status: 201,
          body: new Uint8Array([1]),
          stableHeaders: {
            etag: '"gone"',
            location: '/api/v1/collections/x',
          },
          mediaType: 'application/json',
          contractVersion: '1.0.0',
        },
      },
    );
    const ports = createMemoryPorts(state);

    const outcome = await createOwnedCollectionCanonical(ports, baseInput());
    assert.equal(outcome.kind, 'expired');
    if (outcome.kind === 'expired') {
      assert.equal(outcome.resultDigest, 'old-digest');
    }
    assert.equal(state.bootstraps.length, 0);
    assert.equal(state.collections.length, 0);
    assert.equal(state.operations.length, 0);
  });
});

describe('createOwnedCollectionCanonical: fault injection and rollback', () => {
  test('fault after collection insert rolls back; retry with clean state succeeds', async () => {
    const state = createState({ failAfter: 'collection-insert' });

    await assert.rejects(
      () => withRollback(state, (ports) => createOwnedCollectionCanonical(ports, baseInput())),
      /injected fault after collection insert/,
    );

    assert.equal(state.collections.length, 0);
    assert.equal(state.nodes.length, 0);
    assert.equal(state.memberships.length, 0);
    assert.equal(state.operations.length, 0);
    assert.equal(state.audit.length, 0);
    assert.equal(state.outbox.length, 0);
    assert.equal(state.receipts.size, 0);
    assert.equal(state.ledger.length, 0);

    state.failAfter = undefined;
    const outcome = await withRollback(state, (ports) => createOwnedCollectionCanonical(ports, baseInput()));
    const created = assertCreated(outcome);
    assert.equal(created.commitOrdinal, 1n);
    assert.equal(state.collections.length, 1);
    assert.equal(state.memberships.length, 1);
    assert.equal(state.operations.length, 1);
    assert.equal(completedReceipt(state).status, 201);
  });

  test('fault after membership rolls back so receipt is not completed; retry claims again', async () => {
    const state = createState({ failAfter: 'membership' });

    await assert.rejects(
      () => withRollback(state, (ports) => createOwnedCollectionCanonical(ports, baseInput())),
      /injected fault after membership/,
    );

    assert.equal(state.collections.length, 0);
    assert.equal(state.memberships.length, 0);
    assert.equal(state.receipts.size, 0);

    state.failAfter = undefined;
    const outcome = await withRollback(state, (ports) => createOwnedCollectionCanonical(ports, baseInput()));
    assert.equal(outcome.kind, 'created');
  });
});

describe('createOwnedCollectionCanonical: principal isolation', () => {
  test('different principalId with the same commandId can create independently', async () => {
    const state = createState();
    const ports = createMemoryPorts(state);

    const first = assertCreated(
      await createOwnedCollectionCanonical(
        ports,
        baseInput({
          actor: { principalId: PRINCIPAL_A, principalType: 'account', subjectId: SUBJECT_A },
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_A },
          title: 'A collection',
          collectionId: 'col-a',
          rootNodeId: 'root-a',
          operationId: 'op-a',
        }),
      ),
    );

    const second = assertCreated(
      await createOwnedCollectionCanonical(
        ports,
        baseInput({
          actor: { principalId: PRINCIPAL_B, principalType: 'account', subjectId: SUBJECT_B },
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_A },
          title: 'B collection',
          collectionId: 'col-b',
          rootNodeId: 'root-b',
          operationId: 'op-b',
        }),
      ),
    );

    assert.equal(state.collections.length, 2);
    assert.equal(state.memberships.length, 2);
    assert.equal(state.operations.length, 2);
    assert.equal(state.receipts.size, 2);

    const owners = new Set(state.memberships.map((m) => m.subjectId));
    assert.ok(owners.has(SUBJECT_A));
    assert.ok(owners.has(SUBJECT_B));

    assert.equal(first.collection.title, 'A collection');
    assert.equal(second.collection.title, 'B collection');
    assert.notEqual(first.collection.id, second.collection.id);
  });
});

describe('createOwnedCollectionCanonical: access policy owner membership', () => {
  test('writes owner membership with subjectId and owner role; actor principal is audit-only', async () => {
    const state = createState();
    const ports = createMemoryPorts(state);

    assertCreated(
      await createOwnedCollectionCanonical(
        ports,
        baseInput({
          actor: { principalId: PRINCIPAL_A, principalType: 'account', subjectId: SUBJECT_A },
          command: { commandId: COMMAND_C, fingerprint: FINGERPRINT_A },
        }),
      ),
    );

    assert.equal(state.memberships.length, 1);
    const membership = state.memberships[0]!;
    assert.equal(membership.role, 'owner');
    assert.equal(membership.subjectId, SUBJECT_A);
    assert.equal(membership.collectionId, COLLECTION_ID);
    assert.ok(membership.grantedAt instanceof Date);

    assert.equal(state.policies.size, 1);
    assert.equal([...state.policies.keys()][0], COLLECTION_ID);

    assert.equal(state.collections[0]!.ownerSubjectId, SUBJECT_A);
    assert.equal(state.collections[0]!.visibility, 'private');

    // Actor principal is for audit/receipt, not ownership.
    assert.equal(state.audit[0]!.principalId, PRINCIPAL_A);
    assert.equal(state.operations[0]!.actorPrincipalId, PRINCIPAL_A);
    assert.notEqual(PRINCIPAL_A, SUBJECT_A);
  });
});

describe('createOwnedCollectionCanonical: command scope default', () => {
  test('defaults command scope to the collection-create intent when omitted', async () => {
    const state = createState();
    const ports = createMemoryPorts(state);

    // Build input without commandScope so production applies the constant default.
    const input: CreateOwnedCollectionInput = {
      actor: {
        principalId: PRINCIPAL_A,
        principalType: 'account',
        subjectId: SUBJECT_A,
      },
      command: {
        commandId: COMMAND_A,
        fingerprint: FINGERPRINT_A,
      },
      title: 'Scoped',
      summary: null,
      kind: 'mixed',
      collectionId: COLLECTION_ID,
      rootNodeId: ROOT_ID,
      operationId: OPERATION_ID,
    };

    assertCreated(await createOwnedCollectionCanonical(ports, input));

    const keys = [...state.receipts.keys()];
    assert.equal(keys.length, 1);
    assert.ok(
      keys[0]!.includes(CREATE_OWNED_COLLECTION_COMMAND_SCOPE),
      `expected default scope in receipt key, got ${keys[0]}`,
    );
    assert.equal(CREATE_OWNED_COLLECTION_COMMAND_SCOPE, 'collection:create');
  });
});
