import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  LEDGER_RETENTION_POLICIES,
  createLedgerRetentionEvidence,
} from '../../../src/infrastructure/database/ledger-retention-policy.js';

const purgeMigration = readFileSync(new URL(
  '../../../migrations/202610010800_ledger_payload_purge_jobs.ts', import.meta.url), 'utf8');

function policy(tableName: string) {
  const found = LEDGER_RETENTION_POLICIES.find((item) => item.tableName === tableName);
  assert.ok(found, `missing retention policy for ${tableName}`);
  return found;
}

test('append-only ledger authority stays archive-gated and fail-closed', () => {
  assert.equal(policy('operations').policyStatus, 'correctness_blocked');
  assert.equal(policy('operation_payloads').policyStatus, 'development_authorized');
  assert.equal(policy('audit_events').policyStatus, 'compliance_blocked');
  assert.equal(policy('outbox_events').policyStatus, 'development_authorized');
  assert.equal(policy('outbox_events').hotRetention.kind, 'scoped_minimum_days');
  assert.equal(policy('outbox_events').sourceDeletionAuthorized, false);
  assert.ok(LEDGER_RETENTION_POLICIES.every((item) => item.sourceDeletionAuthorized === false));
  assert.equal(createLedgerRetentionEvidence().deletionAuthorization.posture, 'fail_closed');

  // Dispatch claims are permanent identity facts, not capacity targets.
  assert.equal(LEDGER_RETENTION_POLICIES.some((item) => item.tableName === 'outbox_dispatch_claims'), false);
});

test('Outbox deletion cannot bypass the fenced payload purge job and role', () => {
  assert.match(purgeMigration, /outbox_events_delete_guard/u);
  assert.match(purgeMigration, /ledger_payload_purge_jobs/u);
  assert.match(purgeMigration, /known_outbox_payload_archiver/u);
  assert.match(purgeMigration, /ledger_payload_purge_authorized\('outbox_social'\)/u);
  assert.match(purgeMigration, /Outbox delete requires a fenced purge job/u);
});
