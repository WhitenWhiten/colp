import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { ResourcePolicyFacts } from '../../../src/modules/access-policy/index.js';
import {
  AnnotationProductReadError,
  createProductAnnotationCursorSigner,
  createProductEditorCursorSigner,
  type ProductAnnotationCursorSignerPort,
  getProductAnnotation,
  getProductAnnotationPage,
  type ProductAnnotationReadPorts,
  type ProductAnnotationRow,
} from '../../../src/modules/collections/index.js';

const NOW = new Date('2026-07-25T00:00:00.000Z');
const COLLECTION_ID = 'annotation-query-collection';
const SUBJECT_ID = 'annotation-query-node';
const CURSOR_KEY = 'annotation-product-query-test-key';

function row(overrides: Partial<ProductAnnotationRow> = {}): ProductAnnotationRow {
  return {
    id: 'annotation-1', collectionId: COLLECTION_ID,
    subjectType: 'node', subjectId: SUBJECT_ID,
    creatorPrincipalId: 'principal-creator',
    payload: {
      id: 'annotation-1', collectionId: COLLECTION_ID,
      subject: { type: 'node', id: SUBJECT_ID }, type: 'note', format: 'plain',
      value: 'private text', visibility: 'protected',
      creator: { id: 'https://app.example.test/profiles/creator', name: 'Creator' },
      revision: 'annotation-revision-1',
      createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
      extensions: {},
    },
    resourceRevision: 'annotation-revision-1',
    updatedAt: new Date('2026-07-24T01:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function ports(input: {
  rows?: ProductAnnotationRow[];
  facts?: ResourcePolicyFacts | null;
  subjectExists?: boolean;
  subjectVisibility?: 'private' | 'protected' | 'unlisted' | 'public';
  now?: Date;
  cursorSigner?: ProductAnnotationCursorSignerPort;
} = {}): ProductAnnotationReadPorts {
  const rows = input.rows ?? [row()];
  const facts = input.facts === undefined ? {
    collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner', visibility: 'private',
    policyRevision: 'policy-1', membershipRole: 'viewer', deleted: false,
  } satisfies ResourcePolicyFacts : input.facts;
  return {
    clock: { now: async () => new Date(input.now ?? NOW) },
    accessPolicy: { loadCollectionFacts: async () => facts },
    cursorSigner: input.cursorSigner
      ?? createProductAnnotationCursorSigner({ current: { id: 'annotation-v1', key: CURSOR_KEY } }),
    reads: {
      loadLiveSubject: async ({ resourceType, resourceId }) => (input.subjectExists ?? true)
        ? { type: resourceType, id: resourceId, collectionId: COLLECTION_ID,
          visibility: input.subjectVisibility ?? 'private' }
        : null,
      loadLiveById: async ({ annotationId }) => rows.find((item) => item.id === annotationId) ?? null,
      listLiveBySubject: async ({ after, limit }) => rows
        .filter((item) => !after
          || item.updatedAt < new Date(after.updatedAt)
          || (item.updatedAt.getTime() === new Date(after.updatedAt).getTime() && item.id > after.id))
        .slice(0, limit + 1),
    },
  };
}

describe('P2B-07 Product Annotation query', () => {
  test('maps an explicit Product DTO without authority-row fields and preserves HTML as inert data', async () => {
    const html = row({ payload: { ...row().payload, format: 'html', value: '<img src=x onerror=alert(1)>',
      provenance: { kind: 'human' } } });
    const result = await getProductAnnotation(ports({ rows: [html] }), {
      collectionId: COLLECTION_ID, annotationId: html.id,
      actor: { principalId: 'principal-member', subjectId: 'subject-member' },
    });
    assert.equal(result.value, '<img src=x onerror=alert(1)>');
    assert.equal(result.format, 'html');
    assert.equal(result.revision, 'annotation-revision-1');
    assert.deepEqual(result.provenance, { kind: 'human' });
    assert.equal('creatorPrincipalId' in result, false);
    assert.equal('payload' in result, false);
    assert.equal('commitOrdinal' in result, false);
    assert.equal('policyRevision' in result, false);
  });

  test('redacts provenance providers and extension namespaces for a non-member public reader', async () => {
    const publicRow = row({ payload: { ...row().payload, visibility: 'public', provenance: {
      kind: 'ai', provider: 'internal-provider', model: 'secret-model',
      generatedAt: '2026-07-24T00:00:00.000Z', sourceNodeIds: ['private-source'], editedByHuman: false,
    }, extensions: { internal: { traceId: 'secret' } } } });
    const result = await getProductAnnotation(ports({ rows: [publicRow], subjectVisibility: 'public', facts: {
      collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner', visibility: 'public',
      policyRevision: 'policy-1', membershipRole: null, deleted: false,
    } }), {
      collectionId: COLLECTION_ID, annotationId: publicRow.id,
      actor: { principalId: 'principal-outsider', subjectId: 'subject-outsider' },
    });
    assert.deepEqual(result.provenance, {
      kind: 'ai', generatedAt: '2026-07-24T00:00:00.000Z', editedByHuman: false,
    });
    assert.deepEqual(result.extensions, {});
  });

  test('private annotations are visible only to their creator, including against owner/editor roles', async () => {
    const privateRow = row({ payload: { ...row().payload, visibility: 'private' } });
    const creator = await getProductAnnotation(ports({ rows: [privateRow] }), {
      collectionId: COLLECTION_ID, annotationId: privateRow.id,
      actor: { principalId: 'principal-creator', subjectId: 'subject-viewer' },
    });
    assert.equal(creator.id, privateRow.id);
    for (const actor of [
      { principalId: 'principal-owner', subjectId: 'subject-owner' },
      { principalId: 'principal-editor', subjectId: 'subject-editor' },
    ]) {
      await assert.rejects(
        getProductAnnotation(ports({ rows: [privateRow], facts: {
          collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner', visibility: 'private',
          policyRevision: 'policy-1', membershipRole: actor.subjectId === 'subject-editor' ? 'editor' : null,
          deleted: false,
        } }), { collectionId: COLLECTION_ID, annotationId: privateRow.id, actor }),
        (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'annotation_not_found',
      );
    }
  });

  test('applies owner/editor/member/creator/outsider visibility matrix without private count leakage', async () => {
    const rows = [
      row({ id: 'public', payload: { ...row().payload, id: 'public', visibility: 'public' } }),
      row({ id: 'protected', payload: { ...row().payload, id: 'protected', visibility: 'protected' } }),
      row({ id: 'private', payload: { ...row().payload, id: 'private', visibility: 'private' } }),
    ];
    const baseFacts = { collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner', visibility: 'public' as const,
      policyRevision: 'policy-1', deleted: false };
    const cases = [
      { actor: { principalId: 'principal-owner', subjectId: 'subject-owner' }, role: null, ids: ['protected', 'public'] },
      { actor: { principalId: 'principal-editor', subjectId: 'subject-editor' }, role: 'editor' as const, ids: ['protected', 'public'] },
      { actor: { principalId: 'principal-member', subjectId: 'subject-member' }, role: 'viewer' as const, ids: ['protected', 'public'] },
      { actor: { principalId: 'principal-creator', subjectId: 'subject-member' }, role: 'viewer' as const, ids: ['private', 'protected', 'public'] },
      { actor: { principalId: 'principal-outsider', subjectId: 'subject-outsider' }, role: null, ids: ['public'] },
    ];
    for (const entry of cases) {
      const page = await getProductAnnotationPage(ports({ rows, subjectVisibility: 'public',
        facts: { ...baseFacts, membershipRole: entry.role } }), {
        collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
        actor: entry.actor, limit: 10,
      });
      assert.deepEqual(page.annotations.map((item) => item.id).sort(), entry.ids, entry.actor.principalId);
      assert.equal(page.page.returnedCount, entry.ids.length);
    }
  });

  test('conceals missing/deleted/inaccessible collections and missing or deleted subjects identically', async () => {
    for (const readPorts of [
      ports({ facts: null }),
      ports({ facts: { collectionId: COLLECTION_ID, ownerSubjectId: 'owner', visibility: 'public',
        policyRevision: 'p', membershipRole: null, deleted: true } }),
      ports({ subjectExists: false }),
    ]) {
      await assert.rejects(getProductAnnotationPage(readPorts, {
        collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
        actor: { principalId: 'outsider', subjectId: 'outsider-subject' }, limit: 2,
      }), (error: unknown) => error instanceof AnnotationProductReadError
        && error.code === 'annotation_not_found');
    }
  });

  test('traverses (updated_at DESC, id ASC) without duplicates and binds cursor to subject/principal/page size', async () => {
    const rows = [
      row({ id: 'a', payload: { ...row().payload, id: 'a' }, updatedAt: new Date('2026-07-24T03:00:00Z') }),
      row({ id: 'b', payload: { ...row().payload, id: 'b' }, updatedAt: new Date('2026-07-24T03:00:00Z') }),
      row({ id: 'c', payload: { ...row().payload, id: 'c' }, updatedAt: new Date('2026-07-24T02:00:00Z') }),
      row({ id: 'd', payload: { ...row().payload, id: 'd' }, updatedAt: new Date('2026-07-24T01:00:00Z') }),
    ];
    const readPorts = ports({ rows });
    const actor = { principalId: 'principal-member', subjectId: 'subject-member' };
    const first = await getProductAnnotationPage(readPorts, {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID, actor, limit: 2,
    });
    assert.deepEqual(first.annotations.map((item) => item.id), ['a', 'b']);
    assert.ok(first.page.nextCursor);
    const encodedPayload = first.page.nextCursor!.split('.')[1]!;
    const cursorPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      issuedAt: string; expiresAt: string; after: { updatedAt: string };
    };
    assert.equal(cursorPayload.issuedAt, '2026-07-25T00:00:00Z');
    assert.equal(cursorPayload.expiresAt, '2026-07-25T00:15:00Z');
    assert.equal(cursorPayload.after.updatedAt, '2026-07-24T03:00:00Z');
    const second = await getProductAnnotationPage(readPorts, {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor, cursor: first.page.nextCursor!,
    });
    assert.deepEqual(second.annotations.map((item) => item.id), ['c', 'd']);
    assert.equal(second.page.nextCursor, null);
    await assert.rejects(getProductAnnotationPage(readPorts, {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor: { principalId: 'other-principal', subjectId: actor.subjectId }, cursor: first.page.nextCursor!,
    }), (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'invalid_cursor');
    for (const target of [
      { collectionId: COLLECTION_ID, resourceType: 'node' as const, resourceId: 'other-subject' },
      { collectionId: COLLECTION_ID, resourceType: 'collection' as const, resourceId: SUBJECT_ID },
      { collectionId: 'other-collection', resourceType: 'node' as const, resourceId: SUBJECT_ID },
    ]) {
      await assert.rejects(getProductAnnotationPage(readPorts, {
        ...target, actor, cursor: first.page.nextCursor!,
      }), (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'invalid_cursor');
    }
    await assert.rejects(getProductAnnotationPage(readPorts, {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor, cursor: first.page.nextCursor!, limit: 2,
    }), (error: unknown) => error instanceof AnnotationProductReadError
      && error.code === 'invalid_annotation_query');
  });

  test('fails closed for tampering, expiry, key rotation mistakes, and Editor-purpose replay', async () => {
    const readPorts = ports({ rows: [row(), row({ id: 'annotation-2', payload: { ...row().payload, id: 'annotation-2' } })] });
    const first = await getProductAnnotationPage(readPorts, {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor: { principalId: 'principal-member', subjectId: 'subject-member' }, limit: 1,
    });
    const cursor = first.page.nextCursor!;
    for (const invalidCursor of [`${cursor.slice(0, -1)}x`, 'not-a-cursor']) {
      await assert.rejects(getProductAnnotationPage(readPorts, {
        collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
        actor: { principalId: 'principal-member', subjectId: 'subject-member' }, cursor: invalidCursor,
      }), (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'invalid_cursor');
    }
    const editorCursor = createProductEditorCursorSigner({
      current: { id: 'annotation-v1', key: CURSOR_KEY },
    }).sign({
      v: 1, purpose: 'product-editor-cursor', principalId: 'principal-member',
      collectionId: COLLECTION_ID, limit: 1, comparatorVersion: 'v1',
      after: { parentKey: '', positionKey: '', nodeId: 'node-1' },
      contentRevision: 'content-1', policyRevision: 'policy-1', snapshotId: 'snapshot-1',
      issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    });
    await assert.rejects(getProductAnnotationPage(readPorts, {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor: { principalId: 'principal-member', subjectId: 'subject-member' }, cursor: editorCursor,
    }), (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'invalid_cursor');
    await assert.rejects(getProductAnnotationPage(ports({
      rows: [], now: new Date(NOW.getTime() + 16 * 60 * 1000),
    }), {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor: { principalId: 'principal-member', subjectId: 'subject-member' }, cursor,
    }), (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'invalid_cursor');
  });

  test('continues across process restart and retained-key rotation but rejects an unknown keyring', async () => {
    const rows = [row(), row({ id: 'annotation-2', payload: { ...row().payload, id: 'annotation-2' } })];
    const actor = { principalId: 'principal-member', subjectId: 'subject-member' };
    const oldSigner = createProductAnnotationCursorSigner({
      current: { id: 'old', key: 'annotation-old-key-material' },
    });
    const first = await getProductAnnotationPage(ports({ rows, cursorSigner: oldSigner }), {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID, actor, limit: 1,
    });
    const restarted = await getProductAnnotationPage(ports({ rows, cursorSigner: oldSigner }), {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor, cursor: first.page.nextCursor!,
    });
    assert.equal(restarted.annotations.length, 1);
    const rotated = createProductAnnotationCursorSigner({
      current: { id: 'new', key: 'annotation-new-key-material' },
      previous: [{ id: 'old', key: 'annotation-old-key-material', retainUntil: '2026-07-25T01:00:00.000Z' }],
    });
    const continued = await getProductAnnotationPage(ports({ rows, cursorSigner: rotated }), {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor, cursor: first.page.nextCursor!,
    });
    assert.deepEqual(continued.annotations.map((item) => item.id), restarted.annotations.map((item) => item.id));
    await assert.rejects(getProductAnnotationPage(ports({ rows, cursorSigner:
      createProductAnnotationCursorSigner({ current: { id: 'other', key: 'annotation-other-key-material' } }) }), {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor, cursor: first.page.nextCursor!,
    }), (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'invalid_cursor');
  });

  test('invalidates an in-flight cursor when the collection policy revision changes', async () => {
    const rows = [row(), row({ id: 'annotation-2', payload: { ...row().payload, id: 'annotation-2' } })];
    const cursorSigner = createProductAnnotationCursorSigner({
      current: { id: 'annotation-v1', key: CURSOR_KEY },
    });
    const actor = { principalId: 'principal-member', subjectId: 'subject-member' };
    const first = await getProductAnnotationPage(ports({ rows, cursorSigner }), {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID, actor, limit: 1,
    });
    assert.ok(first.page.nextCursor);
    await assert.rejects(getProductAnnotationPage(ports({ rows, cursorSigner, facts: {
      collectionId: COLLECTION_ID, ownerSubjectId: 'subject-owner', visibility: 'private',
      policyRevision: 'policy-2', membershipRole: 'viewer', deleted: false,
    } }), {
      collectionId: COLLECTION_ID, resourceType: 'node', resourceId: SUBJECT_ID,
      actor, cursor: first.page.nextCursor,
    }), (error: unknown) => error instanceof AnnotationProductReadError && error.code === 'invalid_cursor');
  });
});
