import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listFollowedReports, listFollowedReportIssues, getReportFollowState } from '../../../src/modules/reports/application/report-queries.js';
import type { ReportTransactionPorts } from '../../../src/modules/reports/application/contracts.js';
import { createReportsCursorSigner } from '../../../src/modules/reports/application/reports-cursor.js';

const config = { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } };
const series = { id: 's1', ownerSubjectId: 'owner', title: 'T', summary: null, slug: 'report-one', visibility: 'public' as const, allowSearchIndexing: true, state: 'active' as const, resourceRevision: 'r', contentRevision: 'c', policyRevision: 'p', updatedAt: new Date().toISOString() };
function ports(): ReportTransactionPorts {
  return { receipts: {} as never, series: { lockById: async () => series, insert: async () => undefined, update: async () => series, nextEditionOrdinal: async () => 1 }, editions: { insert: async () => undefined, lockById: async () => null, update: async () => { throw new Error(); } }, members: { ensureOwner: async () => undefined, get: async () => null }, follows: { lockActiveProfile: async () => true, upsert: async () => ({ changed: true, followedAt: new Date() }), remove: async () => ({ changed: false, followedAt: null }), countActive: async () => 2, readState: async () => ({ following: true, followedAt: new Date('2026-01-01T00:00:00Z') }), listFollowed: async () => [Object.assign(series, { followedAt: new Date('2026-01-01T00:00:00Z') })] }, source: { get: async () => null, getMany: async () => [] }, revision: {} as never, audit: {} as never, outbox: {} as never, ids: {} as never, clock: { now: () => new Date('2026-01-01T00:00:00Z') } };
}
test('follow state is private and followed report cursor is principal-bound', async () => {
  const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(ports()) };
  const state = await getReportFollowState(uow, 's1', { principalId: 'a1', subjectId: 'sub-1', profileId: 'profile-1' }); assert.deepEqual(state, { following: true, followedAt: '2026-01-01T00:00:00.000Z', followerCount: 2 });
  // Owner has no followable surface: self-follow is forbidden, so the read
  // conceals the state instead of offering an action that can only fail.
  assert.equal(await getReportFollowState(uow, 's1', { principalId: 'a-owner', subjectId: 'owner', profileId: 'profile-owner' }), null);
  const page = await listFollowedReports(uow, 'profile-1', config, 1); assert.equal(page.items.length, 1); assert.equal(page.items[0]?.followedAt, '2026-01-01T00:00:00.000Z');
  if (page.nextCursor) { const signer = createReportsCursorSigner(config); const payload = signer.verify(page.nextCursor, new Date('2026-01-01T00:00:01Z')); assert.equal(payload.principalId, 'followed:profile-1'); signer.destroy(); }
});

test('followed timeline emits a closed safe issue view without source or revision fields', async () => {
  const edition = {
    id: 'e1', seriesId: 's1', sourceCollectionId: 'private-source', issueKey: 'one', editionOrdinal: 1,
    titleSnapshot: 'Issue', summarySnapshot: null, sourceContentRevision: 'secret-content',
    sourcePolicyRevision: 'secret-policy', resourceRevision: 'secret-resource', periodStart: null,
    periodEnd: null, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z', series,
  };
  const timelinePorts = { ...ports(), follows: {
    ...ports().follows!,
    listFollowedIssues: async () => [edition],
  } } as ReportTransactionPorts;
  const page = await listFollowedReportIssues({ execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(timelinePorts) }, 'profile-1', config, 10);
  assert.equal(page.items.length, 1);
  const item = page.items[0] as unknown as Record<string, unknown>;
  assert.equal(item.sourceCollectionId, undefined);
  assert.equal(item.resourceRevision, undefined);
  assert.equal((item.series as Record<string, unknown>).policyRevision, undefined);
});

test('cursor carries the page size so follow-up requests may omit limit', async () => {
  const first = Object.assign({}, series, { id: 's1', followedAt: new Date('2026-01-02T00:00:00Z') });
  const second = Object.assign({}, series, { id: 's2', followedAt: new Date('2026-01-01T00:00:00Z') });
  const base = ports();
  const queryPorts = { ...base, follows: {
    ...base.follows!,
    listFollowed: async (_profileId: string, _limit: number, after?: { followedAt: Date; seriesId: string }) => {
      if (!after) return [first, second];
      return [second];
    },
  } } as ReportTransactionPorts;
  const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(queryPorts) };
  const firstPage = await listFollowedReports(uow, 'profile-1', config, 1);
  assert.ok(firstPage.nextCursor);
  const nextPage = await listFollowedReports(uow, 'profile-1', config, undefined, firstPage.nextCursor!);
  assert.equal(nextPage.items[0]?.id, 's2');
});

test('followed timeline uses the published/ordinal/id keyset and fences the full snapshot', async () => {
  const publishedAt = '2026-01-02T00:00:00.000Z';
  const rows = [
    {
      id: 'e-ordinal-2', seriesId: 's1', sourceCollectionId: 'source-1', issueKey: 'two', editionOrdinal: 2,
      titleSnapshot: 'Second', summarySnapshot: null, sourceContentRevision: 'source-c1', sourcePolicyRevision: 'source-p1',
      resourceRevision: 'edition-r2', periodStart: null, periodEnd: null, state: 'published' as const, publishedAt,
      series,
      sourceFence: {
        visibility: 'public', publishedAt, publicationSlug: 'source-1', hasRoot: true,
        allowSearchIndexing: true, ownerAccountActive: true, deleted: false, seedExcluded: false,
        contentRevision: 'source-c1', policyRevision: 'source-p1', updatedAt: publishedAt,
      },
    },
    {
      id: 'e-ordinal-1', seriesId: 's1', sourceCollectionId: 'source-1', issueKey: 'one', editionOrdinal: 1,
      titleSnapshot: 'First', summarySnapshot: null, sourceContentRevision: 'source-c1', sourcePolicyRevision: 'source-p1',
      resourceRevision: 'edition-r1', periodStart: null, periodEnd: null, state: 'published' as const, publishedAt,
      series,
      sourceFence: {
        visibility: 'public', publishedAt, publicationSlug: 'source-1', hasRoot: true,
        allowSearchIndexing: true, ownerAccountActive: true, deleted: false, seedExcluded: false,
        contentRevision: 'source-c1', policyRevision: 'source-p1', updatedAt: publishedAt,
      },
    },
    {
      id: 'e-older', seriesId: 's1', sourceCollectionId: 'source-1', issueKey: 'older', editionOrdinal: 3,
      titleSnapshot: 'Older', summarySnapshot: null, sourceContentRevision: 'source-c1', sourcePolicyRevision: 'source-p1',
      resourceRevision: 'edition-r3', periodStart: null, periodEnd: null, state: 'published' as const,
      publishedAt: '2026-01-01T00:00:00.000Z', series,
      sourceFence: {
        visibility: 'public', publishedAt: '2026-01-01T00:00:00.000Z', publicationSlug: 'source-1', hasRoot: true,
        allowSearchIndexing: true, ownerAccountActive: true, deleted: false, seedExcluded: false,
        contentRevision: 'source-c1', policyRevision: 'source-p1', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  ];
  let currentRows = rows;
  const base = ports();
  const queryPorts = {
    ...base,
    follows: {
      ...base.follows!,
      listFollowedIssues: async (_profileId: string, limit: number, after?: unknown) => {
        assert.equal(limit, 2_001);
        assert.equal(after, undefined);
        return currentRows;
      },
    },
  } as ReportTransactionPorts;
  const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(queryPorts) };
  const first = await listFollowedReportIssues(uow, 'profile-1', config, 1);
  assert.deepEqual(first.items.map((item) => item.id), ['e-ordinal-2']);
  assert.ok(first.nextCursor);
  const second = await listFollowedReportIssues(uow, 'profile-1', config, undefined, first.nextCursor!);
  assert.deepEqual(second.items.map((item) => item.id), ['e-ordinal-1']);

  currentRows = rows.map((row) => row.id === 'e-ordinal-2'
    ? { ...row, sourceFence: { ...row.sourceFence, contentRevision: 'source-c2' } }
    : row);
  await assert.rejects(
    () => listFollowedReportIssues(uow, 'profile-1', config, undefined, first.nextCursor!),
    (error: unknown) => error instanceof Error && error.message === 'invalid_cursor',
  );
});
test('followed surfaces tombstone hide_public series and editions instead of dropping them', async () => {
  const hiddenSeries = { ...series, hiddenPublic: true };
  const exposedEdition = {
    id: 'e2', seriesId: 's1', sourceCollectionId: 'src', issueKey: 'two', editionOrdinal: 2,
    titleSnapshot: 'Real title', summarySnapshot: 'Real summary', sourceContentRevision: 'c', sourcePolicyRevision: 'p',
    resourceRevision: 'r', periodStart: null, periodEnd: null, state: 'published' as const,
    publishedAt: '2026-01-02T00:00:00.000Z', series, editionHiddenPublic: true,
  };
  const buriedEdition = {
    id: 'e1', seriesId: 's1', sourceCollectionId: 'src', issueKey: 'one', editionOrdinal: 1,
    titleSnapshot: 'Buried title', summarySnapshot: 'Buried summary', sourceContentRevision: 'c', sourcePolicyRevision: 'p',
    resourceRevision: 'r', periodStart: null, periodEnd: null, state: 'published' as const,
    publishedAt: '2026-01-01T00:00:00.000Z', series: hiddenSeries,
  };
  const base = ports();
  const queryPorts = {
    ...base,
    follows: {
      ...base.follows!,
      listFollowed: async () => [Object.assign({}, hiddenSeries, { followedAt: new Date('2026-01-01T00:00:00Z') })],
      listFollowedIssues: async () => [buriedEdition, exposedEdition],
    },
  } as ReportTransactionPorts;
  const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(queryPorts) };
  const seriesPage = await listFollowedReports(uow, 'profile-1', config, 10);
  assert.equal(seriesPage.items[0]?.title, 'Digest hidden');
  assert.equal(seriesPage.items[0]?.slug, null);
  assert.equal(seriesPage.items[0]?.summary, null);
  assert.equal(seriesPage.items[0]?.hiddenPublic, true);
  const page = await listFollowedReportIssues(uow, 'profile-1', config, 10);
  // Keyset order survives — the newer edition still leads.
  assert.deepEqual(page.items.map((item) => item.id), ['e2', 'e1']);
  assert.deepEqual(page.items.map((item) => item.state), ['hidden', 'hidden']);
  assert.deepEqual(page.items.map((item) => item.titleSnapshot), ['Issue hidden', 'Issue hidden']);
  assert.equal(page.items[0]?.summarySnapshot, null);
  // Edition-level hide leaves the series identity linked...
  assert.equal(page.items[0]?.series.title, 'T');
  assert.equal(page.items[0]?.series.slug, 'report-one');
  assert.equal(page.items[0]?.series.hiddenPublic, undefined);
  // ...series-level hide tombstones the embedded series too.
  assert.equal(page.items[1]?.series.title, 'Digest hidden');
  assert.equal(page.items[1]?.series.slug, null);
  assert.equal(page.items[1]?.series.hiddenPublic, true);
});

test('a hide_public flip moves the timeline fence, so old cursors are rejected', async () => {
  const newer = {
    id: 'e2', seriesId: 's1', sourceCollectionId: 'src', issueKey: 'two', editionOrdinal: 2,
    titleSnapshot: 'Second', summarySnapshot: null, sourceContentRevision: 'c', sourcePolicyRevision: 'p',
    resourceRevision: 'r', periodStart: null, periodEnd: null, state: 'published' as const,
    publishedAt: '2026-01-02T00:00:00.000Z', series,
  };
  const older = { ...newer, id: 'e1', issueKey: 'one', editionOrdinal: 1, titleSnapshot: 'First', publishedAt: '2026-01-01T00:00:00.000Z' };
  let currentRows: unknown[] = [newer, older];
  const base = ports();
  const queryPorts = {
    ...base,
    follows: { ...base.follows!, listFollowedIssues: async () => currentRows },
  } as ReportTransactionPorts;
  const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(queryPorts) };
  const first = await listFollowedReportIssues(uow, 'profile-1', config, 1);
  assert.deepEqual(first.items.map((item) => item.id), ['e2']);
  assert.ok(first.nextCursor);
  // Moderation lands between pages: the same row turns into a tombstone and
  // the fence must reject the now-stale cursor instead of serving around it.
  currentRows = [{ ...newer, editionHiddenPublic: true }, older];
  await assert.rejects(
    () => listFollowedReportIssues(uow, 'profile-1', config, undefined, first.nextCursor!),
    (error: unknown) => error instanceof Error && error.message === 'invalid_cursor',
  );
});
