import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerTransport, createFileJournal, runPollingCycle, WorkerHttpError } from './claim-and-summarize.mjs';
import * as adapter from './deterministic-summary.mjs';

const job = { id: 'j', status: 'ready', deliveryHandle: 'h', allowedFolders: [], task: { type: 'summary.generate', outputContract: 'summary.sourced.v1' } };
const lease = { claimToken: 'secret', generation: 1, inputDigest: 'a'.repeat(64) };
const input = { sourceEventId: 'source', availability: 'available', node: { serverUuid: 's', collectionId: 'c', nodeId: 'n' } };
function fixture() {
  let pending = null;
  const journal = { load: async () => pending, save: async value => { pending = structuredClone(value); }, clear: async () => { pending = null; } };
  const calls = [];
  const request = async (method, path, body, command) => {
    calls.push({ method, path, body, command });
    if (path.startsWith('/jobs?')) return { items: [job], nextCursor: null };
    if (path.includes('/inputs?')) return { items: [input], nextCursor: null };
    if (path.endsWith('/claim') || path.endsWith('/heartbeat')) return lease;
    if (path.endsWith('/results')) return { jobId: 'j', status: 'succeeded' };
    return { resourceId: 'j', status: 'completed' };
  };
  return { journal, calls, request, options: { request, journal, adapter, targetId: 'target' } };
}

test('pair, target-bound queue/input pagination, heartbeat, typed output; adapter sees no credential', async () => {
  const f = fixture();
  const request = async (...args) => {
    const value = await f.request(...args), path = args[1];
    if (path.startsWith('/jobs?')) return { items: [path.includes('cursor=next') ? { ...job, id: 'unsupported', task: { type: 'tags.generate' } } : job], nextCursor: path.includes('cursor=next') ? null : 'next' };
    if (path.includes('/inputs?')) return { items: [input], nextCursor: path.includes('cursor=more') ? null : 'more' };
    return value;
  };
  const results = await runPollingCycle({ ...f.options, request, heartbeatMs: 5, pairing: { pairingId: 'p', code: 'code', commandId: 'stable' }, adapter: {
    supports: adapter.supports,
    async generate(args) {
      assert.deepEqual(Object.keys(args).sort(), ['allowedFolders', 'inputs', 'signal', 'task']);
      assert.equal(args.inputs.length, 2); await delay(20); return adapter.generate(args);
    },
  } });
  assert.equal(results[0].status, 'succeeded');
  assert.equal(f.calls[0].path, '/pairings/claim');
  assert(f.calls.some(call => call.path.endsWith('/heartbeat')));
  assert.equal(f.calls.filter(call => call.path.endsWith('/claim')).length, 2); // pairing and one supported job
  assert(f.calls.filter(call => call.path.startsWith('/jobs?')).every(call => call.path.includes('targetId=target')));
  const submitted = f.calls.find(call => call.path.endsWith('/results'));
  assert.equal(submitted.body.inputDigest, lease.inputDigest);
  assert.equal(submitted.body.output.evidence[0].reference, 'source');
  assert.equal(await f.journal.load(), null);
});

test('lost submit acknowledgment replays exact durable command after restart without a provider call', async () => {
  const f = fixture(); let generations = 0;
  const options = { ...f.options, adapter: { ...adapter, generate: async args => { generations++; return adapter.generate(args); } } };
  await assert.rejects(runPollingCycle({ ...options, request: async (...args) => { const result = await f.request(...args); if (args[1].endsWith('/results')) throw new Error('lost reply'); return result; } }));
  const pending = await f.journal.load(); assert.equal(pending.phase, 'results');
  await runPollingCycle({ ...options, request: async (...args) => args[1].startsWith('/jobs?') ? { items: [], nextCursor: null } : f.request(...args) });
  const attempts = f.calls.filter(call => call.path.endsWith('/results'));
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(generations, 1);
  assert.equal(await f.journal.load(), null);
});

test('provider interruption and restart in claimed phase report unknownOutcome without a second call', async () => {
  const f = fixture();
  await runPollingCycle({ ...f.options, adapter: { ...adapter, generate: async () => { throw new Error('private provider detail'); } } });
  assert.equal(f.calls.find(call => call.path.endsWith('/failures')).body.kind, 'unknownOutcome');
  assert(!JSON.stringify(f.calls).includes('private provider detail'));
  await f.journal.save({ jobId: 'j', targetId: 'target', lease, phase: 'claimed' });
  await runPollingCycle({ ...f.options, request: async (...args) => args[1].startsWith('/jobs?') ? { items: [], nextCursor: null } : f.request(...args) });
  assert.equal(f.calls.filter(call => call.path.endsWith('/failures')).length, 2);
});

test('claim conflict is skipped; lost heartbeat never submits a late result', async () => {
  const f = fixture();
  assert.deepEqual(await runPollingCycle({ ...f.options, request: async (...args) => { if (args[1].endsWith('/claim')) throw new WorkerHttpError(409, 'automation_claim_conflict'); return f.request(...args); } }), []);
  await runPollingCycle({ ...f.options, heartbeatMs: 1, request: async (...args) => { if (args[1].endsWith('/heartbeat')) throw new WorkerHttpError(409, 'automation_lease_lost'); return f.request(...args); },
    adapter: { ...adapter, generate: async args => { await delay(15); return adapter.generate(args); } } });
  assert(!f.calls.some(call => call.path.endsWith('/results')));
  assert(f.calls.some(call => call.body?.kind === 'unknownOutcome'));
});

test('transport uses fresh bearer and command ID, forbids redirects and redacts error bodies', async () => {
  let calls = 0;
  const request = createWorkerTransport({ baseUrl: 'http://127.0.0.1:4000', accessToken: async () => 'token' + ++calls, fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:4000'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer token' + calls);
    assert.equal(options.headers['known-command-id'], 'command');
    return new Response(JSON.stringify({ error: { code: 'authentication_required', message: 'private' } }), { status: 401 });
  } });
  await assert.rejects(request('POST', '/pairings/claim', {}, 'command'), error => error.message === 'Worker HTTP 401: authentication_required');
  await assert.rejects(request('POST', '/pairings/claim', {}, 'command')); assert.equal(calls, 2);
  assert.throws(() => createWorkerTransport({ baseUrl: 'http://remote.example', accessToken: async () => '' }));
});

test('file journal survives reopening with private permissions and blocks target mismatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-worker-'));
  try {
    const path = join(directory, 'journal'), journal = createFileJournal(path);
    await journal.save({ targetId: 'foreign', phase: 'claimed', lease });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await createFileJournal(path).load()).lease.claimToken, 'secret');
    await assert.rejects(runPollingCycle({ ...fixture().options, journal }), /another target/u);
    await journal.clear(); assert.equal(await journal.load(), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
