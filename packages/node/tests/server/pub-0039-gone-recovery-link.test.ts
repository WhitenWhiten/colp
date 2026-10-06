import { describe, expect, it, vi } from 'vitest';

import {
  PUBLICATION_DELETED_COLLECTION_ARCHIVE_REL,
  PUBLICATION_DELETED_COLLECTION_MIGRATION_REL,
  PUBLICATION_DELETED_COLLECTION_OWNER_REL,
  createPublicationDeletedCollectionGoneResponse,
  createPublicationDeletedCollectionGoneResponseWithRecoveryTarget,
  createPublicationDeletedCollectionRecoveryTarget,
  createPublicationDeletedCollectionTombstone,
  type PublicationDeletedCollectionClock,
  type PublicationDeletedCollectionRecoveryKind,
  type PublicationDeletedCollectionRecoveryTarget,
} from '../../src/server/index.js';

const evidence = '[evidence:http.collection-gone-recovery-link]';
const canonicalUrl = 'https://collections.example/library/interface-systems';
const deletedAt = new Date('2026-01-01T00:00:00.000Z');
const oneDay = 24 * 60 * 60 * 1_000;

const targets = [
  ['archive', 'https://archive.example/collections/interface-systems', PUBLICATION_DELETED_COLLECTION_ARCHIVE_REL],
  ['migration', 'https://new.example/collections/interface-systems', PUBLICATION_DELETED_COLLECTION_MIGRATION_REL],
  ['owner', 'https://owner.example/collections/interface-systems', PUBLICATION_DELETED_COLLECTION_OWNER_REL],
] as const;

class FixedClock implements PublicationDeletedCollectionClock {
  constructor(readonly value: Date) {}
  now(): Date { return this.value; }
}

function request(
  url = canonicalUrl,
  method = 'GET',
  headers?: ConstructorParameters<typeof Headers>[0],
): Request {
  return new Request(url, { method, ...(headers === undefined ? {} : { headers }) });
}

function tombstone() {
  return createPublicationDeletedCollectionTombstone({ canonicalUrl, deletedAt });
}

function target(
  kind: PublicationDeletedCollectionRecoveryKind = 'archive',
  url = 'https://archive.example/collections/interface-systems',
): PublicationDeletedCollectionRecoveryTarget {
  return createPublicationDeletedCollectionRecoveryTarget({ kind, url });
}

function response(
  recoveryTarget = target(),
  candidate = request(),
  now = new Date(deletedAt.getTime() + oneDay),
): Response | null {
  return createPublicationDeletedCollectionGoneResponseWithRecoveryTarget(
    candidate,
    tombstone(),
    recoveryTarget,
    new FixedClock(now),
  );
}

function captureError(work: () => unknown): Error {
  try { work(); } catch (error) { return error as Error; }
  throw new Error('Expected operation to reject.');
}

describe(`PUB-0039 deleted Collection recovery target ${evidence}`, () => {
  it.each(targets)(`publishes one exact %s target in both Problem links and RFC 8288 Link ${evidence}`, async (kind, url, relation) => {
    const issued = target(kind, url);
    const result = response(issued)!;
    const body = await result.json() as Record<string, unknown>;

    expect(issued).toEqual({ kind, url, relation });
    expect(Object.isFrozen(issued)).toBe(true);
    expect(result.status).toBe(410);
    expect(result.statusText).toBe('Gone');
    expect(result.headers.get('link')).toBe(`<${url}>; rel="${relation}"`);
    expect(body).toMatchObject({
      status: 410,
      retryable: false,
      links: { [relation]: url },
    });
    expect((body.links as Record<string, unknown>)[relation]).toBe(url);
    expect(Object.keys(body.links as object)).toEqual([relation]);
  });

  it.each(targets)(`keeps GET and HEAD status and recovery headers identical for %s while HEAD has no body ${evidence}`, async (kind, url) => {
    const issued = target(kind, url);
    const get = response(issued, request(canonicalUrl, 'GET'))!;
    const head = response(issued, request(canonicalUrl, 'HEAD'))!;

    expect(head.status).toBe(410);
    expect(head.statusText).toBe(get.statusText);
    expect(Array.from(head.headers.entries())).toEqual(Array.from(get.headers.entries()));
    expect((await get.text()).length).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
    expect(head.body).toBeNull();
  });

  it(`retains PUB-0038 timing and baseline no-link behavior without making recovery mandatory ${evidence}`, async () => {
    const value = tombstone();
    const issued = target();
    const before = new FixedClock(new Date(deletedAt.getTime() - 1));
    const during = new FixedClock(new Date(deletedAt.getTime() + 30 * oneDay - 1));
    const atExpiry = new FixedClock(new Date(deletedAt.getTime() + 30 * oneDay));

    expect(createPublicationDeletedCollectionGoneResponseWithRecoveryTarget(request(), value, issued, before)).toBeNull();
    expect(createPublicationDeletedCollectionGoneResponseWithRecoveryTarget(request(), value, issued, during)?.status).toBe(410);
    expect(createPublicationDeletedCollectionGoneResponseWithRecoveryTarget(request(), value, issued, atExpiry)).toBeNull();

    const baselineValue = tombstone();
    const baseline = createPublicationDeletedCollectionGoneResponse(
      request(),
      baselineValue,
      new FixedClock(new Date(deletedAt.getTime() + oneDay)),
    )!;
    expect(baseline.status).toBe(410);
    expect(baseline.headers.get('link')).toBeNull();
    expect(await baseline.json()).not.toHaveProperty('links');
  });

  it.each([
    ['same-origin HTTPS', `${canonicalUrl}/archive`],
    ['cross-origin HTTPS', 'https://archive.other.example:8443/c/id%2Fpart?signature=a%2Bb%3D'],
    ['encoded Link delimiter', 'https://archive.example/c/id%3Epart?token=a%2Cb%3Bc'],
    ['localhost HTTP', 'http://localhost:8787/archive?id=id%2Fpart'],
    ['IPv4 loopback HTTP', 'http://127.0.0.1:8787/archive'],
    ['IPv6 loopback HTTP', 'http://[::1]:8787/archive'],
  ] as const)(`accepts and preserves a safe %s target byte-for-byte ${evidence}`, (_label, url) => {
    const issued = target('archive', url);
    expect(issued.url).toBe(url);
    expect(response(issued)?.headers.get('link')).toContain(`<${url}>`);
  });

  it.each([
    ['non-loopback HTTP', 'http://archive.example/collection'],
    ['lookalike localhost', 'http://localhost.attacker.example/collection'],
    ['other 127/8 address', 'http://127.0.0.2/collection'],
    ['HTTPS downgrade target', 'http://new.example/collection'],
    ['JavaScript', 'javascript:alert(1)'],
    ['data', 'data:text/html,private'],
    ['file', 'file:///private/collection'],
    ['relative', '../archive'],
    ['protocol-relative', '//archive.example/collection'],
    ['userinfo', 'https://owner:private-password@archive.example/collection'],
    ['fragment', 'https://archive.example/collection#private-fragment'],
    ['malformed percent escape', 'https://archive.example/%zz'],
    ['percent-encoded NUL', 'https://archive.example/a%00b'],
    ['percent-encoded CRLF', 'https://archive.example/a%0d%0aX-Injected%3Ayes'],
    ['percent-encoded DEL', 'https://archive.example/a%7fb'],
    ['percent-encoded C1 control', 'https://archive.example/a%80b'],
    ['percent-encoded userinfo', 'https://owner%3Aprivate-password@archive.example/collection'],
    ['space control', 'https://archive.example/a b'],
    ['tab control', 'https://archive.example/a\tb'],
    ['CRLF injection', 'https://archive.example/a\r\nX-Injected: yes'],
    ['Link delimiter', 'https://archive.example/a>b'],
  ] as const)(`rejects an unsafe or ambiguous %s target without reflecting it ${evidence}`, (_label, url) => {
    const error = captureError(() => target('archive', url));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toMatch(/private-password|private-fragment|X-Injected/iu);
  });

  it(`accepts the exact recovery URL limit and rejects the next byte ${evidence}`, () => {
    const prefix = 'https://archive.example/';
    const accepted = `${prefix}${'a'.repeat(4_096 - prefix.length)}`;
    const rejected = `${prefix}${'a'.repeat(4_097 - prefix.length)}`;

    expect(target('archive', accepted).url).toBe(accepted);
    expect(() => target('archive', rejected)).toThrow(TypeError);
  });

  it.each([
    ['unknown kind', { kind: 'mirror', url: 'https://archive.example/c' }],
    ['missing kind', { url: 'https://archive.example/c' }],
    ['missing URL', { kind: 'archive' }],
    ['old archive field', { archiveUrl: 'https://archive.example/c' }],
    ['multiple target fields', { kind: 'archive', url: 'https://archive.example/c', ownerUrl: 'https://owner.example/c' }],
    ['ambiguous kind fields', { kind: 'archive', type: 'owner', url: 'https://archive.example/c' }],
    ['non-string URL', { kind: 'archive', url: new URL('https://archive.example/c') }],
    ['array', ['archive', 'https://archive.example/c']],
    ['null prototype', Object.assign(Object.create(null), { kind: 'archive', url: 'https://archive.example/c' })],
  ] as const)(`rejects %s instead of guessing a recovery target ${evidence}`, (_label, input) => {
    expect(() => createPublicationDeletedCollectionRecoveryTarget(input as never)).toThrow(TypeError);
  });

  it(`rejects symbol keys accessors and Proxies without invoking hostile code ${evidence}`, () => {
    let getterCalls = 0;
    let proxyTraps = 0;
    const symbol = { kind: 'archive', url: 'https://archive.example/c', [Symbol('owner')]: 'https://owner.example/c' };
    const accessor = Object.defineProperty({ kind: 'archive' }, 'url', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('private-target-getter'); },
    });
    const proxied = new Proxy({ kind: 'archive', url: 'https://archive.example/c' }, {
      get() { proxyTraps += 1; throw new Error('private-target-proxy'); },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('private-target-proxy'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('private-target-proxy'); },
      ownKeys() { proxyTraps += 1; throw new Error('private-target-proxy'); },
    });

    for (const candidate of [symbol, accessor, proxied]) {
      const error = captureError(() => createPublicationDeletedCollectionRecoveryTarget(candidate as never));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toMatch(/private-target/iu);
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it(`rejects forged and proxied issued targets without consulting attacker properties ${evidence}`, () => {
    const issued = target();
    const forged = { ...issued } as PublicationDeletedCollectionRecoveryTarget;
    let traps = 0;
    const proxied = new Proxy(issued, {
      get() { traps += 1; throw new Error('private-issued-target'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('private-issued-target'); },
      getPrototypeOf() { traps += 1; throw new Error('private-issued-target'); },
    });

    for (const candidate of [forged, proxied]) {
      const error = captureError(() => response(candidate));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toContain('private-issued-target');
    }
    expect(traps).toBe(0);
  });

  it(`does not reflect request Authorization cookies or the original private Collection URL ${evidence}`, async () => {
    const secret = 'Bearer publication-private-credential';
    const result = response(target('owner', 'https://owner.example/public-page'), request(canonicalUrl, 'GET', {
      Authorization: secret,
      Cookie: 'session=private-session-cookie',
    }))!;
    const headers = JSON.stringify(Array.from(result.headers.entries()));
    const body = await result.text();

    expect(headers).not.toMatch(/publication-private-credential|private-session-cookie|interface-systems/iu);
    expect(body).not.toMatch(/publication-private-credential|private-session-cookie|interface-systems/iu);
    expect(body).toContain('https://owner.example/public-page');
  });

  it(`advertises recovery without navigating fetching or forwarding credentials ${evidence}`, async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    try {
      const result = response(target('migration', 'https://new.example/collections/interface-systems'), request(
        canonicalUrl,
        'GET',
        { Authorization: 'Bearer private', Cookie: 'session=private' },
      ))!;
      expect(result.status).toBe(410);
      expect(fetch).not.toHaveBeenCalled();
      const body = await result.json() as { links: Record<string, unknown> };
      expect(body.links[PUBLICATION_DELETED_COLLECTION_MIGRATION_REL])
        .toBe('https://new.example/collections/interface-systems');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each(targets)(`does not turn Section 13 %s recovery into Section 14 redirect or migration state ${evidence}`, async (kind, url) => {
    const result = response(target(kind, url))!;
    const body = await result.json() as Record<string, unknown>;

    expect(result.status).toBe(410);
    expect(result.status).not.toBe(308);
    expect(result.headers.get('location')).toBeNull();
    expect(body).not.toHaveProperty('movedTo');
    expect(body).not.toHaveProperty('migration');
    expect(body).not.toHaveProperty('state');
  });

  it(`uses conservative error-response caching and exposes only the intended public target ${evidence}`, async () => {
    const url = 'https://archive.example/public/collection';
    const result = response(target('archive', url))!;
    const serialized = `${JSON.stringify(Array.from(result.headers.entries()))}\n${await result.text()}`;

    expect(result.headers.get('content-type')).toBe('application/problem+json');
    expect(result.headers.get('cache-control')).toMatch(/(?:^|,)\s*(?:private\s*,\s*)?no-store(?:\s*,|$)/iu);
    expect(result.headers.get('cache-control')).not.toMatch(/public|max-age|s-maxage|immutable/iu);
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(serialized).toContain(url);
    expect(serialized).not.toMatch(/set-cookie|authorization|interface-systems|movedTo/iu);
  });

  it.each([
    ['different URL', request('https://collections.example/library/other'), new Date(deletedAt.getTime() + oneDay)],
    ['query mismatch', request(`${canonicalUrl}?view=public`), new Date(deletedAt.getTime() + oneDay)],
    ['unsupported POST', request(canonicalUrl, 'POST'), new Date(deletedAt.getTime() + oneDay)],
    ['unsupported OPTIONS', request(canonicalUrl, 'OPTIONS'), new Date(deletedAt.getTime() + oneDay)],
    ['before deletion', request(), new Date(deletedAt.getTime() - 1)],
    ['expired', request(), new Date(deletedAt.getTime() + 30 * oneDay)],
  ] as const)(`returns null for %s without leaking recovery metadata ${evidence}`, (_label, candidate, now) => {
    const recoveryUrl = 'https://archive.example/private-recovery-route';
    const result = response(target('archive', recoveryUrl), candidate, now);
    expect(result).toBeNull();
  });

  it(`returns fresh independent 410 responses without sharing mutable recovery headers ${evidence}`, async () => {
    const issued = target();
    const first = response(issued)!;
    const second = response(issued)!;
    first.headers.set('link', '<https://attacker.example/>; rel="owner"');

    expect(first).not.toBe(second);
    expect(second.headers.get('link')).toBe(`<${issued.url}>; rel="${issued.relation}"`);
    expect(JSON.stringify(await second.json())).not.toContain('attacker.example');
  });
});
