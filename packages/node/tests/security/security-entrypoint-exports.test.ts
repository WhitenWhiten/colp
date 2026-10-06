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

describe('security entrypoint export smoke', () => {
  it('re-exports core authorization and rate-limit helpers as functions', () => {
    expect(typeof evaluateEffectiveScopes).toBe('function');
    expect(typeof resolveRequestIdentities).toBe('function');
    expect(typeof hasEffectiveScope).toBe('function');
    expect(typeof serializeRateLimitFields).toBe('function');
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
