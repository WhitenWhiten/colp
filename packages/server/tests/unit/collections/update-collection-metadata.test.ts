/**
 * P1-07 updateCollectionMetadataCanonical application unit tests (in-memory canonical ports).
 *
 * Production surface:
 *   updateCollectionMetadataCanonical(ports, input)
 *     → updated | replay | in_progress | reused | expired
 *   Command scope default: collection:{id}:metadata:update
 *   Capability: update_collection_metadata (owner/editor; viewer deny; non-member conceal)
 *   The canonical mutation executor owns ID ledger, revisions, Operation/Audit/Outbox and the
 *   ADR-0007 payload rebuild; the application delegates exactly one canonical 'update' mutation
 *   and builds the Product snapshot + receipt from the returned allocation.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type {
  AccessPolicyFactsPort,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../../src/modules/access-policy/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  ifMatchSatisfied,
  strongEntityTag,
  updateCollectionMetadataCanonical,
  updateCollectionMetadataCommandScope,
  type CanonicalMutationInput,
  type LockedCollectionRow,
  type ProductCollectionCanonicalPorts,
  type UpdateCollectionMetadataInput,
  type UpdateCollectionMetadataResult,
} from '../../../src/modules/collections/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');

const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const COMMAND_C = '11111111-2222-4333-8444-555555555555';

const PRINCIPAL_OWNER = 'principal-owner';
const SUBJECT_OWNER = 'subject-owner';
const PRINCIPAL_EDITOR = 'principal-editor';
const SUBJECT_EDITOR = 'subject-editor';
const PRINCIPAL_VIEWER = 'principal-viewer';
const SUBJECT_VIEWER = 'subject-viewer';
const PRINCIPAL_STRANGER = 'principal-stranger';
const SUBJECT_STRANGER = 'subject-stranger';

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

const COLLECTION_ID = 'col-meta-0001';
const ROOT_ID = 'root-meta-0001';
const RESOURCE_REV = 'resource-rev-meta-1';
const CONTENT_REV = 'content-rev-meta-1';
const POLICY_REV = 'policy-rev-meta-1';
const OPERATION_ID = 'op-meta-0001';

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
}

interface MutableCollection extends LockedCollectionRow {}

interface MemoryState {
  now: Date;
  receipts: Map<string, ReceiptRow>;
  collections: Map<string, MutableCollection>;
  memberships: MembershipRow[];
  /** Canonical 'update' mutations delegated to the executor mock, in order. */
  capturedMutations: CanonicalMutationInput[];
  forceInProgress?: boolean;
  /** When set, lockForUpdate returns this revision for If-Match races. */
  lockResourceRevisionOverride?: string;
}

function receiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
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

function createMemoryAccessPolicyFacts(state: MemoryState): AccessPolicyFactsPort {
  return {
    async loadCollectionFacts(input): Promise<ResourcePolicyFacts | null> {
      const collection = state.collections.get(input.collectionId);
      if (!collection) return null;
      const membership = state.memberships.find(
        (m) => m.collectionId === input.collectionId && m.subjectId === input.actorSubjectId,
      );
      return {
        collectionId: collection.id,
        ownerSubjectId: collection.ownerSubjectId,
        visibility: collection.visibility,
        policyRevision: collection.policyRevision,
        membershipRole: membership?.role ?? null,
        deleted: collection.deletedAt !== null,
      };
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
      async lockForUpdate(collectionId) {
        const row = state.collections.get(collectionId);
        if (!row) return null;
        const locked: LockedCollectionRow = {
          ...row,
          resourceRevision: state.lockResourceRevisionOverride ?? row.resourceRevision,
        };
        return locked;
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
    accessPolicy: createMemoryAccessPolicyFacts(state),
    canonical: {
      async execute(input) {
        state.capturedMutations.push(input);
        const row = state.collections.get(input.collectionId);
        if (!row) throw new Error(`missing collection ${input.collectionId}`);
        const fields = input.mutation.fields!.kindFields as Record<string, unknown>;
        const nextCommit = row.commitOrdinal + 1n;
        const contentChanged = fields.title !== row.title || fields.summary !== row.summary;
        const policyChanged = fields.visibility !== row.visibility
          || fields.allowSearchIndexing !== row.allowSearchIndexing;
        const allocation = {
          commitOrdinal: nextCommit,
          resourceRevision: `resource-${String(nextCommit)}`,
          ...(contentChanged ? { contentRevision: `content-${String(nextCommit)}` } : {}),
          ...(policyChanged ? { policyRevision: `policy-${String(nextCommit)}` } : {}),
          childrenRevisions: {},
        };
        // Executor write-back so later If-Match reads observe the new revision.
        row.title = fields.title as string;
        row.summary = fields.summary as string | null;
        row.visibility = fields.visibility as MutableCollection['visibility'];
        row.allowSearchIndexing = fields.allowSearchIndexing as boolean;
        if (fields.publicationSlug !== undefined) {
          row.publicationSlug = fields.publicationSlug as string | null;
        }
        row.resourceRevision = allocation.resourceRevision;
        if (allocation.contentRevision !== undefined) {
          row.contentRevision = allocation.contentRevision;
        }
        if (allocation.policyRevision !== undefined) {
          row.policyRevision = allocation.policyRevision;
        }
        row.commitOrdinal = allocation.commitOrdinal;
        row.updatedAt = new Date(state.now);
        return {
          operationId: input.operationId,
          collectionId: input.collectionId,
          resourceId: input.collectionId,
          action: 'update',
          allocation,
        };
      },
      async bootstrapOwnedCollection() {
        throw new Error('unused by updateCollectionMetadataCanonical');
      },
    },
  };
}

function createState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    now: new Date(NOW),
    receipts: new Map(),
    collections: new Map(),
    memberships: [],
    capturedMutations: [],
    ...overrides,
  };
}

function seedOwnedCollection(
  state: MemoryState,
  options: {
    collectionId?: string;
    ownerSubjectId?: string;
    title?: string;
    summary?: string | null;
    visibility?: LockedCollectionRow['visibility'];
    allowSearchIndexing?: boolean;
    publicationSlug?: string | null;
    publishedAt?: Date | null;
    resourceRevision?: string;
    contentRevision?: string;
    policyRevision?: string;
    commitOrdinal?: bigint;
    deletedAt?: Date | null;
    memberships?: Array<{ subjectId: string; role: MembershipRole }>;
  } = {},
): MutableCollection {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const ownerSubjectId = options.ownerSubjectId ?? SUBJECT_OWNER;
  const createdAt = new Date(state.now);
  const row: MutableCollection = {
    id: collectionId,
    ownerSubjectId,
    title: options.title ?? 'Original Title',
    summary: options.summary === undefined ? 'original summary' : options.summary,
    kind: 'bookmarks',
    visibility: options.visibility ?? 'private',
    allowSearchIndexing: options.allowSearchIndexing ?? false,
    publicationSlug: options.publicationSlug ?? null,
    publishedAt: options.publishedAt ?? null,
    rootNodeId: ROOT_ID,
    resourceRevision: options.resourceRevision ?? RESOURCE_REV,
    contentRevision: options.contentRevision ?? CONTENT_REV,
    policyRevision: options.policyRevision ?? POLICY_REV,
    commitOrdinal: options.commitOrdinal ?? 1n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: options.deletedAt ?? null,
  };
  state.collections.set(collectionId, row);
  state.memberships.push({
    collectionId,
    subjectId: ownerSubjectId,
    role: 'owner',
  });
  for (const m of options.memberships ?? []) {
    state.memberships.push({
      collectionId,
      subjectId: m.subjectId,
      role: m.role,
    });
  }
  return row;
}

function defaultCommandScope(collectionId = COLLECTION_ID): string {
  return updateCollectionMetadataCommandScope(collectionId);
}

function baseInput(
  overrides: Partial<UpdateCollectionMetadataInput> = {},
): UpdateCollectionMetadataInput {
  const collectionId = overrides.collectionId ?? COLLECTION_ID;
  return {
    actor: {
      principalId: PRINCIPAL_OWNER,
      principalType: 'account',
      subjectId: SUBJECT_OWNER,
      ...overrides.actor,
    },
    command: {
      commandId: COMMAND_A,
      fingerprint: FINGERPRINT_A,
      commandScope: defaultCommandScope(collectionId),
      ...overrides.command,
    },
    collectionId,
    ifMatch: overrides.ifMatch ?? strongEntityTag(RESOURCE_REV),
    patch: overrides.patch ?? { title: 'Updated Title' },
    operationId: overrides.operationId ?? OPERATION_ID,
    productOrigin: overrides.productOrigin,
  };
}

function assertUpdated(
  outcome: UpdateCollectionMetadataResult,
): Extract<UpdateCollectionMetadataResult, { kind: 'updated' }> {
  assert.equal(outcome.kind, 'updated', `expected updated, got ${outcome.kind}`);
  return outcome as Extract<UpdateCollectionMetadataResult, { kind: 'updated' }>;
}

function completedReceipt(state: MemoryState): ProductCommandResult {
  const key = [...state.receipts.keys()][0];
  assert.ok(key, 'expected a receipt');
  const row = state.receipts.get(key!);
  assert.ok(row?.result, 'expected completed receipt result');
  return row!.result!;
}

function decodeBody(result: ProductCommandResult): {
  collection: Record<string, unknown>;
} {
  const parsed = JSON.parse(new TextDecoder().decode(result.body)) as {
    collection: Record<string, unknown>;
  };
  assert.ok(parsed.collection);
  return parsed;
}

function expectCollectionsCode(error: unknown, code: string): void {
  assert.ok(error instanceof CollectionsError, `expected CollectionsError, got ${String(error)}`);
  assert.equal(error.code, code);
}

// ---------------------------------------------------------------------------
// Merge patch validation
// ---------------------------------------------------------------------------

describe('updateCollectionMetadataCanonical: merge patch validation', () => {
  test('accepts title-only, summary-only, and both', async () => {
    for (const [label, patch, expectedTitle, expectedSummary] of [
      ['title-only', { title: 'Title Only' }, 'Title Only', 'original summary'],
      ['summary-only', { summary: 'Summary Only' }, 'Original Title', 'Summary Only'],
      ['both', { title: 'Both Title', summary: 'Both Summary' }, 'Both Title', 'Both Summary'],
    ] as const) {
      const state = createState();
      seedOwnedCollection(state);
      const ports = createMemoryPorts(state);
      const updated = assertUpdated(
        await updateCollectionMetadataCanonical(
          ports,
          baseInput({
            command: {
              commandId: COMMAND_A,
              fingerprint: FINGERPRINT_A + label,
            },
            patch,
            operationId: `op-${label}`,
          }),
        ),
      );
      assert.equal(updated.collection.title, expectedTitle, label);
      assert.equal(updated.collection.summary, expectedSummary, label);
      const fields = state.capturedMutations[0]!.mutation.fields!.kindFields as Record<string, unknown>;
      assert.equal(fields.title, expectedTitle, label);
      assert.equal(fields.summary, expectedSummary, label);
    }
  });

  test('summary null clears summary', async () => {
    const state = createState();
    seedOwnedCollection(state, { summary: 'will clear' });
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(ports, baseInput({ patch: { summary: null } })),
    );

    assert.equal(updated.collection.summary, null);
    assert.equal(state.collections.get(COLLECTION_ID)!.summary, null);
  });

  test('empty object / missing title and summary is invalid_collection_input', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput({ patch: {} })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_input');
        return true;
      },
    );
    assert.equal(state.capturedMutations.length, 0);
    assert.equal(state.receipts.size, 0);
  });

  test('additionalProperties (tags, kind, cover, root) are rejected', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    for (const patch of [
      { title: 'X', tags: ['a'] },
      { kind: 'mixed', title: 'X' },
      { cover: 'x' },
      { rootNodeId: 'evil' },
    ] as const) {
      await assert.rejects(
        () =>
          updateCollectionMetadataCanonical(
            ports,
            baseInput({
              patch: patch as unknown as UpdateCollectionMetadataInput['patch'],
            }),
          ),
        (error: unknown) => {
          expectCollectionsCode(error, 'invalid_collection_input');
          return true;
        },
      );
    }
    assert.equal(state.capturedMutations.length, 0);
    assert.equal(state.receipts.size, 0);
  });

  test('title null or blank is rejected', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionMetadataCanonical(
          ports,
          baseInput({
            // Application type is string|undefined; null is a runtime guard.
            patch: { title: null as unknown as string },
          }),
        ),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_title');
        return true;
      },
    );

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput({ patch: { title: '' } })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_title');
        return true;
      },
    );

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput({ patch: { title: '   ' } })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_title');
        return true;
      },
    );

    assert.equal(state.capturedMutations.length, 0);
    assert.equal(state.receipts.size, 0);
  });

  test('overlong title and summary are rejected without delegation', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput({ patch: { title: 'x'.repeat(513) } })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_title');
        return true;
      },
    );

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput({ patch: { summary: 'y'.repeat(2001) } })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_summary');
        return true;
      },
    );

    assert.equal(state.capturedMutations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// If-Match / ETag
// ---------------------------------------------------------------------------

describe('updateCollectionMetadataCanonical: If-Match / ETag', () => {
  test('ifMatchSatisfied accepts strong entity-tag and bare revision', () => {
    assert.equal(ifMatchSatisfied(strongEntityTag(RESOURCE_REV), RESOURCE_REV), true);
    assert.equal(ifMatchSatisfied(RESOURCE_REV, RESOURCE_REV), true);
    assert.equal(ifMatchSatisfied(strongEntityTag('other'), RESOURCE_REV), false);
    assert.equal(ifMatchSatisfied('other', RESOURCE_REV), false);
  });

  test('stale ETag after lock → CollectionPreconditionError with currentEtag', async () => {
    const state = createState();
    seedOwnedCollection(state, { resourceRevision: RESOURCE_REV });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionMetadataCanonical(
          ports,
          baseInput({ ifMatch: strongEntityTag('stale-revision-token') }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionPreconditionError);
        assert.equal(error.code, 'precondition_failed');
        assert.equal(error.precondition, 'resource');
        assert.equal(error.currentEtag, strongEntityTag(RESOURCE_REV));
        return true;
      },
    );

    assert.equal(state.capturedMutations.length, 0);
    assert.equal(state.collections.get(COLLECTION_ID)!.title, 'Original Title');
  });

  test('matching ETag succeeds; response etag is new revision and equals body collection.etag', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);
    const previousPolicy = POLICY_REV;
    const previousCommit = 1n;

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({ ifMatch: strongEntityTag(RESOURCE_REV), patch: { title: 'New' } }),
      ),
    );

    assert.notEqual(updated.collection.revision, RESOURCE_REV);
    assert.equal(updated.collection.etag, strongEntityTag(updated.collection.revision));
    assert.notEqual(updated.collection.contentRevision, CONTENT_REV);
    assert.equal(updated.collection.policyRevision, previousPolicy);
    assert.equal(updated.collection.policyEtag, strongEntityTag(previousPolicy));
    assert.equal(updated.commitOrdinal, previousCommit + 1n);

    const product = completedReceipt(state);
    assert.equal(product.status, 200);
    assert.equal(product.stableHeaders.etag, updated.collection.etag);
    assert.equal(product.stableHeaders['cache-control'], 'private, no-store');
    const body = decodeBody(product);
    assert.equal(body.collection.etag, updated.collection.etag);
    assert.equal(body.collection.revision, updated.collection.revision);
    assert.equal(product.stableHeaders.etag, body.collection.etag);
  });

  test('bare revision token as ifMatch also matches', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(ports, baseInput({ ifMatch: RESOURCE_REV })),
    );
    assert.equal(updated.kind, 'updated');
  });
});

// ---------------------------------------------------------------------------
// Command admission
// ---------------------------------------------------------------------------

describe('updateCollectionMetadataCanonical: command admission', () => {
  test('same command + fingerprint → exact replay, no second canonical mutation', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);
    const input = baseInput();

    const first = assertUpdated(await updateCollectionMetadataCanonical(ports, input));
    const firstProduct = completedReceipt(state);
    const counts = {
      mutations: state.capturedMutations.length,
      title: state.collections.get(COLLECTION_ID)!.title,
      commitOrdinal: state.collections.get(COLLECTION_ID)!.commitOrdinal,
    };

    const second = await updateCollectionMetadataCanonical(ports, input);
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;

    assert.equal(second.status, 200);
    assert.equal(second.status, firstProduct.status);
    assert.deepEqual(second.stableHeaders, firstProduct.stableHeaders);
    assert.deepEqual(
      Buffer.from(second.body).toString('hex'),
      Buffer.from(firstProduct.body).toString('hex'),
    );

    assert.equal(state.capturedMutations.length, counts.mutations);
    assert.equal(state.collections.get(COLLECTION_ID)!.title, counts.title);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, counts.commitOrdinal);
    void first;
  });

  test('same command + different fingerprint → reused without delegation', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({ command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A } }),
      ),
    );
    const afterFirst = {
      mutations: state.capturedMutations.length,
      commitOrdinal: state.collections.get(COLLECTION_ID)!.commitOrdinal,
    };

    const reused = await updateCollectionMetadataCanonical(
      ports,
      baseInput({
        patch: { title: 'Different intent' },
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.capturedMutations.length, afterFirst.mutations);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, afterFirst.commitOrdinal);
  });

  test('in_progress claim returns without domain delegation', async () => {
    const state = createState({ forceInProgress: true });
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    const outcome = await updateCollectionMetadataCanonical(ports, baseInput());
    assert.equal(outcome.kind, 'in_progress');
    if (outcome.kind === 'in_progress') {
      assert.ok(outcome.retryAfterSeconds >= 1);
    }
    assert.equal(state.capturedMutations.length, 0);
  });

  test('expired claim surfaces expired without new delegation', async () => {
    const state = createState();
    seedOwnedCollection(state);
    state.receipts.set(
      `${PRINCIPAL_OWNER}\0${defaultCommandScope()}\0${COMMAND_A}`,
      {
        fingerprint: FINGERPRINT_A,
        status: 'completed',
        resultDigest: 'old-digest',
        expired: true,
        result: {
          status: 200,
          body: new Uint8Array([1]),
          stableHeaders: { etag: '"gone"' },
          mediaType: 'application/json',
          contractVersion: '1.0.0',
        },
      },
    );
    const ports = createMemoryPorts(state);

    const outcome = await updateCollectionMetadataCanonical(ports, baseInput());
    assert.equal(outcome.kind, 'expired');
    if (outcome.kind === 'expired') {
      assert.equal(outcome.resultDigest, 'old-digest');
    }
    assert.equal(state.capturedMutations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('updateCollectionMetadataCanonical: authorization', () => {
  test('owner and editor allowed; viewer denied', async () => {
    const state = createState();
    seedOwnedCollection(state, {
      memberships: [
        { subjectId: SUBJECT_EDITOR, role: 'editor' },
        { subjectId: SUBJECT_VIEWER, role: 'viewer' },
      ],
    });
    const ports = createMemoryPorts(state);

    const asOwner = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_OWNER,
            principalType: 'account',
            subjectId: SUBJECT_OWNER,
          },
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
          patch: { title: 'Owner Edit' },
          operationId: 'op-owner',
        }),
      ),
    );
    assert.equal(asOwner.collection.title, 'Owner Edit');

    // Refresh If-Match for second mutation (executor mock advanced the revision).
    const currentEtag = strongEntityTag(state.collections.get(COLLECTION_ID)!.resourceRevision);
    const asEditor = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_EDITOR,
            principalType: 'account',
            subjectId: SUBJECT_EDITOR,
          },
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
          ifMatch: currentEtag,
          patch: { title: 'Editor Edit' },
          operationId: 'op-editor',
        }),
      ),
    );
    assert.equal(asEditor.collection.title, 'Editor Edit');

    const afterEditorEtag = strongEntityTag(
      state.collections.get(COLLECTION_ID)!.resourceRevision,
    );
    await assert.rejects(
      () =>
        updateCollectionMetadataCanonical(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_VIEWER,
              principalType: 'account',
              subjectId: SUBJECT_VIEWER,
            },
            command: { commandId: COMMAND_C, fingerprint: FINGERPRINT_A },
            ifMatch: afterEditorEtag,
            patch: { title: 'Viewer Edit' },
            operationId: 'op-viewer',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'deny');
        assert.equal(error.reasonCategory, 'insufficient_role');
        return true;
      },
    );
    assert.equal(state.capturedMutations.length, 2);
  });

  test('non-member of private collection → conceal', async () => {
    const state = createState();
    seedOwnedCollection(state, { visibility: 'private' });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionMetadataCanonical(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_STRANGER,
              principalType: 'account',
              subjectId: SUBJECT_STRANGER,
            },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
    assert.equal(state.capturedMutations.length, 0);
  });

  test('missing collection → conceal 404 path', async () => {
    const state = createState();
    // no seed
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput({ collectionId: 'missing-col' })),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        assert.equal(error.reasonCategory, 'resource_missing');
        return true;
      },
    );
  });

  test('soft-deleted collection → conceal after authorize', async () => {
    const state = createState();
    seedOwnedCollection(state, { deletedAt: new Date(NOW) });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
    assert.equal(state.capturedMutations.length, 0);
  });

  test('policy revision mismatch after lock denies', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const base = createMemoryPorts(state);
    const ports = {
      ...base,
      accessPolicy: {
        async loadCollectionFacts(input: Parameters<typeof base.accessPolicy.loadCollectionFacts>[0]) {
          const facts = await base.accessPolicy.loadCollectionFacts(input);
          if (!facts) return null;
          return { ...facts, policyRevision: 'stale-policy-rev' };
        },
      },
    };

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'deny');
        assert.equal(error.reasonCategory, 'policy_revision_mismatch');
        return true;
      },
    );
    assert.equal(state.capturedMutations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Canonical mutation delegation
// ---------------------------------------------------------------------------

describe('updateCollectionMetadataCanonical: canonical mutation delegation', () => {
  test('delegates one canonical update with locked facts; content advances, policy unchanged, commit +1', async () => {
    const state = createState();
    seedOwnedCollection(state, {
      resourceRevision: RESOURCE_REV,
      contentRevision: CONTENT_REV,
      policyRevision: POLICY_REV,
      commitOrdinal: 5n,
    });
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({
          ifMatch: strongEntityTag(RESOURCE_REV),
          patch: { title: 'Rev Effects', summary: 's' },
        }),
      ),
    );

    // Exactly one canonical mutation; ledger/revisions/Operation/Audit/Outbox/payload
    // are owned by the canonical executor, not this application path.
    assert.equal(state.capturedMutations.length, 1);
    const captured = state.capturedMutations[0]!;
    assert.equal(captured.operationId, OPERATION_ID);
    assert.equal(captured.collectionId, COLLECTION_ID);
    assert.deepEqual(captured.actor, { principalId: PRINCIPAL_OWNER, principalType: 'account' });
    assert.equal(captured.mutation.action, 'update');
    assert.deepEqual(captured.mutation.target, {
      collectionId: COLLECTION_ID,
      resourceId: COLLECTION_ID,
      resourceKind: 'collection',
    });
    assert.equal(captured.mutation.parentId, null);
    assert.equal(captured.mutation.expectedResourceRevision, RESOURCE_REV);
    const fields = captured.mutation.fields!.kindFields as Record<string, unknown>;
    assert.equal(fields.title, 'Rev Effects');
    assert.equal(fields.summary, 's');
    assert.equal(fields.kind, 'bookmarks');
    assert.equal(fields.visibility, 'private');
    assert.equal(fields.allowSearchIndexing, false);
    assert.deepEqual(captured.mutation.fields!.extensions, {});

    // Allocation mapping: content revision advanced, policy revision untouched.
    const row = state.collections.get(COLLECTION_ID)!;
    assert.notEqual(row.resourceRevision, RESOURCE_REV);
    assert.notEqual(row.contentRevision, CONTENT_REV);
    assert.equal(row.policyRevision, POLICY_REV);
    assert.equal(row.commitOrdinal, 6n);
    assert.equal(updated.commitOrdinal, 6n);
    assert.equal(updated.collection.policyRevision, POLICY_REV);
    assert.equal(updated.collection.revision, row.resourceRevision);
    assert.equal(updated.collection.contentRevision, row.contentRevision);
  });

  test('publication patch advances policy revision; plain metadata patch does not', async () => {
    const state = createState();
    seedOwnedCollection(state, { commitOrdinal: 3n });
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({
          ifMatch: strongEntityTag(RESOURCE_REV),
          patch: { visibility: 'public', publicationSlug: 'eng-notes' },
        }),
      ),
    );
    assert.equal(updated.collection.policyRevision, 'policy-4');
    assert.equal(updated.collection.visibility, 'public');
    assert.equal(updated.collection.publicationSlug, 'eng-notes');
    assert.equal(updated.collection.publishedAt, '2026-07-22T12:00:00Z');
    assert.equal(state.capturedMutations.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Field authority
// ---------------------------------------------------------------------------

describe('updateCollectionMetadataCanonical: field authority', () => {
  test('merge patch only mutates title/summary; kind/visibility/root unchanged', async () => {
    const state = createState();
    seedOwnedCollection(state, {
      title: 'Keep Kind',
      summary: 's',
    });
    const ports = createMemoryPorts(state);
    const before = { ...state.collections.get(COLLECTION_ID)! };

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({ patch: { title: 'New Title Only' } }),
      ),
    );

    const after = state.collections.get(COLLECTION_ID)!;
    assert.equal(after.kind, before.kind);
    assert.equal(after.visibility, before.visibility);
    assert.equal(after.rootNodeId, before.rootNodeId);
    assert.equal(after.ownerSubjectId, before.ownerSubjectId);
    assert.equal(after.policyRevision, before.policyRevision);
    assert.equal(updated.collection.kind, 'bookmarks');
    assert.equal(updated.collection.visibility, 'private');
    assert.equal(updated.collection.rootNodeId, ROOT_ID);
    assert.equal(updated.collection.title, 'New Title Only');

    // No publication fields → snapshot omits publication keys and no policy advance.
    assert.equal('publicationSlug' in updated.collection, false);
    assert.equal('publishedAt' in updated.collection, false);
    const fields = state.capturedMutations[0]!.mutation.fields!.kindFields as Record<string, unknown>;
    assert.equal(fields.publicationSlug, undefined);
  });

  test('visibility public without publicationSlug is invalid_collection_input', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports, baseInput({ patch: { visibility: 'public' } })),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_input');
        return true;
      },
    );
    assert.equal(state.capturedMutations.length, 0);
  });

  test('publicationSlug on a private first publication is invalid_collection_input', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionMetadataCanonical(
          ports,
          baseInput({ patch: { publicationSlug: 'eng-notes' } }),
        ),
      (error: unknown) => {
        expectCollectionsCode(error, 'invalid_collection_input');
        return true;
      },
    );
    assert.equal(state.capturedMutations.length, 0);
  });

  test('first public publication sets slug + publishedAt and canonical location', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({
          patch: { visibility: 'public', publicationSlug: 'eng-notes', allowSearchIndexing: true },
          productOrigin: 'https://app.example.test',
        }),
      ),
    );

    assert.equal(updated.collection.visibility, 'public');
    assert.equal(updated.collection.allowSearchIndexing, true);
    assert.equal(updated.collection.publicationSlug, 'eng-notes');
    assert.equal(updated.collection.publishedAt, '2026-07-22T12:00:00Z');
    assert.equal(updated.stableHeaders.location, 'https://app.example.test/c/eng-notes');
    assert.equal(updated.mediaType, 'application/json');

    const product = completedReceipt(state);
    assert.equal(product.stableHeaders.location, 'https://app.example.test/c/eng-notes');
    assert.equal(product.contractVersion, '1.2.0');
  });

  test('canonical location is omitted without productOrigin', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionMetadataCanonical(
        ports,
        baseInput({ patch: { visibility: 'public', publicationSlug: 'eng-notes' } }),
      ),
    );
    assert.equal(updated.stableHeaders.location, undefined);
  });
});

// ---------------------------------------------------------------------------
// Command scope default
// ---------------------------------------------------------------------------

describe('updateCollectionMetadataCanonical: command scope default', () => {
  test('defaults command scope to the collection metadata-update intent', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const ports = createMemoryPorts(state);

    const input: UpdateCollectionMetadataInput = {
      actor: {
        principalId: PRINCIPAL_OWNER,
        principalType: 'account',
        subjectId: SUBJECT_OWNER,
      },
      command: {
        commandId: COMMAND_A,
        fingerprint: FINGERPRINT_A,
      },
      collectionId: COLLECTION_ID,
      ifMatch: strongEntityTag(RESOURCE_REV),
      patch: { title: 'Scoped' },
      operationId: OPERATION_ID,
    };

    assertUpdated(await updateCollectionMetadataCanonical(ports, input));

    const expectedScope = updateCollectionMetadataCommandScope(COLLECTION_ID);
    assert.equal(expectedScope, `collection:${COLLECTION_ID}:metadata:update`);

    const keys = [...state.receipts.keys()];
    assert.equal(keys.length, 1);
    assert.ok(
      keys[0]!.includes(expectedScope),
      `expected concrete collection scope in receipt key, got ${keys[0]}`,
    );
  });
});
