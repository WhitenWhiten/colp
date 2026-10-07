import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMemoryPorts, createState, SUBJECT_OWNER } from '../../support/memory-collections-write-ports.js';

test('memory access-policy writes are observable through facts without changing collection revisions', async () => {
  const state = createState();
  state.collections.set('collection', {
    id: 'collection', ownerSubjectId: SUBJECT_OWNER, title: 'Test', summary: null,
    kind: 'bookmarks', visibility: 'private', rootNodeId: 'root', resourceRevision: 'r1',
    contentRevision: 'c1', policyRevision: 'p1', commitOrdinal: 1n,
    createdAt: state.now, updatedAt: state.now, deletedAt: null,
  });
  const ports = createMemoryPorts(state);
  const input = { collectionId: 'collection', subjectId: 'editor', role: 'editor' as const, grantedAt: new Date(state.now) };
  await ports.accessPolicy.insertMembership(input);
  assert.equal((await ports.accessPolicy.loadCollectionFacts({ collectionId: 'collection', actorSubjectId: 'editor' }))?.membershipRole, 'editor');
  await assert.rejects(ports.accessPolicy.insertMembership(input), /already exists/u);
  assert.equal(await ports.accessPolicy.deleteMembership(input), true);
  assert.equal(await ports.accessPolicy.deleteMembership(input), false);
  assert.equal((await ports.accessPolicy.loadCollectionFacts({ collectionId: 'collection', actorSubjectId: 'editor' }))?.membershipRole, null);
  const policyJson = { nested: { enabled: true } };
  await ports.accessPolicy.upsertCollectionPolicy({ collectionId: 'collection', policyJson, updatedAt: state.now });
  policyJson.nested.enabled = false;
  assert.deepEqual(state.policies.get('collection')?.policyJson, { nested: { enabled: true } });
  await ports.accessPolicy.upsertCollectionPolicy({ collectionId: 'collection', updatedAt: state.now });
  assert.deepEqual(state.policies.get('collection')?.policyJson, {});
  assert.equal(state.collections.get('collection')?.policyRevision, 'p1');
  assert.equal(state.collections.get('collection')?.ownerSubjectId, SUBJECT_OWNER);
});
