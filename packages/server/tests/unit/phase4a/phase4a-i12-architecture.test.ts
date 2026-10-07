/**
 * P4A-I12 architecture / contract suite (updated by P4A-R06).
 *
 * Proves at source level (import-resolution based, not string matching) that:
 * - NO production shared consumer (publication/sync/mcp/search/social/publisher
 *   module or their infrastructure adapters) reaches any `src/modules/attachments/**`
 *   file EXCEPT through the approved eligibility-port shape: exactly the gate
 *   symbols imported from the attachments facade;
 * - the ONLY approved dependency shape is a consumer importing exactly the
 *   eligibility gate (assessment functions + gate types/facts port) from the
 *   attachments facade (anti-false-negative: the rule is not so wide it blocks
 *   a legitimate policy dependency);
 * - P4A-R06: production consumers (publication snapshot, MCP
 *   collection resources, search query) DO depend on the approved gate port —
 *   the scanner reports each as `approved: true` — and a future consumer that
 *   bypasses the gate — importing the facade for a non-approved surface, or
 *   the repository port directly — still fails the scan;
 * - FIX-L-033 (SYNC-R17): the Sync domain no longer imports attachments at
 *   all — it defines the minimal `AttachmentExposurePolicyPort` and the
 *   exposure-eligibility gate is mapped onto it by the composition adapter
 *   (infrastructure/database + bootstrap). The scan therefore reports ZERO
 *   sync edges and the boundary-checker module edges below pin that absence;
 * - the boundary-checker module edges are pinned: publication/mcp/search
 *   consumers hold the controlled `attachments` gate edge (symbol-gated by
 *   the embedded allowlist and by this suite), while the attachments module
 *   itself keeps exactly its owner edges (`access-policy`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  I12_APPROVED_GATE_SYMBOLS,
  scanSharedConsumerAttachmentsEdges,
} from '../../../scripts/evidence/phase4a-i12-architecture.js';
import {
  assessSharedExposureEligibility,
  assessSharedExposureScope,
  assertSharedExposureIneligible,
  assertSharedExposureScopeIneligible,
} from '../../../src/modules/attachments/index.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SOURCE_ROOT = resolve(REPO_ROOT, 'src');
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests', 'fixtures', 'phase4a-i12');

function fixture(name: string): string {
  return resolve(FIXTURE_DIR, name);
}

describe('P4A-I12 architecture scan over the production composition', () => {
  test('every production shared consumer attachments edge is an approved eligibility-port dependency', () => {
    const result = scanSharedConsumerAttachmentsEdges({ sourceRoot: SOURCE_ROOT });
    assert.deepEqual(result.violations, [], 'production consumers must have zero unapproved attachments edges');
    assert.ok(result.dependencies.length >= 3,
      `production consumers must depend on the gate (publication/mcp/search); got ${result.dependencies.length}`);
    for (const dependency of result.dependencies) {
      assert.equal(dependency.approved, true, `${dependency.source} must be an approved gate dependency`);
      assert.ok(dependency.facadeSymbols.length > 0, `${dependency.source} must import gate symbols`);
      for (const symbol of dependency.facadeSymbols) {
        assert.ok(I12_APPROVED_GATE_SYMBOLS.includes(symbol),
          `${dependency.source} must import only approved gate symbols (got ${symbol})`);
      }
    }
    const sources = result.dependencies.map((dependency) => dependency.source);
    assert.ok(sources.includes('modules/publication/application/snapshot-query.ts'),
      'publication snapshot-query must depend on the gate');
    assert.ok(sources.includes('modules/mcp/collection-resources.ts'),
      'mcp collection resources must depend on the gate');
    assert.ok(sources.includes('modules/search/application/search-query.ts'),
      'search query must depend on the gate');
    assert.ok(!sources.some((source) => source.startsWith('modules/sync/')),
      'FIX-L-033: the Sync domain must not import the attachments module (port inversion)');
  });

  test('the eligibility gate is the only approved dependency shape', () => {
    // The approved eligibility-port shape pins the FULL gate surface: the
    // assessment functions, the scope assessment helper, and the gate types
    // (logical facts + the facts port — never repository facts or the physical
    // body). Extending this list is a reviewed attachments-module change.
    assert.deepEqual(I12_APPROVED_GATE_SYMBOLS, [
      'assessSharedExposureEligibility',
      'assertSharedExposureIneligible',
      'assessSharedExposureScope',
      'assertSharedExposureScopeIneligible',
      'SharedExposureBlobFacts',
      'SharedExposureEligibility',
      'IneligibleSharedExposure',
      'SharedExposureFactsPort',
      'SharedExposureFactsScope',
      'SharedExposureProjectionKind',
      'SharedExposureIneligibilityReason',
      'OWNER_PRIVATE_EXPOSURE_MODE',
      'SHARED_EXPOSURE_PROJECTION_KINDS',
      'SHARED_EXPOSURE_INELIGIBILITY_REASONS',
    ]);
    // The gate functions are real exports of the attachments facade.
    assert.equal(typeof assessSharedExposureEligibility, 'function');
    assert.equal(typeof assertSharedExposureIneligible, 'function');
    assert.equal(typeof assessSharedExposureScope, 'function');
    assert.equal(typeof assertSharedExposureScopeIneligible, 'function');
  });

  test('a future consumer importing the facade for a non-approved surface is caught', () => {
    const result = scanSharedConsumerAttachmentsEdges({
      sourceRoot: SOURCE_ROOT,
      extraConsumerFiles: [fixture('future-consumer-without-gate.ts')],
    });
    const violation = result.violations.find((entry) => entry.source.endsWith('future-consumer-without-gate.ts'));
    assert.ok(violation, 'facade import with a non-approved symbol must be reported');
    assert.equal(violation!.kind, 'consumer_attachments_import');
  });

  test('a future consumer importing the repository port directly is caught as repository/body access', () => {
    const result = scanSharedConsumerAttachmentsEdges({
      sourceRoot: SOURCE_ROOT,
      extraConsumerFiles: [fixture('future-consumer-repository.ts')],
    });
    const violation = result.violations.find((entry) => entry.source.endsWith('future-consumer-repository.ts'));
    assert.ok(violation, 'repository-port import must be reported');
    assert.equal(violation!.kind, 'consumer_repository_import');
    assert.equal(violation!.target, 'modules/attachments/attachments-repository-port.ts');
  });

  test('a future consumer depending ONLY on the eligibility gate is allowed (anti-false-negative)', () => {
    const result = scanSharedConsumerAttachmentsEdges({
      sourceRoot: SOURCE_ROOT,
      extraConsumerFiles: [fixture('approved-eligibility-consumer.ts')],
    });
    const violation = result.violations.find((entry) => entry.source.endsWith('approved-eligibility-consumer.ts'));
    assert.equal(violation, undefined, 'the approved eligibility-port dependency must not be a violation');
    const dependency = result.dependencies.find((entry) => entry.source.endsWith('approved-eligibility-consumer.ts'));
    assert.ok(dependency, 'approved dependency must be recorded');
    assert.equal(dependency!.approved, true);
    // The approved fixture imports the assessment function plus its
    // logical-facts type; both are part of the approved eligibility-port shape.
    assert.deepEqual(dependency!.facadeSymbols, ['assessSharedExposureEligibility', 'SharedExposureBlobFacts']);
  });

  test('a consumer importing the repository for a non-approved symbol AND the gate together is still caught', () => {
    const result = scanSharedConsumerAttachmentsEdges({
      sourceRoot: SOURCE_ROOT,
      extraConsumerFiles: [
        fixture('future-consumer-without-gate.ts'),
        fixture('future-consumer-repository.ts'),
        fixture('approved-eligibility-consumer.ts'),
      ],
    });
    assert.equal(result.violations.length, 2, 'the two bypass fixtures must both fail');
    assert.ok(result.violations.some((entry) => entry.source.endsWith('future-consumer-without-gate.ts')));
    assert.ok(result.violations.some((entry) => entry.source.endsWith('future-consumer-repository.ts')));
    // 4 production gate dependencies (publication snapshot-query, MCP
    // collection resources, search query — FIX-L-033 removed the sync facade
    // type re-export and the sync bootstrap gate import) plus the approved
    // eligibility fixture.
    assert.equal(result.dependencies.length, 4, 'the approved fixture plus the production gate dependencies');
  });
});

describe('P4A-I12 boundary-checker module edges are verified and kept', () => {
  test('consumer modules gained ONLY the controlled attachments gate edge; attachments keeps its owner edges', () => {
    const checker = readFileSync(resolve(REPO_ROOT, 'scripts', 'check-import-boundaries.mjs'), 'utf8');
    const moduleEdgesBlock = /const moduleEdges = \{[\s\S]*?\n\};/u.exec(checker)?.[0];
    assert.ok(moduleEdgesBlock, 'boundary checker moduleEdges block must exist');
    for (const consumer of ['publication', 'mcp', 'search']) {
      assert.match(moduleEdgesBlock, new RegExp(`${consumer}:\\s*new Set\\([^)]*'attachments'`, 'u'),
        `${consumer} must hold the controlled attachments gate edge (P4A-R06)`);
    }
    // FIX-L-033 (SYNC-R17): the Sync module holds NO attachments edge — the
    // gate is mapped onto the minimal Sync AttachmentExposurePolicyPort by the
    // composition adapter instead.
    for (const consumer of ['social', 'publisher', 'collections', 'sync']) {
      assert.doesNotMatch(moduleEdgesBlock, new RegExp(`${consumer}:\\s*new Set\\([^)]*'attachments'`, 'u'),
        `${consumer} must not gain an attachments edge`);
    }
    const attachmentsEdge = /attachments:\s*new Set\(\[([^\]]*)\]\)/u.exec(moduleEdgesBlock)?.[1] ?? '';
    assert.deepEqual(
      [...attachmentsEdge.matchAll(/'([^']+)'/gu)].map((match) => match[1]!),
      ['access-policy'],
      'attachments module edge set must stay exactly [access-policy]',
    );
  });

  test('the boundary checker symbol-gates consumer attachments facade imports to the approved gate allowlist', () => {
    const checker = readFileSync(resolve(REPO_ROOT, 'scripts', 'check-import-boundaries.mjs'), 'utf8');
    const allowlist = /const I12_APPROVED_GATE_SYMBOLS = new Set\(\[[\s\S]*?\]\);/u.exec(checker)?.[0];
    assert.ok(allowlist, 'boundary checker must embed the approved gate-symbol allowlist');
    for (const symbol of I12_APPROVED_GATE_SYMBOLS) {
      assert.match(allowlist, new RegExp(`'${symbol}'`, 'u'), `allowlist must pin ${symbol}`);
    }
    assert.match(checker, /non-approved attachments facade symbol/u,
      'boundary checker must reject non-approved attachments facade symbols from consumer modules');
    assert.match(checker, /CONSUMER_GATE_MODULES/u,
      'boundary checker must scope the symbol gate to the consumer module set');
  });

  test('consumer infrastructure has no attachments facade edge; owner infrastructure keeps its edges', () => {
    const checker = readFileSync(resolve(REPO_ROOT, 'scripts', 'check-import-boundaries.mjs'), 'utf8');
    const infraBlock = /const infrastructureModuleEdges = \{[\s\S]*?\n\};/u.exec(checker)?.[0];
    assert.ok(infraBlock, 'boundary checker infrastructureModuleEdges block must exist');
    for (const consumer of ['publication', 'sync', 'search', 'social']) {
      assert.doesNotMatch(infraBlock, new RegExp(`${consumer}:\\s*new Set\\([^)]*module:attachments:facade`, 'u'),
        `${consumer} infrastructure must not gain an attachments facade edge`);
    }
    for (const owner of ['database', 'outbox', 'object-storage']) {
      assert.match(infraBlock, new RegExp(`['"]?${owner}['"]?:\\s*new Set\\([^)]*module:attachments:facade`, 'u'),
        `${owner} infrastructure must keep its attachments facade edge (attachments owner/composition)`);
    }
  });
});
