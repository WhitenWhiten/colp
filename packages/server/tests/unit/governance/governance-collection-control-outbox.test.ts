import { capturePostgresSearchSql } from '../../support/search-candidate-sql-capture.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  GOVERNANCE_OUTBOX_BACKOFF_SECONDS,
  GOVERNANCE_OUTBOX_BATCH_SIZE,
  GOVERNANCE_OUTBOX_LEASE_SECONDS,
  GOVERNANCE_OUTBOX_MAX_ATTEMPTS,
} from '../../../src/modules/governance/domain/moderation-actions.js';
import {
  COLLECTION_DELIST_CONTROL_SQL,
  COLLECTION_DISCOVERY_CONTROL_SQL,
  accountRestrictPublicationExistsSql,
  collectionHidePublicControlSql,
  collectionHidePublicExistsSql,
} from '../../../src/infrastructure/governance/collection-control-sql.js';
import {
  GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE,
  GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION,
  GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME,
  GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE,
  GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION,
  GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
  GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE,
  GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION,
  GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE,
  GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION,
} from '../../../src/infrastructure/governance/postgres-moderation-outbox.js';
import { buildNotificationInboxPageStatement } from '../../../src/infrastructure/notifications/notification-inbox-query-postgres.js';
import {
  createGovernanceBookmarkControlRoutes,
  createGovernanceCollectionControlRoutes,
} from '../../../src/infrastructure/outbox/governance-collection-control.js';
import { PublicationCachePurgeProviderError } from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import {
  OutboxDeliveryError,
  type OutboxHandlerContext,
} from '../../../src/infrastructure/outbox/router.js';
import { buildExplorePageStatement } from '../../../src/infrastructure/publication/postgres-explore-page.js';
import { buildProfileSitemapStatement } from '../../../src/infrastructure/publication/postgres-profile-sitemap-read.js';
import { buildPublicationSitemapStatement } from '../../../src/infrastructure/publication/postgres-sitemap-read.js';
import { buildFeedPageStatement } from '../../../src/infrastructure/social/feed-query-postgres.js';

const ORIGIN = 'https://app.example.test';

function context(): OutboxHandlerContext {
  return {
    envelope: {
      event_id: 'evt_1',
      event_type: GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE,
      event_version: GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION,
      occurred_at: '2026-09-15T00:00:00.000Z',
      payload: {
        collectionId: 'col_1',
        actionId: 'act_1',
        action: 'hide_public',
        state: 'active',
        publicationSlug: 'hidden-notes',
      },
    } as OutboxHandlerContext['envelope'],
    idempotencyKey: 'k1',
    signal: new AbortController().signal,
  };
}

test('GOVERNANCE_OUTBOX constants match the contract batch/lease/backoff', () => {
  assert.equal(GOVERNANCE_OUTBOX_BATCH_SIZE, 100);
  assert.equal(GOVERNANCE_OUTBOX_LEASE_SECONDS, 30);
  assert.equal(GOVERNANCE_OUTBOX_MAX_ATTEMPTS, 10);
  assert.deepEqual([...GOVERNANCE_OUTBOX_BACKOFF_SECONDS], [1, 2, 4, 8, 16, 32, 60]);
});

test('worker.ts registers exactly one governance_collection_control consumer', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../src/bootstrap/worker.ts'),
    'utf8',
  );
  assert.equal([...source.matchAll(/createGovernanceCollectionControlRoutes\(/gu)].length, 1);
  assert.equal([...source.matchAll(/governanceCollectionControlEnvelopeRegistrations\(/gu)].length, 1);
  assert.equal([...source.matchAll(/createGovernanceBookmarkControlRoutes\(/gu)].length, 1);
  assert.equal([...source.matchAll(/governanceBookmarkControlEnvelopeRegistrations\(/gu)].length, 1);
});

test('MCP collection metadata composition wires collectionControl onto the shared query', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../src/bootstrap/api-mcp-surface-composition.ts'),
    'utf8',
  );
  assert.match(source, /metadataQuery:\s*\{[\s\S]*collectionControl:\s*createPostgresModerationActionMethods/u);
  assert.match(source, /createPhase4bMcpSnapshotResourceProjection\(\{[\s\S]*snapshotQuery:\s*publicationSnapshotQuery/u);
  assert.match(source, /createPhase4bMcpNodeResourceProjection\(\{[\s\S]*snapshotQuery:\s*publicationSnapshotQuery/u);
  // The MCP report read tools moved the series/directory reads out of the
  // surface composition; assert them where the report read port builds them.
  const readTools = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../src/modules/mcp/report-read-tools.ts'),
    'utf8',
  );
  assert.match(readTools, /getPublicReportSeries\(unitOfWork, selector.slug\)/u);
  assert.match(readTools, /listPublicReportDirectory\(unit, cursorConfig, limit, cursor\)/u);
});

test('discovery and derived-output SQL exclude collection controls before paging', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const explore = readFileSync(join(root, 'src/infrastructure/publication/postgres-explore-page.ts'), 'utf8');
  const directory = readFileSync(join(root, 'src/infrastructure/publication/postgres-directory-read.ts'), 'utf8');
  const sitemap = readFileSync(join(root, 'src/infrastructure/publication/postgres-sitemap-read.ts'), 'utf8');
  const feed = readFileSync(join(root, 'src/infrastructure/social/feed-query-postgres.ts'), 'utf8');
  const inbox = readFileSync(join(root, 'src/infrastructure/notifications/notification-inbox-query-postgres.ts'), 'utf8');
  // #21: Explore excludes delist outright but keeps hide_public as a
  // tombstone flag, so the discovery omission constant must not return.
  assert.match(explore, /COLLECTION_DELIST_CONTROL_SQL/u);
  assert.match(explore, /collectionHidePublicExistsSql/u);
  assert.equal(explore.includes('COLLECTION_DISCOVERY_CONTROL_SQL'), false);
  assert.match(directory, /COLLECTION_DISCOVERY_CONTROL_SQL/u);
  assert.match(sitemap, /COLLECTION_DISCOVERY_CONTROL_SQL/u);
  const capture = capturePostgresSearchSql();
  await capture.port.listAnonymousCandidates({ query: 'control', limit: 10 });
  const search = capture.queries.find(query => query.sql.includes('branch_collection_public AS'))?.sql;
  assert.ok(search, 'production search candidate SQL must be compiled');
  const branches = ['branch_collection_public', 'branch_node_public', 'branch_profile', 'branch_annotation_public'];
  for (const [index, name] of branches.entries()) {
    const start = search.indexOf(`${name} AS (`);
    const end = search.indexOf(`${branches[index + 1] ?? 'candidates'} AS (`, start + 1);
    assert.ok(start >= 0 && end > start, `${name} must have a bounded candidate branch`);
    const branch = search.slice(start, end);
    const control = COLLECTION_DISCOVERY_CONTROL_SQL.replaceAll('c.id', name === 'branch_profile' ? 'owned.id' : 'c.id');
    const predicateAt = branch.indexOf(control);
    const pagingAt = branch.indexOf('LIMIT ');
    assert.ok(predicateAt >= 0, `${name} must exclude active collection hide_public/delist`);
    assert.ok(pagingAt > predicateAt, `${name} must apply collection control before its page limit`);
    assert.match(branch.slice(0, pagingAt), /restrict_publication/,
      `${name} must also check owner publication restriction before paging`);
  }
  // #21: follower Feed rows keep hide_public collections as tombstones —
  // the exists flag is selected three times, the omission filter is gone.
  assert.equal([...feed.matchAll(/collectionHidePublicExistsSql/gu)].length >= 3, true);
  assert.equal(feed.includes('collectionHidePublicControlSql'), false);
  assert.match(inbox, /collectionHidePublicControlSql/u);
  assert.match(inbox, /collectionHidePublicExistsSql/u);
  const followLock = readFileSync(join(root, 'src/infrastructure/social/follow-command-postgres.ts'), 'utf8');
  const collectionFollowLock = readFileSync(join(root, 'src/infrastructure/social/collection-follow-command-postgres.ts'), 'utf8');
  const digestFollowLock = readFileSync(join(root, 'src/infrastructure/reports/repositories.ts'), 'utf8');
  const profileProjection = readFileSync(join(root, 'src/bootstrap/public-profile-projection.ts'), 'utf8');
  const avatarOrigin = readFileSync(join(root, 'src/transport/auth/browser-auth-handlers.ts'), 'utf8');
  const exploreCreators = readFileSync(join(root, 'src/infrastructure/identity/postgres-explore-creators-query.ts'), 'utf8');
  const profileSitemap = readFileSync(join(root, 'src/infrastructure/publication/postgres-profile-sitemap-read.ts'), 'utf8');
  const publicActivity = readFileSync(join(root, 'src/infrastructure/social/public-activity-query-postgres.ts'), 'utf8');
  const searchCandidate = readFileSync(join(root, 'src/infrastructure/search/postgres-search-candidate.ts'), 'utf8');
  assert.match(followLock, /accountRestrictInteractionExistsSql/u);
  assert.match(collectionFollowLock, /accountRestrictInteractionExistsSql/u);
  assert.match(digestFollowLock, /accountRestrictInteractionExistsSql/u);
  assert.match(profileProjection, /restrictPublication/u);
  assert.match(avatarOrigin, /avatarPublicAccess/u);
  assert.match(exploreCreators, /accountRestrictPublicationExistsSql/u);
  assert.match(profileSitemap, /accountRestrictPublicationExistsSql/u);
  assert.match(profileSitemap, /COLLECTION_DISCOVERY_CONTROL_SQL/u);
  assert.match(publicActivity, /accountRestrictPublicationExistsSql/u);
  assert.match(feed, /accountRestrictPublicationExistsSql/u);
  assert.match(searchCandidate, /accountRestrictPublicationExistsSql/u);
  const reports = readFileSync(join(root, 'src/infrastructure/reports/repositories.ts'), 'utf8');
  const publicQuery = readFileSync(join(root, 'src/modules/reports/application/public-query.ts'), 'utf8');
  // #21: followed digest feeds select hide_public as a tombstone flag —
  // the old omission filter must not come back.
  assert.match(reports, /digestSeriesHidePublicExistsSql/u);
  assert.equal(reports.includes('DIGEST_SERIES_HIDE_PUBLIC_SQL'), false);
  assert.match(reports, /digestEditionHidePublicExistsSql/u);
  assert.match(reports, /collectionHidePublicControlSql/u);
  assert.match(reports, /collectionHidePublicExistsSql/u);
  assert.match(publicQuery, /loadDigestSeriesControls/u);
  assert.match(publicQuery, /isEditionPubliclyDirect/u);
});

test('compiled discovery SQL interpolates collection-control helpers', () => {
  const explore = buildExplorePageStatement(
    { filter: {}, sort: 'updated', limit: 10 },
    { fromDayInclusive: '2026-01-01', toDayExclusive: '2026-01-31' },
  );
  // #21: Explore keeps hide_public rows as inert tombstones in place, so its
  // compiled SQL carries the delist-only exclusion plus the hide flag exists
  // fragment; the combined discovery exclusion must not return here.
  assert.equal(explore.text.includes(COLLECTION_DELIST_CONTROL_SQL), true);
  assert.equal(explore.text.includes(collectionHidePublicExistsSql('c.id')), true);
  assert.equal(explore.text.includes(COLLECTION_DISCOVERY_CONTROL_SQL), false);
  assert.equal(buildPublicationSitemapStatement().text.includes(COLLECTION_DISCOVERY_CONTROL_SQL), true);
  const profileSitemap = buildProfileSitemapStatement();
  assert.equal(profileSitemap.text.includes(COLLECTION_DISCOVERY_CONTROL_SQL), true);
  assert.equal(profileSitemap.text.includes(accountRestrictPublicationExistsSql('a.id')), true);
  const feed = buildFeedPageStatement({ principalId: 'recipient', limit: 10 });
  assert.equal(feed.text.includes(collectionHidePublicExistsSql('collection.id')), true);
  assert.equal(feed.text.includes(collectionHidePublicControlSql('collection')), false);
  assert.equal(feed.text.includes(accountRestrictPublicationExistsSql('item.actor_profile_id')), true);
  const feedFollowers = buildFeedPageStatement({ principalId: 'recipient', limit: 10 },
    { includeCollectionFollowers: true });
  assert.equal(feedFollowers.text.includes(collectionHidePublicExistsSql('collection.id')), true);
  assert.equal(feedFollowers.text.includes(collectionHidePublicControlSql('collection')), false);
  const inbox = buildNotificationInboxPageStatement({ principalId: 'recipient', limit: 10 });
  assert.equal(inbox.text.includes(collectionHidePublicControlSql('collection')), true);
  assert.equal(inbox.text.includes(collectionHidePublicExistsSql('notification.subject_id')), true);
});

test('snapshot and search SQL honor bookmark hide/delist before paging', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const search = readFileSync(join(root, 'src/infrastructure/search/postgres-search-candidate.ts'), 'utf8');
  const snapshot = readFileSync(join(root, 'src/infrastructure/publication/postgres-snapshot-read.ts'), 'utf8');
  const authority = readFileSync(join(root, 'src/infrastructure/search/postgres-search-authority.ts'), 'utf8');
  const favicon = readFileSync(join(root, 'src/transport/product/bookmark-favicon-routes.ts'), 'utf8');
  const nodeCount = readFileSync(join(root, 'src/infrastructure/publication/postgres-directory-read.ts'), 'utf8');
  assert.match(snapshot, /bookmarkHidePublicExistsSql/u);
  assert.match(search, /bookmarkDiscoveryExistsSql/u);
  assert.match(authority, /bookmarkDiscoveryExistsSql/u);
  assert.match(favicon, /faviconPublicAccess/u);
  assert.match(nodeCount, /async loadByPublicationSlug[\s\S]*bookmarkHidePublicExistsSql/u);
});

test('purge failure is retryable and a later attempt can succeed', async () => {
  let attempts = 0;
  const routes = createGovernanceCollectionControlRoutes({
    provider: {
      async purge() {
        attempts += 1;
        if (attempts === 1) {
          throw new PublicationCachePurgeProviderError('retryable', 'cdn timeout');
        }
      },
    },
    publicationOrigin: ORIGIN,
    productOrigin: ORIGIN,
  });
  assert.equal(routes.length, 3);
  assert.equal(routes[0]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
  assert.equal(routes[1]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
  assert.equal(routes[1]?.eventType, GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE);
  assert.equal(routes[2]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
  assert.equal(routes[2]?.eventType, GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE);
  await assert.rejects(
    () => routes[0]!.handle(context()),
    (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
  );
  await routes[0]!.handle(context());
  assert.equal(attempts, 2);
});

test('bookmark control consumer purges collection and favicon URLs and retries', async () => {
  let attempts = 0;
  let purged: string[] = [];
  const routes = createGovernanceBookmarkControlRoutes({
    provider: {
      async purge(input) {
        attempts += 1;
        purged = [...input.urls];
        if (attempts === 1) {
          throw new PublicationCachePurgeProviderError('retryable', 'cdn timeout');
        }
      },
    },
    publicationOrigin: ORIGIN,
    productOrigin: ORIGIN,
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.handlerName, GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME);
  const bookmarkContext: OutboxHandlerContext = {
    envelope: {
      event_id: 'evt_b1',
      event_type: GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE,
      event_version: GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION,
      occurred_at: '2026-09-15T00:00:00.000Z',
      payload: {
        collectionId: 'col_1',
        nodeId: 'node_1',
        actionId: 'act_1',
        action: 'hide_public',
        state: 'active',
        publicationSlug: 'hidden-notes',
        faviconObjectId: '11111111-1111-4111-8111-111111111111',
      },
    } as OutboxHandlerContext['envelope'],
    idempotencyKey: 'k-b1',
    signal: new AbortController().signal,
  };
  await assert.rejects(
    () => routes[0]!.handle(bookmarkContext),
    (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
  );
  await routes[0]!.handle(bookmarkContext);
  assert.equal(attempts, 2);
  assert.equal(purged.some((url) => url.includes('/api/v1/favicon/11111111-1111-4111-8111-111111111111')), true);
  assert.equal(purged.some((url) => url.includes('/share/hidden-notes')), true);
});

test('digest control reuses the collection consumer and purges report URLs', async () => {
  let attempts = 0;
  let purged: string[] = [];
  const routes = createGovernanceCollectionControlRoutes({
    provider: {
      async purge(input) {
        attempts += 1;
        purged = [...input.urls];
        if (attempts === 1) {
          throw new PublicationCachePurgeProviderError('retryable', 'cdn timeout');
        }
      },
    },
    publicationOrigin: ORIGIN,
    productOrigin: ORIGIN,
  });
  const digestRoute = routes.find((route) => route.eventType === GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE);
  assert.equal(digestRoute?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
  const digestContext: OutboxHandlerContext = {
    envelope: {
      event_id: 'evt_d1',
      event_type: GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE,
      event_version: GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION,
      occurred_at: '2026-09-15T00:00:00.000Z',
      payload: {
        seriesId: 'ser_1',
        editionId: 'ed_1',
        actionId: 'act_1',
        action: 'hide_public',
        state: 'active',
        seriesSlug: 'weekly-digest',
      },
    } as OutboxHandlerContext['envelope'],
    idempotencyKey: 'k-d1',
    signal: new AbortController().signal,
  };
  await assert.rejects(
    () => digestRoute!.handle(digestContext),
    (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
  );
  await digestRoute!.handle(digestContext);
  assert.equal(attempts, 2);
  assert.equal(purged.some((url) => url.includes('/api/v1/public-reports/weekly-digest/issues/ed_1')), true);
  assert.equal(purged.some((url) => url.includes('/reports/weekly-digest')), true);
  assert.equal(purged.some((url) => url.includes('/sitemap-reports.xml')), true);
});

test('account control consumer purges profile and avatar URLs on the shared handler', async () => {
  let purged: string[] = [];
  const routes = createGovernanceCollectionControlRoutes({
    provider: {
      async purge(input) { purged = [...input.urls]; },
    },
    publicationOrigin: ORIGIN,
    productOrigin: ORIGIN,
  });
  const accountRoute = routes.find((route) => route.eventType === GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE);
  assert.equal(accountRoute?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
  assert.equal(accountRoute?.eventVersion, GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION);
  await accountRoute!.handle({
    envelope: {
      event_id: 'evt_a1',
      event_type: GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE,
      event_version: GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION,
      occurred_at: '2026-09-16T00:00:00.000Z',
      payload: {
        accountId: 'acc_1',
        actionId: 'act_1',
        action: 'restrict_publication',
        state: 'active',
        handle: 'spamfarm',
        avatarObjectId: '123e4567-e89b-42d3-a456-426614174000',
      },
    } as OutboxHandlerContext['envelope'],
    idempotencyKey: 'k-a1',
    signal: new AbortController().signal,
  });
  assert.equal(purged.some((url) => url.includes('/api/v1/profiles/spamfarm')), true);
  assert.equal(purged.some((url) => url.includes('/u/spamfarm')), true);
  assert.equal(purged.some((url) => url.includes('/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000')), true);
});
