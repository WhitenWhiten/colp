import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReadingProgressReadUnitOfWork,
  createPostgresReadingProgressUnitOfWork,
} from '../../../src/infrastructure/reading-progress/index.js';
import {
  createReadingProgressCursorSigner,
  ReadingProgressError,
  resetReadingProgress,
  upsertReadingProgress,
  type ReadingProgressCommandInput,
  type ReadingProgressStatus,
} from '../../../src/modules/reading-progress/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime, truncateGuardedTablesInTransaction } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-18 PostgreSQL canonical Reading Progress commands', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_reading_progress_commands', { maxConnections: 16 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function command(options: { accountId?: string; principalId?: string; subjectId?: string;
    commandId?: string; fingerprint?: string; resourceType?: 'collection' | 'node'; resourceId?: string;
    status?: ReadingProgressStatus; progress?: number } = {}): ReadingProgressCommandInput {
    return {
      actor: { accountId: options.accountId ?? 'account-owner', principalId: options.principalId ?? 'principal-owner',
        subjectId: options.subjectId ?? 'subject-owner' },
      command: { commandId: options.commandId ?? randomUUID(), fingerprint: options.fingerprint ?? randomUUID() },
      target: { resourceType: options.resourceType ?? 'node', resourceId: options.resourceId ?? 'node-visible' },
      state: { status: options.status ?? 'in_progress', progress: options.progress ?? 0.25 },
    };
  }
  function resetCommand(options: Parameters<typeof command>[0] = {}) {
    const input = command(options);
    return { actor: input.actor, command: input.command, target: input.target };
  }

  test('persists Collection/Node state transitions, server timestamps, reset, and account isolation', async () => {
    const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    const first = await uow.execute((ports) => upsertReadingProgress(ports, command()));
    assert.equal(first.kind, 'upserted');
    if (first.kind === 'upserted') {
      assert.equal(first.inserted, true); assert.equal(first.readingProgress.revision, 1);
      assert.equal(first.readingProgress.completedAt, null);
    }
    const completed = await uow.execute((ports) => upsertReadingProgress(ports,
      command({ status: 'completed', progress: 1 })));
    assert.equal(completed.kind, 'upserted');
    if (completed.kind === 'upserted') {
      assert.equal(completed.inserted, false); assert.equal(completed.readingProgress.revision, 2);
      assert.ok(completed.readingProgress.completedAt instanceof Date);
    }
    const retained = await uow.execute((ports) => upsertReadingProgress(ports,
      command({ status: 'completed', progress: 1 })));
    if (completed.kind === 'upserted' && retained.kind === 'upserted') {
      assert.equal(retained.readingProgress.completedAt?.getTime(), completed.readingProgress.completedAt?.getTime());
    }
    const left = await uow.execute((ports) => upsertReadingProgress(ports,
      command({ status: 'not_started', progress: -0 })));
    if (left.kind === 'upserted') {
      assert.equal(left.readingProgress.progress, 0); assert.equal(left.readingProgress.completedAt, null);
    }
    const other = await uow.execute((ports) => upsertReadingProgress(ports, command({
      accountId: 'account-other', principalId: 'principal-other', subjectId: 'subject-other',
      resourceType: 'collection', resourceId: 'collection-visible', status: 'in_progress', progress: 0.75,
    })));
    assert.equal(other.kind, 'upserted');
    const rows = await isolated.runtime.pool.query(`select account_id,resource_type,resource_id,status,
      progress::text,revision,completed_at from reading_progress order by account_id`);
    assert.deepEqual(rows.rows.map((row) => ({ ...row, revision: Number(row.revision) })), [
      { account_id: 'account-other', resource_type: 'collection', resource_id: 'collection-visible',
        status: 'in_progress', progress: '0.75000', revision: 1, completed_at: null },
      { account_id: 'account-owner', resource_type: 'node', resource_id: 'node-visible',
        status: 'not_started', progress: '0.00000', revision: 4, completed_at: null },
    ]);
    assert.deepEqual(await uow.execute((ports) => resetReadingProgress(ports, resetCommand())),
      { kind: 'reset', changed: true });
    assert.deepEqual(await uow.execute((ports) => resetReadingProgress(ports, resetCommand())),
      { kind: 'reset', changed: false });
  });

  test('exact replay/reuse are stable and do not duplicate private or public side effects', async () => {
    const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    const input = command();
    const first = await uow.execute((ports) => upsertReadingProgress(ports, input));
    const replay = await uow.execute((ports) => upsertReadingProgress(ports, input));
    assert.equal(first.kind, 'upserted'); assert.equal(replay.kind, 'replay');
    const reused = await uow.execute((ports) => upsertReadingProgress(ports,
      { ...input, command: { ...input.command, fingerprint: 'different' } }));
    assert.deepEqual(reused, { kind: 'reused' });
    const counts = await sideEffectCounts();
    assert.deepEqual(counts, { progress: 1, audit: 1, receipts: 1, revisions: 0, operations: 0, outbox: 0 });
  });

  test('database unique authority resolves concurrent first upserts from two devices deterministically', async () => {
    const first = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    const second = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    const outcomes = await Promise.all([
      first.execute((ports) => upsertReadingProgress(ports, command({ status: 'in_progress', progress: 0.2 }))),
      second.execute((ports) => upsertReadingProgress(ports, command({ status: 'in_progress', progress: 0.8 }))),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['upserted', 'upserted']);
    const revisions = outcomes.map((outcome) => outcome.kind === 'upserted' ? outcome.readingProgress.revision : 0).sort();
    assert.deepEqual(revisions, [1, 2]);
    const rows = await isolated.runtime.pool.query<{ count: number; revision: number; progress: string }>(
      `select count(*)::int count,max(revision)::int revision,max(progress)::text progress from reading_progress`);
    assert.equal(rows.rows[0]?.count, 1); assert.equal(rows.rows[0]?.revision, 2);
    const winner = outcomes.find((outcome) => outcome.kind === 'upserted' && outcome.readingProgress.revision === 2);
    assert.equal(rows.rows[0]?.progress, winner?.kind === 'upserted'
      ? winner.readingProgress.progress.toFixed(5) : 'missing-winner');
  });

  test('a same-command-id concurrent claim is barred by the receipt lock and replays after commit', async () => {
    const input = command();
    let release!: () => void;
    let observed!: () => void;
    const allowCommit = new Promise<void>((resolve) => { release = resolve; });
    const atResource = new Promise<void>((resolve) => { observed = resolve; });
    const first = createPostgresReadingProgressUnitOfWork(isolated.runtime.db, {
      faultInjector: { async afterPhase(context) {
        if (context.phase === 'resource') { observed(); await allowCommit; }
      } },
    }).execute((ports) => upsertReadingProgress(ports, input));
    await atResource;
    const second = await createPostgresReadingProgressUnitOfWork(isolated.runtime.db)
      .execute((ports) => upsertReadingProgress(ports, input));
    assert.deepEqual(second, { kind: 'in_progress', retryAfterSeconds: 1 });
    release();
    const firstOutcome = await first;
    assert.equal(firstOutcome.kind, 'upserted');
    if (firstOutcome.kind === 'upserted') assert.equal(firstOutcome.inserted, true);
    const replay = await createPostgresReadingProgressUnitOfWork(isolated.runtime.db)
      .execute((ports) => upsertReadingProgress(ports, input));
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(await sideEffectCounts(),
      { progress: 1, audit: 1, receipts: 1, revisions: 0, operations: 0, outbox: 0 });
  });

  test('rejects missing, deleted, inaccessible and revoked targets with the same concealment code', async () => {
    const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    for (const input of [
      command({ resourceId: 'node-missing' }), command({ resourceId: 'node-deleted' }),
      command({ accountId: 'account-other', principalId: 'principal-other', subjectId: 'subject-other',
        resourceId: 'node-private' }),
    ]) await assert.rejects(() => uow.execute((ports) => upsertReadingProgress(ports, input)),
      (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_not_found');
    await isolated.runtime.pool.query(`update collections set visibility='private' where id='collection-visible'`);
    await assert.rejects(() => uow.execute((ports) => upsertReadingProgress(ports, command({
      accountId: 'account-other', principalId: 'principal-other', subjectId: 'subject-other',
    }))), (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_not_found');
    assert.equal((await sideEffectCounts()).progress, 0);
  });

  test('reset remains available to the stable account after target deletion or access revocation', async () => {
    const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    await uow.execute((ports) => upsertReadingProgress(ports, command()));
    await isolated.runtime.pool.query(`update nodes set deleted_at=current_timestamp where id='node-visible'`);
    assert.deepEqual(await uow.execute((ports) => resetReadingProgress(ports, resetCommand())),
      { kind: 'reset', changed: true });

    const other = { accountId: 'account-other', principalId: 'principal-other', subjectId: 'subject-other',
      resourceType: 'collection' as const, resourceId: 'collection-visible' };
    await uow.execute((ports) => upsertReadingProgress(ports, command(other)));
    await isolated.runtime.pool.query(`update collections set visibility='private' where id='collection-visible'`);
    assert.deepEqual(await uow.execute((ports) => resetReadingProgress(ports, resetCommand(other))),
      { kind: 'reset', changed: true });
    assert.equal((await sideEffectCounts()).progress, 0);
  });

  test('conceals node targets under restricted, cyclic or over-deep ancestors from non-members', async () => {
    const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    const nonMember = { accountId: 'account-other', principalId: 'principal-other', subjectId: 'subject-other' };
    for (const resourceId of ['child-inherit', 'child-protected', 'node-cycle-a', 'node-cycle-b', 'deep-260']) {
      await assert.rejects(() => uow.execute((ports) => upsertReadingProgress(ports,
        command({ ...nonMember, resourceId }))), (error: unknown) => error instanceof ReadingProgressError
          && error.code === 'reading_progress_not_found');
    }
    assert.equal((await sideEffectCounts()).progress, 0);
  });

  test('owner and members write under restricted ancestors while public children stay writable', async () => {
    const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db);
    const owner = await uow.execute((ports) => upsertReadingProgress(ports,
      command({ resourceId: 'child-inherit' })));
    assert.equal(owner.kind, 'upserted');
    await isolated.runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
      values ('collection-chain','subject-other','viewer')`);
    const member = await uow.execute((ports) => upsertReadingProgress(ports, command({
      accountId: 'account-other', principalId: 'principal-other', subjectId: 'subject-other',
      resourceId: 'child-protected' })));
    assert.equal(member.kind, 'upserted');
    const publicChild = await uow.execute((ports) => upsertReadingProgress(ports, command({
      accountId: 'account-other', principalId: 'principal-other', subjectId: 'subject-other',
      resourceId: 'node-visible' })));
    assert.equal(publicChild.kind, 'upserted');
  });

  test('hydrate conceals legacy summaries under restricted ancestors for non-members and serves members', async () => {
    await isolated.runtime.pool.query(`insert into reading_progress(account_id,resource_type,resource_id,status,progress,revision,created_at,updated_at) values
      ('account-other','node','child-inherit','in_progress',0.25,1,current_timestamp,current_timestamp),
      ('account-other','node','node-visible','in_progress',0.5,1,current_timestamp,current_timestamp)`);
    const readUow = createPostgresReadingProgressReadUnitOfWork(isolated.runtime.db, { cursorSigner:
      createReadingProgressCursorSigner({ current: { id: 'pg-v1', key: 'reading-progress-pg-secret' } }) });
    const hidden = await readUow.execute((ports) => ports.reads.hydrateAccessible({
      actorSubjectId: 'subject-other', targets: [{ resourceType: 'node', resourceId: 'child-inherit' }] }));
    assert.deepEqual(hidden, []);
    const publicSummary = await readUow.execute((ports) => ports.reads.hydrateAccessible({
      actorSubjectId: 'subject-other', targets: [{ resourceType: 'node', resourceId: 'node-visible' }] }));
    assert.deepEqual(publicSummary.map((row) => row.resourceId), ['node-visible']);
    await isolated.runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
      values ('collection-chain','subject-other','viewer')`);
    const member = await readUow.execute((ports) => ports.reads.hydrateAccessible({
      actorSubjectId: 'subject-other', targets: [{ resourceType: 'node', resourceId: 'child-inherit' }] }));
    assert.deepEqual(member.map((row) => row.resourceId), ['child-inherit']);
  });

  for (const phase of ['receipt', 'resource', 'audit', 'complete'] as const) {
    test(`rolls back receipt/state/audit and leaves Collection authority untouched after ${phase} fault`, async () => {
      const input = command();
      const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db, {
        faultInjector: { afterPhase(context) { if (context.phase === phase) throw new Error(`fault:${phase}`); } },
      });
      await assert.rejects(() => uow.execute((ports) => upsertReadingProgress(ports, input)), /fault:/);
      assert.deepEqual(await sideEffectCounts(), {
        progress: 0, audit: 0, receipts: 0, revisions: 0, operations: 0, outbox: 0,
      });
    });

    test(`rolls back reset receipt/state/audit and leaves Collection authority untouched after ${phase} fault`, async () => {
      await isolated.runtime.pool.query(`insert into reading_progress
        (account_id,resource_type,resource_id,status,progress,revision,created_at,updated_at)
        values ('account-owner','node','node-visible','in_progress',0.25000,1,current_timestamp,current_timestamp)`);
      const before = await authorityFacts();
      const uow = createPostgresReadingProgressUnitOfWork(isolated.runtime.db, {
        faultInjector: { afterPhase(context) { if (context.phase === phase) throw new Error(`fault:${phase}`); } },
      });
      await assert.rejects(() => uow.execute((ports) => resetReadingProgress(ports, resetCommand())), /fault:/);
      assert.deepEqual(await authorityFacts(), before);
    });
  }

  async function authorityFacts() {
    const result = await isolated.runtime.pool.query(`select
      (select count(*)::int from reading_progress) progress,
      (select count(*)::int from audit_events where event_type like 'reading_progress.%') audit,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from resource_id_ledger) ledger,
      (select json_agg(json_build_array(id,resource_revision,content_revision,policy_revision)
        order by id) from collections) collection_revisions,
      (select count(*)::int from resource_revisions) revisions,
      (select count(*)::int from operations) operations,
      (select count(*)::int from outbox_events) outbox`);
    return result.rows[0];
  }

  async function sideEffectCounts() {
    const result = await isolated.runtime.pool.query(`select
      (select count(*)::int from reading_progress) progress,
      (select count(*)::int from audit_events where event_type like 'reading_progress.%') audit,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from resource_revisions) revisions,
      (select count(*)::int from operations) operations,
      (select count(*)::int from outbox_events) outbox`);
    return result.rows[0] as { progress: number; audit: number; receipts: number;
      revisions: number; operations: number; outbox: number };
  }

  async function resetFixture() {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin'); await client.query('set constraints all deferred');
      await truncateGuardedTablesInTransaction(client, `truncate table product_command_receipts,outbox_events,audit_events,operations,
        reading_progress,saved_resources,collection_members,nodes,collections,accounts,resource_id_ledger cascade`);
      await client.query(`insert into accounts(id,subject_id,status) values
        ('account-owner','subject-owner','active'),('account-other','subject-other','active')`);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ('collection-visible','collection'),('node-visible','node'),('collection-private','collection'),
        ('node-private','node'),('node-deleted','node'),('root-visible','node'),('root-private','node'),
        ('collection-chain','collection'),('root-chain','node'),('parent-private','node'),('child-inherit','node'),
        ('parent-protected','node'),('child-protected','node'),('node-cycle-a','node'),('node-cycle-b','node')`);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type)
        select 'deep-'||lpad(n::text,3,'0'),'node' from generate_series(1,260) n`);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal) values
        ('collection-visible','subject-owner','Visible','bookmarks','public','visible',current_timestamp,
          'root-visible','r1','c1','p1',1),
        ('collection-private','subject-private','Private','bookmarks','private',null,null,
          'root-private','r2','c2','p2',1),
        ('collection-chain','subject-owner','Chain','bookmarks','public','chain',current_timestamp,
          'root-chain','r6','c6','p6',1)`);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,
        position_token,resource_revision,children_revision,deleted_at) values
        ('root-visible','collection-visible',null,'folder',true,'Root',null,'[]','inherit',null,'r1','c1',null),
        ('node-visible','collection-visible','root-visible','bookmark',false,'Visible','https://example.test','[]','inherit','A','r2','c2',null),
        ('node-deleted','collection-visible','root-visible','bookmark',false,'Deleted','https://example.test','[]','inherit','B','r3','c3',current_timestamp),
        ('root-private','collection-private',null,'folder',true,'Root',null,'[]','inherit',null,'r4','c4',null),
        ('node-private','collection-private','root-private','bookmark',false,'Private','https://example.test','[]','private','A','r5','c5',null),
        ('root-chain','collection-chain',null,'folder',true,'Root',null,'[]','inherit',null,'r6','c6',null),
        ('parent-private','collection-chain','root-chain','folder',false,'ParentPrivate',null,'[]','private','A','r7','c7',null),
        ('child-inherit','collection-chain','parent-private','bookmark',false,'ChildInherit','https://example.test/child','[]','inherit','A','r8','c8',null),
        ('parent-protected','collection-chain','root-chain','folder',false,'ParentProtected',null,'[]','protected','B','r9','c9',null),
        ('child-protected','collection-chain','parent-protected','bookmark',false,'ChildProtected','https://example.test/protected','[]','inherit','A','r10','c10',null),
        ('node-cycle-a','collection-chain','node-cycle-b','folder',false,'CycleA',null,'[]','inherit','C','r11','c11',null),
        ('node-cycle-b','collection-chain','node-cycle-a','folder',false,'CycleB',null,'[]','inherit','D','r12','c12',null)`);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,
        position_token,resource_revision,children_revision,deleted_at)
        select 'deep-'||lpad(n::text,3,'0'),'collection-chain',
          case when n=1 then 'root-chain' else 'deep-'||lpad((n-1)::text,3,'0') end,
          'folder',false,'Deep '||n,null,'[]','inherit',
          case when n=1 then 'E' else 'A' end,'r','c',null
        from generate_series(1,260) n`);
      await client.query(`insert into collection_members(collection_id,subject_id,role) values
        ('collection-visible','subject-owner','owner')`);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
});
