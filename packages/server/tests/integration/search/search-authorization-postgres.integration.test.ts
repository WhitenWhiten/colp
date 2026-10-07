import { parseGovernanceTarget, targetFingerprint } from '../../../src/modules/governance/domain/moderation.js';
import assert from 'node:assert/strict';
import type { CompiledQuery, KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresSharedExposureFactsPort, createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../../src/infrastructure/search/index.js';
import {
  createSearchCursorSigner,
  executeSearchQuery,
  SearchQueryError,
  type SearchCandidate,
  type SearchPrincipal,
} from '../../../src/modules/search/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-07-25T12:00:00.000Z');
const KEYS = { current: { id: 'search-current', key: 'postgres-search-cursor-key-material' } } as const;
const owner: SearchPrincipal = { kind: 'account', accountId: 'account-owner', principalId: 'account-owner',
  subjectId: 'subject-owner', securityEpoch: '1' };
const member: SearchPrincipal = { kind: 'account', accountId: 'account-member', principalId: 'account-member',
  subjectId: 'subject-member', securityEpoch: '1' };
const outsider: SearchPrincipal = { kind: 'account', accountId: 'account-outsider', principalId: 'account-outsider',
  subjectId: 'subject-outsider', securityEpoch: '1' };

describeWithPostgres('P2B-23 Search authorization and paging', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_authorization', {
      maxConnections: 4, applicationName: 'known-search-authorization-contract',
    });
    const result = await createMigrator(isolated.runtime.db, undefined, isolated.schema).migrateToLatest();
    if (result.error) throw result.error;
    await seedAuthorityCorpus(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test.each(['hide_public', 'delist', 'bookmark_hide', 'visibility', 'restrict_publication'] as const)(
    'rechecks %s committed between recall and authority for collection/node/annotation', async (control) => {
      const collectionId = `barrier-${control.replaceAll('_', '-')}`;
      const nodeId = `${collectionId}-node`, noteId = `${collectionId}-annotation`;
      await seedCollection(isolated, collectionId, 'public', 'authoritymemberneedle', true);
      await seedNode(isolated, collectionId, nodeId, 'authoritymemberneedle', 'inherit');
      await seedAnnotation(isolated, collectionId, noteId, 'public', 'account-owner', nodeId);
      await isolated.runtime.pool.query("insert into collection_members(collection_id,subject_id,role) values($1,'subject-member','viewer')", [collectionId]);
      const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
      const captured = await candidates.listCandidates({ query: 'authoritymemberneedle', types: ['collection', 'node', 'annotation'], projection: { kind: 'anonymous' }, limit: 100, timeoutMs: 5000 });
      const page = { items: captured.items.filter(item => [collectionId, nodeId, noteId].includes(item.resourceId)), hasMore: false };
      assert.equal(page.items.length, 3);
      const run = (principal: SearchPrincipal) => executeSearchQuery({
        candidates: { ...candidates, listCandidates: async () => page },
        authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
        cursors: createSearchCursorSigner(KEYS), clock: { now: () => NOW },
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      }, { principal, query: 'authoritymemberneedle', types: ['collection', 'node', 'annotation'] });
      if (control === 'visibility') {
        await isolated.runtime.pool.query("update collections set visibility='private' where id=$1", [collectionId]);
      } else {
        const target = parseGovernanceTarget(control === 'bookmark_hide'
          ? { kind: 'bookmark', id: nodeId, collectionId }
          : control === 'restrict_publication' ? { kind: 'account', id: 'account-owner' }
            : { kind: 'collection', id: collectionId });
        const targetJson = JSON.stringify(target), fingerprint = targetFingerprint(target);
        await isolated.runtime.pool.query(`insert into moderation_cases(id,reporter_account_id,target_kind,target_id,target_json,target_fingerprint,category,description,status,revision,created_at,updated_at)
          values($1,'account-owner',$2,$3,$4::jsonb,$5,'privacy','barrier','resolved','1',now(),now())`, [collectionId, target.kind, target.id, targetJson, fingerprint]);
        await isolated.runtime.pool.query(`insert into moderation_actions(id,case_id,target_kind,target_id,parent_id,target_json,target_fingerprint,action,reason,actor_account_id,state,revision,created_at)
          values($1,$1,$2,$3,$4,$5::jsonb,$6,$7,'barrier','account-owner','active','1',now())`,
        [collectionId, target.kind, target.id, control === 'bookmark_hide' ? collectionId : null, targetJson, fingerprint, control === 'bookmark_hide' ? 'hide_public' : control]);
      }
      try {
        const anonymous = await run({ kind: 'anonymous' });
        assert.deepEqual(anonymous.items.map(item => item.resourceId), control === 'bookmark_hide' ? [collectionId] : []);
        for (const principal of [owner, member]) {
          assert.deepEqual(new Set((await run(principal)).items.map(item => item.resourceId)), new Set([collectionId, nodeId, noteId]));
        }
      } finally {
        if (control === 'visibility') await isolated.runtime.pool.query("update collections set visibility='public' where id=$1", [collectionId]);
        else await isolated.runtime.pool.query("update moderation_actions set state='revoked',revoked_at=now(),revoke_reason='test restore' where id=$1", [collectionId]);
      }
      assert.equal((await run({ kind: 'anonymous' })).items.length, 3);
      const restored = await candidates.listCandidates({ query: 'authoritymemberneedle', types: ['collection', 'node', 'annotation'], projection: { kind: 'anonymous' }, limit: 100, timeoutMs: 5000 });
      assert.equal(restored.items.filter(item => [collectionId, nodeId, noteId].includes(item.resourceId)).length, 3);
    });

  test('keeps anonymous candidates public while recalling opted-in member collections and their private branches', async () => {
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    const anonymousPage = await candidates.listCandidates({ query: 'authoritymemberneedle',
      types: ['collection', 'node', 'profile', 'annotation'], projection: { kind: 'anonymous' }, limit: 100,
      timeoutMs: 5_000 });
    const anonymousIds = new Set(anonymousPage.items.map((item) => `${item.resourceType}:${item.resourceId}`));
    assert.ok(anonymousIds.has('collection:search-public'));
    assert.ok(anonymousIds.has('collection:search-stale'));
    assert.equal([...anonymousIds].some((id) => /search-(?:protected|private)|private-node|note/u.test(id)), false);

    const memberPage = await candidates.listCandidates({ query: 'authoritymemberneedle',
      types: ['collection', 'node', 'profile', 'annotation'],
      projection: { kind: 'account', accountId: 'account-member', principalId: 'account-member',
        subjectId: 'subject-member', securityEpoch: '1' }, limit: 100,
      timeoutMs: 5_000 });
    const memberIds = memberPage.items.map((item) => `${item.resourceType}:${item.resourceId}`);
    assert.ok(memberIds.includes('collection:search-public'));
    assert.ok(memberIds.includes('collection:search-protected'));
    assert.ok(memberIds.includes('collection:search-private'));
    assert.ok(memberIds.includes('node:search-private-node'));
    assert.ok(memberIds.includes('annotation:search-protected-note'));
    assert.equal(memberIds.includes('annotation:search-private-note'), false);

    const ownerPage = await candidates.listCandidates({ query: 'authoritymemberneedle',
      types: ['collection', 'node', 'profile', 'annotation'],
      projection: { kind: 'account', accountId: 'account-owner', principalId: 'account-owner',
        subjectId: 'subject-owner', securityEpoch: '1' }, limit: 100,
      timeoutMs: 5_000 });
    assert.ok(ownerPage.items.some((item) => item.resourceId === 'search-private-note'));

    const forgedPage = await candidates.listCandidates({ query: 'authoritymemberneedle',
      types: ['collection', 'node', 'profile', 'annotation'], projection: { kind: 'account',
        accountId: 'account-outsider', principalId: 'account-outsider', subjectId: 'subject-member', securityEpoch: '1' },
      limit: 100, timeoutMs: 5_000 });
    assert.deepEqual(forgedPage.items.map((item) => `${item.resourceType}:${item.resourceId}`),
      anonymousPage.items.map((item) => `${item.resourceType}:${item.resourceId}`));
  });

  test('loads every candidate authority in one batch without trusting stale candidate fields', async () => {
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    let sqlCalls = 0;
    let compiledAuthority: CompiledQuery | undefined;
    const baseExecutor = isolated.runtime.db.getExecutor();
    const observedDb = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        sqlCalls += 1;
        compiledAuthority = baseExecutor.compileQuery(args.node, args.queryId);
        return args.node;
      },
      async transformResult(args) { return args.result; },
    } satisfies KyselyPlugin);
    const authority = createPostgresSearchAuthorityPort(observedDb);
    const page = await candidates.listAnonymousCandidates({ query: 'staleauthorityneedle', limit: 100 });
    assert.ok(page.items.some((item) => item.resourceId === 'search-stale'));
    const stale = page.items.find((item) => item.resourceId === 'search-stale')!;
    const memberCandidates = await candidates.listCandidates({ query: 'authoritymemberneedle',
      types: ['collection', 'node', 'annotation'],
      projection: { kind: 'account', accountId: 'account-owner', principalId: 'account-owner',
        subjectId: 'subject-owner', securityEpoch: '1' },
      limit: 100, timeoutMs: 5_000 });
    const profileCandidate: SearchCandidate = { resourceType: 'profile', resourceId: 'ownerprofile',
      collectionId: null, handle: 'ownerprofile', displayName: 'stale owner', snippetSource: 'stale owner', rank: 0.5,
      exclusive: { rank: 0.5, resourceType: 'profile', resourceId: 'ownerprofile' } };
    const authorityCandidates = [...new Map([...page.items, ...memberCandidates.items, profileCandidate]
      .map((item) => [`${item.resourceType}:${item.resourceId}`, item])).values()];

    await isolated.runtime.pool.query(`update collections set visibility='private',title='CURRENT PRIVATE TITLE',
      summary='CURRENT PRIVATE BODY',policy_revision='policy-2' where id='search-stale'`);
    const facts = await authority.loadBatch({ principal: { kind: 'anonymous' }, candidates: authorityCandidates,
      timeoutMs: 5_000 });
    assert.equal(sqlCalls, 1);
    const staleFact = facts.find((item) => item.resourceType === 'collection' && item.resourceId === 'search-stale');
    assert.ok(staleFact && staleFact.resourceType === 'collection');
    assert.equal(staleFact.visibility, 'private');
    assert.equal(staleFact.policyRevision, 'policy-2');
    assert.equal(staleFact.title, 'CURRENT PRIVATE TITLE');
    assert.equal(staleFact.snippetSource.includes('CURRENT PRIVATE BODY'), true);
    if (!compiledAuthority) throw new Error('Search authority SQL was not observed.');
    const plan = await isolated.runtime.pool.query({
      text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${compiledAuthority.sql}`,
      values: [...compiledAuthority.parameters],
    });
    const planJson = JSON.stringify(plan.rows);
    assert.match(planJson, /Actual Rows|Actual Total Time/u);
    assert.match(compiledAuthority.sql, /jsonb_to_recordset[\s\S]*ancestor_walk[\s\S]*all_facts/u);

    const staticCandidate = { async listAnonymousCandidates() { return { items: [stale], hasMore: false }; },
      async listCandidates() { return { items: [stale], hasMore: false }; } };
    const result = await executeSearchQuery({ candidates: staticCandidate, authority,
      cursors: createSearchCursorSigner(KEYS), clock: { now: () => NOW }, sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime) },
    { principal: { kind: 'anonymous' }, query: 'staleauthorityneedle' });
    assert.deepEqual(result.items, []);
    assert.doesNotMatch(JSON.stringify(result), /STALE PUBLIC TITLE|CURRENT PRIVATE TITLE|CURRENT PRIVATE BODY/u);

    const colliding = ['collection', 'node', 'profile', 'annotation'].flatMap((resourceType) => [
      { ...stale, resourceType, resourceId: 'search-public', exclusive: { ...stale.exclusive, resourceType,
        resourceId: 'search-public' } } as SearchCandidate,
    ]);
    const collisionFacts = await authority.loadBatch({ principal: { kind: 'anonymous' },
      candidates: [...colliding, colliding[0]!], timeoutMs: 5_000 });
    assert.deepEqual(collisionFacts.map((fact) => `${fact.resourceType}:${fact.resourceId}`),
      ['collection:search-public']);
    assert.deepEqual(await authority.loadBatch({ principal: { kind: 'anonymous' }, candidates: [],
      timeoutMs: 5_000 }), []);
  });

  test('applies owner/member/outsider projection using current membership and annotation creator facts', async () => {
    const ports = { candidates: createPostgresSearchCandidatePort(isolated.runtime.db),
      authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
      cursors: createSearchCursorSigner(KEYS), clock: { now: () => NOW },
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime) };
    const run = async (principal: SearchPrincipal) => executeSearchQuery(ports,
      { principal, query: 'authoritymemberneedle', pageSize: 100 });
    const ownerPage = await run(owner);
    const memberPage = await run(member);
    const outsiderPage = await run(outsider);
    const anonymousPage = await run({ kind: 'anonymous' });
    assert.ok(ownerPage.items.some((item) => item.resourceId === 'search-private-note'));
    assert.equal(memberPage.items.some((item) => item.resourceId === 'search-private-note'), false);
    assert.ok(memberPage.items.some((item) => item.resourceId === 'search-private-node'));
    assert.deepEqual(outsiderPage.items.map((item) => item.resourceId), anonymousPage.items.map((item) => item.resourceId));
    assert.equal(ownerPage.cache.class, 'private-no-store');
    assert.equal(anonymousPage.cache.class, 'shared-public');
  });

  test('backfills after current authority filtering and never performs per-result authority loads', async () => {
    const candidatePort = createPostgresSearchCandidatePort(isolated.runtime.db);
    const staleCandidates: SearchCandidate[] = [];
    let candidateAfter: SearchCandidate['exclusive'] | undefined;
    do {
      const candidatePage = await candidatePort.listCandidates({ query: 'qxzbfill709',
        types: ['collection'], projection: { kind: 'account', principalId: 'account-member',
          accountId: 'account-member', subjectId: 'subject-member', securityEpoch: '1' },
        limit: 100, ...(candidateAfter ? { after: candidateAfter } : {}),
        timeoutMs: 5_000 });
      staleCandidates.push(...candidatePage.items);
      candidateAfter = candidatePage.hasMore ? candidatePage.items.at(-1)?.exclusive : undefined;
    } while (candidateAfter);
    const staticCandidates = { async listAnonymousCandidates() { return { items: [], hasMore: false }; },
      async listCandidates(input: Parameters<typeof candidatePort.listCandidates>[0]) {
        const start = input.after === undefined ? 0 : staleCandidates.findIndex((item) =>
          item.rank === input.after?.rank && item.resourceType === input.after.resourceType
            && item.resourceId === input.after.resourceId) + 1;
        const remaining = staleCandidates.slice(start);
        return { items: remaining.slice(0, input.limit), hasMore: remaining.length > input.limit };
      } };
    const realAuthority = createPostgresSearchAuthorityPort(isolated.runtime.db);
    let authorityCalls = 0;
    const batchSizes: number[] = [];
    const authority = { async loadBatch(input: Parameters<typeof realAuthority.loadBatch>[0]) {
      authorityCalls += 1; batchSizes.push(input.candidates.length); return realAuthority.loadBatch(input);
    } };
    const ports = { candidates: staticCandidates, authority, cursors: createSearchCursorSigner(KEYS),
      clock: { now: () => NOW }, sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime) };
    const page = await executeSearchQuery(ports, { principal: { kind: 'anonymous' },
      query: 'qxzbfill709', pageSize: 3 });
    assert.deepEqual(page.items.map((item) => item.resourceId), ['backfill-public-0', 'backfill-public-1', 'backfill-public-2']);
    assert.equal(authorityCalls, 2);
    assert.deepEqual(batchSizes, [100, 10]);
  });

  test('stops real PostgreSQL authorization after the 400-candidate budget with an accurate continuation', async () => {
    const candidatePort = createPostgresSearchCandidatePort(isolated.runtime.db);
    const staleCandidates: SearchCandidate[] = [];
    let after: SearchCandidate['exclusive'] | undefined;
    do {
      const page = await candidatePort.listCandidates({ query: 'jlmbudget462', types: ['collection'],
        projection: { kind: 'account', accountId: 'account-member', principalId: 'account-member',
          subjectId: 'subject-member', securityEpoch: '1' }, limit: 100, ...(after ? { after } : {}),
        timeoutMs: 5_000 });
      staleCandidates.push(...page.items);
      after = page.hasMore ? page.items.at(-1)?.exclusive : undefined;
    } while (after);
    assert.equal(staleCandidates.length, 405);
    const staticCandidates = { async listAnonymousCandidates() { return { items: [], hasMore: false }; },
      async listCandidates(input: Parameters<typeof candidatePort.listCandidates>[0]) {
        const start = input.after === undefined ? 0 : staleCandidates.findIndex((item) =>
          item.rank === input.after?.rank && item.resourceType === input.after.resourceType
            && item.resourceId === input.after.resourceId) + 1;
        const remaining = staleCandidates.slice(start);
        return { items: remaining.slice(0, input.limit), hasMore: remaining.length > input.limit };
      } };
    const realAuthority = createPostgresSearchAuthorityPort(isolated.runtime.db);
    const batchSizes: number[] = [];
    const authority = { async loadBatch(input: Parameters<typeof realAuthority.loadBatch>[0]) {
      batchSizes.push(input.candidates.length); return realAuthority.loadBatch(input);
    } };
    const result = await executeSearchQuery({ candidates: staticCandidates, authority,
      cursors: createSearchCursorSigner(KEYS), clock: { now: () => NOW }, sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime) },
    { principal: { kind: 'anonymous' }, query: 'jlmbudget462', pageSize: 3 });
    assert.deepEqual(result.items, []);
    assert.equal(result.page.hasMore, true);
    assert.ok(result.page.nextCursor);
    assert.deepEqual(batchSizes, [100, 100, 100, 100]);
  });

  test('continues a stable tuple without duplicates and suppresses a resource revoked between pages', async () => {
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    const authority = createPostgresSearchAuthorityPort(isolated.runtime.db);
    const ports = { candidates, authority, cursors: createSearchCursorSigner(KEYS), clock: { now: () => NOW }, sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime) };
    const first = await executeSearchQuery(ports, { principal: { kind: 'anonymous' },
      query: 'vptpage831', types: ['collection'], pageSize: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.page.nextCursor);
    await isolated.runtime.pool.query(`update collections set allow_search_indexing=false,policy_revision='revoked'
      where id='paging-item-2'`);
    const second = await executeSearchQuery(ports, { principal: { kind: 'anonymous' },
      query: 'vptpage831', types: ['collection'], cursor: first.page.nextCursor! });
    const ids = [...first.items, ...second.items].map((item) => item.resourceId);
    assert.equal(ids.includes('paging-item-2'), false);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(second.items.some((item) => item.resourceId === 'paging-item-3'));
  });

  test('cancels a real PostgreSQL lock wait on deadline and caller abort and reuses the connection', async () => {
    const ports = { candidates: createPostgresSearchCandidatePort(isolated.runtime.db),
      authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
      cursors: createSearchCursorSigner(KEYS), clock: { now: () => new Date() },
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime) };
    const blocker = await isolated.runtime.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table collections in access exclusive mode');

      const deadlineStarted = Date.now();
      await assert.rejects(executeSearchQuery(ports, { principal: { kind: 'anonymous' },
        query: 'vptpage831', timeoutMs: 150 }),
      (error: unknown) => error instanceof SearchQueryError && error.code === 'search_timeout');
      assert.ok(Date.now() - deadlineStarted < 2_000);

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(new Error('caller cancelled')), 100);
      const abortStarted = Date.now();
      try {
        await assert.rejects(executeSearchQuery(ports, { principal: { kind: 'anonymous' },
          query: 'vptpage831', timeoutMs: 5_000, signal: controller.signal }),
        (error: unknown) => error instanceof SearchQueryError && error.code === 'search_aborted');
      } finally { clearTimeout(abortTimer); }
      assert.ok(Date.now() - abortStarted < 2_000);
      assert.equal((await isolated.runtime.pool.query('select 1 AS alive')).rows[0]?.alive, 1);
      let activeCount = -1;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const activeSearch = await isolated.runtime.pool.query(`select count(*)::int AS count
          from pg_stat_activity where application_name='known-search-authorization-contract'
            and pid<>pg_backend_pid() and state='active' and query like '%profile_hits%'`);
        activeCount = activeSearch.rows[0]?.count ?? -1;
        if (activeCount === 0) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(activeCount, 0);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
});

async function seedAuthorityCorpus(isolated: IsolatedPostgresRuntime): Promise<void> {
  for (const [accountId, subjectId] of [
    ['account-owner', 'subject-owner'], ['account-member', 'subject-member'], ['account-outsider', 'subject-outsider'],
  ]) await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status,security_epoch)
    values($1,$2,'active',1)`, [accountId, subjectId]);
  await isolated.runtime.pool.query(`insert into profiles(account_id,display_name,avatar_url)
    values('account-owner','Owner Profile','https://example.test/owner.png')`);
  await isolated.runtime.pool.query(`insert into profile_handles(handle,account_id)
    values('ownerprofile','account-owner')`);

  await seedCollection(isolated, 'search-public', 'public', 'authoritymemberneedle', true);
  await seedCollection(isolated, 'search-protected', 'protected', 'authoritymemberneedle', true);
  await seedCollection(isolated, 'search-private', 'private', 'authoritymemberneedle', true);
  await seedCollection(isolated, 'search-stale', 'public', 'STALE PUBLIC TITLE staleauthorityneedle', true);
  await isolated.runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
    values('search-protected','subject-member','viewer'),('search-private','subject-member','viewer')`);
  await seedNode(isolated, 'search-private', 'search-private-node', 'authoritymemberneedle', 'private');
  await seedAnnotation(isolated, 'search-private', 'search-protected-note', 'protected', 'account-owner');
  await seedAnnotation(isolated, 'search-private', 'search-private-note', 'private', 'account-owner');

  for (let index = 0; index < 105; index += 1) {
    await seedCollection(isolated, `backfill-denied-${index}`, 'private', 'qxzbfill709', true,
      `subject-denied-${index}`);
  }
  await isolated.runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
    select 'backfill-denied-' || n,'subject-member','viewer' from generate_series(0,104) n`);
  for (let index = 0; index < 5; index += 1) {
    await seedCollection(isolated, `backfill-public-${index}`, 'public', 'qxzbfill709', true);
  }
  for (let index = 0; index < 6; index += 1) {
    await seedCollection(isolated, `paging-item-${index}`, 'public', 'vptpage831', true);
  }
  await seedBudgetCorpus(isolated);
}

async function seedBudgetCorpus(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      select 'budget-denied-' || lpad(n::text,3,'0'),'collection' from generate_series(0,404) n
      union all
      select 'budget-denied-' || lpad(n::text,3,'0') || '-root','node' from generate_series(0,404) n`);
    await client.query(`insert into collections(id,owner_subject_id,title,summary,kind,visibility,
      allow_search_indexing,root_node_id,resource_revision,content_revision,policy_revision)
      select 'budget-denied-' || lpad(n::text,3,'0'),'budget-owner-' || n,'jlmbudget462',
        'jlmbudget462','bookmarks','private',true,
        'budget-denied-' || lpad(n::text,3,'0') || '-root','r1','c1','p1'
      from generate_series(0,404) n`);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
      select 'budget-denied-' || lpad(n::text,3,'0') || '-root',
        'budget-denied-' || lpad(n::text,3,'0'),'folder',true,'Root','r1','ch1'
      from generate_series(0,404) n`);
    await client.query(`insert into collection_members(collection_id,subject_id,role)
      select 'budget-denied-' || lpad(n::text,3,'0'),'subject-member','viewer'
      from generate_series(0,404) n`);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

async function seedCollection(isolated: IsolatedPostgresRuntime, id: string,
  visibility: 'public' | 'protected' | 'private' | 'unlisted', title: string, optIn: boolean,
  ownerSubjectId = 'subject-owner'): Promise<void> {
  const root = `${id}-root`;
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin'); await client.query('set constraints all deferred');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      values($1,'collection'),($2,'node')`, [id, root]);
    await client.query(`insert into collections(id,owner_subject_id,title,summary,kind,visibility,
      allow_search_indexing,publication_slug,published_at,root_node_id,resource_revision,content_revision,policy_revision)
      values($1,$2,$3,$3,'bookmarks',$4,$5,case when $4 in ('public','unlisted') then $1 end,
        case when $4 in ('public','unlisted') then current_timestamp end,$6,'r1','c1','policy-1')`,
    [id, ownerSubjectId, title, visibility, optIn, root]);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
      values($1,$2,'folder',true,'Root','r1','ch1')`, [root, id]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

async function seedNode(isolated: IsolatedPostgresRuntime, collectionId: string, id: string, title: string,
  visibility: 'inherit' | 'protected' | 'private'): Promise<void> {
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'node')`, [id]);
  await isolated.runtime.pool.query(`insert into nodes(id,collection_id,parent_id,kind,title,url,description,visibility,
    position_token,resource_revision,children_revision) values($1,$2,$3,'bookmark',$4,'https://member.example/path',$4,$5,$1,'r1','ch1')`,
  [id, collectionId, `${collectionId}-root`, title, visibility]);
}

async function seedAnnotation(isolated: IsolatedPostgresRuntime, collectionId: string, id: string,
  visibility: 'public' | 'unlisted' | 'protected' | 'private', creatorPrincipalId: string, nodeId?: string): Promise<void> {
  const timestamp = '2026-07-25T00:00:00.000Z';
  const payload = { id, collectionId, subject: { type: nodeId ? 'node' : 'collection', id: nodeId ?? collectionId },
    creator: { id: 'https://known.test/profiles/owner', name: 'Owner' }, type: 'note', format: 'plain',
    value: 'authoritymemberneedle', visibility, revision: 'r1', createdAt: timestamp, updatedAt: timestamp };
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'annotation')`, [id]);
  await isolated.runtime.pool.query(`insert into annotations(id,collection_id,subject_type,subject_id,creator_principal_id,
    type,format,value_json,visibility,resource_revision,created_at,updated_at,payload_json)
    values($1,$2,$7,$8,$3,'note','plain',to_jsonb('authoritymemberneedle'::text),$4,'r1',$5,$5,$6::jsonb)`,
  [id, collectionId, creatorPrincipalId, visibility, timestamp, JSON.stringify(payload), nodeId ? 'node' : 'collection', nodeId ?? collectionId]);
}
