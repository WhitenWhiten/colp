import { describe, expect, it, vi } from 'vitest';
import type { AutomationStateArea } from '../src/automation/bundle-store.js';
import { SERVER_STATUS_KEY, createServerStatusStore, readServerStatus, serverStatusDue } from '../src/automation/server-status.js';
import { DAY, NOW, serverRule, serverRun } from './automation-fixture.js';

/** The server's own status, read with the web sign-in and kept with its age (AW-54). */
function memoryArea(): AutomationStateArea & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, async get(key) { return structuredClone(values.get(key)); }, async set(key, value) { values.set(key, structuredClone(value)); } };
}
const OWNER = '["https://colp.example","owner-1"]';
const usage = { periodStart: new Date(NOW - 7 * DAY).toISOString(), periodEnd: new Date(NOW).toISOString(), admittedRuns: 12, readyJobs: 7,
  succeededJobs: 4, heldJobs: 1, externalCosts: 'unknownDisclosed' as const, costDisplay: 'Billed by your agent', awaitingApprovalJobs: 2 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Known-Automation-Account-Id': 'owner-1' } });

function server(answers: Record<string, Response | Error>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname, answer = answers[path];
    if (!answer) throw new Error(`unexpected ${path}`);
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
}

describe('reading the server’s automation status', () => {
  it('verifies the owner of each response, including a cookie switch between rules and runs', async () => {
    for (const header of [null, 'other-owner']) {
      const headers = new Headers();
      if (header) headers.set('Known-Automation-Account-Id', header);
      const fetcher = server({ '/api/v1/me/automations/rules': json({ items: [], nextCursor: null }),
        '/api/v1/me/automations/runs': new Response(JSON.stringify({ items: [serverRun()], nextCursor: null }), { headers }) });
      expect(await readServerStatus('https://colp.example', 'owner-1', fetcher)).toEqual({ ok: false, problem: 'signedOut' });
    }
  });
  it('reads rules and the newest runs with the web sign-in, never the Sync bearer', async () => {
    const fetcher = server({ '/api/v1/me/automations/rules': json({ items: [serverRule({ usage })], nextCursor: null }),
      '/api/v1/me/automations/runs': json({ items: [serverRun({ status: 'waiting' })], nextCursor: null }) });
    const read = await readServerStatus('https://colp.example/', 'owner-1', fetcher);
    expect(read).toMatchObject({ ok: true, rules: [{ id: 'rule-arxiv' }], runs: [{ id: 'run-1', status: 'waiting' }] });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://colp.example/api/v1/me/automations/rules?limit=100',
      'https://colp.example/api/v1/me/automations/runs?limit=20']);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store' });
      expect(Object.keys(init!.headers as Record<string, string>)).toEqual(['Accept']);
    }
  });

  it('names each failure, and refuses an answer outside the contract', async () => {
    const page = json({ items: [], nextCursor: null });
    const cases: [Record<string, Response | Error>, string][] = [
      [{ '/api/v1/me/automations/rules': new TypeError('network') }, 'offline'],
      [{ '/api/v1/me/automations/rules': json({}, 401) }, 'signedOut'],
      [{ '/api/v1/me/automations/rules': json({}, 404) }, 'unavailable'],
      [{ '/api/v1/me/automations/rules': json({}, 429) }, 'rateLimited'],
      [{ '/api/v1/me/automations/rules': json({}, 500) }, 'server'],
      [{ '/api/v1/me/automations/rules': page, '/api/v1/me/automations/runs': json({ items: [{ ...serverRun(), status: 'done' }], nextCursor: null }) }, 'invalid'],
      [{ '/api/v1/me/automations/rules': page, '/api/v1/me/automations/runs': new Response('not json', { status: 200, headers: { 'Known-Automation-Account-Id': 'owner-1' } }) }, 'invalid'],
    ];
    for (const [answers, problem] of cases) expect(await readServerStatus('https://colp.example', 'owner-1', server(answers))).toEqual({ ok: false, problem });
  });
});

describe('the kept copy', () => {
  it('discards unverified legacy status and clears private results after a denial', async () => {
    const area = memoryArea(), store = createServerStatusStore(area, OWNER);
    const record = await store.apply({ ok: true, rules: [], runs: [serverRun()] }, NOW);
    await area.set(SERVER_STATUS_KEY, { ...record, version: 1 });
    expect(await store.read()).toMatchObject({ fetchedAt: null, runs: [] });
    await store.apply({ ok: true, rules: [], runs: [serverRun()] }, NOW);
    expect(await store.apply({ ok: false, problem: 'signedOut' }, NOW + 1)).toMatchObject({ fetchedAt: null, runs: [], rules: [] });
  });
  it('keeps only what the pages show, with the time it was read', async () => {
    const area = memoryArea(), store = createServerStatusStore(area, OWNER);
    const record = await store.apply({ ok: true, rules: [serverRule({ usage })],
      runs: [serverRun({ status: 'waiting', held: true, explanation: 'Explicit hold: awaiting an Owner decision to continue the original pinned work.' })] }, NOW);
    expect(record).toEqual({ version: 2, ownerKey: OWNER, fetchedAt: NOW, lastAttemptAt: NOW, failures: 0, problem: null,
      rules: [{ id: 'rule-arxiv', name: 'Place research papers in Academic', state: 'active', intake: true,
        usage: { since: NOW - 7 * DAY, runs: 12, waiting: 7, held: 1, approvals: 2, cost: 'Billed by your agent' } }],
      runs: [{ id: 'run-1', ruleId: 'rule-arxiv', kind: 'intake', status: 'waiting', held: true, unread: false, outputCount: 0,
        explanation: 'Explicit hold: awaiting an Owner decision to continue the original pinned work.', createdAt: NOW, updatedAt: NOW }] });
    // No member ids, job ids or effects are kept.
    expect(JSON.stringify(area.values.get(SERVER_STATUS_KEY))).not.toMatch(/event-1|memberEventIds|jobIds|effects/u);
  });

  it('keeps the last good copy when a read fails, and says why', async () => {
    const store = createServerStatusStore(memoryArea(), OWNER);
    await store.apply({ ok: true, rules: [], runs: [serverRun()] }, NOW);
    const failed = await store.apply({ ok: false, problem: 'offline' }, NOW + 60_000);
    expect(failed).toMatchObject({ fetchedAt: NOW, runs: [{ id: 'run-1' }], failures: 1, problem: { kind: 'offline', at: NOW + 60_000 } });
    expect(await store.apply({ ok: true, rules: [], runs: [] }, NOW + 120_000)).toMatchObject({ fetchedAt: NOW + 120_000, runs: [], failures: 0, problem: null });
  });

  it('never shows one account another account’s status', async () => {
    const area = memoryArea();
    await createServerStatusStore(area, OWNER).apply({ ok: true, rules: [], runs: [serverRun()] }, NOW);
    expect(await createServerStatusStore(area, '["https://colp.example","owner-2"]').read()).toMatchObject({ fetchedAt: null, runs: [] });
  });

  it('reads at most once a minute, backing off to 15 minutes while the server fails', async () => {
    const store = createServerStatusStore(memoryArea(), OWNER);
    expect(serverStatusDue(await store.read(), NOW)).toBe(true);
    let record = await store.apply({ ok: true, rules: [], runs: [] }, NOW);
    expect([serverStatusDue(record, NOW + 59_999), serverStatusDue(record, NOW + 60_000)]).toEqual([false, true]);
    for (let failure = 0; failure < 6; failure += 1) record = await store.apply({ ok: false, problem: 'server' }, NOW);
    expect([serverStatusDue(record, NOW + 899_999), serverStatusDue(record, NOW + 900_000)]).toEqual([false, true]);
  });
});
