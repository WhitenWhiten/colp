import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { saveResource, SavedResourceError, unsaveResource,
  createSavedResourceCursorSigner } from '../../../src/modules/reading-progress/index.js';
import { createPostgresSavedResourceReadUnitOfWork, createPostgresSavedResourceUnitOfWork,
  type SavedResourceFaultInjector } from '../../../src/infrastructure/reading-progress/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime, truncateGuardedTablesInTransaction } from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

describeWithPostgres('P2B-15 saved resource PostgreSQL commands', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_saved_resource_commands');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  const command = (changes: Record<string, unknown> = {}) => ({
    actor: { principalId: 'principal-owner', subjectId: 'subject-owner', accountId: 'account-owner' },
    command: { commandId: randomUUID(), fingerprint: randomUUID() },
    target: { resourceType: 'node' as const, resourceId: 'node-visible' },
    ...changes,
  });
  const executeSave = (input: ReturnType<typeof command>, fault?: SavedResourceFaultInjector) =>
    createPostgresSavedResourceUnitOfWork(isolated.runtime.db, { faultInjector: fault }).execute((ports) => saveResource(ports, input as never));
  const executeUnsave = (input: ReturnType<typeof command>, fault?: SavedResourceFaultInjector) =>
    createPostgresSavedResourceUnitOfWork(isolated.runtime.db, { faultInjector: fault }).execute((ports) => unsaveResource(ports, input as never));

  test('persists Collection and Node saves for stable accounts while isolating two accounts', async () => {
    const node = await executeSave(command());
    const collection = await executeSave(command({ target: { resourceType: 'collection', resourceId: 'collection-visible' } }));
    const other = await executeSave(command({ actor: { principalId: 'principal-other', subjectId: 'subject-other', accountId: 'account-other' } }));
    assert.equal(node.kind, 'saved'); assert.equal(collection.kind, 'saved'); assert.equal(other.kind, 'saved');
    const rows = await isolated.runtime.pool.query(`select account_id,resource_type,resource_id,deleted_at
      from saved_resources order by account_id,resource_type,resource_id`);
    assert.deepEqual(rows.rows.map((row) => [row.account_id,row.resource_type,row.resource_id,row.deleted_at]), [
      ['account-other','node','node-visible',null],
      ['account-owner','collection','collection-visible',null],
      ['account-owner','node','node-visible',null],
    ]);
  });

  test('distinguishes exact replay, new-command duplicate, unsave, resave and command reuse', async () => {
    const firstInput = command();
    const first = await executeSave(firstInput);
    const replay = await executeSave(firstInput);
    const duplicate = await executeSave(command());
    const removed = await executeUnsave(command());
    const absent = await executeUnsave(command());
    const restored = await executeSave(command());
    assert.equal(first.kind, 'saved'); assert.equal(replay.kind, 'replay');
    assert.equal(duplicate.kind, 'saved'); if (duplicate.kind === 'saved') assert.equal(duplicate.changed, false);
    assert.deepEqual(removed, { kind: 'unsaved', changed: true });
    assert.deepEqual(absent, { kind: 'unsaved', changed: false });
    assert.equal(restored.kind, 'saved'); if (restored.kind === 'saved') assert.equal(restored.changed, true);
    const reuse = await executeSave({ ...firstInput, command: { ...firstInput.command, fingerprint: 'different' } });
    assert.deepEqual(reuse, { kind: 'reused' });
    const state = await isolated.runtime.pool.query(`select
      (select count(*)::int from saved_resources) total,
      (select count(*)::int from saved_resources where deleted_at is null) live,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type like 'saved_resource.%') audits,
      (select count(*)::int from resource_revisions) revisions,
      (select count(*)::int from operations) operations,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from resource_id_ledger) ledger`);
    assert.deepEqual(state.rows[0], { total: 2, live: 1, receipts: 5, audits: 5, revisions: 0,
      operations: 0, outbox: 0, ledger: 277 });
    const privacy = await isolated.runtime.pool.query(`select event.operation_id,event.collection_id,payload.details_json
      from audit_events event join audit_event_payloads payload on payload.event_id=event.id
      where event.event_type like 'saved_resource.%'`);
    assert.ok(privacy.rows.every((row) => row.operation_id === null && row.collection_id === null
      && !Object.hasOwn(row.details_json, 'resourceId')));
  });

  test('conceals missing, deleted and inaccessible Collection/Node targets with one error shape', async () => {
    const attempts = [
      command({ target: { resourceType: 'node', resourceId: 'missing' } }),
      command({ target: { resourceType: 'collection', resourceId: 'missing' } }),
      command({ target: { resourceType: 'node', resourceId: 'node-deleted' } }),
      command({ target: { resourceType: 'collection', resourceId: 'collection-deleted' } }),
      command({ target: { resourceType: 'node', resourceId: 'node-private' } }),
      command({ target: { resourceType: 'collection', resourceId: 'collection-private' } }),
    ];
    for (const input of attempts) {
      await assert.rejects(() => executeSave(input), (error: unknown) => error instanceof SavedResourceError
        && error.code === 'saved_resource_not_found' && error.message === 'Saved resource target was not found.');
    }
  });

  test('conceals saves under restricted, cyclic or over-deep ancestors from non-members', async () => {
    for (const resourceId of ['child-inherit', 'child-protected', 'node-cycle-a', 'node-cycle-b', 'deep-260']) {
      await assert.rejects(() => executeSave(command({ actor: { principalId: 'principal-other',
        subjectId: 'subject-other', accountId: 'account-other' },
        target: { resourceType: 'node', resourceId } })), (error: unknown) => error instanceof SavedResourceError
          && error.code === 'saved_resource_not_found' && error.message === 'Saved resource target was not found.');
    }
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from saved_resources`)).rows[0]?.count, 0);
  });

  test('owner and members save under restricted ancestors while public children stay saveable', async () => {
    const owner = await executeSave(command({ target: { resourceType: 'node', resourceId: 'child-inherit' } }));
    assert.equal(owner.kind, 'saved');
    await isolated.runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
      values ('collection-chain','subject-other','viewer')`);
    const member = await executeSave(command({ actor: { principalId: 'principal-other',
      subjectId: 'subject-other', accountId: 'account-other' },
      target: { resourceType: 'node', resourceId: 'child-protected' } }));
    assert.equal(member.kind, 'saved');
    const publicChild = await executeSave(command({ actor: { principalId: 'principal-other',
      subjectId: 'subject-other', accountId: 'account-other' },
      target: { resourceType: 'node', resourceId: 'node-visible' } }));
    assert.equal(publicChild.kind, 'saved');
  });

  test('hydrate conceals legacy saves under restricted ancestors for non-members and serves members', async () => {
    await isolated.runtime.pool.query(`insert into saved_resources(account_id,resource_type,resource_id,saved_at,updated_at) values
      ('account-other','node','child-inherit',current_timestamp,current_timestamp),
      ('account-other','node','node-visible',current_timestamp,current_timestamp)`);
    const readUow = createPostgresSavedResourceReadUnitOfWork(isolated.runtime.db, { cursorSigner:
      createSavedResourceCursorSigner({ current: { id: 'pg-v1', key: 'saved-pg-cursor-secret' } }) });
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

  test('database partial uniqueness is the final arbiter under real concurrent saves', async () => {
    let release!: () => void;
    let inserted!: () => void;
    const allowCommit = new Promise<void>((resolve) => { release = resolve; });
    const observedInsert = new Promise<void>((resolve) => { inserted = resolve; });
    const first = executeSave(command(), { async afterPhase(context) {
      if (context.phase === 'resource') { inserted(); await allowCommit; }
    } });
    await observedInsert;
    const second = executeSave(command());
    await waitForCondition(async () => {
      const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
        select exists(select 1 from pg_stat_activity
          where application_name='known-test-phase2b_saved_resource_commands'
            and cardinality(pg_blocking_pids(pid)) > 0) waiting
      `);
      return blocked.rows[0]?.waiting === true;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'the concurrent save to wait on the partial unique index transaction',
    });
    release();
    const outcomes = await Promise.all([first, second]);
    assert.deepEqual(outcomes.map((value) => value.kind), ['saved', 'saved']);
    assert.deepEqual(outcomes.map((value) => value.kind === 'saved' ? value.changed : null), [true, false]);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from saved_resources where deleted_at is null`)).rows[0]?.count, 1);
  });

  test('a same-command-id concurrent claim is barred by the receipt lock and replays after commit', async () => {
    const input = command();
    let release!: () => void;
    let observed!: () => void;
    const allowCommit = new Promise<void>((resolve) => { release = resolve; });
    const atResource = new Promise<void>((resolve) => { observed = resolve; });
    const first = executeSave(input, { async afterPhase(context) {
      if (context.phase === 'resource') { observed(); await allowCommit; }
    } });
    await atResource;
    const second = await executeSave(input);
    assert.deepEqual(second, { kind: 'in_progress', retryAfterSeconds: 1 });
    release();
    const firstOutcome = await first;
    assert.equal(firstOutcome.kind, 'saved');
    if (firstOutcome.kind === 'saved') assert.equal(firstOutcome.changed, true);
    const replay = await executeSave(input);
    assert.equal(replay.kind, 'replay');
    const state = await isolated.runtime.pool.query(`select
      (select count(*)::int from saved_resources where deleted_at is null) live,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type like 'saved_resource.%') audits`);
    assert.deepEqual(state.rows[0], { live: 1, receipts: 1, audits: 1 });
  });

  test('linearizes a real concurrent save/unsave race without duplicate live state', async () => {
    await executeSave(command());
    let release!: () => void;
    let removed!: () => void;
    const allowCommit = new Promise<void>((resolve) => { release = resolve; });
    const observedRemoval = new Promise<void>((resolve) => { removed = resolve; });
    const unsave = executeUnsave(command(), { async afterPhase(context) {
      if (context.phase === 'resource') { removed(); await allowCommit; }
    } });
    await observedRemoval;
    const save = await executeSave(command());
    release();
    const removal = await unsave;
    assert.equal(save.kind, 'saved');
    if (save.kind === 'saved') assert.equal(save.changed, false);
    assert.deepEqual(removal, { kind: 'unsaved', changed: true });
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from saved_resources where deleted_at is null`)).rows[0]?.count, 0);
  });

  test('serializes save against target deletion and rejects a target deleted before lock acquisition', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`update nodes set deleted_at=current_timestamp where id='node-visible'`);
      const pending = executeSave(command());
      await waitForCondition(async () => {
        const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
          select exists(select 1 from pg_stat_activity
            where application_name='known-test-phase2b_saved_resource_commands'
              and cardinality(pg_blocking_pids(pid)) > 0) waiting
        `);
        return blocked.rows[0]?.waiting === true;
      }, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
        description: 'the save command to wait on the target deletion transaction',
      });
      await client.query('commit');
      await assert.rejects(() => pending, (error: unknown) => error instanceof SavedResourceError
        && error.code === 'saved_resource_not_found');
    } finally { await client.query('rollback').catch(() => undefined); client.release(); }
  });

  test.each(['receipt','resource','audit','complete'] as const)(
    'rolls back receipt, saved row and audit after the %s save phase',
    async (phase) => {
      const input = command();
      await assert.rejects(() => executeSave(input, { afterPhase(context) {
        if (context.phase === phase) throw new Error(`fault-${phase}`);
      } }), new RegExp(`fault-${phase}`));
      const counts = await isolated.runtime.pool.query(`select
        (select count(*)::int from saved_resources) saved,
        (select count(*)::int from audit_events where event_type like 'saved_resource.%') audit,
        (select count(*)::int from product_command_receipts where command_id=$1) receipt,
        (select count(*)::int from resource_revisions) revision,
        (select count(*)::int from resource_id_ledger) ledger,
        (select count(*)::int from operations) operation,
        (select count(*)::int from outbox_events) outbox`, [input.command.commandId]);
      assert.deepEqual(counts.rows[0], { saved: 0, audit: 0, receipt: 0, revision: 0,
        ledger: 277, operation: 0, outbox: 0 });
    },
  );

  test.each(['receipt','resource','audit','complete'] as const)(
    'rolls back unsave state, audit and completed receipt after the %s write phase',
    async (phase) => {
      await executeSave(command());
      const input = command();
      const before = await isolated.runtime.pool.query(`select
        (select count(*)::int from saved_resources where deleted_at is null) live,
        (select count(*)::int from audit_events where event_type like 'saved_resource.%') audit,
        (select count(*)::int from product_command_receipts) receipts`);
      await assert.rejects(() => executeUnsave(input, { afterPhase(context) {
        if (context.phase === phase) throw new Error(`fault-${phase}`);
      } }), new RegExp(`fault-${phase}`));
      const after = await isolated.runtime.pool.query(`select
        (select count(*)::int from saved_resources where deleted_at is null) live,
        (select count(*)::int from audit_events where event_type like 'saved_resource.%') audit,
        (select count(*)::int from product_command_receipts) receipts,
        (select count(*)::int from product_command_receipts where command_id=$1) failed_receipt,
        (select count(*)::int from resource_revisions) revision,
        (select count(*)::int from operations) operation,
        (select count(*)::int from outbox_events) outbox`, [input.command.commandId]);
      assert.deepEqual(after.rows[0], { ...before.rows[0], failed_receipt: 0,
        revision: 0, operation: 0, outbox: 0 });
    },
  );

  async function resetFixture() {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin'); await client.query('set constraints all deferred');
      await truncateGuardedTablesInTransaction(client, `truncate table product_command_receipts,outbox_events,audit_events,operations,
        saved_resources,collection_members,nodes,collections,accounts,resource_id_ledger cascade`);
      await client.query(`insert into accounts(id,subject_id,status) values
        ('account-owner','subject-owner','active'),('account-other','subject-other','active')`);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ('collection-visible','collection'),('node-visible','node'),('collection-private','collection'),('node-private','node'),
        ('node-deleted','node'),('root-visible','node'),('root-private','node'),
        ('collection-deleted','collection'),('root-deleted','node'),
        ('collection-chain','collection'),('root-chain','node'),('parent-private','node'),('child-inherit','node'),
        ('parent-protected','node'),('child-protected','node'),('node-cycle-a','node'),('node-cycle-b','node')`);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type)
        select 'deep-'||lpad(n::text,3,'0'),'node' from generate_series(1,260) n`);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal,deleted_at) values
        ('collection-visible','subject-owner','Visible','bookmarks','public','visible',current_timestamp,
          'root-visible','r1','c1','p1',1,null),
        ('collection-private','subject-private','Private','bookmarks','private',null,null,
          'root-private','r2','c2','p2',1,null),
        ('collection-deleted','subject-owner','Deleted','bookmarks','public','deleted',current_timestamp,
          'root-deleted','r3','c3','p3',1,current_timestamp),
        ('collection-chain','subject-owner','Chain','bookmarks','public','chain',current_timestamp,
          'root-chain','r6','c6','p6',1,null)`);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,
        position_token,resource_revision,children_revision,deleted_at) values
        ('root-visible','collection-visible',null,'folder',true,'Root',null,'[]','inherit',null,'r1','c1',null),
        ('node-visible','collection-visible','root-visible','bookmark',false,'Visible','https://example.test','[]','inherit','A','r2','c2',null),
        ('node-deleted','collection-visible','root-visible','bookmark',false,'Deleted','https://example.test','[]','inherit','B','r3','c3',current_timestamp),
        ('root-private','collection-private',null,'folder',true,'Root',null,'[]','inherit',null,'r4','c4',null),
        ('node-private','collection-private','root-private','bookmark',false,'Private','https://example.test','[]','private','A','r5','c5',null),
        ('root-deleted','collection-deleted',null,'folder',true,'Root',null,'[]','inherit',null,'r6','c6',current_timestamp),
        ('root-chain','collection-chain',null,'folder',true,'Root',null,'[]','inherit',null,'r7','c7',null),
        ('parent-private','collection-chain','root-chain','folder',false,'ParentPrivate',null,'[]','private','A','r8','c8',null),
        ('child-inherit','collection-chain','parent-private','bookmark',false,'ChildInherit','https://example.test/child','[]','inherit','A','r9','c9',null),
        ('parent-protected','collection-chain','root-chain','folder',false,'ParentProtected',null,'[]','protected','B','r10','c10',null),
        ('child-protected','collection-chain','parent-protected','bookmark',false,'ChildProtected','https://example.test/protected','[]','inherit','A','r11','c11',null),
        ('node-cycle-a','collection-chain','node-cycle-b','folder',false,'CycleA',null,'[]','inherit','C','r12','c12',null),
        ('node-cycle-b','collection-chain','node-cycle-a','folder',false,'CycleB',null,'[]','inherit','D','r13','c13',null)`);
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
