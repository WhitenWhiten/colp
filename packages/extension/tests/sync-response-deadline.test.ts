import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'vitest';
import { readBoundedJson } from '../src/json-response.js';
import { ack, emptyPullPage, json, scope, setup } from './durable-sync-engine-harness.js';

async function settles<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('response deadline did not release the caller')), 750);
    })]);
  } finally { clearTimeout(timer); }
}

test('bounds a real HTTP body that stalls after headers and closes the connection', async () => {
  let closed!: () => void;
  const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer((_request, response) => {
    response.on('close', closed);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"partial":');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    await assert.rejects(settles(readBoundedJson(response, 1024, 'invalid', {
      timeoutMilliseconds: 25,
    })), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    await settles(connectionClosed);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a byte rejection does not wait for an uncooperative stream cancel', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(11)); },
    cancel() { return new Promise<void>(() => {}); },
  }));
  await assert.rejects(settles(readBoundedJson(response, 10, 'too_large')), /too_large/);
});

for (const endpoint of ['pull', 'snapshot', 'ack', 'ack_problem'] as const) {
  test(`${endpoint} body stall releases the engine without falsely completing its cursor or Ack`, async () => {
    const fixture = await setup({ requestTimeoutMilliseconds: 25, snapshotRequired: endpoint === 'snapshot' });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    }), { status: endpoint === 'ack_problem' ? 503 : 200,
      headers: { 'Content-Type': endpoint === 'ack_problem' ? 'application/problem+json' : 'application/json' } });
    if (endpoint === 'snapshot') fixture.snapshotResponses.push(response);
    else if (endpoint === 'pull') fixture.pullResponses.push(response);
    else {
      fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
      fixture.ackResponses.push(response);
    }
    const wake = fixture.engine.wake('manual');
    try {
      const state = await settles(wake);
      assert.equal(state?.phase, endpoint === 'snapshot' ? 'recovery' : 'offline');
      if (endpoint !== 'ack_problem') assert.equal(state?.lastError, 'network_unavailable');
      assert.ok(cancelled, 'release the stalled response stream');
      if (endpoint.startsWith('ack')) {
        assert.ok(await fixture.store.getPendingAckIntent(scope));
        fixture.ackResponses.push(json(200, ack('cursor-1')));
        fixture.clock.now += 60_000;
        await settles(fixture.engine.wake('manual'));
        assert.equal(await fixture.store.getPendingAckIntent(scope), null);
        assert.deepEqual(fixture.ackRequests[1], fixture.ackRequests[0], 'retry the exact durable Ack');
      } else {
        assert.equal((await fixture.store.getCursor(scope))?.cursor, undefined);
        assert.equal(fixture.ackRequests.length, 0);
        if (endpoint === 'pull') {
          fixture.pullResponses.push(json(200, emptyPullPage('cursor-0')));
          fixture.ackResponses.push(json(200, ack('cursor-0')));
          fixture.clock.now += 60_000;
          assert.equal((await settles(fixture.engine.wake('manual')))?.phase, 'sleeping');
        }
      }
    } finally {
      if (!cancelled) stream.error(new Error('test cleanup'));
      await wake;
      await fixture.store.close();
    }
  });
}
