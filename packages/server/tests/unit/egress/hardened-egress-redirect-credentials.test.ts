import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createHardenedEgressFetch,
  type HardenedEgressConnector,
  type HardenedEgressTarget,
} from '../../../src/infrastructure/egress/index.js';
import { FetchPublicationCachePurgeProvider } from '../../../src/infrastructure/outbox/publication-cache-purge.js';

const PUBLIC_IP = '93.184.216.34';
const PURGE_ENDPOINT = 'https://purge.example.test/v1/cache';
const AUTHORIZATION = 'Bearer purge-token-value';

interface Hop {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Records every hop the connector was asked to make and replies with the
 * scripted redirect chain. Nothing here touches the network: the resolver and
 * the connector are both injected.
 */
function recordingFetch(locations: readonly string[]): {
  readonly fetchImpl: ReturnType<typeof createHardenedEgressFetch>;
  readonly hops: readonly Hop[];
} {
  const hops: Hop[] = [];
  const connect: HardenedEgressConnector = async (target: HardenedEgressTarget, init) => {
    hops.push({
      url: target.url.toString(),
      method: init.method ?? 'GET',
      headers: headerRecord(init.headers),
      body: bodyText(init.body),
    });
    const location = locations[hops.length - 1];
    if (location === undefined) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(null, { status: 302, headers: { location } });
  };
  return {
    fetchImpl: createHardenedEgressFetch({ resolve: async () => [PUBLIC_IP], connect }),
    hops,
  };
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers ?? undefined).forEach((value, key) => { record[key] = value; });
  return record;
}

function bodyText(body: RequestInit['body']): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  return '';
}

describe('hardened egress redirect hops follow fetch credential rules', () => {
  test('a cross-origin hop never replays authorization and downgrades the POST to a bodyless GET', async () => {
    const { fetchImpl, hops } = recordingFetch(['https://evil.example.test/collect']);
    await fetchImpl(PURGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'idempotency-1', authorization: AUTHORIZATION },
      body: JSON.stringify({ secret: 'payload' }),
    });
    assert.equal(hops.length, 2);
    assert.equal(hops[0]?.method, 'POST');
    assert.equal(hops[0]?.headers.authorization, AUTHORIZATION);
    assert.equal(hops[1]?.url, 'https://evil.example.test/collect');
    assert.equal(hops[1]?.method, 'GET');
    assert.equal(hops[1]?.headers.authorization, undefined, 'authorization must not cross origins');
    // The header was SENT on hop 1 and the strip set carries `idempotency-key`,
    // but nothing asserted it: deleting the set entry left this file green, so a
    // host the caller never chose would receive the correlator the publication
    // cache purge sends.
    assert.equal(hops[1]?.headers['idempotency-key'], undefined,
      'idempotency-key must not cross origins');
    assert.equal(hops[1]?.body, '', 'a 302 downgrades to GET, so the payload is not resent');
  });

  test('a same-origin hop keeps the idempotency key it was sent with', async () => {
    // The other half of the rule, and the reason it is a strip set rather than a
    // blanket delete: same-origin retries must keep their correlator.
    const { fetchImpl, hops } = recordingFetch(['https://purge.example.test/v1/cache/retry']);
    await fetchImpl(PURGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'idempotency-1',
        authorization: AUTHORIZATION },
      body: JSON.stringify({ secret: 'payload' }),
    });
    assert.equal(hops[1]?.headers['idempotency-key'], 'idempotency-1');
  });

  test('a same-origin 302 still downgrades to GET and drops the payload', async () => {
    const { fetchImpl, hops } = recordingFetch(['https://purge.example.test/v1/cache/retry']);
    await fetchImpl(PURGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTHORIZATION },
      body: JSON.stringify({ secret: 'payload' }),
    });
    assert.equal(hops[1]?.method, 'GET');
    assert.equal(hops[1]?.body, '');
    assert.equal(hops[1]?.headers.authorization, AUTHORIZATION, 'same-origin credentials are preserved');
    assert.equal(hops[1]?.headers['content-type'], undefined, 'a bodyless GET keeps no entity headers');
  });

  test('a cross-origin hop strips cookies as well as authorization on a 307', async () => {
    const hops: Hop[] = [];
    const connect: HardenedEgressConnector = async (target, init) => {
      hops.push({ url: target.url.toString(), method: init.method ?? 'GET',
        headers: headerRecord(init.headers), body: bodyText(init.body) });
      if (hops.length === 1) {
        return new Response(null, { status: 307, headers: { location: 'https://evil.example.test/keep' } });
      }
      return new Response('{}', { status: 200 });
    };
    const fetchImpl = createHardenedEgressFetch({ resolve: async () => [PUBLIC_IP], connect });
    await fetchImpl(PURGE_ENDPOINT, {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, cookie: 'session=abc', 'content-type': 'application/json' },
      body: '{"keep":true}',
    });
    assert.equal(hops[1]?.method, 'POST', '307 preserves the method');
    // The BODY is not replayed to a host the caller never chose. This test used to
    // assert the opposite, which was the unsafe expectation: a cross-origin 307
    // re-sent the original form body, and for the OIDC token exchange that body is
    // the code_verifier (in every auth mode) and the client secret (in
    // client_secret_post mode).
    assert.equal(hops[1]?.body, '', 'a cross-origin hop must not carry the body');
    assert.equal(hops[1]?.headers.authorization, undefined);
    assert.equal(hops[1]?.headers.cookie, undefined);
  });


  test('a cross-origin 307 does not replay an OIDC token-exchange body', async () => {
    // REGRESSION, found by an independent reviewer by execution. The hop dropped
    // only UN-replayable bodies, so a 307/308 to an attacker-chosen host re-sent a
    // string body verbatim — for the OIDC token exchange that is the code_verifier
    // in every auth mode, plus client_secret when OIDC_CLIENT_AUTH_MODE is
    // client_secret_post. Nothing about "the body is replayable" answers whether it
    // may be replayed ELSEWHERE.
    const hops: Hop[] = [];
    const connect: HardenedEgressConnector = async (target, init) => {
      hops.push({ url: target.url.toString(), method: init.method ?? 'GET',
        headers: headerRecord(init.headers), body: bodyText(init.body) });
      if (hops.length === 1) {
        return new Response(null, { status: 307, headers: { location: 'https://evil.example.test/token' } });
      }
      return new Response('{}', { status: 200 });
    };
    const fetchImpl = createHardenedEgressFetch({ resolve: async () => [PUBLIC_IP], connect });
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code: 'the-code',
      code_verifier: 'CODE_VERIFIER_VALUE', client_secret: 'OIDC_CLIENT_SECRET_VALUE',
    });
    await fetchImpl('https://idp.example.test/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    });
    assert.equal(hops[0]?.body?.includes('CODE_VERIFIER_VALUE'), true, 'the first hop sends it');
    assert.equal(hops[1]?.body, '', 'the redirected hop must not resend it');
    assert.equal(hops[1]?.headers['content-type'], undefined,
      'and must not describe a body it is no longer sending');
  });

  test('a stream body is dropped rather than sent truncated on a preserved-method cross-origin hop', async () => {
    const hops: Hop[] = [];
    const connect: HardenedEgressConnector = async (target, init) => {
      hops.push({ url: target.url.toString(), method: init.method ?? 'GET',
        headers: headerRecord(init.headers), body: bodyText(init.body) });
      if (hops.length === 1) {
        return new Response(null, { status: 308, headers: { location: 'https://evil.example.test/stream' } });
      }
      return new Response('{}', { status: 200 });
    };
    const fetchImpl = createHardenedEgressFetch({ resolve: async () => [PUBLIC_IP], connect });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"streamed":true}')); controller.close(); },
    });
    await fetchImpl(PURGE_ENDPOINT, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    assert.equal(hops[1]?.method, 'POST');
    assert.equal(hops[1]?.body, '', 'an unreadable body must not be replayed');
  });

  test('the publication cache purge provider never delivers its bearer token to a redirected host', async () => {
    const { fetchImpl, hops } = recordingFetch(['https://evil.example.test/collect']);
    const provider = new FetchPublicationCachePurgeProvider({
      endpoint: PURGE_ENDPOINT,
      bearerToken: 'purge-token-value',
      fetch: fetchImpl,
    });
    await provider.purge({
      eventId: 'event-1', idempotencyKey: 'idempotency-1', collectionId: 'collection-1',
      publicationSlug: 'engineering-notes', visibility: 'public',
      contentRevision: 'content-7', policyRevision: 'policy-4',
      sourceEventType: 'node.updated', sourceEventVersion: 1, urls: [], surrogateKeys: [],
      signal: new AbortController().signal,
    });
    const redirected = hops[1];
    assert.equal(redirected?.url, 'https://evil.example.test/collect');
    assert.equal(redirected?.headers.authorization, undefined);
    assert.equal(redirected?.body.includes('purge-token-value'), false);
  });
});
