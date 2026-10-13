import { expect, test } from 'vitest';
import { placementInputDigest, placementResultDigest } from '../../../src/modules/automation/index.js';
// Frozen from the public digest/v1 contract: intake + placement.subtree.v1, not from these adapters.
const pins = { committedNode: { serverUuid: 'server', collectionId: 'collection', nodeId: 'golden-bookmark' }, ruleRevision: '1', bindingRevision: '1' };
const fields = { url: 'https://arxiv.org/sync', title: 'Sync paper', tags: [] };
test('M1 placement digest pins the registered output contract and canonical identity with an independent golden oracle', () => {
  expect(placementInputDigest(pins, fields)).toBe('834032f03fc653924490829f01b05f8eedfc70f95670beab5fb95077f2bbe170');
  expect(placementResultDigest({ serverUuid: 'server', collectionId: 'collection', nodeId: 'academic' }))
    .toBe('30c3d25b53d6a669f6fef1ec4eccd45672098ff03f019987994cd2d000ac4595');
  const withNote = { ...fields, note: 'unrelated note' };
  expect(placementInputDigest(pins, withNote)).toBe(placementInputDigest(pins, fields));
  expect(placementInputDigest({ ...pins, committedNode: { ...pins.committedNode, nodeId: 'other' } }, fields)).not.toBe(placementInputDigest(pins, fields));
});
