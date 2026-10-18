import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { formatReport, runSyncResilienceConformance, SYNC_RESILIENCE_CHECKS, verifySyncResilienceCase } from '../src/index.mjs';

const report = JSON.parse(await readFile(new URL('../../../protocol/examples/sync-replica-health.json', import.meta.url)));
const response = JSON.parse(await readFile(new URL('../../../protocol/examples/sync-replica-health-result.json', import.meta.url)));
const authority = { leaseExpiresAt: '2026-10-18T00:00:00Z', lastSeenAt: '2026-10-17T00:00:00Z',
  cursor: 'cursor-1', checkpoint: 'r1', lifecycle: 'active' };
const warning = { code: 'record_invalid', message: 'This browser set this node aside.', path: '/nodes/middle' };
const fixtures = {
  'SYNC-0032': { results: [{ opId: 'x1', targetId: 'x', sequence: 1, status: 'conflicted' },
    { opId: 'y1', targetId: 'y', sequence: 2, status: 'applied' }],
  held: [{ opId: 'x2', targetId: 'x', status: 'set_aside' }], currentNativeTitle: 'Now',
  recaptured: [{ originalOpId: 'x2', opId: 'x3', targetId: 'x', sequence: 3, title: 'Now' }] },
  'SYNC-0033': { events: [{ nodeId: 'first', state: 'applied' }, { nodeId: 'middle', state: 'not_applied' },
    { nodeId: 'last', state: 'applied' }], issues: [{ nodeId: 'middle', eventId: 'event-2', code: 'record_invalid' }],
  cursor: 'cursor-3', ackedCursor: 'cursor-3', warnings: [warning] },
  'SYNC-0034': { failureCode: 'pull_effect_binding_invalid', cursorBefore: 'cursor-1', cursorAfter: 'cursor-1',
    nativeBefore: ['node-1'], nativeAfter: ['node-1'], setAside: [] },
  'SYNC-0035': { protected: ['held'], ancestors: ['parent'], independent: ['sibling'], survivors: ['held', 'parent'],
    excluded: ['held'], retainedIssues: ['held'], cursor: 'cursor-2', previousCursor: 'cursor-1' },
  'SYNC-0036': { report, response, olderResponse: { ...response, accepted: false }, authorityBefore: authority,
    authorityAfter: authority, foreignProofStatus: 401, ackWarnings: [warning], storedWarnings: [warning] },
  'SYNC-0037': { deliveries: [{ commandId: 'command-1', action: 'retry' }, { commandId: 'command-1', action: 'retry' }],
    executions: ['command-1'], resultReports: [report, report], refused: [{ outcome: 'failed', code: 'action_unavailable' }] },
};

test('the opt-in runner executes every resilience case and produces a separate report', async () => {
  const executed = [];
  const result = await runSyncResilienceConformance({ name: 'isolated fixtures', async runScenario(id) {
    executed.push(id); return fixtures[id];
  } });
  assert.deepEqual(executed, SYNC_RESILIENCE_CHECKS.map(check => check.id));
  assert.deepEqual(result.summary, { pass: 6, fail: 0, warn: 0, skip: 0 });
  assert.match(formatReport(result), /sync resilience/u);
});

const corruptions = {
  'SYNC-0032': o => { o.results = o.results.slice(0, 1); o.recaptured[0].opId = 'x2'; },
  'SYNC-0033': o => { o.ackedCursor = 'cursor-1'; o.warnings = []; },
  'SYNC-0034': o => { o.nativeAfter.push('partial-mutation'); o.cursorAfter = 'cursor-2'; },
  'SYNC-0035': o => { o.survivors = ['parent']; o.retainedIssues = []; },
  'SYNC-0036': o => { o.authorityAfter.cursor = 'changed'; o.foreignProofStatus = 200; },
  'SYNC-0037': o => { o.executions.push('command-1'); o.resultReports = []; },
};
for (const [id, corrupt] of Object.entries(corruptions)) {
  test(`${id} rejects a concrete regression and malformed observations`, () => {
    const o = structuredClone(fixtures[id]); corrupt(o);
    assert.ok(verifySyncResilienceCase(id, o).length > 0);
    for (const missing of [undefined, null, {}, true]) assert.ok(verifySyncResilienceCase(id, missing).length > 0);
  });
}

test('health cases catch UTF-8 overflow, wrong totals, duplicate IDs, unsafe titles and data-bearing commands', () => {
  for (const corrupt of [
    o => { o.report.issues.total = 0; },
    o => { o.report.issues.items.push({ ...o.report.issues.items[0], count: 2 }); },
    o => { o.report.issues.items[0].title = 'https://private.example'; },
    o => { o.report.issues.items = Array.from({ length: 50 }, (_, i) => ({ ...o.report.issues.items[0], issueId: `issue-${i}`, title: '中'.repeat(256) })); o.report.issues.total = 50; },
    o => { o.response.commands[0].payload = { url: 'https://private.example' }; },
  ]) {
    const o = structuredClone(fixtures['SYNC-0036']); corrupt(o);
    assert.ok(verifySyncResilienceCase('SYNC-0036', o).length > 0);
  }
});

test('unsupported cases skip and adapter failures fail without leaking error text', async () => {
  const result = await runSyncResilienceConformance({ async runScenario(id) {
    if (id === 'SYNC-0032') throw new Error('Bearer private-secret');
    return undefined;
  } });
  assert.deepEqual(result.summary, { pass: 0, fail: 1, warn: 0, skip: 5 });
  assert.doesNotMatch(JSON.stringify(result), /private-secret/u);
  await assert.rejects(() => runSyncResilienceConformance({ async runScenario() {} }, { cases: ['unknown'] }));
});

test('the CLI runs a local adapter and always closes it, with failure exit status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-sync-conformance-'));
  try {
    const modulePath = join(directory, 'adapter.mjs');
    const closedPath = join(directory, 'closed');
    await writeFile(modulePath, `import { writeFile } from 'node:fs/promises';\nexport async function runScenario() { return {}; }\nexport async function close() { await writeFile(${JSON.stringify(closedPath)}, 'closed'); }`);
    const result = await promisify(execFile)(process.execPath,
      [new URL('../bin/colp-sync-resilience.mjs', import.meta.url).pathname, '--json', modulePath]).catch(error => error);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).summary.fail, 6);
    assert.equal(await readFile(closedPath, 'utf8'), 'closed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('every adapter case has a versioned protocol anchor and a production fixture', async () => {
  const root = new URL('../../../', import.meta.url);
  const catalog = JSON.parse(await readFile(new URL('protocol/sync-resilience-cases.json', root), 'utf8'));
  assert.deepEqual(catalog.cases.map(row => row.id), SYNC_RESILIENCE_CHECKS.map(row => row.id));
  for (const row of catalog.cases) {
    const [file, anchor] = row.source.split('#');
    assert.ok((await readFile(new URL(`protocol/${file}`, root), 'utf8')).includes(`<a id="${anchor}"></a>`), row.id);
    assert.ok((await readFile(new URL(row.fixture, root), 'utf8')).includes(row.id), row.id);
  }
});
