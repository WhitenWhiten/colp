import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import type { Annotation } from '@know-n/colp/types';
import {
  AnnotationDeleteError,
  deleteAnnotation,
  deleteAnnotationCommandScope,
  type AnnotationAuthorityRecord,
  type AnnotationMutationPorts,
  type DeleteAnnotationInput,
} from '../../../src/modules/collections/index.js';

const COLLECTION_ID = 'annotation-delete-unit-collection';
const ANNOTATION_ID = 'annotation-delete-unit-annotation';
const REVISION = 'annotation-delete-r1';

function annotation(visibility: Annotation['visibility'] = 'protected'): Readonly<Annotation> {
  return Object.freeze({
    id: ANNOTATION_ID,
    collectionId: COLLECTION_ID,
    subject: { type: 'node', id: 'annotation-delete-unit-node' },
    type: 'note',
    format: 'plain',
    value: 'private body must never enter the delete event',
    visibility,
    creator: { id: 'https://known.test/profiles/creator', name: 'Creator' },
    createdAt: '2026-07-25T01:00:00.000Z',
    updatedAt: '2026-07-25T01:00:00.000Z',
    revision: REVISION,
    extensions: {},
  } as Annotation);
}

function authority(visibility: Annotation['visibility'] = 'protected'): AnnotationAuthorityRecord {
  return { annotation: annotation(visibility), creatorPrincipalId: 'principal-creator',
    deletedAt: null, provenanceSourceNodeIds: [] };
}

function input(overrides: Partial<DeleteAnnotationInput> = {}): DeleteAnnotationInput {
  return {
    actor: { principalId: 'principal-creator', subjectId: 'subject-creator', principalType: 'account' },
    command: { commandId: randomUUID(), fingerprint: 'annotation-delete-fingerprint' },
    collectionId: COLLECTION_ID,
    annotationId: ANNOTATION_ID,
    precondition: { kind: 'single-strong-if-match', entityTag: `"${REVISION}"`, expectedRevision: REVISION },
    operationId: `operation-${randomUUID()}`,
    ...overrides,
  };
}

function ports(options: {
  role?: 'owner' | 'editor' | 'viewer' | null;
  record?: AnnotationAuthorityRecord | null;
  claim?: 'claimed' | 'replay' | 'reused';
} = {}): AnnotationMutationPorts {
  return {
    receipts: {
      async claim() {
        if (options.claim === 'reused') return { kind: 'reused' } as const;
        if (options.claim === 'replay') return { kind: 'replay', result: {
          status: 200, body: Buffer.from('{"first":true}'), stableHeaders: {
            'cache-control': 'private, no-store', 'content-type': 'application/json',
          }, mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: ANNOTATION_ID,
        } } as const;
        return { kind: 'claimed' } as const;
      },
      async complete() {}, async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; },
    },
    clock: { async now() { return new Date('2026-07-25T02:00:00.000Z'); } },
    collections: { async lockForUpdate(id) { return id === COLLECTION_ID ? {
      id, ownerSubjectId: 'subject-owner', title: 'Annotations', summary: null, kind: 'bookmarks',
      visibility: 'public', publicationSlug: 'annotations', publishedAt: new Date(), rootNodeId: 'root',
      resourceRevision: 'cr1', contentRevision: 'cc1', policyRevision: 'cp1', commitOrdinal: 1n,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    } : null; } },
    accessPolicy: { async loadCollectionFacts() { return { collectionId: COLLECTION_ID,
      ownerSubjectId: 'subject-owner', visibility: 'public', policyRevision: 'cp1',
      membershipRole: options.role === undefined ? 'viewer' : options.role, deleted: false } as const; } },
    subjects: { async resolveLiveSubject() { return null; } },
    annotations: {
      async countLiveForSubject() { return 1; },
      async loadAuthoritativeForUpdate(_collectionId, id) {
        return id === ANNOTATION_ID ? (options.record === undefined ? authority() : options.record) : null;
      },
    },
    canonical: { async execute(value) { return { operationId: value.operationId,
      collectionId: value.collectionId, resourceId: value.mutation.target.resourceId, action: 'delete',
      allocation: { commitOrdinal: 2n, resourceRevision: 'annotation-delete-r2',
        contentRevision: 'content-delete-r2', childrenRevisions: {},
        deletedResourceRevisions: { [ANNOTATION_ID]: 'annotation-delete-r2' } } } as const; } },
  };
}

async function rejects(value: DeleteAnnotationInput, p: AnnotationMutationPorts, code: string) {
  await assert.rejects(() => deleteAnnotation(p, value), (error: unknown) => {
    assert.ok(error instanceof AnnotationDeleteError);
    assert.equal(error.code, code);
    return true;
  });
}

test('requires one strong If-Match and binds the delete namespace to the item identity', async () => {
  for (const precondition of [undefined, { kind: 'missing' },
    { kind: 'duplicate', values: [`"${REVISION}"`, '"other"'] },
    { kind: 'single-strong-if-match', entityTag: `W/"${REVISION}"`, expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: '*', expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: `"${REVISION}", "other"`, expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: REVISION, expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: `"${REVISION}"`, expectedRevision: 'other' },
    { kind: 'single-strong-if-match', entityTag: '"bad revision"', expectedRevision: 'bad revision' }]) {
    await rejects(input({ precondition: precondition as never }), ports(),
      precondition === undefined || precondition.kind === 'missing'
        ? 'annotation_precondition_required' : 'invalid_annotation_precondition');
  }
  assert.equal(deleteAnnotationCommandScope(COLLECTION_ID, ANNOTATION_ID),
    `collection:${COLLECTION_ID}:annotation:${ANNOTATION_ID}:delete`);
});

test('conceals missing, already-deleted and unauthorized records with one external shape', async () => {
  await rejects(input(), ports({ record: null }), 'annotation_not_found');
  await rejects(input(), ports({ record: { ...authority(), deletedAt: new Date() } }), 'annotation_not_found');
  for (const [visibility, role, principalId, subjectId] of [
    ['private', 'owner', 'principal-owner', 'subject-owner'],
    ['private', 'editor', 'principal-editor', 'subject-editor'],
    ['protected', 'viewer', 'principal-viewer', 'subject-viewer'],
    ['protected', null, 'principal-outsider', 'subject-outsider'],
  ] as const) {
    await rejects(input({ actor: { principalId, subjectId, principalType: 'account' } }),
      ports({ record: authority(visibility), role }), 'annotation_not_found');
  }
  await rejects(input({ actor: undefined as never }), ports(), 'invalid_annotation_input');
});

test('allows private creator and shared creator/owner/editor, then returns authoritative single receipt', async () => {
  for (const [record, role, principalId, subjectId] of [
    [authority('private'), 'viewer', 'principal-creator', 'subject-creator'],
    [authority('protected'), 'viewer', 'principal-creator', 'subject-creator'],
    [authority('protected'), 'owner', 'principal-owner', 'subject-owner'],
    [authority('protected'), 'editor', 'principal-editor', 'subject-editor'],
  ] as const) {
    const result = await deleteAnnotation(ports({ record, role }), input({
      actor: { principalId, subjectId, principalType: 'account' },
    }));
    assert.equal(result.kind, 'deleted');
    if (result.kind === 'deleted') {
      assert.deepEqual(result.receipt, {
        resourceType: 'annotation', targetId: ANNOTATION_ID, collectionId: COLLECTION_ID,
        scope: 'single', deletedAt: '2026-07-25T02:00:00Z', deleteRevision: 'annotation-delete-r2',
        operationId: result.operationId, affectedCount: 1, purgeAfter: '2026-08-24T02:00:00Z',
      });
      assert.equal(result.commitOrdinal, 2n);
      assert.equal(result.fence.contentRevision, 'content-delete-r2');
    }
  }
});

test('checks stale evidence after concealment and does not expose private authority', async () => {
  const stale = input({ precondition: { kind: 'single-strong-if-match', entityTag: '"stale"', expectedRevision: 'stale' } });
  await rejects(stale, ports(), 'annotation_precondition_failed');
  await rejects(input({
    actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
    precondition: { kind: 'single-strong-if-match', entityTag: '"stale"', expectedRevision: 'stale' },
  }), ports({ record: authority('private'), role: 'editor' }), 'annotation_not_found');
});

test('exact replay returns first stable bytes while command reuse performs zero authority work', async () => {
  const replayPorts = ports({ claim: 'replay' });
  replayPorts.annotations.loadAuthoritativeForUpdate = async () => assert.fail('replay must not load authority');
  const replay = await deleteAnnotation(replayPorts, input());
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') {
    assert.equal(Buffer.from(replay.body).toString(), '{"first":true}');
    assert.equal(replay.status, 200);
  }
  const reusedPorts = ports({ claim: 'reused' });
  reusedPorts.canonical.execute = async () => assert.fail('reuse must not mutate');
  assert.deepEqual(await deleteAnnotation(reusedPorts, input()), { kind: 'reused' });
});
