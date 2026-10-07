import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import type { Relation } from '@know-n/colp/types';
import {
  RELATION_MAX_JSON_DEPTH,
  RelationDeleteError,
  RelationUpdateError,
  deleteRelation,
  deleteRelationCommandScope,
  updateRelation,
  updateRelationCommandScope,
  type DeleteRelationInput,
  type RelationAuthorityRecord,
  type RelationMutationPorts,
  type UpdateRelationInput,
} from '../../../src/modules/collections/index.js';

const COLLECTION_ID = 'relation-mutation-unit-collection';
const RELATION_ID = 'relation-mutation-unit-relation';
const FROM_ID = 'relation-mutation-unit-from';
const TO_ID = 'relation-mutation-unit-to';
const REVISION = 'relation-r1';

function current(overrides: Partial<Relation> = {}): Readonly<Relation> {
  return Object.freeze({
    id: RELATION_ID,
    collectionId: COLLECTION_ID,
    type: 'related',
    fromNodeId: FROM_ID,
    toNodeId: TO_ID,
    label: 'Original',
    visibility: 'protected',
    createdAt: '2026-07-25T04:00:00.000Z',
    updatedAt: '2026-07-25T04:00:00.000Z',
    revision: REVISION,
    extensions: {},
    ...overrides,
  } as Relation);
}

function authority(relation = current(), deletedAt: Date | null = null): RelationAuthorityRecord {
  return { relation, deletedAt };
}

function precondition(revision = REVISION) {
  return { kind: 'single-strong-if-match' as const, entityTag: `"${revision}"`, expectedRevision: revision };
}

function updateInput(overrides: Partial<UpdateRelationInput> = {}): UpdateRelationInput {
  return {
    actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
    command: { commandId: randomUUID(), fingerprint: 'relation-update-fingerprint' },
    collectionId: COLLECTION_ID,
    relationId: RELATION_ID,
    precondition: precondition(),
    patch: { label: 'Updated' },
    operationId: `operation-${randomUUID()}`,
    ...overrides,
  };
}

function deleteInput(overrides: Partial<DeleteRelationInput> = {}): DeleteRelationInput {
  return {
    actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
    command: { commandId: randomUUID(), fingerprint: 'relation-delete-fingerprint' },
    collectionId: COLLECTION_ID,
    relationId: RELATION_ID,
    precondition: precondition(),
    operationId: `operation-${randomUUID()}`,
    ...overrides,
  };
}

interface FakeOptions {
  readonly record?: RelationAuthorityRecord | null;
  readonly role?: 'owner' | 'editor' | 'viewer' | null;
  readonly collectionVisibility?: 'public' | 'unlisted' | 'protected' | 'private';
  readonly endpointVisibility?: 'public' | 'unlisted' | 'protected' | 'private';
  readonly semanticDuplicate?: boolean;
  readonly claim?: 'claimed' | 'replay' | 'reused' | 'in_progress' | 'expired';
}

function fakePorts(options: FakeOptions = {}): RelationMutationPorts {
  const record = options.record === undefined ? authority() : options.record;
  return {
    receipts: {
      async claim() {
        if (options.claim === 'replay') return { kind: 'replay', result: {
          status: 200, body: Buffer.from('{"first":true}'),
          stableHeaders: { etag: '"relation-r2"', 'cache-control': 'private, no-store' },
          mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: RELATION_ID,
        } } as const;
        if (options.claim === 'reused') return { kind: 'reused' } as const;
        if (options.claim === 'in_progress') return { kind: 'in_progress', retryAfterSeconds: 1 } as const;
        if (options.claim === 'expired') return { kind: 'expired', resultDigest: 'a'.repeat(64) } as const;
        return { kind: 'claimed' } as const;
      },
      async complete() {}, async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; },
    },
    clock: { async now() { return new Date('2026-07-25T05:00:00.000Z'); } },
    collections: { async lockForUpdate(id) { return id === COLLECTION_ID ? {
      id, ownerSubjectId: 'subject-owner', title: 'Relations', summary: null, kind: 'bookmarks',
      visibility: options.collectionVisibility ?? 'public', publicationSlug: 'relations',
      publishedAt: new Date('2026-07-25T03:00:00.000Z'), rootNodeId: 'root',
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: 1n, createdAt: new Date('2026-07-25T03:00:00.000Z'),
      updatedAt: new Date('2026-07-25T03:00:00.000Z'), deletedAt: null,
    } : null; } },
    accessPolicy: { async loadCollectionFacts() { return {
      collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner',
      visibility: options.collectionVisibility ?? 'public', policyRevision: 'policy-r1',
      membershipRole: options.role === undefined ? 'editor' : options.role, deleted: false,
    }; } },
    endpoints: { async resolveLiveEndpoint(collectionId, nodeId) {
      return collectionId === COLLECTION_ID && (nodeId === FROM_ID || nodeId === TO_ID) ? {
        id: nodeId, collectionId, visibility: options.endpointVisibility ?? 'public', deletedAt: null,
      } : null;
    } },
    relations: {
      async hasLiveSemanticEdge() { return options.semanticDuplicate ?? false; },
      async loadAuthoritativeForUpdate(_collectionId, relationId) {
        return relationId === RELATION_ID ? record : null;
      },
    },
    canonical: { async execute(value) { return {
      operationId: value.operationId, collectionId: value.collectionId,
      resourceId: value.mutation.target.resourceId, action: value.mutation.action,
      allocation: { commitOrdinal: 2n, resourceRevision: 'relation-r2',
        contentRevision: 'content-r2', childrenRevisions: {} },
    }; } },
  };
}

async function rejectsUpdate(value: UpdateRelationInput, code: string, ports = fakePorts()) {
  await assert.rejects(() => updateRelation(ports, value), (error: unknown) => {
    assert.ok(error instanceof RelationUpdateError); assert.equal(error.code, code); return true;
  });
}

async function rejectsDelete(value: DeleteRelationInput, code: string, ports = fakePorts()) {
  await assert.rejects(() => deleteRelation(ports, value), (error: unknown) => {
    assert.ok(error instanceof RelationDeleteError); assert.equal(error.code, code); return true;
  });
}

test('Relation update/delete require one strong If-Match and stable item command scopes', async () => {
  const invalid = [
    undefined, { kind: 'missing' }, { kind: 'duplicate', values: ['"a"', '"b"'] },
    { kind: 'single-strong-if-match', entityTag: `W/"${REVISION}"`, expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: '*', expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: `"${REVISION}", "other"`, expectedRevision: REVISION },
  ];
  for (const evidence of invalid) {
    const updateCode = !evidence || (evidence as { kind?: string }).kind === 'missing'
      ? 'relation_precondition_required' : 'invalid_relation_precondition';
    await rejectsUpdate(updateInput({ precondition: evidence as never }), updateCode);
    await rejectsDelete(deleteInput({ precondition: evidence as never }), updateCode);
  }
  assert.equal(updateRelationCommandScope(COLLECTION_ID, RELATION_ID),
    `collection:${COLLECTION_ID}:relation:${RELATION_ID}:update`);
  assert.equal(deleteRelationCommandScope(COLLECTION_ID, RELATION_ID),
    `collection:${COLLECTION_ID}:relation:${RELATION_ID}:delete`);
});

test('Relation merge patch is closed and endpoints or identity can never be changed', async () => {
  for (const patch of [
    {}, { unknown: true }, { id: 'other' }, { collectionId: 'other' },
    { fromNodeId: TO_ID }, { toNodeId: FROM_ID }, { revision: 'chosen' },
    { createdAt: null }, { updatedAt: null },
  ]) await rejectsUpdate(updateInput({ patch: patch as never }), 'invalid_relation_patch');
});

test('Relation merge patch supports type, nullable label, visibility and extensions', async () => {
  const updated = await updateRelation(fakePorts(), updateInput({ patch: {
    type: 'supports', label: null, visibility: 'public',
    extensions: { 'https://known.test/relation': { enabled: true } },
  } }));
  assert.equal(updated.kind, 'updated');
  if (updated.kind !== 'updated') return;
  assert.equal(updated.relation.type, 'supports');
  assert.equal(Object.hasOwn(updated.relation, 'label'), false);
  assert.equal(updated.relation.fromNodeId, FROM_ID);
  assert.equal(updated.relation.toNodeId, TO_ID);
  assert.deepEqual(updated.relation.extensions, { 'https://known.test/relation': { enabled: true } });
});

test('Relation custom type requires a non-empty label after merge', async () => {
  await rejectsUpdate(updateInput({ patch: { type: 'custom', label: null } }), 'invalid_relation_document');
  const result = await updateRelation(fakePorts(), updateInput({ patch: { type: 'custom', label: 'Explains' } }));
  assert.equal(result.kind, 'updated');
});

test('Relation label, extension depth and complete candidate byte budgets fail closed', async () => {
  await rejectsUpdate(updateInput({ patch: { label: 'x'.repeat(4097) } }), 'relation_label_too_large');
  let nested: Record<string, unknown> = {};
  for (let index = 0; index <= RELATION_MAX_JSON_DEPTH; index += 1) nested = { child: nested };
  await rejectsUpdate(updateInput({ patch: { extensions: { 'https://known.test/deep': nested } } }),
    'relation_json_too_deep');
  await rejectsUpdate(updateInput({ patch: { extensions: {
    'https://known.test/many': Array.from({ length: 260 }, () => 0),
  } } }), 'relation_json_too_many_members');
  await rejectsUpdate(updateInput({ patch: { extensions: { 'https://known.test/large': 'x'.repeat(132_000) } } }),
    'relation_candidate_too_large');
});

test('type transition checks live semantic uniqueness and stale writes expose current ETag only to editors', async () => {
  await rejectsUpdate(updateInput({ patch: { type: 'supports' } }), 'relation_already_exists',
    fakePorts({ semanticDuplicate: true }));
  await assert.rejects(() => updateRelation(fakePorts(), updateInput({ precondition: precondition('stale') })),
    (error: unknown) => error instanceof RelationUpdateError
      && error.code === 'relation_precondition_failed' && error.currentEtag === `"${REVISION}"`);
  await rejectsUpdate(updateInput(), 'relation_not_found', fakePorts({ role: null }));
  await rejectsUpdate(updateInput(), 'insufficient_relation_permission', fakePorts({ role: 'viewer' }));
});

test('visibility cannot exceed Collection or either immutable endpoint', async () => {
  await rejectsUpdate(updateInput({ patch: { visibility: 'public' } }), 'relation_visibility_too_broad',
    fakePorts({ endpointVisibility: 'protected' }));
});

test('update emits immutable endpoint canonical facts and public-change purge evidence', async () => {
  let mutation: unknown;
  const ports = fakePorts();
  (ports.canonical as { execute: typeof ports.canonical.execute }).execute = async (value) => { mutation = value; return {
    operationId: value.operationId, collectionId: value.collectionId,
    resourceId: value.mutation.target.resourceId, action: value.mutation.action,
    allocation: { commitOrdinal: 2n, resourceRevision: 'relation-r2',
      contentRevision: 'content-r2', childrenRevisions: {} },
  }; };
  await updateRelation(ports, updateInput({ patch: { visibility: 'private' } }));
  const planned = mutation as { mutation: { expectedResourceRevision?: string; fields?: { kindFields: Record<string, unknown> };
    trustedFacts?: Record<string, unknown> } };
  assert.equal(planned.mutation.expectedResourceRevision, REVISION);
  assert.equal(planned.mutation.fields?.kindFields.fromNodeId, FROM_ID);
  assert.equal(planned.mutation.fields?.kindFields.toNodeId, TO_ID);
  assert.equal(planned.mutation.trustedFacts?.previousVisibility, 'protected');
  assert.equal(planned.mutation.trustedFacts?.publicRepresentationChanged, true);
});

test('delete returns a stable Deletion Receipt, tombstone plan and preserves replay outcomes', async () => {
  let mutation: unknown;
  const ports = fakePorts();
  (ports.canonical as { execute: typeof ports.canonical.execute }).execute = async (value) => { mutation = value; return {
    operationId: value.operationId, collectionId: value.collectionId,
    resourceId: value.mutation.target.resourceId, action: value.mutation.action,
    allocation: { commitOrdinal: 2n, resourceRevision: 'relation-delete-r2',
      contentRevision: 'content-r2', childrenRevisions: {},
      deletedResourceRevisions: { [RELATION_ID]: 'relation-delete-r2' } },
  }; };
  const result = await deleteRelation(ports, deleteInput());
  assert.equal(result.kind, 'deleted');
  if (result.kind !== 'deleted') return;
  assert.equal(result.receipt.resourceType, 'relation');
  assert.equal(result.receipt.targetId, RELATION_ID);
  assert.equal(result.receipt.affectedCount, 1);
  const planned = mutation as { mutation: { action: string; expectedResourceRevision?: string;
    deleteIntent?: { scope: string }; trustedFacts?: Record<string, unknown> } };
  assert.equal(planned.mutation.action, 'delete');
  assert.equal(planned.mutation.expectedResourceRevision, REVISION);
  assert.deepEqual(planned.mutation.deleteIntent, { scope: 'single' });
  assert.equal(planned.mutation.trustedFacts?.previousVisibility, 'protected');

  assert.equal((await updateRelation(fakePorts({ claim: 'replay' }), updateInput())).kind, 'replay');
  assert.equal((await deleteRelation(fakePorts({ claim: 'replay' }), deleteInput())).kind, 'replay');
  assert.equal((await deleteRelation(fakePorts({ claim: 'reused' }), deleteInput())).kind, 'reused');
});

test('delete conceals missing/tombstoned rows, rejects stale revisions and enforces editor role', async () => {
  await rejectsDelete(deleteInput(), 'relation_not_found', fakePorts({ record: null }));
  await rejectsDelete(deleteInput(), 'relation_not_found', fakePorts({ record: authority(current(), new Date()) }));
  await rejectsDelete(deleteInput({ precondition: precondition('stale') }), 'relation_precondition_failed');
  await rejectsDelete(deleteInput(), 'insufficient_relation_permission', fakePorts({ role: 'viewer' }));
});
