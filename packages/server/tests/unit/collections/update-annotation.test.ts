import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import type { Annotation } from '@know-n/colp/types';
import {
  ANNOTATION_MAX_CANDIDATE_BYTES,
  ANNOTATION_MAX_JSON_DEPTH,
  ANNOTATION_MAX_JSON_MEMBERS,
  ANNOTATION_MAX_VALUE_BYTES,
  AnnotationUpdateError,
  updateAnnotation,
  updateAnnotationCommandScope,
  type AnnotationAuthorityRecord,
  type AnnotationMutationPorts,
  type UpdateAnnotationInput,
} from '../../../src/modules/collections/index.js';

const COLLECTION_ID = 'annotation-update-unit-collection';
const NODE_ID = 'annotation-update-unit-node';
const ANNOTATION_ID = 'annotation-update-unit-annotation';
const REVISION = 'annotation-r1';

function currentAnnotation(overrides: Partial<Annotation> = {}): Readonly<Annotation> {
  return Object.freeze({
    id: ANNOTATION_ID,
    collectionId: COLLECTION_ID,
    subject: { type: 'node', id: NODE_ID },
    type: 'note',
    format: 'plain',
    value: 'Original note',
    visibility: 'protected',
    creator: { id: 'https://known.test/profiles/creator', name: 'Creator' },
    createdAt: '2026-07-25T01:00:00.000Z',
    updatedAt: '2026-07-25T01:00:00.000Z',
    revision: REVISION,
    extensions: {},
    ...overrides,
  } as Annotation);
}

function authority(options: {
  annotation?: Readonly<Annotation>;
  creatorPrincipalId?: string;
  deletedAt?: Date | null;
} = {}): AnnotationAuthorityRecord {
  return {
    annotation: options.annotation ?? currentAnnotation(),
    creatorPrincipalId: options.creatorPrincipalId ?? 'principal-creator',
    deletedAt: options.deletedAt ?? null,
    provenanceSourceNodeIds: [],
  };
}

function input(overrides: Partial<UpdateAnnotationInput> = {}): UpdateAnnotationInput {
  return {
    actor: { principalId: 'principal-creator', subjectId: 'subject-creator', principalType: 'account' },
    command: { commandId: randomUUID(), fingerprint: 'annotation-update-fingerprint' },
    collectionId: COLLECTION_ID,
    annotationId: ANNOTATION_ID,
    precondition: {
      kind: 'single-strong-if-match',
      entityTag: `"${REVISION}"`,
      expectedRevision: REVISION,
    },
    patch: { value: 'Updated note' },
    operationId: `operation-${randomUUID()}`,
    ...overrides,
  };
}

interface FakeOptions {
  readonly role?: 'owner' | 'editor' | 'viewer' | null;
  readonly record?: AnnotationAuthorityRecord | null;
  readonly collectionVisibility?: 'public' | 'unlisted' | 'protected' | 'private';
  readonly subjectVisibility?: 'public' | 'unlisted' | 'protected' | 'private';
  readonly claim?: 'claimed' | 'replay' | 'reused' | 'in_progress' | 'expired';
}

function fakePorts(options: FakeOptions = {}): AnnotationMutationPorts {
  const record = options.record === undefined ? authority() : options.record;
  return {
    receipts: {
      async claim() {
        switch (options.claim ?? 'claimed') {
          case 'claimed': return { kind: 'claimed' } as const;
          case 'reused': return { kind: 'reused' } as const;
          case 'in_progress': return { kind: 'in_progress', retryAfterSeconds: 1 } as const;
          case 'expired': return { kind: 'expired', resultDigest: 'd'.repeat(64) } as const;
          case 'replay': return { kind: 'replay', result: {
            status: 200, body: Buffer.from('{"first":true}'),
            stableHeaders: { etag: '"first-r2"', 'cache-control': 'private, no-store' },
            mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: ANNOTATION_ID,
          } } as const;
        }
      },
      async complete() {},
      async purgeExpired() { return 0; },
      async deletePrincipalReceipts() { return 0; },
    },
    clock: { async now() { return new Date('2026-07-25T02:00:00.000Z'); } },
    collections: { async lockForUpdate(id) { return id === COLLECTION_ID ? {
      id, ownerSubjectId: 'subject-owner', title: 'Annotations', summary: null,
      kind: 'bookmarks', visibility: options.collectionVisibility ?? 'public',
      publicationSlug: 'annotations', publishedAt: new Date('2026-07-25T00:00:00.000Z'),
      rootNodeId: 'root', resourceRevision: 'collection-r1', contentRevision: 'content-r1',
      policyRevision: 'policy-r1', commitOrdinal: 1n,
      createdAt: new Date('2026-07-25T00:00:00.000Z'),
      updatedAt: new Date('2026-07-25T00:00:00.000Z'), deletedAt: null,
    } : null; } },
    accessPolicy: { async loadCollectionFacts() { return {
      collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner',
      visibility: options.collectionVisibility ?? 'public', policyRevision: 'policy-r1',
      membershipRole: options.role === undefined ? 'viewer' : options.role, deleted: false,
    }; } },
    subjects: { async resolveLiveSubject(_collectionId, type, id) {
      return type === 'node' && id === NODE_ID ? {
        type, id, collectionId: COLLECTION_ID,
        visibility: options.subjectVisibility ?? 'public', deletedAt: null,
      } : null;
    } },
    annotations: {
      async countLiveForSubject() { return 1; },
      async loadAuthoritativeForUpdate(_collectionId, id) {
        return id === ANNOTATION_ID ? record : null;
      },
    },
    canonical: { async execute(value) {
      return { operationId: value.operationId, collectionId: value.collectionId,
        resourceId: value.mutation.target.resourceId, action: 'update', allocation: {
          commitOrdinal: 2n, resourceRevision: 'annotation-r2', contentRevision: 'content-r2',
          childrenRevisions: {},
        } };
    } },
  };
}

async function rejects(value: UpdateAnnotationInput, ports: AnnotationMutationPorts, code: string) {
  await assert.rejects(() => updateAnnotation(ports, value), (error: unknown) => {
    assert.ok(error instanceof AnnotationUpdateError);
    assert.equal(error.code, code);
    return true;
  });
}

test('requires transport evidence for exactly one strong If-Match and binds it to one revision', async () => {
  const malformed = [
    undefined,
    { kind: 'missing' },
    { kind: 'duplicate', values: [`"${REVISION}"`, '"other"'] },
    { kind: 'single-strong-if-match', entityTag: `W/"${REVISION}"`, expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: '*', expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: `"${REVISION}", "other"`, expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: REVISION, expectedRevision: REVISION },
    { kind: 'single-strong-if-match', entityTag: `"${REVISION}"`, expectedRevision: 'other' },
    { kind: 'single-strong-if-match', entityTag: '"bad revision"', expectedRevision: 'bad revision' },
  ];
  for (const precondition of malformed) {
    await rejects(input({ precondition: precondition as never }), fakePorts(),
      precondition === undefined || (precondition as { kind?: string })?.kind === 'missing'
        ? 'annotation_precondition_required' : 'invalid_annotation_precondition');
  }
  assert.equal(updateAnnotationCommandScope(COLLECTION_ID, ANNOTATION_ID),
    `collection:${COLLECTION_ID}:annotation:${ANNOTATION_ID}:update`);
});

test('rejects a stale representation fact only after concealment and exposes no private current ETag', async () => {
  const stale = input({ precondition: {
    kind: 'single-strong-if-match', entityTag: '"stale-r0"', expectedRevision: 'stale-r0',
  } });
  await rejects(stale, fakePorts(), 'annotation_precondition_failed');
  await rejects(stale, fakePorts({ record: authority({
    annotation: currentAnnotation({ visibility: 'private' }),
    creatorPrincipalId: 'principal-someone-else',
  }), role: 'editor' }), 'annotation_not_found');
});

test('fails closed for empty, unknown and immutable path or authority fields', async () => {
  for (const patch of [
    {},
    { unknown: true },
    { id: 'other' },
    { collectionId: 'other' },
    { subject: { type: 'node', id: 'other' } },
    { type: 'summary' },
    { creator: { id: 'https://attacker.test', name: 'Attacker' } },
    { createdAt: '2020-01-01T00:00:00Z' },
    { updatedAt: '2020-01-01T00:00:00Z' },
    { revision: 'caller-r2' },
  ]) {
    await rejects(input({ patch: patch as never }), fakePorts(), 'invalid_annotation_patch');
  }
});

test('implements RFC 7396 null semantics and validates the complete format/value candidate', async () => {
  await rejects(input({ patch: { value: null } }), fakePorts(), 'invalid_annotation_document');
  await rejects(input({ patch: { format: null } }), fakePorts(), 'invalid_annotation_document');
  await rejects(input({ patch: { visibility: null } as never }), fakePorts(), 'invalid_annotation_document');
  await rejects(input({ patch: { format: 'json' } }), fakePorts(), 'invalid_annotation_document');
  await rejects(input({ patch: { format: 'json', value: 'not-json' } }), fakePorts(), 'invalid_annotation_document');

  const extensions = await updateAnnotation(fakePorts(), input({ patch: { extensions: null } }));
  assert.equal(extensions.kind, 'updated');
  if (extensions.kind === 'updated') assert.equal(Object.hasOwn(extensions.annotation, 'extensions'), false);

  const custom = authority({ annotation: currentAnnotation({ type: 'custom' }) });
  const json = await updateAnnotation(fakePorts({ record: custom }), input({ patch: {
    format: 'json', value: { message: 'structured' },
  } }));
  assert.equal(json.kind, 'updated');
  if (json.kind === 'updated') {
    assert.equal(json.annotation.format, 'json');
    assert.deepEqual(json.annotation.value, { message: 'structured' });
  }
});

test('applies value, extension depth/member and complete candidate byte budgets to update patches', async () => {
  await rejects(input({ patch: { value: 'x'.repeat(ANNOTATION_MAX_VALUE_BYTES + 1) } }),
    fakePorts(), 'annotation_value_too_large');
  let deep: unknown = 'leaf';
  for (let index = 0; index <= ANNOTATION_MAX_JSON_DEPTH; index += 1) deep = { child: deep };
  await rejects(input({ patch: { extensions: { 'https://known.test/deep': deep } } }),
    fakePorts(), 'annotation_json_too_deep');
  await rejects(input({ patch: { extensions: Object.fromEntries(
    Array.from({ length: ANNOTATION_MAX_JSON_MEMBERS + 1 }, (_, index) =>
      [`https://known.test/member/${index}`, index]),
  ) } }), fakePorts(), 'annotation_json_too_many_members');
  await rejects(input({ patch: { extensions: {
    'https://known.test/huge': 'x'.repeat(ANNOTATION_MAX_CANDIDATE_BYTES),
  } } }), fakePorts(), 'annotation_candidate_too_large');
});

test('private annotations are creator-only while shared annotations use creator-or-role authorization', async () => {
  const privateRecord = authority({ annotation: currentAnnotation({ visibility: 'private' }) });
  assert.equal((await updateAnnotation(fakePorts({ record: privateRecord, role: 'viewer' }), input())).kind, 'updated');
  await rejects(input({ actor: {
    principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account',
  } }), fakePorts({ record: privateRecord, role: 'editor' }), 'annotation_not_found');
  await rejects(input({ actor: {
    principalId: 'principal-owner', subjectId: 'subject-owner', principalType: 'account',
  } }), fakePorts({ record: privateRecord, role: 'owner' }), 'annotation_not_found');
  await rejects(input({ actor: {
    principalId: 'principal-outsider', subjectId: 'subject-outsider', principalType: 'account',
  } }), fakePorts({ role: null }), 'annotation_not_found');
  await rejects(input(), fakePorts({ record: null }), 'annotation_not_found');
  await rejects(input({ actor: undefined as never }), fakePorts(), 'invalid_annotation_input');

  assert.equal((await updateAnnotation(fakePorts({ role: 'editor' }), input({ actor: {
    principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account',
  } }))).kind, 'updated');
  assert.equal((await updateAnnotation(fakePorts({ role: 'owner' }), input({ actor: {
    principalId: 'principal-owner', subjectId: 'subject-owner', principalType: 'account',
  } }))).kind, 'updated');
  await rejects(input({ actor: {
    principalId: 'principal-viewer', subjectId: 'subject-viewer', principalType: 'account',
  } }), fakePorts({ role: 'viewer' }), 'annotation_not_found');
});

test('visibility widening requires an owner/editor and never exceeds current subject or Collection visibility', async () => {
  const privateRecord = authority({ annotation: currentAnnotation({ visibility: 'private' }) });
  await rejects(input({ patch: { visibility: 'protected' } }),
    fakePorts({ record: privateRecord, role: 'viewer' }), 'insufficient_annotation_permission');
  assert.equal((await updateAnnotation(fakePorts({ record: privateRecord, role: 'editor' }), input({
    actor: { principalId: 'principal-creator', subjectId: 'subject-creator', principalType: 'account' },
    patch: { visibility: 'protected' },
  }))).kind, 'updated');
  await rejects(input({ patch: { visibility: 'public' } }),
    fakePorts({ role: 'owner', subjectVisibility: 'protected' }), 'annotation_visibility_too_broad');
  await rejects(input({ patch: { visibility: 'unlisted' } }),
    fakePorts({ role: 'owner', collectionVisibility: 'protected' }), 'annotation_visibility_too_broad');
});

test('preserves AI identity exactly and monotonically marks trusted human format/value edits', async () => {
  const provenance = {
    kind: 'ai' as const, provider: 'known-ai', model: 'model-1',
    generatedAt: '2026-07-24T12:00:00.000Z', sourceNodeIds: [NODE_ID],
  };
  const aiRecord: AnnotationAuthorityRecord = {
    ...authority({ annotation: currentAnnotation({ provenance }) }),
    provenanceSourceNodeIds: [NODE_ID],
  };
  const visibility = await updateAnnotation(fakePorts({ record: aiRecord }), input({ patch: { visibility: 'private' } }));
  assert.equal(visibility.kind, 'updated');
  if (visibility.kind === 'updated') assert.deepEqual(visibility.annotation.provenance, provenance);

  const formatted = await updateAnnotation(fakePorts({ record: aiRecord }), input({ patch: { format: 'markdown' } }));
  assert.equal(formatted.kind, 'updated');
  if (formatted.kind === 'updated') assert.deepEqual(formatted.annotation.provenance, {
    ...provenance, editedByHuman: true,
  });

  const edited = await updateAnnotation(fakePorts({ record: aiRecord }), input({ patch: { value: 'Human edit' } }));
  assert.equal(edited.kind, 'updated');
  if (edited.kind === 'updated') assert.deepEqual(edited.annotation.provenance, {
    ...provenance, editedByHuman: true,
  });
  const alreadyEdited: AnnotationAuthorityRecord = {
    ...authority({ annotation: currentAnnotation({ provenance: {
      ...provenance, editedByHuman: true,
    } }) }),
    provenanceSourceNodeIds: [NODE_ID],
  };
  const monotonic = await updateAnnotation(fakePorts({ record: alreadyEdited }), input({ patch: { format: 'markdown' } }));
  assert.equal(monotonic.kind, 'updated');
  if (monotonic.kind === 'updated') assert.equal(monotonic.annotation.provenance?.editedByHuman, true);
});

test('rejects every caller provenance mutation and schema-shaped but untrusted context input', async () => {
  const validAi = {
    kind: 'ai' as const, provider: 'caller', model: 'forged',
    generatedAt: '2026-07-25T00:00:00.000Z',
  };
  for (const provenance of [null, { kind: 'human' }, validAi]) {
    await rejects(input({ patch: { provenance } as never }), fakePorts(), 'untrusted_ai_provenance');
  }
  await rejects({ ...input(), context: { origin: 'human' } } as never,
    fakePorts(), 'untrusted_annotation_context');
});

test('returns the first exact result and command reuse before loading or mutating authority', async () => {
  const replayPorts = fakePorts({ claim: 'replay' });
  replayPorts.annotations.loadAuthoritativeForUpdate = async () => {
    assert.fail('exact replay must not load the Annotation');
  };
  const replay = await updateAnnotation(replayPorts, input({ precondition: {
    kind: 'single-strong-if-match', entityTag: '"stale-r0"', expectedRevision: 'stale-r0',
  } }));
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') {
    assert.equal(Buffer.from(replay.body).toString('utf8'), '{"first":true}');
    assert.deepEqual(replay.stableHeaders, {
      etag: '"first-r2"', 'cache-control': 'private, no-store',
    });
  }
  const reusedPorts = fakePorts({ claim: 'reused' });
  reusedPorts.canonical.execute = async () => assert.fail('reuse must not mutate');
  assert.deepEqual(await updateAnnotation(reusedPorts, input()), { kind: 'reused' });
});

test('failed complete-candidate validation never invokes canonical mutation or completes the receipt', async () => {
  const ports = fakePorts();
  let canonicalCalls = 0;
  let completes = 0;
  ports.canonical.execute = async () => {
    canonicalCalls += 1;
    assert.fail('invalid patch must not enter canonical mutation');
  };
  ports.receipts.complete = async () => { completes += 1; };
  await rejects(input({ patch: { format: 'json', value: 'invalid' } }), ports, 'invalid_annotation_document');
  assert.equal(canonicalCalls, 0);
  assert.equal(completes, 0);
});
