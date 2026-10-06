import { describe, expect, it } from 'vitest';

import {
  evaluateEffectiveScopes,
  serializeRateLimitFields,
} from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

function policy(visibility: AccessPolicy['visibility'], entries: AccessPolicy['entries']): AccessPolicy {
  return {
    visibility,
    entries,
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-1',
  };
}

function policyChain(
  serverDefault: AccessPolicy,
  collection: AccessPolicy,
  ancestors: readonly AccessPolicy[],
  object: AccessPolicy,
) {
  return { serverDefault, collection, ancestors, object };
}

describe('effective authorization', () => {
  const user: PrincipalRef = { type: 'user', id: 'alice' };
  const granted = new Set<ScopeName>(['collections:read', 'nodes:read', 'nodes:write']);

  it('intersects token, collection, and descendant policy with deny precedence', () => {
    const allowAll = policy('private', [
      {
        principal: user,
        effect: 'allow',
        scopes: ['collections:read', 'nodes:read', 'nodes:write'],
      },
    ]);
    const effective = evaluateEffectiveScopes({
      grantedScopes: granted,
      identities: [user],
      policyChain: policyChain(
        allowAll,
        allowAll,
        [
          policy('private', [
            { principal: user, effect: 'allow', scopes: ['nodes:read', 'nodes:write'] },
            { principal: user, effect: 'deny', scopes: ['nodes:write'] },
          ]),
        ],
        policy('private', [
          { principal: user, effect: 'allow', scopes: ['nodes:read', 'nodes:write'] },
        ]),
      ),
    });
    expect([...effective]).toEqual(['nodes:read']);
  });

  it('does not apply an anonymous public deny to an authenticated principal', () => {
    const apiKey: PrincipalRef = { type: 'api_key', id: 'key_reader_1' };
    const apiKeyPolicy = policy('protected', [
      {
        principal: { type: 'public', id: 'public' },
        effect: 'deny',
        scopes: ['collections:read', 'nodes:read'],
      },
      {
        principal: apiKey,
        effect: 'allow',
        scopes: ['collections:read', 'nodes:read', 'feed:read'],
      },
    ]);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['collections:read', 'nodes:read', 'feed:read']),
      identities: [apiKey],
      policyChain: policyChain(apiKeyPolicy, apiKeyPolicy, [], apiKeyPolicy),
    });

    expect([...effective]).toEqual(['collections:read', 'nodes:read', 'feed:read']);
  });

  it('matches the synthetic public principal only for anonymous requests', () => {
    const anonymousPolicy = policy('protected', [
      {
        principal: { type: 'public', id: 'public' },
        effect: 'deny',
        scopes: ['collections:read', 'nodes:read'],
      },
    ]);

    const anonymous = evaluateEffectiveScopes({
      grantedScopes: granted,
      identities: [],
      policyChain: policyChain(anonymousPolicy, anonymousPolicy, [], anonymousPolicy),
    });
    const authenticatedPolicy = policy('protected', [
      ...anonymousPolicy.entries,
      { principal: user, effect: 'allow', scopes: ['collections:read', 'nodes:read'] },
    ]);
    const authenticated = evaluateEffectiveScopes({
      grantedScopes: granted,
      identities: [user, { type: 'public', id: 'public' }],
      policyChain: policyChain(authenticatedPolicy, authenticatedPolicy, [], authenticatedPolicy),
    });

    expect([...anonymous]).toEqual([]);
    expect([...authenticated]).toEqual(['collections:read', 'nodes:read']);
  });

  it('grants public reads but never invents scopes absent from the credential', () => {
    const publicPolicy = policy('public', []);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['collections:read', 'nodes:write']),
      identities: [],
      policyChain: policyChain(publicPolicy, publicPolicy, [], publicPolicy),
    });
    expect([...effective]).toEqual(['collections:read']);
  });
});

describe('RFC 9651 fields', () => {
  it('formats RateLimit and RateLimit-Policy', () => {
    const input = {
      policy: 'feed',
      limit: 120,
      remaining: 83,
      resetSeconds: 27,
      windowSeconds: 60,
    };
    const preferred = serializeRateLimitFields(input);
    expect(preferred).toEqual({
      RateLimit: '"feed";r=83;t=27',
      'RateLimit-Policy': '"feed";q=120;w=60',
    });
  });

  it('escapes policy identifiers (quote and backslash)', () => {
    const input = {
      policy: 'quoted"policy\\x',
      limit: 1,
      remaining: 0,
      resetSeconds: 0,
      windowSeconds: 60,
    };
    const preferred = serializeRateLimitFields(input);
    expect(preferred).toEqual({
      RateLimit: '"quoted\\"policy\\\\x";r=0;t=0',
      'RateLimit-Policy': '"quoted\\"policy\\\\x";q=1;w=60',
    });
  });

  it('rejects negative remaining and resetSeconds with TypeError', () => {
    const negativeRemaining = {
      policy: 'feed',
      limit: 1,
      remaining: -1,
      resetSeconds: 0,
      windowSeconds: 60,
    };
    const negativeReset = {
      policy: 'feed',
      limit: 1,
      remaining: 0,
      resetSeconds: -2,
      windowSeconds: 60,
    };

    expect(() => serializeRateLimitFields(negativeRemaining)).toThrow(TypeError);
    expect(() => serializeRateLimitFields(negativeReset)).toThrow(TypeError);
  });
});
