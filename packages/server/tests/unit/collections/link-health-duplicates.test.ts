import assert from 'node:assert/strict';
import { test } from 'vitest';
import { duplicateOfNodeIdByNormalizedUrl } from '../../../src/modules/collections/index.js';

const T0 = new Date('2026-08-22T07:00:00.000Z');
const T1 = new Date('2026-08-22T07:01:00.000Z');
const T2 = new Date('2026-08-22T07:02:00.000Z');

test('same URL different parent/title stay distinct nodes and later copies are candidates of the earliest', () => {
  const facts = [
    { nodeId: 'alpha', collectionId: 'col-a', url: 'https://example.com/shared', createdAt: T0 },
    { nodeId: 'beta', collectionId: 'col-a', url: 'https://EXAMPLE.com/shared/', createdAt: T1 },
    { nodeId: 'gamma', collectionId: 'col-a', url: 'https://example.com/shared', createdAt: T2 },
  ];
  const map = duplicateOfNodeIdByNormalizedUrl(facts);
  assert.equal(map.get('alpha'), null);
  assert.equal(map.get('beta'), 'alpha');
  assert.equal(map.get('gamma'), 'alpha');
  assert.equal(new Set(facts.map((fact) => fact.nodeId)).size, 3);
});

test('the same normalized URL in another Collection is not a candidate of this Collection', () => {
  const facts = [
    { nodeId: 'owned', collectionId: 'col-a', url: 'https://example.com/x', createdAt: T0 },
    { nodeId: 'foreign', collectionId: 'col-b', url: 'https://example.com/x', createdAt: T1 },
  ];
  const map = duplicateOfNodeIdByNormalizedUrl(facts);
  assert.equal(map.get('owned'), null);
  assert.equal(map.get('foreign'), null);
});
