import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { createDatabase, createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { ensurePgTrgm } from '../../../migrations/202607251000_postgres_search_baseline.js';
import { extractSearchUrlHost } from '../../../src/modules/search/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import {
  loadSearchQualityCorpus,
  runPostgresSearchBaselineEvidence,
  type PostgresSearchBaselineEvidence,
} from '../../../scripts/evidence/search-postgres-baseline.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  requireTestDatabaseUrl,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PRE_SEARCH_MIGRATION = '202607250900_reading_progress';
const SEARCH_MIGRATION = '202607251000_postgres_search_baseline';

describeWithPostgres('PostgreSQL Search baseline migration and candidates', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_baseline', {
      maxConnections: 4,
      applicationName: 'known-search-baseline-contract',
    });
  });

  afterAll(async () => isolated?.close());

  test('migrates an empty database and upgrades legacy URLs through the standard URL parser', async () => {
    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const prior = await migrator.migrateTo(PRE_SEARCH_MIGRATION);
    if (prior.error) throw prior.error;
    await seedLegacyCollection(isolated, 'legacy-public', 'public', [
      ['legacy-valid', 'Valid host', 'https://API.Example.COM:8443/private?q=secret'],
      ['legacy-invalid', 'Invalid host', 'not a URL'],
    ]);

    const migrated = await migrator.migrateTo(SEARCH_MIGRATION);
    if (migrated.error) throw migrated.error;
    assert.deepEqual(migrated.results?.map((item) => item.migrationName), [SEARCH_MIGRATION]);

    const extension = await isolated.runtime.pool.query<{ extname: string; extversion: string }>(
      "select extname,extversion from pg_extension where extname='pg_trgm'",
    );
    assert.equal(extension.rowCount, 1);
    assert.ok(extension.rows[0]?.extversion);
    const rows = await isolated.runtime.pool.query<{
      id: string; search_url_host: string | null; search_vector: string; allow_search_indexing: boolean;
    }>(`select n.id,n.search_url_host,n.search_vector::text,c.allow_search_indexing
        from nodes n join collections c on c.id=n.collection_id
        where n.id in ('legacy-valid','legacy-invalid') order by n.id`);
    assert.deepEqual(rows.rows.map((row) => ({ id: row.id, host: row.search_url_host })), [
      { id: 'legacy-invalid', host: null },
      { id: 'legacy-valid', host: 'api.example.com' },
    ]);
    assert.ok(rows.rows.every((row) => row.search_vector.length > 0));
    assert.ok(rows.rows.every((row) => row.allow_search_indexing === false));

    const generated = await isolated.runtime.pool.query<{
      table_name: string; column_name: string; is_generated: string; generation_expression: string;
    }>(`select table_name,column_name,is_generated,generation_expression
        from information_schema.columns
        where table_schema=current_schema()
          and table_name in ('collections','nodes')
          and column_name in ('search_text','search_vector')
        order by table_name,column_name`);
    assert.equal(generated.rowCount, 4);
    assert.ok(generated.rows.every((row) => row.is_generated === 'ALWAYS'));
    assert.ok(generated.rows.every((row) => row.generation_expression.length > 0));
    const volatility = await isolated.runtime.pool.query<{ proname: string; provolatile: string }>(
      `select proname,provolatile from pg_proc
       where proname in ('normalize','lower','to_tsvector') order by proname,oid`,
    );
    assert.ok(volatility.rows.filter((row) => row.proname === 'normalize').every((row) => row.provolatile === 'i'));

    const downgraded = await migrator.migrateTo(PRE_SEARCH_MIGRATION);
    if (downgraded.error) throw downgraded.error;
    const absent = await isolated.runtime.pool.query<{ count: string }>(`select count(*)::text as count
      from information_schema.columns where table_schema=current_schema()
        and column_name in ('allow_search_indexing','search_text','search_vector','search_url_host')
        and table_name in ('collections','nodes')`);
    assert.equal(absent.rows[0]?.count, '0');
    const remigrated = await migrator.migrateTo(SEARCH_MIGRATION);
    if (remigrated.error) throw remigrated.error;
    const remigratedHost = await isolated.runtime.pool.query<{ search_url_host: string | null }>(
      `select search_url_host from nodes where id='legacy-valid'`,
    );
    assert.equal(remigratedHost.rows[0]?.search_url_host, 'api.example.com');
    // The search migration deliberately accepts historical invalid URLs so it can
    // backfill a null host. Later canonical-payload migrations correctly reject a
    // malformed *live* bookmark, so retain the legacy row only as a tombstone.
    await isolated.runtime.pool.query(
      `update nodes set deleted_at=current_timestamp where id='legacy-invalid'`,
    );
    const latest = await migrator.migrateToLatest();
    if (latest.error) throw latest.error;
  });

  test('fails closed with an actionable diagnostic when pg_trgm cannot be installed', async () => {
    const adminUrl = new URL(requireTestDatabaseUrl());
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const databaseName = `search_noext_${suffix}`;
    const roleName = `search_role_${suffix}`;
    const password = `Known-${suffix}-NoExt`;
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try {
      await admin.query(`create role ${roleName} login password '${password}'`);
      await admin.query(`create database ${databaseName}`);
      const restrictedUrl = new URL(adminUrl);
      restrictedUrl.username = roleName;
      restrictedUrl.password = password;
      restrictedUrl.pathname = `/${databaseName}`;
      const restricted = createDatabase(restrictedUrl.toString(), { maxConnections: 1 });
      try {
        await assert.rejects(
          ensurePgTrgm(restricted.db),
          /pg_trgm is required for Phase 2B search.*database owner.*CREATE EXTENSION/isu,
        );
      } finally {
        await restricted.close();
      }
    } finally {
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1`, [databaseName]);
      await admin.query(`drop database if exists ${databaseName}`);
      await admin.query(`drop role if exists ${roleName}`);
      await admin.end();
    }
  }, 30_000);

  test('fails closed when pg_trgm is installed outside public', async () => {
    const adminUrl = new URL(requireTestDatabaseUrl());
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const databaseName = `search_wrong_schema_${suffix}`;
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try {
      await admin.query(`create database ${databaseName}`);
      const targetUrl = new URL(adminUrl);
      targetUrl.pathname = `/${databaseName}`;
      const targetAdmin = new Pool({ connectionString: targetUrl.toString(), max: 1 });
      try {
        await targetAdmin.query('create schema search_extension');
        await targetAdmin.query('create extension pg_trgm with schema search_extension');
      } finally {
        await targetAdmin.end();
      }
      const target = createDatabase(targetUrl.toString(), { maxConnections: 1 });
      try {
        await assert.rejects(
          ensurePgTrgm(target.db),
          /pg_trgm is required for Phase 2B search in schema public.*will not fall back/isu,
        );
      } finally {
        await target.close();
      }
    } finally {
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1`, [databaseName]);
      await admin.query(`drop database if exists ${databaseName}`);
      await admin.end();
    }
  }, 30_000);

  test('filters authority in candidate SQL and covers quality, normalization, ties, and paging', async () => {
    await runMigrations(isolated.runtime.db, 'latest');
    await seedQualityAndVisibilityCorpus(isolated);
    const port = createPostgresSearchCandidatePort(isolated.runtime.db);

    const hidden = await port.listAnonymousCandidates({ query: 'xqzv94731privatemarker', limit: 100 });
    assert.deepEqual(hidden.items, []);

    for (const query of ['', '  ', '\r\n']) {
      const empty = await port.listAnonymousCandidates({ query, limit: 20 });
      assert.deepEqual(empty, { items: [], hasMore: false });
    }

    const corpus = loadSearchQualityCorpus();
    for (const qualityCase of corpus.cases) {
      const result = await port.listAnonymousCandidates({ query: qualityCase.query, limit: qualityCase.topN });
      const ids = new Set(result.items.map((item) => item.resourceId));
      const recalled = qualityCase.expectedTopN.filter((id) => ids.has(id)).length;
      const recall = recalled / qualityCase.expectedTopN.length;
      assert.ok(
        recall >= qualityCase.minimumRecall,
        `${qualityCase.query} recall ${recall} below ${qualityCase.minimumRecall}: ${[...ids].join(',')}`,
      );
    }

    const normalized = await port.listAnonymousCandidates({ query: 'CAFÉ', limit: 10 });
    assert.ok(normalized.items.some((item) => item.resourceId === 'n-unicode'));
    const special = await port.listAnonymousCandidates({ query: `" : | & ! ( ) <-> % _ \\`, limit: 10 });
    assert.ok(Array.isArray(special.items));

    const all: string[] = [];
    let after: Parameters<typeof port.listAnonymousCandidates>[0]['after'];
    do {
      const page = await port.listAnonymousCandidates({ query: 'deterministic tie', limit: 1, ...(after ? { after } : {}) });
      all.push(...page.items.map((item) => `${item.resourceType}:${item.resourceId}`));
      after = page.hasMore ? page.items.at(-1)?.exclusive : undefined;
    } while (after);
    assert.deepEqual(all, ['node:n-tie-a', 'node:n-tie-b']);
    assert.equal(new Set(all).size, all.length);
  }, 60_000);
});

describeWithPostgres('PostgreSQL Search baseline target-scale evidence', () => {
  let isolated: IsolatedPostgresRuntime;
  let evidence: PostgresSearchBaselineEvidence;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_evidence', {
      maxConnections: 4,
      applicationName: 'known-search-baseline-evidence',
      statementTimeoutMs: 60_000,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    evidence = await runPostgresSearchBaselineEvidence(isolated.runtime);
    console.info(JSON.stringify(evidence, null, 2));
  }, 300_000);

  afterAll(async () => isolated?.close());

  test('records reproducible environment, data distribution, cold/warm method, and thresholds', () => {
    assert.ok(evidence.environment.nodeCount >= 20_000);
    assert.ok(evidence.environment.nodesPerCollection >= 10_000);
    assert.equal(evidence.method.parallelWorkers, 0);
    assert.equal(evidence.method.cacheRegime, 'cold-first-then-warm');
    assert.ok(evidence.environment.node);
    assert.ok(evidence.environment.os);
    assert.ok(evidence.environment.cpu);
    assert.ok(evidence.environment.postgresVersion);
    assert.equal(evidence.pass.environment, true);
  });

  test('passes fixed quality thresholds rather than a non-empty assertion', () => {
    assert.ok(evidence.quality.length >= 8);
    assert.ok(evidence.quality.every((item) => item.recall >= item.minimumRecall));
    assert.equal(evidence.pass.quality, true);
  });

  test('uses search indexes without scanning the target-scale Node relation for first, middle, and final tuples', () => {
    assert.deepEqual(evidence.plans.map((plan) => plan.location), ['first', 'middle', 'final']);
    for (const plan of evidence.plans) {
      assert.ok(plan.indexNames.some((name) => name.includes('search')));
      assert.equal(plan.hasNodesSequentialScan, false);
      assert.equal(plan.hasSortAboveCandidateLimit, false);
      assert.ok(plan.executionMs <= evidence.thresholds.planExecutionMs);
    }
    assert.equal(evidence.pass.plans, true);
  });

  test('meets cold landmarks and controlled warm p95 latency', () => {
    assert.ok(evidence.latency.coldFirstMs <= evidence.thresholds.coldLandmarkMs);
    assert.ok(evidence.latency.coldMiddleMs <= evidence.thresholds.coldLandmarkMs);
    assert.ok(evidence.latency.coldFinalMs <= evidence.thresholds.coldLandmarkMs);
    assert.ok(evidence.latency.warmP95Ms <= evidence.thresholds.warmP95Ms);
    assert.equal(evidence.latency.concurrentSamplesMs.length,
      evidence.thresholds.concurrentClients * evidence.thresholds.concurrentRunsPerClient);
    assert.ok(evidence.latency.concurrentP95Ms <= evidence.thresholds.concurrentP95Ms);
    assert.equal(evidence.pass.latency, true);
    assert.equal(evidence.pass.overall, true);
  });
});

async function seedLegacyCollection(
  isolated: IsolatedPostgresRuntime,
  collectionId: string,
  visibility: 'public' | 'unlisted' | 'protected' | 'private',
  nodes: ReadonlyArray<readonly [string, string, string | null]>,
): Promise<void> {
  const rootId = `${collectionId}-root`;
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into accounts(id,subject_id,status)
      values ('search-fixture-owner','owner','active')
      on conflict (id) do nothing`);
    await client.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')`, [collectionId, rootId]);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
      root_node_id,resource_revision,content_revision,policy_revision)
      values ($1,'owner','Legacy','bookmarks',$2,$3,$4,$5,'r1','c1','p1')`, [
      collectionId, visibility,
      visibility === 'public' || visibility === 'unlisted' ? collectionId : null,
      visibility === 'public' || visibility === 'unlisted' ? new Date('2026-07-25T00:00:00Z') : null,
      rootId,
    ]);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
      values($1,$2,'folder',true,'Root','r1','ch1')`, [rootId, collectionId]);
    for (const [id, title, url] of nodes) {
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'node')`, [id]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,title,url,position_token,resource_revision,children_revision)
        values($1,$2,$3,$6,$4,$5,$1,'r1','ch1')`, [id, collectionId, rootId, title, url, url === null ? 'folder' : 'bookmark']);
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedQualityAndVisibilityCorpus(isolated: IsolatedPostgresRuntime): Promise<void> {
  const corpus = loadSearchQualityCorpus();
  const collectionIds = [...new Set(corpus.documents.map((item) => item.collectionId))];
  for (const collectionId of collectionIds) {
    const collection = corpus.documents.find((item) => item.resourceType === 'collection' && item.resourceId === collectionId)!;
    const nodes = corpus.documents.filter((item) => item.resourceType === 'node' && item.collectionId === collectionId)
      .map((item) => [item.resourceId, item.title, item.url] as const);
    await seedLegacyCollection(isolated, collectionId, 'public', nodes);
    await isolated.runtime.pool.query(`update collections set title=$2,summary=$3,allow_search_indexing=true where id=$1`,
      [collectionId, collection.title, collection.description]);
  }
  await isolated.runtime.pool.query(`update nodes n set description=v.description
    from (values ${corpus.documents.filter((item) => item.resourceType === 'node').map((_, index) => `($${index * 2 + 1}::text,$${index * 2 + 2}::text)`).join(',')}) as v(id,description)
    where n.id=v.id`, corpus.documents.filter((item) => item.resourceType === 'node').flatMap((item) => [item.resourceId, item.description]));
  for (const node of corpus.documents.filter((item) => item.resourceType === 'node')) {
    await isolated.runtime.pool.query(`update nodes set search_url_host=$2 where id=$1`, [
      node.resourceId, extractSearchUrlHost(node.url),
    ]);
  }

  for (const [id, visibility, optIn] of [
    ['hidden-optout', 'public', false],
    ['hidden-unlisted', 'unlisted', true],
    ['hidden-private', 'private', true],
    ['hidden-protected', 'protected', true],
  ] as const) {
    await seedLegacyCollection(isolated, id, visibility,
      [[`${id}-node`, 'xqzv94731privatemarker', 'https://hidden.example.test']]);
    await isolated.runtime.pool.query(`update collections set allow_search_indexing=$2 where id=$1`, [id, optIn]);
  }
  await seedLegacyCollection(isolated, 'tie-collection', 'public', [
    ['n-tie-a', 'deterministic tie', 'https://tie.example.test/a'],
    ['n-tie-b', 'deterministic tie', 'https://tie.example.test/b'],
  ]);
  await isolated.runtime.pool.query(`update collections set allow_search_indexing=true where id='tie-collection'`);

  await seedLegacyCollection(isolated, 'ancestor-collection', 'public', [
    ['ancestor-restricted', 'Restricted folder', null],
    ['ancestor-child', 'xqzv94731privatemarker', 'https://hidden.example.test/ancestor'],
  ]);
  await isolated.runtime.pool.query(`update collections set allow_search_indexing=true where id='ancestor-collection'`);
  await isolated.runtime.pool.query(`update nodes set kind='folder',url=null,visibility='protected' where id='ancestor-restricted'`);
  await isolated.runtime.pool.query(`update nodes set parent_id='ancestor-restricted' where id='ancestor-child'`);
  await isolated.runtime.pool.query('analyze collections');
  await isolated.runtime.pool.query('analyze nodes');
}
