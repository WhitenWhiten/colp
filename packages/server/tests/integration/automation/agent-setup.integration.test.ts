import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AgentSetupInput } from '@know-n/colp/automation';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('guided automation agent setup', () => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });

  function input(): AgentSetupInput {
    const definition = structuredClone(f.rule);
    definition.roles.push({ key: 'agent', kind: 'executor', required: true, description: 'Selected AI' });
    definition.tasks = [{ id: 'summary', type: 'summary.generate', after: [], executorRole: 'agent', required: true,
      outputContract: 'summary.sourced.v1', inputFields: ['url', 'title'], instruction: 'Summarize with sources.' }];
    return { definition, bindings: { name: 'Research', values: { [definition.intake!.folderRole]: { kind: 'folder',
      folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'academic' }, followIdentity: true,
      onUnavailable: 'block', notifyOn: ['delete', 'permission'] } } },
    agent: { name: 'ChatGPT', clientId: 'https://chatgpt.com/oauth/client.json' }, wakeMode: 'poll' };
  }

  test('one command creates an approval-required draft and replays without secrets or duplicate resources', async () => {
    f = await automationWorkerFixture('guided_create', 100, false, true);
    const body = input(), command = randomUUID();
    const created = await f.ownerPost('/agent-setup', body, undefined, command);
    expect(created.statusCode, created.body).toBe(201);
    const result = created.json();
    expect(result.rule).toMatchObject({ desiredState: 'draft', effectiveState: 'draft' });
    expect(result.rule.definition.route.targetIds).toEqual([result.target.id]);
    expect(result.binding.values.agent.kind).toBe('executor');
    expect(result.pairing.code).toBeTruthy();
    const replay = await f.ownerPost('/agent-setup', body, undefined, command);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual({ ...result, pairing: { ...result.pairing, code: null } });
    for (const table of ['automation_connection_profiles', 'automation_targets', 'automation_executors', 'automation_rules', 'automation_binding_sets', 'automation_execution_policies']) {
      expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(f.db)).rows[0]!.n, table).toBe(1);
    }
    const policy = (await sql<{ configuration_json: { allowAutomaticWrites: boolean; assignments: { maxCalls: number; allowedData: string[] }[] } }>`SELECT configuration_json FROM automation_execution_policy_revisions`.execute(f.db)).rows[0]!.configuration_json;
    expect(policy.allowAutomaticWrites).toBe(false);
    expect(policy.assignments[0]).toMatchObject({ maxCalls: 1, allowedData: ['url', 'title'] });
    // A second configuration reuses its agent; replacing a stale rule rolls back every new resource.
    const again = await f.ownerPost('/agent-setup', { ...body, ruleId: result.rule.id, ruleRevision: result.rule.revision });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().target.id).toBe(result.target.id);
    const stale = await f.ownerPost('/agent-setup', { ...body, ruleId: result.rule.id, ruleRevision: result.rule.revision });
    expect(stale.statusCode, stale.body).toBe(412);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM automation_rules`.execute(f.db)).rows[0]!.n).toBe(1);
  });

  test('invalid folder authority rolls the whole setup back', async () => {
    f = await automationWorkerFixture('guided_rollback', 100, false, true);
    const body = input();
    body.bindings.values[body.definition.intake!.folderRole] = { kind: 'folder', folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'missing' },
      followIdentity: true, onUnavailable: 'block', notifyOn: [] };
    const response = await f.ownerPost('/agent-setup', body);
    expect(response.statusCode, response.body).toBe(409);
    for (const table of ['automation_connection_profiles', 'automation_targets', 'automation_executors', 'automation_rules'])
      expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(f.db)).rows[0]!.n, table).toBe(0);
  });

  test('a paired AI can test exactly one current bookmark without moving it or enabling the rule', async () => {
    f = await automationWorkerFixture('guided_test', 100, false, true);
    await f.createNode('other-paper', 'root', 'Another paper', 'https://arxiv.org/abs/other');
    const setup = await f.ownerPost('/agent-setup', input());
    expect(setup.statusCode, setup.body).toBe(201);
    const result = setup.json(), token = await f.mint({ clientId: input().agent!.clientId });
    expect((await f.pair(result.pairing, randomUUID(), token)).statusCode).toBe(200);
    const preview = await f.ownerPost(`/rules/${result.rule.id}/run-once/preview`, {
      folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, includeDescendants: true,
      moveFolderedBookmarks: false, tasks: 'all', nodeId: 'paper', tasksOnly: true,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ canStart: true, matchedCount: 1, sample: [{ nodeId: 'paper' }] });
    const start = await f.ownerPost(`/rules/${result.rule.id}/run-once`, { previewId: preview.json().id, previewDigest: preview.json().previewDigest });
    expect(start.statusCode, start.body).toBe(201);
    expect(start.json().childRunIds).toHaveLength(1);
    const jobs = (await sql<{ state: string; task_json: { type: string } }>`SELECT state, task_json FROM automation_jobs`.execute(f.db)).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'ready', task_json: { type: 'summary.generate' } });
    const node = await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'paper').executeTakeFirstOrThrow();
    expect(node.parent_id).toBe('root');
    expect((await f.db.selectFrom('automation_rules').select('desired_state').executeTakeFirstOrThrow()).desired_state).toBe('draft');
    const foreign = await f.ownerPost(`/rules/${result.rule.id}/run-once/preview`, {
      folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'academic' }, includeDescendants: false,
      moveFolderedBookmarks: false, tasks: 'all', nodeId: 'paper', tasksOnly: true,
    });
    expect(foreign.statusCode).toBe(404);
  });
});
