import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';

const identity = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'bookmarks' };
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function configured() {
  const transport = await import('../src/personal-sync-fetch.js');
  const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
  transport.configurePersonalSyncTransport(policy);
  return { ...transport, policy };
}

test('composition installs one policy and unconfigured transport retains the exact native port', async () => {
  const transport = await import('../src/personal-sync-fetch.js');
  const fetcher = vi.fn<typeof fetch>(async () => new Response('unconfigured'));
  vi.stubGlobal('fetch', fetcher);
  assert.equal(transport.configuredPersonalSyncPolicy(), undefined);
  assert.equal(transport.personalSyncFetch(identity), fetcher);
  const native = { label: 'native', async get() { return this.label; } };
  assert.equal(await transport.personalSyncNativeApi(identity, native), native);
  const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
  transport.configurePersonalSyncTransport(policy);
  transport.configurePersonalSyncTransport(policy);
  assert.equal(transport.configuredPersonalSyncPolicy(), policy);
  assert.throws(() => transport.configurePersonalSyncTransport(
    createPersonalSyncPolicyStore(new MemoryStorageArea())), /already_configured/);
});

test('an unconfigured transport still forwards the exact request through the outer dispatch gate', async () => {
  const { personalSyncFetch } = await import('../src/personal-sync-fetch.js');
  const request = new Request('https://known.test/pull');
  const init = { headers: { 'x-known-test': 'dispatch' } };
  const response = new Response('forwarded');
  const fetcher = vi.fn<typeof fetch>(async () => response);
  const dispatch = vi.fn(async (send: () => Promise<Response>) => send());
  assert.equal(await personalSyncFetch(identity, fetcher, dispatch)(request, init), response);
  assert.equal(dispatch.mock.calls.length, 1);
  assert.deepEqual(fetcher.mock.calls, [[request, init]]);
});

test.each(['none', 'request', 'init'] as const)('configured fetch retains the %s request cancellation and the policy cancellation', async source => {
  const f = await configured();
  const caller = new AbortController();
  const request = source === 'request'
    ? new Request('https://known.test/pull', { signal: caller.signal }) : 'https://known.test/pull';
  let dispatchedSignal: AbortSignal | undefined;
  const fetcher: typeof fetch = async (_request, init) => {
    dispatchedSignal = init?.signal ?? undefined;
    return new Response('completed');
  };
  const response = await f.personalSyncFetch(identity, fetcher)(request,
    source === 'init' ? { signal: caller.signal } : undefined);
  assert.equal(await response.text(), 'completed');
  assert.ok(dispatchedSignal);
  assert.equal(dispatchedSignal.aborted, false);
  if (source !== 'none') {
    const reason = new Error('caller_cancelled'); caller.abort(reason);
    assert.equal(dispatchedSignal.aborted, true);
    assert.equal(dispatchedSignal.reason, reason);
  } else {
    await f.policy.write(identity, 'paused');
    assert.equal(dispatchedSignal.aborted, true);
    assert.match(String(dispatchedSignal.reason), /personal_sync_stopped/);
  }
});

test('an outer gate cannot revive an admitted request across Pause and Resume', async () => {
  const f = await configured();
  let send!: () => Promise<Response>;
  let entered!: () => void;
  const atGate = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async () => new Response('must not run'));
  const pending = f.personalSyncFetch(identity, fetcher, async callback => {
    send = callback; entered(); await gate; return send();
  })('https://known.test/push');
  const refused = assert.rejects(pending, /personal_sync_stopped/);
  await atGate;
  await f.policy.write(identity, 'paused');
  await f.policy.write(identity, 'enabled');
  release(); await refused;
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(await (await f.personalSyncFetch(identity, fetcher)('https://known.test/push')).text(), 'must not run');
  assert.equal(fetcher.mock.calls.length, 1, 'only a newly captured lease may send after Resume');
});

test('a response completed after Pause is refused even when the fetch port ignores cancellation', async () => {
  const f = await configured();
  let entered!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  let finish!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { finish = resolve; });
  const pending = f.personalSyncFetch(identity, async () => { entered(); return response; })('https://known.test/pull');
  const refused = assert.rejects(pending, /personal_sync_stopped/);
  await dispatched; await f.policy.write(identity, 'paused');
  finish(new Response('stale response')); await refused;
});

test('native forwarding preserves this, properties and arguments, and fences reads after Pause', async () => {
  const f = await configured();
  const observed: unknown[] = [];
  const api = { label: 'native receiver', async read(id: string) { observed.push([this.label, id]); return id; } };
  let attempts = 0;
  const wrapped = await f.personalSyncNativeApi(identity, api, async () => { attempts++; });
  assert.equal(wrapped.label, api.label);
  assert.equal(await wrapped.read('one'), 'one');
  assert.deepEqual(observed, [['native receiver', 'one']]);
  await f.policy.write(identity, 'paused');
  await assert.rejects(wrapped.read('two'), /personal_sync_stopped/);
  assert.equal(attempts, 2);
  assert.equal(observed.length, 1);
});

test('native attempt fences also work without policy composition and cannot be skipped by a method call', async () => {
  const { personalSyncNativeApi } = await import('../src/personal-sync-fetch.js');
  const api = { label: 'native', async read(id: string) { return `${this.label}:${id}`; } };
  let allowed = true;
  const wrapped = await personalSyncNativeApi(identity, api, async () => {
    if (!allowed) throw new Error('attempt_stale');
  });
  assert.equal(await wrapped.read('one'), 'native:one');
  allowed = false;
  await assert.rejects(wrapped.read('two'), /attempt_stale/);
});

test('native access with only the configured policy still checks its lease before each call', async () => {
  const f = await configured();
  const native = vi.fn(async () => 'read');
  const api = await f.personalSyncNativeApi(identity, { native });
  assert.equal(await api.native(), 'read');
  await f.policy.write(identity, 'paused');
  await assert.rejects(api.native(), /personal_sync_stopped/);
  assert.equal(native.mock.calls.length, 1);
});
