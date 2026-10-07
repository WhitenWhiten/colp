import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import { compareSearchCandidateTuple } from '../../../src/modules/search/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS = '202607251000_postgres_search_baseline';
const CURRENT = '202607251100_profile_annotation_search';

describeWithPostgres('P2B-22 Profile and Annotation search branches', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_profile_annotation', {
      maxConnections: 4,
      applicationName: 'known-search-profile-annotation-contract',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('upgrades stored materialization, indexes it, and supports down/up replay', async () => {
    const isolated = await createIsolatedPostgresRuntime('search_profile_annotation_upgrade');
    try {
      const setupMigrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
      const previous = await setupMigrator.migrateTo(PREVIOUS);
      if (previous.error) throw previous.error;
      await seedPreMigrationRows(isolated);
      const current = await setupMigrator.migrateTo(CURRENT);
      if (current.error) throw current.error;
      const generated = await isolated.runtime.pool.query<{
        table_name: string; column_name: string; is_generated: string; generation_expression: string;
      }>(`select table_name,column_name,is_generated,generation_expression
          from information_schema.columns
          where table_schema=current_schema() and (
            (table_name='annotations' and column_name in ('annotation_search_text','annotation_search_vector'))
            or (table_name='profiles' and column_name in ('search_display_name','search_display_vector'))
            or (table_name='profile_handles' and column_name='search_handle'))
          order by table_name,column_name`);
      assert.equal(generated.rowCount, 5);
      assert.ok(generated.rows.every((row) => row.is_generated === 'ALWAYS'));
      assert.ok(generated.rows.every((row) => row.generation_expression.length > 0));

      const catalog = await isolated.runtime.pool.query<{ indexname: string }>(`select indexname from pg_indexes
        where schemaname=current_schema() and indexname in (
          'profile_handles_search_exact_prefix_idx','profile_handles_search_trgm_idx',
          'profiles_search_display_trgm_idx','profiles_search_display_vector_idx',
          'collections_search_profile_owner_idx','annotations_search_trgm_idx',
          'annotations_search_vector_idx','annotations_search_authority_order_idx')`);
      assert.equal(catalog.rowCount, 8);
      const volatility = await isolated.runtime.pool.query<{ provolatile: string }>(`select provolatile
        from pg_proc where pronamespace=current_schema()::regnamespace
          and proname='search_safe_annotation_text'`);
      assert.deepEqual(volatility.rows, [{ provolatile: 'i' }]);

      const upgraded = await isolated.runtime.pool.query<{ id: string; text: string }>(`select id,
        annotation_search_text as text from annotations where id='annotation-upgrade'`);
      assert.deepEqual(upgraded.rows, [{ id: 'annotation-upgrade', text: 'legacy safe text' }]);

      const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
      const down = await migrator.migrateTo(PREVIOUS);
      if (down.error) throw down.error;
      const absent = await isolated.runtime.pool.query<{ count: string }>(`select count(*)::text count
        from information_schema.columns where table_schema=current_schema()
          and column_name in ('annotation_search_text','annotation_search_vector','search_display_name',
            'search_display_vector','search_handle')`);
      assert.equal(absent.rows[0]?.count, '0');
      const baseline = await isolated.runtime.pool.query<{ id: string }>(`select c.id
        from collections c
        where c.deleted_at is null and c.visibility='public' and c.allow_search_indexing=true
          and ('upgrade' operator(public.<%) c.search_text
            or c.search_vector @@ plainto_tsquery('english'::regconfig,'upgrade'))`);
      assert.deepEqual(baseline.rows, [{ id: 'upgrade-collection' }]);
      const up = await migrator.migrateTo(CURRENT);
      if (up.error) throw up.error;
    } finally {
      await isolated.close();
    }
  }, 120_000);

  test('admits only active public Profiles backed by an opted-in public Collection', async () => {
    await seedProfileCorpus(isolated);
    const port = createPostgresSearchCandidatePort(isolated.runtime.db);
    for (const [query, expected] of [
      ['alice', 'alice'], ['ali', 'alice'], ['alce', 'alice'], ['Security Researcher', 'alice'],
    ] as const) {
      const page = await port.listAnonymousCandidates({ query, limit: 50 });
      const profiles = page.items.filter((item) => item.resourceType === 'profile');
      assert.ok(profiles.some((item) => item.resourceId === expected), `${query} did not find ${expected}`);
    }
    for (const query of ['deletedperson', 'disabledperson', 'noprofile', 'nooptin']) {
      const page = await port.listAnonymousCandidates({ query, limit: 50 });
      assert.equal(page.items.some((item) => item.resourceType === 'profile'), false, query);
    }
    const exact = (await port.listAnonymousCandidates({ query: 'alice', limit: 50 })).items
      .find((item) => item.resourceType === 'profile');
    assert.ok(exact && exact.handle === 'alice' && exact.displayName === 'Security Researcher');
    assert.equal(exact.collectionId, null);
    assert.ok(exact.rank > 0 && exact.rank <= 1);
    assert.equal(exact.snippetSource.includes('account-alice'), false);
    for (const query of ['%', '_', '\\']) {
      const page = await port.listAnonymousCandidates({ query, limit: 50 });
      assert.equal(page.items.some((item) => item.resourceType === 'profile'), false, query);
    }
  });

  test('materializes safe bounded plain, Markdown, HTML, and allowlisted JSON snippets', async () => {
    await seedAnnotationCorpus(isolated);
    const port = createPostgresSearchCandidatePort(isolated.runtime.db);
    const page = await port.listAnonymousCandidates({ query: 'needle', limit: 100 });
    const annotations = page.items.filter((item) => item.resourceType === 'annotation');
    const byId = new Map(annotations.map((item) => [item.resourceId, item]));
    for (const id of ['ann-plain', 'ann-markdown', 'ann-html', 'ann-json', 'ann-long']) assert.ok(byId.has(id), id);

    assert.equal(byId.get('ann-plain')?.snippetSource, 'plain needle text');
    const markdown = byId.get('ann-markdown')?.snippetSource ?? '';
    assert.match(markdown, /markdown needle safe label/u);
    assert.doesNotMatch(markdown, /javascript:|<script|onclick|https?:\/\//iu);
    const html = byId.get('ann-html')?.snippetSource ?? '';
    assert.match(html, /html needle visible/u);
    assert.doesNotMatch(html, /script|style|onclick|alert|display:none|<|>/iu);
    const json = byId.get('ann-json')?.snippetSource ?? '';
    assert.match(json, /json needle allowed/u);
    assert.doesNotMatch(json, /private-secret|token-secret|password/iu);
    const long = byId.get('ann-long')?.snippetSource ?? '';
    assert.ok([...long].length <= 1024);
    assert.doesNotMatch(long, /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    assert.doesNotMatch(long, /<[^>]*>/u);
    assert.equal([...long].at(-1), '😀');
    assert.equal(byId.get('ann-nfkc')?.snippetSource, 'NFKC needle AB');
  });

  test('filters Annotation authority and subject visibility inside the candidate branch', async () => {
    const port = createPostgresSearchCandidatePort(isolated.runtime.db);
    const page = await port.listAnonymousCandidates({ query: 'authorityprobeunique', limit: 100 });
    const ids = page.items.filter((item) => item.resourceType === 'annotation').map((item) => item.resourceId);
    assert.deepEqual(ids, ['ann-public-control', 'ann-public-node']);

    await isolated.runtime.pool.query(`alter table annotations drop constraint annotations_type_supported`);
    await insertAnnotation(isolated, {
      id: 'ann-reading-state-probe', collectionId: 'ann-public', subjectType: 'collection',
      subjectId: 'ann-public', type: 'reading_state', format: 'plain', value: 'authorityprobeunique', visibility: 'public',
    });
    const replay = await port.listAnonymousCandidates({ query: 'authorityprobeunique', limit: 100 });
    assert.deepEqual(replay.items.filter((item) => item.resourceType === 'annotation').map((item) => item.resourceId), [
      'ann-public-control', 'ann-public-node',
    ]);
  });

  test('private matches do not change observable count, rank, or hasMore', async () => {
    const port = createPostgresSearchCandidatePort(isolated.runtime.db);
    const snapshot = async () => {
      const pages = [];
      let after: Parameters<typeof port.listAnonymousCandidates>[0]['after'];
      do {
        const page = await port.listAnonymousCandidates({ query: 'isolationkeyword', limit: 1,
          ...(after ? { after } : {}) });
        pages.push(page);
        after = page.hasMore ? page.items.at(-1)?.exclusive : undefined;
      } while (after);
      return pages;
    };
    const before = await snapshot();
    await insertPrivateIsolationAnnotations(isolated, 1_000);
    const after = await snapshot();
    assert.deepEqual(after, before);
    assert.equal(before[0]?.hasMore, true);
    assert.equal(before.flatMap((page) => page.items).length, 3);
  });

  test('uses normalized ranks and traverses the complete cross-type tuple without gaps or repeats', async () => {
    await seedCrossTypeTie(isolated);
    const port = createPostgresSearchCandidatePort(isolated.runtime.db);
    const all = [];
    let after: Parameters<typeof port.listAnonymousCandidates>[0]['after'];
    do {
      const page = await port.listAnonymousCandidates({ query: 'crossbranchranktie', limit: 1, ...(after ? { after } : {}) });
      all.push(...page.items);
      after = page.hasMore ? page.items.at(-1)?.exclusive : undefined;
    } while (after);
    assert.ok(all.some((item) => item.resourceType === 'collection'));
    assert.ok(all.some((item) => item.resourceType === 'node'));
    assert.ok(all.some((item) => item.resourceType === 'profile'));
    assert.ok(all.some((item) => item.resourceType === 'annotation'));
    assert.deepEqual([...all].sort(compareSearchCandidateTuple), all);
    assert.equal(new Set(all.map((item) => `${item.resourceType}:${item.resourceId}`)).size, all.length);
    assert.ok(all.every((item) => item.rank > 0 && item.rank <= 1));
    assert.ok(all.every((item) => Number(item.rank.toFixed(6)) === item.rank));
    await assert.rejects(
      port.listAnonymousCandidates({ query: 'crossbranchranktie', limit: 1,
        after: { rank: 0.1234567, resourceType: 'collection', resourceId: 'x' } }),
      /continuation tuple is invalid/u,
    );
  });
});

async function seedPreMigrationRows(isolated: IsolatedPostgresRuntime): Promise<void> {
  await seedCollection(isolated, 'upgrade-collection', 'upgrade-owner', 'public', true);
  await insertAnnotation(isolated, {
    id: 'annotation-upgrade', collectionId: 'upgrade-collection', subjectType: 'collection',
    subjectId: 'upgrade-collection', format: 'plain', value: 'legacy safe text', visibility: 'public',
  });
}

async function seedProfileCorpus(isolated: IsolatedPostgresRuntime): Promise<void> {
  for (const row of [
    ['account-alice', 'subject-alice', 'active', null, 'alice', 'Security Researcher', 'public', true],
    ['account-deleted', 'subject-deleted', 'deleted', new Date(), 'deletedperson', 'Deleted Person', 'public', true],
    ['account-disabled', 'subject-disabled', 'disabled', null, 'disabledperson', 'Disabled Person', 'public', true],
    ['account-no-profile', 'subject-no-profile', 'active', null, 'noprofile', null, 'public', true],
    ['account-no-optin', 'subject-no-optin', 'active', null, 'nooptin', 'No Opt In', 'public', false],
    ['account-no-handle', 'subject-no-handle', 'active', null, null, 'Handle Missing', 'public', true],
  ] as const) {
    const [accountId, subjectId, status, deletedAt, handle, displayName, visibility, optIn] = row;
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status,deleted_at)
      values($1,$2,$3,$4) on conflict(id) do nothing`, [accountId, subjectId, status, deletedAt]);
    if (displayName !== null) await isolated.runtime.pool.query(`insert into profiles(account_id,display_name)
      values($1,$2) on conflict(account_id) do nothing`, [accountId, displayName]);
    if (handle !== null) await isolated.runtime.pool.query(`insert into profile_handles(handle,account_id)
      values($1,$2) on conflict(handle) do nothing`, [handle, accountId]);
    await seedCollection(isolated, `profile-${handle ?? 'missing-handle'}`, subjectId, visibility, optIn);
  }
}

async function seedAnnotationCorpus(isolated: IsolatedPostgresRuntime): Promise<void> {
  await seedCollection(isolated, 'ann-public', 'ann-owner', 'public', true);
  await seedCollection(isolated, 'ann-optout', 'ann-owner', 'public', false);
  await seedCollection(isolated, 'ann-unlisted', 'ann-owner', 'unlisted', true);
  await seedCollection(isolated, 'ann-private-collection', 'ann-owner', 'private', true);
  await seedNode(isolated, 'ann-public', 'ann-public-visible', 'Visible node', 'inherit');
  await seedNode(isolated, 'ann-public', 'ann-public-hidden', 'Hidden node', 'private');
  await seedNode(isolated, 'ann-public', 'ann-public-deleted', 'Deleted node', 'inherit');
  await seedNode(isolated, 'ann-public', 'ann-public-parent', 'Restricted parent', 'protected', true);
  await seedNode(isolated, 'ann-public', 'ann-public-descendant', 'Descendant', 'inherit', false, 'ann-public-parent');
  await seedNode(isolated, 'ann-public', 'ann-cycle-a', 'Cycle A', 'inherit', true);
  await seedNode(isolated, 'ann-public', 'ann-cycle-b', 'Cycle B', 'inherit', true, 'ann-cycle-a');
  await seedDeepSubject(isolated, 257);

  const common = { collectionId: 'ann-public', subjectType: 'collection' as const, subjectId: 'ann-public' };
  await insertAnnotation(isolated, { id: 'ann-plain', ...common, format: 'plain', value: 'plain needle text', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-markdown', ...common, format: 'markdown',
    value: 'markdown needle [safe label](javascript:alert(1)) <img src=x onerror=alert(2)>', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-html', ...common, format: 'html',
    value: '<script>alert(1)</script><style>.x{display:none}</style><p onclick="steal()">html needle visible</p>', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-json', ...common, format: 'json', value: {
    text: 'json needle allowed', title: 42,
    secret: 'private-secret', password: 'password', // secret-scan: allow 'password' -- deliberate redaction fixture
    nested: { content: 'token-secret' },
  }, visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-long', ...common, format: 'plain',
    value: `needle\u202E\u0007\u0085${'x'.repeat(1016)}\ud83d\ude00${'z'.repeat(4_000)}`, visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-nfkc', ...common, format: 'plain',
    value: 'NFKC needle \uff21\uff22', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-public-control', ...common, format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-public-node', collectionId: 'ann-public', subjectType: 'node',
    subjectId: 'ann-public-visible', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-private', ...common, format: 'plain', value: 'authorityprobeunique', visibility: 'private' });
  await insertAnnotation(isolated, { id: 'ann-unlisted-annotation', ...common, format: 'plain', value: 'authorityprobeunique', visibility: 'unlisted' });
  await insertAnnotation(isolated, { id: 'ann-protected-annotation', ...common, format: 'plain', value: 'authorityprobeunique', visibility: 'protected' });
  await insertAnnotation(isolated, { id: 'ann-hidden-node', collectionId: 'ann-public', subjectType: 'node',
    subjectId: 'ann-public-hidden', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-hidden-ancestor', collectionId: 'ann-public', subjectType: 'node',
    subjectId: 'ann-public-descendant', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-root-subject', collectionId: 'ann-public', subjectType: 'node',
    subjectId: 'ann-public-root', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-deleted-subject', collectionId: 'ann-public', subjectType: 'node',
    subjectId: 'ann-public-deleted', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await isolated.runtime.pool.query(`update nodes set deleted_at=current_timestamp where id='ann-public-deleted'`);
  await insertAnnotation(isolated, { id: 'ann-cycle-subject', collectionId: 'ann-public', subjectType: 'node',
    subjectId: 'ann-cycle-b', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await isolated.runtime.pool.query(`update nodes set parent_id='ann-cycle-b' where id='ann-cycle-a'`);
  await insertAnnotation(isolated, { id: 'ann-too-deep-subject', collectionId: 'ann-public', subjectType: 'node',
    subjectId: 'ann-deep-257', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-optout-value', collectionId: 'ann-optout', subjectType: 'collection',
    subjectId: 'ann-optout', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-unlisted-collection-value', collectionId: 'ann-unlisted', subjectType: 'collection',
    subjectId: 'ann-unlisted', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-private-collection-value', collectionId: 'ann-private-collection', subjectType: 'collection',
    subjectId: 'ann-private-collection', format: 'plain', value: 'authorityprobeunique', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-deleted', ...common, format: 'plain', value: 'authorityprobeunique', visibility: 'public', deleted: true });
  await insertAnnotation(isolated, { id: 'ann-public-isolation', ...common, format: 'plain', value: 'isolationkeyword', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-public-isolation-b', ...common, format: 'plain', value: 'isolationkeyword', visibility: 'public' });
  await insertAnnotation(isolated, { id: 'ann-public-isolation-c', ...common, format: 'plain', value: 'isolationkeyword', visibility: 'public' });
}

async function insertPrivateIsolationAnnotations(
  isolated: IsolatedPostgresRuntime,
  count: number,
): Promise<void> {
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
    select 'ann-private-isolation-' || lpad(n::text,4,'0'),'annotation'
    from generate_series(1,$1) n`, [count]);
  await isolated.runtime.pool.query(`insert into annotations(id,collection_id,subject_type,subject_id,
    creator_principal_id,type,format,value_json,visibility,resource_revision,created_at,updated_at,payload_json)
    select id,'ann-public','collection','ann-public','principal-author','note','plain',
      to_jsonb('isolationkeyword'::text),'private','r1',current_timestamp,current_timestamp,
      jsonb_build_object('id',id,'collectionId','ann-public','subject',jsonb_build_object('type','collection','id','ann-public'),
        'creator',jsonb_build_object('id','https://known.test/profiles/author','name','Author'),'type','note',
        'format','plain','value','isolationkeyword','visibility','private','revision','r1',
        'createdAt','2026-07-25T00:00:00Z','updatedAt','2026-07-25T00:00:00Z')
    from (select 'ann-private-isolation-' || lpad(n::text,4,'0') id from generate_series(1,$1) n) seeded`, [count]);
}

async function seedDeepSubject(isolated: IsolatedPostgresRuntime, depth: number): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      select 'ann-deep-' || n,'node' from generate_series(1,$1) n`, [depth]);
    await client.query(`insert into nodes(id,collection_id,parent_id,kind,title,visibility,position_token,
      resource_revision,children_revision)
      select 'ann-deep-' || n,'ann-public',case when n=1 then 'ann-public-root' else 'ann-deep-' || (n-1) end,
        'folder','Deep ' || n,'inherit','D' || lpad(n::text,3,'0'),'r1','ch1'
      from generate_series(1,$1) n`, [depth]);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedCrossTypeTie(isolated: IsolatedPostgresRuntime): Promise<void> {
  await isolated.runtime.pool.query(`update collections set title='crossbranchranktie',summary=null
    where id='profile-alice'`);
  await seedNode(isolated, 'profile-alice', 'cross-tie-node', 'crossbranchranktie', 'inherit');
  await insertAnnotation(isolated, { id: 'cross-tie-annotation', collectionId: 'profile-alice',
    subjectType: 'collection', subjectId: 'profile-alice', format: 'plain', value: 'crossbranchranktie', visibility: 'public' });
  await isolated.runtime.pool.query(`update profiles set display_name='crossbranchranktie' where account_id='account-alice'`);
}

async function seedCollection(
  isolated: IsolatedPostgresRuntime,
  id: string,
  owner: string,
  visibility: 'public' | 'unlisted' | 'protected' | 'private',
  optIn: boolean,
): Promise<void> {
  const root = `${id}-root`;
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'collection'),($2,'node')
      on conflict(resource_id) do nothing`, [id, root]);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
      allow_search_indexing,root_node_id,resource_revision,content_revision,policy_revision)
      values($1,$2,$1,'bookmarks',$3,case when $3 in ('public','unlisted') then $1 end,
        case when $3 in ('public','unlisted') then current_timestamp end,$4,$5,'r1','c1','p1')
      on conflict(id) do nothing`, [id, owner, visibility, optIn, root]);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
      values($1,$2,'folder',true,'Root','r1','ch1') on conflict(id) do nothing`, [root, id]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedNode(
  isolated: IsolatedPostgresRuntime,
  collectionId: string,
  id: string,
  title: string,
  visibility: 'inherit' | 'protected' | 'private',
  folder = false,
  parentId = `${collectionId}-root`,
): Promise<void> {
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
    values($1,'node') on conflict(resource_id) do nothing`, [id]);
  await isolated.runtime.pool.query(`insert into nodes(id,collection_id,parent_id,kind,title,url,visibility,
    position_token,resource_revision,children_revision)
    values($1,$2,$3,$4,$5,$6,$7,$1,'r1','ch1') on conflict(id) do nothing`, [
    id, collectionId, parentId, folder ? 'folder' : 'bookmark', title,
    folder ? null : `https://example.test/${id}`, visibility,
  ]);
}

interface AnnotationSeed {
  id: string;
  collectionId: string;
  subjectType: 'collection' | 'node';
  subjectId: string;
  type?: string;
  format: 'plain' | 'markdown' | 'html' | 'json';
  value: unknown;
  visibility: 'public' | 'unlisted' | 'protected' | 'private';
  deleted?: boolean;
}

async function insertAnnotation(isolated: IsolatedPostgresRuntime, row: AnnotationSeed): Promise<void> {
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
    values($1,'annotation') on conflict(resource_id) do nothing`, [row.id]);
  const type = row.type ?? 'note';
  const timestamp = '2026-07-25T00:00:00.000Z';
  const payload = {
    id: row.id, collectionId: row.collectionId, subject: { type: row.subjectType, id: row.subjectId },
    creator: { id: 'https://known.test/profiles/author', name: 'Author' }, type, format: row.format,
    value: row.value, visibility: row.visibility, revision: 'r1', createdAt: timestamp, updatedAt: timestamp,
  };
  await isolated.runtime.pool.query(`insert into annotations(id,collection_id,subject_type,subject_id,
    creator_principal_id,type,format,value_json,visibility,resource_revision,created_at,updated_at,
    deleted_at,deleted_commit_ordinal,payload_json)
    values($1,$2,$3,$4,'principal-author',$5,$6,$7::jsonb,$8,'r1',$9,$9,
      case when $10 then $9::timestamptz end,case when $10 then 1 end,$11::jsonb)
    on conflict(id) do nothing`, [
    row.id, row.collectionId, row.subjectType, row.subjectId, type, row.format,
    JSON.stringify(row.value), row.visibility, timestamp, row.deleted === true, JSON.stringify(payload),
  ]);
}
