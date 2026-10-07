import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ChangePlanOperation,
  OperationResult,
  ScopeName,
} from '@know-n/colp/types';
import { buildPostgresMcpChangePlanRow, createMigrator, createMcpBindingDigest, createPostgresMcpChangePlanStore, createUnitOfWork, PostgresMcpChangePlanStoreError, runMigrations, type PostgresMcpPlanCommitResult, type PostgresMcpStoredPlan } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const OTHER_BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  ...BINDING,
  principalId: 'principal-2',
});

const CHANGED_EPOCH_BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  ...BINDING,
  securityEpoch: 'epoch-2',
});

const OPERATION: ChangePlanOperation = Object.freeze({
  type: 'set_visibility',
  collectionId: 'collection-1',
  baseRevision: 'rev-1',
  input: Object.freeze({ visibility: 'public' }),
});

const IMPACT: ChangePlanImpact = Object.freeze({
  collections: 0,
  nodes: 1,
  annotations: 0,
  attachments: 0,
  relations: 0,
  privateFieldsExcluded: [],
});

function makePlan(
  overrides: Readonly<Partial<PostgresMcpStoredPlan>> = Object.freeze({}),
): PostgresMcpStoredPlan {
  return Object.freeze({
    planId: `plan-${Math.random().toString(36).slice(2)}`,
    expiresAt: '2030-01-01T00:00:00.000Z',
    risk: 'high',
    requiresApproval: true,
    approvalMethod: 'out_of_band',
    approvalUri: 'https://approve.example/plan',
    summary: 'Review public visibility',
    impact: IMPACT,
    requiredScopes: Object.freeze(['access:write'] as readonly ScopeName[]),
    baseRevisions: Object.freeze({ collection: 'rev-1' }),
    operations: Object.freeze([OPERATION]),
    operationsDigest: 'sha-256:test-digest',
    binding: BINDING,
    untrustedNote: 'untrusted note',
    createdAt: '2029-12-31T23:59:00.000Z',
    status: 'pending',
    ...overrides,
  });
}

function makeResult(planId: string): PostgresMcpPlanCommitResult {
  const operation: OperationResult = Object.freeze({
    opId: 'op-1',
    sequence: 1,
    status: 'applied',
    revision: 'rev-2',
    cursor: 'cursor-1',
    warnings: Object.freeze([]),
  });
  return Object.freeze({
    planId,
    committedAt: '2030-01-01T00:01:00.000Z',
    operations: Object.freeze([operation]),
  });
}

describeWithPostgres('MCP-W02 session-free Change Plan/Approval/receipt authority', () => {
  let isolated: IsolatedPostgresRuntime;
  let store: ReturnType<typeof createPostgresMcpChangePlanStore>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_w02', {
      maxConnections: 12,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    store = createPostgresMcpChangePlanStore(isolated.runtime.db);
  }, 120_000);

  afterAll(async () => isolated?.close());

  beforeEach(async () => {
    await isolated.runtime.pool.query(
      'truncate table mcp_commit_receipts, mcp_approvals, mcp_change_plans cascade',
    );
  });

  test('Plan list is principal-scoped and does not compare MCP OAuth epochs', async () => {
    const current = makePlan({ planId: 'plan-current-epoch' });
    const olderOauthEpoch = makePlan({
      planId: 'plan-older-oauth-epoch',
      binding: CHANGED_EPOCH_BINDING,
    });
    const otherAccount = makePlan({
      planId: 'plan-other-account',
      binding: OTHER_BINDING,
    });
    await Promise.all([
      store.planStore.save(current),
      store.planStore.save(olderOauthEpoch),
      store.planStore.save(otherAccount),
    ]);

    const listed = await store.listByPrincipalIds({
      principalIds: [BINDING.principalId],
      limit: 100,
    });
    assert.deepEqual(
      new Set(listed.map((plan) => plan.planId)),
      new Set([current.planId, olderOauthEpoch.planId]),
    );
  });

  test('migration creates session-free tables, constraints, triggers, and retention indexes', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint
       where conrelid in (
         'mcp_change_plans'::regclass, 'mcp_approvals'::regclass, 'mcp_commit_receipts'::regclass
       )
      union all
      select indexname from pg_indexes
       where schemaname=current_schema() and tablename in (
         'mcp_change_plans', 'mcp_approvals', 'mcp_commit_receipts'
       )
      union all
      select tgname from pg_trigger
       where tgrelid in (
         'mcp_change_plans'::regclass, 'mcp_approvals'::regclass, 'mcp_commit_receipts'::regclass
       ) and not tgisinternal`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'mcp_change_plans_pkey',
      'mcp_change_plans_binding_no_session_check',
      'mcp_change_plans_approval_binding_check',
      'mcp_change_plans_time_check',
      'mcp_change_plans_transition_guard',
      'mcp_approvals_pkey',
      'mcp_approvals_binding_unique',
      'mcp_approvals_immutable',
      'mcp_commit_receipts_pkey',
      'mcp_commit_receipts_result_check',
      'mcp_commit_receipts_immutable',
      'mcp_change_plans_expiry_status_idx',
      'mcp_change_plans_retention_idx',
      'mcp_commit_receipts_retention_idx',
    ]) assert.ok(names.has(expected), `missing schema object ${expected}`);

    const sessionColumns = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count
      from information_schema.columns
      where table_schema = current_schema()
        and table_name in ('mcp_change_plans', 'mcp_approvals', 'mcp_commit_receipts')
        and lower(column_name) like '%session%'`);
    assert.equal(sessionColumns.rows[0]?.count, 0);
    await assert.rejects(
      () => isolated.runtime.pool.query('select session_id from mcp_change_plans limit 1'),
      /column "session_id" does not exist/u,
    );
  });

  test('upgrade from previous head and down/forward recovery preserve monotonic migration order', async () => {
    const previous = await createIsolatedPostgresRuntime('phase4b_mcp_w02_upgrade');
    try {
      const migrator = createHistoricalMigrator(previous, '202608061000_mcp_recursive_session_guard');
      const before = await migrator.migrateTo('202608020800_notification_email_suppressions');
      if (before.error) throw before.error;
      for (const table of ['mcp_change_plans', 'mcp_approvals', 'mcp_commit_receipts']) {
        assert.equal(await tablePresent(previous, table), false, `unexpected ${table}`);
      }

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      for (const table of ['mcp_change_plans', 'mcp_approvals', 'mcp_commit_receipts']) {
        assert.equal(await tablePresent(previous, table), true, `missing ${table}`);
      }

      const down = await migrator.migrateTo('202608020800_notification_email_suppressions');
      if (down.error) throw down.error;
      for (const table of ['mcp_change_plans', 'mcp_approvals', 'mcp_commit_receipts']) {
        assert.equal(await tablePresent(previous, table), false, `unexpected ${table} after down`);
      }

      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      for (const table of ['mcp_change_plans', 'mcp_approvals', 'mcp_commit_receipts']) {
        assert.equal(await tablePresent(previous, table), true, `missing ${table} after forward`);
      }
      await migrator.upgradeToCurrentLatest();
    } finally {
      await previous.close();
    }
  }, 120_000);

  test('repository persists full binding facts and rejects legacy session input', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    const loaded = await store.planStore.get(plan.planId);
    assert.ok(loaded);
    assert.equal(loaded?.binding.kind, 'authenticated');
    assert.deepEqual(loaded?.binding, BINDING);
    assert.equal(loaded?.status, 'pending');
    assert.equal(loaded?.operationsDigest, plan.operationsDigest);

    const legacy = Object.freeze({
      ...plan,
      sessionId: 'legacy',
    } as unknown as PostgresMcpStoredPlan);
    await assert.rejects(
      async () => {
        await store.planStore.save(legacy);
      },
      (error: unknown) => error instanceof PostgresMcpChangePlanStoreError
        && error.code === 'legacy_session_field_rejected',
    );
    assert.equal(await planCount(), 1);
    assert.deepEqual(await resourceWriteCounts(), {
      collections: 0,
      nodes: 0,
      operations: 0,
      outbox: 0,
      audits: 0,
    });

    await assert.rejects(
      () => isolated.runtime.pool.query(
        `insert into mcp_change_plans(
           plan_id, binding_kind, principal_id, client_id, credential_binding_id,
           resource_audience, security_epoch, binding_digest, binding_json, status,
           risk, requires_approval, approval_method, approval_uri, summary, impact_json,
           required_scopes_json, base_revisions_json, operations_json, operations_digest,
           untrusted_note, expires_at, created_at, updated_at, retained_until)
         select 'plan-nested-session', binding_kind, principal_id, client_id, credential_binding_id,
           resource_audience, security_epoch, binding_digest,
           jsonb_set(binding_json, '{extension}', '{"sessionId":"legacy"}'::jsonb), status,
           risk, requires_approval, approval_method, approval_uri, summary, impact_json,
           required_scopes_json, base_revisions_json, operations_json, operations_digest,
           untrusted_note, expires_at, created_at, updated_at, retained_until
           from mcp_change_plans where plan_id = $1`,
        [plan.planId],
      ),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'mcp_change_plans_binding_no_session_check',
    );
    assert.equal(await planCount(), 1);
  });

  test('state transitions are constrained and binding/content cannot be rebound', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await store.planStore.update(Object.freeze({ ...plan, status: 'approved' }));
    assert.equal((await store.planStore.get(plan.planId))?.status, 'approved');

    await assert.rejects(
      () => isolated.runtime.pool.query(
        `update mcp_change_plans set status='consumed', updated_at=current_timestamp
          where plan_id=$1`, [plan.planId],
      ),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'mcp_change_plans_transition_guard',
    );

    await assert.rejects(
      () => isolated.runtime.pool.query(
        `update mcp_change_plans set principal_id='attacker', updated_at=current_timestamp
          where plan_id=$1`, [plan.planId],
      ),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'mcp_change_plans_binding_immutable',
    );

    await store.planStore.update(Object.freeze({ ...plan, status: 'cancelled' }));
    assert.equal((await store.planStore.get(plan.planId))?.status, 'cancelled');
    await assert.rejects(
      async () => {
        await store.planStore.update(Object.freeze({
          ...plan,
          binding: OTHER_BINDING,
          status: 'approved',
        }));
      },
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'mcp_change_plans_binding_immutable',
    );
  });

  test('coordinator commit stores first result and same/different replay is exact', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    const firstResult = makeResult(plan.planId);
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const locked = await store.commitPlanStore.lock(transaction, plan.planId);
      assert.ok(locked);
      await store.commitApprovalStore.markApproved(transaction, {
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
      });
      await store.commitPlanStore.update(transaction, Object.freeze({ ...locked, status: 'approved' }));
      const claim = await store.commitApprovalStore.beginCommit(transaction, {
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
        idempotencyKey: 'key-1',
      });
      assert.equal(claim.status, 'ready');
      await store.commitPlanStore.update(transaction, Object.freeze({ ...locked, status: 'committing' }));
      await store.commitApprovalStore.finalizeCommit(transaction, {
        planId: plan.planId,
        idempotencyKey: 'key-1',
        result: firstResult,
      });
      await store.commitPlanStore.update(transaction, Object.freeze({ ...locked, status: 'consumed' }));
    });

    assert.equal((await store.planStore.get(plan.planId))?.status, 'consumed');
    const replay = await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) =>
      await store.commitApprovalStore.beginCommit(transaction, {
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
        idempotencyKey: 'key-1',
      }));
    assert.equal(replay.status, 'already_consumed');
    if (replay.status !== 'already_consumed') throw new Error('expected already_consumed replay');
    assert.deepEqual(replay.firstResult, firstResult);

    const differentKey = await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) =>
      await store.commitApprovalStore.beginCommit(transaction, {
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
        idempotencyKey: 'key-2',
      }));
    assert.deepEqual(differentKey, { status: 'rejected', reason: 'concurrent_lost' });

    const rebound = await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) =>
      await store.commitApprovalStore.beginCommit(transaction, {
        planId: plan.planId,
        binding: OTHER_BINDING,
        operationsDigest: plan.operationsDigest,
        idempotencyKey: 'key-1',
      }));
    assert.deepEqual(rebound, { status: 'rejected', reason: 'binding_mismatch' });

    const changedDigest = await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) =>
      await store.commitApprovalStore.beginCommit(transaction, {
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: 'sha-256:other-digest',
        idempotencyKey: 'key-1',
      }));
    assert.deepEqual(changedDigest, { status: 'rejected', reason: 'digest_mismatch' });

    const receipt = (await isolated.runtime.pool.query<{
      plan_id: string;
      idempotency_key: string;
      binding_digest: string;
      operations_digest: string;
      result_json: PostgresMcpPlanCommitResult;
      completed_at: Date;
    }>(`select plan_id,idempotency_key,binding_digest,operations_digest,result_json,completed_at
        from mcp_commit_receipts`)).rows[0];
    assert.ok(receipt);
    assert.equal(receipt?.idempotency_key, 'key-1');
    assert.equal(receipt?.binding_digest, createMcpBindingDigest(BINDING));
    assert.equal(receipt?.operations_digest, plan.operationsDigest);
    assert.deepEqual(receipt?.result_json, firstResult);
    assert.ok(receipt?.completed_at instanceof Date);
  });

  test('credential binding and security epoch changes cannot approve or consume a Plan', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await store.planStore.update(Object.freeze({ ...plan, status: 'approved' }));

    await assert.rejects(
      async () => {
        await store.approvalStore.markApproved({
          planId: plan.planId,
          binding: OTHER_BINDING,
          operationsDigest: plan.operationsDigest,
        });
      },
      (error: unknown) => error instanceof PostgresMcpChangePlanStoreError
        && error.code === 'binding_mismatch',
    );
    await store.approvalStore.markApproved({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
    });

    const changedEpoch = await store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: CHANGED_EPOCH_BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'key-epoch',
    });
    assert.deepEqual(changedEpoch, { status: 'rejected', reason: 'binding_mismatch' });

    const changedBinding = await store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: OTHER_BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'key-binding',
    });
    assert.deepEqual(changedBinding, { status: 'rejected', reason: 'binding_mismatch' });
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_commit_receipts`,
    )).rows[0]?.count, 0);
  });

  test('concurrent decision and consume have one database winner', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await store.planStore.update(Object.freeze({ ...plan, status: 'approved' }));
    await Promise.all([
      store.approvalStore.markApproved({
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
      }),
      store.approvalStore.markApproved({
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
      }),
    ]);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_approvals`,
    )).rows[0]?.count, 1);

    const [first, second] = await Promise.all([
      store.approvalStore.beginCommit({
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
        idempotencyKey: 'race-key',
      }),
      store.approvalStore.beginCommit({
        planId: plan.planId,
        binding: BINDING,
        operationsDigest: plan.operationsDigest,
        idempotencyKey: 'race-key',
      }),
    ]);
    assert.deepEqual(
      [first.status, second.status].sort(),
      ['ready', 'rejected'],
    );
    const rejected = first.status === 'rejected' ? first : second;
    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') assert.equal(rejected.reason, 'concurrent_lost');
    const ready = first.status === 'ready' ? first : second;
    assert.equal(ready.status, 'ready');
    await store.approvalStore.finalizeCommit({
      planId: plan.planId,
      idempotencyKey: 'race-key',
      result: makeResult(plan.planId),
    });
    assert.equal((await store.planStore.get(plan.planId))?.status, 'consumed');
    const replay = await store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'race-key',
    });
    assert.equal(replay.status, 'already_consumed');
  });

  test('caller transaction rollback restores Plan, Approval, receipt, and result state', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await assert.rejects(
      () => createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
        const locked = await store.commitPlanStore.lock(transaction, plan.planId);
        assert.ok(locked);
        await store.commitApprovalStore.markApproved(transaction, {
          planId: plan.planId,
          binding: BINDING,
          operationsDigest: plan.operationsDigest,
        });
        await store.commitPlanStore.update(transaction, Object.freeze({ ...locked, status: 'approved' }));
        const claim = await store.commitApprovalStore.beginCommit(transaction, {
          planId: plan.planId,
          binding: BINDING,
          operationsDigest: plan.operationsDigest,
          idempotencyKey: 'rollback-key',
        });
        assert.equal(claim.status, 'ready');
        await store.commitPlanStore.update(transaction, Object.freeze({ ...locked, status: 'committing' }));
        await store.commitApprovalStore.finalizeCommit(transaction, {
          planId: plan.planId,
          idempotencyKey: 'rollback-key',
          result: makeResult(plan.planId),
        });
        await store.commitPlanStore.update(transaction, Object.freeze({ ...locked, status: 'consumed' }));
        throw new Error('rollback-w02');
      }),
      /rollback-w02/u,
    );
    assert.equal((await store.planStore.get(plan.planId))?.status, 'pending');
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_approvals`,
    )).rows[0]?.count, 0);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_commit_receipts`,
    )).rows[0]?.count, 0);
  });

  test('database clock is the authority for expiry and retention', async () => {
    const future = makePlan();
    const past = makePlan({
      createdAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-01T00:01:00.000Z',
    });
    await store.planStore.save(future);
    await store.planStore.save(past);

    assert.equal(await store.expireDuePlans(), 1);
    assert.equal((await store.planStore.get(past.planId))?.status, 'expired');
    assert.equal((await store.planStore.get(future.planId))?.status, 'pending');
    await assert.rejects(
      () => store.approvalStore.markApproved({
        planId: past.planId,
        binding: BINDING,
        operationsDigest: past.operationsDigest,
      }),
      (error: unknown) => error instanceof PostgresMcpChangePlanStoreError
        && error.code === 'approval_conflict',
    );

    const retainedPlan = makePlan();
    await store.planStore.save(retainedPlan);
    await store.planStore.update(Object.freeze({ ...retainedPlan, status: 'approved' }));
    await store.approvalStore.markApproved({
      planId: retainedPlan.planId,
      binding: BINDING,
      operationsDigest: retainedPlan.operationsDigest,
    });
    const begin = await store.approvalStore.beginCommit({
      planId: retainedPlan.planId,
      binding: BINDING,
      operationsDigest: retainedPlan.operationsDigest,
      idempotencyKey: 'retention-key',
    });
    assert.equal(begin.status, 'ready');
    await store.approvalStore.finalizeCommit({
      planId: retainedPlan.planId,
      idempotencyKey: 'retention-key',
      result: makeResult(retainedPlan.planId),
    });
    await isolated.runtime.pool.query(`
      update mcp_commit_receipts set retained_until = current_timestamp - interval '1 second';
      update mcp_approvals set retained_until = current_timestamp - interval '1 second';
      update mcp_change_plans set retained_until = current_timestamp - interval '1 second'
       where status = 'consumed'
    `);
    const purged = await store.purgeRetained();
    assert.deepEqual(purged, { receipts: 1, approvals: 1, plans: 2 });
    assert.equal(await planCount(), 1);
  });

  test('direct legacy Session row shapes are rejected by the schema', async () => {
    const plan = makePlan();
    const row = buildPostgresMcpChangePlanRow(plan);
    await assert.rejects(
      () => isolated.runtime.pool.query(
        `insert into mcp_change_plans (
           plan_id, binding_kind, principal_id, client_id, credential_binding_id,
           resource_audience, security_epoch, binding_digest, binding_json, status,
           risk, requires_approval, approval_method, approval_uri, summary, impact_json,
           required_scopes_json, base_revisions_json, operations_json, operations_digest,
           untrusted_note, expires_at, created_at, updated_at, retained_until
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,
           $17::jsonb,$18::jsonb,$19::jsonb,$20,$21,$22::timestamptz,$23::timestamptz,
           current_timestamp,$22::timestamptz + interval '30 days'
         )`,
        [
          'legacy-row-plan',
          row.binding_kind,
          row.principal_id,
          row.client_id,
          row.credential_binding_id,
          row.resource_audience,
          row.security_epoch,
          row.binding_digest,
          JSON.stringify({ ...row.binding_json, sessionId: 'legacy' }),
          row.status,
          row.risk,
          row.requires_approval,
          row.approval_method,
          row.approval_uri,
          row.summary,
          JSON.stringify(row.impact_json),
          JSON.stringify(row.required_scopes_json),
          JSON.stringify(row.base_revisions_json),
          JSON.stringify(row.operations_json),
          row.operations_digest,
          row.untrusted_note,
          row.expires_at,
          row.created_at,
        ],
      ),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'mcp_change_plans_binding_no_session_check',
    );
  });

  test('expired Plans are rejected by direct beginCommit and completed replay is preserved', async () => {
    const forceExpired = async (planId: string): Promise<void> => {
      await isolated.runtime.pool.query(
        'alter table mcp_change_plans disable trigger mcp_change_plans_transition_guard',
      );
      try {
        await isolated.runtime.pool.query(
          `update mcp_change_plans set expires_at = '2000-01-01T00:00:00.000Z' where plan_id = $1`,
          [planId],
        );
      } finally {
        await isolated.runtime.pool.query(
          'alter table mcp_change_plans enable trigger mcp_change_plans_transition_guard',
        );
      }
    };

    const expiredPending = makePlan({
      createdAt: '1999-12-31T23:59:00.000Z',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await store.planStore.save(expiredPending);
    assert.deepEqual(await store.approvalStore.beginCommit({
      planId: expiredPending.planId,
      binding: BINDING,
      operationsDigest: expiredPending.operationsDigest,
      idempotencyKey: 'expired-pending-key',
    }), { status: 'rejected', reason: 'expired' });

    const expiredApproved = makePlan({ createdAt: '1999-12-31T23:59:00.000Z' });
    await store.planStore.save(expiredApproved);
    await store.approvalStore.markApproved({
      planId: expiredApproved.planId,
      binding: BINDING,
      operationsDigest: expiredApproved.operationsDigest,
    });
    await store.planStore.update(Object.freeze({ ...expiredApproved, status: 'approved' }));
    await forceExpired(expiredApproved.planId);
    assert.deepEqual(await store.approvalStore.beginCommit({
      planId: expiredApproved.planId,
      binding: BINDING,
      operationsDigest: expiredApproved.operationsDigest,
      idempotencyKey: 'expired-approved-key',
    }), { status: 'rejected', reason: 'expired' });

    const consumed = makePlan({ createdAt: '1999-12-31T23:59:00.000Z' });
    await store.planStore.save(consumed);
    await store.approvalStore.markApproved({
      planId: consumed.planId,
      binding: BINDING,
      operationsDigest: consumed.operationsDigest,
    });
    await store.planStore.update(Object.freeze({ ...consumed, status: 'approved' }));
    const claim = await store.approvalStore.beginCommit({
      planId: consumed.planId,
      binding: BINDING,
      operationsDigest: consumed.operationsDigest,
      idempotencyKey: 'expired-replay-key',
    });
    assert.equal(claim.status, 'ready');
    const result = makeResult(consumed.planId);
    await store.approvalStore.finalizeCommit({
      planId: consumed.planId,
      idempotencyKey: 'expired-replay-key',
      result,
    });
    await store.planStore.update(Object.freeze({ ...consumed, status: 'consumed' }));
    await forceExpired(consumed.planId);
    const replay = await store.approvalStore.beginCommit({
      planId: consumed.planId,
      binding: BINDING,
      operationsDigest: consumed.operationsDigest,
      idempotencyKey: 'expired-replay-key',
    });
    assert.equal(replay.status, 'already_consumed');
    if (replay.status === 'already_consumed') assert.deepEqual(replay.firstResult, result);
  });

  test('cancelled Plans reject beginCommit with plan_cancelled and never claim a receipt', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await store.approvalStore.markApproved({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
    });
    await store.planStore.update(Object.freeze({ ...plan, status: 'approved' }));
    await store.planStore.update(Object.freeze({ ...plan, status: 'cancelled' }));

    const claim = await store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'cancelled-claim-key',
    });
    assert.deepEqual(claim, { status: 'rejected', reason: 'plan_cancelled' });
    // The claim never happened, so there is nothing an executor could run.
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_commit_receipts where plan_id = $1`,
      [plan.planId],
    )).rows[0]?.count, 0);
    const approval = await isolated.runtime.pool.query<{ consumed_at: Date | null }>(
      'select consumed_at from mcp_approvals where plan_id = $1',
      [plan.planId],
    );
    assert.equal(approval.rows[0]?.consumed_at, null);
  });

  test('two-connection approved read, cancel, and claim returns plan_cancelled with zero claims', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await store.approvalStore.markApproved({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
    });
    await store.planStore.update(Object.freeze({ ...plan, status: 'approved' }));

    // Connection 1: the approved read.
    assert.equal((await store.planStore.get(plan.planId))?.status, 'approved');
    // Connection 2: cancel wins before the claim.
    await store.planStore.update(Object.freeze({ ...plan, status: 'cancelled' }));
    // Connection 1: the claim observes the terminal state and never executes.
    const claim = await store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'read-cancel-claim-key',
    });
    assert.deepEqual(claim, { status: 'rejected', reason: 'plan_cancelled' });
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_commit_receipts where plan_id = $1`,
      [plan.planId],
    )).rows[0]?.count, 0);
  });

  test('beginCommit blocked on a concurrent cancel observes plan_cancelled after the row lock is released', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await store.approvalStore.markApproved({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
    });
    await store.planStore.update(Object.freeze({ ...plan, status: 'approved' }));

    // Connection 2: cancel wins the row lock first and holds the update open.
    let releaseCancel!: () => void;
    const cancelReleased = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancelling = createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await store.commitPlanStore.update(transaction, Object.freeze({ ...plan, status: 'cancelled' }));
      await cancelReleased;
    });
    // Connection 1: the claim blocks on the plan row lock and then observes
    // the committed cancelled state instead of racing the transition guard.
    const claiming = store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'lock-race-cancel-key',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCancel();
    const claim = await claiming;
    await cancelling;
    assert.deepEqual(claim, { status: 'rejected', reason: 'plan_cancelled' });
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_commit_receipts where plan_id = $1`,
      [plan.planId],
    )).rows[0]?.count, 0);
  });

  test('completed replay stays authoritative for cancelled Plans instead of plan_cancelled', async () => {
    const plan = makePlan();
    await store.planStore.save(plan);
    await store.approvalStore.markApproved({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
    });
    await store.planStore.update(Object.freeze({ ...plan, status: 'approved' }));
    const claim = await store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'cancelled-replay-key',
    });
    assert.equal(claim.status, 'ready');
    const result = makeResult(plan.planId);
    await store.approvalStore.finalizeCommit({
      planId: plan.planId,
      idempotencyKey: 'cancelled-replay-key',
      result,
    });
    // Defensive terminal override: a completed receipt on a cancelled Plan
    // must still replay the first result before any plan_cancelled rejection.
    await isolated.runtime.pool.query(
      'alter table mcp_change_plans disable trigger mcp_change_plans_transition_guard',
    );
    try {
      await isolated.runtime.pool.query(
        `update mcp_change_plans set status = 'cancelled' where plan_id = $1`,
        [plan.planId],
      );
    } finally {
      await isolated.runtime.pool.query(
        'alter table mcp_change_plans enable trigger mcp_change_plans_transition_guard',
      );
    }
    const replay = await store.approvalStore.beginCommit({
      planId: plan.planId,
      binding: BINDING,
      operationsDigest: plan.operationsDigest,
      idempotencyKey: 'cancelled-replay-key',
    });
    assert.equal(replay.status, 'already_consumed');
    if (replay.status === 'already_consumed') assert.deepEqual(replay.firstResult, result);
  });

  test('low-risk cancelled Plans reject beginCommit with plan_cancelled', async () => {
    const lowRisk = makePlan({
      risk: 'low',
      requiresApproval: false,
      approvalMethod: undefined,
      approvalUri: undefined,
    });
    await store.planStore.save(lowRisk);
    await store.planStore.update(Object.freeze({ ...lowRisk, status: 'cancelled' }));
    const claim = await store.approvalStore.beginCommit({
      planId: lowRisk.planId,
      binding: BINDING,
      operationsDigest: lowRisk.operationsDigest,
      idempotencyKey: 'low-risk-cancelled-key',
    });
    assert.deepEqual(claim, { status: 'rejected', reason: 'plan_cancelled' });
  });

  async function planCount(): Promise<number> {
    return (await isolated.runtime.pool.query<{ count: number }>(
      'select count(*)::int count from mcp_change_plans',
    )).rows[0]?.count ?? -1;
  }

  async function resourceWriteCounts() {
    return (await isolated.runtime.pool.query<{
      collections: number;
      nodes: number;
      operations: number;
      outbox: number;
      audits: number;
    }>(`select
      (select count(*)::int from collections) collections,
      (select count(*)::int from nodes) nodes,
      (select count(*)::int from operations) operations,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from audit_events) audits`)).rows[0]!;
  }
});

async function tablePresent(
  runtime: IsolatedPostgresRuntime,
  table: string,
): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null present`, [table],
  )).rows[0]?.present ?? false;
}
