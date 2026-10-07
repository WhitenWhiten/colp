import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresNotificationOperationsRepository,
  SOCIAL_FEED_WITHDRAWAL_HANDLER } from '../../../src/infrastructure/notifications/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

/**
 * E-OPS-007 evidence: withdrawal dead-letter replay at production capacity.
 *
 * Decision question (FIX-L-063): the account-scoped dead-letter replay
 * (`notification-operations-postgres.ts` replayDeadLetters) predicates on
 * `payload_json->>'actorProfileId'` for the withdrawal handler, and the outbox
 * table only has claim/expired-lease indexes. This suite measures whether the
 * CURRENT plan (no predicate index) violates an ops budget at target scale.
 * Per the task contract, NO index is added unless the measured plan breaks the
 * budget — the gates below decide that.
 *
 * Production capacity assumptions (explicit evidence contract):
 * - outbox_events target table size: 1,000,000 rows across ALL handlers. The
 *   replay candidate scan has no usable predicate index, so the planner reads
 *   the whole table; total table size is the cost driver.
 * - State mix at that size: completed 900k (90%), pending 89k (8.9%),
 *   leased 1k (0.1%), dead_letter 10k (1%).
 * - Handler mix: social_follow_activity 30%, social_feed_item_notification
 *   20%, social_feed_withdrawal 2%, social.publish-collection-change 48%.
 * - Withdrawal share of dead letters: 200 rows = 2% of all dead letters
 *   (10% of the 2,000 social-handler dead letters).
 * - The evidence target account adds its own 105 dead letters (50 withdrawal
 *   + 50 non-withdrawal + 5 unknown-future-version) so the replay surface is
 *   exercised at scale with a realistic per-account dead-letter backlog
 *   (≈10% of the 1000-row replay cap).
 * - Replay is a manual, low-frequency ops action capped at 1000 rows. Wide
 *   budget: execution time ≤ 5 000 ms at target scale (cold measurement on
 *   postgres:16.4-alpine is ≈80 ms, so 5 s leaves >60× headroom for CI
 *   variance; time is deliberately NOT a tight gate).
 *
 * Gate priority (task doc): plan shape → candidate scanned-rows upper bound →
 * no disk spill; time only as the wide budget above. Behavior re-checks
 * (task step 5): SKIP LOCKED, limit ≤ 1000, cross-account isolation,
 * allowUnknownFutureVersion fencing, replay re-entrancy.
 */
const TARGET_ACCOUNT = 'eops-target';
const REPLAY_LIMIT_MAX = 1_000;
const CAPACITY_TOTAL_OUTBOX_ROWS = 1_000_000;
const CAPACITY_STATE_MIX = Object.freeze({ completed: 900_000, pending: 89_000,
  leased: 1_000, deadLetter: 10_000 });
const CAPACITY_DEAD_LETTER_TOTAL = CAPACITY_STATE_MIX.deadLetter + 105;
const CAPACITY_DEAD_LETTER_BY_HANDLER = Object.freeze({
  social_follow_activity: 3_000 + 53,
  social_feed_item_notification: 2_000,
  social_feed_withdrawal: 200 + 52,
  'social.publish-collection-change': 4_800,
});
const REPLAY_EXECUTION_MS_MAX = 5_000;

// Byte-identical copy of the production replay statement (replayDeadLetters in
// notification-operations-postgres.ts); the test below pins it against the
// source so the evidence cannot silently drift from the executed query.
const REPLAY_CANDIDATE_SQL = `with candidates as (
  select outbox_id from outbox_events where handler_name=any($1::text[])
    and state='dead_letter'
    and (
      (handler_name<>$4 and aggregate_scope=$2)
      or (handler_name=$4 and payload_json->>'actorProfileId'=$2)
    )
    and ($5::boolean or last_error not ilike '%unknown%version%')
    order by dead_lettered_at,outbox_id for update skip locked limit $3)
update outbox_events event set state='retryable',available_at=current_timestamp,
  dead_lettered_at=null,locked_until=null from candidates
where event.outbox_id=candidates.outbox_id and event.state='dead_letter'
returning event.outbox_id`;

const HANDLERS = ['social_follow_activity', 'social_feed_item_notification',
  SOCIAL_FEED_WITHDRAWAL_HANDLER];

describeWithPostgres('E-OPS-007 withdrawal dead-letter replay plan at production capacity', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_withdrawal_replay_plan', {
      maxConnections: 8, statementTimeoutMs: 300_000,
      applicationName: 'known-eops007-evidence',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCapacityCorpus(isolated);
    await isolated.runtime.pool.query('analyze outbox_events');
  }, 300_000);

  afterAll(async () => isolated?.close());

  test('capacity corpus matches the documented production mix', async () => {
    const states = await counts(`select state,count(*)::text count from outbox_events
      group by state`);
    assert.deepEqual(states, {
      completed: CAPACITY_STATE_MIX.completed,
      pending: CAPACITY_STATE_MIX.pending,
      leased: CAPACITY_STATE_MIX.leased,
      dead_letter: CAPACITY_DEAD_LETTER_TOTAL,
    }, 'state mix must match the documented capacity assumptions');
    const total = await counts(`select count(*)::text count from outbox_events`);
    assert.equal(total.count, CAPACITY_TOTAL_OUTBOX_ROWS + 105,
      'total outbox rows must be the documented 1M corpus plus the target account rows');
    const deadByHandler = await counts(`select handler_name,count(*)::text count
      from outbox_events where state='dead_letter' group by handler_name`);
    assert.deepEqual(deadByHandler, CAPACITY_DEAD_LETTER_BY_HANDLER,
      'dead-letter distribution by handler must match the documented withdrawal ratio');
  });

  test('replay candidate EXPLAIN stays within budget without a predicate index', async () => {
    // Drift guard: the EXPLAINed statement must stay byte-identical to the
    // production query, otherwise this evidence silently stops measuring the
    // shipped replay.
    const source = readFileSync(resolve(import.meta.dirname,
      '../../../src/infrastructure/notifications/notification-operations-postgres.ts'), 'utf8');
    const extracted = /query<\{ outbox_id: string \}>\(`([\s\S]*?)`/u.exec(source)?.[1];
    assert.ok(extracted, 'production replay statement must be extractable');
    assert.equal(normalize(extracted), normalize(REPLAY_CANDIDATE_SQL),
      'evidence statement must match the production replay query verbatim');

    const client = await isolated.runtime.pool.connect();
    let plan: ReplayPlan;
    try {
      await client.query('begin');
      const explained = await client.query<{ 'QUERY PLAN': ReplayPlan[] }>(
        `explain (analyze, buffers, format json) ${REPLAY_CANDIDATE_SQL}`,
        [HANDLERS, TARGET_ACCOUNT, REPLAY_LIMIT_MAX, SOCIAL_FEED_WITHDRAWAL_HANDLER, false]);
      await client.query('rollback');
      const first = explained.rows[0]?.['QUERY PLAN']?.[0];
      assert.ok(first, 'EXPLAIN must return a plan');
      plan = first;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const nodes = flattenPlan(plan.Plan);
    const candidateScans = nodes.filter((node) =>
      node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'outbox_events');
    // Plan shape: with no predicate index the planner must sweep the whole
    // table once for the candidate set (bounded by table size), lock it via
    // FOR UPDATE SKIP LOCKED, top-N sort by (dead_lettered_at,outbox_id), and
    // join the materialized candidates back through the primary key. If a
    // partial expression index is ever introduced, this shape assertion is the
    // gate that must be re-evidenced as part of that migration.
    assert.equal(candidateScans.length, 1,
      `exactly one candidate scan on outbox_events expected (nodes: ${nodes.map((n) => n['Node Type']).join(',')})`);
    const candidate = candidateScans[0]!;
    const scanned = (candidate['Actual Rows'] ?? 0) + (candidate['Rows Removed by Filter'] ?? 0);
    assert.equal(scanned, CAPACITY_TOTAL_OUTBOX_ROWS + 105,
      'candidate scan must read exactly the seeded corpus (no multiplicative blow-up)');
    assert.ok((candidate['Rows Removed by Filter'] ?? 0) >= CAPACITY_TOTAL_OUTBOX_ROWS,
      'the current plan sweeps the full table; the filter removes the non-candidates');
    assert.ok(nodes.some((node) => node['Node Type'] === 'LockRows'),
      'plan must keep FOR UPDATE SKIP LOCKED on the candidates');
    assert.ok(nodes.some((node) => node['Node Type'] === 'ModifyTable'
      && node['Operation'] === 'Update'), 'plan must update outbox_events from the candidates');
    assert.ok(nodes.some((node) => node['Node Type'] === 'Index Scan'
      && node['Index Name'] === 'outbox_events_pkey'),
      'candidates must be joined back through the primary key');
    const limitNode = nodes.find((node) => node['Node Type'] === 'Limit');
    assert.ok(limitNode, 'plan must contain the replay limit');
    assert.ok((limitNode['Actual Rows'] ?? 0) <= REPLAY_LIMIT_MAX,
      `limit must be bounded by the 1000-row replay cap (actual ${limitNode['Actual Rows']})`);
    // No disk spill: every sort must be in-memory and no node may write temp files.
    for (const node of nodes.filter((node) => node['Node Type'] === 'Sort')) {
      assert.equal(node['Sort Space Type'], 'Memory',
        `candidate sort must stay in memory (${node['Sort Space Type']})`);
      assert.ok(node['Sort Method'] !== 'external merge',
        `candidate sort must not spill (${node['Sort Method']})`);
    }
    assert.equal(nodes.filter((node) => (node['Disk Usage'] ?? 0) > 0).length, 0,
      'no hash node may spill to disk');
    assert.equal(plan.Plan['Temp Written Blocks'] ?? 0, 0,
      'the statement must not write temp files');
    // Wide budget only: an interactive ops replay must complete well under the
    // documented cap at target scale. Measured cold ≈80 ms on 16.4-alpine, so
    // 5 s is deliberately generous and environment-tolerant.
    assert.ok(plan['Execution Time'] <= REPLAY_EXECUTION_MS_MAX,
      `replay execution must fit the wide budget (${plan['Execution Time']} ms > ${REPLAY_EXECUTION_MS_MAX})`);
    const buffers = (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0)
      + (plan.Plan['Shared Dirtied Blocks'] ?? 0) + (plan.Plan['Shared Written Blocks'] ?? 0);
    console.info(JSON.stringify({
      task: 'E-OPS-007', verdict: 'budget-pass', indexAdded: false,
      planShape: summarizePlan(plan), candidateScanRows: scanned,
      limitActualRows: limitNode['Actual Rows'], buffers, executionMs: plan['Execution Time'],
      planningMs: plan['Planning Time'], jit: plan.JIT !== undefined,
    }, null, 2));
  }, 120_000);

  test('at-scale replay keeps SKIP LOCKED, cross-account isolation, future fencing and re-entrancy',
    async () => {
      const pool = isolated.runtime.pool;
      const operations = createPostgresNotificationOperationsRepository(pool);
      const expected = targetOutboxIds();
      const future = new Set([51, 52, 103, 104, 105].map((n) => n <= 52
        ? `eops-target-wd-${String(n).padStart(3, '0')}`
        : `eops-target-fw-${String(n - 52).padStart(3, '0')}`));
      const normal = expected.filter((id) => !future.has(id));
      assert.equal(normal.length, 100);
      assert.equal(future.size, 5);

      // SKIP LOCKED: another connection holds two candidate rows; the replay
      // must skip exactly those and still drain the remaining account backlog.
      const locker = await pool.connect();
      try {
        await locker.query('begin');
        await locker.query(`select outbox_id from outbox_events where outbox_id=any($1::text[])
          for update`, [['eops-target-wd-001', 'eops-target-fw-001']]);
        const first = await operations.replayDeadLetters({ recipientAccountId: TARGET_ACCOUNT,
          limit: REPLAY_LIMIT_MAX });
        assert.equal(first.outboxIds.length, 98,
          'replay must skip the two locked rows and drain the remaining 98');
        assert.deepEqual(sortIds(first.outboxIds), sortIds(normal.filter((id) =>
          id !== 'eops-target-wd-001' && id !== 'eops-target-fw-001')),
          'replayed ids must be exactly the unlocked, non-future target candidates');
        assert.equal(first.deliveryIds.length, 0);
      } finally {
        await locker.query('rollback').catch(() => undefined);
        locker.release();
      }
      // The previously locked rows are still dead_letter and now unlocked.
      const second = await operations.replayDeadLetters({ recipientAccountId: TARGET_ACCOUNT,
        limit: REPLAY_LIMIT_MAX });
      assert.deepEqual(sortIds(second.outboxIds), sortIds(['eops-target-wd-001',
        'eops-target-fw-001']), 'replay after lock release must drain the held rows');
      // Re-entrant: a repeated replay is a deterministic no-op.
      assert.deepEqual((await operations.replayDeadLetters({ recipientAccountId: TARGET_ACCOUNT,
        limit: REPLAY_LIMIT_MAX })).outboxIds, []);
      // Future-version fencing: the default replay leaves unknown-future rows;
      // the explicit allowUnknownFutureVersion replay drains exactly those.
      const allowed = await operations.replayDeadLetters({ recipientAccountId: TARGET_ACCOUNT,
        limit: REPLAY_LIMIT_MAX, allowUnknownFutureVersion: true });
      assert.deepEqual(sortIds(allowed.outboxIds), sortIds([...future]));
      assert.deepEqual((await operations.replayDeadLetters({ recipientAccountId: TARGET_ACCOUNT,
        limit: REPLAY_LIMIT_MAX })).outboxIds, [], 'the whole target backlog is drained');
      assert.equal((await pool.query<{ c: string }>(`select count(*)::text c from outbox_events
        where (handler_name=any($1::text[]) and state='dead_letter' and aggregate_scope=$2)
          or (handler_name=$3 and payload_json->>'actorProfileId'=$2 and state='dead_letter')`,
      [HANDLERS, TARGET_ACCOUNT, SOCIAL_FEED_WITHDRAWAL_HANDLER])).rows[0]?.c, '0',
      'no target candidate may remain dead_letter');

      // Cross-account isolation at scale: the withdrawal rows keep their scope
      // on the follow TARGET, so replaying the target side must never pull them,
      // and a scope-only account must pull exactly its own bound rows.
      assert.deepEqual((await operations.replayDeadLetters({ recipientAccountId: 'eops-other-50',
        limit: REPLAY_LIMIT_MAX })).outboxIds, [],
      'withdrawal rows bound to the payload actor must not leak to their scope owner');
      const other = await operations.replayDeadLetters({ recipientAccountId: 'eops-other-7',
        limit: REPLAY_LIMIT_MAX });
      assert.equal(other.outboxIds.length, 100,
        'a generic account must replay exactly its 100 scope-bound dead letters');
      assert.ok(other.outboxIds.every((id) => id.startsWith('eops-ob-')),
        'no target-account row may leak into another account replay');
    }, 120_000);

  async function counts(text: string): Promise<Record<string, number>> {
    const rows = await isolated.runtime.pool.query<Record<string, string>>(text);
    return Object.fromEntries(rows.rows.map((row) => {
      const labelKey = Object.keys(row).find((key) => key !== 'count');
      return [labelKey ? row[labelKey] : 'count', Number(row.count)];
    }));
  }
});

async function seedCapacityCorpus(isolated: IsolatedPostgresRuntime): Promise<void> {
  const pool = isolated.runtime.pool;
  // 2M ledger rows: one outbox id and one domain-event id per outbox row.
  await pool.query(`insert into resource_id_ledger(resource_id, resource_type, committed_at)
    select 'eops-ev-' || lpad(i::text, 9, '0'), 'domain-event', current_timestamp
      from generate_series(1, 1000000) i`);
  await pool.query(`insert into resource_id_ledger(resource_id, resource_type, committed_at)
    select 'eops-ob-' || lpad(i::text, 9, '0'), 'outbox', current_timestamp
      from generate_series(1, 1000000) i`);
  // 1M outbox rows: k = i%1000 drives the state mix, j = (i/1000)%100 drives
  // the handler mix so the state and handler distributions are orthogonal.
  // claim_outbox_dispatch_identity takes pg_advisory_xact_lock per INSERT row;
  // one 1M-row statement exhausts max_locks_per_transaction. Skip row triggers
  // and claim identities in one set-based write afterward.
  await executeWithoutPermanenceGuards(pool, `insert into outbox_events(outbox_id, domain_event_id, event_type, event_version,
      handler_name, handler_mode, aggregate_type, aggregate_id, aggregate_scope, aggregate_revision,
      commit_ordinal, occurred_at, payload_json, state, attempt_count, available_at, lease_generation,
      completed_at, dead_lettered_at, last_error)
    select
      'eops-ob-' || lpad(i::text, 9, '0'),
      'eops-ev-' || lpad(i::text, 9, '0'),
      case when j between 50 and 51 then 'social.follow-removed' else 'social.follow-created' end,
      1,
      case when j between 0 and 29 then 'social_follow_activity'
           when j between 30 and 49 then 'social_feed_item_notification'
           when j between 50 and 51 then 'social_feed_withdrawal'
           else 'social.publish-collection-change' end,
      'delivery_each_event',
      'profile',
      'eops-other-' || j,
      case when j between 50 and 51 then 'eops-other-' || (j * 2) else 'eops-other-' || j end,
      '1',
      i,
      '2026-01-01T00:00:00Z'::timestamptz + (i % 90 || ' days')::interval,
      '{}',
      case when k between 0 and 9 then 'dead_letter'
           when k = 10 then 'leased'
           when k between 11 and 99 then 'pending'
           else 'completed' end,
      case when k between 0 and 9 then 4 else 0 end,
      current_timestamp,
      case when k between 0 and 9 then 3 else 0 end,
      case when k >= 100 then '2026-03-01T00:00:00Z'::timestamptz + (i % 60 || ' days')::interval
           else null end,
      case when k between 0 and 9
           then '2026-07-01T00:00:00Z'::timestamptz + (i % 10000 || ' seconds')::interval
           else null end,
      case when k between 0 and 9 then 'dependency unavailable' else null end
    from generate_series(1, 1000000) i,
    lateral (select (i % 1000)::int k, ((i / 1000) % 100)::int j) parts`);
  await pool.query(`insert into outbox_dispatch_claims(domain_event_id, handler_name, outbox_id)
    select domain_event_id, handler_name, outbox_id from outbox_events`);
  // Target account corpus: 52 withdrawal dead letters (50 normal + 2
  // unknown-future) + 53 follow dead letters (50 normal + 3 unknown-future).
  await pool.query(`insert into resource_id_ledger(resource_id, resource_type, committed_at)
    select case when n <= 52 then 'eops-target-wd-' || lpad(n::text, 3, '0')
                else 'eops-target-fw-' || lpad((n - 52)::text, 3, '0') end,
           'outbox', current_timestamp from generate_series(1, 105) n
    union all select 'eops-target-ev-' || n, 'domain-event', current_timestamp
      from generate_series(1, 105) n`);
  await pool.query(`insert into outbox_events(outbox_id, domain_event_id, event_type, event_version,
      handler_name, handler_mode, aggregate_type, aggregate_id, aggregate_scope, aggregate_revision,
      commit_ordinal, occurred_at, payload_json, state, attempt_count, available_at, lease_generation,
      dead_lettered_at, last_error)
    select
      case when n <= 52 then 'eops-target-wd-' || lpad(n::text, 3, '0')
           else 'eops-target-fw-' || lpad((n - 52)::text, 3, '0') end,
      'eops-target-ev-' || n,
      case when n <= 52 then 'social.follow-removed' else 'social.follow-created' end,
      1,
      case when n <= 52 then 'social_feed_withdrawal' else 'social_follow_activity' end,
      'delivery_each_event',
      'profile',
      'eops-other-50',
      case when n <= 52 then 'eops-other-50' else 'eops-target' end,
      '1',
      n,
      '2026-06-01T00:00:00Z'::timestamptz + (n || ' minutes')::interval,
      case when n <= 52
           then jsonb_build_object('actorProfileId', 'eops-target', 'targetProfileId', 'eops-other-50')
           else '{}' end,
      'dead_letter',
      4,
      current_timestamp,
      3,
      '2026-06-02T00:00:00Z'::timestamptz + (n || ' minutes')::interval,
      case when n in (51, 52, 103, 104, 105) then 'unknown event version 99'
           else 'dependency unavailable' end
    from generate_series(1, 105) n`);
}

function targetOutboxIds(): string[] {
  const ids: string[] = [];
  for (let n = 1; n <= 52; n += 1) ids.push(`eops-target-wd-${String(n).padStart(3, '0')}`);
  for (let n = 1; n <= 53; n += 1) ids.push(`eops-target-fw-${String(n).padStart(3, '0')}`);
  return ids;
}

interface ReplayPlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Operation'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly 'Sort Method'?: string;
  readonly 'Sort Space Type'?: string;
  readonly 'Disk Usage'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly 'Shared Dirtied Blocks'?: number;
  readonly 'Shared Written Blocks'?: number;
  readonly 'Temp Written Blocks'?: number;
  readonly Plans?: readonly ReplayPlanNode[];
}

interface ReplayPlan {
  readonly Plan: ReplayPlanNode;
  readonly 'Planning Time': number;
  readonly 'Execution Time': number;
  readonly JIT?: unknown;
}

function flattenPlan(root: ReplayPlanNode): ReplayPlanNode[] {
  return [root, ...(root.Plans ?? []).flatMap(flattenPlan)];
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function summarizePlan(plan: ReplayPlan): string {
  const nodes = flattenPlan(plan.Plan);
  const shape = (node: ReplayPlanNode, depth: number): string[] => [
    `${'  '.repeat(depth)}${node['Node Type']}`
      + (node['Relation Name'] ? `(${node['Relation Name']})` : '')
      + (node['Index Name'] ? `[${node['Index Name']}]` : '')
      + ` rows=${node['Actual Rows'] ?? '?'}`,
    ...(node.Plans ?? []).flatMap((child) => shape(child, depth + 1)),
  ];
  return [
    ...shape(plan.Plan, 0),
    `planning=${plan['Planning Time']}ms execution=${plan['Execution Time']}ms`
      + (plan.JIT ? ' jit=on' : ' jit=off'),
    `sorts=${nodes.filter((n) => n['Node Type'] === 'Sort')
      .map((n) => `${n['Sort Method']}/${n['Sort Space Type']}`).join(',')}`,
  ].join('\n');
}
