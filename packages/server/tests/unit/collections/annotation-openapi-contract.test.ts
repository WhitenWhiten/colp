import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';

// YAML contract traversal is intentionally dynamic at this parser boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RecordValue = Record<string, any>;

function document(): RecordValue {
  return parse(readFileSync(join(process.cwd(), 'openapi/product-v1.yaml'), 'utf8')) as RecordValue;
}

test('P2B-07 declares the complete additive Annotation Product surface', () => {
  const api = document();
  const collection = api.paths['/api/v1/collections/{collectionId}/annotations'];
  const item = api.paths['/api/v1/collections/{collectionId}/annotations/{annotationId}'];
  assert.deepEqual(Object.keys(collection).sort(), ['get', 'post']);
  assert.deepEqual(Object.keys(item).sort(), ['delete', 'get', 'patch']);
  assert.deepEqual(
    [collection.get, collection.post, item.get, item.patch, item.delete]
      .map((operation: RecordValue) => operation.operationId),
    ['listAnnotations', 'createAnnotation', 'getAnnotation', 'updateAnnotation', 'deleteAnnotation'],
  );
  for (const operation of [collection.get, collection.post, item.get, item.patch, item.delete]) {
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    assert.ok(operation.responses['401']);
    assert.ok(operation.responses['404']);
  }
  for (const operation of [collection.post, item.patch, item.delete]) {
    const refs = new Set(operation.parameters.map((parameter: RecordValue) => parameter.$ref));
    for (const ref of ['#/components/parameters/Origin', '#/components/parameters/CsrfToken', '#/components/parameters/CommandId']) {
      assert.ok(refs.has(ref), `${operation.operationId} misses ${ref}`);
    }
    assert.ok(operation.responses['409']);
    assert.ok(operation.responses['410']);
  }
  for (const operation of [item.patch, item.delete]) {
    assert.ok(operation.parameters.some((parameter: RecordValue) => parameter.$ref === '#/components/parameters/IfMatch'));
    assert.ok(operation.responses['412']);
    assert.ok(operation.responses['428']);
  }
});

test('Annotation schemas are closed, path/query identity is authoritative, and DTO omits internal facts', () => {
  const api = document();
  const schemas = api.components.schemas;
  for (const name of ['AnnotationView', 'AnnotationPage', 'AnnotationPageState', 'CreateAnnotationRequest',
    'AnnotationMergePatch', 'DeleteAnnotationResult', 'AnnotationDeletionReceipt']) {
    assert.equal(schemas[name].type, 'object', name);
    assert.equal(schemas[name].additionalProperties, false, name);
  }
  assert.deepEqual(Object.keys(schemas.CreateAnnotationRequest.properties).sort(),
    ['extensions', 'format', 'type', 'value', 'visibility']);
  assert.deepEqual(schemas.CreateAnnotationRequest.required, ['type', 'value', 'visibility']);
  assert.deepEqual(Object.keys(schemas.AnnotationMergePatch.properties).sort(),
    ['extensions', 'format', 'value', 'visibility']);
  const viewFields = Object.keys(schemas.AnnotationView.properties);
  for (const forbidden of ['payload', 'payloadJson', 'creatorPrincipalId', 'commitOrdinal', 'policyRevision']) {
    assert.equal(viewFields.includes(forbidden), false, forbidden);
  }
  for (const required of ['id', 'collectionId', 'subject', 'type', 'format', 'value', 'visibility', 'creator',
    'provenance', 'revision', 'createdAt', 'updatedAt', 'extensions']) {
    assert.ok(viewFields.includes(required), required);
  }
  const list = api.paths['/api/v1/collections/{collectionId}/annotations'].get;
  const refs = new Set(list.parameters.map((parameter: RecordValue) => parameter.$ref));
  assert.ok(refs.has('#/components/parameters/AnnotationResourceType'));
  assert.ok(refs.has('#/components/parameters/AnnotationResourceId'));
  assert.ok(refs.has('#/components/parameters/AnnotationLimit'));
  assert.ok(refs.has('#/components/parameters/AnnotationCursor'));
  assert.equal(schemas.AnnotationCursorValue.description.includes('Annotation-only'), true);
  assert.deepEqual(schemas.AnnotationProvenance.properties.kind.enum,
    ['human', 'ai', 'imported', 'derived']);
  assert.deepEqual(schemas.AnnotationProvenance.required, ['kind']);
});
