import { describe, expect, it, vi } from 'vitest';

import {
  evaluateEffectiveScopes,
  resolveRequestIdentities,
} from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const evidence = '[evidence:security.anonymous-public-principal]';
const publicPrincipal: PrincipalRef = { type: 'public', id: 'public' };
const user: PrincipalRef = { type: 'user', id: 'alice' };
const readScopes = new Set<ScopeName>(['collections:read', 'nodes:read']);

function policy(
  visibility: AccessPolicy['visibility'],
  entries: AccessPolicy['entries'] = [],
): AccessPolicy {
  return {
    visibility,
    entries,
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-sec-0005',
  };
}

function chain(layer: AccessPolicy) {
  return { serverDefault: layer, collection: layer, ancestors: [], object: layer };
}

function anonymous(): readonly PrincipalRef[] {
  return resolveRequestIdentities({ credentialEstablished: false, identities: [] });
}

function authenticated(identities: readonly PrincipalRef[]): readonly PrincipalRef[] {
  return resolveRequestIdentities({ credentialEstablished: true, identities });
}

describe(`${evidence} SEC-0005 synthetic public principal`, () => {
  it(`${evidence} creates exactly one frozen public identity for an explicit anonymous request`, () => {
    const identities = anonymous();
    const nextResolution = resolveRequestIdentities({ status: 'anonymous', identities: [] });

    expect(identities).toEqual([publicPrincipal]);
    expect(identities).toHaveLength(1);
    expect(Object.isFrozen(identities)).toBe(true);
    expect(Object.isFrozen(identities[0])).toBe(true);
    expect(nextResolution).toBe(identities);
    expect(nextResolution[0]).toBe(identities[0]);
  });

  it(`${evidence} requires exactly one consistent credential-state discriminator`, () => {
    const both = {
      status: 'anonymous',
      credentialEstablished: false,
      identities: [],
    } as unknown as Parameters<typeof resolveRequestIdentities>[0];
    const neither = { identities: [] } as unknown as Parameters<typeof resolveRequestIdentities>[0];

    expect(() => resolveRequestIdentities(both)).toThrow();
    expect(() => resolveRequestIdentities(neither)).toThrow();
    expect(resolveRequestIdentities({ status: 'authenticated', identities: [user] })).toEqual([user]);
  });

  it(`${evidence} never adds public to any authenticated principal type`, () => {
    const authenticatedTypes = [
      'user',
      'group',
      'oauth_client',
      'api_key',
      'service',
      'ai_agent',
    ] as const;

    for (const type of authenticatedTypes) {
      const identity: PrincipalRef = { type, id: `${type}-1` };
      expect(authenticated([identity])).toEqual([identity]);
      expect(authenticated([identity])).not.toContainEqual(publicPrincipal);
    }

    expect(() => authenticated([{ type: 'public', id: 'everyone' }])).toThrow();
    expect(authenticated([user, { type: 'public', id: 'everyone' }])).toEqual([user]);
  });

  it(`${evidence} preserves the type, id, and order of multiple authenticated identities`, () => {
    const identities: readonly PrincipalRef[] = [
      { type: 'user', id: 'shared' },
      { type: 'group', id: 'editors' },
      { type: 'service', id: 'publisher' },
    ];

    expect(authenticated(identities)).toEqual(identities);
  });

  it(`${evidence} fails closed when a credential is established without any identity`, () => {
    expect(() => authenticated([])).toThrow();

    const effective = evaluateEffectiveScopes({
      grantedScopes: readScopes,
      identityResolution: { status: 'authenticated', identities: [] },
      policyChain: chain(policy('public')),
    });
    expect([...effective]).toEqual([]);
  });

  it(`${evidence} fails closed when an anonymous request contains a non-public identity`, () => {
    const contradictory = {
      credentialEstablished: false,
      identities: [user],
    } as const;

    expect(() => resolveRequestIdentities(contradictory)).toThrow();
  });

  it(`${evidence} removes duplicate authenticated identities without conflating type and id`, () => {
    const identities = authenticated([
      { type: 'user', id: 'shared' },
      { type: 'user', id: 'shared' },
      { type: 'group', id: 'shared' },
    ]);

    expect(identities).toEqual([
      { type: 'user', id: 'shared' },
      { type: 'group', id: 'shared' },
    ]);
  });

  it(`${evidence} rejects malformed identity values`, () => {
    const malformed: readonly unknown[] = [
      null,
      'alice',
      {},
      { type: 'user' },
      { type: 'user', id: '' },
      { type: 'unknown', id: 'alice' },
      { type: 'user', id: 42 },
    ];

    for (const identity of malformed) {
      expect(() =>
        resolveRequestIdentities({
          credentialEstablished: true,
          identities: [identity] as unknown as readonly PrincipalRef[],
        }),
      ).toThrow();
    }
  });

  it(`${evidence} rejects accessor, proxy, and sparse identity inputs without invoking accessors`, () => {
    const idGetter = vi.fn(() => 'alice');
    const accessorIdentity = Object.defineProperty({ type: 'user' }, 'id', { get: idGetter });
    const hostileProxy = new Proxy(user, {
      getOwnPropertyDescriptor() {
        throw new Error('identity descriptor trap');
      },
    });
    const sparse = new Array<PrincipalRef>(1);
    const dynamicTarget: PrincipalRef[] = [user, { type: 'group', id: 'editors' }];
    const dynamic = new Proxy(dynamicTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') {
          delete target[1];
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(() =>
      resolveRequestIdentities({
        credentialEstablished: true,
        identities: [accessorIdentity] as unknown as readonly PrincipalRef[],
      }),
    ).toThrow();
    expect(idGetter).not.toHaveBeenCalled();
    expect(() => authenticated([hostileProxy])).toThrow();
    expect(() => authenticated(sparse)).toThrow();
    expect(() => authenticated(dynamic)).toThrow();
  });

  it(`${evidence} lets a public ACL match only anonymous evaluation`, () => {
    const protectedPolicy = policy('protected', [
      { principal: publicPrincipal, effect: 'allow', scopes: ['nodes:read'] },
      { principal: user, effect: 'allow', scopes: ['collections:read'] },
    ]);
    const anonymous = evaluateEffectiveScopes({
      grantedScopes: readScopes,
      identityResolution: { credentialEstablished: false, identities: [] },
      policyChain: chain(protectedPolicy),
    });
    const authenticated = evaluateEffectiveScopes({
      grantedScopes: readScopes,
      identityResolution: { credentialEstablished: true, identities: [user, publicPrincipal] },
      policyChain: chain(protectedPolicy),
    });

    expect([...anonymous]).toEqual(['nodes:read']);
    expect([...authenticated]).toEqual(['collections:read']);
  });

  it(`${evidence} does not let legacy callers manufacture anonymous state with public`, () => {
    const protectedPolicy = policy('protected', [
      { principal: publicPrincipal, effect: 'allow', scopes: ['nodes:read'] },
    ]);

    const emptyLegacy = evaluateEffectiveScopes({
      grantedScopes: readScopes,
      identities: [],
      policyChain: chain(protectedPolicy),
    });
    const suppliedPublic = evaluateEffectiveScopes({
      grantedScopes: readScopes,
      identities: [publicPrincipal],
      policyChain: chain(protectedPolicy),
    });

    expect([...emptyLegacy]).toEqual(['nodes:read']);
    expect([...suppliedPublic]).toEqual([]);
  });

  it(`${evidence} keeps public and unlisted visibility independently readable to authenticated callers`, () => {
    for (const visibility of ['public', 'unlisted'] as const) {
      const visiblePolicy = policy(visibility);
      const effective = evaluateEffectiveScopes({
        grantedScopes: readScopes,
        identityResolution: { credentialEstablished: true, identities: [user] },
        policyChain: chain(visiblePolicy),
      });

      expect([...effective], visibility).toEqual(['collections:read', 'nodes:read']);
    }
  });

  it(`${evidence} returns immutable identities and keeps equal ids isolated by principal type`, () => {
    const identities = authenticated([
      { type: 'user', id: 'shared' },
      { type: 'group', id: 'shared' },
    ]);
    const groupOnly = policy('private', [
      { principal: { type: 'group', id: 'shared' }, effect: 'allow', scopes: ['nodes:read'] },
    ]);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identityResolution: { credentialEstablished: true, identities: [identities[0]!] },
      policyChain: chain(groupOnly),
    });

    expect(Object.isFrozen(identities)).toBe(true);
    expect(identities.every(Object.isFrozen)).toBe(true);
    expect([...effective]).toEqual([]);
  });

  it(`${evidence} snapshots identity input and returns a genuinely immutable scope view`, () => {
    const mutableIdentity: PrincipalRef = { type: 'user', id: 'alice' };
    const supplied = [mutableIdentity];
    const identities = authenticated(supplied);
    supplied[0] = { type: 'group', id: 'editors' };
    (mutableIdentity as { id: string }).id = 'mallory';

    expect(identities).toEqual([user]);

    const visiblePolicy = policy('public');
    const effective = evaluateEffectiveScopes({
      grantedScopes: readScopes,
      identityResolution: { status: 'authenticated', identities },
      policyChain: chain(visiblePolicy),
    });
    const mutableView = effective as Set<ScopeName>;

    expect(Object.isFrozen(effective)).toBe(true);
    expect(() => mutableView.add('nodes:write')).toThrow();
    expect([...effective]).toEqual(['collections:read', 'nodes:read']);
  });

  it(`${evidence} snapshots granted scopes without invoking subclass iteration hooks`, () => {
    class HostileScopeSet extends Set<ScopeName> {
      override [Symbol.iterator](): SetIterator<ScopeName> {
        throw new Error('caller-controlled iterator must not run');
      }
    }
    const grantedScopes = new HostileScopeSet(['collections:read', 'nodes:read']);
    const effective = evaluateEffectiveScopes({
      grantedScopes,
      identityResolution: { status: 'authenticated', identities: [user] },
      policyChain: chain(policy('public')),
    });
    grantedScopes.clear();
    grantedScopes.add('nodes:write');

    expect([...effective]).toEqual(['collections:read', 'nodes:read']);
  });
});
