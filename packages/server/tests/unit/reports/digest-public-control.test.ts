import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  EMPTY_DIGEST_CONTROL,
  isEditionInPublicListing,
  isEditionPubliclyDirect,
  isSeriesInPublicDirectory,
  isSeriesPubliclyReadable,
} from '../../../src/modules/reports/application/digest-public-control.js';
import type { DigestEdition, DigestSeries, ReportSourceFacts } from '../../../src/modules/reports/domain/types.js';

const series: DigestSeries = {
  id: 'ser_1', ownerSubjectId: 'owner', title: 'Weekly', summary: null, slug: 'weekly',
  visibility: 'public', allowSearchIndexing: true, state: 'active',
  resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1',
};
const edition: DigestEdition = {
  id: 'ed_1', seriesId: 'ser_1', sourceCollectionId: 'col_1', issueKey: 'w1',
  editionOrdinal: 1, titleSnapshot: 'Issue', summarySnapshot: 'body',
  sourceContentRevision: 'c1', sourcePolicyRevision: null, resourceRevision: 'er1',
  periodStart: null, periodEnd: null, state: 'published', publishedAt: '2026-01-01T00:00:00.000Z',
};
const source: ReportSourceFacts = {
  collectionId: 'col_1', visibility: 'public', publishedAt: '2026-01-01T00:00:00.000Z',
  publicationSlug: 'source-one', hasRoot: true, allowSearchIndexing: true,
  ownerAccountActive: true, deleted: false, seedExcluded: false,
  contentRevision: 'c1', policyRevision: 'p1',
};

test('series hide blocks public output; delist is directory-only', () => {
  assert.equal(isSeriesPubliclyReadable(series, EMPTY_DIGEST_CONTROL), true);
  assert.equal(isSeriesInPublicDirectory(series, EMPTY_DIGEST_CONTROL), true);
  assert.equal(isSeriesPubliclyReadable(series, { hidePublic: true, delisted: true }), false);
  assert.equal(isSeriesInPublicDirectory(series, { hidePublic: false, delisted: true }), false);
  assert.equal(isSeriesPubliclyReadable(series, { hidePublic: false, delisted: true }), true);
});

test('edition hide is independent of siblings; delist keeps direct reads', () => {
  const hide = { hidePublic: true, delisted: true };
  const delist = { hidePublic: false, delisted: true };
  assert.equal(isEditionPubliclyDirect(series, edition, source, EMPTY_DIGEST_CONTROL, EMPTY_DIGEST_CONTROL), true);
  assert.equal(isEditionPubliclyDirect(series, edition, source, EMPTY_DIGEST_CONTROL, hide), false);
  assert.equal(isEditionPubliclyDirect(series, edition, source, EMPTY_DIGEST_CONTROL, delist), true);
  assert.equal(isEditionInPublicListing(series, edition, source, EMPTY_DIGEST_CONTROL, delist), false);
  assert.equal(isEditionPubliclyDirect(series, edition, source, hide, EMPTY_DIGEST_CONTROL), false);
});

test('source private or collection-hidden cannot be overridden by a public series', () => {
  const privateSource = { ...source, visibility: 'private' as const };
  const hiddenSource = { ...source, hiddenPublic: true };
  assert.equal(isEditionPubliclyDirect(series, edition, privateSource, EMPTY_DIGEST_CONTROL, EMPTY_DIGEST_CONTROL), false);
  assert.equal(isEditionPubliclyDirect(series, edition, hiddenSource, EMPTY_DIGEST_CONTROL, EMPTY_DIGEST_CONTROL), false);
});
