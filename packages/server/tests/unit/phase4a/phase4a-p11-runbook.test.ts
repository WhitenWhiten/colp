/**
 * P4A-P11 runbook / release-gates contract (plan §9 P11, §11 recommended
 * final release gate, §15 Definition of Done): pins the fixed command
 * surface of the Phase 4A final release, the delivery-contract document
 * (`docs/evidence/phase4a-owner-private.md`) that must carry every command
 * token (the validator replays it at schema level) and the prohibitions the
 * document must never violate (no credentials, no per-run secrets, no
 * success claims while the artifact is PENDING).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  P11_DEFAULT_EVIDENCE_OUTPUT,
  P11_EVIDENCE_DOC_PATH,
  P11_RUNBOOK_COMMANDS,
} from '../../../scripts/phase4a-owner-private-evidence.js';
import { checkRunbookCommands } from '../../../scripts/phase4a-owner-private-validate-evidence.mjs';

const DOC = new URL('../../../docs/evidence/phase4a-owner-private.md', import.meta.url);

test('the release-gate command surface is fixed and complete', () => {
  // The plan §11 recommended release gate in full, plus the P11 commands.
  const releaseGateCommands: readonly string[] = [
    'npm run test:phase4a:i16',
    'npm run evidence:phase4a-i16',
    'npm run evidence:phase4a-i16:validate',
    'npm run evidence:phase4a-redis-rate-limit',
    'npm run evidence:phase4a-redis-rate-limit:validate',
    'npm run evidence:phase4a-owner-private',
    'npm run evidence:phase4a-owner-private:validate',
    'npm run typecheck',
    'npm run lint',
    'npm run check:imports',
    'npm run build',
    'git diff --check',
    'npm run local:phase4a-r2:run -- p11 confirm-real-r2',
  ];
  for (const command of releaseGateCommands) {
    assert.ok((P11_RUNBOOK_COMMANDS as readonly string[]).includes(command), `missing release-gate command ${command}`);
  }
  assert.equal(P11_RUNBOOK_COMMANDS.length, 13);
  assert.equal(P11_DEFAULT_EVIDENCE_OUTPUT, 'docs/evidence/phase4a-owner-private.json');
  assert.equal(P11_EVIDENCE_DOC_PATH, 'docs/evidence/phase4a-owner-private.md');
});

test('the delivery-contract document replays every command token (validator contract)', async () => {
  const doc = await readFile(DOC, 'utf8');
  const missing = checkRunbookCommands(doc);
  assert.equal(missing, null, `the delivery-contract document must carry every command token; missing: ${missing?.join(', ')}`);
  // The validator's replay must accept the document as-is.
  assert.equal(checkRunbookCommands(doc)?.length ?? 0, 0);
});

test('the delivery-contract document is an AUDIT RECORD that never regresses to PENDING', async () => {
  const doc = await readFile(DOC, 'utf8');
  assert.match(doc, /状态：\*\*AUDIT RECORD/u, 'the document must declare the AUDIT RECORD status');
  assert.doesNotMatch(doc, /状态：\*\*PENDING|\*\*PENDING\*\*/u,
    'the owner-private PENDING / status-table Verified contradiction must stay eliminated');
  assert.match(doc, /不证明当前 HEAD/u,
    'the document must state the historical run does not prove current HEAD');
  assert.match(doc, /Verified/u, 'the document must name the Phase 4A Verified target');
  assert.match(doc, /Deployment-proven/u, 'the document must explicitly distinguish Verified from Deployment-proven');
  // Prohibitions: no credential/secret samples, no per-run prefix, no
  // concrete accepted-run facts (run ids) while the document stays an
  // audit record rather than a current acceptance claim.
  assert.ok(!/(P4A_R2_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|known\/[a-z]+\/r2\/rw)/u.test(doc),
    'the document must never carry credential names or secret references');
  assert.ok(!/capability-probes\/local-/u.test(doc), 'the document must not embed a concrete run prefix');
  assert.ok(!/runId\s*[:=]\s*[0-9a-f-]{20,}/u.test(doc), 'the document must not embed a concrete run id');
});

test('the Phase 4A status document is Verified after the V4A-08 current-revision seal', async () => {
  const statusDoc = await readFile(new URL('../../../docs/09-phase-execution-status.md', import.meta.url), 'utf8');
  const row = statusDoc.split(/\r?\n/u).find((line) => line.startsWith('| Phase 4A：')) ?? '';
  assert.ok(row, 'Phase 4A canonical status row');
  assert.match(row, /\*\*Verified\*\*/u);
  assert.match(row, /P11/u);
  assert.match(row, /不证明当前 HEAD/u);
  assert.match(row, /V4A-08/u);
  assert.match(row, /deploymentProven=false/u);
  assert.doesNotMatch(row, /\*\*Implemented \/ Awaiting current-revision acceptance\*\*/u);
});
