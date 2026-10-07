import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationInsightFactsPort,
  createPostgresPublicationInsightMaintenancePortFactory,
  createPostgresPublicationInsightStore,
  createVisitorHashPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  InsightConcealError,
  PUBLICATION_INSIGHT_PURGE_LIMIT,
  recordInsightEvent,
  schedulePublicationInsightPurge,
  type RecordInsightEventInput,
  type RecordInsightEventResult,
} from '../../../src/modules/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const PEPPER_A = Buffer.alloc(32, 11);
const PEPPER_B = Buffer.alloc(32, 17);
const COOKIE = 'anon-cookie-pi01';
const NOW = new Date('2026-08-18T12:00:00.000Z');

describeWithPostgres('publication insight postgres persistence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('pi01_insight_pg');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedFixtures(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('writes public and unlisted published live collections and skips owner', async () => {
    const publicWrite = await record(isolated, view('alpha-notes'));
    const unlistedWrite = await record(isolated, view('alpha-notes-unlisted', {
      eventType: 'preview_open',
    }));
    const ownerSkip = await record(isolated, view('alpha-notes', {
      visitor: { kind: 'subject', subjectId: 'owner-a' },
    }));
    const editorWrite = await record(isolated, view('alpha-notes', {
      visitor: { kind: 'subject', subjectId: 'editor-a' },
    }));
    const anonymousWrite = await record(isolated, view('alpha-notes', {
      visitor: { kind: 'anonymous', cookie: 'third-party' },
    }));
    assert.deepEqual(
      [publicWrite, unlistedWrite, ownerSkip, editorWrite, anonymousWrite],
      [
        { kind: 'written' },
        { kind: 'written' },
        { kind: 'skipped', reason: 'owner' },
        { kind: 'written' },
        { kind: 'written' },
      ],
    );

    const publicDaily = await dailyCount(isolated, 'col-alpha-a', 'collection_view');
    const unlistedDaily = await dailyCount(isolated, 'col-alpha-unlisted', 'preview_open');
    assert.equal(publicDaily, 3);
    assert.equal(unlistedDaily, 1);
    assert.equal(await eventCount(isolated, 'col-alpha-a', 'collection_view'), publicDaily);
    assert.equal(await eventCount(isolated, 'col-alpha-unlisted', 'preview_open'), unlistedDaily);
  });

  test('private, protected, deleted, and missing slug do not write', async () => {
    for (const slug of ['alpha-notes-private', 'alpha-notes-protected', 'alpha-notes-deleted', 'missing-slug']) {
      await assert.rejects(
        () => record(isolated, view(slug)),
        (error: unknown) => error instanceof InsightConcealError && error.code === 'conceal',
      );
    }
    assert.equal(await eventCount(isolated, 'col-alpha-private'), 0);
    assert.equal(await eventCount(isolated, 'col-alpha-protected'), 0);
    assert.equal(await eventCount(isolated, 'col-alpha-deleted'), 0);
    assert.equal(await dailyCount(isolated, 'col-alpha-private', 'collection_view'), 0);
  });

  test('owner A/B collections with similar titles and slugs do not cross-write', async () => {
    const beforeA = await eventCount(isolated, 'col-alpha-a', 'collection_view');
    const beforeB = await eventCount(isolated, 'col-alpha-b', 'collection_view');
    await record(isolated, view('alpha-notes-live'));
    assert.equal(await eventCount(isolated, 'col-alpha-b', 'collection_view'), beforeB + 1);
    assert.equal(await eventCount(isolated, 'col-alpha-a', 'collection_view'), beforeA);
    assert.equal(await dailyCount(isolated, 'col-alpha-b', 'collection_view'), beforeB + 1);
  });

  test('two concurrent increments accumulate daily count = 2', async () => {
    const first = record(isolated, view('alpha-notes-race', {
      visitor: { kind: 'anonymous', cookie: 'race-1' },
    }));
    const second = record(isolated, view('alpha-notes-race', {
      visitor: { kind: 'anonymous', cookie: 'race-2' },
    }));
    const results = await Promise.all([first, second]);
    assert.deepEqual(results, [{ kind: 'written' }, { kind: 'written' }]);
    assert.equal(await dailyCount(isolated, 'col-alpha-race', 'collection_view'), 2);
    assert.equal(await eventCount(isolated, 'col-alpha-race', 'collection_view'), 2);
  });

  test('UTC 23:59:59 and 00:00:00 fall into different days', async () => {
    const late = await record(isolated, view('alpha-notes-clock', {
      occurredAt: new Date('2026-03-15T23:59:59.000Z'),
      visitor: { kind: 'anonymous', cookie: 'clock-late' },
    }));
    const early = await record(isolated, view('alpha-notes-clock', {
      occurredAt: new Date('2026-03-16T00:00:00.000Z'),
      visitor: { kind: 'anonymous', cookie: 'clock-early' },
    }));
    assert.deepEqual([late, early], [{ kind: 'written' }, { kind: 'written' }]);
    const days = await isolated.runtime.pool.query<{ day: string }>(
      `select day::text as day from publication_insight_daily
        where collection_id = 'col-alpha-clock' and event_type = 'collection_view'
        order by day`,
    );
    assert.deepEqual(days.rows.map((row) => row.day), ['2026-03-15', '2026-03-16']);
  });

  test('different peppers produce different hashes', async () => {
    await record(isolated, view('alpha-notes-hash'), PEPPER_A);
    await record(isolated, view('alpha-notes-hash', {
      visitor: { kind: 'anonymous', cookie: COOKIE },
    }), PEPPER_B);
    const hashes = await isolated.runtime.pool.query<{ visitor_hash: Buffer }>(
      `select visitor_hash from publication_insight_events
        where collection_id = 'col-alpha-hash' order by occurred_at, id`,
    );
    assert.equal(hashes.rows.length, 2);
    for (const row of hashes.rows) {
      assert.equal(row.visitor_hash.length, 32);
    }
    const actual = new Set(hashes.rows.map((row) => row.visitor_hash.toString('hex')));
    const expectedA = createHmac('sha256', PEPPER_A).update(`anon|${COOKIE}`, 'utf8').digest('hex');
    const expectedB = createHmac('sha256', PEPPER_B).update(`anon|${COOKIE}`, 'utf8').digest('hex');
    assert.equal(actual.size, 2);
    assert.ok(actual.has(expectedA), 'pepper A digest must be stored');
    assert.ok(actual.has(expectedB), 'pepper B digest must be stored');
  });

  test('same-transaction event COUNT matches daily.count', async () => {
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const result = await recordInsightEvent({
        facts: createPostgresPublicationInsightFactsPort(transaction),
        store: createPostgresPublicationInsightStore(transaction),
        visitorHash: createVisitorHashPort(PEPPER_A),
      }, view('alpha-notes-txn', {
        visitor: { kind: 'anonymous', cookie: 'txn-1' },
      }));
      assert.deepEqual(result, { kind: 'written' });
      const events = await transaction
        .selectFrom('publication_insight_events')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('collection_id', '=', 'col-alpha-txn')
        .executeTakeFirstOrThrow();
      const daily = await transaction
        .selectFrom('publication_insight_daily')
        .select('count')
        .where('collection_id', '=', 'col-alpha-txn')
        .where('event_type', '=', 'collection_view')
        .executeTakeFirstOrThrow();
      assert.equal(Number(events.n), Number(daily.count));
      assert.equal(Number(daily.count), 1);
    });
  });

  test('resource_open for a live bookmark increments; folder, root, and foreign nodes skip', async () => {
    const live = await record(isolated, view('alpha-notes-nodes', {
      eventType: 'resource_open',
      nodeId: 'bm-alpha-nodes',
    }));
    const folder = await record(isolated, view('alpha-notes-nodes', {
      eventType: 'resource_open',
      nodeId: 'folder-alpha-nodes',
    }));
    const root = await record(isolated, view('alpha-notes-nodes', {
      eventType: 'resource_open',
      nodeId: 'root-alpha-nodes',
    }));
    const foreign = await record(isolated, view('alpha-notes-nodes', {
      eventType: 'resource_open',
      nodeId: 'bm-alpha-a',
    }));
    const deleted = await record(isolated, view('alpha-notes-nodes', {
      eventType: 'resource_open',
      nodeId: 'bm-alpha-nodes-deleted',
    }));
    assert.deepEqual(live, { kind: 'written' });
    assert.deepEqual([folder, root, foreign, deleted], [
      { kind: 'skipped', reason: 'node' },
      { kind: 'skipped', reason: 'node' },
      { kind: 'skipped', reason: 'node' },
      { kind: 'skipped', reason: 'node' },
    ]);
    assert.equal(await dailyCount(isolated, 'col-alpha-nodes', 'resource_open', 'bm-alpha-nodes'), 1);
    assert.equal(await eventCount(isolated, 'col-alpha-nodes', 'resource_open'), 1);
    assert.equal(await dailyCount(isolated, 'col-alpha-nodes', 'resource_open', 'folder-alpha-nodes'), 0);
    assert.equal(await dailyCount(isolated, 'col-alpha-a', 'resource_open', 'bm-alpha-a'), 0);
  });

  test('global purge is bounded by limit, deletes expired rows, and keeps unexpired rows', async () => {
    const expiredAt = new Date('2026-05-19T12:00:00.000Z');
    const retainedAt = new Date('2026-05-21T12:00:00.000Z');
    const cutoff = new Date('2026-05-20T12:00:00.000Z');
    const hash = Buffer.alloc(32, 3);
    for (let index = 0; index < 6; index += 1) {
      await isolated.runtime.pool.query(
        `insert into publication_insight_events
           (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
         values ($1, 'col-alpha-purge', 'collection_view', null, $2, $3)`,
        [`evt-expired-${index}`, hash, expiredAt],
      );
    }
    await isolated.runtime.pool.query(
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-retained', 'col-alpha-purge', 'collection_view', null, $1, $2)`,
      [hash, retainedAt],
    );
    for (let index = 0; index < 5; index += 1) {
      await isolated.runtime.pool.query(
        `insert into publication_insight_daily
           (collection_id, day, event_type, node_id, count)
         values ('col-alpha-purge', $1, 'collection_view', $2, 1)`,
        [`2026-05-1${index}`, `expired-${index}`],
      );
    }
    await isolated.runtime.pool.query(
      `insert into publication_insight_daily
         (collection_id, day, event_type, node_id, count)
       values ('col-alpha-purge', date '2026-05-21', 'collection_view', 'kept', 1)`,
    );

    const expiredEventsBefore = await expiredEventCount(isolated, cutoff);
    const expiredDailyBefore = await expiredDailyCount(isolated, '2026-05-20');
    const first = await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const store = createPostgresPublicationInsightStore(transaction);
      return store.purgeExpired(NOW, 3);
    });
    assert.deepEqual(first, { events: 3, daily: 3 });
    assert.equal(await expiredEventCount(isolated, cutoff), expiredEventsBefore - 3);
    assert.equal(await expiredDailyCount(isolated, '2026-05-20'), expiredDailyBefore - 3);

    const drained = await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const store = createPostgresPublicationInsightStore(transaction);
      return store.purgeExpired(NOW, PUBLICATION_INSIGHT_PURGE_LIMIT);
    });
    assert.equal(drained.events, expiredEventsBefore - 3);
    assert.equal(drained.daily, expiredDailyBefore - 3);
    assert.equal(await expiredEventCount(isolated, cutoff), 0);
    assert.equal(await expiredDailyCount(isolated, '2026-05-20'), 0);

    const retainedEvents = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events
        where collection_id = 'col-alpha-purge' and id = 'evt-retained'`,
    );
    const keptDaily = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_daily
        where collection_id = 'col-alpha-purge' and node_id = 'kept'`,
    );
    assert.equal(retainedEvents.rows[0]?.n, 1);
    assert.equal(keptDaily.rows[0]?.n, 1);
    assert.equal(PUBLICATION_INSIGHT_PURGE_LIMIT, 5000);
  });

  test('worker maintenance tick deletes expired insight rows', async () => {
    const expiredAt = new Date('2026-05-19T12:00:00.000Z');
    const retainedAt = new Date('2026-05-21T12:00:00.000Z');
    const hash = Buffer.alloc(32, 9);
    await isolated.runtime.pool.query(
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-worker-expired', 'col-alpha-purge', 'collection_view', null, $1, $2),
              ('evt-worker-retained', 'col-alpha-purge', 'collection_view', null, $1, $3)`,
      [hash, expiredAt, retainedAt],
    );
    await isolated.runtime.pool.query(
      `insert into publication_insight_daily
         (collection_id, day, event_type, node_id, count)
       values ('col-alpha-purge', date '2026-05-19', 'collection_view', 'worker-expired', 1),
              ('col-alpha-purge', date '2026-05-21', 'collection_view', 'worker-kept', 1)`,
    );
    const purged: Array<{ events: number; daily: number }> = [];
    const schedule = schedulePublicationInsightPurge(
      createPostgresPublicationInsightMaintenancePortFactory(isolated.runtime.db),
      {
        intervalMs: 20,
        batchSize: PUBLICATION_INSIGHT_PURGE_LIMIT,
        now: () => NOW,
        onPurged: (counts) => { purged.push(counts); },
      },
    );
    try {
      await waitForCondition(
        () => purged.some((counts) => counts.events > 0 || counts.daily > 0),
        { timeoutMs: 2_000, description: 'the publication insight purge tick to report deleted rows' },
      );
    } finally {
      await schedule.stop();
    }
    assert.ok(purged.some((counts) => counts.events > 0 || counts.daily > 0),
      'the worker tick must delete expired insight rows');
    const leftoverExpired = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events
        where id = 'evt-worker-expired'`,
    );
    const leftoverRetained = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events
        where id = 'evt-worker-retained'`,
    );
    assert.equal(leftoverExpired.rows[0]?.n, 0);
    assert.equal(leftoverRetained.rows[0]?.n, 1);
  });

  test('ingest write does not delete expired insight rows in the same unit of work', async () => {
    const expiredAt = new Date('2026-05-19T12:00:00.000Z');
    const cutoff = new Date('2026-05-20T12:00:00.000Z');
    const hash = Buffer.alloc(32, 7);
    await isolated.runtime.pool.query(
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-ingest-expired', 'col-alpha-purge', 'preview_open', null, $1, $2)`,
      [hash, expiredAt],
    );
    await isolated.runtime.pool.query(
      `insert into publication_insight_daily
         (collection_id, day, event_type, node_id, count)
       values ('col-alpha-purge', date '2026-05-19', 'preview_open', 'ingest-expired', 1)`,
    );
    const expiredEventsBefore = await expiredEventCount(isolated, cutoff);
    const expiredDailyBefore = await expiredDailyCount(isolated, '2026-05-20');

    const result = await record(isolated, view('alpha-notes-purge', {
      visitor: { kind: 'anonymous', cookie: 'ingest-no-purge' },
    }));
    assert.deepEqual(result, { kind: 'written' });
    assert.equal(await expiredEventCount(isolated, cutoff), expiredEventsBefore);
    assert.equal(await expiredDailyCount(isolated, '2026-05-20'), expiredDailyBefore);
    assert.equal(await eventCount(isolated, 'col-alpha-purge', 'collection_view') > 0, true);
  });

  test('log and error strings do not contain visitor hash hex', async () => {
    const logs: string[] = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const capture = (...args: unknown[]) => {
      logs.push(args.map((value) => stringify(value)).join(' '));
    };
    console.log = capture;
    console.info = capture;
    console.warn = capture;
    console.error = capture;
    try {
      const result = await record(isolated, view('alpha-notes-log'));
      assert.deepEqual(result, { kind: 'written' });
      await assert.rejects(
        () => record(isolated, view('missing-slug-log')),
        (error: unknown) => {
          logs.push(stringify(error));
          return error instanceof InsightConcealError;
        },
      );
      const stored = await isolated.runtime.pool.query<{ visitor_hash: Buffer }>(
        `select visitor_hash from publication_insight_events
          where collection_id = 'col-alpha-log' limit 1`,
      );
      const hex = stored.rows[0]?.visitor_hash.toString('hex');
      assert.ok(hex && hex.length === 64);
      const haystack = `${logs.join('\n')}\n${stringify(result)}`;
      assert.equal(haystack.includes(hex), false);
      assert.equal(haystack.toLowerCase().includes(`\\x${hex}`), false);
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
  });
});

async function record(
  runtime: IsolatedPostgresRuntime,
  input: RecordInsightEventInput,
  pepper: Uint8Array = PEPPER_A,
): Promise<RecordInsightEventResult> {
  return createUnitOfWork(runtime.runtime.db).execute(async ({ transaction }) => (
    recordInsightEvent({
      facts: createPostgresPublicationInsightFactsPort(transaction),
      store: createPostgresPublicationInsightStore(transaction),
      visitorHash: createVisitorHashPort(pepper),
    }, input)
  ));
}

function view(
  slug: string,
  overrides: Partial<RecordInsightEventInput> = {},
): RecordInsightEventInput {
  return {
    slug,
    eventType: 'collection_view',
    visitor: { kind: 'anonymous', cookie: COOKIE },
    occurredAt: NOW,
    ...overrides,
  };
}

async function eventCount(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  eventType?: string,
): Promise<number> {
  const result = eventType === undefined
    ? await runtime.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events where collection_id = $1`,
      [collectionId],
    )
    : await runtime.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events
        where collection_id = $1 and event_type = $2`,
      [collectionId, eventType],
    );
  return result.rows[0]?.n ?? 0;
}

async function dailyCount(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  eventType: string,
  nodeId = '',
): Promise<number> {
  const result = await runtime.runtime.pool.query<{ count: string }>(
    `select count from publication_insight_daily
      where collection_id = $1 and event_type = $2 and node_id = $3`,
    [collectionId, eventType, nodeId],
  );
  return result.rows[0] ? Number(result.rows[0].count) : 0;
}

async function expiredEventCount(
  runtime: IsolatedPostgresRuntime,
  cutoff: Date,
): Promise<number> {
  const result = await runtime.runtime.pool.query<{ n: number }>(
    `select count(*)::int as n from publication_insight_events where occurred_at < $1`,
    [cutoff],
  );
  return result.rows[0]?.n ?? 0;
}

async function expiredDailyCount(
  runtime: IsolatedPostgresRuntime,
  cutoffDay: string,
): Promise<number> {
  const result = await runtime.runtime.pool.query<{ n: number }>(
    `select count(*)::int as n from publication_insight_daily where day < $1::date`,
    [cutoffDay],
  );
  return result.rows[0]?.n ?? 0;
}

function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function seedFixtures(runtime: IsolatedPostgresRuntime): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    const collections: ReadonlyArray<{
      id: string;
      owner: string;
      title: string;
      visibility: 'private' | 'protected' | 'public' | 'unlisted';
      slug: string | null;
      deleted?: boolean;
      extraNodes?: ReadonlyArray<{
        id: string;
        kind: 'folder' | 'bookmark';
        title: string;
        url: string | null;
        position: string;
        deleted?: boolean;
      }>;
    }> = [
      {
        id: 'col-alpha-a', owner: 'owner-a', title: 'Alpha Notes', visibility: 'public',
        slug: 'alpha-notes', extraNodes: [
          { id: 'bm-alpha-a', kind: 'bookmark', title: 'A bookmark', url: 'https://example.test/a', position: 'A' },
        ],
      },
      {
        id: 'col-alpha-b', owner: 'owner-b', title: 'Alpha Notes', visibility: 'public',
        slug: 'alpha-notes-live',
      },
      {
        id: 'col-alpha-unlisted', owner: 'owner-a', title: 'Alpha Notes Unlisted', visibility: 'unlisted',
        slug: 'alpha-notes-unlisted',
      },
      {
        id: 'col-alpha-private', owner: 'owner-a', title: 'Alpha Notes Private', visibility: 'private',
        slug: null,
      },
      {
        id: 'col-alpha-protected', owner: 'owner-a', title: 'Alpha Notes Protected', visibility: 'protected',
        slug: 'alpha-notes-protected',
      },
      {
        id: 'col-alpha-deleted', owner: 'owner-a', title: 'Alpha Notes Deleted', visibility: 'public',
        slug: 'alpha-notes-deleted', deleted: true,
      },
      { id: 'col-alpha-race', owner: 'owner-a', title: 'Alpha Race', visibility: 'public', slug: 'alpha-notes-race' },
      { id: 'col-alpha-clock', owner: 'owner-a', title: 'Alpha Clock', visibility: 'public', slug: 'alpha-notes-clock' },
      { id: 'col-alpha-hash', owner: 'owner-a', title: 'Alpha Hash', visibility: 'public', slug: 'alpha-notes-hash' },
      { id: 'col-alpha-txn', owner: 'owner-a', title: 'Alpha Txn', visibility: 'public', slug: 'alpha-notes-txn' },
      { id: 'col-alpha-log', owner: 'owner-a', title: 'Alpha Log', visibility: 'public', slug: 'alpha-notes-log' },
      { id: 'col-alpha-purge', owner: 'owner-a', title: 'Alpha Purge', visibility: 'public', slug: 'alpha-notes-purge' },
      {
        id: 'col-alpha-nodes', owner: 'owner-a', title: 'Alpha Nodes', visibility: 'public',
        slug: 'alpha-notes-nodes', extraNodes: [
          { id: 'folder-alpha-nodes', kind: 'folder', title: 'Folder', url: null, position: 'A' },
          { id: 'bm-alpha-nodes', kind: 'bookmark', title: 'Live', url: 'https://example.test/live', position: 'B' },
          {
            id: 'bm-alpha-nodes-deleted', kind: 'bookmark', title: 'Gone',
            url: 'https://example.test/gone', position: 'C', deleted: true,
          },
        ],
      },
    ];
    for (const collection of collections) {
      const rootId = `root-${collection.id.slice(4)}`;
      const nodeIds = [rootId, ...(collection.extraNodes ?? []).map((node) => node.id)];
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type, committed_at)
         select * from unnest($1::text[], $2::text[], $3::timestamptz[])`,
        [
          [collection.id, ...nodeIds],
          ['collection', ...nodeIds.map(() => 'node')],
          Array.from({ length: nodeIds.length + 1 }, () => new Date()),
        ],
      );
      await client.query(
        `insert into collections(
           id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
           root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
           commit_ordinal, created_at, updated_at, deleted_at)
         values ($1,$2,$3,'bookmarks',$4,$5,$6,$7,true,'r1','c1','p1',1,
           current_timestamp,current_timestamp,$8)`,
        [
          collection.id,
          collection.owner,
          collection.title,
          collection.visibility,
          collection.slug,
          collection.slug === null ? null : NOW,
          rootId,
          collection.deleted ? NOW : null,
        ],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at, deleted_at)
         values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
           current_timestamp,current_timestamp,$3)`,
        [rootId, collection.id, collection.deleted ? NOW : null],
      );
      for (const node of collection.extraNodes ?? []) {
        await client.query(
          `insert into nodes(
             id, collection_id, parent_id, kind, is_root, title, url, position_token,
             resource_revision, children_revision, created_at, updated_at, deleted_at)
           values ($1,$2,$3,$4,false,$5,$6,$7,'r1','ch1',current_timestamp,current_timestamp,$8)`,
          [
            node.id, collection.id, rootId, node.kind, node.title, node.url, node.position,
            node.deleted ? NOW : null,
          ],
        );
      }
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
