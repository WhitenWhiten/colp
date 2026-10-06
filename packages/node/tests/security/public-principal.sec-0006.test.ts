import { describe, expect, it, vi } from 'vitest';

import {
  evaluateEffectiveScopes,
  resolveRequestIdentities,
} from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const evidence = '[evidence:security.authenticated-public-isolation]';
const canonicalPublic: PrincipalRef = { type: 'public', id: 'public' };
const noncanonicalPublic: PrincipalRef = { type: 'public', id: 'everyone' };
const user: PrincipalRef = { type: 'user', id: 'alice' };
const readScopes = new Set<ScopeName>([
  'collections:read',
  'nodes:read',
  'attachments:read',
]);

function policy(
  visibility: AccessPolicy['visibility'],
  entries: AccessPolicy['entries'] = [],
): AccessPolicy {
  return {
    visibility,
    entries,
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-sec-0006',
  };
}

function chain(layer: AccessPolicy) {
  return { serverDefault: layer, collection: layer, ancestors: [], object: layer };
}

function evaluateAuthenticated(
  identities: readonly PrincipalRef[],
  layer: AccessPolicy,
): ReadonlySet<ScopeName> {
  return evaluateEffectiveScopes({
    grantedScopes: readScopes,
    identityResolution: { status: 'authenticated', identities },
    policyChain: chain(layer),
  });
}

function evaluateLegacy(
  identities: readonly PrincipalRef[],
  layer: AccessPolicy,
): ReadonlySet<ScopeName> {
  return evaluateEffectiveScopes({
    grantedScopes: readScopes,
    identities,
    policyChain: chain(layer),
  });
}

describe(`${evidence} SEC-0006 caller-supplied public isolation`, () => {
  it(`${evidence} filters canonical and noncanonical public from all six authenticated identity types`, () => {
    const authenticatedTypes = [
      'user',
      'group',
      'oauth_client',
      'api_key',
      'service',
      'ai_agent',
    ] as const;

    for (const type of authenticatedTypes) {
      const identity: PrincipalRef = { type, id: `${type}-principal` };
      const resolved = resolveRequestIdentities({
        status: 'authenticated',
        identities: [canonicalPublic, identity, noncanonicalPublic],
      });

      expect(resolved, type).toEqual([identity]);
      expect(resolved.some((principal) => principal.type === 'public'), type).toBe(false);
    }
  });

  it(`${evidence} fails closed for authenticated public-only resolutions`, () => {
    expect(() =>
      resolveRequestIdentities({
        status: 'authenticated',
        identities: [canonicalPublic, noncanonicalPublic],
      }),
    ).toThrow();
    expect(() =>
      resolveRequestIdentities({ credentialEstablished: true, identities: [canonicalPublic] }),
    ).toThrow();

    const effective = evaluateAuthenticated(
      [canonicalPublic, noncanonicalPublic],
      policy('protected', [
        { principal: canonicalPublic, effect: 'allow', scopes: ['nodes:read'] },
      ]),
    );
    expect([...effective]).toEqual([]);
  });

  it(`${evidence} rejects caller-supplied public identities for explicit anonymous state`, () => {
    for (const suppliedPublic of [canonicalPublic, noncanonicalPublic]) {
      expect(() =>
        resolveRequestIdentities({ status: 'anonymous', identities: [suppliedPublic] }),
      ).toThrow();
      expect(() =>
        resolveRequestIdentities({ credentialEstablished: false, identities: [suppliedPublic] }),
      ).toThrow();
    }
  });

  it(`${evidence} fails closed for canonical and noncanonical legacy public-only inputs`, () => {
    const protectedPolicy = policy('protected', [
      { principal: canonicalPublic, effect: 'allow', scopes: ['nodes:read'] },
      { principal: noncanonicalPublic, effect: 'allow', scopes: ['attachments:read'] },
    ]);

    expect([...evaluateLegacy([canonicalPublic], protectedPolicy)]).toEqual([]);
    expect([...evaluateLegacy([noncanonicalPublic], protectedPolicy)]).toEqual([]);
    expect([...evaluateLegacy([canonicalPublic, noncanonicalPublic], protectedPolicy)]).toEqual([]);
  });

  it(`${evidence} lets legacy mixed user and public input match only the user ACL`, () => {
    const protectedPolicy = policy('protected', [
      { principal: canonicalPublic, effect: 'allow', scopes: ['nodes:read'] },
      { principal: noncanonicalPublic, effect: 'allow', scopes: ['attachments:read'] },
      { principal: user, effect: 'allow', scopes: ['collections:read'] },
    ]);

    const effective = evaluateLegacy(
      [canonicalPublic, user, noncanonicalPublic],
      protectedPolicy,
    );
    expect([...effective]).toEqual(['collections:read']);
  });

  it(`${evidence} ignores both public allow and public deny ACL entries for authenticated requests`, () => {
    const withPublicAllow = policy('protected', [
      { principal: canonicalPublic, effect: 'allow', scopes: ['nodes:read'] },
      { principal: user, effect: 'allow', scopes: ['collections:read'] },
    ]);
    const withPublicDeny = policy('protected', [
      {
        principal: user,
        effect: 'allow',
        scopes: ['collections:read', 'nodes:read', 'attachments:read'],
      },
      { principal: noncanonicalPublic, effect: 'deny', scopes: ['nodes:read'] },
    ]);
    const supplied = [canonicalPublic, user, noncanonicalPublic];

    expect([...evaluateAuthenticated(supplied, withPublicAllow)]).toEqual(['collections:read']);
    expect([...evaluateAuthenticated(supplied, withPublicDeny)]).toEqual([
      'collections:read',
      'nodes:read',
      'attachments:read',
    ]);
  });

  it(`${evidence} isolates equal ids across public, user, and group principal types`, () => {
    const sharedUser: PrincipalRef = { type: 'user', id: 'shared' };
    const sharedPublic: PrincipalRef = { type: 'public', id: 'shared' };
    const sharedGroup: PrincipalRef = { type: 'group', id: 'shared' };
    const privatePolicy = policy('private', [
      { principal: sharedUser, effect: 'allow', scopes: ['collections:read'] },
      { principal: sharedPublic, effect: 'allow', scopes: ['nodes:read'] },
      { principal: sharedGroup, effect: 'allow', scopes: ['attachments:read'] },
    ]);

    const effective = evaluateAuthenticated([sharedPublic, sharedUser], privatePolicy);
    expect([...effective]).toEqual(['collections:read']);
  });

  it(`${evidence} keeps public and unlisted visibility independent from supplied public identities`, () => {
    for (const visibility of ['public', 'unlisted'] as const) {
      const layer = policy(visibility);
      const userOnly = evaluateAuthenticated([user], layer);
      const callerSuppliedPublic = evaluateAuthenticated(
        [canonicalPublic, user, noncanonicalPublic],
        layer,
      );

      expect([...callerSuppliedPublic], visibility).toEqual([...userOnly]);
      expect([...callerSuppliedPublic], visibility).toEqual([
        'collections:read',
        'nodes:read',
        'attachments:read',
      ]);
    }
  });

  it(`${evidence} prevents duplicate and subsequently mutated public input from injecting identity`, () => {
    const mutablePublic: PrincipalRef = { type: 'public', id: 'public' };
    const supplied: PrincipalRef[] = [
      mutablePublic,
      user,
      mutablePublic,
      { type: 'public', id: 'everyone' },
    ];
    const resolved = resolveRequestIdentities({ status: 'authenticated', identities: supplied });

    mutablePublic.type = 'group';
    mutablePublic.id = 'admins';
    supplied[1] = canonicalPublic;
    supplied.push({ type: 'group', id: 'late-injection' });

    expect(resolved).toEqual([user]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved.every(Object.isFrozen)).toBe(true);
  });

  it(`${evidence} prevents accessor, proxy, and dynamic public inputs from injecting identity`, () => {
    const typeGetter = vi.fn(() => 'public');
    const accessorPublic = Object.defineProperty({ id: 'public' }, 'type', { get: typeGetter });
    const hostilePublic = new Proxy(canonicalPublic, {
      getOwnPropertyDescriptor() {
        throw new Error('caller-controlled public descriptor');
      },
    });
    const dynamicTarget: PrincipalRef[] = [user, canonicalPublic];
    const dynamicPublic = new Proxy(dynamicTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') {
          target[1] = noncanonicalPublic;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(() =>
      resolveRequestIdentities({
        status: 'authenticated',
        identities: [user, accessorPublic] as unknown as readonly PrincipalRef[],
      }),
    ).toThrow();
    expect(typeGetter).not.toHaveBeenCalled();
    expect(() =>
      resolveRequestIdentities({ status: 'authenticated', identities: [user, hostilePublic] }),
    ).toThrow();
    expect(() =>
      resolveRequestIdentities({ status: 'authenticated', identities: dynamicPublic }),
    ).toThrow();
  });

  it(`${evidence} fails closed when an array Proxy turns a later public entry into an identity`, () => {
    for (const injectedType of ['group', 'service'] as const) {
      const target: PrincipalRef[] = [user, { type: 'public', id: 'public' }];
      const identities = new Proxy(target, {
        getOwnPropertyDescriptor(array, property) {
          if (property === '0') {
            array[1] = { type: injectedType, id: `${injectedType}-injected` };
          }
          return Reflect.getOwnPropertyDescriptor(array, property);
        },
      });

      expect(() =>
        resolveRequestIdentities({ status: 'authenticated', identities }),
      ).toThrow();
    }
  });

  it(`${evidence} fails closed when an identity Proxy changes between descriptor reads`, () => {
    const target: PrincipalRef = { type: 'public', id: 'public' };
    const identity = new Proxy(target, {
      getOwnPropertyDescriptor(principal, property) {
        if (property === 'type') {
          principal.type = 'group';
          principal.id = 'admins';
        }
        return Reflect.getOwnPropertyDescriptor(principal, property);
      },
    });

    expect(() =>
      resolveRequestIdentities({ status: 'authenticated', identities: [user, identity] }),
    ).toThrow();
  });
});
