import { describe, expect, it, vi } from 'vitest';

import { evaluateEffectiveScopes } from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const publisher: PrincipalRef = { type: 'service', id: 'publisher' };
const granted = new Set<ScopeName>(['nodes:read', 'nodes:write']);
type EntryScopes = AccessPolicy['entries'][number]['scopes'];
const allScopes: EntryScopes = ['nodes:read', 'nodes:write'];

function policy(entries: AccessPolicy['entries']): AccessPolicy {
  return {
    visibility: 'private',
    entries,
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-sec-0002',
  };
}

function allow(scopes: EntryScopes = allScopes): AccessPolicy {
  return policy([{ principal: publisher, effect: 'allow', scopes }]);
}

function deny(scope: ScopeName): AccessPolicy {
  return policy([
    { principal: publisher, effect: 'allow', scopes: allScopes },
    { principal: publisher, effect: 'deny', scopes: [scope] },
  ]);
}

function evaluate(policyChain: {
  readonly serverDefault: AccessPolicy;
  readonly collection: AccessPolicy;
  readonly ancestors: readonly AccessPolicy[];
  readonly object: AccessPolicy;
}): ReadonlySet<ScopeName> {
  return evaluateEffectiveScopes({ grantedScopes: granted, identities: [publisher], policyChain });
}

describe('[evidence:security.deny-precedence] SEC-0002 fixed policy chain', () => {
  it.each([
    ['allow before deny', ['allow', 'deny'] as const],
    ['deny before allow', ['deny', 'allow'] as const],
  ])('[evidence:security.deny-precedence] gives deny precedence with %s', (_label, effects) => {
    const contested = policy(
      effects.map((effect) => ({ principal: publisher, effect, scopes: ['nodes:write'] })),
    );

    expect([
      ...evaluate({
        serverDefault: allow(),
        collection: contested,
        ancestors: [allow()],
        object: allow(),
      }),
    ]).toEqual([]);
  });

  it('[evidence:security.deny-precedence] honors a deny at every required layer', () => {
    const layers = ['serverDefault', 'collection', 'ancestor', 'object'] as const;

    for (const layer of layers) {
      const restrictive = deny('nodes:write');
      const effective = evaluate({
        serverDefault: layer === 'serverDefault' ? restrictive : allow(),
        collection: layer === 'collection' ? restrictive : allow(),
        ancestors: [layer === 'ancestor' ? restrictive : allow()],
        object: layer === 'object' ? restrictive : allow(),
      });

      expect([...effective], `deny at ${layer}`).toEqual(['nodes:read']);
    }
  });

  it('[evidence:security.deny-precedence] intersects all ancestors in supplied order', () => {
    const effective = evaluate({
      serverDefault: allow(),
      collection: allow(),
      ancestors: [deny('nodes:write'), deny('nodes:read'), allow()],
      object: allow(),
    });

    expect([...effective]).toEqual([]);
  });

  it('[evidence:security.deny-precedence] evaluates server, collection, every ancestor, then object', () => {
    const effective = evaluate({
      serverDefault: allow(),
      collection: deny('nodes:write'),
      ancestors: [allow(['nodes:read']), deny('nodes:read')],
      object: allow(),
    });

    expect([...effective]).toEqual([]);
    expect([
      ...evaluate({
        serverDefault: allow(),
        collection: allow(),
        ancestors: [allow(), allow()],
        object: allow(),
      }),
    ]).toEqual(['nodes:read', 'nodes:write']);
  });

  it('[evidence:security.deny-precedence] does not short-circuit later policies after access is empty', () => {
    const entriesGetter = vi.fn(() => {
      throw new Error('hostile object entries accessor');
    });
    const hostileObject = allow();
    Object.defineProperty(hostileObject, 'entries', {
      configurable: true,
      get: entriesGetter,
    });

    const effective = evaluate({
      serverDefault: policy([]),
      collection: allow(),
      ancestors: [allow(), allow()],
      object: hostileObject,
    });

    expect([...effective]).toEqual([]);
    expect(entriesGetter).not.toHaveBeenCalled();
  });

  it('[evidence:security.deny-precedence] ignores forged inherit and skip bypass hints', () => {
    const forgedDeny = {
      ...deny('nodes:write'),
      inherit: false,
      skip: true,
      inheritance: 'replace',
    } as AccessPolicy & { inherit: boolean; skip: boolean; inheritance: string };

    const effective = evaluate({
      serverDefault: allow(),
      collection: forgedDeny,
      ancestors: [allow()],
      object: allow(),
    });

    expect([...effective]).toEqual(['nodes:read']);
  });

  it('[evidence:security.deny-precedence] fails closed when a required policy layer is missing', () => {
    // Baseline: complete chain with the same credentials grants scopes.
    expect([
      ...evaluate({
        serverDefault: allow(),
        collection: allow(),
        ancestors: [allow()],
        object: allow(),
      }),
    ]).toEqual(['nodes:read', 'nodes:write']);

    const missingCollection = {
      serverDefault: allow(),
      ancestors: [allow()],
      object: allow(),
    } as unknown as Parameters<typeof evaluate>[0];

    const result = evaluate(missingCollection);
    expect(result.size).toBe(0);
    expect(result.has('nodes:read')).toBe(false);
    expect(result.has('nodes:write')).toBe(false);
  });

  it('[evidence:security.deny-precedence] prevents descendants from restoring an ancestor denial', () => {
    const restoringObject = policy([
      { principal: publisher, effect: 'allow', scopes: allScopes },
      { principal: publisher, effect: 'allow', scopes: ['nodes:write'] },
    ]);

    const effective = evaluate({
      serverDefault: allow(),
      collection: allow(),
      ancestors: [deny('nodes:write')],
      object: restoringObject,
    });

    expect([...effective]).toEqual(['nodes:read']);
  });

  it('[evidence:security.deny-precedence] rejects sparse ancestor chains', () => {
    // Baseline: dense ancestors grant under the same credentials.
    expect([
      ...evaluate({
        serverDefault: allow(),
        collection: allow(),
        ancestors: [allow()],
        object: allow(),
      }),
    ]).toEqual(['nodes:read', 'nodes:write']);

    const ancestors = new Array<AccessPolicy>(1);
    const result = evaluate({
      serverDefault: allow(),
      collection: allow(),
      ancestors,
      object: allow(),
    });
    expect(result.size).toBe(0);
    expect(result.has('nodes:read')).toBe(false);
    expect(result.has('nodes:write')).toBe(false);
  });

  it('[evidence:security.deny-precedence] fails closed on policy getter failures and keeps evaluating', () => {
    const visibilityGetter = vi.fn(() => {
      throw new Error('unreadable policy');
    });
    const throwingPolicy = {
      get visibility() {
        return visibilityGetter();
      },
      entries: allow().entries,
    } as unknown as AccessPolicy;

    const effective = evaluate({
      serverDefault: throwingPolicy,
      collection: allow(),
      ancestors: [],
      object: allow(),
    });

    expect([...effective]).toEqual([]);
    expect(visibilityGetter).not.toHaveBeenCalled();
  });

  it('[evidence:security.deny-precedence] snapshots entry length so mutation cannot skip a deny', () => {
    const lengthTrap = vi.fn((target: AccessPolicy['entries']) => target.length);
    const entries = new Proxy(
      [
        { principal: publisher, effect: 'allow' as const, scopes: allScopes },
        { principal: publisher, effect: 'deny' as const, scopes: ['nodes:write'] as EntryScopes },
      ],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            return lengthTrap(target);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const contested = policy(entries);

    const effective = evaluate({
      serverDefault: allow(),
      collection: contested,
      ancestors: [],
      object: allow(),
    });

    expect([...effective]).toEqual([]);
    expect(lengthTrap).not.toHaveBeenCalled();
  });

  it('[evidence:security.deny-precedence] fails closed when entry length initially hides a deny', () => {
    const lengthTrap = vi.fn(() => 1);
    const entries = new Proxy(
      [
        { principal: publisher, effect: 'allow' as const, scopes: allScopes },
        { principal: publisher, effect: 'deny' as const, scopes: ['nodes:write'] as EntryScopes },
      ],
      {
        get(target, property, receiver) {
          return property === 'length' ? lengthTrap() : Reflect.get(target, property, receiver);
        },
      },
    );

    const effective = evaluate({
      serverDefault: allow(),
      collection: policy(entries),
      ancestors: [],
      object: allow(),
    });

    expect([...effective]).toEqual([]);
    expect(lengthTrap).not.toHaveBeenCalled();
  });

  it('[evidence:security.deny-precedence] snapshots the complete chain before policy getters run', () => {
    // Baseline: own-data chain with the same layers grants nodes:read (write denied).
    expect([
      ...evaluate({
        serverDefault: allow(),
        collection: deny('nodes:write'),
        ancestors: [],
        object: allow(),
      }),
    ]).toEqual(['nodes:read']);

    const visibilityGetter = vi.fn(() => 'private' as const);
    const objectGetter = vi.fn(() => allow());
    const mutatingServer = {
      ...allow(),
      get visibility() {
        return visibilityGetter();
      },
    };
    const policyChain = {
      serverDefault: mutatingServer,
      collection: deny('nodes:write'),
      ancestors: [],
      get object() {
        return objectGetter();
      },
    };

    const result = evaluate(policyChain);
    expect(result.size).toBe(0);
    expect(result.has('nodes:read')).toBe(false);
    expect(result.has('nodes:write')).toBe(false);
    expect(objectGetter).not.toHaveBeenCalled();
    expect(visibilityGetter).not.toHaveBeenCalled();
  });
});
