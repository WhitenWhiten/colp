import { describe, expect, it } from 'vitest';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import { harness, openSession } from './subscriptions-listen-harness.js';

describe('MCP listen per-principal admission', () => {
  it('counts one principal across different clients and credentials', async () => {
    const { adapter, memory } = harness({ maxConcurrentSessionsPerPrincipal: 1 });
    const first = openSession(adapter, {});
    try {
      expect(() => openSession(adapter, {}, {
        binding: authenticatedBinding({ clientId: 'other-client', credentialBindingId: 'other-credential' }),
      })).toThrow(/per-principal/u);
      const other = openSession(adapter, {}, {
        binding: authenticatedBinding({ principalId: 'other-principal' }),
      });
      other.close();
      await other.closed;
    } finally { first.close(); await first.closed; }
    expect(memory.listenerCount()).toBe(0);
  });
});
