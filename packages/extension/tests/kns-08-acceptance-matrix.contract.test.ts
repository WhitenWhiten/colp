/**
 * KNS-08 acceptance map contract.
 * Owner: KNS-08 (QA). Fixture: e2e/kns-08-ids.ts.
 * Run: npx vitest run tests/kns-08-acceptance-matrix.contract.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 *
 * Static policy pin (allowlisted in tests/static-anchor-allowlist.ts): the artifact
 * under test is the acceptance map plus the e2e specs and their evidence commands.
 * The specs themselves cannot run in the host unit lane, so text is the only check
 * that the matrix still points at product-winning assertions and never at disabled
 * or quarantined tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  KNS_08_ACCEPTANCE_IDS, KNS_08_MATRIX_SCENARIOS, KNS_08_REQUIRED_ACS, KNS_09_REQUIRED_ACS,
} from '../e2e/kns-08-ids.js';
import { redactEvidenceText } from '../e2e/kns-08-redact.js';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');

describe('KNS-08 acceptance IDs and evidence harness', () => {
  test('covers AC-01…09 for KNS-00…07, 10, 11 without skip or baseline raise', () => {
    const acs = new Set(KNS_08_ACCEPTANCE_IDS.map((row) => row.ac));
    for (const ac of KNS_08_REQUIRED_ACS) assert.equal(acs.has(ac), true, ac);
    for (const ac of KNS_09_REQUIRED_ACS) assert.equal(acs.has(ac), true, ac);
    const owners = new Set(KNS_08_ACCEPTANCE_IDS.map((row) => row.kns));
    for (const kns of ['KNS-00', 'KNS-01', 'KNS-02', 'KNS-03', 'KNS-04', 'KNS-05', 'KNS-06', 'KNS-07', 'KNS-10', 'KNS-11', 'KNS-08', 'KNS-09']) {
      assert.equal(owners.has(kns), true, kns);
    }
    const ids = KNS_08_ACCEPTANCE_IDS.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const row of KNS_08_ACCEPTANCE_IDS) {
      const source = readFileSync(resolve(repositoryRoot, row.file), 'utf8');
      assert.match(source, /Owner:/u, `${row.file} Owner`);
      assert.match(source, /Fixture:/u, `${row.file} Fixture`);
      assert.match(source, /Run:/u, `${row.file} Run`);
      assert.match(source, /Evidence:/u, `${row.file} Evidence`);
      assert.doesNotMatch(source, /\.skip\(|test\.skip|it\.skip|xtest|xdescribe|quarantine/u, row.file);
    }
  });

  test('pins every matrix scenario to an e2e spec ID', () => {
    const e2e = KNS_08_ACCEPTANCE_IDS.filter((row) => row.layer === 'e2e').map((row) => row.id).join(' ');
    for (const scenario of KNS_08_MATRIX_SCENARIOS) {
      assert.match(e2e, new RegExp(scenario.replaceAll('-', '[-]')), scenario);
    }
  });

  test('evidence scripts match the existing with-postgres / xvfb / verify shape', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    for (const name of ['evidence:first-run-sync', 'evidence:trash-restore'] as const) {
      const outer = pkg.scripts?.[name] ?? '';
      const inner = pkg.scripts?.[`${name}:inner`] ?? '';
      assert.match(outer, /build -- --config config\/e2e-fixture\.json/);
      assert.match(outer, /with-postgres\.mjs/);
      assert.match(inner, /with-xvfb\.mjs npx playwright test/);
      assert.match(inner, /verify-release-artifact\.mjs dist\/production/);
      assert.match(inner, /verify-bookmark-privacy-artifacts\.mjs test-results/);
    }
    assert.match(pkg.scripts?.['evidence:first-run-sync:inner'] ?? '', /mv3-first-run-sync\.spec\.ts/);
    assert.match(pkg.scripts?.['evidence:trash-restore:inner'] ?? '', /mv3-trash-restore\.spec\.ts/);
  });

  test('first-run quiet does not treat rejected rows or mapping-only snapshot as settled', () => {
    const harness = readFileSync(resolve(packageRoot, 'e2e/kns-08-harness.ts'), 'utf8');
    const quietStart = harness.indexOf('function quietLabel');
    const quietNext = harness.indexOf('\nexport async function ', quietStart);
    assert.ok(quietStart >= 0 && quietNext > quietStart, 'quietLabel missing');
    const quiet = harness.slice(quietStart, quietNext);
    assert.match(harness, /LIVE_QUEUE = new Set\(\[[^\]]*['"]rejected['"]/u);
    assert.match(harness, /invalid_json/u);
    assert.match(harness, /invalid_document/u);
    assert.match(quiet, /hasFirstRunSettlementProof\(facts\)/u);
    assert.match(quiet, /hasDownloadPathSettlement\(facts\)/u);
    assert.match(quiet, /facts\.rejectedPending !== true/u);
    assert.match(quiet, /facts\.mappingCount > 0/u);
    assert.match(quiet, /facts\.recoveryFrozen !== true/u);
    assert.match(quiet, /bootstrapPhase === 'completed'/u);
    assert.match(quiet, /bootstrapPhase === 'needs_attention'/u);
    assert.match(quiet, /needs_attention' \? aligned : hasFirstRunSettlementProof/u);
    assert.doesNotMatch(quiet, /needs_attention' \|\| hasFirstRunSettlementProof/u);
    assert.match(quiet, /enginePhase === 'idle'\)\s*&& aligned/u);
    assert.match(harness, /expect\(facts\.cursor\)\.toBe\(facts\.ackedCursor\)/u);
    assert.match(harness, /expect\(facts\.pendingAckCount\)\.toBe\(0\)/u);
    assert.match(harness, /expect\(facts\.pendingCaptureCount\)\.toBe\(0\)/u);
    assert.match(harness, /drainBookmarkEventCaptureEvidence/u);
    assert.doesNotMatch(harness, /mappingCount > 0 \|\| facts\.receiptCount/u);
    assert.doesNotMatch(quiet, /mappingCount > 0 && \(facts\.receiptCount > 0/u);
    assert.doesNotMatch(quiet, /bootstrapPhase === 'syncing'/u);
  });

  test('AC-01 waits on product first-run handshake without harness resume or wake', () => {
    const spec = readFileSync(resolve(packageRoot, 'e2e/mv3-first-run-sync.spec.ts'), 'utf8');
    const harness = readFileSync(resolve(packageRoot, 'e2e/kns-08-harness.ts'), 'utf8');
    const ac01Start = spec.indexOf("test('KNS-08-AC-01");
    const ac01End = spec.indexOf("test('KNS-08-AC-02");
    assert.ok(ac01Start >= 0 && ac01End > ac01Start, 'AC-01 test block');
    const ac01 = spec.slice(ac01Start, ac01End);
    assert.match(ac01, /waitFirstRunProductQuiet/u);
    assert.match(ac01, /confirmPreview/u);
    assert.doesNotMatch(ac01, /waitQueueQuiet\s*\(/u);
    const ac02Start = spec.indexOf("test('KNS-08-AC-02 nested");
    const ac02End = spec.indexOf("test('KNS-08-AC-03/06");
    assert.ok(ac02Start >= 0 && ac02End > ac02Start, 'AC-02 nested test block');
    const ac02 = spec.slice(ac02Start, ac02End);
    assert.match(ac02, /waitFirstRunProductQuiet/u);
    assert.doesNotMatch(ac02, /waitQueueQuiet\s*\(/u);
    const helperStart = harness.indexOf('export async function waitFirstRunProductQuiet');
    assert.ok(helperStart >= 0, 'waitFirstRunProductQuiet missing');
    const helperNext = harness.indexOf('\nexport async function ', helperStart + 1);
    const helper = helperNext === -1 ? harness.slice(helperStart) : harness.slice(helperStart, helperNext);
    assert.match(helper, /quietLabel\([^,]+,\s*true\)/u);
    assert.match(helper, /known\.firstRun\.status/u);
    assert.doesNotMatch(helper, /resumeFirstRun/u);
    assert.doesNotMatch(helper, /wakeOutboundPushEvidence/u);
    assert.doesNotMatch(helper, /wakeEngine/u);
  });

  test('A/B merge, lost-push, and field-conflict specs pin product winners', () => {
    const spec = readFileSync(resolve(packageRoot, 'e2e/mv3-first-run-sync.spec.ts'), 'utf8');
    const harness = readFileSync(resolve(packageRoot, 'e2e/kns-08-harness.ts'), 'utf8');
    const mergeStart = spec.indexOf("test('KNS-08-AC-03/06");
    const lostStart = spec.indexOf("test('KNS-08-AC-04/05/09");
    const conflictStart = spec.indexOf("test('KNS-08-AC-04/06");
    assert.ok(mergeStart >= 0 && lostStart > mergeStart && conflictStart > lostStart, 'first-run test blocks');
    const merge = spec.slice(mergeStart, lostStart);
    const lost = spec.slice(lostStart, conflictStart);
    const conflict = spec.slice(conflictStart);
    assert.match(merge, /liveTitles\(stack\)/u);
    assert.match(merge, /filter\(\(title\) => title === 'KNS08 shared'\)\.length\)\.toBeGreaterThanOrEqual\(2\)/u);
    assert.match(merge, /\['completed', 'needs_attention'\]/u);
    assert.doesNotMatch(merge, /['"]syncing['"]/u);
    assert.match(merge, /assertQueueTerminal\(factsA\)/u);
    assert.match(merge, /assertQueueTerminal\(factsB\)/u);
    assert.match(merge, /waitFirstRunProductQuiet\(pageA, stack, bindingA\)/u);
    assert.match(merge, /waitFirstRunProductQuiet\(pageB, stack, bindingB\)/u);
    assert.doesNotMatch(merge, /waitQueueQuiet\s*\(/u);
    assert.match(merge, /chromeA\)\.toContain\('KNS08 only A'\)/u);
    assert.match(merge, /chromeA\)\.toContain\('KNS08 only B'\)/u);
    assert.match(merge, /chromeB\)\.toContain\('KNS08 only A'\)/u);
    assert.match(merge, /chromeB\)\.toContain\('KNS08 only B'\)/u);
    const lostFirstA = lost.indexOf('confirmFirstRun(pageA');
    const lostOffline = lost.indexOf('setOffline(true)');
    assert.ok(lostFirstA >= 0 && lostOffline > lostFirstA, 'AC-04 first-run wait slice');
    const lostFirstRun = lost.slice(lostFirstA, lostOffline);
    assert.match(lostFirstRun, /waitFirstRunProductQuiet\(pageA, stack, bindingA\)/u);
    assert.match(lostFirstRun, /waitFirstRunProductQuiet\(pageB, stack, bindingB\)/u);
    assert.doesNotMatch(lostFirstRun, /waitQueueQuiet\s*\(/u);
    assert.match(lost, /waitQueueQuiet\(pageA, stack, bindingA, 90_000\)/u);
    const conflictFirstA = conflict.indexOf('confirmFirstRun(pageA');
    const conflictWake = conflict.indexOf("waitTitles(pageB, ['KNS08 conflict'");
    assert.ok(conflictFirstA >= 0 && conflictWake > conflictFirstA, 'AC-04/06 first-run wait slice');
    const conflictFirstRun = conflict.slice(conflictFirstA, conflictWake);
    assert.match(conflictFirstRun, /waitFirstRunProductQuiet\(pageA, stack, bindingA\)/u);
    assert.match(conflictFirstRun, /waitFirstRunProductQuiet\(pageB, stack, bindingB\)/u);
    assert.doesNotMatch(conflictFirstRun, /waitQueueQuiet\s*\(/u);
    // Conflict convergence, move write settlement, then move propagation each
    // have a bounded wait; the write barrier must check both real queues.
    assert.equal((conflict.match(/\.toPass\(\{ timeout: 90_000 \}\)/gu) ?? []).length, 3);
    assert.match(conflict, /assertQueueTerminal\(await scopeFacts\(pageA, stack, bindingA\)\)/u);
    assert.match(conflict, /assertQueueTerminal\(await scopeFacts\(pageB, stack, bindingB\)\)/u);
    assert.match(conflict, /canonicalPlacement\(stack, conflictNodeId\)/u);
    assert.match(conflict, /canonical\.title\)\.toBe\(forkA\.title\)/u);
    assert.match(conflict, /movedA\.parentTitle\)\.toBe\(canonical\.parentTitle\)/u);
    assert.equal((conflict.match(/waitNonterminalQueue\(pageA, stack, bindingA\)/gu) ?? []).length, 1);
    assert.equal((conflict.match(/waitNonterminalQueue\(pageB, stack, bindingB\)/gu) ?? []).length, 1);
    assert.match(conflict, /captureStates\.includes\('move:pending'\)/u);
    assert.match(conflict, /queueTypes\.includes\('move_node'\)/u);
    assert.match(lost, /assertPushEnvelopeReused\(digestsBeforeLost, lost\.pushRequestDigests\)/u);
    assert.doesNotMatch(lost, /new Set\([^)]*pushRequestDigests[^)]*\)\.size\)\.toBeGreaterThan\(0\)/u);
    assert.match(lost, /filter\(\(title\) => title === 'KNS08 lost push'\)\)\.toHaveLength\(1\)/u);
    assert.match(lost, /waitTitles\(pageB2, \['KNS08 lost push'\]\)/u);
    assert.match(lost, /factsB\.mappingCount\)\.toBeGreaterThan\(0\)/u);
    assert.match(lost, /factsB\.cursor\)\.not\.toBeNull\(\)/u);
    assert.match(lost, /revoked\.mappingCount\)\.toBe\(beforeRevoke\.mappingCount\)/u);
    assert.match(lost, /revoked\.queueOpIds/u);
    assert.match(lost, /beforeRevoke\.queueOpIds/u);
    assert.doesNotMatch(lost, /queueStatuses\.length >= beforeRevoke\.queueStatuses\.length \|\| revoked\.receiptCount > 0/u);
    assert.match(conflict, /bookmarkPlacement\(pageA, 'KNS08 conflict'\)/u);
    assert.match(conflict, /bookmarkPlacement\(pageB, 'KNS08 conflict'\)/u);
    assert.match(conflict, /\['KNS08 conflict A', 'KNS08 conflict B'\]/u);
    assert.match(conflict, /movedA\.parentTitle\)\.toBe\(movedB\.parentTitle\)/u);
    assert.match(conflict, /\['KNS08 move folder', 'KNS08 move folder B'\]/u);
    assert.match(conflict, /assertQueueTerminal\(factsA\)/u);
    assert.match(conflict, /assertQueueTerminal\(factsB\)/u);
    assert.match(harness, /export async function bookmarkPlacement/u);
    assert.match(harness, /export function assertQueueTerminal/u);
    assert.match(harness, /export async function liveTitles/u);
    assert.match(harness, /export function assertPushEnvelopeReused/u);
  });

  test('parent-delete restore requires Recovered parentTitle and forbids recovered-title disjunction', () => {
    const spec = readFileSync(resolve(packageRoot, 'e2e/mv3-trash-restore.spec.ts'), 'utf8');
    const parentStart = spec.indexOf("test('KNS-08-AC-07 parent delete");
    const restoreStart = spec.indexOf("test('KNS-08-AC-07 delete restores");
    assert.ok(parentStart >= 0 && restoreStart >= 0 && parentStart > restoreStart, 'parent-delete test block');
    const parent = spec.slice(parentStart);
    assert.doesNotMatch(parent, /\|\|[^\n]*\/recovered\/i/u);
    assert.match(parent, /waitTitles\(pageA, \['Recovered', 'KNS08 orphan child'\]\)/u);
    assert.match(parent, /bookmarkPlacement\(pageA, 'KNS08 orphan child'\)/u);
    assert.match(parent, /parentTitle\)\.toBe\('Recovered'\)/u);
    assert.match(parent, /waitTitles\(pageB, \['KNS08 orphan child'\]\)/u);
    assert.match(parent, /hasBrowserTrashFolder\(\(await treeProjection\(pageA\)\)\.titles\)\)\.toBe\(false\)/u);
    assert.match(parent, /hasBrowserTrashFolder\(\(await treeProjection\(pageB\)\)\.titles\)\)\.toBe\(false\)/u);
    assert.match(parent, /bookmarkPlacement\(pageB, 'KNS08 orphan child'\)/u);
    assert.match(parent, /assertQueueTerminal\(factsA\)/u);
    assert.match(parent, /assertQueueTerminal\(factsB\)/u);
  });

  test('split-mount restore pins unmounted mapping on A and Recovered under other on B', () => {
    const spec = readFileSync(resolve(packageRoot, 'e2e/mv3-trash-restore.spec.ts'), 'utf8');
    const splitStart = spec.indexOf("test('FRR-05 split-mount restore");
    const productStart = spec.indexOf("test('P1-03 Product trash");
    assert.ok(splitStart >= 0 && productStart > splitStart, 'split-mount test block');
    const split = spec.slice(splitStart, productStart);
    assert.match(split, /unmounted:/u);
    assert.match(split, /bookmarkPlacement\(pageB, 'KNS08 other orphan'\)/u);
    assert.match(split, /parentTitle\)\.toBe\('Recovered'\)/u);
    assert.match(split, /rootsB\.otherTitle/u);
    assert.match(split, /title === 'Recovered'\)\)\.toBe\(false\)/u);
    assert.match(split, /waitTitles\(pageB, \['Recovered', 'KNS08 other orphan'\]\)/u);
  });

  test('redacts URL, token, email, and user-shaped identifiers from evidence text', () => {
    const raw = [
      'https://example.test/secret-title', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.e30',
      '__Host-known_session=abc.def', 'p3-27-extension@example.test',
      'user-11111111-2222-3333-4444-555555555555',
    ].join('\n');
    const redacted = redactEvidenceText(raw, ['secret-title']);
    assert.doesNotMatch(redacted, /https:\/\//u);
    assert.doesNotMatch(redacted, /eyJ/u);
    assert.doesNotMatch(redacted, /abc\.def/u);
    assert.doesNotMatch(redacted, /p3-27-extension@/u);
    assert.doesNotMatch(redacted, /11111111-2222-3333-4444/u);
  });
});
