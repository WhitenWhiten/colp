#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export class WorkerHttpError extends Error {
  constructor(status, code) { super(`Worker HTTP ${status}: ${code}`); this.status = status; this.code = code; }
}

/** Supply a fresh access token per request. Never forward credentials across redirects. */
export function createWorkerTransport({ baseUrl, accessToken, fetchImpl = fetch, signal }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('Use an HTTPS origin or an HTTP loopback origin without credentials.');
  }
  return async (method, path, body, commandId) => {
    const response = await fetchImpl(new URL('/api/v1/automation-work' + path, base), {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { authorization: 'Bearer ' + await accessToken(), ...(body ? { 'content-type': 'application/json', 'known-command-id': commandId } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new WorkerHttpError(response.status, /^[a-z_]+$/u.test(value?.error?.code) ? value.error.code : 'request_failed');
    return value;
  };
}

export function createFileJournal(path) {
  return {
    async load() { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async save(value) {
      // Contains the one-time lease and untrusted output: keep private and replace atomically.
      const temporary = path + '.' + randomUUID() + '.tmp';
      const file = await open(temporary, 'wx', 0o600);
      try {
        try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
    async clear() { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
  };
}

async function readPages(request, path, query) {
  const items = [], seen = new Set();
  let cursor;
  do {
    const params = new URLSearchParams({ ...query, limit: '100', ...(cursor ? { cursor } : {}) });
    const page = await request('GET', path + '?' + params);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Repeated pagination cursor.');
    seen.add(cursor);
  } while (cursor);
  return items;
}

const proof = lease => ({ claimToken: lease.claimToken, generation: lease.generation });
const unknownFailure = lease => ({ ...proof(lease), kind: 'unknownOutcome', code: 'worker_interrupted', message: 'Adapter outcome is unknown; reconcile before any external retry.' });

async function flush(request, journal, pending) {
  if (pending.phase === 'claimed') {
    pending = { ...pending, phase: 'failures', commandId: randomUUID(), body: unknownFailure(pending.lease) };
    await journal.save(pending);
  }
  const result = await request('POST', `/jobs/${encodeURIComponent(pending.jobId)}/${pending.phase}`, pending.body, pending.commandId);
  if (pending.phase === 'results' && ['awaitingApproval', 'committing'].includes(result.status)) {
    // A completed HTTP command replays its original pending response forever. Reconcile the
    // same proposal with a fresh transport command after a KNOWN pending response, preserving
    // the typed body and server-owned plan identity. Lost responses still replay the old command.
    await journal.save({ ...pending, commandId: randomUUID() });
  } else await journal.clear();
  return result;
}

async function withHeartbeat(request, jobId, lease, interval, signal, work) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let failure;
  const heartbeat = (async () => {
    try {
      while (true) {
        await delay(interval, undefined, { signal: combined });
        await request('POST', `/jobs/${encodeURIComponent(jobId)}/heartbeat`, { ...proof(lease), extendSeconds: 120 }, randomUUID());
      }
    } catch (error) { if (!combined.aborted) { failure = error; controller.abort(); } }
  })();
  try {
    combined.throwIfAborted();
    const value = await work(combined);
    if (failure) throw failure;
    combined.throwIfAborted();
    return value;
  } finally { controller.abort(); await heartbeat; }
}

/** One serial queue reconciliation. Adapter has no transport, credential or lease access. */
export async function runPollingCycle({ request, targetId, adapter, journal, pairing, heartbeatMs = 30_000, signal }) {
  signal?.throwIfAborted();
  if (!targetId) throw new Error('Select a targetId.');
  const results = [];
  const pending = await journal.load();
  if (pending) {
    if (pending.targetId !== targetId) throw new Error('Journal belongs to another target.');
    results.push(await flush(request, journal, pending));
    if (await journal.load()) return results;
  }
  if (pairing) await request('POST', '/pairings/claim', { pairingId: pairing.pairingId, code: pairing.code }, pairing.commandId);
  const jobs = await readPages(request, '/jobs', { targetId });
  for (const job of jobs) {
    signal?.throwIfAborted();
    // Unsupported tasks stay available for a capable worker; do not consume their budget.
    if (job.status !== 'ready' || !adapter.supports(job.task)) continue;
    let lease;
    try { lease = await request('POST', `/jobs/${encodeURIComponent(job.id)}/claim`, { deliveryHandle: job.deliveryHandle, requestedLeaseSeconds: 120 }, randomUUID()); }
    catch (error) { if (error instanceof WorkerHttpError && error.status === 409) continue; throw error; }
    const saved = { targetId, jobId: job.id, lease, phase: 'claimed' };
    await journal.save(saved);
    let generated;
    try {
      generated = await withHeartbeat(request, job.id, lease, heartbeatMs, signal, async signal => {
        const inputs = await readPages(request, `/jobs/${encodeURIComponent(job.id)}/inputs`, { deliveryHandle: job.deliveryHandle });
        if (!inputs.length || inputs.some(input => input.availability !== 'available')) throw new Error('Required inputs are unavailable.');
        signal.throwIfAborted();
        return adapter.generate({ task: job.task, allowedFolders: job.allowedFolders, inputs, signal });
      });
    } catch {
      // Includes interrupted provider calls and lost heartbeats. Never infer a safe retry.
      results.push(await flush(request, journal, saved));
      continue;
    }
    const submission = { ...saved, phase: 'results', commandId: randomUUID(), body: {
      ...proof(lease), inputDigest: lease.inputDigest, outputContract: job.task.outputContract, output: generated.output,
      ...(generated.modelLabel === undefined ? {} : { modelLabel: generated.modelLabel }),
      ...(generated.providerRequestId === undefined ? {} : { providerRequestId: generated.providerRequestId }),
      ...(generated.usageCostMicros === undefined ? {} : { usageCostMicros: generated.usageCostMicros }),
    } };
    await journal.save(submission);
    // A lost submit response is recovered using these exact bytes/command, never a new model call.
    results.push(await flush(request, journal, submission));
    if (await journal.load()) return results;
  }
  return results;
}

async function main() {
  const { COLP_ORIGIN, COLP_ACCESS_TOKEN, COLP_TARGET_ID, COLP_ADAPTER, COLP_JOURNAL,
    COLP_PAIRING_ID, COLP_PAIRING_CODE, COLP_PAIRING_COMMAND_ID } = process.env;
  if (!COLP_ORIGIN || !COLP_ACCESS_TOKEN || !COLP_TARGET_ID || !COLP_ADAPTER || !COLP_JOURNAL) {
    throw new Error('Set COLP_ORIGIN, COLP_ACCESS_TOKEN, COLP_TARGET_ID, COLP_ADAPTER and COLP_JOURNAL.');
  }
  const interval = Number(process.env.COLP_POLL_SECONDS ?? 60);
  if (!Number.isFinite(interval) || interval < 1) throw new Error('COLP_POLL_SECONDS must be at least 1.');
  if (COLP_PAIRING_ID && (!COLP_PAIRING_CODE || !COLP_PAIRING_COMMAND_ID)) throw new Error('Pairing requires code and a stable command UUID.');
  const adapter = await import(pathToFileURL(resolve(COLP_ADAPTER)).href);
  if (typeof adapter.supports !== 'function' || typeof adapter.generate !== 'function') throw new Error('Adapter must export supports and generate.');
  const journalPath = resolve(COLP_JOURNAL), lockPath = journalPath + '.lock';
  const lock = await open(lockPath, 'wx', 0o600);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const request = createWorkerTransport({ baseUrl: COLP_ORIGIN, accessToken: async () => COLP_ACCESS_TOKEN, signal: controller.signal });
    let pairing = COLP_PAIRING_ID ? { pairingId: COLP_PAIRING_ID, code: COLP_PAIRING_CODE, commandId: COLP_PAIRING_COMMAND_ID } : undefined;
    do {
      const results = await runPollingCycle({ request, targetId: COLP_TARGET_ID, adapter, journal: createFileJournal(journalPath), pairing, signal: controller.signal });
      pairing = undefined;
      for (const result of results) console.log(JSON.stringify({ jobId: result.jobId ?? result.resourceId, status: result.status }));
      if (process.argv.includes('--once')) break;
      await delay(interval * 1000, undefined, { signal: controller.signal });
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await lock.close(); await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { if (error.name !== 'AbortError') { console.error(error instanceof WorkerHttpError ? error.message : 'Worker stopped; check configuration or reconcile the private journal.'); process.exitCode = 1; } });
}
