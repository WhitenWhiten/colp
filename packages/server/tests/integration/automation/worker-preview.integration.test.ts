import { afterEach, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { createCollectionNode } from '../../../src/modules/collections/index.js';
import { revalidateRule } from '../../../src/modules/automation/index.js';

describeWithPostgres('worker preview and intake agreement', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  test('preserved placement enrichment waits for daily run admission and resumes with its pins', async () => {
    f = await automationPollingFixture('review_preserved_cap', { dailyLimit: 1 });
    const created = await f.canonical.execute(ports => createCollectionNode(ports, {
      actor: { principalId: f.owner.accountId, subjectId: f.owner.subjectId, principalType: 'account' },
      command: f.command(), collectionId: 'collection', parentId: 'root', intakeDisposition: 'userSelected',
      nodeId: 'selected-overflow', afterId: null, beforeId: null,
      node: { kind: 'bookmark', title: 'Selected paper', url: 'https://arxiv.org/selected', description: null, tags: [], visibility: 'inherit' },
    }));
    expect(created.kind).toBe('created'); await f.inspect();
    const run = (await sql<{ id: string; state: string; rule_revision_id: string; binding_revision: string }>`SELECT * FROM automation_runs
      WHERE explanation_json->>'nodeId'='selected-overflow'`.execute(f.db)).rows[0]!;
    expect(run.state).toBe('waiting');
    expect((await sql`SELECT state FROM automation_jobs WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([{ state: 'pending' }]);
    await sql`UPDATE automation_intake_reservations SET admission_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1`.execute(f.db);
    await sql`UPDATE automation_intake_delays SET available_at=clock_timestamp()-interval '1 second'`.execute(f.db);
    await f.inspect();
    expect((await sql`SELECT state FROM automation_jobs WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([{ state: 'ready' }]);
    expect((await sql`SELECT rule_revision_id,binding_revision FROM automation_runs WHERE id=${run.id}`.execute(f.db)).rows[0])
      .toEqual({ rule_revision_id: run.rule_revision_id, binding_revision: run.binding_revision });
    expect((await sql`SELECT run_id FROM automation_intake_reservations WHERE run_id=${run.id}`.execute(f.db)).rows).toHaveLength(1);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'selected-overflow').executeTakeFirstOrThrow()).parent_id).toBe('root');
  });
  test('missing execution policy is visible in rule health and the Owner rule read', async () => {
    f = await automationPollingFixture('review_worker_health', { policyEnabled: false });
    expect(f.rule.effectiveState).toBe('degraded');
    const health = await f.uow.execute(f.owner, ports => revalidateRule(ports, f.owner, f.rule.id));
    expect(health.effectiveState).toBe('degraded'); // Deterministic intake remains available.
    expect(health.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'executorUnavailable', blockingStages: ['summary'] })]));
    const response = await f.app.inject({ url: `/api/v1/me/automations/rules/${f.rule.id}`, headers: { cookie: f.owner.cookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().effectiveState).toBe('degraded');
  });
  test('conflicting placement previews and admissions both retain review without worker calls', async () => {
    f = await automationPollingFixture('review_conflict_tasks');
    const original = (await f.app.inject({ url: '/api/v1/me/automations/binding-sets/'+f.ruleInput.bindingSetId, headers: { cookie: f.owner.cookie } })).json();
    const binding = await f.ownerPost('/binding-sets', { name: 'Competing destination', values: {
      ...original.values, academicRoot: { ...original.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } },
    } });
    expect(binding.statusCode, binding.body).toBe(201);
    const competingInput = { ...f.ruleInput, bindingSetId: binding.json().id };
    const rule = await f.ownerPost('/rules', competingInput);
    expect(rule.statusCode, rule.body).toBe(201);
    const activation = await f.ownerPost('/rules/preview', { rule: competingInput, mode: 'currentState' });
    expect(activation.statusCode, activation.body).toBe(200);
    const enabled = await f.ownerPost(`/rules/${rule.json().id}/lifecycle`, { state: 'enabled', pendingRuns: 'continuePinned', reason: 'Activate competing rule', activationPreviewId: activation.json().previewId }, String(rule.headers.etag));
    expect(enabled.statusCode, enabled.body).toBe(200);
    const event = JSON.parse(readFileSync('../../docs/automation/design/examples/event-facts.json', 'utf8'));
    event.collectionId = 'collection'; event.intakeDisposition = 'userDefault';
    const preview = await f.ownerPost('/rules/preview', { rule: f.ruleInput, mode: 'supplied', events: [event] });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ plannedRunCount: 0, decisions: [{ outcome: 'conflict', pendingTasks: [] }] });
    await f.createNode('conflicted-paper', 'root', 'Conflicting paper', 'https://arxiv.org/conflict'); await f.inspect();
    const runs = (await sql<{ id: string; state: string }>`SELECT id,state FROM automation_runs WHERE explanation_json->>'nodeId'='conflicted-paper'`.execute(f.db)).rows;
    expect(runs).toHaveLength(2);
    expect(runs.every(run => run.state === 'review')).toBe(true);
    for (const run of runs) {
      expect((await sql`SELECT id FROM automation_jobs WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([]);
      expect((await sql`SELECT run_id FROM automation_intake_reservations WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([]);
    }
  });
  test('preview counts the enrichment run for explicitly selected placement', async () => {
    f = await automationPollingFixture('review_preview');
    expect(f.rule.effectiveState).toBe('active');
    const event = JSON.parse(readFileSync('../../docs/automation/design/examples/event-facts.json', 'utf8'));
    Object.assign(event, { collectionId: 'collection', nodeId: 'selected-paper', intakeDisposition: 'userSelected' });
    Object.assign(event.bookmark, { nodeId: 'selected-paper', parent: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, ancestors: [{ serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }] });
    const preview = await f.ownerPost('/rules/preview', { rule: f.ruleInput, mode: 'supplied', events: [event] });
    expect(preview.statusCode, preview.body).toBe(200);
    const created = await f.canonical.execute(ports => createCollectionNode(ports, { actor: { principalId: f.owner.accountId, subjectId: f.owner.subjectId, principalType: 'account' }, command: f.command(), collectionId: 'collection',
      parentId: 'root', intakeDisposition: 'userSelected', nodeId: 'selected-paper', afterId: null, beforeId: null,
      node: { kind: 'bookmark', title: event.bookmark.title, url: 'https://arxiv.org/abs/example-placeholder', description: null, tags: [], visibility: 'inherit' } }));
    expect(created.kind).toBe('created'); await f.inspect();
    const actual = (await sql`SELECT r.id FROM automation_runs r JOIN automation_jobs j ON j.run_id=r.id WHERE r.explanation_json->>'nodeId'='selected-paper' AND j.state='ready'`.execute(f.db)).rows;
    expect(actual).toHaveLength(1);
    expect(preview.json().plannedRunCount).toBe(actual.length);
    expect(preview.json().decisions[0].pendingTasks).toEqual(['summary.generate']);
  });
});
