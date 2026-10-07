import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHardenedEgressFetch } from '../../../src/infrastructure/egress/index.js';

for (const redirected of [false, true]) {
  test(`cancellation interrupts ${redirected ? 'redirect' : 'initial'} DNS and never connects to a late result`, async () => {
    const controller = new AbortController();
    let dnsStarted!: () => void;
    const started = new Promise<void>((resolve) => { dnsStarted = resolve; });
    let completeDns!: (addresses: readonly string[]) => void;
    let calls = 0;
    let resolverSignal: AbortSignal | undefined;
    const fetch = createHardenedEgressFetch({
      resolve: async (host, signal) => {
        if (redirected && host === 'first.example') return ['1.1.1.1'];
        resolverSignal = signal;
        dnsStarted();
        return new Promise((resolve) => { completeDns = resolve; });
      },
      connect: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: 'https://second.example/' } });
      },
    });
    let settled = false;
    const request = fetch('https://first.example/', { signal: controller.signal });
    const observed = request.then(() => 'success', (error: Error) => error.name)
      .then((name) => { settled = true; return name; });
    await started;
    controller.abort();
    // A turn of the event loop; DNS is deliberately still unresolved.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(settled, true, 'cancellation must not wait for DNS');
      assert.equal(resolverSignal?.aborted, true);
      assert.equal(await observed, 'AbortError');
    } finally {
      completeDns(['1.1.1.1']);
      await observed;
    }
    assert.equal(calls, redirected ? 1 : 0, 'late DNS must never start a connection');
  });
}

test('an already cancelled request does not start DNS', async () => {
  let calls = 0;
  const fetch = createHardenedEgressFetch({ resolve: async () => { calls++; return ['1.1.1.1']; } });
  await assert.rejects(fetch('https://first.example/', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
