import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ColpClient } from '@know-n/colp/client';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { assembleSnapshotPages, validateSnapshotSemantics } from '@know-n/colp/semantic';
import type { Relation, Snapshot } from '@know-n/colp/types';
import { test } from 'vitest';
import {
  createPublicationCursorKeyring,
  createPublicationManifestCandidate,
  getPublicationSnapshotPage,
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  PUBLICATION_SNAPSHOT_MAX_BYTES,
  PublicationSnapshotExpiredError,
  type PublicationAnnotationReadPort,
  type PublicationRelationReadPort,
  type PublicationRelationRecord,
  type PublicationSnapshotQueryPorts,
  type PublicationSnapshotReadPort,
} from '../../../src/modules/publication/index.js';
import {
  publicationAnnotation, publicationCollection, publicationNode, publicationRoot,
} from '../../fixtures/phase2/publication-annotations.js';

const instant = '2026-07-25T00:00:00.000Z';
const locator = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);

function relation(id: string, overrides: Partial<PublicationRelationRecord> = {}): PublicationRelationRecord {
  const wire: Relation = {
    id, collectionId: 'collection-1', type: 'related', fromNodeId: 'node-1', toNodeId: 'node-2',
    label: `label-${id}`, visibility: 'public', revision: `revision-${id}`,
    createdAt: instant, updatedAt: instant,
  };
  return {
    id, collectionId: 'collection-1', fromNodeId: wire.fromNodeId, toNodeId: wire.toNodeId,
    visibility: wire.visibility, fromVisibility: 'inherit', toVisibility: 'inherit',
    fromAuthorized: true, toAuthorized: true,
    fromAncestorVisibility: null, toAncestorVisibility: null,
    fromAncestorRestricted: false, toAncestorRestricted: false, payload: wire, deletedAt: null,
    ...overrides,
  };
}

function keyring() {
  return createPublicationCursorKeyring({
    active: { id: 'relations', secret: Buffer.alloc(32, 82).toString('base64') }, retained: [],
  });
}

function ports(input: {
  nodes?: ReturnType<typeof publicationNode>[];
  relations?: PublicationRelationRecord[];
  annotations?: ReturnType<typeof publicationAnnotation>[];
  relationCalls?: unknown[];
  member?: boolean;
  memberRole?: 'viewer' | 'editor';
  revision?: () => { contentRevision: string; policyRevision: string };
} = {}): PublicationSnapshotQueryPorts {
  const revision = input.revision ?? (() => ({ contentRevision: 'content-1', policyRevision: 'policy-1' }));
  const collection = () => publicationCollection(revision());
  const nodes = input.nodes ?? [publicationNode('node-1'), publicationNode('node-2')];
  const nodeRead: PublicationSnapshotReadPort = { async loadPage(request) {
    const start = request.afterLocator ? nodes.findIndex((row) => locator(row.id) === request.afterLocator) + 1 : 0;
    return { isolation: 'repeatable read', comparatorVersion: 'parent-position-id-v1', collection: collection(),
      root: publicationRoot, candidates: request.metadataOnly ? [] : nodes.slice(Math.max(0, start), Math.max(0, start) + request.limit + 1) };
  } };
  const annotations = input.annotations ?? [];
  const annotationRead: PublicationAnnotationReadPort = { async loadPage(request) {
    const start = request.afterLocator ? annotations.findIndex((row) => locator(row.id) === request.afterLocator) + 1 : 0;
    const current = revision();
    return { isolation: 'repeatable read', comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
      ...current, candidates: annotations.slice(Math.max(0, start), Math.max(0, start) + request.limit + 1) };
  } };
  const relations = input.relations ?? [];
  const relationRead: PublicationRelationReadPort = { async loadPage(request) {
    input.relationCalls?.push(request);
    const start = request.afterLocator ? relations.findIndex((row) => locator(row.id) === request.afterLocator) + 1 : 0;
    const current = revision();
    return { isolation: 'repeatable read', comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION,
      ...current, candidates: relations.slice(Math.max(0, start), Math.max(0, start) + request.limit + 1) };
  } };
  return {
    reads: nodeRead, annotations: annotationRead, relations: relationRead, cursors: keyring(),
    origin: 'https://known.example', accessPolicy: { async loadCollectionFacts() {
      const current = collection();
      return { collectionId: current.id, ownerSubjectId: current.ownerSubjectId,
        visibility: current.visibility, policyRevision: current.policyRevision,
        membershipRole: input.member ? (input.memberRole ?? 'viewer') : null, deleted: false };
    } },
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  };
}

async function traverse(queryPorts: PublicationSnapshotQueryPorts, include: ('annotations' | 'relations')[], member = false) {
  const pages: Snapshot[] = [];
  let pageCursor: string | undefined;
  do {
    const page = await getPublicationSnapshotPage(queryPorts, {
      collectionId: 'collection-1', principal: member
        ? { kind: 'account', principalId: 'account-member', subjectId: 'subject-member' }
        : { kind: 'anonymous' },
      query: { include, limit: 2, ...(pageCursor ? { pageCursor } : {}) },
    });
    pages.push(page.snapshot); pageCursor = page.nextCursor ?? undefined;
  } while (pageCursor);
  return pages;
}

test('performs zero Relation reads unless include=relations is requested', async () => {
  const calls: unknown[] = [];
  const page = await getPublicationSnapshotPage(ports({ relations: [relation('relation-1')], relationCalls: calls }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' }, query: { limit: 3 },
  });
  assert.deepEqual(page.snapshot.relations, []);
  assert.equal(calls.length, 0);
});

test('conceals the complete Relation whenever visibility or either endpoint is not authorized', async () => {
  const rows = [
    relation('public'), relation('unlisted', { visibility: 'unlisted', payload: { ...relation('unlisted').payload, visibility: 'unlisted' } }),
    relation('protected', { visibility: 'protected', payload: { ...relation('protected').payload, visibility: 'protected' } }),
    relation('private', { visibility: 'private', payload: { ...relation('private').payload, visibility: 'private' } }),
    relation('hidden-from', { fromVisibility: 'private' }), relation('hidden-to', {
      toAncestorRestricted: true, toAncestorVisibility: 'private',
    }),
    relation('deleted', { deletedAt: new Date(instant) }),
  ];
  const anonymous = assembleSnapshotPages(await traverse(ports({ relations: rows }), ['relations']), {
    publicationExtensionMode: 'producer',
  });
  assert.equal(anonymous.valid, true);
  if (anonymous.valid) assert.deepEqual(anonymous.snapshot.relations.map((row) => row.id), ['public', 'unlisted']);
  assert.equal(JSON.stringify(anonymous).includes('label-hidden-from'), false);
  assert.equal(JSON.stringify(anonymous).includes('label-hidden-to'), false);

  const member = assembleSnapshotPages(await traverse(ports({ relations: rows, member: true }), ['relations'], true), {
    publicationExtensionMode: 'producer',
  });
  assert.equal(member.valid, true);
  if (member.valid) assert.deepEqual(member.snapshot.relations.map((row) => row.id), [
    'public', 'unlisted', 'protected',
  ]);
  assert.equal(JSON.stringify(member).includes('label-private'), false);
  assert.equal(JSON.stringify(member).includes('label-hidden-from'), false);
  assert.equal(JSON.stringify(member).includes('label-hidden-to'), false);

  const editor = assembleSnapshotPages(await traverse(ports({
    relations: rows, member: true, memberRole: 'editor',
  }), ['relations'], true), { publicationExtensionMode: 'producer' });
  assert.equal(editor.valid, true);
  if (editor.valid) assert.equal(editor.snapshot.relations.some((row) => row.id === 'private'), true);
});

test('uses deterministic Node, Annotation, Relation streams and permits a Relation-only final page', async () => {
  const pages = await traverse(ports({
    annotations: [publicationAnnotation('annotation-1')],
    relations: [relation('relation-1'), relation('relation-2'), relation('relation-3')],
  }), ['relations', 'annotations']);
  assert.deepEqual(pages.map((page) => ({ nodes: page.nodes.map((row) => row.id),
    annotations: page.annotations.map((row) => row.id), relations: page.relations.map((row) => row.id) })), [
    { nodes: ['root-1', 'node-1'], annotations: [], relations: [] },
    { nodes: ['node-2'], annotations: ['annotation-1'], relations: [] },
    { nodes: [], annotations: [], relations: ['relation-1', 'relation-2'] },
    { nodes: [], annotations: [], relations: ['relation-3'] },
  ]);
  const assembly = assembleSnapshotPages(pages, { publicationExtensionMode: 'producer' });
  assert.equal(assembly.valid, true);
  if (assembly.valid) assert.deepEqual(validateSnapshotSemantics(assembly.snapshot, {
    publicationExtensionMode: 'producer',
  }), { valid: true, issues: [] });
});

test('preserves directed incoming and outgoing endpoints across different Node pages', async () => {
  const outgoing = relation('outgoing');
  const incoming = relation('incoming', {
    fromNodeId: 'node-2', toNodeId: 'node-1',
    payload: { ...relation('incoming').payload, fromNodeId: 'node-2', toNodeId: 'node-1' },
  });
  const assembled = assembleSnapshotPages(await traverse(ports({
    relations: [outgoing, incoming],
  }), ['relations']), { publicationExtensionMode: 'producer' });
  assert.equal(assembled.valid, true);
  if (assembled.valid) assert.deepEqual(assembled.snapshot.relations.map((row) => [
    row.id, row.fromNodeId, row.toNodeId,
  ]), [
    ['outgoing', 'node-1', 'node-2'], ['incoming', 'node-2', 'node-1'],
  ]);
});

test('binds canonical include set and versioned stream state, rejects cross-include and fence mutation', async () => {
  let current = { contentRevision: 'content-1', policyRevision: 'policy-1' };
  const queryPorts = ports({ relations: [relation('relation-1')], revision: () => current });
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['relations', 'annotations'], limit: 2 },
  });
  const canonical = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations', 'relations'], limit: 2, pageCursor: first.nextCursor! },
  });
  assert.equal(canonical.snapshot.page.sequence, 2);
  await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['relations'], limit: 2, pageCursor: first.nextCursor! },
  }), PublicationSnapshotExpiredError);
  current = { ...current, contentRevision: 'content-2' };
  await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations', 'relations'], limit: 2, pageCursor: first.nextCursor! },
  }), PublicationSnapshotExpiredError);
});

test('shares 500-item and 4 MiB budgets across all streams', async () => {
  const nodes = Array.from({ length: 250 }, (_, index) => publicationNode(`node-${String(index).padStart(3, '0')}`));
  const rows = Array.from({ length: 300 }, (_, index) => relation(`relation-${String(index).padStart(3, '0')}`));
  const page = await getPublicationSnapshotPage(ports({ nodes, relations: rows }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' }, query: { include: ['relations'], limit: 500 },
  });
  assert.equal(page.snapshot.nodes.length + page.snapshot.annotations.length + page.snapshot.relations.length, 500);
  assert.ok(page.nextCursor);

  const largeAnnotations = Array.from({ length: 50 }, (_, index) => publicationAnnotation(`large-a-${index}`, {
    payload: { ...publicationAnnotation(`large-a-${index}`).payload, value: 'x'.repeat(65_000) },
  }));
  const largeRelations = Array.from({ length: 300 }, (_, index) => relation(`large-r-${index}`, {
    payload: { ...relation(`large-r-${index}`).payload, label: 'y'.repeat(4_096) },
  }));
  const bounded = await getPublicationSnapshotPage(ports({
    annotations: largeAnnotations, relations: largeRelations,
  }), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
    query: { include: ['annotations', 'relations'], limit: 500 },
  });
  assert.ok(bounded.byteLength <= PUBLICATION_SNAPSHOT_MAX_BYTES);
  assert.equal(bounded.snapshot.annotations.length, largeAnnotations.length);
  assert.ok(bounded.snapshot.relations.length < largeRelations.length);
  assert.ok(bounded.nextCursor);
});

test('a real COLP client assembles relation endpoints across Node pages without dangling references', async () => {
  const queryPorts = ports({ relations: [relation('relation-1')] });
  const coreManifest = createPublicationManifestCandidate({
    origin: 'https://known.example', mountPath: '/colp/v0.1/',
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de', title: 'Known', maxPageSize: 500,
    maxSnapshotNodes: 100_000, endpoints: {
      directory: 'https://known.example/colp/v0.1/directory',
      collection: 'https://known.example/colp/v0.1/collections/{collectionId}',
      snapshot: 'https://known.example/colp/v0.1/collections/{collectionId}/snapshot',
    },
  }, ['directory', 'collection', 'snapshot']).manifest;
  const manifest = { ...coreManifest, mounts: coreManifest.mounts.map((mount) => ({
    ...mount, profiles: ['core', 'publication'] as const,
  })) };
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest, { headers: { ETag: '"m"' } });
    const pageCursor = url.searchParams.get('pageCursor') ?? undefined;
    const page = await getPublicationSnapshotPage(queryPorts, {
      collectionId: 'collection-1', principal: { kind: 'anonymous' },
      query: { include: ['relations'], limit: 2, ...(pageCursor ? { pageCursor } : {}) },
    });
    const headers = new Headers({ 'Content-Type': 'application/json', ETag: '"r"' });
    if (page.nextCursor) headers.set('Link', `<https://known.example${url.pathname}?include=relations&limit=2&pageCursor=${page.nextCursor}>; rel="next"`);
    return new Response(JSON.stringify(page.snapshot), { status: 200, headers });
  };
  const snapshot = await new ColpClient({
    manifestUrl: 'https://known.example/.well-known/collection-protocol', fetch,
  }).getSnapshot('collection-1', { include: ['relations'], limit: 2 });
  assert.deepEqual(snapshot.relations.map((row) => row.id), ['relation-1']);
  assert.equal(createValidatorRegistry().validate('snapshot', snapshot).valid, true);
  assert.deepEqual(validateSnapshotSemantics(snapshot, { publicationExtensionMode: 'consumer' }), {
    valid: true, issues: [],
  });
});
