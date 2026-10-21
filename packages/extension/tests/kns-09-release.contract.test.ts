/**
 * Owner: KNS-09 (Release). Fixture: docs/kns-09-runbook.md.
 * Run: npx vitest run tests/kns-09-release.contract.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 *
 * Static release-gate pin (allowlisted in tests/static-anchor-allowlist.ts): the npm
 * scripts, workflow jobs and runbook text are the artifacts under test, and the
 * receipt/manifest generators are consumed by CI rather than by an importable entry.
 * Schema behaviour is separately covered by tests/schema-v15.test.ts and
 * tests/kns-09-release.test.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { KNS09_METRICS, KNS09_MUTATION_STORAGE_KEY, KNS09_SCHEMA_VERSION, KNS09_STOP_METRICS,
} from '../src/kns-09-release.js';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');

describe('KNS-09 AC-10 release gate contract', () => {
  test('pins CI jobs for typecheck, lint, source-size, COLP, backend, and target E2E', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const extensionCi = readFileSync(resolve(repositoryRoot, '.github/workflows/colp-ci.yml'), 'utf8');
    assert.match(pkg.scripts?.typecheck ?? '', /tsc/);
    assert.match(pkg.scripts?.lint ?? '', /eslint/);
    assert.match(pkg.scripts?.['check:source-size'] ?? '', /check-source-file-sizes/);
    assert.match(pkg.scripts?.['evidence:first-run-sync'] ?? '', /mv3-first-run-sync|first-run-sync:inner/);
    assert.match(pkg.scripts?.['evidence:trash-restore'] ?? '', /trash-restore/);
    assert.match(pkg.scripts?.['kns-09:contracts'] ?? '', /kns-09-release/);
    assert.match(pkg.scripts?.['kns-09:manifest'] ?? '', /kns-09-release-manifest/);
    assert.match(pkg.scripts?.['kns-09:receipt'] ?? '', /kns-09-acceptance-receipt/);
    assert.match(pkg.scripts?.['evidence:kns-09-release'] ?? '', /kns-09:manifest/);
    assert.doesNotMatch(pkg.scripts?.['evidence:kns-09-release'] ?? '', /kns-09:receipt/);
    assert.match(extensionCi, /npm run typecheck && npm run lint && npm run check:source-size/);
    assert.match(extensionCi, /extension-kns-09-release:/);
    assert.match(extensionCi, /npm run evidence:kns-09-release/);
    assert.match(extensionCi, /- extension-kns-09-release/);
    assert.match(extensionCi, /extension-kns-09-e2e:/);
    assert.match(extensionCi, /- extension-kns-09-e2e/);
    assert.doesNotMatch(extensionCi, /kns-09-e2e:[\s\S]*workflow_dispatch/);
    assert.match(extensionCi, /npm run evidence:first-run-sync/);
    assert.match(extensionCi, /npm run evidence:trash-restore/);
    assert.match(extensionCi, /KNS09_E2E_RESULT/);
    assert.match(extensionCi, /run: npm run test:unit\n\s+working-directory: packages\/server/);
    assert.match(JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).dependencies['@know-n/colp'], /^\d+\.\d+\.\d+$/u);
  });

  test('runbook and pin refuse v9 rollback and personal fields', () => {
    const runbook = readFileSync(resolve(packageRoot, 'docs/kns-09-runbook.md'), 'utf8');
    const pin = readFileSync(resolve(packageRoot, 'docs/kns-09-release.md'), 'utf8');
    const schema = readFileSync(resolve(packageRoot, 'src/sync-state/schema.ts'), 'utf8');
    const controls = readFileSync(resolve(packageRoot, 'src/kns-09-release.ts'), 'utf8');
    for (const token of [
      'scopeKey', 'mountId', 'replicaId', 'opId', 'collectionHash', 'replicaHash',
      'known.kns09.mutations.v1', 'sync_paused', 'pause_mutations_and_drain',
      'do not install v9', 'evidence:first-run-sync', 'evidence:trash-restore',
      'restore_node', 'kns-09-rollback-drill.json',
    ]) {
      assert.match(runbook, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
    }
    // The disjunction made this vacuous: `DATABASE_VERSION` appears elsewhere in
    // the same document, so the pin could say `version **99**` and still pass. It
    // must name the version the release actually ships.
    assert.match(pin, /version \*\*20\*\*/u, 'the release pin must name schema v20');
    assert.doesNotMatch(pin, /version \*\*(?!20)\d+\*\*/u, 'no stale version pin may remain');
    assert.match(pin, /coordinator: false/);
    assert.match(schema, /DATABASE_VERSION = 21/);
    assert.equal(KNS09_SCHEMA_VERSION, 21);
    assert.equal(KNS09_MUTATION_STORAGE_KEY, 'known.kns09.mutations.v1');
    assert.match(controls, /do-not-install-older|keep-v20/);
    assert.doesNotMatch(`${runbook}\n${pin}`, /dashboard[^\n]*(?:https?:\/\/|title:)/iu);
    for (const name of [KNS09_METRICS.firstRun, KNS09_METRICS.queueBacklogAgeMs, KNS09_METRICS.pushReceiptLatencyMs,
      KNS09_METRICS.pullRecovery, KNS09_METRICS.duplicateCandidate, KNS09_METRICS.conflict,
      KNS09_METRICS.permissionRevoked, KNS09_METRICS.scopeReconcileFailure]) {
      assert.match(pin, new RegExp(name.replaceAll('.', '\\.')));
    }
    assert.match(pin, /kns09\.stop\.duplicate_node/);
    assert.equal(Object.keys(KNS09_STOP_METRICS).length, 6);
  });

  test('receipt and manifest pin schema 20 and consume machine gate results', () => {
    const manifest = readFileSync(resolve(packageRoot, 'scripts/kns-09-release-manifest.mjs'), 'utf8');
    const acceptance = readFileSync(resolve(packageRoot, 'scripts/kns-09-acceptance-receipt.mjs'), 'utf8');
    assert.match(manifest, /requireSchemaVersion\(schema, 20\)/);
    assert.match(acceptance, /requireSchemaVersion\(schema, 20\)/);
    assert.match(manifest, /golden-scenarios\.json/);
    assert.match(manifest, /rollbackToV9Binary: false/);
    assert.match(manifest, /verdict: 'manifest'/);
    assert.match(acceptance, /evaluateAcceptance/);
    assert.match(acceptance, /KNS09_GATE_RESULTS|gate-results\.json/);
    assert.doesNotMatch(`${manifest}\n${acceptance}`, /KNOWN_CI_WEBHOOK|webhook\.env/);
    assert.doesNotMatch(`${manifest}\n${acceptance}`, /version: 11|version: 13/);
  });
});
