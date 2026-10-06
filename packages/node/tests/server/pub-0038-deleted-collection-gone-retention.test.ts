import { describe, expect, it } from 'vitest';

import {
  PUBLICATION_DELETED_COLLECTION_MIN_RETENTION_MILLISECONDS,
  createPublicationDeletedCollectionGoneResponse,
  createPublicationDeletedCollectionTombstone,
  type PublicationDeletedCollectionClock,
  type PublicationDeletedCollectionTombstone,
} from '../../src/server/index.js';

const evidence = '[evidence:http.collection-gone-retention]';
const canonicalUrl = 'https://collections.example/library/interface-systems';
const deletedAt = new Date('2026-01-01T00:00:00.000Z');
const oneDay = 24 * 60 * 60 * 1_000;

class MutableClock implements PublicationDeletedCollectionClock {
  constructor(public value: Date) {}
  now(): Date { return this.value; }
}

function request(
  url = canonicalUrl,
  method: 'GET' | 'HEAD' = 'GET',
  headers?: ConstructorParameters<typeof Headers>[0],
): Request {
  return new Request(url, { method, ...(headers === undefined ? {} : { headers }) });
}

function tombstone(
  overrides: Partial<Parameters<typeof createPublicationDeletedCollectionTombstone>[0]> = {},
): PublicationDeletedCollectionTombstone {
  return createPublicationDeletedCollectionTombstone({ canonicalUrl, deletedAt, ...overrides });
}

function responseAt(
  value: PublicationDeletedCollectionTombstone,
  now: Date,
  candidate = request(),
): Response | null {
  return createPublicationDeletedCollectionGoneResponse(candidate, value, new MutableClock(now));
}

function captureError(work: () => unknown): Error {
  try { work(); } catch (error) { return error as Error; }
  throw new Error('Expected operation to reject.');
}

describe(`PUB-0038 deleted Collection 410 retention ${evidence}`, () => {
  it(`returns 410 Gone at the exact original Canonical URL throughout the normal retention window ${evidence}`, async () => {
    const value = tombstone();
    const response = responseAt(value, new Date(deletedAt.getTime() + 10 * oneDay));

    expect(value.canonicalUrl).toBe(canonicalUrl);
    expect(value.deletedAt).toBe(deletedAt.toISOString());
    expect(value.retentionUntil).toBe(new Date(deletedAt.getTime() + 30 * oneDay).toISOString());
    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(410);
    expect(await response?.json()).toMatchObject({
      type: expect.stringMatching(/^https:\/\//u),
      title: expect.any(String),
      status: 410,
      code: expect.any(String),
      retryable: false,
    });
  });

  it(`uses a half-open 30-day interval at the exact boundary and does not answer before deletion ${evidence}`, () => {
    const value = tombstone();
    expect(responseAt(value, new Date(deletedAt.getTime() - 1))).toBeNull();
    expect(responseAt(value, new Date(deletedAt.getTime()))?.status).toBe(410);
    expect(responseAt(value, new Date(deletedAt.getTime() + 30 * oneDay - 1))?.status).toBe(410);
    expect(responseAt(value, new Date(deletedAt.getTime() + 30 * oneDay))).toBeNull();
  });

  it(`honors a longer explicit retention period before and after its expiry ${evidence}`, () => {
    const value = tombstone({ retentionMilliseconds: 45 * oneDay });
    expect(value.retentionUntil).toBe(new Date(deletedAt.getTime() + 45 * oneDay).toISOString());
    expect(responseAt(value, new Date(deletedAt.getTime() + 30 * oneDay))?.status).toBe(410);
    expect(responseAt(value, new Date(deletedAt.getTime() + 45 * oneDay - 1))?.status).toBe(410);
    expect(responseAt(value, new Date(deletedAt.getTime() + 45 * oneDay))).toBeNull();
    expect(responseAt(value, new Date(deletedAt.getTime() + 40 * oneDay))?.status).toBe(410);
  });

  it.each([
    ['one millisecond short', PUBLICATION_DELETED_COLLECTION_MIN_RETENTION_MILLISECONDS - 1],
    ['zero', 0],
    ['negative', -1],
    ['fractional', PUBLICATION_DELETED_COLLECTION_MIN_RETENTION_MILLISECONDS + 0.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
  ] as const)(`rejects a retention period below or outside the minimum contract: %s ${evidence}`, (_label, retentionMilliseconds) => {
    expect(() => tombstone({ retentionMilliseconds })).toThrow(RangeError);
  });

  it.each([
    ['relative', '/library/interface-systems'],
    ['non-HTTP', 'file:///private/interface-systems'],
    ['credential-bearing', 'https://owner:private-password@collections.example/library/interface-systems'],
    ['fragment-bearing', `${canonicalUrl}#private-fragment`],
    ['empty', ''],
    ['CRLF', `${canonicalUrl}\r\nX-Injected: yes`],
    ['malformed percent escape', `${canonicalUrl}/%zz`],
  ] as const)(`rejects an invalid or hostile Canonical URL: %s ${evidence}`, (_label, value) => {
    const error = captureError(() => tombstone({ canonicalUrl: value }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toMatch(/private-password|private-fragment|X-Injected/iu);
  });

  it.each([
    ['invalid Date', new Date(Number.NaN)],
    ['number', deletedAt.getTime()],
    ['string', deletedAt.toISOString()],
    ['plain object', {}],
  ])(`rejects an invalid deletion timestamp: %s ${evidence}`, (_label, value) => {
    expect(() => tombstone({ deletedAt: value as Date })).toThrow(TypeError);
  });

  it(`accepts only detached plain data and does not invoke hostile accessors or Proxy traps ${evidence}`, () => {
    let getterCalls = 0;
    let proxyTraps = 0;
    const accessor = Object.defineProperty({ deletedAt }, 'canonicalUrl', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('private-getter-secret'); },
    });
    const proxied = new Proxy({ canonicalUrl, deletedAt }, {
      get() { proxyTraps += 1; throw new Error('private-proxy-secret'); },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('private-proxy-secret'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('private-proxy-secret'); },
      ownKeys() { proxyTraps += 1; throw new Error('private-proxy-secret'); },
    });
    const unknown = { canonicalUrl, deletedAt, deletionReason: 'private deletion reason' };

    for (const candidate of [accessor, proxied, unknown]) {
      const error = captureError(() => createPublicationDeletedCollectionTombstone(candidate as never));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toMatch(/private-(getter|proxy)|private deletion reason/iu);
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);

    const sourceDate = new Date(deletedAt);
    const detached = tombstone({ deletedAt: sourceDate });
    sourceDate.setUTCFullYear(2030);
    expect(detached.deletedAt).toBe(deletedAt.toISOString());
    expect(Object.isFrozen(detached)).toBe(true);
  });

  it.each([
    ['different path', 'https://collections.example/library/other'],
    ['trailing slash', `${canonicalUrl}/`],
    ['query', `${canonicalUrl}?view=public`],
    ['fragment', `${canonicalUrl}#section`],
    ['different origin', 'https://other.example/library/interface-systems'],
    ['different port', 'https://collections.example:8443/library/interface-systems'],
    ['lookalike host', 'https://collections.example.attacker.test/library/interface-systems'],
  ] as const)(`does not return 410 for a Canonical URL mismatch: %s ${evidence}`, (_label, url) => {
    expect(responseAt(tombstone(), new Date(deletedAt.getTime() + oneDay), request(url))).toBeNull();
  });

  it(`matches a Canonical URL containing a query only byte-for-byte ${evidence}`, () => {
    const queried = `${canonicalUrl}?edition=2&lang=zh`;
    const value = tombstone({ canonicalUrl: queried });
    const now = new Date(deletedAt.getTime() + oneDay);
    expect(responseAt(value, now, request(queried))?.status).toBe(410);
    expect(responseAt(value, now, request(`${canonicalUrl}?lang=zh&edition=2`))).toBeNull();
    expect(responseAt(value, now, request(`${queried}#section`))).toBeNull();
  });

  it(`preserves lowercase percent escapes as part of exact Canonical URL identity ${evidence}`, () => {
    const escaped = `${canonicalUrl}/%aa`;
    const value = tombstone({ canonicalUrl: escaped });
    const now = new Date(deletedAt.getTime() + oneDay);

    expect(value.canonicalUrl).toBe(escaped);
    expect(responseAt(value, now, request(escaped))?.status).toBe(410);
    expect(responseAt(value, now, request(`${canonicalUrl}/%AA`))).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(`ignores unsupported request method %s ${evidence}`, (method) => {
    const candidate = new Request(canonicalUrl, { method });
    expect(responseAt(tombstone(), new Date(deletedAt.getTime() + oneDay), candidate)).toBeNull();
  });

  it(`keeps GET and HEAD status plus headers identical while HEAD has no body ${evidence}`, async () => {
    const value = tombstone();
    const now = new Date(deletedAt.getTime() + oneDay);
    const get = responseAt(value, now, request(canonicalUrl, 'GET'))!;
    const head = responseAt(value, now, request(canonicalUrl, 'HEAD'))!;

    expect(head.status).toBe(410);
    expect(head.statusText).toBe(get.statusText);
    expect(Array.from(head.headers.entries())).toEqual(Array.from(get.headers.entries()));
    expect(get.headers.get('content-type')).toBe('application/problem+json');
    expect((await get.text()).length).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
    expect(head.body).toBeNull();
  });

  it(`emits a safe RFC 9457 Problem with conservative caching and no request credential reflection ${evidence}`, async () => {
    const secret = 'Bearer publication-private-credential';
    const candidate = request(canonicalUrl, 'GET', {
      Authorization: secret,
      Cookie: 'session=private-session-cookie',
    });
    const response = responseAt(tombstone(), new Date(deletedAt.getTime() + oneDay), candidate)!;
    const serializedHeaders = JSON.stringify(Array.from(response.headers.entries()));
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toMatch(/(?:^|,)\s*(?:private\s*,\s*)?no-store(?:\s*,|$)/iu);
    expect(response.headers.get('cache-control')).not.toMatch(/public|max-age|s-maxage|immutable/iu);
    expect(body).toMatchObject({ status: 410, code: expect.any(String) });
    expect(body.type).toBe(body.code);
    expect(text).not.toMatch(/publication-private-credential|private-session-cookie|interface-systems/iu);
    expect(serializedHeaders).not.toMatch(/publication-private-credential|private-session-cookie/iu);
  });

  it(`does not invent PUB-0039 archive migration or Owner recovery links ${evidence}`, async () => {
    const response = responseAt(tombstone(), new Date(deletedAt.getTime() + oneDay))!;
    const body = await response.json() as Record<string, unknown>;

    expect(response.headers.get('link')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
    expect(body).not.toHaveProperty('links');
    expect(body).not.toHaveProperty('movedTo');
    expect(JSON.stringify(body)).not.toMatch(/archive|migration|moved|owner/iu);
  });

  it(`returns fresh equivalent responses for repeated in-window calls ${evidence}`, async () => {
    const value = tombstone();
    const clock = new MutableClock(new Date(deletedAt.getTime() + oneDay));
    const first = createPublicationDeletedCollectionGoneResponse(request(), value, clock)!;
    const second = createPublicationDeletedCollectionGoneResponse(request(), value, clock)!;

    expect(first).not.toBe(second);
    expect(Array.from(first.headers.entries())).toEqual(Array.from(second.headers.entries()));
    expect(await first.json()).toEqual(await second.json());
  });

  it(`returns 410 again when the same tombstone's clock steps back inside the persisted window ${evidence}`, () => {
    const value = tombstone();
    const clock = new MutableClock(new Date(deletedAt.getTime() + oneDay));
    const ask = (method: 'GET' | 'HEAD'): Response | null => createPublicationDeletedCollectionGoneResponse(
      request(canonicalUrl, method),
      value,
      clock,
    );

    for (const method of ['GET', 'HEAD'] as const) expect(ask(method)?.status).toBe(410);

    clock.value = new Date(deletedAt.getTime() + 30 * oneDay);
    for (const method of ['GET', 'HEAD'] as const) expect(ask(method)).toBeNull();

    clock.value = new Date(deletedAt.getTime() + 29 * oneDay);
    for (const method of ['GET', 'HEAD'] as const) expect(ask(method)?.status).toBe(410);

    clock.value = new Date(deletedAt.getTime() - 1);
    for (const method of ['GET', 'HEAD'] as const) expect(ask(method)).toBeNull();

    clock.value = new Date(deletedAt.getTime());
    for (const method of ['GET', 'HEAD'] as const) expect(ask(method)?.status).toBe(410);
  });

  it(`recomputes 410 from persisted deletion facts for a reissued tombstone ${evidence}`, () => {
    const retentionMilliseconds = 30 * oneDay;
    const first = tombstone({ retentionMilliseconds });
    const pastRetention = new Date(deletedAt.getTime() + retentionMilliseconds);
    expect(createPublicationDeletedCollectionGoneResponse(request(), first, new MutableClock(pastRetention))).toBeNull();

    const reissued = createPublicationDeletedCollectionTombstone({
      canonicalUrl,
      deletedAt: new Date(deletedAt),
      retentionMilliseconds,
    });
    expect(reissued).not.toBe(first);
    expect(reissued.deletedAt).toBe(first.deletedAt);
    expect(reissued.retentionUntil).toBe(first.retentionUntil);

    const inside = new Date(deletedAt.getTime() + retentionMilliseconds - 1);
    const beforeDeletion = new Date(deletedAt.getTime() - 1);
    for (const value of [first, reissued]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const at = (now: Date): Response | null => createPublicationDeletedCollectionGoneResponse(
          request(canonicalUrl, method),
          value,
          new MutableClock(now),
        );
        expect(at(pastRetention)).toBeNull();
        expect(at(inside)?.status).toBe(410);
        expect(at(beforeDeletion)).toBeNull();
      }
    }
  });

  it(`rejects invalid clock output and consults a valid clock exactly once per call ${evidence}`, () => {
    let calls = 0;
    const value = tombstone();
    const clock: PublicationDeletedCollectionClock = {
      now() { calls += 1; return new Date(deletedAt.getTime() + oneDay); },
    };
    expect(createPublicationDeletedCollectionGoneResponse(request(), value, clock)?.status).toBe(410);
    expect(calls).toBe(1);

    const invalidClock: PublicationDeletedCollectionClock = { now: () => new Date(Number.NaN) };
    expect(() => createPublicationDeletedCollectionGoneResponse(request(), tombstone(), invalidClock)).toThrow(TypeError);
  });

  it(`rejects forged tombstones and hostile clock shapes without invoking or reflecting them ${evidence}`, () => {
    let getterCalls = 0;
    let proxyTraps = 0;
    const accessorClock = Object.defineProperty({}, 'now', {
      get() { getterCalls += 1; throw new Error('private-clock-getter'); },
    });
    const hostilePrototype = new Proxy({}, {
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('private-clock-proxy'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('private-clock-proxy'); },
    });
    const inheritedProxyClock = Object.create(hostilePrototype) as PublicationDeletedCollectionClock;

    for (const clock of [accessorClock, inheritedProxyClock]) {
      const error = captureError(() => createPublicationDeletedCollectionGoneResponse(
        request(),
        tombstone(),
        clock as PublicationDeletedCollectionClock,
      ));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toMatch(/private-clock/iu);
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);

    const genuine = tombstone();
    const forged = { ...genuine } as PublicationDeletedCollectionTombstone;
    expect(() => responseAt(forged, new Date(deletedAt.getTime() + oneDay))).toThrow(TypeError);
  });
});
