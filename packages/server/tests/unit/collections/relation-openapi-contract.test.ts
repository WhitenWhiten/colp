import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';

type RecordValue = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const api = () => parse(readFileSync(join(process.cwd(), 'openapi/product-v1.yaml'), 'utf8')) as RecordValue;

test('P2B-12 declares complete generated-client Relation CRUD and node paging contracts', () => {
  const document = api();
  const collection = document.paths['/api/v1/collections/{collectionId}/relations'];
  const item = document.paths['/api/v1/collections/{collectionId}/relations/{relationId}'];
  assert.deepEqual([collection.get.operationId, collection.post.operationId, item.get.operationId,
    item.patch.operationId, item.delete.operationId],
  ['listRelations', 'createRelation', 'getRelation', 'updateRelation', 'deleteRelation']);
  for (const operation of [collection.get, collection.post, item.get, item.patch, item.delete]) {
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    assert.ok(operation.responses['401']); assert.ok(operation.responses['404']);
  }
  const refs = new Set(collection.get.parameters.map((parameter: RecordValue) => parameter.$ref));
  for (const name of ['RelationNodeId', 'RelationDirection', 'RelationTypeFilter',
    'RelationVisibilityFilter', 'RelationLimit', 'RelationCursor']) {
    assert.ok(refs.has(`#/components/parameters/${name}`), name);
  }
});

test('Relation DTOs are closed and omit payload, ordinal, actor and owner facts', () => {
  const schemas = api().components.schemas;
  for (const name of ['RelationView', 'RelationPage', 'RelationPageState', 'CreateRelationRequest',
    'RelationMergePatch', 'DeleteRelationResult', 'RelationDeletionReceipt']) {
    assert.equal(schemas[name].type, 'object', name);
    assert.equal(schemas[name].additionalProperties, false, name);
  }
  assert.deepEqual(Object.keys(schemas.CreateRelationRequest.properties).sort(),
    ['extensions', 'fromNodeId', 'label', 'toNodeId', 'type', 'visibility']);
  assert.deepEqual(Object.keys(schemas.RelationMergePatch.properties).sort(),
    ['extensions', 'label', 'type', 'visibility']);
  const fields = Object.keys(schemas.RelationView.properties);
  for (const forbidden of ['payload', 'payloadJson', 'commitOrdinal', 'ownerSubjectId', 'actorPrincipalId']) {
    assert.equal(fields.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(schemas.RelationDirection.enum, ['incoming', 'outgoing', 'both']);
});
