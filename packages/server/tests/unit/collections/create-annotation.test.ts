import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  ANNOTATION_MAX_CANDIDATE_BYTES,
  ANNOTATION_MAX_JSON_DEPTH,
  ANNOTATION_MAX_JSON_MEMBERS,
  ANNOTATION_MAX_LIVE_PER_SUBJECT,
  ANNOTATION_MAX_VALUE_BYTES,
  AnnotationCreateError,
  createAnnotation,
  createAnnotationCommandScope,
  type CreateAnnotationInput,
  type CreateAnnotationPorts,
} from '../../../src/modules/collections/index.js';

const COLLECTION_ID = 'annotation-unit-collection';
const NODE_ID = 'annotation-unit-node';

function input(overrides: Partial<CreateAnnotationInput> = {}): CreateAnnotationInput {
  return {
    actor: {
      principalId: 'principal-owner', subjectId: 'subject-owner', principalType: 'account',
      creator: { id: 'https://known.test/profiles/owner', name: 'Owner' },
    },
    command: { commandId: randomUUID(), fingerprint: 'annotation-fingerprint' },
    collectionId: COLLECTION_ID,
    annotation: {
      subject: { type: 'node', id: NODE_ID }, type: 'note', format: 'plain',
      value: 'A useful note', visibility: 'protected', extensions: {},
    },
    annotationId: `annotation-${randomUUID()}`,
    operationId: `operation-${randomUUID()}`,
    ...overrides,
  };
}

function fakePorts(options: {
  role?: 'owner' | 'editor' | 'viewer' | null;
  collectionVisibility?: 'public' | 'unlisted' | 'protected' | 'private';
  subject?: { type: 'collection' | 'node'; id: string; collectionId: string; visibility: 'public' | 'unlisted' | 'protected' | 'private'; deletedAt: Date | null } | null;
  liveCount?: number;
  claim?: 'claimed' | 'replay' | 'reused' | 'in_progress' | 'expired';
} = {}): CreateAnnotationPorts {
  const role = options.role === undefined ? 'owner' : options.role;
  const subject = options.subject === undefined ? {
    type: 'node' as const, id: NODE_ID, collectionId: COLLECTION_ID,
    visibility: 'public' as const, deletedAt: null,
  } : options.subject;
  let ordinal = 1n;
  return {
    receipts: {
      async claim() {
        switch (options.claim ?? 'claimed') {
          case 'claimed': return { kind: 'claimed' } as const;
          case 'reused': return { kind: 'reused' } as const;
          case 'in_progress': return { kind: 'in_progress', retryAfterSeconds: 1 } as const;
          case 'expired': return { kind: 'expired', resultDigest: 'a'.repeat(64) } as const;
          case 'replay': return {
            kind: 'replay', result: { status: 201, body: Buffer.from('{"stable":true}'),
              stableHeaders: { location: '/stable' }, mediaType: 'application/json',
              contractVersion: '1.0.0', targetIdentity: 'annotation-stable' },
          } as const;
        }
      },
      async complete() {}, async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; },
    },
    collections: { async lockForUpdate(id) { return id === COLLECTION_ID ? {
      id, ownerSubjectId: 'subject-owner', visibility: options.collectionVisibility ?? 'public',
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: ordinal, deletedAt: null,
    } : null; } },
    accessPolicy: { async loadCollectionFacts() { return {
      collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner', visibility: options.collectionVisibility ?? 'public',
      policyRevision: 'policy-r1', membershipRole: role, deleted: false,
    }; } },
    subjects: { async resolveLiveSubject(_collectionId, type, id) {
      if (!subject || subject.type !== type || subject.id !== id || subject.deletedAt) return null;
      return subject;
    } },
    annotations: { async countLiveForSubject() { return options.liveCount ?? 0; } },
    clock: { async now() { return new Date('2026-07-25T01:00:00.000Z'); } },
    canonical: { async execute(seen) {
      ordinal += 1n;
      return { operationId: seen.operationId, collectionId: seen.collectionId,
        resourceId: seen.mutation.target.resourceId, action: 'create', allocation: {
          commitOrdinal: ordinal, resourceRevision: 'annotation-r2', contentRevision: 'content-r2',
          childrenRevisions: {},
        } };
    } },
  };
}

async function rejectCode(value: CreateAnnotationInput, ports: CreateAnnotationPorts, code: string) {
  await assert.rejects(() => createAnnotation(ports, value), (error: unknown) => {
    assert.ok(error instanceof AnnotationCreateError);
    assert.equal(error.code, code);
    return true;
  });
}

test('builds a complete COLP candidate with creator and canonical facts bound by the server', async () => {
  const ports = fakePorts();
  let seen: Parameters<CreateAnnotationPorts['canonical']['execute']>[0] | undefined;
  ports.canonical.execute = async (value) => {
    seen = value;
    return { operationId: value.operationId, collectionId: value.collectionId,
      resourceId: value.mutation.target.resourceId, action: 'create', allocation: {
        commitOrdinal: 2n, resourceRevision: 'annotation-r2', contentRevision: 'content-r2', childrenRevisions: {},
      } };
  };
  const command = input();
  const result = await createAnnotation(ports, command);
  assert.equal(result.kind, 'created');
  if (result.kind !== 'created') return;
  assert.equal(result.annotation.creator.id, command.actor.creator.id);
  assert.equal(result.annotation.revision, 'annotation-r2');
  assert.equal(seen?.mutation.target.resourceKind, 'annotation');
  assert.deepEqual(seen?.mutation.fields?.kindFields, {
    subject: result.annotation.subject,
    type: result.annotation.type,
    format: result.annotation.format,
    value: result.annotation.value,
    visibility: result.annotation.visibility,
    creator: result.annotation.creator,
    ...(result.annotation.provenance ? { provenance: result.annotation.provenance } : {}),
  });
  assert.equal(createAnnotationCommandScope(COLLECTION_ID), `collection:${COLLECTION_ID}:annotation:create`);
});

test('accepts Collection and same-Collection Node subjects but rejects cross-Collection, missing and deleted subjects', async () => {
  await createAnnotation(fakePorts({ subject: {
    type: 'collection', id: COLLECTION_ID, collectionId: COLLECTION_ID,
    visibility: 'public', deletedAt: null,
  } }), input({ annotation: {
    subject: { type: 'collection', id: COLLECTION_ID }, type: 'summary', format: 'markdown',
    value: 'summary', visibility: 'protected', extensions: {},
  } }));
  await rejectCode(input(), fakePorts({ subject: { type: 'node', id: NODE_ID,
    collectionId: 'other', visibility: 'public', deletedAt: null } }), 'invalid_annotation_subject');
  await rejectCode(input(), fakePorts({ subject: null }), 'invalid_annotation_subject');
  await rejectCode(input(), fakePorts({ subject: { type: 'node', id: NODE_ID,
    collectionId: COLLECTION_ID, visibility: 'public', deletedAt: new Date() } }), 'invalid_annotation_subject');
});

test('owner/editor may create shared annotations and viewer may create only own private annotations', async () => {
  await createAnnotation(fakePorts({ role: 'owner' }), input());
  await createAnnotation(fakePorts({ role: 'editor' }), input({ actor: {
    principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account',
    creator: { id: 'https://known.test/profiles/editor', name: 'Editor' },
  } }));
  const memberActor = {
    principalId: 'principal-member', subjectId: 'subject-member', principalType: 'account' as const,
    creator: { id: 'https://known.test/profiles/member', name: 'Member' },
  };
  const privateResult = await createAnnotation(fakePorts({ role: 'viewer' }), input({ actor: memberActor, annotation: {
    subject: { type: 'node', id: NODE_ID }, type: 'note', format: 'plain', value: 'mine',
    visibility: 'private', extensions: {},
  } }));
  assert.equal(privateResult.kind, 'created');
  if (privateResult.kind === 'created') assert.equal(privateResult.annotation.creator.id, memberActor.creator.id);
  await rejectCode(input({ actor: memberActor }), fakePorts({ role: 'viewer' }), 'insufficient_annotation_permission');
  await rejectCode(input({ actor: {
    principalId: 'principal-outsider', subjectId: 'subject-outsider', principalType: 'account',
    creator: { id: 'https://known.test/profiles/outsider', name: 'Outsider' },
  } }), fakePorts({ role: null }), 'annotation_not_found');
  await rejectCode(input({ actor: undefined as never }), fakePorts(), 'invalid_annotation_input');
});

test('rejects caller creator/AI provenance, reserved reading_state and invalid format/value combinations', async () => {
  const base = input();
  await rejectCode(input({ annotation: { ...base.annotation, creator: base.actor.creator } as never }), fakePorts(), 'untrusted_annotation_creator');
  await rejectCode(input({ annotation: { ...base.annotation,
    provenance: { kind: 'ai', provider: 'caller' } } as never }), fakePorts(), 'untrusted_ai_provenance');
  await rejectCode(input({ annotation: { ...base.annotation, type: 'reading_state' } }), fakePorts(), 'reserved_annotation_type');
  await rejectCode(input({ annotation: { ...base.annotation, format: 'json', value: 'not-json' } }), fakePorts(), 'invalid_annotation_document');
  await rejectCode(input({ annotation: { ...base.annotation, type: 'rating', format: 'plain', value: 'five' } }), fakePorts(), 'invalid_annotation_document');
});

test('enforces subject/Collection visibility ceiling and private annotations need no public purge intent', async () => {
  await rejectCode(input(), fakePorts({ collectionVisibility: 'private' }), 'annotation_visibility_too_broad');
  await rejectCode(input(), fakePorts({ subject: { type: 'node', id: NODE_ID,
    collectionId: COLLECTION_ID, visibility: 'private', deletedAt: null } }), 'annotation_visibility_too_broad');
  let seen: Parameters<CreateAnnotationPorts['canonical']['execute']>[0] | undefined;
  const ports = fakePorts();
  ports.canonical.execute = async (value) => {
    seen = value;
    return { operationId: value.operationId, collectionId: value.collectionId,
      resourceId: value.mutation.target.resourceId, action: 'create', allocation: {
        commitOrdinal: 2n, resourceRevision: 'r2', contentRevision: 'c2', childrenRevisions: {},
      } };
  };
  await createAnnotation(ports, input({ annotation: { ...input().annotation, visibility: 'private' } }));
  assert.equal(seen?.mutation.fields?.kindFields.visibility, 'private');
});

test('enforces value, JSON depth/member, candidate and live-count snapshot budgets', async () => {
  const base = input();
  await rejectCode(input({ annotation: { ...base.annotation, value: 'x'.repeat(ANNOTATION_MAX_VALUE_BYTES + 1) } }), fakePorts(), 'annotation_value_too_large');
  let deep: unknown = 'leaf';
  for (let i = 0; i <= ANNOTATION_MAX_JSON_DEPTH; i += 1) deep = { child: deep };
  await rejectCode(input({ annotation: { ...base.annotation, format: 'json', value: deep } }), fakePorts(), 'annotation_json_too_deep');
  await rejectCode(input({ annotation: { ...base.annotation, format: 'json',
    value: Object.fromEntries(Array.from({ length: ANNOTATION_MAX_JSON_MEMBERS + 1 }, (_, i) => [`k${i}`, i])) } }), fakePorts(), 'annotation_json_too_many_members');
  let deepExtension: unknown = 'leaf';
  for (let i = 0; i <= ANNOTATION_MAX_JSON_DEPTH; i += 1) deepExtension = { child: deepExtension };
  await rejectCode(input({ annotation: { ...base.annotation,
    extensions: { 'https://known.test/deep': deepExtension } } }), fakePorts(), 'annotation_json_too_deep');
  await rejectCode(input({ annotation: { ...base.annotation,
    extensions: Object.fromEntries(Array.from({ length: ANNOTATION_MAX_JSON_MEMBERS + 1 }, (_, i) =>
      [`https://known.test/member/${i}`, i])) } }), fakePorts(), 'annotation_json_too_many_members');
  await rejectCode(input({ annotation: { ...base.annotation,
    extensions: { huge: 'x'.repeat(ANNOTATION_MAX_CANDIDATE_BYTES) } } }), fakePorts(), 'annotation_candidate_too_large');
  await rejectCode(input(), fakePorts({ liveCount: ANNOTATION_MAX_LIVE_PER_SUBJECT }), 'annotation_subject_limit_reached');
});

test('returns stable exact replay and rejects command reuse before mutation', async () => {
  const replay = await createAnnotation(fakePorts({ claim: 'replay' }), input());
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') assert.equal(Buffer.from(replay.body).toString(), '{"stable":true}');
  assert.deepEqual(await createAnnotation(fakePorts({ claim: 'reused' }), input()), { kind: 'reused' });
});

test('Extension singleton notes check the owning principal under the collection lock and refuse concurrent duplicates', async () => {
  const base = input(), request = { ...base, privateNoteSingleton: true,
    annotation: { ...base.annotation, visibility: 'private' as const } };
  const ports = fakePorts();
  const seen: string[] = [];
  const locked = ports.collections.lockForUpdate;
  const guarded: CreateAnnotationPorts = { ...ports, collections: { lockForUpdate: async id => {
    seen.push('locked'); return locked(id);
  } }, annotations: { ...ports.annotations, hasOwnPrivateNote: async (collection, subject, principal) => {
    assert.deepEqual(seen, ['locked']); assert.equal(collection, COLLECTION_ID); assert.equal(subject, NODE_ID);
    assert.equal(principal, request.actor.principalId); return true;
  } } };
  await rejectCode(request, guarded, 'annotation_note_already_exists');
  await rejectCode(request, ports, 'invalid_annotation_input');
  assert.equal((await createAnnotation({ ...ports, annotations: { ...ports.annotations,
    hasOwnPrivateNote: async () => false } }, request)).kind, 'created');
});
