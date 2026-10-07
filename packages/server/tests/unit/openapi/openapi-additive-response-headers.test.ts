import { expect, test } from 'vitest';
import { findBreakingChanges } from '../../../scripts/check-openapi-breaking.mjs';

const etag = { schema: { type: 'string' } };
const binding = { required: false, schema: { type: 'string' } };
function document(headers?: Record<string, unknown>) {
  return { paths: { '/preferences': { get: { operationId: 'getPreferences',
    responses: { '200': { description: 'Preferences', ...(headers ? { headers } : {}) } } } } } };
}

test('an explicitly optional response header is additive with or without existing headers', () => {
  expect(findBreakingChanges(document(), document({ 'Known-Bookmark-Session': binding }))).toEqual([]);
  expect(findBreakingChanges(document({ ETag: etag }), document({ ETag: etag, 'Known-Bookmark-Session': binding }))).toEqual([]);
});

test('a response header with omitted required uses the OpenAPI optional default', () => {
  expect(findBreakingChanges(document(), document({ 'X-Request-Id': etag }))).toEqual([]);
  expect(findBreakingChanges(document({ ETag: etag }),
    document({ ETag: etag, 'X-Request-Id': etag }))).toEqual([]);
});

test('adding an optional response header cannot hide removed or changed existing headers', () => {
  expect(findBreakingChanges(document({ ETag: etag }), document({ 'Known-Bookmark-Session': binding }))).not.toEqual([]);
  expect(findBreakingChanges(document({ ETag: etag }), document({ ETag: { schema: { type: 'integer' } },
    'Known-Bookmark-Session': binding }))).not.toEqual([]);
});

test('required response headers and requiredness changes remain incompatible', () => {
  expect(findBreakingChanges(document(), document({ Binding: { ...binding, required: true } }))).not.toEqual([]);
  expect(findBreakingChanges(document({ Binding: binding }),
    document({ Binding: { ...binding, required: true } }))).not.toEqual([]);
});
