import assert from 'node:assert/strict';
import { test } from 'vitest';
import { allocateMcpPublicationSlug } from '../../../src/modules/mcp/publication-slug.js';
import { decideMcpSetVisibilityRevisions } from '../../../src/modules/mcp/set-visibility-revisions.js';

const COLLECTION_ID = 'col_vis_1';
const NODE_ID = 'node_vis_1';
const COLLECTION_REVISION = 'collection-res-r1';
const POLICY_REVISION = 'policy-r1';
const NODE_REVISION = 'node-res-r1';

test('allocateMcpPublicationSlug is lowercase hex of length 32 and stable', () => {
  const slug = allocateMcpPublicationSlug(COLLECTION_ID);
  assert.match(slug, /^[a-z0-9]{32}$/u);
  assert.equal(allocateMcpPublicationSlug(COLLECTION_ID), slug);
  assert.notEqual(allocateMcpPublicationSlug(`${COLLECTION_ID}-other`), slug);
});

test('public and unlisted require the collection resource fence', () => {
  const publicOk = decideMcpSetVisibilityRevisions({
    visibility: 'public',
    collectionId: COLLECTION_ID,
    baseRevision: COLLECTION_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([{ id: NODE_ID, resourceRevision: NODE_REVISION }]),
  });
  assert.equal(publicOk?.kind, 'collection');
  assert.deepEqual(publicOk?.map, {
    [`resource.${COLLECTION_ID}`]: COLLECTION_REVISION,
    [`policy.${COLLECTION_ID}`]: POLICY_REVISION,
  });

  assert.equal(decideMcpSetVisibilityRevisions({
    visibility: 'unlisted',
    collectionId: COLLECTION_ID,
    baseRevision: NODE_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([{ id: NODE_ID, resourceRevision: NODE_REVISION }]),
  }), null);
});

test('protected requires exactly one matching node', () => {
  const ok = decideMcpSetVisibilityRevisions({
    visibility: 'protected',
    collectionId: COLLECTION_ID,
    baseRevision: NODE_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([{ id: NODE_ID, resourceRevision: NODE_REVISION }]),
  });
  assert.equal(ok?.kind, 'node');
  assert.deepEqual(ok?.map, {
    [`node.${NODE_ID}`]: NODE_REVISION,
    [`policy.${COLLECTION_ID}`]: POLICY_REVISION,
  });

  assert.equal(decideMcpSetVisibilityRevisions({
    visibility: 'protected',
    collectionId: COLLECTION_ID,
    baseRevision: COLLECTION_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([]),
  }), null);

  assert.equal(decideMcpSetVisibilityRevisions({
    visibility: 'protected',
    collectionId: COLLECTION_ID,
    baseRevision: NODE_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([
      { id: NODE_ID, resourceRevision: NODE_REVISION },
      { id: 'node_vis_2', resourceRevision: NODE_REVISION },
    ]),
  }), null);
});

test('private fail-closes when both collection and a unique node match the fence', () => {
  assert.equal(decideMcpSetVisibilityRevisions({
    visibility: 'private',
    collectionId: COLLECTION_ID,
    baseRevision: COLLECTION_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([{ id: NODE_ID, resourceRevision: COLLECTION_REVISION }]),
  }), null);

  const collectionOnly = decideMcpSetVisibilityRevisions({
    visibility: 'private',
    collectionId: COLLECTION_ID,
    baseRevision: COLLECTION_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([]),
  });
  assert.equal(collectionOnly?.kind, 'collection');

  const nodeOnly = decideMcpSetVisibilityRevisions({
    visibility: 'private',
    collectionId: COLLECTION_ID,
    baseRevision: NODE_REVISION,
    collectionResourceRevision: COLLECTION_REVISION,
    collectionPolicyRevision: POLICY_REVISION,
    matchingNodes: Object.freeze([{ id: NODE_ID, resourceRevision: NODE_REVISION }]),
  });
  assert.equal(nodeOnly?.kind, 'node');
});
