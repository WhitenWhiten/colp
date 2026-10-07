import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  RELATION_MAX_CANDIDATE_BYTES,
  RELATION_MAX_LABEL_BYTES,
  RelationCreateError,
  assertClosedJsonObject,
  createRelation,
  createRelationCommandScope,
  type CreateRelationInput,
  type CreateRelationPorts,
} from '../../../src/modules/collections/index.js';

const COLLECTION_ID = 'relation-unit-collection';
const FROM_ID = 'relation-unit-from';
const TO_ID = 'relation-unit-to';

function input(overrides: Partial<CreateRelationInput> = {}): CreateRelationInput {
  return {
    actor: { principalId: 'principal-owner', subjectId: 'subject-owner', principalType: 'account' },
    command: { commandId: randomUUID(), fingerprint: 'relation-fingerprint' },
    collectionId: COLLECTION_ID,
    relation: {
      type: 'related', fromNodeId: FROM_ID, toNodeId: TO_ID,
      label: 'See also', visibility: 'protected', extensions: {},
    },
    relationId: `relation-${randomUUID()}`,
    operationId: `operation-${randomUUID()}`,
    ...overrides,
  };
}

function fakePorts(options: {
  role?: 'owner' | 'editor' | 'viewer' | null;
  collectionVisibility?: 'public' | 'unlisted' | 'protected' | 'private';
  from?: { id: string; collectionId: string; visibility: 'public' | 'unlisted' | 'protected' | 'private'; deletedAt: Date | null } | null;
  to?: { id: string; collectionId: string; visibility: 'public' | 'unlisted' | 'protected' | 'private'; deletedAt: Date | null } | null;
  duplicate?: boolean;
  claim?: 'claimed' | 'replay' | 'reused' | 'in_progress' | 'expired';
} = {}): CreateRelationPorts {
  const endpoint = (id: string) => ({ id, collectionId: COLLECTION_ID,
    visibility: 'public' as const, deletedAt: null });
  const from = options.from === undefined ? endpoint(FROM_ID) : options.from;
  const to = options.to === undefined ? endpoint(TO_ID) : options.to;
  return {
    receipts: {
      async claim() {
        switch (options.claim ?? 'claimed') {
          case 'claimed': return { kind: 'claimed' } as const;
          case 'reused': return { kind: 'reused' } as const;
          case 'in_progress': return { kind: 'in_progress', retryAfterSeconds: 1 } as const;
          case 'expired': return { kind: 'expired', resultDigest: 'a'.repeat(64) } as const;
          case 'replay': return { kind: 'replay', result: { status: 201,
            body: Buffer.from('{"stable":true}'), stableHeaders: { location: '/stable' },
            mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: 'relation-stable' } } as const;
        }
      },
      async complete() {}, async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; },
    },
    collections: { async lockForUpdate(id) { return id === COLLECTION_ID ? {
      id, ownerSubjectId: 'subject-owner', visibility: options.collectionVisibility ?? 'public',
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: 1n, deletedAt: null,
    } : null; } },
    accessPolicy: { async loadCollectionFacts() { return {
      collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner',
      visibility: options.collectionVisibility ?? 'public', policyRevision: 'policy-r1',
      membershipRole: options.role === undefined ? 'owner' : options.role, deleted: false,
    }; } },
    endpoints: { async resolveLiveEndpoint(_collectionId, id) {
      if (id === FROM_ID) return from;
      if (id === TO_ID) return to;
      return null;
    } },
    relations: { async hasLiveSemanticEdge() { return options.duplicate ?? false; } },
    clock: { async now() { return new Date('2026-07-25T04:00:00.000Z'); } },
    canonical: { async execute(value) { return { operationId: value.operationId,
      collectionId: value.collectionId, resourceId: value.mutation.target.resourceId,
      action: 'create', allocation: { commitOrdinal: 2n, resourceRevision: 'relation-r2',
        contentRevision: 'content-r2', childrenRevisions: {} } }; } },
  };
}

async function rejectCode(value: CreateRelationInput, ports: CreateRelationPorts, code: string) {
  await assert.rejects(() => createRelation(ports, value), (error: unknown) => {
    assert.ok(error instanceof RelationCreateError);
    assert.equal(error.code, code);
    return true;
  });
}

test('builds a complete COLP Relation with path identity and immutable endpoints', async () => {
  let seen: Parameters<CreateRelationPorts['canonical']['execute']>[0] | undefined;
  const ports = fakePorts();
  ports.canonical.execute = async (value) => {
    seen = value;
    return { operationId: value.operationId, collectionId: value.collectionId,
      resourceId: value.mutation.target.resourceId, action: 'create', allocation: {
        commitOrdinal: 2n, resourceRevision: 'relation-r2', contentRevision: 'content-r2', childrenRevisions: {},
      } };
  };
  const result = await createRelation(ports, input());
  assert.equal(result.kind, 'created');
  if (result.kind !== 'created') return;
  assert.equal(result.relation.collectionId, COLLECTION_ID);
  assert.equal(result.relation.revision, 'relation-r2');
  assert.deepEqual(seen?.mutation.fields?.kindFields, {
    type: 'related', fromNodeId: FROM_ID, toNodeId: TO_ID,
    label: 'See also', visibility: 'protected',
  });
  assert.equal(seen?.mutation.target.resourceKind, 'relation');
  assert.equal(createRelationCommandScope(COLLECTION_ID), `collection:${COLLECTION_ID}:relation:create`);
});

test('accepts every core type and custom with a non-empty label', async () => {
  const types = ['related', 'precedes', 'follows', 'supports', 'contradicts',
    'duplicate_of', 'derived_from', 'mentions'] as const;
  for (const type of types) {
    const result = await createRelation(fakePorts(), input({ relation: {
      type, fromNodeId: FROM_ID, toNodeId: TO_ID, visibility: 'private',
    } }));
    assert.equal(result.kind, 'created');
  }
  assert.equal((await createRelation(fakePorts(), input({ relation: {
    type: 'custom', fromNodeId: FROM_ID, toNodeId: TO_ID,
    label: 'requires review', visibility: 'private',
  } }))).kind, 'created');
  await rejectCode(input({ relation: { type: 'custom', fromNodeId: FROM_ID,
    toNodeId: TO_ID, label: '', visibility: 'private' } }), fakePorts(), 'invalid_relation_document');
});

test('rejects collectionId or URI endpoints supplied in the body', async () => {
  const base = input();
  await rejectCode(input({ relation: { ...base.relation, collectionId: 'caller' } as never }),
    fakePorts(), 'untrusted_relation_identity');
  await rejectCode(input({ relation: { ...base.relation,
    fromNodeId: 'https://remote.test/nodes/1' } }), fakePorts(), 'invalid_relation_document');
});

test('requires two distinct live same-Collection endpoints', async () => {
  await rejectCode(input({ relation: { ...input().relation, toNodeId: FROM_ID } }),
    fakePorts(), 'relation_self_forbidden');
  await rejectCode(input(), fakePorts({ from: null }), 'invalid_relation_endpoint');
  await rejectCode(input(), fakePorts({ to: { id: TO_ID, collectionId: 'other',
    visibility: 'public', deletedAt: null } }), 'invalid_relation_endpoint');
  await rejectCode(input(), fakePorts({ to: { id: TO_ID, collectionId: COLLECTION_ID,
    visibility: 'public', deletedAt: new Date() } }), 'invalid_relation_endpoint');
});

test('owner and editor can create; viewer and outsider fail closed', async () => {
  assert.equal((await createRelation(fakePorts({ role: 'owner' }), input())).kind, 'created');
  assert.equal((await createRelation(fakePorts({ role: 'editor' }), input())).kind, 'created');
  await rejectCode(input({ actor: { principalId: 'principal-viewer', subjectId: 'subject-viewer',
    principalType: 'account' } }), fakePorts({ role: 'viewer' }), 'insufficient_relation_permission');
  await rejectCode(input({ actor: { principalId: 'principal-outsider', subjectId: 'subject-outsider',
    principalType: 'account' } }), fakePorts({ role: null }), 'relation_not_found');
});

test('fails closed for unknown fields, malformed extensions, and oversized candidates', async () => {
  const base = input();
  await rejectCode(input({ relation: { ...base.relation, futureField: true } as never }),
    fakePorts(), 'invalid_relation_document');
  await rejectCode(input({ relation: { ...base.relation, extensions: [] } as never }),
    fakePorts(), 'invalid_relation_document');
  await rejectCode(input({ relation: { ...base.relation,
    label: 'x'.repeat(RELATION_MAX_LABEL_BYTES + 1) } }), fakePorts(), 'relation_candidate_too_large');
  await rejectCode(input({ relation: { ...base.relation,
    label: 'x'.repeat(RELATION_MAX_CANDIDATE_BYTES) } }), fakePorts(), 'relation_candidate_too_large');
});

test('enforces Collection and both endpoint visibility ceilings', async () => {
  for (const visibility of ['public', 'unlisted', 'protected', 'private'] as const) {
    assert.equal((await createRelation(fakePorts(), input({ relation: {
      ...input().relation, visibility,
    } }))).kind, 'created');
  }
  await rejectCode(input(), fakePorts({ collectionVisibility: 'private' }),
    'relation_visibility_too_broad');
  await rejectCode(input({ relation: { ...input().relation, visibility: 'public' } }),
    fakePorts({ collectionVisibility: 'unlisted' }), 'relation_visibility_too_broad');
  await rejectCode(input(), fakePorts({ to: { id: TO_ID, collectionId: COLLECTION_ID,
    visibility: 'private', deletedAt: null } }), 'relation_visibility_too_broad');
});

test('semantic identity is directional and type-specific, while label is not identity', async () => {
  await rejectCode(input(), fakePorts({ duplicate: true }), 'relation_already_exists');
  const reverse = input({ relation: { ...input().relation, fromNodeId: TO_ID, toNodeId: FROM_ID } });
  const reversePorts = fakePorts();
  reversePorts.endpoints.resolveLiveEndpoint = async (_collectionId, id) => ({ id,
    collectionId: COLLECTION_ID, visibility: 'public', deletedAt: null });
  assert.equal((await createRelation(reversePorts, reverse)).kind, 'created');
  assert.equal((await createRelation(fakePorts(), input({ relation: {
    ...input().relation, type: 'supports', label: 'same endpoints, different semantic type',
  } }))).kind, 'created');
});

test('returns stable replay/reuse without resolving endpoints or mutating', async () => {
  const replay = await createRelation(fakePorts({ claim: 'replay' }), input());
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') assert.equal(Buffer.from(replay.body).toString(), '{"stable":true}');
  assert.deepEqual(await createRelation(fakePorts({ claim: 'reused' }), input()), { kind: 'reused' });
});

test('closed JSON payload guard admits plain JSON and rejects non-JSON values', () => {
  assertClosedJsonObject({ ok: true, list: [1, 'two', null], nested: { depth: 2 } });
  assertClosedJsonObject({});
  for (const bad of [
    () => 1,
    new Date(),
    undefined,
    NaN,
    Infinity,
    2 ** 53,
    BigInt(1),
    Symbol('bad'),
    new Map(),
    [undefined],
    { nested: new Date() },
  ]) {
    assert.throws(() => assertClosedJsonObject({ bad }), TypeError);
  }
  assert.throws(() => assertClosedJsonObject([1, 2]), TypeError);
  assert.throws(() => assertClosedJsonObject(new Date()), TypeError);
});

test('rejects non-JSON extension values before canonical admission', async () => {
  const base = input();
  await rejectCode(input({ relation: { ...base.relation, extensions: { bad: () => 1 } } }),
    fakePorts(), 'invalid_relation_document');
  await rejectCode(input({ relation: { ...base.relation, extensions: { bad: new Date() } } }),
    fakePorts(), 'invalid_relation_document');
  await rejectCode(input({ relation: { ...base.relation, extensions: { missing: undefined } } }),
    fakePorts(), 'invalid_relation_document');
});
