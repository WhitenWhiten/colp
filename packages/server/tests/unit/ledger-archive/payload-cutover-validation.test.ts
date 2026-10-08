import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';

import { validatePayloadArchiveRowForCutover } from '../../../src/infrastructure/ledger-archive/payload-cold-sources.js';

test('cutover validation exercises the production audit payload parser', () => {
  const canonicalJson = '{"action":"read-back"}';
  const createdAt = '2026-08-30T00:00:00.000Z';
  assert.doesNotThrow(() => validatePayloadArchiveRowForCutover('audit_payload', {
    key: 7n,
    value: {
      kind: 'audit-payload-v1', eventId: '7', operationId: null,
      collectionId: null, principalId: 'operator', eventType: 'archive.cutover',
      createdAt,
      payloadDigest: `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`,
      payloadBytes: String(Buffer.byteLength(canonicalJson)), payloadSchemaVersion: 1,
      payloadBucketLocator: 'hot://audit_event_payloads/7', canonicalJson,
    },
  }, 'global'));
  assert.throws(() => validatePayloadArchiveRowForCutover('audit_payload', {
    key: 8n, value: { kind: 'audit-payload-v1', eventId: '7' },
  }, 'global'));
});

test('social Outbox cutover remains generic full-archive verification only', () => {
  assert.doesNotThrow(() => validatePayloadArchiveRowForCutover('outbox_social', {
    key: 1n, value: { deliberately: 'opaque-to-online-cold-readers' },
  }, 'aggregate:test'));
  assert.throws(() => validatePayloadArchiveRowForCutover('unknown_family', {
    key: 1n, value: {},
  }, 'unknown'));
});
