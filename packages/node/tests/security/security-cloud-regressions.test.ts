import { describe, expect, it, vi } from 'vitest';
import { TextByteBudget } from '../../src/shared/text-budget.js';
import { immutableJsonSnapshot } from '../../src/shared/immutable-json.js';
import { preserveExtensions } from '../../src/schema/extensions.js';
import { encodeCanonicalJson, CANONICAL_JSON_MAX_BYTES } from '../../src/sync/canonical-json.js';
import { immutableRequest, MAX_PUSH_BATCH_BYTES } from '../../src/sync/push-transaction-guards.js';
import { snapshotBoundedStrings } from '../../src/security/bounded-string-array.js';
import { assertRequestTargetBudget } from '../../src/security/request-target-budget.js';
import { enforceApiKeyTransport } from '../../src/security/api-key-transport.js';
import { credentialQueryDenial } from '../../src/security/credential-query-value.js';
import { enforceOAuthAuthorizationServerMetadata } from '../../src/security/mcp-oauth-discovery.js';
import { formatOAuthLogContext } from '../../src/security/mcp-oauth-client.js';
import { ColpClient } from '../../src/client/index.js';
import { isListenAuthorized } from '../../src/mcp/2026-07-28/subscription-authority.js';
import { authorizeNodeWriteIdentities } from '../../src/publisher/node-write-identity.js';
import { mapFeedToAtom } from '../../src/feed/atom.js';
import { serializeBoundedAtom } from '../../src/feed/atom-serializer.js';

const metadata = {
  issuer: 'https://issuer.example',
  authorization_endpoint: 'https://issuer.example/authorize',
  token_endpoint: 'https://issuer.example/token',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};
const metadataOptions = { expectedIssuer: metadata.issuer };
const stringLimits = { maxEntries: 256, maxStringBytes: 2048, maxTotalBytes: 64 * 1024 };

describe('Security Cloud: byte accounting before allocating representations', () => {
  it.each(['', 'ascii', '中文', '😀', '\u0000\n"\\', '\ud800'])('counts JSON encoding of %j exactly', text => {
    const size = Buffer.byteLength(JSON.stringify(text));
    const budget = new TextByteBudget(size, 'test');
    budget.jsonString(text);
    expect(budget.bytes).toBe(size);
    if (size > 1) expect(() => new TextByteBudget(size - 1, 'test').jsonString(text)).toThrow(RangeError);
  });
  it('counts keys, punctuation and multibyte strings in immutable snapshots', () => {
    const value = { key: ['中文', true, null, 1] };
    const size = Buffer.byteLength(JSON.stringify(value));
    expect(immutableJsonSnapshot(value, 'test', { maxBytes: size })).toEqual(value);
    expect(() => immutableJsonSnapshot(value, 'test', { maxBytes: size - 1 })).toThrow(RangeError);
  });
});

describe('Security Cloud finding 2: bounded extension preservation', () => {
  it('rejects excess depth without overflowing the stack', () => {
    let value: unknown = null;
    for (let i = 0; i < 100; i += 1) value = { nested: value };
    expect(() => preserveExtensions({ 'https://example.com/ext': value }, { surface: 'relay' })).toThrow();
  });
  it('charges every occurrence in a shared DAG', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 14; i += 1) value = [value, value];
    expect(() => preserveExtensions({ 'https://example.com/ext': value }, { surface: 'relay' })).toThrow();
  });
  it('does not reset the aggregate budget for each namespace', () => {
    const value = Object.fromEntries(Array.from({ length: 20 }, (_, i) =>
      [`https://example.com/ext/${i}`, 'x'.repeat(64 * 1024)]));
    expect(() => preserveExtensions(value, { surface: 'relay' })).toThrow();
  });
  it('never invokes a proxy trap', () => {
    const trap = vi.fn(() => { throw new Error('trap'); });
    const value = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap });
    expect(() => preserveExtensions(value, { surface: 'relay' })).toThrow();
    expect(trap).not.toHaveBeenCalled();
  });
});

describe('Security Cloud finding 3: metadata budgets', () => {
  it('keeps valid issuer-pinned metadata working', () => {
    expect(enforceOAuthAuthorizationServerMetadata(metadata, metadataOptions).allowed).toBe(true);
  });
  it('bounds metadata members before discarding undefined optional values', () => {
    const oversized = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`optional${index}`, undefined]));
    expect(enforceOAuthAuthorizationServerMetadata({ ...metadata, ...oversized }, metadataOptions).allowed).toBe(false);
  });
  it.each(['response_types_supported', 'grant_types_supported', 'code_challenge_methods_supported'])('bounds %s', key => {
    const result = enforceOAuthAuthorizationServerMetadata({ ...metadata, [key]: Array(257).fill('code') }, metadataOptions);
    expect(result.allowed).toBe(false);
  });
  it('bounds individual strings and unknown extension data in aggregate', () => {
    expect(enforceOAuthAuthorizationServerMetadata({ ...metadata, grant_types_supported: ['x'.repeat(4097)] }, metadataOptions).allowed).toBe(false);
    expect(enforceOAuthAuthorizationServerMetadata({ ...metadata, extension: 'x'.repeat(64 * 1024) }, metadataOptions).allowed).toBe(false);
  });
});

describe('Security Cloud findings 4 and 12: resource subscriptions', () => {
  it('rejects the count before reading any item', () => {
    const items = new Array(257);
    const getter = vi.fn(() => 'uri');
    Object.defineProperty(items, '0', { get: getter, enumerable: true });
    expect(() => snapshotBoundedStrings(items, 'uris', stringLimits)).toThrow(RangeError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('enforces per-URI and aggregate bytes', () => {
    expect(() => snapshotBoundedStrings(['x'.repeat(2049)], 'uris', stringLimits)).toThrow();
    expect(() => snapshotBoundedStrings(Array(33).fill('x'.repeat(2048)), 'uris', stringLimits)).toThrow();
  });
  it('does not turn a request-wide allow into a resource-wide allow', () => {
    expect(isListenAuthorized({}, ['private:resource'], { isAuthorized: () => true })).toBe(false);
  });
  it('checks exact URIs and reflects revocation/errors before delivery', () => {
    let allowed = true;
    const context = Object.freeze({ subject: 'alice' });
    const check = vi.fn((ctx: typeof context, uri: string) => ctx === context && uri === 'private:mine' && allowed);
    const authorization = { isAuthorized: () => true, isResourceAuthorized: check };
    expect(isListenAuthorized(context, ['private:mine'], authorization)).toBe(true);
    expect(isListenAuthorized(context, ['private:other'], authorization)).toBe(false);
    allowed = false;
    expect(isListenAuthorized(context, ['private:mine'], authorization)).toBe(false);
    expect(isListenAuthorized(context, ['private:mine'], { ...authorization, isResourceAuthorized: () => { throw new Error(); } })).toBe(false);
  });
});

describe('Security Cloud finding 5: Push budgets precede validation/work', () => {
  it('rejects excessive operation count without reading items', () => {
    const operations = new Array(1001);
    const getter = vi.fn(() => ({}));
    Object.defineProperty(operations, '0', { enumerable: true, get: getter });
    expect(() => immutableRequest({ operations } as never)).toThrow(RangeError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects aggregate operation bytes before schema validation', () => {
    const text = 'x'.repeat(Math.ceil(MAX_PUSH_BATCH_BYTES / 1000));
    const operations = Array.from({ length: 1000 }, () => ({ operation: { text }, sequenceScope: 's', digest: 'd' }));
    expect(() => immutableRequest({ batchId: 'b', atomic: true, serverCursor: 'c', operations } as never)).toThrow(RangeError);
  });
});

describe('Security Cloud finding 6: client preserves jsonLimits.maxBytes', () => {
  it('fails at parsing, rather than accepting a response up to the default ceiling', async () => {
    const client = new ColpClient({
      manifestUrl: 'https://example.com/manifest', jsonLimits: { maxBytes: 32 },
      fetch: async () => new Response(JSON.stringify({ padding: 'x'.repeat(128) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    });
    await expect(client.getDirectory()).rejects.toMatchObject({ stage: 'parse' });
  });
});

describe('Security Cloud finding 7: raw query work is bounded first', () => {
  it('allows 256 entries and rejects 257 before invoking classifiers', () => {
    expect(() => assertRequestTargetBudget('/?' + Array(256).fill('x=1').join('&'))).not.toThrow();
    const classifyApiKey = vi.fn(() => false);
    expect(enforceApiKeyTransport({ requestTarget: '/?' + Array(257).fill('x=1').join('&'), classifyApiKey }))
      .toMatchObject({ allowed: false, reason: 'query_limit_exceeded' });
    expect(classifyApiKey).not.toHaveBeenCalled();
  });
  it('rejects huge request targets without consulting authorization/classification', () => {
    expect(enforceApiKeyTransport({ requestTarget: '/?' + 'x'.repeat(16 * 1024) })).toMatchObject({ allowed: false, reason: 'query_limit_exceeded' });
  });
});

describe('Security Cloud findings 8 and 9: output expansion', () => {
  it('rejects oversized Atom source strings', () => {
    expect(mapFeedToAtom({ feedUrl: 'https://example.com/feed', collectionUrl: 'https://example.com/c', title: 'x'.repeat(1024 * 1024), events: [] },
      { emptyFeedUpdated: '2026-10-06T00:00:00Z' })).toEqual({ ok: false, code: 'malformed_feed' });
  });
  it('charges repeated URLs and escaped bytes before generating XML', () => {
    const document = { id: 'i', title: '&'.repeat(100), updated: 't', links: [], entries: [] };
    expect(() => serializeBoundedAtom(document, 400)).toThrow(RangeError);
  });
  it('rejects canonical byte overflow before canonicalization/encoding', () => {
    expect(() => encodeCanonicalJson({ operation: 'x'.repeat(CANONICAL_JSON_MAX_BYTES) }, 'operation')).toThrow(RangeError);
  });
});

describe('Security Cloud finding 10: pre-plan identity gate', () => {
  const mutation = { kind: 'move-node' as const, nodeId: 'node', parentId: 'parent', afterId: 'sibling' };
  it('fails closed without the new host identity authorization port', async () => {
    await expect(authorizeNodeWriteIdentities(mutation, undefined)).resolves.toBe(false);
  });
  it('checks literal identities before allowing graph planning', async () => {
    const order: string[] = [];
    const allowed = await authorizeNodeWriteIdentities(mutation, async id => { order.push(id); return id !== 'parent'; });
    if (allowed) order.push('plan');
    expect(order).toEqual(['node', 'parent']);
  });
  it('does not leak exceptions from a denied identity check', async () => {
    await expect(authorizeNodeWriteIdentities(mutation, async () => { throw new Error('private state'); })).resolves.toBe(false);
  });
});

describe('Security Cloud findings 11 and 13: credentials and logging', () => {
  const token = 'abc+def==';
  it('rejects the bearer in parameter names, including a plus-preserving view', () => {
    const raw = `${token}=anything`;
    const entries = Array.from(new URLSearchParams(raw.replaceAll('+', '%2B')));
    // '=' is a query delimiter, so a token used as a name must be percent-encoded.
    const encodedName = Array.from(new URLSearchParams(`${encodeURIComponent(token)}=anything`));
    expect(credentialQueryDenial(encodedName, token, [`Bearer ${token}`])).toBe('credential_in_query');
    expect(credentialQueryDenial(Array.from(new URLSearchParams('x=abc%2Bdef%3D%3D')), token, [])).toBe('credential_in_query');
    expect(entries.length).toBe(1);
  });
  it('detects a raw plus token value using the additional view', () => {
    const query = 'x=' + token;
    expect(credentialQueryDenial(Array.from(new URLSearchParams(query.replaceAll('+', '%2B'))), token, [])).toBe('credential_in_query');
  });
  it.each(['alice\nforged', 'alice\rforged', 'alice\u2028forged', 'x'.repeat(257), '中'.repeat(86)])('rejects unsafe clientId %j', clientId => {
    expect(() => formatOAuthLogContext({ issuer: metadata.issuer, clientId, operation: 'token-exchange', outcome: 'allowed' })).toThrow(TypeError);
  });
  it.each(['alice outcome=allowed', 'alice=forged'])('quotes delimiter-bearing client IDs %j', clientId => {
    const line = formatOAuthLogContext({ issuer: metadata.issuer, clientId, operation: 'token-exchange', outcome: 'denied' });
    expect(line).toContain('outcome=denied');
    expect(line).not.toContain(`${clientId} issuer=`);
  });
  it.each(['alice\u0085forged', 'alice\u202eforged'])('rejects Unicode-control client IDs %j', clientId => {
    expect(() => formatOAuthLogContext({ issuer: metadata.issuer, clientId, operation: 'token-exchange', outcome: 'denied' })).toThrow(TypeError);
  });
  it.each(['https://auth.example.test/issuer\u0085x', 'https://auth.example.test/issuer\u2028x', 'https://auth.example.test/issuer\u202ex'])('rejects Unicode controls in issuer log context %j', issuer => {
    expect(() => formatOAuthLogContext({ issuer, clientId: 'client-1', operation: 'token-exchange', outcome: 'denied' })).toThrow(TypeError);
  });
  it('keeps an ordinary stable client identifier working', () => {
    expect(formatOAuthLogContext({ issuer: metadata.issuer, clientId: 'client-1', operation: 'token-exchange', outcome: 'allowed' })).toContain('clientId=client-1');
  });
});
