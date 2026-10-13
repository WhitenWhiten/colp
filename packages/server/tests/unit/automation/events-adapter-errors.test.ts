import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { AutomationError } from '../../../src/modules/automation/index.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/index.js';
import { createMcpEventsAdapter } from '../../../src/modules/mcp/events-adapter.js';

const context = createMcpApplicationContext({ principal: { kind: 'authenticated', principalId: 'owner', clientId: 'client', credentialBindingId: 'binding',
  resourceAudience: 'https://example.test/collections/-/mcp', securityEpoch: '1' }, scopes: ['automation:work'], abortSignal: new AbortController().signal,
  budgets: { maxDepth: 16, maxNodes: 1000, maxBytes: 100000, maxOperations: 100 }, correlationId: randomUUID(), authorization: { accountSubjectId: 'subject' } });

test('Events errors separate retryable server conditions from invalid requests and lost authority', async () => {
  const codeFor = async (code: AutomationError['code']) => {
    const adapter = createMcpEventsAdapter({ available: async () => true, unsubscribe: async () => {},
      subscribe: async () => { throw new AutomationError(code, 'Internal detail that must not leak.'); } });
    const params = { name: 'colp.automation.triggered', arguments: { targetId: 'target' },
      delivery: { mode: 'webhook', url: 'https://hooks.example.test/automation', secret: 'whsec_'+Buffer.alloc(32, 7).toString('base64') } };
    return adapter.call(context, 'events/subscribe', params).then(() => null, (error: { code: number; message: string }) => {
      expect(error.message).not.toContain('Internal detail');
      return error.code;
    });
  };
  expect(await codeFor('rate_limited')).toBe(-32603);
  expect(await codeFor('automation_paused')).toBe(-32603);
  expect(await codeFor('invalid_request')).toBe(-32602);
  expect(await codeFor('resource_not_found')).toBe(-32602);
});
