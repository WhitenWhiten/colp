import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

import { LEDGER_CAPACITY_TARGETS } from '../../../src/infrastructure/database/ledger-capacity.js';
import {
  createLedgerAuthorityRegistry,
  LEDGER_ARCHIVE_SOURCE_RELATIONS,
  ledgerAuthorityRegistryDigest,
  OPERATION_ARCHIVE_RELATION,
  ORDINARY_PULL_CONTRACT,
} from '../../../src/infrastructure/ledger-archive/index.js';

const snapshotUrl = new URL('../../../generated/ledger-authority-registry.json', import.meta.url);

test('committed registry snapshot matches the typed authority and ordinary Pull contract', async () => {
  const registry = createLedgerAuthorityRegistry();
  const snapshot = JSON.parse(await readFile(snapshotUrl, 'utf8')) as {
    digest: string;
    registry: ReturnType<typeof createLedgerAuthorityRegistry>;
  };
  assert.equal(snapshot.digest, ledgerAuthorityRegistryDigest(registry));
  assert.deepEqual(snapshot.registry, JSON.parse(JSON.stringify(registry)));
  assert.equal(ORDINARY_PULL_CONTRACT.archiveFallback, false);
  assert.equal(OPERATION_ARCHIVE_RELATION, 'public.operation_payloads');
  assert.deepEqual(LEDGER_ARCHIVE_SOURCE_RELATIONS.map((item) => item.tableName).sort(), [
    'audit_event_payloads', 'operation_payloads', 'outbox_events',
  ]);
  assert.deepEqual(registry.capacity.map((item) => item.tableName),
    LEDGER_CAPACITY_TARGETS.map((item) => item.tableName));
});
