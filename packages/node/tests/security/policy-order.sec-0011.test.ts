import { describe, expect, it, vi } from 'vitest';

import { evaluateEffectiveScopes } from '../../src/security/index.js';
import type { EffectivePolicyChain } from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const evidence = '[evidence:security.policy-chain-order]';
const publisher: PrincipalRef = { type: 'service', id: 'publisher' };
const otherPublisher: PrincipalRef = { type: 'service', id: 'other-publisher' };
const credentialScopes = new Set<ScopeName>(['nodes:read', 'nodes:write']);
type EntryScopes = AccessPolicy['entries'][number]['scopes'];

function policy(
  scopes: EntryScopes = ['nodes:read', 'nodes:write'],
  effect: 'allow' | 'deny' = 'allow',
  principal: PrincipalRef = publisher,
): AccessPolicy {
  return {
    visibility: 'private',
    entries: [{ principal, effect, scopes }],
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-sec-0011',
  };
}

function evaluate(
  policyChain: EffectivePolicyChain,
  grantedScopes: ReadonlySet<ScopeName> = credentialScopes,
): ReadonlySet<ScopeName> {
  return evaluateEffectiveScopes({
    grantedScopes,
    identities: [publisher],
    policyChain,
  });
}

describe(`${evidence} SEC-0011 fixed publisher policy order`, () => {
  it(`${evidence} starts with the credential grant and applies server, collection, then object with no ancestors`, () => {
    const effective = evaluate(
      {
        serverDefault: policy(['nodes:read', 'nodes:write']),
        collection: policy(['nodes:read', 'nodes:write']),
        ancestors: [],
        object: policy(['nodes:read']),
      },
      new Set<ScopeName>(['nodes:read', 'nodes:write']),
    );

    expect([...effective]).toEqual(['nodes:read']);
  });

  it(`${evidence} applies one ancestor between collection and object`, () => {
    const effective = evaluate({
      serverDefault: policy(['nodes:read', 'nodes:write']),
      collection: policy(['nodes:read', 'nodes:write']),
      ancestors: [policy(['nodes:read'])],
      object: policy(['nodes:read', 'nodes:write']),
    });

    expect([...effective]).toEqual(['nodes:read']);
  });

  it(`${evidence} applies every supplied ancestor before object`, () => {
    const effective = evaluate(
      {
        serverDefault: policy(['collections:read', 'nodes:read', 'nodes:write']),
        collection: policy(['collections:read', 'nodes:read', 'nodes:write']),
        ancestors: [
          policy(['nodes:read', 'nodes:write']),
          policy(['collections:read', 'nodes:read']),
          policy(['collections:read', 'nodes:read', 'nodes:write']),
        ],
        object: policy(['collections:read', 'nodes:read', 'nodes:write']),
      },
      new Set<ScopeName>(['collections:read', 'nodes:read', 'nodes:write']),
    );

    expect([...effective]).toEqual(['nodes:read']);

    const repeatedAncestor = policy(['nodes:read']);
    const largeAncestors = Array.from({ length: 100_000 }, () => repeatedAncestor);
    expect([
      ...evaluate(
        {
          serverDefault: repeatedAncestor,
          collection: repeatedAncestor,
          ancestors: largeAncestors,
          object: repeatedAncestor,
        },
        new Set<ScopeName>(['nodes:read']),
      ),
    ]).toEqual(['nodes:read']);
  });

  it(`${evidence} does not omit later layers after an early policy makes access empty`, () => {
    const emptyServer = policy(['nodes:read'], 'allow', otherPublisher);
    const effective = evaluate({
      serverDefault: emptyServer,
      collection: policy(['nodes:read', 'nodes:write']),
      ancestors: [policy(['nodes:read', 'nodes:write']), policy(['nodes:read', 'nodes:write'])],
      object: policy(['nodes:read', 'nodes:write']),
    });
    // Baseline: open layers with the same credentials grant scopes, so missing object is deny-all.
    const openBaseline = {
      serverDefault: policy(['nodes:read', 'nodes:write']),
      collection: policy(),
      ancestors: [policy()],
      object: policy(),
    };
    expect([...evaluate(openBaseline)]).toEqual(['nodes:read', 'nodes:write']);

    const missingObject = {
      serverDefault: emptyServer,
      collection: policy(),
      ancestors: [policy()],
    };
    const missingObjectResult = evaluate(missingObject as unknown as EffectivePolicyChain);

    expect([...effective]).toEqual([]);
    expect(missingObjectResult.size).toBe(0);
    expect(missingObjectResult.has('nodes:read')).toBe(false);
    expect(missingObjectResult.has('nodes:write')).toBe(false);
  });

  it(`${evidence} does not omit later layers after an early matching deny`, () => {
    const serverDeny: AccessPolicy = {
      ...policy(),
      entries: [
        { principal: publisher, effect: 'allow', scopes: ['nodes:read', 'nodes:write'] },
        { principal: publisher, effect: 'deny', scopes: ['nodes:write'] },
      ],
    };

    const effective = evaluate({
      serverDefault: serverDeny,
      collection: policy(['nodes:read', 'nodes:write']),
      ancestors: [policy(['nodes:read', 'nodes:write'])],
      object: policy(['nodes:read', 'nodes:write']),
    });
    const objectGetter = vi.fn(() => {
      throw new Error('object accessor must not execute');
    });
    // Baseline: open own-data object grants under the same credentials (minus deny write).
    const openObject = {
      serverDefault: serverDeny,
      collection: policy(),
      ancestors: [policy()],
      object: policy(),
    };
    expect([...evaluate(openObject)]).toEqual(['nodes:read']);

    const dynamicObject = {
      serverDefault: serverDeny,
      collection: policy(),
      ancestors: [policy()],
      object: policy(),
    };
    Object.defineProperty(dynamicObject, 'object', { configurable: true, get: objectGetter });
    const dynamicResult = evaluate(dynamicObject);

    expect([...effective]).toEqual(['nodes:read']);
    expect(dynamicResult.size).toBe(0);
    expect(dynamicResult.has('nodes:read')).toBe(false);
    expect(dynamicResult.has('nodes:write')).toBe(false);
    expect(objectGetter).not.toHaveBeenCalled();
  });

  it(`${evidence} fails closed on later hostile policies without invoking dynamic accessors`, () => {
    const policyAccessor = policy();
    const entriesGetter = vi.fn(() => {
      throw new Error('hostile entries accessor');
    });
    Object.defineProperty(policyAccessor, 'entries', { configurable: true, get: entriesGetter });
    const scopeAccessor = policy().entries[0]!;
    const scopesGetter = vi.fn(() => {
      throw new Error('hostile scopes accessor');
    });
    Object.defineProperty(scopeAccessor, 'scopes', { configurable: true, get: scopesGetter });
    const entryAccessor = { ...policy(), entries: [scopeAccessor] };
    const proxyTrap = vi.fn(() => {
      throw new Error('hostile Proxy trap');
    });
    const proxyHandler: ProxyHandler<object> = {
      get: proxyTrap,
      getOwnPropertyDescriptor: proxyTrap,
      getPrototypeOf: proxyTrap,
      ownKeys: proxyTrap,
    };
    const policyProxy = new Proxy(policy(), proxyHandler as ProxyHandler<AccessPolicy>);
    const entryProxy = new Proxy(
      policy().entries[0]!,
      proxyHandler as ProxyHandler<AccessPolicy['entries'][number]>,
    );
    const principalProxy = new Proxy(
      publisher,
      proxyHandler as ProxyHandler<PrincipalRef>,
    );
    const entriesProxy = new Proxy(
      policy().entries,
      proxyHandler as ProxyHandler<AccessPolicy['entries']>,
    );
    const scopesProxy = new Proxy(
      policy().entries[0]!.scopes,
      proxyHandler as ProxyHandler<EntryScopes>,
    );
    const sparseEntries = new Array<AccessPolicy['entries'][number]>(1);
    const sparseScopes = new Array<ScopeName>(1) as unknown as EntryScopes;
    const hostilePolicies: AccessPolicy[] = [
      policyAccessor,
      entryAccessor,
      policyProxy,
      { ...policy(), entries: [entryProxy] },
      {
        ...policy(),
        entries: [{ principal: principalProxy, effect: 'allow', scopes: ['nodes:read'] }],
      },
      { ...policy(), entries: entriesProxy },
      {
        ...policy(),
        entries: [{ principal: publisher, effect: 'allow', scopes: scopesProxy }],
      },
      { ...policy(), entries: sparseEntries },
      {
        ...policy(),
        entries: [{ principal: publisher, effect: 'allow', scopes: sparseScopes }],
      },
    ];
    const broad = policy(['nodes:read', 'nodes:write']);

    for (const hostile of hostilePolicies) {
      const afterOpen = evaluate({
        serverDefault: broad,
        collection: broad,
        ancestors: [hostile],
        object: broad,
      });
      const afterEmpty = evaluate({
        serverDefault: policy(['nodes:read'], 'allow', otherPublisher),
        collection: broad,
        ancestors: [hostile],
        object: broad,
      });

      expect([...afterOpen]).toEqual([]);
      expect([...afterEmpty]).toEqual([]);
    }
    expect(entriesGetter).not.toHaveBeenCalled();
    expect(scopesGetter).not.toHaveBeenCalled();
    expect(proxyTrap).not.toHaveBeenCalled();
  });

  it(`${evidence} keeps credential scope as the upper bound when every lower layer grants more`, () => {
    const broad = policy(['collections:read', 'nodes:read', 'nodes:write']);
    const effective = evaluate(
      {
        serverDefault: broad,
        collection: broad,
        ancestors: [broad, broad],
        object: broad,
      },
      new Set<ScopeName>(['nodes:read']),
    );

    expect([...effective]).toEqual(['nodes:read']);
    expect(effective.has('nodes:write')).toBe(false);
    expect(effective.has('collections:read')).toBe(false);
  });

  it(`${evidence} rejects omission of each required own server, collection, ancestors, or object layer`, () => {
    const complete = {
      serverDefault: policy(),
      collection: policy(),
      ancestors: [policy()],
      object: policy(),
    };

    // Baseline: the same own-data `complete` chain grants under these credentials,
    // so empty results below are deny-all rather than a no-op false positive.
    expect([...evaluate(complete)]).toEqual(['nodes:read', 'nodes:write']);

    // Missing own required layers on an otherwise plain chain: fail closed deny-all, no throw.
    for (const key of ['serverDefault', 'collection', 'ancestors', 'object'] as const) {
      const incomplete = { ...complete } as Record<string, unknown>;
      delete incomplete[key];
      const incompleteResult = evaluate(incomplete as unknown as EffectivePolicyChain);
      expect(incompleteResult.size, `missing ${key}`).toBe(0);
      expect(incompleteResult.has('nodes:read'), `missing ${key} nodes:read`).toBe(false);
      expect(incompleteResult.has('nodes:write'), `missing ${key} nodes:write`).toBe(false);
    }

    // Inherited-only layer values (prototype chain, no own layer fields) are an
    // unusable policyChain container: fail closed to empty scopes, do not throw.
    const inheritedOnly = evaluate(Object.create(complete) as EffectivePolicyChain);
    expect(inheritedOnly.size).toBe(0);
    expect(inheritedOnly.has('nodes:read')).toBe(false);
    expect(inheritedOnly.has('nodes:write')).toBe(false);

    // Hostile policy *layer* (not the chain container) still fails closed empty.
    expect([
      ...evaluate({
        ...complete,
        collection: Object.create(policy()) as AccessPolicy,
      }),
    ]).toEqual([]);
  });

  it(`${evidence} rejects sparse ancestors and arrays whose reported length hides an index`, () => {
    const openAncestors = [policy(), policy()];
    // Baseline: dense own-data ancestors grant under these credentials.
    expect([
      ...evaluate({
        serverDefault: policy(),
        collection: policy(),
        ancestors: openAncestors,
        object: policy(),
      }),
    ]).toEqual(['nodes:read', 'nodes:write']);

    const sparse = new Array<AccessPolicy>(2);
    sparse[0] = policy();
    const spoofedLength = new Proxy([policy(), policy()], {
      get(target, property, receiver) {
        return property === 'length' ? 1 : Reflect.get(target, property, receiver);
      },
    });

    for (const ancestors of [sparse, spoofedLength]) {
      const result = evaluate({
        serverDefault: policy(),
        collection: policy(),
        ancestors,
        object: policy(),
      });
      expect(result.size).toBe(0);
      expect(result.has('nodes:read')).toBe(false);
      expect(result.has('nodes:write')).toBe(false);
    }
  });

  it(`${evidence} rejects accessor-backed and Proxy ancestor arrays without trusting dynamic values`, () => {
    // Baseline: dense ordinary ancestors grant under these credentials.
    expect([
      ...evaluate({
        serverDefault: policy(),
        collection: policy(),
        ancestors: [policy()],
        object: policy(),
      }),
    ]).toEqual(['nodes:read', 'nodes:write']);

    const accessor = [policy()];
    const ancestorGetter = vi.fn(() => policy());
    Object.defineProperty(accessor, '0', { enumerable: true, configurable: true, get: ancestorGetter });
    const proxied = new Proxy([policy()], {});
    const customPrototype = [policy()];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));

    for (const ancestors of [accessor, proxied, customPrototype]) {
      const result = evaluate({
        serverDefault: policy(),
        collection: policy(),
        ancestors,
        object: policy(),
      });
      expect(result.size).toBe(0);
      expect(result.has('nodes:read')).toBe(false);
      expect(result.has('nodes:write')).toBe(false);
    }
    expect(ancestorGetter).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects accessors for every policy-chain field without invoking them`, () => {
    // Baseline: open own-data chain grants under these credentials.
    const openChain = {
      serverDefault: policy(),
      collection: policy(),
      ancestors: [policy()],
      object: policy(),
    };
    expect([...evaluate(openChain)]).toEqual(['nodes:read', 'nodes:write']);

    for (const key of ['serverDefault', 'collection', 'ancestors', 'object'] as const) {
      const chain = {
        serverDefault: policy(),
        collection: policy(),
        ancestors: [policy()],
        object: policy(),
      };
      const originalValue = chain[key];
      const getter = vi.fn(() => originalValue);
      Object.defineProperty(chain, key, { enumerable: true, configurable: true, get: getter });

      const result = evaluate(chain);
      expect(result.size, `${key} accessor`).toBe(0);
      expect(result.has('nodes:read'), `${key} nodes:read`).toBe(false);
      expect(result.has('nodes:write'), `${key} nodes:write`).toBe(false);
      expect(getter, `${key} accessor`).not.toHaveBeenCalled();
    }
  });

  it(`${evidence} fails closed on a Proxy policyChain without running traps or accepting trap-selected layers`, () => {
    let collectionReads = 0;
    const openTarget = {
      serverDefault: policy(),
      collection: policy(),
      ancestors: [policy()],
      object: policy(),
    };
    // Baseline: the same own-data chain grants under these credentials, so an empty
    // result from the Proxy container is deny-all rather than a no-op false positive.
    expect([...evaluate(openTarget)]).toEqual(['nodes:read', 'nodes:write']);

    const chain = new Proxy(openTarget, {
      get(target, property, receiver) {
        if (property === 'collection') {
          collectionReads += 1;
          return collectionReads === 1
            ? target.collection
            : policy(['nodes:read'], 'allow', otherPublisher);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    // Unusable policyChain container: empty scope set (deny-all), no throw, traps idle.
    const effective = evaluate(chain);
    expect(effective.size).toBe(0);
    expect(effective.has('nodes:read')).toBe(false);
    expect(effective.has('nodes:write')).toBe(false);
    expect(collectionReads).toBe(0);
  });

  it(`${evidence} ignores forged inherit, skip, reorder, short-circuit, and bypass controls`, () => {
    const forged = (scopes: EntryScopes): AccessPolicy =>
      Object.assign(policy(scopes), {
        inherit: false,
        skip: true,
        reorder: ['object', 'serverDefault'],
        shortCircuit: true,
        bypass: true,
      });

    const effective = evaluate({
      serverDefault: forged(['nodes:read', 'nodes:write']),
      collection: forged(['nodes:read', 'nodes:write']),
      ancestors: [forged(['nodes:read']), forged(['nodes:read', 'nodes:write'])],
      object: forged(['nodes:read', 'nodes:write']),
    });

    expect([...effective]).toEqual(['nodes:read']);

    const visibilityDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'visibility');
    const entriesDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'entries');
    try {
      Object.defineProperty(Object.prototype, 'visibility', {
        configurable: true,
        writable: true,
        value: 'private',
      });
      Object.defineProperty(Object.prototype, 'entries', {
        configurable: true,
        writable: true,
        value: policy().entries,
      });
      expect([
        ...evaluate({
          serverDefault: policy(),
          collection: {} as AccessPolicy,
          ancestors: [policy()],
          object: policy(),
        }),
      ]).toEqual([]);
    } finally {
      if (visibilityDescriptor === undefined) Reflect.deleteProperty(Object.prototype, 'visibility');
      else Object.defineProperty(Object.prototype, 'visibility', visibilityDescriptor);
      if (entriesDescriptor === undefined) Reflect.deleteProperty(Object.prototype, 'entries');
      else Object.defineProperty(Object.prototype, 'entries', entriesDescriptor);
    }
  });

  it(`${evidence} keeps the chain result fixed across policy entry order and deny precedence`, () => {
    const orders = [
      ['allow', 'deny'],
      ['deny', 'allow'],
    ] as const;

    for (const order of orders) {
      const entries: AccessPolicy['entries'] = order.map((effect) => ({
        principal: publisher,
        effect,
        scopes: ['nodes:write'],
      }));
      const effective = evaluate({
        serverDefault: policy(),
        collection: { ...policy(), entries },
        ancestors: [policy()],
        object: policy(),
      });

      expect([...effective]).toEqual([]);
    }
  });

  it(`${evidence} keeps an evaluated result stable after credential, identity, and chain replacement`, () => {
    const grantedScopes = new Set<ScopeName>(['nodes:read']);
    const identities = [publisher];
    const replacementCollection = policy(['nodes:read'], 'allow', otherPublisher);
    const replacementChain: EffectivePolicyChain = {
      serverDefault: replacementCollection,
      collection: replacementCollection,
      ancestors: [],
      object: replacementCollection,
    };
    const input: {
      grantedScopes: Set<ScopeName>;
      identities: PrincipalRef[];
      policyChain: EffectivePolicyChain;
    } = {
      grantedScopes,
      identities,
      policyChain: {
        serverDefault: policy(['nodes:read']),
        collection: policy(['nodes:read']),
        ancestors: [],
        object: policy(['nodes:read']),
      },
    };
    const effective = evaluateEffectiveScopes(input);

    grantedScopes.clear();
    identities[0] = otherPublisher;
    input.policyChain = replacementChain;

    expect([...effective]).toEqual(['nodes:read']);
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Reflect.set(effective as object, 'size', 0)).toBe(false);
    expect(() => (effective as Set<ScopeName>).add('nodes:write')).toThrow(TypeError);
  });

  it(`${evidence} keeps the prior snapshot after ancestor and object references are replaced`, () => {
    const ancestors = [policy(['nodes:read']), policy(['nodes:read'])];
    const chain = {
      serverDefault: policy(['nodes:read']),
      collection: policy(['nodes:read']),
      ancestors,
      object: policy(['nodes:read']),
    };
    const effective = evaluate(chain, new Set<ScopeName>(['nodes:read']));

    ancestors[0] = policy(['nodes:read'], 'allow', otherPublisher);
    ancestors.push(policy(['nodes:read'], 'allow', otherPublisher));
    chain.object = policy(['nodes:read'], 'allow', otherPublisher);

    expect([...effective]).toEqual(['nodes:read']);
    expect([...evaluate(chain, new Set<ScopeName>(['nodes:read']))]).toEqual([]);
  });
});
