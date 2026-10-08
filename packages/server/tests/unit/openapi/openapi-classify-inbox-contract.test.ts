import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const sourcePath = join(backendRoot, 'openapi/product-v1.yaml');

type UnknownRecord = Record<string, unknown>;
type Operation = UnknownRecord & {
  operationId?: string;
  tags?: string[];
  parameters?: Array<{ $ref?: string }>;
  responses?: Record<string, UnknownRecord>;
  security?: Array<Record<string, unknown>>;
  requestBody?: UnknownRecord;
};
type OpenApiDocument = UnknownRecord & {
  paths: Record<string, Record<string, Operation>>;
  components: {
    parameters: Record<string, UnknownRecord>;
    schemas: Record<string, UnknownRecord>;
  };
};

function readDocument(path = sourcePath): OpenApiDocument {
  return parse(readFileSync(path, 'utf8')) as OpenApiDocument;
}

function parameterRefs(operation: Operation): Set<string> {
  return new Set((operation.parameters ?? []).map((parameter) => parameter.$ref).filter(Boolean) as string[]);
}

test('Classify inbox OpenAPI operations, parameters, and closed schemas', () => {
  const document = readDocument();
  const classifyInbox = document.paths['/api/v1/me/classify-inbox']?.get;
  assert.ok(classifyInbox);
  assert.equal(classifyInbox.operationId, 'getMyClassifyInbox');
  assert.deepEqual(classifyInbox.tags, ['ClassifyInbox']);
  assert.deepEqual(classifyInbox.security, [{ cookieAuth: [] }]);
  const classifyInboxRefs = parameterRefs(classifyInbox);
  assert.equal(classifyInboxRefs.has('#/components/parameters/CommandId'), false);
  assert.equal(classifyInboxRefs.has('#/components/parameters/Origin'), false);
  assert.equal(classifyInboxRefs.has('#/components/parameters/CsrfToken'), false);
  assert.equal(classifyInboxRefs.has('#/components/parameters/ClassifyInboxLimit'), true);
  assert.equal(classifyInboxRefs.has('#/components/parameters/ClassifyInboxCursor'), true);
  const classifyInboxOk = classifyInbox.responses?.['200'] as UnknownRecord;
  assert.equal(
    (classifyInboxOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  assert.equal(
    ((classifyInboxOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/ClassifyInboxPage',
  );
  assert.ok(Object.keys(classifyInbox.responses ?? {}).includes('404'));
  assert.equal(document.paths['/api/v1/me/classify-inbox']?.post, undefined);
  const classifySkip = document.paths['/api/v1/me/classify-inbox/{nodeId}/skip']?.post;
  assert.ok(classifySkip);
  assert.equal(classifySkip.operationId, 'skipMyClassifyInboxItem');
  assert.deepEqual(classifySkip.tags, ['ClassifyInbox']);
  assert.deepEqual(classifySkip.security, [{ cookieAuth: [] }]);
  assert.notEqual(classifySkip['x-known-route-manifest'], false);
  const classifySkipRefs = parameterRefs(classifySkip);
  assert.equal(classifySkipRefs.has('#/components/parameters/NodeId'), true);
  assert.equal(classifySkipRefs.has('#/components/parameters/Origin'), true);
  assert.equal(classifySkipRefs.has('#/components/parameters/CsrfToken'), true);
  assert.equal(classifySkipRefs.has('#/components/parameters/CommandId'), true);
  assert.equal(classifySkipRefs.has('#/components/parameters/IfMatch'), false);
  const classifyAccept = document.paths['/api/v1/me/classify-inbox/{nodeId}/accept']?.post;
  assert.ok(classifyAccept);
  assert.equal(classifyAccept.operationId, 'acceptMyClassifyInboxItem');
  assert.deepEqual(classifyAccept.tags, ['ClassifyInbox']);
  assert.deepEqual(classifyAccept.security, [{ cookieAuth: [] }]);
  assert.notEqual(classifyAccept['x-known-route-manifest'], false);
  const classifyAcceptRefs = parameterRefs(classifyAccept);
  assert.equal(classifyAcceptRefs.has('#/components/parameters/NodeId'), true);
  assert.equal(classifyAcceptRefs.has('#/components/parameters/Origin'), true);
  assert.equal(classifyAcceptRefs.has('#/components/parameters/CsrfToken'), true);
  assert.equal(classifyAcceptRefs.has('#/components/parameters/CommandId'), true);
  assert.equal(classifyAcceptRefs.has('#/components/parameters/IfMatch'), true);
  const acceptBody = classifyAccept.requestBody as UnknownRecord;
  assert.equal(
    ((acceptBody.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/ClassifyInboxAcceptRequest',
  );
  const acceptRequest = document.components.schemas.ClassifyInboxAcceptRequest as UnknownRecord;
  assert.equal(acceptRequest.additionalProperties, false);
  assert.deepEqual(acceptRequest.required, ['suggestionId']);
  assert.ok(Object.keys(classifyAccept.responses ?? {}).includes('412'));
  assert.ok(Object.keys(classifyAccept.responses ?? {}).includes('428'));

  const skipBody = classifySkip.requestBody as UnknownRecord;
  assert.equal(skipBody.required, true);
  assert.equal(
    ((skipBody.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/ClassifyInboxSkipRequest',
  );
  const skipRequest = document.components.schemas.ClassifyInboxSkipRequest as UnknownRecord;
  assert.equal(skipRequest.additionalProperties, false);
  const skipOk = classifySkip.responses?.['200'] as UnknownRecord;
  assert.equal(
    (skipOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  assert.equal(
    ((skipOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/ClassifyInboxDecisionReceipt',
  );
  assert.ok(Object.keys(classifySkip.responses ?? {}).includes('403'));
  const skipReceipt = document.components.schemas.ClassifyInboxDecisionReceipt as UnknownRecord;
  assert.equal(skipReceipt.additionalProperties, false);
  assert.deepEqual(skipReceipt.required, ['nodeId', 'decision']);
  assert.equal(Object.hasOwn(skipReceipt.properties as UnknownRecord, 'folderId'), false);
  assert.deepEqual(((skipReceipt.properties as UnknownRecord).decision as UnknownRecord).enum, ['skipped']);
  const acceptOk = classifyAccept.responses?.['200'] as UnknownRecord;
  assert.equal(
    ((acceptOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/ClassifyInboxAcceptReceipt',
  );
  const acceptReceipt = document.components.schemas.ClassifyInboxAcceptReceipt as UnknownRecord;
  assert.equal(acceptReceipt.additionalProperties, false);
  assert.deepEqual(acceptReceipt.required, ['nodeId', 'decision', 'folderId']);
  assert.deepEqual(((acceptReceipt.properties as UnknownRecord).decision as UnknownRecord).enum, ['accepted']);
  const classifyItem = document.components.schemas.ClassifyInboxItem as UnknownRecord;
  assert.equal(classifyItem.additionalProperties, false);
  assert.deepEqual(classifyItem.required, [
    'nodeId', 'collectionId', 'collectionTitle', 'title', 'url', 'host', 'etag', 'createdAt', 'suggestions',
  ]);
  assert.equal(Object.hasOwn(classifyItem.properties as UnknownRecord, 'revision'), false);
  const classifySuggestion = document.components.schemas.ClassifyInboxSuggestion as UnknownRecord;
  assert.equal(classifySuggestion.additionalProperties, false);
  assert.deepEqual(classifySuggestion.required, [
    'suggestionId', 'folderId', 'folderTitle', 'score', 'reason', 'kind',
  ]);
  const scoreSchema = (classifySuggestion.properties as UnknownRecord).score as UnknownRecord;
  assert.equal(scoreSchema.minimum, 0);
  assert.equal(scoreSchema.maximum, 100);
  assert.match(String(scoreSchema.description), /Jaccard/u);
  const kindSchema = document.components.schemas.ClassifyInboxSuggestionKind as UnknownRecord;
  assert.deepEqual(kindSchema.enum, ['existing']);
  const classifyLimit = document.components.parameters.ClassifyInboxLimit as UnknownRecord;
  assert.equal((classifyLimit.schema as UnknownRecord).maximum, 50);
  assert.equal((classifyLimit.schema as UnknownRecord).default, 20);
});
