import { expect, test } from 'vitest';
import { parseMcpEventsParams, MCP_AUTOMATION_EVENT } from '../../src/mcp/2026-07-28/events.js';
import { createMcp20260728DiscoverResult } from '../../src/mcp/2026-07-28/discovery.js';
const params = { name: MCP_AUTOMATION_EVENT, arguments: { targetId: 'target' }, delivery: { mode: 'webhook', url: 'https://callback.example/path', secret: 'whsec_'+Buffer.alloc(32,7).toString('base64') } };
test('discovery preserves only the pinned Events extension and freezes it', () => {
  const result = createMcp20260728DiscoverResult({ serverInfo: { name: 'COLP', version: '1' }, capabilities: { events: {}, unsupported: {} } });
  expect(JSON.parse(JSON.stringify(result)).capabilities).toEqual({ events: {} });
  expect(Object.isFrozen(result.capabilities.events)).toBe(true);
  expect(() => createMcp20260728DiscoverResult({ serverInfo: { name: 'COLP', version: '1' }, capabilities: { events: { poll: true } } })).toThrow();
});
test('OpenAI profile rejects replay, drafts, malformed secrets and credentials in callback URLs', () => {
  expect(parseMcpEventsParams('events/subscribe',params)).toMatchObject({ cursor: null, ttlMs: null });
  for (const change of [{ cursor: 'history' }, { ttlMs: 0 }, { ttlMs: Infinity }, { name: 'other' }, { arguments: { targetId: 'target', pairingCode: 'secret' } },
    { delivery: { ...params.delivery, url: 'http://example.com' } }, { delivery: { ...params.delivery, url: 'https://user:pass@example.com' } },
    { delivery: { ...params.delivery, secret: 'whsec_'+Buffer.alloc(23).toString('base64') } }, { delivery: { ...params.delivery, secret: 'whsec_'+Buffer.alloc(65).toString('base64') } }]) {
    expect(() => parseMcpEventsParams('events/subscribe',{ ...params,...change })).toThrow();
  }
  expect(() => parseMcpEventsParams('events/poll',{})).toThrow();
  expect(() => parseMcpEventsParams('events/list',{ cursor: 'history' })).toThrow();
  expect(() => parseMcpEventsParams('events/unsubscribe',params)).toThrow();
  expect(parseMcpEventsParams('events/unsubscribe',{ ...params, delivery: { mode: 'webhook',url: params.delivery.url } })).toMatchObject({ arguments: params.arguments });
});
