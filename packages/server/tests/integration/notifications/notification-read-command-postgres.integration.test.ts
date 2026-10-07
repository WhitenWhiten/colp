import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { DatabaseOperationError, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresNotificationReadCommandUnitOfWork,
  type NotificationReadCommandWritePhase,
} from '../../../src/infrastructure/notifications/index.js';
import { markNotificationRead, markNotificationsRead } from '../../../src/modules/notifications/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime, truncateFixtureTables } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-19 Notification read commands', () => {
  let isolated: IsolatedPostgresRuntime;
  const OWNER = 'notification-owner'; const OTHER = 'notification-other';
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('p5_notification_read',
    { maxConnections: 8 }); await runMigrations(isolated.runtime.db, 'latest'); }, 120_000);
  afterAll(async () => isolated?.close());

  async function reset(): Promise<void> {
    await truncateFixtureTables(isolated.runtime.pool, `truncate table product_command_receipts,audit_events,
      notification_deliveries,notifications cascade`);
    await isolated.runtime.pool.query(`delete from accounts where id in ($1,$2)`, [OWNER, OTHER]);
    for (const id of [OWNER, OTHER]) await isolated.runtime.pool.query(
      `insert into accounts(id,subject_id,status) values($1,$2,'active')`, [id, `subject-${id}`]);
  }
  async function add(owner: string, id: string, state: 'unread'|'read' = 'unread'): Promise<void> {
    await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
      source_event_id,notification_type,subject_type,subject_id,occurred_at,retain_until)
      values($1,$2,$3,'collection_change','collection',$4,current_timestamp,
      current_timestamp+interval '365 days')`, [id, owner, `event-${id}`, `subject-${id}`]);
    if (state === 'read') await isolated.runtime.pool.query(`update notifications set state='read',
      read_at=current_timestamp,state_revision=state_revision+1 where notification_id=$1`, [id]);
  }
  const command = (notificationId: string, commandId = randomUUID()) => ({ principalId: OWNER,
    notificationId, expectedStateRevision: 0n, commandId });
  const executeOne = (input: ReturnType<typeof command>, options = {}) =>
    createPostgresNotificationReadCommandUnitOfWork(isolated.runtime.db, options)
      .execute((ports) => markNotificationRead(ports, input));

  test('exact replay/reuse, already-read and cross-account concealment preserve per-table single effects', async () => {
    await reset(); await add(OWNER, 'own'); await add(OWNER, 'read', 'read'); await add(OTHER, 'foreign');
    const commandId = randomUUID(); const first = await executeOne(command('own', commandId));
    assert.equal(first.kind, 'succeeded');
    const replay = await executeOne(command('own', commandId));
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')), JSON.parse(JSON.stringify(first,
        (_key, value) => typeof value === 'bigint' ? value.toString() : value)));
      assert.deepEqual(replay.stableHeaders, { 'cache-control': 'private, no-store',
        'content-type': 'application/json' });
      assert.equal(replay.targetIdentity, 'own');
    }
    assert.equal((await executeOne(command('read'))).kind, 'succeeded');
    const concealed = await executeOne(command('foreign')); assert.deepEqual(concealed,
      { kind: 'succeeded', outcome: 'not_found', changed: false });
    const reused = await executeOne(command('read', commandId)); assert.equal(reused.kind, 'reused');
    const counts = (await isolated.runtime.pool.query(`select
      (select count(*)::int from notifications where state='read') notifications,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.read_state_command') audits`)).rows[0];
    assert.deepEqual(counts, { notifications: 2, receipts: 3, audits: 3 });
    const receipt = (await isolated.runtime.pool.query(`select principal_id,command_scope,
      request_fingerprint,contract_version,target_identity,result_status,result_media_type,
      result_bytes is not null has_result,completed_at is not null completed
      from product_command_receipts where command_id=$1`, [commandId])).rows[0];
    assert.equal(receipt.principal_id, OWNER);
    assert.equal(receipt.command_scope, 'notification:read-state:v1');
    assert.match(receipt.request_fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual({ contract_version: receipt.contract_version, target_identity: receipt.target_identity,
      result_status: receipt.result_status, result_media_type: receipt.result_media_type,
      has_result: receipt.has_result, completed: receipt.completed },
    { contract_version: '1.0.0', target_identity: 'own', result_status: 200,
      result_media_type: 'application/json', has_result: true, completed: true });
    const audit = (await isolated.runtime.pool.query<{ details_json: Record<string, unknown> }>(
      `select payload.details_json from audit_events event join audit_event_payloads payload on payload.event_id=event.id where event.event_type='notification.read_state_command'`)).rows;
    for (const row of audit) {
      assert.deepEqual(Object.keys(row.details_json).sort(),
        ['changedCount', 'mode', 'outcome', 'requestedCount']);
      assert.equal(JSON.stringify(row.details_json).includes('foreign'), false);
    }
  });

  test('bounded bulk changes only current-account unread rows and is exactly replayable', async () => {
    await reset(); await add(OWNER, 'a'); await add(OWNER, 'b'); await add(OWNER, 'read', 'read');
    await add(OTHER, 'foreign'); const commandId = randomUUID();
    const run = () => createPostgresNotificationReadCommandUnitOfWork(isolated.runtime.db)
      .execute((ports) => markNotificationsRead(ports, { principalId: OWNER,
        notificationIds: ['a', 'b', 'read', 'foreign'], commandId }));
    assert.deepEqual(await run(), { kind: 'succeeded', requestedCount: 4, markedCount: 2 });
    assert.equal((await run()).kind, 'replay');
    assert.equal((await isolated.runtime.pool.query(`select state from notifications
      where recipient_account_id=$1 and notification_id='foreign'`, [OTHER])).rows[0].state, 'unread');
    const effects = (await isolated.runtime.pool.query(`select
      (select count(*)::int from notifications where recipient_account_id=$1 and state='read') notifications,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.read_state_command') audits`,
    [OWNER])).rows[0];
    assert.deepEqual(effects, { notifications: 3, receipts: 1, audits: 1 });
  });

  test('stale mark-one rolls back its Product receipt and leaves the unread authority unchanged', async () => {
    await reset(); await add(OWNER, 'stale');
    await assert.rejects(() => executeOne({ ...command('stale'), expectedStateRevision: 1n }),
      (error: unknown) => error instanceof Error
        && 'code' in error && error.code === 'stale_state');
    const row = (await isolated.runtime.pool.query(`select
      (select state from notifications where notification_id='stale') state,
      (select state_revision::int from notifications where notification_id='stale') revision,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.read_state_command') audits`)).rows[0];
    assert.deepEqual(row, { state: 'unread', revision: 0, receipts: 0, audits: 0 });
  });

  test('FIX-H-005 mark-read converges the retention deadline to min(unread deadline, read_at+90d) and is idempotent', async () => {
    await reset();
    // Fresh unread row: the read boundary (read_at+90d) binds after marking.
    await add(OWNER, 'recent');
    // Late-read row: reading after the unread deadline would pass keeps the
    // original 365-day unread deadline (read_at+90d is later).
    await isolated.runtime.pool.query(`insert into notifications(notification_id,
        recipient_account_id,source_event_id,notification_type,subject_type,subject_id,
        occurred_at,retain_until)
      values('late',$1,'event-late','collection_change','collection','late-subject',
        current_timestamp - interval '300 days',
        current_timestamp - interval '300 days' + interval '365 days')`, [OWNER]);
    assert.equal((await executeOne(command('recent'))).kind, 'succeeded');
    assert.equal((await executeOne(command('late'))).kind, 'succeeded');
    const rows = await isolated.runtime.pool.query<{ notification_id: string;
      occurred_at: Date; read_at: Date; retain_until: Date }>(`select notification_id,
        occurred_at,read_at,retain_until from notifications
      where recipient_account_id=$1 and notification_id in ('recent','late')
      order by notification_id`, [OWNER]);
    const byId = new Map(rows.rows.map((row) => [row.notification_id, row]));
    const recent = byId.get('recent')!;
    assert.equal(recent.retain_until.getTime(), recent.read_at.getTime() + 90 * 86_400_000);
    assert.ok(recent.retain_until.getTime()
      < recent.occurred_at.getTime() + 365 * 86_400_000);
    const late = byId.get('late')!;
    assert.equal(late.retain_until.getTime(), late.occurred_at.getTime() + 365 * 86_400_000);
    assert.ok(late.retain_until.getTime() < late.read_at.getTime() + 90 * 86_400_000);
    // already-read is a stable no-op that never moves the deadline.
    await add(OWNER, 'read-deadline', 'read');
    const before = (await isolated.runtime.pool.query<{ retain_until: Date }>(`select retain_until
      from notifications where notification_id='read-deadline'`)).rows[0]!.retain_until;
    assert.equal((await executeOne(command('read-deadline'))).kind, 'succeeded');
    const after = (await isolated.runtime.pool.query<{ retain_until: Date }>(`select retain_until
      from notifications where notification_id='read-deadline'`)).rows[0]!.retain_until;
    assert.equal(after.getTime(), before.getTime());
    // Bulk mark converges every owned unread row in the same write.
    await add(OWNER, 'bulk-a'); await add(OWNER, 'bulk-b');
    assert.deepEqual(await createPostgresNotificationReadCommandUnitOfWork(isolated.runtime.db)
      .execute((ports) => markNotificationsRead(ports, { principalId: OWNER,
        notificationIds: ['bulk-a', 'bulk-b'], commandId: randomUUID() })),
    { kind: 'succeeded', requestedCount: 2, markedCount: 2 });
    const bulk = await isolated.runtime.pool.query<{ notification_id: string;
      read_at: Date; retain_until: Date }>(`select notification_id,read_at,retain_until
      from notifications where recipient_account_id=$1 and notification_id in ('bulk-a','bulk-b')
      order by notification_id`, [OWNER]);
    for (const row of bulk.rows) {
      assert.equal(row.retain_until.getTime(), row.read_at.getTime() + 90 * 86_400_000);
    }
  });

  test('a concurrent reuse of the same command fails closed as in-progress', async () => {
    await reset(); await add(OWNER, 'in-progress'); let release!: () => void; let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const atAuthority = new Promise<void>((resolve) => { reached = resolve; });
    const input = command('in-progress');
    const first = executeOne(input, { faultInjector: { async afterPhase(
      phase: NotificationReadCommandWritePhase) { if (phase === 'authority') { reached(); await held; } } } });
    await atAuthority;
    assert.deepEqual(await executeOne(input), { kind: 'in_progress', retryAfterSeconds: 1 });
    release(); assert.equal((await first).kind, 'succeeded');
    assert.equal((await executeOne(input)).kind, 'replay');
  }, 30_000);

  test('two real connections competing for one unread item produce one CAS winner', async () => {
    await reset(); await add(OWNER, 'race'); let release!: () => void; let reached!: () => void;
    let secondClaimed!: () => void; let firstPid = 0; let secondPid = 0;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const atAuthority = new Promise<void>((resolve) => { reached = resolve; });
    const atSecondClaim = new Promise<void>((resolve) => { secondClaimed = resolve; });
    const first = executeOne(command('race'), { faultInjector: { async afterPhase(
      phase: NotificationReadCommandWritePhase) { if (phase === 'authority') { reached(); await held; } } },
    transactionFaultInjector: { async beforeCallback(transaction) {
      firstPid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(transaction)).rows[0]!.pid;
    } } });
    await atAuthority; const second = executeOne(command('race'), {
      faultInjector: { afterPhase(phase: NotificationReadCommandWritePhase) {
        if (phase === 'receipt') secondClaimed();
      } },
      transactionFaultInjector: { async beforeCallback(transaction) {
        secondPid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(transaction)).rows[0]!.pid;
      } },
    });
    await atSecondClaim; assert.notEqual(firstPid, secondPid);
    release(); const results = await Promise.all([first, second]);
    assert.equal(results.filter((result) => result.kind === 'succeeded'
      && result.outcome === 'marked').length, 1);
    assert.equal(results.filter((result) => result.kind === 'succeeded'
      && result.outcome === 'already_read').length, 1);
    assert.equal((await isolated.runtime.pool.query(`select state_revision::int revision
      from notifications where notification_id='race'`)).rows[0].revision, 1);
  }, 30_000);

  test('faults at every write phase and before commit roll back Notification/receipt/Audit together', async () => {
    for (const phase of ['receipt', 'authority', 'audit', 'complete', 'before_commit'] as const) {
      await reset(); await add(OWNER, 'rollback');
      const options = phase === 'before_commit' ? { transactionFaultInjector: {
        afterCallbackBeforeCommit() { throw new Error(`fault-${phase}`); },
      } } : { faultInjector: { afterPhase(value: NotificationReadCommandWritePhase) {
        if (value === phase) throw new Error(`fault-${phase}`);
      } } };
      await assert.rejects(() => executeOne(command('rollback'), options), new RegExp(`fault-${phase}`));
      const row = (await isolated.runtime.pool.query(`select
        (select state from notifications where notification_id='rollback') state,
        (select count(*)::int from product_command_receipts) receipts,
        (select count(*)::int from audit_events where event_type='notification.read_state_command') audits`)).rows[0];
      assert.deepEqual(row, { state: 'unread', receipts: 0, audits: 0 });
    }
  });

  test('unknown commit outcome recovers the stored response without duplicate table effects', async () => {
    await reset(); await add(OWNER, 'unknown'); const input = command('unknown'); let injected = false;
    await assert.rejects(() => executeOne(input, { transactionFaultInjector: {
      afterCommitAcknowledged() { if (!injected) { injected = true;
        throw Object.assign(new Error('lost ack'), { code: 'ECONNRESET' }); } },
    } }), (error: unknown) => error instanceof DatabaseOperationError
      && error.kind === 'commit_outcome_unknown');
    assert.equal((await executeOne(input)).kind, 'replay');
    const row = (await isolated.runtime.pool.query(`select
      (select state_revision::int from notifications where notification_id='unknown') revision,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.read_state_command') audits`)).rows[0];
    assert.deepEqual(row, { revision: 1, receipts: 1, audits: 1 });
  });

  test('commands do not mutate Collection revisions, Operations, preferences, or deliveries', async () => {
    await reset(); await add(OWNER, 'bounded');
    const before = (await isolated.runtime.pool.query(`select
      (select count(*)::int from operations) operations,
      (select count(*)::int from collection_members) memberships,
      (select count(*)::int from notification_preferences) preferences,
      (select count(*)::int from notification_deliveries) deliveries`)).rows[0];
    await executeOne(command('bounded'));
    const after = (await isolated.runtime.pool.query(`select
      (select count(*)::int from operations) operations,
      (select count(*)::int from collection_members) memberships,
      (select count(*)::int from notification_preferences) preferences,
      (select count(*)::int from notification_deliveries) deliveries`)).rows[0];
    assert.deepEqual(after, before);
  });
});
