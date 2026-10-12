import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { chromeCreate, mappingFor, nativeContent, nodeContent, nodeCreate,
  projectionContent } from '../src/pull-projection.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const collectionId = 'collection-projection';

function created(kind: 'Bookmark' | 'Folder' | 'Separator', sequence: number) {
  const event = pullFixtures.createEvent({ kind, sequence, collectionId, parentId: 'root' });
  if (event.kind !== 'operation' || event.effect.kind !== 'node_created') throw new Error('fixture_invalid');
  return event.effect.node;
}

describe('Pull native projection', () => {
  test('projects bookmark, folder and separator content for Chrome without protocol metadata', () => {
    const bookmark = created('Bookmark', 1); const folder = created('Folder', 2); const separator = created('Separator', 3);
    assert.deepEqual(nodeContent(bookmark), { title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(nodeContent(folder), { title: 'Remote' });
    assert.deepEqual(nodeContent(separator), {});
    assert.deepEqual(nodeCreate(bookmark), { kind: 'bookmark', title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(chromeCreate(bookmark), { title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(chromeCreate(folder), { title: 'Remote' });
    assert.throws(() => chromeCreate(separator), /pull_node_kind_invalid/);
  });

  test('preserves canonical extensions and annotations only in durable projection content', () => {
    const node: any = { ...created('Bookmark', 4), visibility: 'shared', description: 'Description',
      tags: ['tag-a'], extensions: { 'https://example.test/ext': { nested: true } } };
    assert.deepEqual(projectionContent(node), { title: 'Remote', url: 'https://example.test/', visibility: 'shared',
      extensions: { 'https://example.test/ext': { nested: true } }, description: 'Description', tags: ['tag-a'] });
    assert.deepEqual(nativeContent(projectionContent(node)), { title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(nativeContent({ title: 1, url: null, extensions: {} } as never), {});
  });

  test('an explicit folder clear stays distinguishable from a legacy projection with unknown description', () => {
    const node = { ...created('Folder', 8), description: undefined };
    assert.equal(projectionContent(node).description, null);
    assert.deepEqual(nativeContent(projectionContent(node)), { title: 'Remote' });
  });

  test('creates a canonical mapping with stable content digests and optional parent identities', () => {
    const node = created('Bookmark', 5);
    const mapping = mappingFor(node, 'native-node', 'native-parent', 'parent', null, 'native-root');
    assert.deepEqual({ nativeId: mapping.nativeId, colpId: mapping.colpId, nodeKind: mapping.nodeKind,
      parentNativeId: mapping.parentNativeId, parentColpId: mapping.parentColpId,
      content: mapping.projection.content }, {
      nativeId: 'native-node', colpId: node.id, nodeKind: 'bookmark', parentNativeId: 'native-parent',
      parentColpId: 'parent', content: { title: 'Remote', url: 'https://example.test/', tags: [] } });
    assert.match(mapping.projection.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(mapping.projection.contentDigest ?? '', /^sha256:[0-9a-f]{64}$/u);
    const detached = mappingFor(node, 'native-node', null, null, null, 'native-root');
    assert.equal('parentNativeId' in detached, false); assert.equal('parentColpId' in detached, false);
  });

  test('rejects root, alias and separator shapes that Chrome cannot create directly', () => {
    const root = { ...created('Folder', 6), kind: 'root' } as never;
    const alias = { ...created('Bookmark', 7), kind: 'alias' } as never;
    for (const candidate of [root, alias]) {
      assert.throws(() => nodeContent(candidate), /pull_node_kind_invalid/);
      assert.throws(() => nodeCreate(candidate), /pull_node_kind_invalid/);
      assert.throws(() => chromeCreate(candidate), /pull_node_kind_invalid/);
      assert.throws(() => mappingFor(candidate, 'native', null, null, null, 'native-root'),
        /pull_node_kind_invalid/);
    }
  });
});
