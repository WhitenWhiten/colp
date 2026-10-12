import { expect, test, vi } from 'vitest';
import { createFixedWindowRateLimiter, consumeProductAdmission } from '../../server/src/transport/http-security.js';
import { createSubscriptionProductClient } from '../src/bookmark-subscriptions/product-client.js';
import { createMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { digest } from '../src/bookmark-subscriptions/projection.js';
import { database, row, root, leaf, nativeFixture, scope } from './bookmark-subscriptions-fixture.js';
import type { SnapshotDescriptor } from '../src/bookmark-subscriptions/contracts.js';

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Known-Subscription-Session': 'session-a', ...headers } });
}
function transport(respond: (path: string, init?: RequestInit) => Promise<Response>, wait: (ms: number) => Promise<void>, assertCurrent = async () => {}) {
  return createSubscriptionProductClient({ serverOrigin: scope.serverOrigin, accountId: scope.accountId, assertCurrent, wait, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/session') return json({ authenticated: true, csrfToken: 'csrf' });
    if (path === '/api/v1/auth/get-session') return json({ user: { id: scope.accountId }, session: { id: 'session-a' } });
    return respond(path, init);
  } });
}

test('a full 16000-node permission scan progresses across the deployed 120/minute quota', async () => {
  const db = database();
  try {
    const mapping = row();
    const nodes = [root, ...Array.from({ length: 15999 }, (_, i) => ({ ...leaf('node-' + i), index: i }))];
    await db.put('mappings', mapping);
    const staged = await db.stage(mapping, { descriptor: { counts: { nodes: nodes.length } } as SnapshotDescriptor, nodes });
    let now = 0, denied = 0;
    const batches: string[] = [], waits: number[] = [];
    const limiter = createFixedWindowRateLimiter({ maxRequests: 120, windowMs: 60000, now: () => now });
    const client = transport(async (path, init) => {
      now += 35;
      const admission = await consumeProductAdmission(limiter, 'subscription-read:' + scope.accountId);
      if (admission.kind === 'denied') { denied++; return json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(admission.retryAfterSeconds) }); }
      const fence = { mappingId: mapping.id, generation: mapping.mapping.generation, mappingRevision: mapping.mapping.revision, authorityRevision: 'a1', contentEnabled: true, state: 'available' };
      if (path.endsWith('/node-access-checks')) {
        const body = JSON.parse(String(init?.body)); batches.push(body.nodes[0].nodeId);
        return json({ ...fence, requestDigest: digest(body.nodes), removeNodes: [] });
      }
      return json({ ...fence, removeEditionIds: [] });
    }, async ms => { waits.push(ms); now += ms; });
    const maintenance = createMaintenance(db, createNativeExecutor(db, nativeFixture().api));
    await expect(maintenance.access({ scope, client, assertCurrent: async () => {} }, staged)).resolves.toBe(true);
    expect(denied).toBe(1);
    expect(batches).toHaveLength(125);
    expect(new Set(batches).size).toBe(125);
    expect(batches.at(-1)).toBe('node-15872');
    expect(waits.every(ms => ms <= 10000)).toBe(true);
    expect((await db.get('meta', 'scan:' + mapping.id))?.value).toMatchObject({ complete: true, processed: 15999 });
  } finally { await db.close(); }
}, 20000);

test('quota retry preserves command id/body and has an independent CSRF retry budget', async () => {
  const writes: RequestInit[] = [];
  const wait = vi.fn(async () => {});
  const client = transport(async (_path, init) => {
    writes.push(init!);
    if (writes.length === 1) return json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '1' });
    if (writes.length === 2) return json({ error: { code: 'csrf_failed' } }, 403);
    return json({ ok: true });
  }, wait);
  const commandId = crypto.randomUUID();
  await expect(client.request('/me/bookmark-subscription-exits', { method: 'POST', commandId, body: { previewId: 'same-preview' } })).resolves.toMatchObject({ data: { ok: true } });
  expect(writes).toHaveLength(3);
  expect(writes.map(w => w.body)).toEqual(Array(3).fill(JSON.stringify({ previewId: 'same-preview' })));
  for (const write of writes) expect(write.headers).toHaveProperty('Known-Command-Id', commandId);
  expect(wait).toHaveBeenCalledOnce();
});

test('authority change during quota wait prevents the retry request', async () => {
  let changed = false;
  const respond = vi.fn(async () => json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' }));
  const client = transport(respond, async () => { changed = true; }, async () => { if (changed) throw new Error('authority_fenced'); });
  await expect(client.request('/me/bookmark-subscriptions')).rejects.toThrow('authority_fenced');
  expect(respond).toHaveBeenCalledOnce();
});

test('persistent quota rejection stays bounded and reports the final retry delay', async () => {
  const respond = vi.fn(async () => json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '1' }));
  const wait = vi.fn(async () => {});
  await expect(transport(respond, wait).request('/me/bookmark-subscriptions')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 1000 });
  expect(respond).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
});

test.each(['invalid', '3600'])('does not wait indefinitely for Retry-After %s', async header => {
  const respond = vi.fn(async () => json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': header }));
  const wait = vi.fn(async () => {});
  await expect(transport(respond, wait).request('/me/bookmark-subscriptions')).rejects.toThrow('rate_limited');
  expect(respond).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
});
