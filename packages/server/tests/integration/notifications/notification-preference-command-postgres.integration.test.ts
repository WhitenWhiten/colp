import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { DatabaseOperationError, runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresNotificationPreferenceCommandUnitOfWork,
  getPostgresNotificationPreferences,
  type NotificationPreferenceCommandWritePhase,
} from '../../../src/infrastructure/notifications/index.js';
import { getNotificationPreferences, updateNotificationPreference }
  from '../../../src/modules/notifications/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime, truncateFixtureTables } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-20 Notification preference commands', () => {
  let isolated: IsolatedPostgresRuntime;
  const OWNER = 'preference-owner'; const OTHER = 'preference-other';
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('p5_notification_preference',
    { maxConnections: 8 }); await runMigrations(isolated.runtime.db, 'latest'); }, 120_000);
  afterAll(async () => isolated?.close());

  async function reset(): Promise<void> {
    await truncateFixtureTables(isolated.runtime.pool, `truncate table product_command_receipts,audit_events,
      notification_preferences cascade`);
    await isolated.runtime.pool.query(`delete from accounts where id in ($1,$2)`, [OWNER, OTHER]);
    for (const id of [OWNER, OTHER]) await isolated.runtime.pool.query(
      `insert into accounts(id,subject_id,status) values($1,$2,'active')`, [id, `subject-${id}`]);
  }
  const command = (enabled: boolean, commandId = randomUUID()) => ({ principalId: OWNER,
    channel: 'in_app' as const, mode: 'set' as const, enabled, expectedRevision: 0n, commandId });
  const emailCommand = (enabled: boolean, commandId = randomUUID()) => ({ principalId: OWNER,
    channel: 'email' as const, mode: 'set' as const, enabled, expectedRevision: 0n, commandId });
  const execute = (input: ReturnType<typeof command> | ReturnType<typeof emailCommand> | {
    principalId: string; channel: 'in_app' | 'email'; mode: 'reset'; expectedRevision: bigint; commandId: string
  }, options = {}) => createPostgresNotificationPreferenceCommandUnitOfWork(isolated.runtime.db,
    options).execute((ports) => updateNotificationPreference(ports, input));

  test('first read persists stable server defaults and exposes both channels additively', async () => {
    await reset();
    const first = await getNotificationPreferences(getPostgresNotificationPreferences(
      isolated.runtime.db), { principalId: OWNER });
    const second = await getNotificationPreferences(getPostgresNotificationPreferences(
      isolated.runtime.db), { principalId: OWNER });
    assert.deepEqual(first, second);
    assert.deepEqual({ channel: first.channel, enabled: first.enabled, revision: first.revision },
      { channel: 'in_app', enabled: true, revision: 0n });
    assert.deepEqual({ enabled: first.email.enabled, revision: first.email.revision,
      emailSuppressed: first.email.emailSuppressed },
    { enabled: false, revision: 0n, emailSuppressed: false });
    assert.equal(first.email.verifiedSender, null);
    assert.equal(first.email.emailAvailable, false);
    const rows = (await isolated.runtime.pool.query(`select channel,enabled,state_revision::int revision
      from notification_preferences where recipient_account_id=$1 order by channel`, [OWNER])).rows;
    assert.deepEqual(rows, [
      { channel: 'email', enabled: false, revision: 0 },
      { channel: 'in_app', enabled: true, revision: 0 },
    ]);
  });

  test('exact replay/reuse and reset/no-op preserve authority, receipt and Audit single effects', async () => {
    await reset(); const commandId = randomUUID();
    const first = await execute(command(false, commandId));
    assert.deepEqual(first.kind, 'succeeded');
    const replay = await execute(command(false, commandId)); assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')),
        JSON.parse(JSON.stringify(first, (_key, value) => typeof value === 'bigint'
          ? value.toString() : value)));
      assert.equal(replay.targetIdentity, 'in_app');
    }
    const receipt = (await isolated.runtime.pool.query(`select principal_id,command_scope,
      request_fingerprint,contract_version,target_identity,result_status,result_headers,
      result_media_type,result_bytes,result_digest,
      completed_at is not null completed from product_command_receipts where command_id=$1`,
    [commandId])).rows[0];
    assert.equal(receipt.principal_id, OWNER);
    assert.equal(receipt.command_scope, 'notification:preference:v1');
    assert.match(receipt.request_fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual({ contract_version: receipt.contract_version,
      target_identity: receipt.target_identity, result_status: receipt.result_status,
      result_media_type: receipt.result_media_type, completed: receipt.completed },
    { contract_version: '1.0.0', target_identity: 'in_app', result_status: 200,
      result_media_type: 'application/json', completed: true });
    assert.deepEqual(receipt.result_headers,
      { 'cache-control': 'private, no-store', 'content-type': 'application/json' });
    assert.match(receipt.result_digest, /^[0-9a-f]{64}$/);
    assert.equal(createHash('sha256').update(receipt.result_bytes).digest('hex'),
      receipt.result_digest);
    await isolated.runtime.pool.query(`update product_command_receipts set result_bytes=null,
      result_headers=null,result_media_type=null,result_status=null,compact_claim=true,
      result_purged_at=current_timestamp where command_id=$1`, [commandId]);
    assert.equal((await execute(command(false, commandId))).kind, 'expired');
    assert.equal((await execute({ principalId: OWNER, channel: 'in_app', mode: 'reset',
      expectedRevision: 1n, commandId: randomUUID() })).kind, 'succeeded');
    const noOp = await execute({ ...command(true), expectedRevision: 2n });
    assert.deepEqual(noOp.kind, 'succeeded');
    if (noOp.kind === 'succeeded') { assert.equal(noOp.changed, false); assert.equal(noOp.revision, 2n); }
    assert.equal((await execute(command(true, commandId))).kind, 'reused');
    const row = (await isolated.runtime.pool.query(`select
      (select enabled from notification_preferences where recipient_account_id=$1 and channel='in_app') enabled,
      (select state_revision::int from notification_preferences where recipient_account_id=$1 and channel='in_app') revision,
      (select state_revision::int from notification_preferences where recipient_account_id=$1 and channel='email') email_revision,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.preference_command') audits`,
    [OWNER])).rows[0];
    assert.deepEqual(row, { enabled: true, revision: 2, email_revision: 0, receipts: 3, audits: 3 });
    const audits = (await isolated.runtime.pool.query<{ details_json: Record<string, unknown> }>(
      `select payload.details_json from audit_events event join audit_event_payloads payload on payload.event_id=event.id where event.event_type='notification.preference_command'`)).rows;
    for (const audit of audits) assert.deepEqual(Object.keys(audit.details_json).sort(),
      ['changed', 'channel', 'mode', 'outcome']);
  });

  test('email channel commands persist independently with per-channel revision CAS and replay', async () => {
    await reset(); const commandId = randomUUID();
    const first = await execute(emailCommand(true, commandId));
    assert.deepEqual(first.kind, 'succeeded');
    if (first.kind === 'succeeded') {
      assert.equal(first.channel, 'email'); assert.equal(first.enabled, true);
      assert.equal(first.revision, 1n);
    }
    const replay = await execute(emailCommand(true, commandId));
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') assert.equal(replay.targetIdentity, 'email');
    await assert.rejects(() => execute(emailCommand(false)), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'stale_revision');
    assert.deepEqual((await execute(command(false))).kind, 'succeeded');
    const row = (await isolated.runtime.pool.query(`select
      (select enabled from notification_preferences where recipient_account_id=$1 and channel='email') email_enabled,
      (select state_revision::int from notification_preferences where recipient_account_id=$1 and channel='email') email_revision,
      (select enabled from notification_preferences where recipient_account_id=$1 and channel='in_app') in_app_enabled,
      (select state_revision::int from notification_preferences where recipient_account_id=$1 and channel='in_app') in_app_revision`,
    [OWNER])).rows[0];
    assert.deepEqual(row, { email_enabled: true, email_revision: 1,
      in_app_enabled: false, in_app_revision: 1 });
    const resetResult = await execute({ principalId: OWNER, channel: 'email', mode: 'reset',
      expectedRevision: 1n, commandId: randomUUID() });
    assert.deepEqual(resetResult.kind, 'succeeded');
    if (resetResult.kind === 'succeeded') {
      assert.equal(resetResult.channel, 'email'); assert.equal(resetResult.enabled, false);
      assert.equal(resetResult.revision, 2n);
    }
  });

  test('a concurrent reuse of the same durable command claim fails closed as in-progress', async () => {
    await reset(); let release!: () => void; let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const atAuthority = new Promise<void>((resolve) => { reached = resolve; });
    const input = command(false);
    const first = execute(input, { faultInjector: { async afterPhase(
      phase: NotificationPreferenceCommandWritePhase) { if (phase === 'authority') {
        reached(); await held; } } } });
    await atAuthority;
    assert.deepEqual(await execute(input), { kind: 'in_progress', retryAfterSeconds: 1 });
    release(); assert.equal((await first).kind, 'succeeded');
    assert.equal((await execute(input)).kind, 'replay');
  }, 30_000);

  test('stale revision rolls back receipt and leaves authority and Audit untouched', async () => {
    await reset(); await getNotificationPreferences(getPostgresNotificationPreferences(
      isolated.runtime.db), { principalId: OWNER });
    await assert.rejects(() => execute({ ...command(false), expectedRevision: 1n }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'stale_revision');
    const row = (await isolated.runtime.pool.query(`select
      (select enabled from notification_preferences where recipient_account_id=$1 and channel='in_app') enabled,
      (select state_revision::int from notification_preferences where recipient_account_id=$1 and channel='in_app') revision,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.preference_command') audits`,
    [OWNER])).rows[0];
    assert.deepEqual(row, { enabled: true, revision: 0, receipts: 0, audits: 0 });
  });

  test('two real connections with the same channel revision produce one winner', async () => {
    await reset(); let release!: () => void; let reached!: () => void; let secondClaimed!: () => void;
    let firstPid = 0; let secondPid = 0;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const atAuthority = new Promise<void>((resolve) => { reached = resolve; });
    const atSecondClaim = new Promise<void>((resolve) => { secondClaimed = resolve; });
    const first = execute(command(false), { faultInjector: { async afterPhase(
      phase: NotificationPreferenceCommandWritePhase) { if (phase === 'authority') {
        reached(); await held; } } }, transactionFaultInjector: { async beforeCallback(transaction) {
      firstPid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(transaction)).rows[0]!.pid;
    } } });
    await atAuthority;
    const second = execute(command(false), { faultInjector: { afterPhase(
      phase: NotificationPreferenceCommandWritePhase) { if (phase === 'receipt') secondClaimed(); } },
    transactionFaultInjector: { async beforeCallback(transaction) {
      secondPid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(transaction)).rows[0]!.pid;
    } } });
    await atSecondClaim; assert.notEqual(firstPid, secondPid); release();
    const settled = await Promise.allSettled([first, second]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((item) => item.status === 'rejected'
      && item.reason?.code === 'stale_revision').length, 1);
    const row = (await isolated.runtime.pool.query(`select
      (select state_revision::int from notification_preferences where recipient_account_id=$1 and channel='in_app') revision,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.preference_command') audits`,
    [OWNER])).rows[0];
    assert.deepEqual(row, { revision: 1, receipts: 1, audits: 1 });
  }, 30_000);

  test('faults at every write phase and before commit roll back all three tables', async () => {
    for (const phase of ['receipt', 'authority', 'audit', 'complete', 'before_commit'] as const) {
      await reset();
      const options = phase === 'before_commit' ? { transactionFaultInjector: {
        afterCallbackBeforeCommit() { throw new Error(`fault-${phase}`); },
      } } : { faultInjector: { afterPhase(value: NotificationPreferenceCommandWritePhase) {
        if (value === phase) throw new Error(`fault-${phase}`);
      } } };
      await assert.rejects(() => execute(command(false), options), new RegExp(`fault-${phase}`));
      const row = (await isolated.runtime.pool.query(`select
        (select count(*)::int from notification_preferences) preferences,
        (select count(*)::int from product_command_receipts) receipts,
        (select count(*)::int from audit_events where event_type='notification.preference_command') audits`)).rows[0];
      assert.deepEqual(row, { preferences: 0, receipts: 0, audits: 0 });
    }
  });

  test('unknown commit outcome recovers stored response without duplicate effects', async () => {
    await reset(); const input = command(false); let injected = false;
    await assert.rejects(() => execute(input, { transactionFaultInjector: {
      afterCommitAcknowledged() { if (!injected) { injected = true;
        throw Object.assign(new Error('lost ack'), { code: 'ECONNRESET' }); } },
    } }), (error: unknown) => error instanceof DatabaseOperationError
      && error.kind === 'commit_outcome_unknown');
    assert.equal((await execute(input)).kind, 'replay');
    const row = (await isolated.runtime.pool.query(`select
      (select state_revision::int from notification_preferences where recipient_account_id=$1 and channel='in_app') revision,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type='notification.preference_command') audits`,
    [OWNER])).rows[0];
    assert.deepEqual(row, { revision: 1, receipts: 1, audits: 1 });
  });

  test('all reads/writes are principal-scoped and account deletion removes preference authority', async () => {
    await reset(); const sharedCommandId = randomUUID();
    await execute(command(false, sharedCommandId));
    await execute({ ...command(false, sharedCommandId), principalId: OTHER });
    const other = await getNotificationPreferences(getPostgresNotificationPreferences(
      isolated.runtime.db), { principalId: OTHER });
    assert.equal(other.enabled, false); assert.equal(other.revision, 1n);
    const isolatedEffects = (await isolated.runtime.pool.query(`select
      (select count(*)::int from product_command_receipts where command_id=$1) receipts,
      (select count(*)::int from audit_events where event_type='notification.preference_command') audits,
      (select count(*)::int from notification_preferences where channel='in_app'
        and enabled=false and state_revision=1) authorities`, [sharedCommandId])).rows[0];
    assert.deepEqual(isolatedEffects, { receipts: 2, audits: 2, authorities: 2 });
    await isolated.runtime.pool.query(`update accounts set status='deleted',deleted_at=current_timestamp
      where id=$1`, [OWNER]);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from notification_preferences where recipient_account_id=$1`, [OWNER])).rows[0].count, 0);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from notification_preferences where recipient_account_id=$1`, [OTHER])).rows[0].count, 2);
    await assert.rejects(() => getNotificationPreferences(getPostgresNotificationPreferences(
      isolated.runtime.db), { principalId: OWNER }));
    const rejectedCommandId = randomUUID();
    await assert.rejects(() => execute({ ...command(true, rejectedCommandId), expectedRevision: 1n }));
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from product_command_receipts where command_id=$1`, [rejectedCommandId])).rows[0].count, 0);
  });

  test('preference commands do not mutate inbox, delivery, Collection or canonical Operation state', async () => {
    await reset();
    await isolated.runtime.pool.query(`insert into notifications(notification_id,
      recipient_account_id,source_event_id,notification_type,subject_type,subject_id,
      occurred_at,retain_until) values('preference-inbox',$1,'preference-event',
      'follow_activity','profile','profile-subject','2026-07-29T01:00:00Z',
      '2027-07-29T01:00:00Z')`, [OWNER]);
    await isolated.runtime.pool.query(`insert into notification_deliveries(delivery_id,
      notification_id,recipient_account_id,channel) values
      ('preference-delivery','preference-inbox',$1,'email')`, [OWNER]);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at) values
        ('preference-collection','collection',current_timestamp),
        ('preference-root','node',current_timestamp),
        ('preference-operation','operation',current_timestamp)`);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,
        root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal)
        values('preference-collection','subject-preference-owner','Preference baseline',
        'bookmarks','private','preference-root','resource-r7','content-r8','policy-r9',11)`);
      await client.query(`insert into nodes(id,collection_id,kind,is_root,title,
        resource_revision,children_revision) values('preference-root','preference-collection',
        'folder',true,'Root','root-r2','children-r3')`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback'); throw error;
    } finally { client.release(); }
    await insertTestOperation(isolated.runtime.db, {
      operationId: 'preference-operation', collectionId: 'preference-collection',
      commitOrdinal: 11n, operationType: 'baseline', payloadJson: { stable: true },
      actorPrincipalId: OWNER,
    });
    const snapshot = () => isolated.runtime.pool.query(`select
      (select row_to_json(value) from (select notification_id,state,state_revision::text,read_at,
        occurred_at,retain_until from notifications where notification_id='preference-inbox') value)
        notification,
      (select row_to_json(value) from (select delivery_id,state,attempt_count,
        state_revision::text,next_attempt_at,leased_until,delivered_at,suppressed_at,
        dead_lettered_at,provider_message_id from notification_deliveries
        where delivery_id='preference-delivery') value) delivery,
      (select row_to_json(value) from (select resource_revision,content_revision,policy_revision,
        commit_ordinal::text,updated_at,deleted_at from collections
        where id='preference-collection') value) collection,
      (select row_to_json(value) from (select operation.operation_id,operation.collection_id,
        operation.commit_ordinal::text,operation.operation_type,payload.payload_json,
        operation.actor_principal_id,operation.created_at
        from operations operation join operation_payloads payload using (operation_id)
        where operation.operation_id='preference-operation') value) operation`);
    const before = (await snapshot()).rows[0];
    await execute(command(false));
    const after = (await snapshot()).rows[0];
    assert.deepEqual(after, before);
  });
});
