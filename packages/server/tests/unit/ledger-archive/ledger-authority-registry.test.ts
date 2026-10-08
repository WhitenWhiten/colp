import assert from 'node:assert/strict';
import { test } from 'vitest';

import { LEDGER_CAPACITY_TARGETS } from '../../../src/infrastructure/database/ledger-capacity.js';
import {
  createLedgerAuthorityRegistry,
  LEDGER_ARCHIVE_SOURCE_RELATIONS,
  ledgerAuthorityRegistryDigest,
  OPERATION_ARCHIVE_RELATION,
  ORDINARY_PULL_CONTRACT,
} from '../../../src/infrastructure/ledger-archive/index.js';

test('typed authority matches the ordinary Pull contract', () => {
  const registry = createLedgerAuthorityRegistry();
  assert.equal(typeof ledgerAuthorityRegistryDigest(registry), 'string');
  assert.equal(ORDINARY_PULL_CONTRACT.archiveFallback, false);
  assert.equal(OPERATION_ARCHIVE_RELATION, 'public.operation_payloads');
  assert.deepEqual(LEDGER_ARCHIVE_SOURCE_RELATIONS.map((item) => item.tableName).sort(), [
    'audit_event_payloads', 'operation_payloads', 'outbox_events',
  ]);
  assert.deepEqual(registry.capacity.map((item) => item.tableName),
    LEDGER_CAPACITY_TARGETS.map((item) => item.tableName));
});
