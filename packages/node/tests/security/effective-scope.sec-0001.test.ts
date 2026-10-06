import { describe, expect, it } from 'vitest';

import { evaluateEffectiveScopes } from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const publisher: PrincipalRef = { type: 'service', id: 'publisher' };

function policy(
  scopes: AccessPolicy['entries'][number]['scopes'],
  visibility: AccessPolicy['visibility'] = 'private',
  principal: PrincipalRef = publisher,
): AccessPolicy {
  return {
    visibility,
    entries: [{ principal, effect: 'allow', scopes }],
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-1',
  };
}

function publicPolicy(): AccessPolicy {
  return {
    visibility: 'public',
    entries: [],
    publication: { listInDirectory: true, allowSearchIndexing: true, allowEmbedding: true },
    revision: 'acl-public-1',
  };
}

describe('[evidence:security.effective-scope] SEC-0001 effective publisher scope', () => {
  it('[evidence:security.effective-scope] intersects the credential and every policy layer', () => {
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>([
        'collections:read',
        'nodes:read',
        'nodes:write',
        'annotations:read',
      ]),
      identities: [publisher],
      policyChain: {
        serverDefault: policy(['collections:read', 'nodes:read', 'nodes:write', 'annotations:read']),
        collection: policy(['nodes:read', 'nodes:write', 'annotations:read']),
        ancestors: [
          policy(['nodes:read', 'nodes:write']),
          policy(['nodes:read', 'annotations:read']),
        ],
        object: policy(['collections:read', 'nodes:read']),
      },
    });

    expect([...effective]).toEqual(['nodes:read']);
  });

  it('[evidence:security.effective-scope] keeps credential scopes as the upper bound', () => {
    const broadPolicy = policy(['collections:read', 'nodes:read', 'nodes:write', 'feed:read']);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [publisher],
      policyChain: {
        serverDefault: broadPolicy,
        collection: broadPolicy,
        ancestors: [broadPolicy],
        object: broadPolicy,
      },
    });

    expect([...effective]).toEqual(['nodes:read']);
  });

  it('[evidence:security.effective-scope] lets an ancestor policy tighten otherwise broad access', () => {
    const broadPolicy = policy(['collections:read', 'nodes:read', 'nodes:write']);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['collections:read', 'nodes:read', 'nodes:write']),
      identities: [publisher],
      policyChain: {
        serverDefault: broadPolicy,
        collection: broadPolicy,
        ancestors: [policy(['nodes:read'])],
        object: broadPolicy,
      },
    });

    expect([...effective]).toEqual(['nodes:read']);
  });

  it('[evidence:security.effective-scope] lets the object policy tighten inherited access', () => {
    const inheritedPolicy = policy(['collections:read', 'nodes:read', 'nodes:write']);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['collections:read', 'nodes:read', 'nodes:write']),
      identities: [publisher],
      policyChain: {
        serverDefault: inheritedPolicy,
        collection: inheritedPolicy,
        ancestors: [inheritedPolicy],
        object: policy(['collections:read']),
      },
    });

    expect([...effective]).toEqual(['collections:read']);
  });

  it('[evidence:security.effective-scope] defaults to no access when one layer has no matching allow', () => {
    const matchingPolicy = policy(['nodes:read', 'nodes:write']);
    const unrelatedPrincipal: PrincipalRef = { type: 'service', id: 'other-publisher' };
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read', 'nodes:write']),
      identities: [publisher],
      policyChain: {
        serverDefault: matchingPolicy,
        collection: policy(['nodes:read', 'nodes:write'], 'private', unrelatedPrincipal),
        ancestors: [matchingPolicy],
        object: matchingPolicy,
      },
    });

    expect([...effective]).toEqual([]);
  });

  it('[evidence:security.effective-scope] keeps principal types distinct when ids are equal', () => {
    const sameIdApiKey: PrincipalRef = { type: 'api_key', id: publisher.id };
    const matchingPolicy = policy(['nodes:read']);
    const wrongTypePolicy = policy(['nodes:read'], 'private', sameIdApiKey);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [publisher],
      policyChain: {
        serverDefault: matchingPolicy,
        collection: matchingPolicy,
        ancestors: [wrongTypePolicy],
        object: matchingPolicy,
      },
    });

    expect([...effective]).toEqual([]);
  });

  it('[evidence:security.effective-scope] does not report a scope removed by a matching deny', () => {
    const matchingPolicy = policy(['nodes:read', 'nodes:write']);
    const denyingObject: AccessPolicy = {
      ...matchingPolicy,
      entries: [
        ...matchingPolicy.entries,
        { principal: publisher, effect: 'deny', scopes: ['nodes:write'] },
      ],
    };
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read', 'nodes:write']),
      identities: [publisher],
      policyChain: {
        serverDefault: matchingPolicy,
        collection: matchingPolicy,
        ancestors: [matchingPolicy],
        object: denyingObject,
      },
    });

    expect([...effective]).toEqual(['nodes:read']);
  });

  it('[evidence:security.effective-scope] handles empty and public boundaries without expanding access', () => {
    const openPolicy = publicPolicy();
    const chain = {
      serverDefault: openPolicy,
      collection: openPolicy,
      ancestors: [openPolicy],
      object: openPolicy,
    };

    const emptyCredential = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(),
      identities: [],
      policyChain: chain,
    });
    const writeOnlyCredential = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:write']),
      identities: [],
      policyChain: chain,
    });
    const publicReadCredential = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [],
      policyChain: chain,
    });

    expect([...emptyCredential]).toEqual([]);
    expect([...writeOnlyCredential]).toEqual([]);
    expect([...publicReadCredential]).toEqual(['nodes:read']);
  });
});
