/**
 * P4A-P09 architecture gate suite: product-data variants.
 *
 * Confirms the P4A-R06 architecture coverage (zero unapproved production
 * consumer edges; the eligibility gate is the ONLY approved dependency shape;
 * the boundary checker symbol-gates consumer facade imports) and adds the
 * P4A-P09 product-data variants: after the owner-private Product closed loop
 * (P02-P08) the P02-era product repository surfaces
 * (`attachment-metadata-repository-port.ts`,
 * `attachment-canonical-mutation-port.ts`) hold owner-private Attachment
 * metadata and canonical mutation facts. A future shared consumer reaching
 * them directly is classified as `consumer_repository_import` — the strongest
 * forbidden shape — at build/contract stage, and the boundary checker's
 * allowlist keeps every product surface (finalize/status/replacement/retire/
 * delivery) out of consumer modules.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  I12_APPROVED_GATE_SYMBOLS,
  I12_ATTACHMENTS_REPOSITORY_SURFACES,
  scanSharedConsumerAttachmentsEdges,
} from '../../../scripts/evidence/phase4a-i12-architecture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SOURCE_ROOT = resolve(REPO_ROOT, 'src');
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests', 'fixtures', 'phase4a-p09');
const I12_FIXTURE_DIR = resolve(REPO_ROOT, 'tests', 'fixtures', 'phase4a-i12');

function fixture(name: string): string {
  return resolve(FIXTURE_DIR, name);
}

function i12Fixture(name: string): string {
  return resolve(I12_FIXTURE_DIR, name);
}

describe('P4A-P09 architecture gate over the productized composition', () => {
  test('R06 coverage confirmed: production consumers keep zero unapproved edges and the approved gate dependencies', () => {
    const result = scanSharedConsumerAttachmentsEdges({ sourceRoot: SOURCE_ROOT });
    assert.deepEqual(result.violations, [], 'production consumers must have zero unapproved attachments edges');
    // FIX-L-033 (SYNC-R17): the Sync domain holds NO attachments edge by
    // design — the exposure gate is mapped onto a Sync-owned port by the
    // composition adapter, so the production gate consumers are exactly
    // publication/mcp/search.
    assert.ok(result.dependencies.length >= 3,
      `production consumers must depend on the gate (publication/mcp/search); got ${result.dependencies.length}`);
    for (const dependency of result.dependencies) {
      assert.equal(dependency.approved, true, `${dependency.source} must be an approved gate dependency`);
      for (const symbol of dependency.facadeSymbols) {
        assert.ok(I12_APPROVED_GATE_SYMBOLS.includes(symbol),
          `${dependency.source} must import only approved gate symbols (got ${symbol})`);
      }
    }
    const sources = result.dependencies.map((dependency) => dependency.source);
    assert.ok(sources.includes('modules/publication/application/snapshot-query.ts'));
    assert.ok(sources.includes('modules/mcp/collection-resources.ts'));
    assert.ok(sources.includes('modules/search/application/search-query.ts'));
    // FIX-L-033: sync must NOT appear — a regression to a direct gate import
    // would trip the consumer scan as an unapproved attachments edge.
    assert.ok(!sources.includes('modules/sync/sync-bootstrap-snapshot.ts'));
  });

  test('the P02-era product repository surfaces are classified as repository connections', () => {
    // The product-data repository surfaces a shared consumer must never reach:
    // owner-private Attachment metadata rows and canonical mutation assembly.
    for (const surface of ['attachment-metadata-repository-port.ts', 'attachment-canonical-mutation-port.ts']) {
      assert.ok(I12_ATTACHMENTS_REPOSITORY_SURFACES.includes(surface),
        `the i12 scanner must classify ${surface} as a repository surface`);
    }
    const result = scanSharedConsumerAttachmentsEdges({
      sourceRoot: SOURCE_ROOT,
      extraConsumerFiles: [
        fixture('future-consumer-metadata-repository.ts'),
        fixture('future-consumer-canonical-mutation.ts'),
      ],
    });
    const metadataViolation = result.violations.find(
      (entry) => entry.source.endsWith('future-consumer-metadata-repository.ts'),
    );
    assert.ok(metadataViolation, 'a consumer importing the product metadata repository must be reported');
    assert.equal(metadataViolation!.kind, 'consumer_repository_import');
    assert.equal(metadataViolation!.target, 'modules/attachments/attachment-metadata-repository-port.ts');
    const canonicalViolation = result.violations.find(
      (entry) => entry.source.endsWith('future-consumer-canonical-mutation.ts'),
    );
    assert.ok(canonicalViolation, 'a consumer importing the canonical mutation port must be reported');
    assert.equal(canonicalViolation!.kind, 'consumer_repository_import');
    assert.equal(canonicalViolation!.target, 'modules/attachments/attachment-canonical-mutation-port.ts');
  });

  test('product surfaces via the facade stay forbidden while the approved gate fixture stays allowed', () => {
    const result = scanSharedConsumerAttachmentsEdges({
      sourceRoot: SOURCE_ROOT,
      extraConsumerFiles: [
        i12Fixture('future-consumer-without-gate.ts'),
        i12Fixture('future-consumer-repository.ts'),
        fixture('future-consumer-metadata-repository.ts'),
        fixture('future-consumer-canonical-mutation.ts'),
        i12Fixture('approved-eligibility-consumer.ts'),
      ],
    });
    assert.equal(result.violations.length, 4, 'every bypass fixture must fail the scan');
    assert.ok(result.violations.some((entry) => entry.source.endsWith('future-consumer-without-gate.ts')));
    assert.ok(result.violations.some((entry) => entry.source.endsWith('future-consumer-repository.ts')));
    const approved = result.dependencies.find((entry) => entry.source.endsWith('approved-eligibility-consumer.ts'));
    assert.ok(approved, 'the approved eligibility-port dependency must remain allowed (anti-false-negative)');
    assert.equal(approved!.approved, true);
  });

  test('the boundary checker allowlist keeps every product surface out of consumer modules', () => {
    const checker = readFileSync(resolve(REPO_ROOT, 'scripts', 'check-import-boundaries.mjs'), 'utf8');
    const allowlist = /const I12_APPROVED_GATE_SYMBOLS = new Set\(\[[\s\S]*?\]\);/u.exec(checker)?.[0];
    assert.ok(allowlist, 'boundary checker must embed the approved gate-symbol allowlist');
    for (const symbol of I12_APPROVED_GATE_SYMBOLS) {
      assert.match(allowlist, new RegExp(`'${symbol}'`, 'u'), `allowlist must pin ${symbol}`);
    }
    // P4A-P09 product surfaces must NEVER become consumer-importable.
    for (const productSurface of [
      'finalizeAttachment',
      'readAttachmentStatus',
      'issueReplacementIntent',
      'retireAttachment',
      'authorizeOwnerDownload',
      'completeUpload',
      'issueUploadIntentWithAdmissionGate',
    ]) {
      assert.doesNotMatch(allowlist, new RegExp(`'${productSurface}'`, 'u'),
        `${productSurface} must not be importable by a shared consumer`);
    }
  });
});
