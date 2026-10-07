import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  attachBookmarkPreviewImages,
  linkPreviewObjectUrl,
  linkPreviewTargetIdentity,
  type LinkPreviewReadPort,
} from '../../../src/modules/collections/index.js';

const ORIGIN = 'https://known.example';
const OBJECT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function port(calls: string[][] = []): LinkPreviewReadPort {
  const key = linkPreviewTargetIdentity('https://a.example.com/x')!.urlKey;
  return {
    async findReadyByUrlKeys(keys) {
      calls.push([...keys]);
      return new Map(keys.includes(key) ? [[key, { objectId: OBJECT, width: 800, height: 400 }]] : []);
    },
    async findVetoedNodeIds(ids) {
      return new Set(ids.filter((id) => id === 'vetoed'));
    },
  };
}

describe('attachBookmarkPreviewImages', () => {
  const nodes = [
    { id: 'folder', kind: 'folder', url: null },
    { id: 'a', kind: 'bookmark', url: 'https://a.example.com/x' },
    { id: 'a-again', kind: 'bookmark', url: 'HTTPS://A.example.com/x/#frag' },
    { id: 'vetoed', kind: 'bookmark', url: 'https://a.example.com/x' },
    { id: 'tombstone', kind: 'bookmark', url: null },
    { id: 'other', kind: 'bookmark', url: 'https://b.example.com/' },
  ];

  test('looks up each normalized URL once and applies veto, tombstone and miss rules', async () => {
    const calls: string[][] = [];
    const result = await attachBookmarkPreviewImages(port(calls), ORIGIN, nodes);
    const image = { url: `${ORIGIN}/api/v1/link-preview/${OBJECT}`, width: 800, height: 400 };
    assert.deepEqual(result.map((node) => (node as { previewImage?: unknown }).previewImage), [
      undefined, image, null, null, null, null,
    ]);
    assert.equal(Object.hasOwn(result[0]!, 'previewImage'), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.length, 3, 'case and fragment collapse; a trailing slash stays a distinct fetch address');
  });

  test('no port or no origin gives null without querying', async () => {
    const calls: string[][] = [];
    for (const result of [
      await attachBookmarkPreviewImages(undefined, ORIGIN, nodes),
      await attachBookmarkPreviewImages(port(calls), undefined, nodes),
    ]) {
      assert.ok(result.filter((node) => node.kind === 'bookmark').every((node) => (node as { previewImage?: unknown }).previewImage === null));
    }
    assert.equal(calls.length, 0);
  });

  test('object URLs are same-origin and refuse non-uuid ids', () => {
    assert.equal(linkPreviewObjectUrl('https://known.example/some/path', OBJECT), `${ORIGIN}/api/v1/link-preview/${OBJECT}`);
    assert.throws(() => linkPreviewObjectUrl(ORIGIN, '../../etc/passwd'));
  });
});
