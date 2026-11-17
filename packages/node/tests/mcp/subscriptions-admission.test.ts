import { describe, expect, it } from 'vitest';
import { createAnonymousPublicBinding } from '../../src/mcp/shared/authorization.js';
import {
  FIXTURE_RESOURCE_AUDIENCE,
  FIXTURE_SECURITY_EPOCH,
  authenticatedBinding,
} from './authenticated-binding-fixture.js';
import { harness, openSession } from './subscriptions-listen-harness.js';

const forwarded = (...values: string[]): readonly string[] => Object.freeze(values);

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

describe('MCP listen per-client admission identity', () => {
  it('does not key client buckets on caller-controlled forwarded evidence', async () => {
    const { adapter, memory } = harness({ maxConcurrentSessionsPerIp: 1 });
    const first = openSession(adapter, {}, { forwardedFor: forwarded('203.0.113.7') });
    try {
      // The same forwarded value shares the credential-bound bucket.
      expect(() => openSession(adapter, {}, { forwardedFor: forwarded('203.0.113.7') }))
        .toThrow(/per-client/u);
      // A different forwarded value must not mint a second bucket.
      expect(() => openSession(adapter, {}, { forwardedFor: forwarded('198.51.100.9') }))
        .toThrow(/per-client/u);
    } finally { first.close(); await first.closed; }
    expect(memory.listenerCount()).toBe(0);
  });

  it('gives an anonymous request the per-principal bucket instead of forwarded evidence', async () => {
    const { adapter, memory } = harness({
      maxConcurrentSessionsPerIp: 1,
      maxConcurrentSessionsPerPrincipal: 10,
    });
    const anonymous = createAnonymousPublicBinding({
      resourceAudience: FIXTURE_RESOURCE_AUDIENCE,
      securityEpoch: FIXTURE_SECURITY_EPOCH,
    });
    const first = openSession(adapter, {}, {
      binding: anonymous,
      forwardedFor: forwarded('203.0.113.7'),
    });
    try {
      expect(() => openSession(adapter, {}, {
        binding: anonymous,
        forwardedFor: forwarded('198.51.100.9'),
      })).toThrow(/per-client/u);
    } finally { first.close(); await first.closed; }
    expect(memory.listenerCount()).toBe(0);
  });

  it('enforces the aggregate cap before principal and client buckets', async () => {
    const { adapter, memory } = harness({
      maxConcurrentSessions: 1,
      maxConcurrentSessionsPerPrincipal: 10,
      maxConcurrentSessionsPerIp: 10,
    });
    const first = openSession(adapter, {});
    try {
      expect(() => openSession(adapter, {}, {
        binding: authenticatedBinding({ principalId: 'other-principal' }),
        forwardedFor: forwarded('198.51.100.9'),
      })).toThrow(/aggregate/u);
    } finally { first.close(); await first.closed; }
    expect(memory.listenerCount()).toBe(0);
  });
});
