import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  ReportsDomainError,
  assertIssueKey,
  assertPeriod,
  assertReportSlug,
  assertReportTitle,
  isReportIndexable,
  transitionDigestEdition,
  transitionDigestRun,
} from '../../../src/modules/reports/index.js';
import {
  createReportsCursorSigner,
  createReportsIssueCursorSigner,
} from '../../../src/modules/reports/index.js';
import { loadReportsFeatureConfig } from '../../../src/bootstrap/config-reports.js';

describe('reports domain contracts', () => {
  test('edition state machine is terminal and does not permit source rebind semantics', () => {
    expect(transitionDigestEdition('draft', 'publish')).toBe('published');
    expect(transitionDigestEdition('published', 'withdraw')).toBe('withdrawn');
    expect(() => transitionDigestEdition('withdrawn', 'publish')).toThrow(ReportsDomainError);
  });

  test('run transitions require matching lease owner and generation', () => {
    expect(transitionDigestRun('pending', { type: 'lease', owner: 'w1', generation: 0 }, { leaseOwner: null, generation: 0 })).toBe('leased');
    expect(() => transitionDigestRun('leased', { type: 'succeed', owner: 'w2', generation: 0 }, { leaseOwner: 'w1', generation: 0 })).toThrow(ReportsDomainError);
    expect(transitionDigestRun('leased', { type: 'retry', owner: 'w1', generation: 0 }, { leaseOwner: 'w1', generation: 0 })).toBe('retryable');
  });

  test('validation enforces frozen slug/period/issue contracts', () => {
    assert.equal(assertReportSlug('a'.repeat(63), (value) => value.length >= 3), 'a'.repeat(63));
    assert.throws(() => assertReportSlug('a'.repeat(64), () => true));
    assert.throws(() => assertReportTitle('   '));
    assert.throws(() => assertIssueKey('x\u0000y'));
    assert.deepEqual(assertPeriod('2026-09-04T08:00:00+08:00', '2026-09-04T09:00:00+08:00'), ['2026-09-04T00:00:00.000Z', '2026-09-04T01:00:00.000Z']);
    assert.throws(() => assertPeriod('2026-09-04', null));
  });

  test('indexability is fail-closed and requires every source', () => {
    const source = { collectionId: 'c', visibility: 'public' as const, publishedAt: '2026-09-04T00:00:00Z', publicationSlug: 'c', hasRoot: true, allowSearchIndexing: true, ownerAccountActive: true, deleted: false, seedExcluded: false, contentRevision: 'r1', policyRevision: 'p1' };
    assert.equal(isReportIndexable({ series: { visibility: 'public', allowSearchIndexing: true }, publishedSources: [source] }), true);
    assert.equal(isReportIndexable({ series: { visibility: 'unlisted', allowSearchIndexing: true }, publishedSources: [source] }), false);
    assert.equal(isReportIndexable({ series: { visibility: 'public', allowSearchIndexing: true }, publishedSources: [{ ...source, allowSearchIndexing: false }] }), false);
    assert.equal(isReportIndexable({ series: { visibility: 'public', allowSearchIndexing: true }, publishedSources: [{ ...source, seedExcluded: true }] }), false);
  });

  test('cursor signer round trips a bounded payload and rejects tampering', () => {
    const signer = createReportsCursorSigner({ active: { id: 'reports-v1', key: 'secret-for-reports-cursor-32-bytes-min' } });
    const payload = { v: 1 as const, purpose: 'reports-list-v1' as const, principalId: 'subject', policyRevision: 'p1', limit: 10, sort: 'updated_at:desc,id:asc' as const, comparatorVersion: 'updated-desc-id-v1' as const, after: { updatedAt: '2026-09-04T00:00:00.000Z', id: 'series-1' }, issuedAt: '2026-09-04T00:00:00.000Z', expiresAt: '2026-09-04T00:15:00.000Z' };
    const token = signer.sign(payload);
    assert.equal(signer.verify(token, new Date('2026-09-04T00:01:00.000Z')).principalId, 'subject');
    assert.throws(() => signer.verify(`${token}x`, new Date('2026-09-04T00:01:00.000Z')));
    signer.destroy();
  });

  test('issue cursor signer binds the published/ordinal/id comparator', () => {
    const signer = createReportsIssueCursorSigner({
      active: { id: 'reports-v1', key: 'secret-for-reports-cursor-32-bytes-min' },
    });
    const payload = {
      v: 1 as const,
      purpose: 'reports-issues-list-v1' as const,
      principalId: 'timeline:profile-1',
      policyRevision: 'fence-1',
      limit: 10,
      sort: 'published_at:desc,edition_ordinal:desc,id:asc' as const,
      comparatorVersion: 'published-ordinal-id-v1' as const,
      after: {
        publishedAt: '2026-09-04T00:00:00.000Z',
        editionOrdinal: 7,
        id: 'edition-7',
      },
      issuedAt: '2026-09-04T00:00:00.000Z',
      expiresAt: '2026-09-04T00:15:00.000Z',
    };
    const token = signer.sign(payload);
    assert.equal(signer.verify(token, new Date('2026-09-04T00:01:00.000Z')).after.editionOrdinal, 7);
    assert.throws(() => signer.verify(token, new Date('2026-09-04T00:16:00.000Z')));
    signer.destroy();
  });

  test('flag-off config has no derived side effects and rejects illegal combinations', () => {
    const config = loadReportsFeatureConfig({ NODE_ENV: 'test' });
    assert.equal(config.enabled, false);
    assert.throws(() => loadReportsFeatureConfig({ KNOWN_FEATURE_REPORTS_PUBLIC: 'true' }, 'test'));
    assert.throws(() => loadReportsFeatureConfig({ KNOWN_FEATURE_REPORTS: 'true', KNOWN_FEATURE_REPORTS_MCP_WRITE: 'true', KNOWN_FEATURE_REPORTS_MCP: 'true', KNOWN_FEATURE_MCP_WRITE: 'false' }, 'test'));
  });

  test('property: terminal edition states never transition back to an active state', () => {
    fc.assert(fc.property(fc.constantFrom('withdrawn' as const, 'detached' as const), (state) => {
      for (const transition of ['publish', 'withdraw', 'detach'] as const) {
        assert.throws(() => transitionDigestEdition(state, transition));
      }
    }));
  });
});
