/**
 * P4A-P10 recovery runbook contract (plan §9 P10 item 7). Pins the fixed
 * recovery order, the stop-issuance / drain / reconcile / rotation / rollback
 * command surface, the bounded-resource rules and the prohibitions of
 * `docs/runbooks/attachments-recovery-operations.md` — without running any
 * real scenario (the rehearsal itself runs in the P10 integration suites and
 * the evidence CLI on a clean retained revision).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  ATTACHMENTS_RECOVERY_STEPS,
} from '../../../src/modules/attachments/index.js';

const RUNBOOK = new URL('../../../docs/runbooks/attachments-recovery-operations.md', import.meta.url);

const REQUIRED_TOKENS = [
  // Fixed recovery order (must mirror the sealed step list).
  'secret/control', 'PostgreSQL', 'R2 reconcile', 'Redis limiter', 'Worker', 'isolated origin', 'admission',
  // Stop issuance + limiter rollback.
  'ATTACHMENTS_RATE_LIMIT_MODE=off', '停止签发', 'issue', 'download',
  // Drain / resume / graceful close.
  'drain', 'resume', 'graceful close', 'stopAdmissionAndDrain', 'resumeAdmission',
  // Reconcile unknown.
  'reconcile', 'unknown', 'per_exact_key_head', 'quarantine',
  // Credential / ACL rotation.
  'rotateAttachmentCredentials', 'old_credential_still_accepted', 'ACL', 'verifyOldCredentialRejected',
  // Rollback + bounded resources.
  '回滚', 'bounded', '有界',
];

test('the recovery runbook carries the fixed recovery order and the P10 command surface', async () => {
  const doc = await readFile(RUNBOOK, 'utf8');
  for (const token of REQUIRED_TOKENS) {
    assert.match(doc, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
  // The fixed recovery order in the doc must be exactly the sealed sequence.
  const order = ATTACHMENTS_RECOVERY_STEPS.join(' ');
  assert.match(doc, new RegExp(order.replace(/_/gu, '[_ -]'), 'iu'), 'the sealed recovery order appears verbatim');
});

test('the recovery runbook forbids destructive cleanup and never contains real secret samples', async () => {
  const doc = await readFile(RUNBOOK, 'utf8');
  for (const forbidden of ['FLUSHDB', 'FLUSHALL', 'KEYS *', 'SCAN 0', 'TRUNCATE', 'delete from upload_intents',
    'drop schema', 'DELETE FROM blob_generations']) {
    assert.doesNotMatch(doc, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), forbidden);
  }
  assert.doesNotMatch(doc, /redis:\/\/[^<\s]+:[^<\s]+@/iu);
  assert.doesNotMatch(doc, /Bearer\s+[A-Za-z0-9._-]{12,}/iu);
  assert.doesNotMatch(doc, /AKIA[A-Z0-9]{16}/iu);
  assert.doesNotMatch(doc, /password\s*=\s*[A-Za-z0-9]{8,}/iu);
});

test('the recovery runbook marks multi-instance limiter-off as a short incident mode and keeps resources bounded', async () => {
  const doc = await readFile(RUNBOOK, 'utf8');
  assert.match(doc, /多实例[^。\n]{0,80}(告警|WAF|缩|incident)/iu);
  assert.match(doc, /短时|short[- ]term|incident/iu);
  assert.match(doc, /(?:有界|bounded)[^。\n]{0,80}/iu);
  // The runbook must point at the rehearsal entry points.
  assert.match(doc, /test:phase4a:p10/u);
  assert.match(doc, /evidence:phase4a-p10-recovery/u);
  assert.match(doc, /local:phase4a-r2:run -- p10 confirm-real-r2/u);
});

test('the recovery runbook documents the alert contract: sustained windows and maintenance suppression never delete events', async () => {
  const doc = await readFile(RUNBOOK, 'utf8');
  assert.match(doc, /sustained|持续窗口/iu);
  assert.match(doc, /underlyingFiring/u);
  assert.match(doc, /suppressed/u);
  assert.doesNotMatch(doc, /maintenance[^。\n]{0,60}(delete|删除|erase)/iu,
    'suppression must never be documented as deleting events');
});
