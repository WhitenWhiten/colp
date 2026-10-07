import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  attachDigestEdition,
  publishDigestEdition,
  withdrawDigestEdition,
  updateDigestSeries,
  ReportsApplicationError,
} from '../../../src/modules/reports/application/report-commands.js';
import {
  getPublicReportIssue,
  getPublicReportSeries,
  listPublicReportDirectory,
  listPublicReportIssues,
} from '../../../src/modules/reports/application/public-query.js';
import type {
  ReportEditionWritePort,
  ReportSeriesWritePort,
  ReportSourceReadPort,
  ReportTransactionPorts,
} from '../../../src/modules/reports/application/contracts.js';
import type { DigestEdition, DigestSeries, ReportSourceFacts } from '../../../src/modules/reports/domain/types.js';

const commandId = '123e4567-e89b-42d3-a456-426614174000';
const source: ReportSourceFacts = {
  collectionId: 'collection-1', visibility: 'public', publishedAt: '2026-01-01T00:00:00.000Z',
  publicationSlug: 'source-one', hasRoot: true, allowSearchIndexing: true,
  ownerAccountActive: true, deleted: false, seedExcluded: false,
  contentRevision: 'content-1', policyRevision: 'policy-1',
};
const baseSeries: DigestSeries = {
  id: 'series-1', ownerSubjectId: 'owner-1', title: 'Digest', summary: null, slug: 'digest-one',
  visibility: 'unlisted', allowSearchIndexing: false, state: 'active', resourceRevision: 'r1',
  contentRevision: 'c1', policyRevision: 'p1', updatedAt: '2026-01-01T00:00:00.000Z',
};
const baseEdition: DigestEdition = {
  id: 'edition-1', seriesId: 'series-1', sourceCollectionId: source.collectionId, issueKey: 'one',
  editionOrdinal: 1, titleSnapshot: 'Issue', summarySnapshot: null, sourceContentRevision: 'content-1',
  sourcePolicyRevision: null, resourceRevision: 'er1', periodStart: null, periodEnd: null,
  state: 'draft', publishedAt: null,
};

interface PortOverrides {
  readonly series?: Partial<ReportSeriesWritePort>;
  readonly editions?: Partial<ReportEditionWritePort>;
  readonly source?: Partial<ReportSourceReadPort>;
  readonly members?: Partial<ReportTransactionPorts['members']>;
  readonly follows?: Partial<NonNullable<ReportTransactionPorts['follows']>>;
  readonly ownerProfiles?: ReportTransactionPorts['ownerProfiles'];
}

function makePorts(overrides: PortOverrides = {}): ReportTransactionPorts {
  const revisions = ['r2', 'p2', 'er2'];
  const series: ReportSeriesWritePort = {
    insert: async () => undefined,
    lockById: async () => baseSeries,
    update: async (_id, patch) => ({ ...baseSeries, ...patch }),
    nextEditionOrdinal: async () => 2,
    ...overrides.series,
  };
  const editions: ReportEditionWritePort = {
    insert: async () => undefined,
    lockById: async () => baseEdition,
    update: async (_id, patch) => ({ ...baseEdition, ...patch }),
    ...overrides.editions,
  };
  const sourcePort: ReportSourceReadPort = {
    get: async () => source,
    getMany: async () => [source],
    ...overrides.source,
  };
  return {
    receipts: {
      claim: async () => ({ kind: 'claimed' as const }),
      complete: async () => undefined,
      purgeExpired: async () => 0,
      deletePrincipalReceipts: async () => 0,
    },
    revision: {
      next: () => revisions.shift() ?? 'rN',
      etag: (value) => `"${value}"`,
      matches: (value, etag) => etag === `"${value}"`,
    },
    ids: { nextResourceId: (type) => `${type}-new`, nextEventId: () => 'event-1', nextOutboxId: () => 'outbox-1' },
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    series,
    editions,
    members: {
      ensureOwner: async () => undefined,
      get: async () => ({ seriesId: baseSeries.id, subjectId: 'editor-1', role: 'editor', revokedAt: null }),
      ...overrides.members,
    },
    source: sourcePort,
    audit: { append: async () => undefined },
    outbox: { append: async () => undefined },
    ...(overrides.follows ? {
      follows: {
        lockActiveProfile: async () => true,
        upsert: async () => ({ changed: true, followedAt: new Date('2026-01-01T00:00:00.000Z') }),
        remove: async () => ({ changed: true, followedAt: null }),
        ...overrides.follows,
      },
    } : {}),
    ...(overrides.ownerProfiles ? { ownerProfiles: overrides.ownerProfiles } : {}),
  };
}

function unitWith(ports: ReportTransactionPorts) {
  return { execute: async <T>(work: (value: ReportTransactionPorts) => Promise<T>) => work(ports) };
}

describe('report authorization and public projection boundaries', () => {
  for (const visibility of ['private', 'protected', 'public', 'unlisted'] as const) {
    for (const role of ['owner', 'editor', 'viewer', 'revoked-editor'] as const) {
      for (const action of ['publish', 'withdraw'] as const) {
        test(`${role} ${action} authorization on ${visibility} issues`, async () => {
          let series: DigestSeries = { ...baseSeries, visibility };
          let edition: DigestEdition = { ...baseEdition,
            state: action === 'publish' ? 'draft' : 'published',
            publishedAt: action === 'publish' ? null : '2026-01-01T00:00:00.000Z' };
          const writes: string[] = [];
          const ports = makePorts({
            series: {
              lockById: async () => series,
              update: async (_id, patch) => { writes.push('series'); return series = { ...series, ...patch }; },
            },
            editions: {
              lockById: async () => edition,
              update: async (_id, patch) => { writes.push('edition'); return edition = { ...edition, ...patch }; },
            },
            members: { get: async () => ({
              seriesId: series.id, subjectId: 'member-1', role: role === 'viewer' ? 'viewer' : 'editor',
              revokedAt: role === 'revoked-editor' ? '2026-01-01T00:00:00.000Z' : null,
            }) },
            source: { getForActor: async () => ({ verdict: 'authorized', facts: source }) },
          });
          ports.receipts.complete = async () => { writes.push('receipt'); };
          ports.audit.append = async () => { writes.push('audit'); };
          ports.outbox.append = async () => { writes.push('outbox'); };
          const command = action === 'publish' ? publishDigestEdition : withdrawDigestEdition;
          const run = () => command(unitWith(ports), {
            actor: { principalId: 'account-1', subjectId: role === 'owner' ? series.ownerSubjectId : 'member-1' },
            commandId, seriesId: series.id, editionId: edition.id, expectedRevision: '"er1"',
          });
          const allowed = role === 'owner' || (role === 'editor' && (visibility === 'private' || visibility === 'protected'));
          if (allowed) {
            assert.equal((await run()).kind, 'succeeded');
            assert.equal(edition.state, action === 'publish' ? 'published' : 'withdrawn');
            assert.ok(writes.includes('receipt'));
            assert.ok(writes.includes('outbox'));
          } else {
            await assert.rejects(run, (error: unknown) => error instanceof ReportsApplicationError && error.code === 'forbidden');
            assert.deepEqual(writes, []);
            assert.equal(edition.state, action === 'publish' ? 'draft' : 'published');
          }
        });
      }
    }
  }

  test.each(['public', 'unlisted'] as const)('editor cannot withdraw a draft in a %s series', async visibility => {
    const ports = makePorts({ series: { lockById: async () => ({ ...baseSeries, visibility }) } });
    await assert.rejects(() => withdrawDigestEdition(unitWith(ports), {
      actor: { principalId: 'editor-account', subjectId: 'editor-1' }, commandId,
      seriesId: baseSeries.id, editionId: baseEdition.id, expectedRevision: '"er1"',
    }), (error: unknown) => error instanceof ReportsApplicationError && error.code === 'forbidden');
  });

  test('editor cannot mutate visibility, slug, or indexability policy', async () => {
    await assert.rejects(
      () => updateDigestSeries(unitWith(makePorts()), {
        actor: { principalId: 'editor-account', subjectId: 'editor-1' }, commandId,
        seriesId: baseSeries.id, expectedRevision: '"r1"', visibility: 'public',
      }),
      (error: unknown) => error instanceof ReportsApplicationError && error.code === 'forbidden',
    );
  });

  test('attach uses actor-bound source authorization and conceals foreign source', async () => {
    let legacyRead = false;
    await assert.rejects(
      () => attachDigestEdition(unitWith(makePorts({
        source: {
          get: async () => { legacyRead = true; return source; },
          getForActor: async () => ({ verdict: 'not_public' as const }),
        },
      })), {
        actor: { principalId: 'editor-account', subjectId: 'editor-1' }, commandId,
        seriesId: baseSeries.id, sourceCollectionId: source.collectionId, issueKey: 'new-issue', titleSnapshot: 'Issue',
      }),
      (error: unknown) => error instanceof ReportsApplicationError && error.code === 'resource_not_found',
    );
    assert.equal(legacyRead, false);
  });

  test('attach rejects a source adapter that returns a different collection identity', async () => {
    await assert.rejects(
      () => attachDigestEdition(unitWith(makePorts({
        source: {
          getForActor: async () => ({ verdict: 'authorized' as const, facts: { ...source, collectionId: 'another-collection' } }),
        },
      })), {
        actor: { principalId: 'owner-account', subjectId: 'owner-1' }, commandId,
        seriesId: baseSeries.id, sourceCollectionId: source.collectionId, issueKey: 'mismatch', titleSnapshot: 'Issue',
      }),
      (error: unknown) => error instanceof ReportsApplicationError && error.code === 'resource_not_found',
    );
  });

  test('unlisted publish accepts a public source with indexing opt-out', async () => {
    const sourceWithoutIndexing = { ...source, allowSearchIndexing: false };
    const result = await publishDigestEdition(unitWith(makePorts({
      source: {
        get: async () => sourceWithoutIndexing,
        getForActor: async () => ({ verdict: 'authorized' as const, facts: sourceWithoutIndexing }),
      },
    })), {
      actor: { principalId: 'owner-account', subjectId: 'owner-1' }, commandId,
      editionId: baseEdition.id, expectedRevision: '"er1"',
    });
    assert.equal(result.kind, 'succeeded');
  });

  test('unlisted projection keeps public issues visible while remaining noindex', async () => {
    const edition = { ...baseEdition, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' };
    const result = await getPublicReportSeries(unitWith(makePorts({
      series: { list: async () => [baseSeries] },
      editions: { listBySeries: async () => [edition] },
      source: { getMany: async () => [{ ...source, allowSearchIndexing: false }] },
    })), baseSeries.slug!);
    assert.ok(result);
    assert.equal(result.visibility, 'unlisted');
    assert.equal(result.indexable, false);
    assert.deepEqual(result.issues.map((issue) => issue.id), [edition.id]);
  });

  test('public projection omits source ID and hides indexing-off issues', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const publicEdition = { ...baseEdition, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' };
    const ports = makePorts({
      series: { list: async () => [publicSeries] },
      editions: { listBySeries: async () => [publicEdition] },
      source: { getMany: async () => [{ ...source, allowSearchIndexing: false }] },
    });
    const result = await getPublicReportSeries(unitWith(ports), publicSeries.slug!);
    assert.ok(result);
    assert.equal(result.indexable, false);
    assert.deepEqual(result.issues, []);
  });

  test('public projection keeps seed-excluded issues visible but noindex', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const publicEdition = { ...baseEdition, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' };
    const result = await getPublicReportSeries(unitWith(makePorts({
      series: { list: async () => [publicSeries] },
      editions: { listBySeries: async () => [publicEdition] },
      source: { getMany: async () => [{ ...source, seedExcluded: true }] },
    })), publicSeries.slug!);
    assert.ok(result);
    assert.equal(result.indexable, false);
    assert.deepEqual(result.issues.map((issue) => issue.id), [publicEdition.id]);
  });

  test('public directory lists noindex public series and omits unlisted', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const publicEdition = { ...baseEdition, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' };
    const unlistedEdition = { ...baseEdition, id: 'edition-unlisted', state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' };
    const result = await listPublicReportDirectory(unitWith(makePorts({
      series: { listAll: async () => [publicSeries, baseSeries] },
      editions: {
        listBySeriesIds: async () => new Map([
          [publicSeries.id, [publicEdition]],
          [baseSeries.id, [unlistedEdition]],
        ]),
      },
      source: { getMany: async () => [{ ...source, seedExcluded: true }] },
    })), { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } }, 10);
    assert.deepEqual(result.items.map((item) => item.slug), [publicSeries.slug]);
    assert.equal(result.items[0]?.indexable, false);
    assert.equal(result.items[0]?.issues.length, 1);
  });

  test('public projection exposes the source slug but never the source ID', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const publicEdition = { ...baseEdition, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' };
    const ports = makePorts({
      series: { list: async () => [publicSeries] },
      editions: { listBySeries: async () => [publicEdition] },
      source: { getMany: async () => [source] },
    });
    const result = await getPublicReportSeries(unitWith(ports), publicSeries.slug!);
    assert.ok(result);
    const issue = result.issues.find((candidate) => candidate.id === publicEdition.id);
    assert.ok(issue);
    assert.equal(issue.sourceCollectionSlug, source.publicationSlug);
    assert.equal(Object.hasOwn(issue, 'sourceCollectionId'), false);
    assert.equal(JSON.stringify(issue).includes(source.collectionId), false);
  });

  test('public issue cursor uses publication time and invalidates on source revision change', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const };
    const editions: readonly DigestEdition[] = [
      { ...baseEdition, id: 'edition-2', editionOrdinal: 2, issueKey: 'two', state: 'published', publishedAt: '2026-01-02T00:00:00.000Z' },
      { ...baseEdition, state: 'published', publishedAt: '2026-01-01T00:00:00.000Z' },
    ];
    let currentSource = source;
    const ports = makePorts({
      series: { list: async () => [publicSeries] },
      editions: {
        listBySeries: async () => editions,
        publicProjectionRevision: async () => currentSource.contentRevision,
      },
      source: { getMany: async () => [currentSource] },
    });
    const config = { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } };
    const first = await listPublicReportIssues(unitWith(ports), publicSeries.slug!, config, 1);
    assert.ok(first?.nextCursor);
    assert.equal(first?.items[0]?.id, 'edition-2');
    const second = await listPublicReportIssues(unitWith(ports), publicSeries.slug!, config, undefined, first!.nextCursor!);
    assert.equal(second?.items[0]?.id, 'edition-1');
    currentSource = { ...source, contentRevision: 'content-2' };
    await assert.rejects(
      () => listPublicReportIssues(unitWith(ports), publicSeries.slug!, config, 1, first!.nextCursor!),
      (error: unknown) => error instanceof Error && ((error as { code?: unknown }).code === 'invalid_cursor' || error.message === 'invalid_cursor' || error.message === 'invalid cursor'),
    );
  });

  test('draft and withdrawn history beyond 2,000 rows cannot disable public report reads', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const published = { ...baseEdition, id: 'edition-live', state: 'published' as const,
      publishedAt: '2026-01-03T00:00:00.000Z', editionOrdinal: 2_002 };
    const historical = Array.from({ length: 2_001 }, (_, index): DigestEdition => ({
      ...baseEdition,
      id: `edition-history-${index}`,
      issueKey: `history-${index}`,
      editionOrdinal: index + 1,
      state: index % 2 === 0 ? 'draft' : 'withdrawn',
      publishedAt: index % 2 === 0 ? null : '2025-01-01T00:00:00.000Z',
    }));
    const all = [...historical, published];
    const ports = makePorts({
      series: { list: async () => [publicSeries], listAll: async () => [publicSeries] },
      editions: {
        findById: async (id) => id === published.id ? published : null,
        listBySeries: async () => all,
        listBySeriesIds: async () => new Map([[publicSeries.id, all]]),
      },
    });

    const projected = await getPublicReportSeries(unitWith(ports), publicSeries.slug!);
    assert.deepEqual(projected?.issues.map((issue) => issue.id), [published.id]);
    const direct = await getPublicReportIssue(unitWith(ports), publicSeries.slug!, published.id);
    assert.equal(direct?.issue.id, published.id);
    const directory = await listPublicReportDirectory(unitWith(ports),
      { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } }, 10);
    assert.deepEqual(directory.items[0]?.issues.map((issue) => issue.id), [published.id]);
  });

  test('public issue keyset reads continue beyond 2,000 published Editions', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const editions = Array.from({ length: 2_001 }, (_, index): DigestEdition => ({
      ...baseEdition,
      id: `edition-${String(2_001 - index).padStart(4, '0')}`,
      issueKey: `issue-${index}`,
      editionOrdinal: 2_001 - index,
      state: 'published',
      publishedAt: '2026-01-01T00:00:00.000Z',
    }));
    const requested: number[] = [];
    const ports = makePorts({
      series: { list: async () => [publicSeries] },
      editions: {
        publicProjectionRevision: async () => 'projection-1',
        listPublishedBySeries: async (_seriesId, limit, after) => {
          requested.push(limit);
          const start = after ? editions.findIndex((edition) => edition.id === after.id) + 1 : 0;
          return editions.slice(start, start + limit);
        },
      },
    });
    const config = { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } };
    const first = await listPublicReportIssues(unitWith(ports), publicSeries.slug!, config, 1);
    assert.equal(first?.items[0]?.id, 'edition-2001');
    assert.ok(first?.nextCursor);
    const second = await listPublicReportIssues(unitWith(ports), publicSeries.slug!, config, undefined, first!.nextCursor!);
    assert.equal(second?.items[0]?.id, 'edition-2000');
    assert.ok(requested.every((limit) => limit <= 201));
  });

  test('public projection exposes curator, follower count, and issue key facts', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const publicEdition = {
      ...baseEdition, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z',
      issueKey: '2026-W01', editionOrdinal: 7,
      periodStart: '2025-12-29T00:00:00.000Z', periodEnd: '2026-01-04T00:00:00.000Z',
    };
    const result = await getPublicReportSeries(unitWith(makePorts({
      series: { list: async () => [publicSeries] },
      editions: { listBySeries: async () => [publicEdition] },
      follows: { countActive: async () => 42 },
      ownerProfiles: {
        findManyByOwnerSubjectIds: async (ids) => new Map(ids.map((id) => [id, {
          profileId: 'profile-owner', handle: 'curator', displayName: 'Curator One', avatarUrl: null,
        }])),
      },
    })), publicSeries.slug!);
    assert.ok(result);
    assert.deepEqual(result.curator, {
      profileId: 'profile-owner', handle: 'curator', displayName: 'Curator One', avatarUrl: null,
    });
    assert.equal(result.followerCount, 42);
    assert.equal(result.sourceCollectionSlug, source.publicationSlug);
    const issue = result.issues[0];
    assert.ok(issue);
    assert.equal(issue.issueKey, '2026-W01');
    assert.equal(issue.editionOrdinal, 7);
    assert.equal(issue.periodStart, '2025-12-29T00:00:00.000Z');
    assert.equal(issue.periodEnd, '2026-01-04T00:00:00.000Z');
    assert.equal(JSON.stringify(result).includes('owner-1'), false);
  });

  test('public projection hides a series whose owner is publication-restricted', async () => {
    const restrictedSeries = {
      ...baseSeries,
      visibility: 'public' as const,
      ownerPublicationRestricted: true,
    } as DigestSeries;
    const result = await getPublicReportSeries(unitWith(makePorts({
      series: { list: async () => [restrictedSeries] },
    })), restrictedSeries.slug!);
    assert.equal(result, null);
  });

  test('public projection omits curator when the owner profile cannot be resolved', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const result = await getPublicReportSeries(unitWith(makePorts({
      series: { list: async () => [publicSeries] },
      ownerProfiles: { findManyByOwnerSubjectIds: async () => new Map() },
    })), publicSeries.slug!);
    assert.ok(result);
    assert.equal(result.curator, undefined);
    assert.equal(result.followerCount, undefined);
  });

  test('public directory resolves owners and follower counts through batch ports', async () => {
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    let ownerCalls = 0;
    let singularCountCalls = 0;
    const result = await listPublicReportDirectory(unitWith(makePorts({
      series: { listAll: async () => [publicSeries] },
      editions: { listBySeriesIds: async () => new Map([[publicSeries.id, []]]) },
      follows: {
        countActive: async () => { singularCountCalls += 1; return 1; },
        countActiveBySeriesIds: async () => new Map([[publicSeries.id, 9]]),
      },
      ownerProfiles: {
        findManyByOwnerSubjectIds: async (ids) => {
          ownerCalls += 1;
          return new Map(ids.map((id) => [id, {
            profileId: 'profile-owner', handle: 'curator', displayName: 'Curator One', avatarUrl: null,
          }]));
        },
      },
    })), { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } }, 10);
    assert.equal(result.items[0]?.curator?.handle, 'curator');
    assert.equal(result.items[0]?.followerCount, 9);
    assert.equal(ownerCalls, 1);
    assert.equal(singularCountCalls, 0);
  });

  test('public directory uses the batch edition seam instead of one query per series', async () => {
    let batchCalls = 0;
    let perSeriesCalls = 0;
    const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
    const publicEdition = { ...baseEdition, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' };
    const ports = makePorts({
      series: { listAll: async () => [publicSeries] },
      source: { publishedSourcesIndexableBySeriesIds: async () => new Map([[publicSeries.id, true]]) },
      editions: {
        listBySeries: async () => { perSeriesCalls += 1; return [publicEdition]; },
        listBySeriesIds: async () => { batchCalls += 1; return new Map([[publicSeries.id, [publicEdition]]]); },
      },
    });
    const result = await listPublicReportDirectory(unitWith(ports), { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } }, 1);
    assert.equal(result.items.length, 1);
    assert.equal(batchCalls, 1);
    assert.equal(perSeriesCalls, 0);
  });

  test.each(['delist', 'hide_public', 'private_source'] as const)(
    'directory fills visible issues past filtered %s candidates without adding tombstones', async (restriction) => {
      const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
      const editions: DigestEdition[] = Array.from({ length: 405 }, (_, index) => ({
        ...baseEdition, id: `filtered-${index}`, issueKey: `issue-${index}`, editionOrdinal: 405 - index,
        state: 'published', publishedAt: '2026-01-01T00:00:00.000Z',
        sourceCollectionId: index < 305 && restriction === 'private_source' ? 'private-source' : source.collectionId,
      }));
      const calls: number[] = [];
      const ports: ReportTransactionPorts = {
        ...makePorts({
          series: { list: async () => [publicSeries], listAll: async () => [publicSeries] },
          editions: {
            listPublishedBySeriesIds: async (_ids, limit) => new Map([[publicSeries.id, editions.slice(0, limit)]]),
            listPublishedBySeries: async (_id, limit, after) => {
              calls.push(limit);
              const start = after ? editions.findIndex(edition => edition.id === after.id) + 1 : 0;
              return editions.slice(start, start + limit);
            },
          },
          source: { getMany: async () => [source, { ...source, collectionId: 'private-source', visibility: 'private' }],
            publishedSourcesIndexableBySeriesIds: async () => new Map([[publicSeries.id, restriction !== 'private_source']]) },
        }),
        digestControl: {
          seriesControls: async () => new Map(),
          editionControls: async ids => new Map(ids.map(id => [id, {
            hidePublic: restriction === 'hide_public' && Number(id.split('-')[1]) < 305,
            delisted: restriction === 'delist' && Number(id.split('-')[1]) < 305,
          }])),
        },
      };
      const directory = await listPublicReportDirectory(unitWith(ports),
        { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } }, 10);
      assert.deepEqual(directory.items[0]?.issues.map(issue => issue.id), editions.slice(305).map(edition => edition.id));
      assert.equal(directory.items[0]?.sourceCollectionSlug, source.publicationSlug);
      assert.ok(directory.items[0]?.issues.every(issue => issue.state !== 'hidden'));
      assert.equal(calls.length, 2);
      assert.ok(calls.every(limit => limit <= 201), 'continuation must use bounded keyset pages');
    });

  test('public directory language filter is applied before paging and binds the cursor fence', async () => {
    const english = {
      ...baseSeries, id: 'series-en', slug: 'en-digest', visibility: 'public' as const,
      language: 'en', updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const french = {
      ...baseSeries, id: 'series-fr', slug: 'fr-digest', visibility: 'public' as const,
      language: 'fr', updatedAt: '2026-01-03T00:00:00.000Z',
    };
    const unknown = {
      ...baseSeries, id: 'series-und', slug: 'und-digest', visibility: 'public' as const,
      language: null, updatedAt: '2026-01-04T00:00:00.000Z',
    };
    const editions = new Map([
      [english.id, []],
      [french.id, []],
      [unknown.id, []],
    ]);
    const config = { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } };
    const ports = makePorts({
      series: { listAll: async () => [unknown, french, english] },
      editions: { listBySeriesIds: async () => editions },
    });
    const unfiltered = await listPublicReportDirectory(unitWith(ports), config, 1);
    assert.equal(unfiltered.items[0]?.slug, unknown.slug);
    const filtered = await listPublicReportDirectory(unitWith(ports), config, 1, undefined, 'en');
    assert.deepEqual(filtered.items.map((item) => item.slug), [english.slug]);
    assert.equal(filtered.nextCursor, null);
    await assert.rejects(
      () => listPublicReportDirectory(unitWith(ports), config, 1, unfiltered.nextCursor ?? undefined, 'en'),
      (error: unknown) => error instanceof Error && (error.message === 'invalid_cursor' || error.message === 'invalid cursor'),
    );
  });
});

test('indexability checks sources beyond the first scan batch', async () => {
  const publicSeries = { ...baseSeries, visibility: 'public' as const, allowSearchIndexing: true };
  const editions = Array.from({ length: 201 }, (_, i) => ({ ...baseEdition,
    id: `edition-${i}`, editionOrdinal: 201-i, state: 'published' as const,
    publishedAt: '2026-01-01T00:00:00.000Z', sourceCollectionId: `source-${i}` }));
  const ports = makePorts({
    series: { list: async () => [publicSeries], listAll: async () => [publicSeries] },
    editions: {
      findById: async (id) => editions.find(e => e.id === id) ?? null,
      listBySeries: async () => editions,
      listPublishedBySeries: async (_id, limit, after) => editions.slice(after ? editions.findIndex(e => e.id === after.id)+1 : 0).slice(0, limit),
    },
    source: { getMany: async (ids) => ids.map(id => ({ ...source, collectionId: id, seedExcluded: id === 'source-200' })) },
  });
  const result = await getPublicReportSeries(unitWith(ports), publicSeries.slug!);
  assert.ok(result);
  assert.equal(result.indexable, false);
  const direct = await getPublicReportIssue(unitWith(ports), publicSeries.slug!, editions[0]!.id);
  assert.equal(direct?.series.indexable, false);
  const directory = await listPublicReportDirectory(unitWith(ports),
    { active: { id: 'test', secret: Buffer.alloc(32, 7).toString('base64') } }, 10);
  assert.equal(directory.items[0]?.indexable, false);
});
