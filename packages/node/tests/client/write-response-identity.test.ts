import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ColpClient, createUrlHash } from '../../src/client/index.js';
import type { Manifest, Snapshot } from '../../src/types/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(
  new URL(`../../fixtures/protocol/examples/${name}`, import.meta.url), 'utf8'));
const manifest = fixture<Manifest>('public-manifest.json');
const snapshot = fixture<Snapshot>('collection-snapshot.json');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const node = { ...snapshot.nodes[1]!, parentId: snapshot.collection.rootNodeId };
const createPayload = { parentId: node.parentId,
  node: { kind: 'bookmark' as const, title: 'Created', url: 'https://example.test/' } };
const movePayload = { newParentId: node.parentId, baseSourceParentRevision: 'cr1', baseTargetParentRevision: 'cr1' };

function client(response: unknown, created = false) {
  return new ColpClient({ manifestUrl, fetch: async input => String(input) === manifestUrl
    ? Response.json(manifest)
    : Response.json(response, { status: created ? 201 : 200,
      headers: { ETag: '"r2"', ...(created ? { Location: `https://alice.example/nodes/${node.id}` } : {}) } }),
  });
}

describe('write response resource and placement bindings', () => {
  it('accepts a correctly bound create response', async () => {
    await expect(client(node, true).createNode(snapshot.collection.id, createPayload,
      { idempotencyKey: 'create-1' })).resolves.toEqual(node);
  });

  it.each([
    { field: 'collectionId', value: 'other-collection', code: 'collection_identity_mismatch' },
    { field: 'parentId', value: 'other-parent', code: 'node_parent_mismatch' },
  ])('rejects create response $field mismatch with a semantic error', async ({ field, value, code }) => {
    await expect(client({ ...node, [field]: value }, true).createNode(snapshot.collection.id, createPayload,
      { idempotencyKey: 'create-1' })).rejects.toMatchObject({ stage: 'semantic',
      details: [expect.objectContaining({ code, path: `/${field}` })] });
  });

  it.each([
    { field: 'collectionId', value: 'other-collection', code: 'collection_identity_mismatch' },
    { field: 'id', value: 'other-node', code: 'node_identity_mismatch' },
    { field: 'parentId', value: 'other-parent', code: 'node_parent_mismatch' },
    { field: 'position', value: 'z1', code: 'node_position_mismatch' },
  ])('rejects moved Node $field mismatch with a semantic error', async ({ field, value, code }) => {
    const response = { node: { ...node, [field]: value }, position: node.position,
      sourceParentRevision: 'cr2', targetParentRevision: 'cr3', warnings: [] };
    await expect(client(response).moveNode(snapshot.collection.id, node.id, movePayload,
      { idempotencyKey: 'move-1', ifMatch: '"r1"' })).rejects.toMatchObject({ stage: 'semantic',
      details: [expect.objectContaining({ code, path: `/node/${field}` })] });
  });

  it('accepts a consistent server-transformed position', async () => {
    const response = { node: { ...node, position: 'z1' }, position: 'z1',
      sourceParentRevision: 'cr2', targetParentRevision: 'cr3', warnings: [] };
    await expect(client(response).moveNode(snapshot.collection.id, node.id, movePayload,
      { idempotencyKey: 'move-1', ifMatch: '"r1"' })).resolves.toEqual(response);
  });

  it('keeps structural errors distinct from identity errors', async () => {
    await expect(client({ ...node, collectionId: 42 }, true).createNode(snapshot.collection.id, createPayload,
      { idempotencyKey: 'create-1' })).rejects.toMatchObject({ stage: 'structural' });
  });

  it.each(['create', 'move'] as const)('preserves URL hash validation for %s responses', async operation => {
    const invalidNode = { ...node, urlHash: createUrlHash('https://wrong.example/') };
    const response = operation === 'create' ? invalidNode : { node: invalidNode, position: node.position,
      sourceParentRevision: 'cr2', targetParentRevision: 'cr3', warnings: [] };
    const request = operation === 'create'
      ? client(response, true).createNode(snapshot.collection.id, createPayload, { idempotencyKey: 'create-1' })
      : client(response).moveNode(snapshot.collection.id, node.id, movePayload,
        { idempotencyKey: 'move-1', ifMatch: '"r1"' });
    await expect(request).rejects.toMatchObject({ stage: 'semantic', details: [expect.objectContaining({
      code: 'url_hash_mismatch', path: operation === 'create' ? '/urlHash' : '/node/urlHash',
    })] });
  });
});
