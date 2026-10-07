import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ColpClient } from '@know-n/colp/client';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { assembleSnapshotPages, validateSnapshotSemantics } from '@know-n/colp/semantic';
import type { Snapshot } from '@know-n/colp/types';
import { test } from 'vitest';
import {
  createPublicationCursorKeyring,
  createPublicationManifestCandidate,
  getPublicationSnapshotPage,
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PUBLICATION_SNAPSHOT_MAX_BYTES,
  PublicationSnapshotExpiredError,
  type PublicationAnnotationReadPort,
  type PublicationAnnotationRecord,
  type PublicationCollectionRecord,
  type PublicationNodeRecord,
  type PublicationSnapshotQueryPorts,
  type PublicationSnapshotReadPort,
} from '../../../src/modules/publication/index.js';
import {
  publicationAnnotation,
  publicationAnnotationInstant,
  publicationCollection,
  publicationNode,
  publicationRoot,
} from '../../fixtures/phase2/publication-annotations.js';

function locator(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

function nodeReader(
  records: readonly PublicationNodeRecord[],
  current: () => PublicationCollectionRecord = () => publicationCollection(),
): PublicationSnapshotReadPort {
  return {
    async loadPage(request) {
      const start = request.afterLocator
        ? Math.max(0, records.findIndex((row) => locator(row.id) === request.afterLocator) + 1)
        : request.after
          ? Math.max(0, records.findIndex((row) => row.id === request.after?.nodeId) + 1)
          : 0;
      return {
        isolation: 'repeatable read', comparatorVersion: 'parent-position-id-v1',
        collection: current(), root: publicationRoot,
        candidates: request.metadataOnly ? [] : records.slice(start, start + request.limit + 1),
      };
    },
  };
}

function annotationReader(
  records: readonly PublicationAnnotationRecord[],
  calls: Array<Parameters<PublicationAnnotationReadPort['loadPage']>[0]> = [],
  current: () => PublicationCollectionRecord = () => publicationCollection(),
): PublicationAnnotationReadPort {
  return {
    async loadPage(request) {
      calls.push(request);
      const start = request.afterLocator
        ? Math.max(0, records.findIndex((row) => locator(row.id) === request.afterLocator) + 1)
        : request.after
          ? Math.max(0, records.findIndex((row) => row.id === request.after?.annotationId) + 1)
          : 0;
      return {
        isolation: 'repeatable read', comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
        contentRevision: current().contentRevision, policyRevision: current().policyRevision,
        candidates: records.slice(start, start + request.limit + 1),
      };
    },
  };
}

function keyring(id = 'active', byte = 71, retained: readonly { id: string; byte: number }[] = []) {
  return createPublicationCursorKeyring({
    active: { id, secret: Buffer.alloc(32, byte).toString('base64') },
    retained: retained.map((key) => ({ id: key.id, secret: Buffer.alloc(32, key.byte).toString('base64') })),
  });
}

function ports(input: {
  nodes?: readonly PublicationNodeRecord[];
  annotations?: readonly PublicationAnnotationRecord[];
  annotationCalls?: Array<Parameters<PublicationAnnotationReadPort['loadPage']>[0]>;
  member?: boolean;
  collection?: () => PublicationCollectionRecord;
  cursors?: ReturnType<typeof keyring>;
} = {}): PublicationSnapshotQueryPorts {
  const current = input.collection ?? (() => publicationCollection());
  return {
    reads: nodeReader(input.nodes ?? [], current),
    annotations: annotationReader(input.annotations ?? [], input.annotationCalls, current),
    cursors: input.cursors ?? keyring(), origin: 'https://known.example',
    accessPolicy: {
      async loadCollectionFacts() {
        const collection = current();
        return {
          collectionId: collection.id, ownerSubjectId: collection.ownerSubjectId,
          visibility: collection.visibility, policyRevision: collection.policyRevision,
          membershipRole: input.member ? 'viewer' : null, deleted: false,
        };
      },
    },
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  };
}

test('does not invoke the Annotation port without include=annotations and preserves old empty sidecars', async () => {
  const calls: Array<Parameters<PublicationAnnotationReadPort['loadPage']>[0]> = [];
  const result = await getPublicationSnapshotPage(ports({
    nodes: [publicationNode('node-1')], annotations: [publicationAnnotation('annotation-1')],
    annotationCalls: calls,
  }), { collectionId: 'collection-1', principal: { kind: 'anonymous' }, query: { limit: 2 } });
  assert.deepEqual(result.snapshot.annotations, []);
  assert.equal(calls.length, 0);
});

test('projects Collection and Node subjects with public creator mapping and AI provenance redaction', async () => {
  const annotations = [
    publicationAnnotation('annotation-collection', { subjectType: 'collection', subjectId: 'collection-1' }),
    publicationAnnotation('annotation-node', { payload: {
      ...publicationAnnotation('annotation-node').payload,
      provenance: {
        kind: 'ai', provider: 'internal-provider-id', model: 'tenant/model-secret',
        generatedAt: publicationAnnotationInstant, editedByHuman: true,
      },
    } }),
  ];
  const result = await getPublicationSnapshotPage(ports({
    nodes: [publicationNode('node-1')], annotations,
  }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 4 },
  });
  assert.deepEqual(result.snapshot.annotations.map((row) => row.id), [
    'annotation-collection', 'annotation-node',
  ]);
  assert.equal(result.snapshot.complete, false);
  for (const row of result.snapshot.annotations) {
    assert.deepEqual(row.creator, { id: 'https://known.example/profiles/creator', name: 'Public Creator' });
    assert.equal(JSON.stringify(row).includes('account-creator'), false);
    assert.equal(JSON.stringify(row).includes('internal:'), false);
  }
  const ai = result.snapshot.annotations[1]!;
  assert.deepEqual(ai.provenance, {
    kind: 'ai', generatedAt: publicationAnnotationInstant, editedByHuman: true,
  });
  assert.equal(JSON.stringify(ai).includes('internal-provider-id'), false);
  assert.equal(JSON.stringify(ai).includes('tenant/model-secret'), false);
});

test('enforces public/member/protected/private and subject visibility at the application boundary', async () => {
  const records = [
    publicationAnnotation('public'),
    publicationAnnotation('unlisted', { visibility: 'unlisted' }),
    publicationAnnotation('protected', { visibility: 'protected' }),
    publicationAnnotation('private-self', { visibility: 'private', creatorPrincipalId: 'account-member' }),
    publicationAnnotation('private-other', { visibility: 'private', creatorPrincipalId: 'account-other' }),
    publicationAnnotation('hidden-subject', {
      visibility: 'private', creatorPrincipalId: 'account-member', subjectVisibility: 'private',
    }),
    publicationAnnotation('hidden-ancestor', {
      visibility: 'private', creatorPrincipalId: 'account-member', subjectAncestorRestricted: true,
    }),
    publicationAnnotation('deleted', { deletedAt: new Date(publicationAnnotationInstant) }),
  ];
  const anonymous = await getPublicationSnapshotPage(ports({
    nodes: [publicationNode('node-1')], annotations: records,
  }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 20 },
  });
  assert.deepEqual(anonymous.snapshot.annotations.map((row) => row.id), ['public', 'unlisted']);

  const member = await getPublicationSnapshotPage(ports({
    nodes: [publicationNode('node-1')], annotations: records, member: true,
  }), {
    collectionId: 'collection-1',
    principal: { kind: 'account', principalId: 'account-member', subjectId: 'subject-member' },
    query: { include: ['annotations'], limit: 20 },
  });
  assert.deepEqual(member.snapshot.annotations.map((row) => row.id), [
    'public', 'unlisted', 'protected', 'private-self', 'hidden-subject', 'hidden-ancestor',
  ]);
  assert.equal(member.snapshot.annotations.some((row) => row.id === 'private-other'), false);
});

test('traverses Node then Annotation streams exactly once and permits a terminal sidecar-only page', async () => {
  const annotationCalls: Array<Parameters<PublicationAnnotationReadPort['loadPage']>[0]> = [];
  const queryPorts = ports({
    nodes: [publicationNode('node-1'), publicationNode('node-2')],
    annotations: [
      publicationAnnotation('annotation-1'), publicationAnnotation('annotation-2'),
      publicationAnnotation('annotation-3'), publicationAnnotation('annotation-4'),
    ],
    annotationCalls,
  });
  const pages: Snapshot[] = [];
  let cursor: string | undefined;
  do {
    const page = await getPublicationSnapshotPage(queryPorts, {
      collectionId: 'collection-1', principal: { kind: 'anonymous' },
      query: { include: ['annotations'], limit: 2, ...(cursor ? { pageCursor: cursor } : {}) },
    });
    pages.push(page.snapshot);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  assert.deepEqual(pages.map((page) => ({
    nodes: page.nodes.map((node) => node.id), annotations: page.annotations.map((row) => row.id),
  })), [
    { nodes: ['root-1', 'node-1'], annotations: [] },
    { nodes: ['node-2'], annotations: ['annotation-1'] },
    { nodes: [], annotations: ['annotation-2', 'annotation-3'] },
    { nodes: [], annotations: ['annotation-4'] },
  ]);
  assert.equal(annotationCalls.length, 3);
  const assembly = assembleSnapshotPages(pages, { publicationExtensionMode: 'producer' });
  assert.equal(assembly.valid, true);
  if (assembly.valid) {
    assert.deepEqual(assembly.snapshot.nodes.map((node) => node.id), ['root-1', 'node-1', 'node-2']);
    assert.deepEqual(assembly.snapshot.annotations.map((row) => row.id), [
      'annotation-1', 'annotation-2', 'annotation-3', 'annotation-4',
    ]);
    assert.deepEqual(validateSnapshotSemantics(assembly.snapshot, {
      publicationExtensionMode: 'producer',
    }), { valid: true, issues: [] });
  }
});

test('binds include and stream position into tamper-safe, rotation-safe cursors', async () => {
  const oldKeys = keyring('old', 11);
  const firstPorts = ports({
    nodes: [publicationNode('node-1')], annotations: [publicationAnnotation('annotation-1')],
    cursors: oldKeys,
  });
  const first = await getPublicationSnapshotPage(firstPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2 },
  });
  assert.ok(first.nextCursor);
  assert.ok(first.nextCursor.length <= 128);
  const rotated = ports({
    nodes: [publicationNode('node-1')], annotations: [publicationAnnotation('annotation-1')],
    cursors: keyring('new', 12, [{ id: 'old', byte: 11 }]),
  });
  const continued = await getPublicationSnapshotPage(rotated, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2, pageCursor: first.nextCursor! },
  });
  assert.deepEqual(continued.snapshot.annotations.map((row) => row.id), ['annotation-1']);
  await assert.rejects(() => getPublicationSnapshotPage(rotated, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { limit: 2, pageCursor: first.nextCursor! },
  }), PublicationSnapshotExpiredError);
  const tampered = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(() => getPublicationSnapshotPage(rotated, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2, pageCursor: tampered },
  }), PublicationSnapshotExpiredError);
});

test('forwards cropped root/depth scope into the Annotation stream without changing logical completeness', async () => {
  const calls: Array<Parameters<PublicationAnnotationReadPort['loadPage']>[0]> = [];
  const result = await getPublicationSnapshotPage(ports({
    annotations: [publicationAnnotation('annotation-scoped')], annotationCalls: calls,
  }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { root: 'folder-1', depth: 2, include: ['annotations'], limit: 10 },
  });
  assert.equal(result.snapshot.complete, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.rootId, 'folder-1');
  assert.equal(calls[0]?.depth, 2);
});

test('expires sidecar continuations after create/delete/content or visibility/policy changes', async () => {
  let current = publicationCollection();
  const records = [publicationAnnotation('annotation-1'), publicationAnnotation('annotation-2')];
  const queryPorts = ports({
    nodes: [publicationNode('node-1')],
    annotations: records,
    collection: () => current,
  });
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2 },
  });
  records.push(publicationAnnotation('annotation-created-between-pages'));
  current = publicationCollection({ contentRevision: 'content-after-annotation-create' });
  await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2, pageCursor: first.nextCursor! },
  }), PublicationSnapshotExpiredError);

  current = publicationCollection();
  records.pop();
  const restarted = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2 },
  });
  records.splice(records.findIndex((row) => row.id === 'annotation-2'), 1);
  current = publicationCollection({ contentRevision: 'content-after-annotation-delete' });
  await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2, pageCursor: restarted.nextCursor! },
  }), PublicationSnapshotExpiredError);

  current = publicationCollection();
  records.push(publicationAnnotation('annotation-2'));
  const visibilityStart = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2 },
  });
  current = publicationCollection({ policyRevision: 'policy-after-visibility-delete' });
  await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2, pageCursor: visibilityStart.nextCursor! },
  }), PublicationSnapshotExpiredError);
});

test('shares the 500-item and 4 MiB delivery budgets across Nodes and Annotations', async () => {
  const combined = await getPublicationSnapshotPage(ports({
    nodes: Array.from({ length: 250 }, (_, index) => publicationNode(`node-${String(index).padStart(3, '0')}`)),
    annotations: Array.from({ length: 300 }, (_, index) => publicationAnnotation(`annotation-${String(index).padStart(3, '0')}`)),
  }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 500 },
  });
  assert.equal(combined.snapshot.nodes.length + combined.snapshot.annotations.length, 500);
  assert.ok(combined.nextCursor);

  const large = Array.from({ length: 80 }, (_, index) => publicationAnnotation(`large-${index}`, {
    payload: { ...publicationAnnotation(`large-${index}`).payload, value: 'x'.repeat(65_000) },
  }));
  const first = await getPublicationSnapshotPage(ports({ annotations: large }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 81 },
  });
  assert.ok(first.byteLength <= PUBLICATION_SNAPSHOT_MAX_BYTES);
  assert.ok(first.snapshot.annotations.length < large.length);
  assert.ok(first.nextCursor);
  assert.equal(first.snapshot.complete, false);
});

test('rejects an oversized Annotation continuation instead of issuing a non-advancing empty page', async () => {
  const oversized = publicationAnnotation('oversized', {
    payload: {
      ...publicationAnnotation('oversized').payload,
      value: 'x'.repeat(PUBLICATION_SNAPSHOT_MAX_BYTES),
    },
  });
  const queryPorts = ports({ annotations: [oversized] });
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2 },
  });
  assert.deepEqual(first.snapshot.nodes.map((row) => row.id), ['root-1']);
  assert.deepEqual(first.snapshot.annotations, []);
  assert.ok(first.nextCursor);

  await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations'], limit: 2, pageCursor: first.nextCursor! },
  }));
});

test('a real COLP client follows sidecar stream pages and validates the final assembled Snapshot', async () => {
  const queryPorts = ports({
    nodes: [publicationNode('node-1')],
    annotations: [publicationAnnotation('annotation-1'), publicationAnnotation('annotation-2')],
  });
  const coreManifest = createPublicationManifestCandidate({
    origin: 'https://known.example', mountPath: '/colp/v0.1/',
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de', title: 'Known', maxPageSize: 500,
    maxSnapshotNodes: 100_000,
    endpoints: {
      directory: 'https://known.example/colp/v0.1/directory',
      collection: 'https://known.example/colp/v0.1/collections/{collectionId}',
      snapshot: 'https://known.example/colp/v0.1/collections/{collectionId}/snapshot',
    },
  }, ['directory', 'collection', 'snapshot']).manifest;
  const manifest = {
    ...coreManifest,
    mounts: coreManifest.mounts.map((mount) => ({
      ...mount,
      profiles: ['core', 'publication'] as const,
    })),
  };
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/.well-known/collection-protocol') return protocolResponse(manifest);
    const page = await getPublicationSnapshotPage(queryPorts, {
      collectionId: 'collection-1', principal: { kind: 'anonymous' }, query: {
        include: ['annotations'], limit: 2,
        ...(url.searchParams.get('pageCursor') ? { pageCursor: url.searchParams.get('pageCursor')! } : {}),
      },
    });
    const headers = new Headers();
    if (page.nextCursor) headers.set('Link', `<https://known.example${url.pathname}?include=annotations&limit=2&pageCursor=${page.nextCursor}>; rel="next"`);
    return protocolResponse(page.snapshot, { headers });
  };
  const client = new ColpClient({
    manifestUrl: 'https://known.example/.well-known/collection-protocol', fetch,
  });
  const assembled = await client.getSnapshot('collection-1', { include: ['annotations'], limit: 2 });
  assert.deepEqual(assembled.annotations.map((row) => row.id), ['annotation-1', 'annotation-2']);
  assert.equal(createValidatorRegistry().validate('snapshot', assembled).valid, true);
  assert.deepEqual(validateSnapshotSemantics(assembled, { publicationExtensionMode: 'consumer' }), {
    valid: true, issues: [],
  });
});

function protocolResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('ETag', '"publication-annotation-test"');
  return new Response(JSON.stringify(value), { ...init, status: 200, headers });
}
