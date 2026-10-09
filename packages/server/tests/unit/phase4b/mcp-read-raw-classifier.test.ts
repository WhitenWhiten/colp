import assert from 'node:assert/strict';
import { test } from 'vitest';

import { classifyRawMcpBody } from '../../../src/transport/mcp/mcp-read-routes.js';

test('raw MCP classifier scans top-level keys linearly and ignores nested method fields', () => {
  const fields = Array.from({ length: 4_000 }, (_, index) => `"k${index}":"value"`).join(',');
  const body = Buffer.from(`{"params":{"method":"subscriptions/listen"},${fields},"method":"tools/call"}`);

  assert.deepEqual(classifyRawMcpBody(body), { listen: false, method: 'tools/call' });
});

test('raw MCP classifier decodes escaped method values without treating malformed JSON as listen', () => {
  assert.deepEqual(
    classifyRawMcpBody(Buffer.from('{"method":"subscriptions\\/listen"}')),
    { listen: true, method: 'subscriptions/listen' },
  );
  assert.deepEqual(
    classifyRawMcpBody(Buffer.from('{"method":"subscriptions\\u002flisten"}')),
    { listen: true, method: 'subscriptions/listen' },
  );
  assert.deepEqual(
    classifyRawMcpBody(Buffer.from('{"method":"subscriptions\\u"}')),
    { listen: false, method: 'unknown' },
  );
});
