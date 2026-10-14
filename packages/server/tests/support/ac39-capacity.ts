/** Opt-in capacity evidence, never part of the routine integration suite.
 * Uses production transactions with isolated fixture identities; not an HTTP SLA test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { sql, PostgresQueryCompiler, type KyselyPlugin } from 'kysely';
import { Pool } from 'pg';
import { compilePredicate, type Predicate } from '@know-n/colp/automation';
import { readRepositoryFile } from './repository-files.js';
import { automationRuntimeFixture } from './automation-runtime-fixture.js';
import { automationPollingFixture } from './automation-polling-fixture.js';
import { createAutomationUnitOfWork, setAutomationCaptureEnabled } from '../../src/infrastructure/automation/index.js';
import { createOwnedCollectionCanonical, createCollectionNode } from '../../src/modules/collections/index.js';
import { createRule, previewRule } from '../../src/modules/automation/index.js';

process.env.COLP_MULTI_USER = 'true';
const output = process.env.AC39_OUTPUT;
const rounds = Number(process.env.AC39_ROUNDS ?? 3);
const burstCount = Number(process.env.AC39_SAVE_COUNT ?? 20);
const ruleSizes = (process.env.AC39_RULE_SIZES ?? '1,50,200,500').split(',').map(Number);
const stage = process.env.AC39_STAGE ?? 'manual';
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, 'AC39_ROUNDS must be 1..10');
assert.ok(Number.isInteger(burstCount) && burstCount >= 1 && burstCount <= 100, 'AC39_SAVE_COUNT must be 1..100');
assert.ok(ruleSizes.every((n, i) => Number.isInteger(n) && n >= 1 && n <= 500 && (!i || n > ruleSizes[i - 1]!)), 'AC39_RULE_SIZES must increase in 1..500');
const failures: string[] = [];
function record(value: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), stage, ...value });
  console.log(line);
  if (output) appendFileSync(output, line + '\n');
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { n: values.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) };
}
function gate(name: string, pass: boolean) { if (!pass) failures.push(name); }
async function traffic(save: (id: string) => Promise<unknown>, count = 20) {
  const pending: Promise<void>[] = [], times: number[] = [], errors: string[] = [];
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const due = started + i * 200;
    await delay(Math.max(0, due - performance.now()));
    pending.push(save(randomUUID()).then(() => { times.push(performance.now() - due); }, error => {
      errors.push(String(error)); times.push(performance.now() - due);
    }));
  }
  await Promise.all(pending);
  return { latencyMs: summary(times), errors };
}
type Fixture = Awaited<ReturnType<typeof automationRuntimeFixture>>;
async function secondary(f: Fixture, foreign: boolean) {
  const owner = foreign ? await f.issue('control') : f.owner;
  const actor = { principalId: owner.accountId, subjectId: owner.subjectId, principalType: 'account' as const };
  const collectionId = randomUUID(), rootNodeId = randomUUID();
  await f.canonical.execute(ports => createOwnedCollectionCanonical(ports, { actor, command: f.command(), title: 'Control', summary: null,
    kind: 'bookmarks', collectionId, rootNodeId, operationId: randomUUID() }));
  return (id: string) => f.canonical.execute(ports => createCollectionNode(ports, { actor, command: f.command(), collectionId,
    parentId: rootNodeId, nodeId: id, afterId: null, beforeId: null, intakeDisposition: 'userDefault',
    node: { kind: 'bookmark', title: 'Control save', url: 'https://example.org/control', description: null, tags: [], visibility: 'inherit' } }));
}
async function seedMembers(f: Fixture, count: number) {
  if (process.env.AC39_CANONICAL_SEED === '1') {
    for (let i = 1; i < count; i++) await f.createNode(`capacity-${i}`, 'root', `Capacity ${i}`, `https://arxiv.org/capacity/${i}`);
    return;
  }
  // Same canonical-shaped bulk fixture as AW-41. No ingestion evidence is claimed for seed rows.
  await sql`INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT 'capacity-'||g::text,'node' FROM generate_series(1,${count - 1}) g`.execute(f.db);
  const columns = (await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='nodes' AND is_generated='NEVER' ORDER BY ordinal_position`.execute(f.db)).rows.map(r => r.column_name);
  await sql`INSERT INTO nodes (${sql.join(columns.map(c => sql.id(c)))}) SELECT ${sql.join(columns.map(c => c === 'id' ? sql`'capacity-'||g::text`
    : c === 'position_token' ? sql`'z'||lpad(g::text,8,'0')`
    : c === 'payload_json' ? sql`n.payload_json || jsonb_build_object('id','capacity-'||g::text,'position','z'||lpad(g::text,8,'0'))`
    : sql.ref('n.' + c)))}
    FROM nodes n CROSS JOIN generate_series(1,${count - 1}) g WHERE n.id='paper'`.execute(f.db);
}
async function manual(count: number, round: number) {
  const f = await automationRuntimeFixture('ac39_manual', true);
  const observer = new Pool({ connectionString: f.isolated.databaseUrl, max: 1 });
  try {
    await seedMembers(f, count);
    const sameOwnerSave = await secondary(f, false), foreignSave = await secondary(f, true);
    setAutomationCaptureEnabled(false);
    const disabledBaseline = await traffic(sameOwnerSave);
    setAutomationCaptureEnabled(true);
    const baseline = await traffic(sameOwnerSave);
    let queries = 0;
    const profileSql = process.env.AC39_PROFILE_SQL === '1';
    const timings: { sql: string; ms: number }[] = [];
    const pending = new Map<object, { sql: string; start: number }>();
    const compiler = new PostgresQueryCompiler();
    const plugin: KyselyPlugin = {
      transformQuery: ({ node, queryId }) => {
        queries++;
        if (profileSql) pending.set(queryId, { sql: compiler.compileQuery(node, queryId).sql, start: performance.now() });
        return node;
      },
      transformResult: async ({ result, queryId }) => {
        const timing = pending.get(queryId);
        if (timing) { timings.push({ sql: timing.sql, ms: performance.now() - timing.start }); pending.delete(queryId); }
        return result;
      },
    };
    const uow = createAutomationUnitOfWork(f.db.withPlugin(plugin), 'server', { runtimeEnabled: true });
    const begin = performance.now();
    const preview = await uow.execute(f.owner, ports => ports.runOnce!.preview(f.rule.id, {
      folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none',
    }));
    const previewMs = performance.now() - begin, previewQueries = queries;
    assert.equal(preview.matchedCount, Math.min(count, 1000));
    if (count > 1000) {
      assert.equal(preview.canStart, false);
      await assert.rejects(uow.execute(f.owner, ports => ports.runOnce!.start(f.rule.id, { previewId: preview.id, previewDigest: preview.previewDigest })));
      const effects = (await sql<{ n: number }>`SELECT count(*)::int n FROM automation_effect_receipts`.execute(f.db)).rows[0]!.n;
      assert.equal(effects, 0);
      record({ count, round, previewMs, previewQueries, overLimitRejected: true }); return;
    }
    assert.equal(preview.canStart, true);
    queries = 0; timings.length = 0;
    const start = performance.now();
    let finished = false, firstGate: number | undefined, lastGate: number | undefined, maxWaiters = 0;
    const run = uow.execute(f.owner, ports => ports.runOnce!.start(f.rule.id, { previewId: preview.id, previewDigest: preview.previewDigest }))
      .finally(() => { finished = true; });
    // Observe the real gate before starting writers, avoiding a stale-preview race.
    while (!finished && firstGate === undefined) {
      const locks = await observer.query("SELECT granted FROM pg_locks WHERE locktype='advisory' AND classid=1263675657 AND objid=hashtext('collection')::oid");
      if (locks.rows.some(r => r.granted)) firstGate = performance.now();
      else await delay(5);
    }
    const monitor = (async () => {
      while (!finished) {
        const locks = await observer.query("SELECT granted FROM pg_locks WHERE locktype='advisory' AND classid=1263675657 AND objid=hashtext('collection')::oid");
        if (locks.rows.some(r => r.granted)) lastGate = performance.now();
        maxWaiters = Math.max(maxWaiters, locks.rows.filter(r => !r.granted).length);
        await delay(25);
      }
    })();
    const writes = Promise.all([
      traffic(id => f.createNode(id, 'root', 'Concurrent save', 'https://example.org/save'), burstCount),
      traffic(sameOwnerSave, burstCount), traffic(foreignSave, burstCount),
    ]);
    // Always settle writers before dropping their schema, including a failed run.
    const result = await run.catch(async error => { await writes; await monitor; throw error; });
    const runMs = performance.now() - start, runQueries = queries;
    if (profileSql) record({ kind: 'sqlProfile', count, round, runMs, monotonicUs: Number(process.hrtime.bigint() / 1000n),
      sqlMs: timings.reduce((sum, row) => sum + row.ms, 0),
      slowest: timings.toSorted((a, b) => b.ms - a.ms).slice(0, 20).map(row => ({ ...row, sql: row.sql.slice(0, 800) })) });
    const [sameCollection, sameOwner, foreignOwner] = await writes;
    await monitor;
    assert.equal(result.childRunIds?.length, count);
    const placed = (await sql<{ n: number }>`SELECT count(*)::int n FROM nodes WHERE parent_id='academic' AND kind='bookmark'`.execute(f.db)).rows[0]!.n;
    assert.equal(placed, count);
    for (const [name, value] of Object.entries({ sameCollection, sameOwner, foreignOwner })) {
      gate(`manual/${count}/${round}/${name}`, !value.errors.length && value.latencyMs.p95 <= 1000 && value.latencyMs.max <= 2000);
    }
    gate(`manual/${count}/${round}/run`, runMs <= 10000);
    record({ count, round, disabledBaseline, baseline, previewMs, previewQueries, runMs, runQueries, placed,
      gateObservedMsLowerBound: firstGate !== undefined && lastGate !== undefined ? lastGate - firstGate : null,
      maxGateWaiters: maxWaiters, sameCollection, sameOwner, foreignOwner, rssBytes: process.memoryUsage().rss });
    if (runMs > 30000) throw new Error('Safety stop: run-once exceeds 30 seconds');
    if ([sameCollection, sameOwner, foreignOwner].some(value => value.errors.length))
      throw new Error('Safety stop: saving failed; do not increase load');
  } finally { await observer.end(); await f.isolated.close(); }
}
async function rules() {
  const f = await automationRuntimeFixture('ac39_rules', true);
  try {
    let queries = 0;
    const plugin: KyselyPlugin = { transformQuery: ({ node }) => { queries++; return node; }, transformResult: async ({ result }) => result };
    const uow = createAutomationUnitOfWork(f.db.withPlugin(plugin), 'server', { runtimeEnabled: true });
    let existing = 1;
    for (const count of ruleSizes) {
      // Seed via production create; enable fixture state directly to avoid measuring N activation previews.
      for (; existing < count; existing++) await f.uow.execute(f.owner, async ports => {
        const created = await createRule(ports, f.owner, { definition: { ...f.rule.definition, name: `Capacity ${existing}` }, bindingSetId: f.binding.id });
        const stored = (await ports.rules.load(f.owner.accountId, created.id))!;
        const collection = (await ports.reads.readCollection(f.owner, 'collection'))!;
        await ports.activation(stored, { kind: 'enable', collectionId: 'collection', afterOrdinal: collection.commitOrdinal });
        await ports.rules.setState(f.owner.accountId, { ...stored, view: { ...stored.view, desiredState: 'enabled', revision: '2' } });
      });
      const active = (await sql<{ n: number }>`SELECT count(*)::int n FROM automation_activations WHERE disabled_after_ordinal IS NULL`.execute(f.db)).rows[0]!.n;
      assert.equal(active, count);
      for (let round = 1; round <= rounds; round++) {
        queries = 0;
        const start = performance.now();
        await uow.execute(f.owner, ports => previewRule(ports, f.owner, { rule: { definition: f.rule.definition, bindingSetId: f.binding.id }, mode: 'currentState' }));
        const previewMs = performance.now() - start, previewQueries = queries;
        await f.createNode(randomUUID(), 'root', 'Rule load', 'https://arxiv.org/load');
        const admissionStart = performance.now(); await f.inspect();
        const admissionMs = performance.now() - admissionStart;
        record({ count, round, previewMs, previewQueries, admissionMs, rssBytes: process.memoryUsage().rss });
        gate(`rules/${count}/${round}`, previewMs <= 10000 && admissionMs <= 10000);
        if (previewMs > 30000 || admissionMs > 30000) throw new Error('Safety stop: rule workload exceeds 30 seconds');
      }
    }
  } finally { await f.isolated.close(); }
}
async function queue() {
  const f = await automationPollingFixture('ac39_queue', { dailyLimit: 1000 });
  try {
    const before = await traffic(id => f.createNode(id, 'root', 'Queued', 'https://arxiv.org/queued'), 50);
    const intakeStart = performance.now(); await f.inspect();
    const admissionMs = performance.now() - intakeStart;
    const queued = (await sql<{ n: number }>`SELECT count(*)::int n FROM automation_jobs WHERE state='ready'`.execute(f.db)).rows[0]!.n;
    assert.equal(queued, 51);
    const recoveryStart = performance.now(); let completed = 0;
    while (true) {
      const job = (await f.work!.list(f.actor, { targetId: f.target.id, limit: '1' })).items[0];
      if (!job) break;
      const inputs = await f.work!.inputs(f.actor, job.id, { deliveryHandle: job.deliveryHandle! });
      const lease = await f.work!.mutate(f.actor, job.id, 'claim', { deliveryHandle: job.deliveryHandle }, randomUUID()) as { claimToken: string; generation: number; inputDigest: string };
      await delay(100);
      const body = { ...lease, outputContract: job.task.outputContract, output: { kind: 'text', textType: 'summary', text: 'AC-39 deterministic summary', language: 'en',
        evidence: [{ kind: 'source', reference: inputs.items[0]!.sourceEventId, observedAt: new Date().toISOString() }] } };
      const payload = { claimToken: body.claimToken, generation: body.generation, inputDigest: body.inputDigest, outputContract: body.outputContract, output: body.output };
      await f.work!.mutate(f.actor, job.id, 'submit', payload, randomUUID()); completed++;
      if (performance.now() - recoveryStart > 120000) throw new Error('Safety stop: queue recovery exceeds 120 seconds');
    }
    const states = (await sql`SELECT state,count(*)::int n FROM automation_jobs GROUP BY state`.execute(f.db)).rows;
    assert.equal(completed, queued);
    assert.deepEqual(states, [{ state: 'succeeded', n: queued }]);
    const duplicateEffects = (await sql`SELECT job_id FROM automation_effect_receipts WHERE job_id IS NOT NULL GROUP BY job_id HAVING count(*)>1`.execute(f.db)).rows;
    assert.equal(duplicateEffects.length, 0);
    record({ queued, completed, admissionMs, recoveryMs: performance.now() - recoveryStart, saving: before, states });
    gate('queue/saving', !before.errors.length && before.latencyMs.p95 <= 1000 && before.latencyMs.max <= 2000);
  } finally { await f.close(); }
}
function evaluator() {
  const facts = JSON.parse(readRepositoryFile('packages/node/tests/fixtures/automation/event-facts.json'));
  const leaf: Predicate = { kind: 'field', field: 'bookmark.kind', op: 'eq', value: 'bookmark' };
  let deep: Predicate = leaf;
  for (let level = 0; level < 14; level++) deep = { kind: 'all', items: [deep] };
  const wide: Predicate[] = Array.from({ length: 4 }, () => ({ kind: 'all', items: Array.from({ length: 27 }, () => leaf) }));
  const boundary: Predicate = { kind: 'all', items: [...wide, deep] };
  assert.equal(compilePredicate({ kind: 'all', items: [boundary] }).valid, false);
  assert.equal(compilePredicate({ kind: 'all', items: [...wide, deep, leaf] }).valid, false);
  for (const [shape, predicate] of Object.entries({ shallow: leaf, depth16nodes128: boundary })) {
    for (let round = 1; round <= rounds; round++) {
      const compileStart = performance.now();
      const compiled = Array.from({ length: 500 }, () => compilePredicate(predicate));
      const compileMs = performance.now() - compileStart;
      const start = performance.now(), batches: number[] = []; let matched = 0, budgetErrors = 0;
      for (let member = 0; member < 1000; member++) {
        const batchStart = performance.now();
        for (const rule of compiled) {
          assert.equal(rule.valid, true);
          if (!rule.valid) throw new Error('Unexpected invalid evaluator fixture');
          const decision = rule.evaluate(facts);
          if (decision.outcome === 'matched') matched++;
          else if (decision.outcome === 'error' && decision.code === 'evaluationBudgetExceeded') budgetErrors++;
          else throw new Error('Unexpected evaluator decision');
        }
        batches.push(performance.now() - batchStart);
      }
      record({ shape, round, compileMs, elapsedMs: performance.now() - start, evaluations: 500000, matched, budgetErrors, batch500Ms: summary(batches) });
      gate(`evaluator/${shape}/${round}`, matched === 500000);
    }
  }
}
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
record({ kind: 'start', node: process.version, thresholds: { saveP95Ms: 1000, saveMaxMs: 2000, runOnceMs: 10000 },
  rounds, burstCount, ruleSizes, canonicalSeed: process.env.AC39_CANONICAL_SEED === '1' });
try {
  if (stage === 'manual') for (const count of (process.env.AC39_SIZES ?? '100,500,1000,1001').split(',').map(Number)) {
    assert.ok(Number.isInteger(count) && count >= 1 && count <= 1001, 'AC39_SIZES must contain integers in 1..1001');
    for (let round = 1; round <= (count > 1000 ? 1 : rounds); round++) await manual(count, round);
  }
  else if (stage === 'rules') await rules();
  else if (stage === 'queue') await queue();
  else if (stage === 'evaluator') evaluator();
  else throw new Error('Unknown AC39_STAGE');
} catch (error) { failures.push(String(error)); record({ kind: 'error', error: String(error), stack: error instanceof Error ? error.stack : undefined }); }
finally {
  eventLoop.disable();
  record({ kind: 'result', failures, eventLoopP99Ms: eventLoop.count ? eventLoop.percentile(99) / 1e6 : null, maxRssKiB: process.resourceUsage().maxRSS });
  process.exitCode = failures.length ? 1 : 0;
}
