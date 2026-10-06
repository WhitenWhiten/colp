/**
 * U-5 Security property invariants (contracted only).
 * Design cards: reports/audit/property-design-cards-u5.md (U5-S1..S4).
 *
 * Do not use production scope/digest helpers as oracle.
 */

import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  enforceCredentialRestrictions,
  enforceRateLimit,
  evaluateEffectiveScopes,
  type AtomicRateLimitCharge,
  type AtomicRateLimitCeilingResult,
  type AtomicRateLimitPort,
  type AtomicRateLimitResult,
  type CredentialRestriction,
  type CredentialRestrictionPorts,
  type RateLimitBucketId,
} from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';
import { propertyOptions } from '../helpers/property-options.js';

const evidence = '[review:security.u5-properties]';
const RUNS = 60;
const ASYNC_RUNS = 40;
const RATE_RUNS = 50;

const options = (numRuns = RUNS) => propertyOptions(numRuns);

const scopes: readonly ScopeName[] = [
  'collections:read',
  'nodes:read',
  'nodes:write',
  'annotations:read',
  'feed:read',
  'sync:pull',
];

const user: PrincipalRef = { type: 'user', id: 'u5-user' };

function policy(
  allowed: readonly ScopeName[],
  denied: readonly ScopeName[] = [],
): AccessPolicy {
  const entries: AccessPolicy['entries'] = [];
  if (allowed.length > 0) {
    entries.push({
      principal: user,
      effect: 'allow',
      scopes: [allowed[0]!, ...allowed.slice(1)],
    });
  }
  if (denied.length > 0) {
    entries.push({
      principal: user,
      effect: 'deny',
      scopes: [denied[0]!, ...denied.slice(1)],
    });
  }
  return {
    visibility: 'private',
    entries,
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'u5-policy',
  };
}

function openChain(layer: AccessPolicy, object: AccessPolicy = layer) {
  return {
    serverDefault: layer,
    collection: layer,
    ancestors: [] as AccessPolicy[],
    object,
  };
}

const scopeSubset = fc.subarray([...scopes], { minLength: 0, maxLength: scopes.length });
const nonEmptyScopes = fc.subarray([...scopes], { minLength: 1, maxLength: scopes.length });

describe(`U-5 effective-scopes deny monotonicity / empty scopes ${evidence}`, () => {
  it(`regression: empty deny scopes fail closed (mutant 762) ${evidence}`, () => {
    const allow = policy(['nodes:read']);
    const hostile = {
      ...allow,
      entries: [
        ...allow.entries,
        {
          principal: user,
          effect: 'deny' as const,
          scopes: [] as unknown as [ScopeName, ...ScopeName[]],
        },
      ],
    } as AccessPolicy;
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [user],
      policyChain: openChain(allow, hostile),
    });
    expect(effective.size).toBe(0);
    expect([...effective]).toEqual([]);
  });

  it(`adding deny scopes never enlarges the effective set ${evidence}`, () => {
    fc.assert(
      fc.property(scopeSubset, scopeSubset, scopeSubset, (granted, denied, extraDeny) => {
        const allow = policy(granted);
        const baseObject = policy(granted, denied);
        const tighterObject = policy(granted, [...new Set([...denied, ...extraDeny])]);
        const grantedSet = new Set<ScopeName>(granted);
        const base = evaluateEffectiveScopes({
          grantedScopes: grantedSet,
          identities: [user],
          policyChain: openChain(allow, baseObject),
        });
        const tighter = evaluateEffectiveScopes({
          grantedScopes: new Set<ScopeName>(granted),
          identities: [user],
          policyChain: openChain(allow, tighterObject),
        });
        // Independent oracle: set inclusion under additional denies.
        expect([...tighter].every((scope) => base.has(scope))).toBe(true);
        expect([...tighter].every((scope) => grantedSet.has(scope) && !denied.includes(scope) && !extraDeny.includes(scope))).toBe(true);
      }),
      options(),
    );
  });

  it(`empty scopes on a deny entry always fail closed across allow baselines ${evidence}`, () => {
    fc.assert(
      fc.property(nonEmptyScopes, (granted) => {
        const allow = policy(granted);
        const hostile = {
          ...allow,
          entries: [
            ...allow.entries,
            {
              principal: user,
              effect: 'deny' as const,
              scopes: [] as unknown as [ScopeName, ...ScopeName[]],
            },
          ],
        } as AccessPolicy;
        const effective = evaluateEffectiveScopes({
          grantedScopes: new Set<ScopeName>(granted),
          identities: [user],
          policyChain: openChain(allow, hostile),
        });
        expect(effective.size).toBe(0);
      }),
      options(ASYNC_RUNS),
    );
  });
});

describe(`U-5 credential restriction intersection monotonicity ${evidence}`, () => {
  function ports(): CredentialRestrictionPorts {
    return {
      nodeSubtree: { isAllowed: vi.fn(async () => true) },
      operationBudget: { checkAndConsume: vi.fn(async () => true) },
      clock: { now: () => Date.parse('2026-07-18T04:00:00.000Z') },
    };
  }

  const collectionId = fc.stringMatching(/^[a-z]{3,10}$/);

  it(`regression: collection denial stays denied after extra maxOperations ${evidence}`, async () => {
    const handle = ports();
    const base: CredentialRestriction = {
      collectionAllowlist: ['a'],
      allowPublicExposure: false,
    };
    const extra: CredentialRestriction = {
      collectionAllowlist: ['a'],
      maxOperations: 1,
      allowPublicExposure: false,
    };
    const first = await enforceCredentialRestrictions(handle, {
      credentialId: 'key-u5',
      restrictions: [base],
      collectionId: 'b',
      operationCost: 1,
      publicExposure: false,
    });
    expect(first.allowed).toBe(false);
    const tighter = await enforceCredentialRestrictions(handle, {
      credentialId: 'key-u5',
      restrictions: [base, extra],
      collectionId: 'b',
      operationCost: 1,
      publicExposure: false,
    });
    expect(tighter.allowed).toBe(false);
    expect(handle.operationBudget!.checkAndConsume).not.toHaveBeenCalled();
  });

  it(`adding restrictions cannot flip a collection denial to allow ${evidence}`, async () => {
    const deniedRequest = fc.uniqueArray(collectionId, { minLength: 2, maxLength: 5 }).map(
      (ids) => ({
        allowedCollections: ids.slice(0, -1),
        requested: ids[ids.length - 1]!,
      }),
    );
    await fc.assert(
      fc.asyncProperty(
        deniedRequest,
        fc.integer({ min: 1, max: 8 }),
        async ({ allowedCollections, requested }, maxOperations) => {
          const baseRestriction: CredentialRestriction = {
            collectionAllowlist: allowedCollections,
            allowPublicExposure: false,
          };
          const extra: CredentialRestriction = {
            collectionAllowlist: allowedCollections,
            maxOperations,
            allowPublicExposure: false,
          };
          const handle = ports();
          const decision = await enforceCredentialRestrictions(handle, {
            credentialId: 'key-u5',
            restrictions: [baseRestriction],
            collectionId: requested,
            operationCost: 1,
            publicExposure: false,
          });
          expect(decision.allowed).toBe(false);

          const tighter = await enforceCredentialRestrictions(handle, {
            credentialId: 'key-u5',
            restrictions: [baseRestriction, extra],
            collectionId: requested,
            operationCost: 1,
            publicExposure: false,
          });
          // Independent oracle: denial is monotone under added restrictions.
          expect(tighter.allowed).toBe(false);
          expect(handle.operationBudget!.checkAndConsume).not.toHaveBeenCalled();
        },
      ),
      options(ASYNC_RUNS),
    );
  });
});

describe(`U-5 rate-limit cost / remaining monotonicity ${evidence}`, () => {
  const bucket: RateLimitBucketId = 'publisher:general-write';

  function capacityPort(remaining: {
    readonly credential: number;
    readonly ip: number;
    readonly instance: number;
  }): AtomicRateLimitPort {
    return {
      charge: async (charge: AtomicRateLimitCharge): Promise<AtomicRateLimitResult> => {
        const map = {
          credential: remaining.credential,
          ip: remaining.ip,
          instance: remaining.instance,
        } as const;
        return {
          ceilings: charge.ceilings.map((ceiling): AtomicRateLimitCeilingResult => {
            const left = map[ceiling.dimension];
            const allowed = charge.cost <= left;
            return {
              dimension: ceiling.dimension,
              key: ceiling.key,
              allowed,
              remaining: allowed ? left - charge.cost : left,
              resetSeconds: 30,
            };
          }),
        };
      },
    };
  }

  function request(cost: number, limits: { credential: number; ip: number; instance: number }) {
    return {
      bucket,
      cost,
      credentialId: 'key-u5',
      ipAddress: '203.0.113.50',
      instanceId: 'instance-u5',
      ceilings: {
        credential: { policy: 'write:credential', limit: limits.credential, windowSeconds: 60 },
        ip: { policy: 'write:ip', limit: limits.ip, windowSeconds: 60 },
        instance: { policy: 'write:instance', limit: limits.instance, windowSeconds: 300 },
      },
    };
  }

  const remainingArb = fc.record({
    credential: fc.integer({ min: 0, max: 20 }),
    ip: fc.integer({ min: 0, max: 20 }),
    instance: fc.integer({ min: 0, max: 20 }),
  });

  it(`regression: zero remaining denies cost 1 and higher cost stays denied ${evidence}`, async () => {
    const remaining = { credential: 0, ip: 0, instance: 0 };
    const limits = { credential: 1, ip: 1, instance: 1 };
    const port = capacityPort(remaining);
    const first = await enforceRateLimit(port, request(1, limits));
    expect(first.allowed).toBe(false);
    if (!first.allowed) {
      expect(first.reason).toBe('limited');
    }
    const higher = await enforceRateLimit(port, request(2, limits));
    expect(higher.allowed).toBe(false);
  });

  it(`higher cost cannot turn a capacity denial into allow ${evidence}`, async () => {
    await fc.assert(
      fc.asyncProperty(
        remainingArb,
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 10 }),
        async (remaining, cost, delta) => {
          const limits = {
            credential: Math.max(remaining.credential, 1),
            ip: Math.max(remaining.ip, 1),
            instance: Math.max(remaining.instance, 1),
          };
          const port = capacityPort(remaining);
          const first = await enforceRateLimit(port, request(cost, limits));
          const oracleDeny =
            cost > remaining.credential || cost > remaining.ip || cost > remaining.instance;
          expect(first.allowed).toBe(!oracleDeny);
          if (!first.allowed) {
            const higher = await enforceRateLimit(port, request(cost + delta, limits));
            expect(higher.allowed).toBe(false);
          }
        },
      ),
      options(RATE_RUNS),
    );
  });

  it(`tighter remaining cannot turn a capacity denial into allow ${evidence}`, async () => {
    await fc.assert(
      fc.asyncProperty(
        remainingArb,
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 5 }),
        async (remaining, cost, tighten) => {
          const limits = {
            credential: Math.max(remaining.credential, 1),
            ip: Math.max(remaining.ip, 1),
            instance: Math.max(remaining.instance, 1),
          };
          const first = await enforceRateLimit(capacityPort(remaining), request(cost, limits));
          if (!first.allowed) {
            const tighterRemaining = {
              credential: Math.max(0, remaining.credential - tighten),
              ip: Math.max(0, remaining.ip - tighten),
              instance: Math.max(0, remaining.instance - tighten),
            };
            const second = await enforceRateLimit(
              capacityPort(tighterRemaining),
              request(cost, limits),
            );
            expect(second.allowed).toBe(false);
          }
        },
      ),
      options(RATE_RUNS),
    );
  });
});

describe(`U-5 effective-scopes caller mutation isolation ${evidence}`, () => {
  it(`regression: returned set unchanged after identity id mutation to mallory ${evidence}`, () => {
    const granted: ScopeName[] = ['nodes:read', 'nodes:write'];
    const allow = policy(granted);
    const identities: PrincipalRef[] = [{ type: 'user', id: 'u5-user' }];
    const grantedScopes = new Set<ScopeName>(granted);
    const effective = evaluateEffectiveScopes({
      grantedScopes,
      identities,
      policyChain: openChain(allow),
    });
    const snapshot = [...effective].sort();
    expect(snapshot).toEqual(['nodes:read', 'nodes:write']);
    identities[0] = { type: 'user', id: 'mallory' };
    grantedScopes.add('audit:read');
    expect([...effective].sort()).toEqual(snapshot);
  });

  it(`returned effective set is stable after caller mutates identities and grants ${evidence}`, () => {
    fc.assert(
      fc.property(nonEmptyScopes, (granted) => {
        const allow = policy(granted);
        const identities: PrincipalRef[] = [{ type: 'user', id: 'u5-user' }];
        const grantedScopes = new Set<ScopeName>(granted);
        const effective = evaluateEffectiveScopes({
          grantedScopes,
          identities,
          policyChain: openChain(allow),
        });
        const snapshot = [...effective].sort();
        identities[0] = { type: 'user', id: 'mallory' };
        grantedScopes.add('audit:read');
        grantedScopes.delete(granted[0]!);
        expect([...effective].sort()).toEqual(snapshot);
      }),
      options(ASYNC_RUNS),
    );
  });
});
