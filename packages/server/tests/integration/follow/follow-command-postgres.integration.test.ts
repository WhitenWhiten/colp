import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { DatabaseOperationError, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresFollowCommandUnitOfWork,
  type FollowCommandWritePhase,
} from '../../../src/infrastructure/social/index.js';
import {
  FollowCommandError,
  followProfile,
  unfollowProfile,
  type FollowCommandInput,
} from '../../../src/modules/social/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';
import { yieldToEventLoop } from '../../support/async-test-helpers.js';

const ACTOR = 'profile-actor';
const TARGET = 'profile-target';
const OTHER = 'profile-other';
const PRINCIPAL = ACTOR;
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';

describeWithPostgres('P5-03 exact-once Follow commands', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_follow_command', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function command(overrides: Partial<FollowCommandInput> = {}): FollowCommandInput {
    return {
      actor: { principalId: PRINCIPAL, profileId: ACTOR },
      targetProfileId: TARGET,
      commandId: COMMAND_ID,
      ...overrides,
    };
  }

  async function follow(value = command(), options = {}) {
    return createPostgresFollowCommandUnitOfWork(isolated.runtime.db, options)
      .execute((ports) => followProfile(ports, value));
  }

  async function unfollow(value = command(), options = {}) {
    return createPostgresFollowCommandUnitOfWork(isolated.runtime.db, options)
      .execute((ports) => unfollowProfile(ports, value));
  }

  test('first Follow and exact replay preserve the first response and one row per side effect table', async () => {
    const first = await follow();
    const replay = await follow();
    assert.equal(first.kind, 'succeeded');
    assert.equal(replay.kind, 'replay');
    assert.equal(replay.kind === 'replay' && Buffer.from(replay.body).toString('utf8'),
      first.kind === 'succeeded' ? JSON.stringify({
        actorProfileId: ACTOR, targetProfileId: TARGET, following: true,
        changedAt: first.relation.changedAt.toISOString(),
      }) : '');
    assert.deepEqual(await counts(), { follows: 1, receipts: 1, audits: 1, outbox: 2, eventIds: 3 });

    const receipt = (await isolated.runtime.pool.query(`select principal_id,command_scope,target_identity,
      request_fingerprint,result_status,contract_version from product_command_receipts`)).rows[0];
    assert.deepEqual(receipt, {
      principal_id: PRINCIPAL,
      command_scope: 'social:follow-relation:v1',
      target_identity: TARGET,
      request_fingerprint: receipt.request_fingerprint,
      result_status: 200,
      contract_version: '1.0.0',
    });
    assert.match(receipt.request_fingerprint, /^[0-9a-f]{64}$/);

    const audit = (await isolated.runtime.pool.query(`select event.principal_id,event.event_type,payload.details_json
      from audit_events event join audit_event_payloads payload on payload.event_id=event.id
      where event.event_type like 'social.follow_%'`)).rows[0];
    assert.deepEqual(audit, { principal_id: PRINCIPAL, event_type: 'social.follow_created', details_json: {
      actorProfileId: ACTOR, targetProfileId: TARGET, action: 'follow', changed: true,
    } });
    const events = (await isolated.runtime.pool.query<{
      outbox_id: string; domain_event_id: string; event_type: string; event_version: number;
      handler_name: string; handler_mode: string; aggregate_type: string; aggregate_id: string;
      aggregate_scope: string; aggregate_revision: string | null; commit_ordinal: string | null;
      payload_json: { actorProfileId: string; targetProfileId: string };
    }>(`select outbox_id,domain_event_id,event_type,event_version,handler_name,
      handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,payload_json
      from outbox_events where event_type='social.follow-created'
      order by handler_name`)).rows;
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((row) => ({
      event_type: row.event_type, event_version: row.event_version,
      handler_name: row.handler_name, handler_mode: row.handler_mode,
      aggregate_type: row.aggregate_type, aggregate_id: row.aggregate_id,
      aggregate_scope: row.aggregate_scope, aggregate_revision: row.aggregate_revision,
      commit_ordinal: row.commit_ordinal, payload_json: row.payload_json,
    })), [
      {
        event_type: 'social.follow-created', event_version: 1,
        handler_name: 'social_feed_follow_activity', handler_mode: 'delivery_each_event',
        aggregate_type: 'profile-follow', aggregate_id: ACTOR, aggregate_scope: TARGET,
        aggregate_revision: null, commit_ordinal: null,
        payload_json: { actorProfileId: ACTOR, targetProfileId: TARGET },
      },
      {
        event_type: 'social.follow-created', event_version: 1,
        handler_name: 'social_follow_activity', handler_mode: 'delivery_each_event',
        aggregate_type: 'profile-follow', aggregate_id: ACTOR, aggregate_scope: TARGET,
        aggregate_revision: null, commit_ordinal: null,
        payload_json: { actorProfileId: ACTOR, targetProfileId: TARGET },
      },
    ]);
    assert.equal(events[0]?.domain_event_id, events[1]?.domain_event_id);
    assert.notEqual(events[0]?.outbox_id, events[1]?.outbox_id);
    const ledger = (await isolated.runtime.pool.query<{ resource_id: string; resource_type: string }>(
      `select resource_id,resource_type from resource_id_ledger
        where resource_id in ($1,$2,$3) order by resource_type,resource_id`,
      [events[0]!.domain_event_id, events[0]!.outbox_id, events[1]!.outbox_id],
    )).rows;
    const expectedLedger = [
      { resource_id: events[0]!.domain_event_id, resource_type: 'social-domain-event' },
      { resource_id: events[0]!.outbox_id, resource_type: 'social-outbox' },
      { resource_id: events[1]!.outbox_id, resource_type: 'social-outbox' },
    ].sort((a, b) => (a.resource_type === b.resource_type
      ? (a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0)
      : (a.resource_type < b.resource_type ? -1 : 1)));
    assert.deepEqual(ledger, expectedLedger);
  });

  test('first Unfollow and replay delete once and emit dual removal outbox rows', async () => {
    await isolated.runtime.pool.query(
      `insert into follows(actor_profile_id,target_profile_id) values($1,$2)`, [ACTOR, TARGET],
    );
    const first = await unfollow();
    const replay = await unfollow();
    assert.equal(first.kind, 'succeeded');
    assert.equal(first.kind === 'succeeded' && first.relation.following, false);
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(await counts(), { follows: 0, receipts: 1, audits: 1, outbox: 2, eventIds: 3 });
    const rows = (await isolated.runtime.pool.query<{
      event_type: string; handler_name: string; domain_event_id: string; outbox_id: string;
    }>(`select event_type,handler_name,domain_event_id,outbox_id from outbox_events
        order by handler_name`)).rows;
    assert.deepEqual(rows.map((row) => ({
      event_type: row.event_type, handler_name: row.handler_name,
    })), [
      { event_type: 'social.follow-removed', handler_name: 'social_feed_withdrawal' },
      { event_type: 'social.follow-removed', handler_name: 'social_follow_activity' },
    ]);
    assert.equal(rows[0]?.domain_event_id, rows[1]?.domain_event_id);
    assert.notEqual(rows[0]?.outbox_id, rows[1]?.outbox_id);
  });

  test('same principal and id with different action/target reject with no duplicate effects', async () => {
    await follow();
    assert.deepEqual(await unfollow(), { kind: 'reused' });
    assert.deepEqual(await follow(command({ targetProfileId: OTHER })), { kind: 'reused' });
    assert.deepEqual(await counts(), { follows: 1, receipts: 1, audits: 1, outbox: 2, eventIds: 3 });
  });

  test('same command id is principal-scoped and cannot replay another principal result', async () => {
    await follow();
    const other = await follow(command({ actor: { principalId: OTHER, profileId: OTHER } }));
    assert.equal(other.kind, 'succeeded');
    assert.deepEqual(await counts(), { follows: 2, receipts: 2, audits: 2, outbox: 4, eventIds: 6 });
    const owners = (await isolated.runtime.pool.query<{ principal_id: string }>(
      `select principal_id from product_command_receipts order by principal_id`,
    )).rows.map((row) => row.principal_id);
    assert.deepEqual(owners, [ACTOR, OTHER]);
  });

  test('real lifecycle failures conceal while mutable handle absence does not redefine Profile identity', async () => {
    await assertProfileNotFound(() => follow(command({ targetProfileId: 'profile-missing' })));
    await isolated.runtime.pool.query(`delete from profiles where account_id=$1`, [TARGET]);
    await assertProfileNotFound(() => follow());
    await resetFixture();
    await isolated.runtime.pool.query(`delete from profile_handles where account_id=$1`, [TARGET]);
    assert.equal((await follow()).kind, 'succeeded');
    await resetFixture();
    await isolated.runtime.pool.query(
      `update accounts set status='deleted',deleted_at=current_timestamp where id=$1`, [TARGET],
    );
    await assertProfileNotFound(() => follow());
    await resetFixture();
    await isolated.runtime.pool.query(`update accounts set status='disabled' where id=$1`, [ACTOR]);
    await assertProfileNotFound(() => follow());
    await resetFixture();
    await isolated.runtime.pool.query(
      `update accounts set status='deleted',deleted_at=current_timestamp where id=$1`, [ACTOR],
    );
    await assertProfileNotFound(() => follow());
    await resetFixture();
    await assertProfileNotFound(() => follow(command({ actor: {
      principalId: OTHER, profileId: ACTOR,
    } })));
    assert.deepEqual(await counts(), { follows: 0, receipts: 0, audits: 0, outbox: 0, eventIds: 0 });
  }, 30_000);

  test('expired compact claim remains terminal with no repeated side effects', async () => {
    await follow();
    await isolated.runtime.pool.query(`update product_command_receipts set
      result_bytes=null,result_headers=null,result_media_type=null,result_status=null,
      result_purged_at=current_timestamp,compact_claim=true where command_id=$1`, [COMMAND_ID]);
    const expired = await follow();
    assert.equal(expired.kind, 'expired');
    assert.match(expired.kind === 'expired' ? expired.resultDigest ?? '' : '', /^[0-9a-f]{64}$/);
    assert.deepEqual(await counts(), { follows: 1, receipts: 1, audits: 1, outbox: 2, eventIds: 3 });
  });

  test('two real connections competing for the same command produce one receipt and one transition', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let claimed!: () => void;
    const atClaim = new Promise<void>((resolve) => { claimed = resolve; });
    const winner = follow(command(), { faultInjector: { async afterPhase(phase: FollowCommandWritePhase) {
      if (phase === 'receipt') { claimed(); await held; }
    } } });
    await atClaim;
    const competitor = await follow();
    assert.deepEqual(competitor, { kind: 'in_progress', retryAfterSeconds: 1 });
    release();
    assert.equal((await winner).kind, 'succeeded');
    assert.deepEqual(await counts(), { follows: 1, receipts: 1, audits: 1, outbox: 2, eventIds: 3 });
  }, 30_000);

  test('a Follow/Unfollow race remains transactionally ordered with no torn receipt/Audit/Outbox', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let written!: () => void;
    const atAuthority = new Promise<void>((resolve) => { written = resolve; });
    const create = follow(command(), { faultInjector: { async afterPhase(phase: FollowCommandWritePhase) {
      if (phase === 'authority') { written(); await held; }
    } } });
    await atAuthority;
    const remove = unfollow(command({ commandId: '019fa956-0c4e-4190-84df-484c41fd9684' }));
    await yieldToEventLoop();
    release();
    await Promise.all([create, remove]);
    const snapshot = await counts();
    assert.equal(snapshot.receipts, 2);
    assert.equal(snapshot.audits, 2);
    assert.equal(snapshot.outbox, snapshot.follows === 1 ? 2 : 4);
    const eventTypes = (await isolated.runtime.pool.query<{ event_type: string }>(
      `select event_type from outbox_events order by occurred_at,outbox_id`,
    )).rows.map((row) => row.event_type).sort();
    assert.deepEqual(eventTypes, snapshot.follows === 1
      ? ['social.follow-created', 'social.follow-created']
      : ['social.follow-created', 'social.follow-created',
        'social.follow-removed', 'social.follow-removed']);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from collection_members`))
      .rows[0]?.count, 0);
  });

  test('faults after authority, Audit, Outbox, receipt finalize and before commit roll back every table', async () => {
    for (const action of ['follow', 'unfollow'] as const) {
      for (const phase of ['receipt', 'authority', 'audit', 'outbox', 'complete', 'before_commit'] as const) {
        await resetFixture();
        if (action === 'unfollow') {
          await isolated.runtime.pool.query(
            `insert into follows(actor_profile_id,target_profile_id) values($1,$2)`, [ACTOR, TARGET],
          );
        }
        const ledgerBefore = (await counts()).eventIds;
        const options = phase === 'before_commit'
          ? { transactionFaultInjector: {
            afterCallbackBeforeCommit() { throw new Error(`fault-${action}-${phase}`); },
          } }
          : { faultInjector: { afterPhase(value: FollowCommandWritePhase) {
            if (value === phase) throw new Error(`fault-${action}-${phase}`);
          } } };
        const run = action === 'follow' ? follow : unfollow;
        await assert.rejects(() => run(command(), options), new RegExp(`fault-${action}-${phase}`));
        assert.deepEqual(await counts(), {
          follows: action === 'follow' ? 0 : 1,
          receipts: 0, audits: 0, outbox: 0, eventIds: ledgerBefore,
        });
      }
    }
    // Twelve fault cycles already take about 35s on an idle host.
  }, 90_000);

  test('unknown commit outcome is classified and same binding recovers the committed first response', async () => {
    let injected = false;
    await assert.rejects(() => follow(command(), { transactionFaultInjector: {
      afterCommitAcknowledged() {
        if (!injected) { injected = true; throw Object.assign(new Error('lost ack'), { code: 'ECONNRESET' }); }
      },
    } }), (error: unknown) => error instanceof DatabaseOperationError
      && error.kind === 'commit_outcome_unknown' && !error.retryableAtCommandBoundary);
    const stored = (await isolated.runtime.pool.query<{ result_bytes: Buffer }>(
      `select result_bytes from product_command_receipts where command_id=$1`, [COMMAND_ID],
    )).rows[0]!.result_bytes;
    const recovered = await follow();
    assert.equal(recovered.kind, 'replay');
    assert.deepEqual(recovered.kind === 'replay' ? Buffer.from(recovered.body) : null, stored);
    assert.deepEqual(JSON.parse(stored.toString('utf8')), {
      actorProfileId: ACTOR,
      targetProfileId: TARGET,
      following: true,
      changedAt: JSON.parse(stored.toString('utf8')).changedAt,
    });
    assert.deepEqual(await counts(), { follows: 1, receipts: 1, audits: 1, outbox: 2, eventIds: 3 });
  });

  test('Follow changes no Collection revisions, membership, policy grant, Operation or search authority', async () => {
    const before = await forbiddenEffects();
    await follow();
    assert.deepEqual(await forbiddenEffects(), before);
  });

  async function assertProfileNotFound(run: () => Promise<unknown>): Promise<void> {
    await assert.rejects(run, (error: unknown) => error instanceof FollowCommandError
      && error.code === 'resource_not_found');
  }

  async function counts() {
    return (await isolated.runtime.pool.query<{
      follows: number; receipts: number; audits: number; outbox: number; eventIds: number;
    }>(`select
      (select count(*)::int from follows) follows,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events where event_type like 'social.follow_%') audits,
      (select count(*)::int from outbox_events where event_type like 'social.follow-%') outbox,
      (select count(*)::int from resource_id_ledger
        where resource_type in ('social-domain-event','social-outbox')) "eventIds"`)).rows[0]!;
  }

  async function forbiddenEffects() {
    return (await isolated.runtime.pool.query(`select
      (select count(*)::int from collection_members) memberships,
      (select count(*)::int from collection_policies) policies,
      (select count(*)::int from operations) operations,
      (select count(*)::int from collections) collections,
      (select coalesce(sum(commit_ordinal),0)::text from collections) commit_ordinal,
      (select count(*)::int from content_revisions) content_revisions,
      (select count(*)::int from policy_revisions) policy_revisions`)).rows[0];
  }

  async function resetFixture(): Promise<void> {
    await truncateFixtureTables(isolated.runtime.pool, `truncate table product_command_receipts,outbox_events,
      audit_events,follows,resource_id_ledger cascade`);
    await isolated.runtime.pool.query(`delete from profile_handles where account_id like 'profile-%'`);
    await isolated.runtime.pool.query(`delete from profiles where account_id like 'profile-%'`);
    await isolated.runtime.pool.query(`delete from accounts where id like 'profile-%'`);
    for (const id of [ACTOR, TARGET, OTHER]) {
      await isolated.runtime.pool.query(
        `insert into accounts(id,subject_id,status) values($1,$2,'active')`, [id, `subject-${id}`],
      );
      await isolated.runtime.pool.query(
        `insert into profiles(account_id,display_name) values($1,$2)`, [id, id],
      );
      await isolated.runtime.pool.query(
        `insert into profile_handles(handle,account_id) values($1,$2)`, [id, id],
      );
    }
  }
});
