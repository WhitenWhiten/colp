import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P5-31 gate doc section 15 is a rollback/stop runbook that keeps email independent of Phase 5', async () => {
  const gate = await readFile(new URL('../../../docs/11-phase5-email-delivery-gate.md', import.meta.url), 'utf8');
  const section15 = gate.slice(gate.indexOf('## 15.'));
  for (const required of [
    'stop-sending', 'KNOWN_FEATURE_EMAIL', 'drain', 'dead-letter', 'dead_letter',
    'P5-28', 'P5-29', 'P5-30', 'rollback', 'suppression', 'callback',
    'UnblockRecipient', 'independent', 'COLP Profile', 'no Phase 5 status change',
    'phase5Verified', 'marketing automation', 'Billing email', 'Deployment-proven',
    'probe:email-capability', 'evidence:phase5:email', 'email capability independent',
  ]) {
    assert.match(section15, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), required);
  }
});

test('P5-31 ops runbook binds the callback route, suppression ops, metrics and probe to production surfaces', async () => {
  const [runbook, callbackRoutes, opsRoutes, opsCli, probe] = await Promise.all([
    readFile(new URL('../../../docs/runbooks/email-delivery-operations.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/transport/product/email-callback-routes.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/transport/product/email-ops-routes.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/email-suppression-ops.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/email-capability-probe.ts', import.meta.url), 'utf8'),
  ]);
  for (const token of ['/api/v1/email/callbacks/delivery', 'EventBridge', 'X-Known-DM-',
    'verifyCallback', 'reconcileCallback', '202', 'idempotent', 'EMAIL_OPS_TOKEN',
    'recipientAccountId', 'never emails', 'resubscribe', 'UnblockRecipient',
    'notifications.email_delivery.enabled', 'notifications.email_delivery.probe.status',
    'probe:email-capability', 'Deployment-proven', 'marketing', 'Billing']) {
    assert.match(runbook, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
  // N14: the runbook must document the exactly-once semantics added by the
  // hardening rounds - the REQUIRED Content-MD5 on legacy MNS pushes and the
  // delivered-callback authority (dead_letter re-arm + delivered-confirmed
  // marker) that makes a verified delivered callback never re-send.
  for (const token of ['Content-MD5', 'missing_content_md5', 're-arm', 'delivered-confirmed marker',
    're-send']) {
    assert.match(runbook, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
  assert.match(callbackRoutes, /registerEmailCallbackRoutes/u);
  assert.match(callbackRoutes, /verifyCallback/u);
  assert.match(callbackRoutes, /reconcile/u);
  assert.match(callbackRoutes, /\/api\/v1\/email\/callbacks\/delivery/u);
  assert.match(callbackRoutes, /202/u);
  assert.match(callbackRoutes, /EmailCallbackRejectedError/u);
  assert.match(opsRoutes, /registerEmailOpsRoutes/u);
  assert.match(opsRoutes, /EMAIL_OPS_TOKEN|opsToken/u);
  assert.match(opsRoutes, /listEmailSuppressionFacts|listSuppressionFacts/u);
  assert.match(opsRoutes, /clearEmailSuppressionFact|clearSuppressionFact/u);
  assert.match(opsCli, /list/u);
  assert.match(opsCli, /clear/u);
  assert.match(opsCli, /EMAIL_OPS_TOKEN/u);
  assert.match(opsCli, /createPostgresEmailSuppressionOpsRepository/u);
  assert.match(probe, /runEmailCapabilityProbe/u);
  assert.match(probe, /suppressionTablePresent|notification_email_suppressions/u);
  assert.match(probe, /deploymentProven/u);
  assert.doesNotMatch(probe, /Deployment-proven[\s\S]{0,80}true/iu);
});

test('P5-31 evidence doc states fixture evidence is not target-passing and documents replay commands', async () => {
  const doc = await readFile(new URL('../../../docs/evidence/phase5-email-acceptance-2026-08-02.md', import.meta.url), 'utf8');
  for (const token of ['NOT target-passing evidence', 'controlled DirectMail fixture', 'not an SMTP mock',
    'RPC protocol', 'EMAIL_DM_TARGET_ATTESTATION', 'credentials not provisioned',
    'fixtureReplayDigest', 'sourceBoundOnly', 'evidence:phase5:email', 'KNOWN_PHASE5_EVIDENCE_ROOT',
    'p5-31/phase5-email-acceptance.json', 'probe:email-capability', 'test:phase5:email-acceptance:contract',
    'P5-28', 'P5-29', 'P5-30', 'rollback', 'stop-sending']) {
    assert.match(doc, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
});
