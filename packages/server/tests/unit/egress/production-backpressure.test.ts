import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { test, vi } from 'vitest';
import { createProductionEgressConnector } from '../../../src/infrastructure/egress/hardened-egress.js';

async function fixture(work: (response: Response, source: Readable, produced: () => number) => Promise<void>) {
  let bytes = 0;
  const source = new Readable({ highWaterMark: 64 * 1024, read() {
    if (bytes === 4 * 1024 * 1024) { this.push(null); return; }
    const chunk = Buffer.alloc(16 * 1024, (bytes / (16 * 1024)) % 256);
    bytes += chunk.length;
    this.push(chunk);
  } });
  Object.assign(source, { statusCode: 200, headers: {} });
  const spy = vi.spyOn(https, 'request').mockImplementation(((_url: unknown, _options: unknown,
    callback: (source: unknown) => void) => {
    const request = Object.assign(new EventEmitter(), {
      end() { queueMicrotask(() => callback(source)); }, destroy() { source.destroy(); },
    });
    return request;
  }) as never);
  try {
    const response = await createProductionEgressConnector()({
      url: new URL('https://example.test'), ip: '93.184.216.34', family: 4,
    }, {});
    await work(response, source, () => bytes);
  } finally { source.destroy(); spy.mockRestore(); }
}

test('production bridge bounds unread buffering and preserves all bytes while resuming', async () => {
  await fixture(async (response, _source, produced) => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.bodyUsed, false);
    assert.ok(produced() <= 192 * 1024, `unread producer advanced ${produced()} bytes`);
    const reader = response.body!.getReader();
    let bytes = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      assert.ok(item.value.every(value => value === (bytes / (16 * 1024)) % 256));
      bytes += item.value.length;
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(produced() - bytes <= 192 * 1024);
    }
    assert.equal(bytes, 4 * 1024 * 1024);
  });
});

test('cancelling the response destroys the production Node source', async () => {
  await fixture(async (response, source) => {
    await response.body!.cancel();
    assert.equal(source.destroyed, true);
  });
});

test('upstream errors propagate to the consumer without leaving a source alive', async () => {
  await fixture(async (response, source) => {
    source.destroy(new Error('fixture interruption'));
    await assert.rejects(response.arrayBuffer(), /fixture interruption/);
    assert.equal(source.destroyed, true);
  });
});
