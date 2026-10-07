import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { createHttpClient, createPinnedFetch, ResponseTooLargeError } from '../src/http.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(new URL(`http://unresolvable.invalid:${server.address().port}/snapshot`));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

for (const status of [204, 205, 304]) {
  test(`pinned transport handles bodyless status ${status}`, async () => {
    await withServer((_request, response) => {
      response.writeHead(status, { ETag: '"cached"' });
      response.end();
    }, async url => {
      const response = await createPinnedFetch()(url, {}, '127.0.0.1');
      assert.equal(response.status, status);
      assert.equal(response.body, null);
      assert.equal(response.headers.get('etag'), '"cached"');
    });
  });
}

test('pinned transport handles HEAD without a body', async () => {
  await withServer((_request, response) => response.end('ignored'), async url => {
    const response = await createPinnedFetch()(url, { method: 'HEAD' }, '127.0.0.1');
    assert.equal(response.body, null);
  });
});

test('bounded reads cancel a pinned response and close the socket', async () => {
  let closed;
  await withServer((_request, response) => {
    closed = once(response, 'close');
    response.write('too large');
  }, async url => {
    const transport = createPinnedFetch();
    const http = createHttpClient({
      resolveHost: async () => ['93.184.216.34'],
      fetch: (target, init) => transport(target, init, '127.0.0.1'),
      maxBytes: 4,
    });
    await assert.rejects(http.request(url), ResponseTooLargeError);
    await closed;
  });
});

test('pinned transport rejects a truncated response', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': '100' });
    response.write('partial');
    setImmediate(() => response.destroy());
  }, async url => {
    const response = await createPinnedFetch()(url, {}, '127.0.0.1');
    await assert.rejects(response.text());
  });
});
