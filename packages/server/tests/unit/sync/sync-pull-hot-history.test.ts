import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

import { SyncPullReadError } from '../../../src/modules/sync/index.js';
import { resolveHotPullOperationRow } from '../../../src/infrastructure/sync/postgres/sync-operation-payload-reader.js';

test('hot Pull rows stay hot and archived or missing payloads fail closed without a cold source', () => {
  const hot = resolveHotPullOperationRow({
    commit_ordinal: 2n, stream_kind: 0, stable_id: 'op-2', payload: { opId: 'op-2' },
    effect: null, effect_operation_id: null, effect_collection_id: null, effect_replica_id: null,
    effect_sequence: null, effect_commit_ordinal: null, effect_protocol_version: null,
    effect_terminal_status: null, operation_digest: null, effect_digest: null,
    payload_source: 'hot', payload_locator: 'operation_payloads/2026-08-01/op-2',
    payload_digest_sha256: 'abc', payload_bytes: 4n, payload_schema_version: 1,
    payload_bucket: '2026-08-01', sync_wire_present: true,
    actual_payload_digest: 'abc', actual_payload_bytes: 4n,
  });
  assert.equal(hot.payload_source, 'hot');
  assert.throws(() => resolveHotPullOperationRow({
    ...hot, payload_source: 'archive', payload: null, actual_payload_digest: null,
  }), (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
  assert.throws(() => resolveHotPullOperationRow({
    ...hot, payload: null,
  }), (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
});

test('Pull composition never accepts a historical payload port', async () => {
  const pullCluster = [
    '../../../src/infrastructure/sync/postgres/sync-pull-postgres.ts',
    '../../../src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts',
    '../../../src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts',
    '../../../src/infrastructure/sync/postgres/sync-pull-recovery-postgres.ts',
  ];
  const [reader, pull] = await Promise.all([
    readFile(new URL(
      '../../../src/infrastructure/sync/postgres/sync-operation-payload-reader.ts', import.meta.url,
    ), 'utf8'),
    Promise.all(pullCluster.map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
      .then((parts) => parts.join('\n')),
  ]);
  assert.match(reader, /resolveHotPullOperationRow/u);
  assert.doesNotMatch(reader, /HistoricalOperationPayloadPort|archiveSource/u);
  assert.doesNotMatch(pull, /operationPayloadSource|HistoricalOperationPayloadPort/u);
});
