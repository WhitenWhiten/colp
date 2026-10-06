/**
 * Entrypoint re-export smoke: keeps evaluateEffectiveScopes /
 * resolveRequestIdentities / hasEffectiveScope / serializeRateLimitFields
 * stable on `src/security/index` after implementation/export separation.
 *
 * Behavioral depth lives in authorization.test.ts, effective-scope.*, etc.
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateEffectiveScopes,
  hasEffectiveScope,
  resolveRequestIdentities,
  serializeRateLimitFields,
} from '../../src/security/index.js';

const publicPolicy = {
  visibility: 'public' as const,
  entries: [],
  publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
  revision: 'entrypoint-test',
};

describe('security entrypoint public contracts', () => {
  it('runs the re-exported authorization and rate-limit helpers through their public contracts', () => {
    const input = {
      grantedScopes: new Set(['collections:read' as const]),
      identities: [],
      policyChain: {
        serverDefault: publicPolicy,
        collection: publicPolicy,
        ancestors: [],
        object: publicPolicy,
      },
    };
    const evaluated = evaluateEffectiveScopes(input);
    expect([...evaluated]).toEqual(['collections:read']);
    expect(hasEffectiveScope(input, 'collections:read')).toBe(true);

    expect(serializeRateLimitFields({
      policy: 'publisher:read',
      limit: 10,
      remaining: 9,
      resetSeconds: 30,
      windowSeconds: 60,
    })).toEqual({
      RateLimit: '"publisher:read";r=9;t=30',
      'RateLimit-Policy': '"publisher:read";q=10;w=60',
    });
  });

  it('resolveRequestIdentities yields the canonical public anonymous shape', () => {
    const identities = resolveRequestIdentities({
      status: 'anonymous',
      identities: [],
    });

    expect(identities).toHaveLength(1);
    expect(identities[0]).toEqual({ type: 'public', id: 'public' });
    expect(Object.isFrozen(identities)).toBe(true);
    expect(Object.isFrozen(identities[0])).toBe(true);
  });
});
