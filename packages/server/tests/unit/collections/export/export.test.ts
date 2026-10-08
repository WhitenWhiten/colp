import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetscapeBookmarkHtml } from '@know-n/colp/sync';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { parse } from 'yaml';
import { test } from 'vitest';
import {
  buildCollectionExport,
  renderCollectionExport,
  type ExportAnnotationSource,
  type ExportCollectionSource,
  type ExportNodeSource,
  type ExportRelationSource,
} from '../../../../src/modules/collections/application/export-collection.js';
import { serializeNetscapeBookmarkHtml } from '../../../../src/modules/collections/application/netscape-serializer.js';

const created = new Date('2026-03-04T05:06:07.000Z');
const updated = new Date('2026-04-05T06:07:08.000Z');
const stamp = '2026-03-04T05:06:07Z';
const later = '2026-04-05T06:07:08Z';

function node(partial: Pick<ExportNodeSource, 'id' | 'parentId' | 'kind'> & Partial<ExportNodeSource>): ExportNodeSource {
  return {
    isRoot: false,
    title: null,
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    position: null,
    revision: 'rev-node',
    createdAt: created,
    updatedAt: updated,
    ...partial,
  };
}

function source(access: ExportCollectionSource['access'] = 'owner'): ExportCollectionSource {
  const note: ExportAnnotationSource = {
    visibility: 'private',
    creatorPrincipalId: 'principal-owner',
    payload: {
      id: 'ann-note',
      collectionId: 'col-export',
      subject: { type: 'node', id: 'node-nested' },
      type: 'note',
      format: 'plain',
      value: 'remember this',
      visibility: 'private',
      createdAt: stamp,
      updatedAt: later,
      revision: 'rev-ann',
    },
  };
  const other: ExportAnnotationSource = {
    visibility: 'private',
    creatorPrincipalId: 'principal-other',
    payload: {
      id: 'ann-other',
      collectionId: 'col-export',
      subject: { type: 'node', id: 'node-nested' },
      type: 'note',
      format: 'plain',
      value: 'not mine',
      visibility: 'private',
      createdAt: stamp,
      updatedAt: later,
      revision: 'rev-ann-other',
    },
  };
  const related: ExportRelationSource = {
    visibility: 'protected',
    payload: {
      id: 'rel-related',
      collectionId: 'col-export',
      type: 'related',
      fromNodeId: 'node-l1-mark',
      toNodeId: 'node-nested',
      visibility: 'protected',
      createdAt: stamp,
      updatedAt: later,
      revision: 'rev-rel',
    },
  };
  const hidden: ExportRelationSource = {
    visibility: 'private',
    payload: {
      id: 'rel-private',
      collectionId: 'col-export',
      type: 'mentions',
      fromNodeId: 'node-l1-mark',
      toNodeId: 'node-after',
      visibility: 'private',
      createdAt: stamp,
      updatedAt: later,
      revision: 'rev-rel-private',
    },
  };
  return {
    id: 'col-export',
    access,
    title: 'Reading & list',
    summary: 'owner export',
    kind: 'bookmarks',
    visibility: 'private',
    publicationSlug: 'reading-list',
    rootNodeId: 'node-root',
    contentRevision: 'rev-content',
    policyRevision: 'rev-policy',
    createdAt: created,
    updatedAt: updated,
    nodes: [
      node({ id: 'node-root', parentId: null, kind: 'folder', isRoot: true, title: 'Reading & list' }),
      node({ id: 'node-l1', parentId: 'node-root', kind: 'folder', title: 'Level 1', position: 'a0', description: 'level-one note', tags: ['outer'] }),
      node({ id: 'node-l1-mark', parentId: 'node-l1', kind: 'bookmark', title: 'L1 mark', position: 'a0', url: 'https://example.test/l1', description: 'first mark' }),
      node({ id: 'node-sep-1', parentId: 'node-l1', kind: 'separator', position: 'a1' }),
      node({ id: 'node-l2', parentId: 'node-l1', kind: 'folder', title: 'Level 2', position: 'a2' }),
      node({ id: 'node-l3', parentId: 'node-l2', kind: 'folder', title: 'Level 3', position: 'a0', tags: ['inner', 'deep'] }),
      node({
        id: 'node-nested', parentId: 'node-l3', kind: 'bookmark', title: 'Nested', position: 'a0',
        url: 'https://example.test/nested?a=1&b=2', description: 'a <b> & notes', tags: ['colp', 'draft'],
      }),
      node({ id: 'node-sep-2', parentId: 'node-l3', kind: 'separator', position: 'a1' }),
      node({ id: 'node-after', parentId: 'node-l3', kind: 'bookmark', title: 'After', position: 'a2', url: 'https://example.test/after' }),
      node({ id: 'node-l2-mark', parentId: 'node-l2', kind: 'bookmark', title: 'L2 mark', position: 'a1', url: 'https://example.test/l2' }),
      node({ id: 'node-tail', parentId: 'node-root', kind: 'bookmark', title: 'Tail', position: 'a1', url: 'https://example.test/tail' }),
    ],
    annotations: [note, other],
    relations: [related, hidden],
  };
}

test('serializes folders three deep and round-trips structure and order', () => {
  const built = buildCollectionExport(source(), { principalId: 'principal-owner', origin: 'https://colp.test' });
  const html = serializeNetscapeBookmarkHtml(built.snapshot);
  const unix = String(Math.floor(created.getTime() / 1000));
  assert.match(html, new RegExp(`ADD_DATE="${unix}"`));
  assert.match(html, /TAGS="colp,draft"/u);
  assert.match(html, /TAGS="outer"/u);
  assert.match(html, /<DD>level-one note<\/DD>/u);
  assert.match(html, /<DD>a &lt;b&gt; &amp; notes<\/DD>/u);
  assert.equal(html.match(/<DT><HR>/gu)?.length, 2);
  assert.deepEqual(parseNetscapeBookmarkHtml(html), {
    kind: 'folder',
    title: 'Bookmarks',
    children: [
      {
        kind: 'folder',
        title: 'Level 1',
        children: [
          { kind: 'bookmark', title: 'L1 mark', url: 'https://example.test/l1' },
          {
            kind: 'folder',
            title: 'Level 2',
            children: [
              {
                kind: 'folder',
                title: 'Level 3',
                children: [
                  { kind: 'bookmark', title: 'Nested', url: 'https://example.test/nested?a=1&b=2' },
                  { kind: 'bookmark', title: 'After', url: 'https://example.test/after' },
                ],
              },
              { kind: 'bookmark', title: 'L2 mark', url: 'https://example.test/l2' },
            ],
          },
        ],
      },
      { kind: 'bookmark', title: 'Tail', url: 'https://example.test/tail' },
    ],
  });
});

test('export JSON validates as a COLP snapshot and keeps owner annotations', () => {
  const rendered = renderCollectionExport(source(), {
    principalId: 'principal-owner',
    origin: 'https://colp.test',
    format: 'json',
  });
  const parsed: unknown = JSON.parse(rendered.body);
  const result = createValidatorRegistry().validate('snapshot', parsed);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const document = parsed as {
    collection: { slug: string; canonicalUrl: string; revision: string };
    annotations: Array<{ id: string }>;
    relations: Array<{ id: string }>;
    nodes: Array<{ id: string; description?: string; tags?: string[] }>;
  };
  assert.equal(document.collection.slug, 'reading-list');
  assert.equal(document.collection.canonicalUrl, 'https://colp.test/c/reading-list');
  assert.equal(document.collection.revision, 'rev-content.rev-policy');
  assert.deepEqual(document.annotations.map((annotation) => annotation.id), ['ann-note']);
  assert.deepEqual(document.relations.map((relation) => relation.id), ['rel-related', 'rel-private']);
  const nested = document.nodes.find((item) => item.id === 'node-nested');
  assert.equal(nested?.description, 'a <b> & notes');
  assert.deepEqual(nested?.tags, ['colp', 'draft']);
  assert.equal(rendered.filename, 'reading-list.json');
  assert.match(rendered.contentType, /snapshot\+json/u);

  const viewer = renderCollectionExport(source('viewer'), {
    principalId: 'principal-viewer',
    origin: 'https://colp.test',
    format: 'json',
  });
  const viewerDocument = JSON.parse(viewer.body) as { annotations: unknown[]; relations: Array<{ id: string }> };
  assert.equal(createValidatorRegistry().validate('snapshot', JSON.parse(viewer.body)).valid, true);
  assert.deepEqual(viewerDocument.annotations, []);
  assert.deepEqual(viewerDocument.relations.map((relation) => relation.id), ['rel-related']);
});

test('OpenAPI export operation is no longer pending', () => {
  const document = parse(readFileSync(join(import.meta.dirname, '../../../../openapi/colp-server-v1.yaml'), 'utf8')) as {
    paths: Record<string, { get?: Record<string, unknown> }>;
  };
  const operation = document.paths['/api/v1/collections/{id}/export']?.get;
  assert.ok(operation);
  assert.equal(operation.operationId, 'exportCollection');
  assert.equal(operation['x-colp-server-pending'], undefined);
  const ok = operation.responses as { '200': { headers: { 'Content-Disposition': { required: boolean } } } };
  assert.equal(ok['200'].headers['Content-Disposition'].required, true);
  assert.equal(document.paths['/api/v1/me/agents']?.get?.operationId, 'listMyAgents');
  assert.equal(document.paths['/api/v1/me/agents']?.get?.['x-colp-server-pending'], undefined);
  assert.equal(document.paths['/api/v1/me/agents/{clientId}/policy']?.get?.['x-colp-server-pending'], true);
});
