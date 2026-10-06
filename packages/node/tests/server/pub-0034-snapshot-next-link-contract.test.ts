import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPublicationSnapshotPageResponse,
  type PublicationSnapshotNextLinkHeadersInit,
  type PublicationSnapshotPageResponseInit,
} from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:http.snapshot.next-link]';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'collection-snapshot.json',
);
const sameOriginNext = 'https://alice.example/collections/c/id/snapshot?limit=2&pageCursor=cursor-2';
const unrelated = '<https://schema.example/snapshot>; rel="describedby"; type="application/schema+json"';

function snapshot(hasMore = true, nextCursor: string | null = 'cursor-2'): Snapshot {
  const value = JSON.parse(readFileSync(fixturePath, 'utf8')) as Snapshot;
  value.nodes = value.nodes.slice(0, 1);
  value.annotations = [];
  value.attachments = [];
  value.relations = [];
  value.tombstones = [];
  value.page = { sequence: 1, hasMore, nextCursor };
  return value;
}

function create(
  value: unknown = snapshot(),
  init: PublicationSnapshotPageResponseInit = { method: 'GET', nextUrl: sameOriginNext },
): Response {
  return createPublicationSnapshotPageResponse(value, init);
}

function link(response: Response): string | null {
  return response.headers.get('Link');
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected Publication Snapshot response construction to fail.');
}

describe(`PUB-0034 server-provided Snapshot rel=next contract ${evidence}`, () => {
  it(`emits the exact adapter-provided URL for a non-final page ${evidence}`, () => {
    expect(link(create())).toBe(`<${sameOriginNext}>; rel="next"`);
  });

  it(`omits Link for a final page and never fabricates a continuation ${evidence}`, () => {
    const response = create(snapshot(false, null), { method: 'GET' });
    expect(link(response)).toBeNull();
  });

  it.each([
    ['hasMore=true with null nextCursor', snapshot(true, null), sameOriginNext],
    ['hasMore=false with a nextCursor', snapshot(false, 'cursor-2'), undefined],
    ['hasMore=true without a next URL', snapshot(true, 'cursor-2'), undefined],
    ['hasMore=false with a next URL', snapshot(false, null), sameOriginNext],
    ['URL cursor differs from body', snapshot(true, 'cursor-2'), 'https://pages.example/two?pageCursor=other'],
  ] as const)(`rejects body/URL mismatch: %s ${evidence}`, (_label, value, nextUrl) => {
    expect(() => create(value, { method: 'GET', ...(nextUrl === undefined ? {} : { nextUrl }) })).toThrow(TypeError);
  });

  it.each([
    ['same-origin', 'https://alice.example:8443/opaque/batch%2F7.json?include=relations&pageCursor=c%2D2'],
    ['cross-Origin', 'https://cdn.other.example:9443/signed/page.json?sig=a%2Bb%3D&pageCursor=cursor-2'],
  ] as const)(`preserves an exact %s URL without normalization ${evidence}`, (_label, nextUrl) => {
    const value = snapshot();
    value.page.nextCursor = new URL(nextUrl).searchParams.get('pageCursor');
    expect(link(create(value, { method: 'GET', nextUrl }))).toBe(`<${nextUrl}>; rel="next"`);
  });

  it(`does not concatenate the server URL with a base or current request URL ${evidence}`, () => {
    const nextUrl = 'https://edge.example/static/batch-seven.json?token=opaque&pageCursor=cursor-2';
    const result = link(create(snapshot(), { method: 'GET', nextUrl }))!;
    expect(result).toBe(`<${nextUrl}>; rel="next"`);
    expect(result).not.toContain('alice.example/collections/c/id/snapshot');
  });

  it(`merges an unrelated existing Link before rel=next ${evidence}`, () => {
    expect(link(create(snapshot(), {
      method: 'GET',
      nextUrl: sameOriginNext,
      headers: { Link: unrelated },
    }))).toBe(`${unrelated}, <${sameOriginNext}>; rel="next"`);
  });

  it(`deduplicates one exact existing rel=next ${evidence}`, () => {
    const next = `<${sameOriginNext}>; rel="next"`;
    expect(link(create(snapshot(), { method: 'GET', nextUrl: sameOriginNext, headers: { Link: next } }))).toBe(next);
  });

  it.each([
    ['conflicting target', '<https://pages.example/wrong?pageCursor=cursor-2>; rel="next"'],
    ['conflicting cursor', '<https://pages.example/two?pageCursor=wrong>; rel="next"'],
    ['multiple next relations', `<${sameOriginNext}>; rel="next", <https://pages.example/three?pageCursor=cursor-2>; rel="next"`],
    ['mixed-case next relation', '<https://pages.example/wrong?pageCursor=cursor-2>; rel="NEXT"'],
  ] as const)(`rejects an existing %s ${evidence}`, (_label, existing) => {
    expect(() => create(snapshot(), {
      method: 'GET',
      nextUrl: sameOriginNext,
      headers: { Link: existing },
    })).toThrow(TypeError);
  });

  it.each([
    ['missing pageCursor', 'https://pages.example/two?limit=2'],
    ['repeated equal pageCursor', 'https://pages.example/two?pageCursor=cursor-2&pageCursor=cursor-2'],
    ['repeated unequal pageCursor', 'https://pages.example/two?pageCursor=cursor-2&pageCursor=other'],
    ['empty pageCursor', 'https://pages.example/two?pageCursor='],
    ['mismatched encoded pageCursor', 'https://pages.example/two?pageCursor=cursor%252D2'],
  ] as const)(`rejects %s ${evidence}`, (_label, nextUrl) => {
    expect(() => create(snapshot(), { method: 'GET', nextUrl })).toThrow(TypeError);
  });

  it(`allows duplicate non-cursor query fields and preserves their order and spelling ${evidence}`, () => {
    const nextUrl = 'https://pages.example/two?include=relations&x=a%2Bb&x=c%2Fd&pageCursor=cursor-2';
    expect(link(create(snapshot(), { method: 'GET', nextUrl }))).toBe(`<${nextUrl}>; rel="next"`);
  });

  it.each([
    ['a fragment', 'https://pages.example/two?pageCursor=cursor-2#private'],
    ['userinfo', 'https://user:password@pages.example/two?pageCursor=cursor-2'],
    ['file scheme', 'file:///private/page.json?pageCursor=cursor-2'],
    ['javascript scheme', 'javascript:alert(1)?pageCursor=cursor-2'],
    ['non-loopback HTTP URL', 'http://pages.example/two?pageCursor=cursor-2'],
    ['an empty HTTPS authority', 'https:///two?pageCursor=cursor-2'],
    ['an empty scheme-relative authority', '///two?pageCursor=cursor-2'],
    ['malformed percent escape', 'https://pages.example/two?pageCursor=cursor-2&sig=%zz'],
    ['CR injection', 'https://pages.example/two?pageCursor=cursor-2\rX-Injected: yes'],
    ['LF injection', 'https://pages.example/two?pageCursor=cursor-2\nX-Injected: yes'],
  ] as const)(`rejects %s in the supplied URL ${evidence}`, (_label, nextUrl) => {
    expect(() => create(snapshot(), { method: 'GET', nextUrl })).toThrow(TypeError);
  });

  it.each([
    ['path-relative', '../two?limit=2&pageCursor=cursor-2'],
    ['root-relative', '/collections/c/id/snapshot?limit=2&pageCursor=cursor-2'],
    ['scheme-relative', '//pages.example/two?pageCursor=cursor-2'],
    ['query-relative', '?limit=2&pageCursor=cursor-2'],
    ['loopback HTTP', 'http://localhost:8080/two?pageCursor=cursor-2'],
  ] as const)(`preserves an exact %s server URL reference ${evidence}`, (_label, nextUrl) => {
    expect(link(create(snapshot(), { method: 'GET', nextUrl }))).toBe(`<${nextUrl}>; rel="next"`);
  });

  it(`exposes one unambiguous nextUrl response option ${evidence}`, () => {
    expect(() => create(snapshot(), {
      method: 'GET',
      serverNextUrl: sameOriginNext,
    } as PublicationSnapshotPageResponseInit)).toThrow(TypeError);
  });

  it(`accepts the maximum bounded URL and rejects the next byte ${evidence}`, () => {
    const prefix = 'https://pages.example/two?padding=';
    const suffix = '&pageCursor=cursor-2';
    const accepted = `${prefix}${'a'.repeat(16_384 - prefix.length - suffix.length)}${suffix}`;
    expect(link(create(snapshot(), { method: 'GET', nextUrl: accepted }))).toBe(`<${accepted}>; rel="next"`);
    const rejected = `${prefix}${'a'.repeat(16_385 - prefix.length - suffix.length)}${suffix}`;
    expect(() => create(snapshot(), { method: 'GET', nextUrl: rejected })).toThrow(RangeError);
  });

  it(`accepts 128 query fields and rejects the 129th ${evidence}`, () => {
    const query = Array.from({ length: 127 }, (_unused, index) => `x=${index}`).join('&');
    const accepted = `https://pages.example/two?${query}&pageCursor=cursor-2`;
    expect(link(create(snapshot(), { method: 'GET', nextUrl: accepted }))).toBe(`<${accepted}>; rel="next"`);
    const rejected = `https://pages.example/two?${query}&x=overflow&pageCursor=cursor-2`;
    expect(() => create(snapshot(), { method: 'GET', nextUrl: rejected })).toThrow(RangeError);
  });

  it.each([
    ['CRLF injection', { Link: `${unrelated}\r\nX-Injected: yes` }],
    ['malformed Link syntax', { Link: 'not-a-link-value' }],
    ['credentialed existing target', { Link: '<https://user:pass@pages.example/two>; rel="help"' }],
    ['non-HTTP existing target', { Link: '<file:///private/page>; rel="help"' }],
  ] as const)(`rejects unsafe existing headers: %s ${evidence}`, (_label, headers) => {
    expect(() => create(snapshot(), { method: 'GET', nextUrl: sameOriginNext, headers })).toThrow(TypeError);
  });

  it(`accepts 128 caller headers and rejects the 129th for tuple and Headers inputs ${evidence}`, () => {
    const entries: [string, string][] = Array.from(
      { length: 128 },
      (_unused, index) => [`X-Metadata-${index}`, `${index}`],
    );
    expect(create(snapshot(), { method: 'GET', nextUrl: sameOriginNext, headers: entries }).headers.get('X-Metadata-127')).toBe('127');
    expect(() => create(snapshot(), {
      method: 'GET',
      nextUrl: sameOriginNext,
      headers: [...entries, ['X-Overflow', 'yes']],
    })).toThrow(TypeError);
    expect(() => create(snapshot(), {
      method: 'GET',
      nextUrl: sameOriginNext,
      headers: new Headers([...entries, ['X-Overflow', 'yes']]),
    })).toThrow(TypeError);
  });

  it.each(['GET', 'HEAD'] as const)(`publishes the same continuation and caller metadata for %s ${evidence}`, (method) => {
    const response = create(snapshot(), {
      method,
      nextUrl: sameOriginNext,
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Origin, Authorization',
        Origin: 'https://app.example',
        ETag: '"snapshot-page-1"',
      },
    });
    expect(link(response)).toBe(`<${sameOriginNext}>; rel="next"`);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Origin, Authorization');
    expect(response.headers.get('Origin')).toBe('https://app.example');
    expect(response.headers.get('ETag')).toBe('"snapshot-page-1"');
    if (method === 'HEAD') expect(response.body).toBeNull();
  });

  it(`keeps GET and HEAD status plus headers identical while HEAD has no body ${evidence}`, async () => {
    const get = create(snapshot(), { method: 'GET', nextUrl: sameOriginNext });
    const head = create(snapshot(), { method: 'HEAD', nextUrl: sameOriginNext });
    expect(Array.from(head.headers.entries())).toEqual(Array.from(get.headers.entries()));
    expect(await get.json()).toMatchObject({ page: { hasMore: true, nextCursor: 'cursor-2' } });
    expect(await head.text()).toBe('');
  });

  it.each([300, 400, 401, 403, 404, 409, 422, 500, 503])(
    `removes success rel=next on status %s while preserving unrelated headers ${evidence}`,
    (status) => {
      const response = create({ type: 'about:blank', status }, {
        method: 'HEAD',
        status,
        headers: {
          Link: `${unrelated}, <${sameOriginNext}>; rel="next"`,
          'Cache-Control': 'private, no-store',
          Vary: 'Origin, Authorization',
          Origin: 'https://app.example',
        },
      });
      expect(link(response)).toBe('<https://schema.example/snapshot>; rel=describedby; type="application/schema+json"');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Vary')).toBe('Origin, Authorization');
      expect(response.headers.get('Origin')).toBe('https://app.example');
      expect(response.body).toBeNull();
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get', 'head', ''])(
    `rejects unsupported method %j ${evidence}`,
    (method) => expect(() => create(snapshot(), {
      method,
      nextUrl: sameOriginNext,
    } as PublicationSnapshotPageResponseInit)).toThrow(TypeError),
  );

  it(`rejects accessor and Proxy headers without invoking hostile code ${evidence}`, () => {
    let getterCalls = 0;
    let traps = 0;
    const accessor = Object.defineProperty({}, 'Link', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('getter-secret'); },
    });
    const proxied = new Proxy({ Vary: 'Origin' }, {
      get() { traps += 1; throw new Error('proxy-secret'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('proxy-secret'); },
      getPrototypeOf() { traps += 1; throw new Error('proxy-secret'); },
      ownKeys() { traps += 1; throw new Error('proxy-secret'); },
    });
    for (const headers of [accessor, proxied]) {
      const error = captureError(() => create(snapshot(), {
        method: 'GET',
        nextUrl: sameOriginNext,
        headers: headers as PublicationSnapshotNextLinkHeadersInit,
      }));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toMatch(/(getter|proxy)-secret/u);
    }
    expect(getterCalls).toBe(0);
    expect(traps).toBe(0);
  });

  it(`rejects accessor, Proxy, and mutable hostile response options ${evidence}`, () => {
    let getterCalls = 0;
    let traps = 0;
    const accessor = Object.defineProperty({ method: 'GET' }, 'nextUrl', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('next-getter-secret'); },
    });
    const proxy = new Proxy({ method: 'GET', nextUrl: sameOriginNext }, {
      get() { traps += 1; throw new Error('init-proxy-secret'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('init-proxy-secret'); },
      getPrototypeOf() { traps += 1; throw new Error('init-proxy-secret'); },
      ownKeys() { traps += 1; throw new Error('init-proxy-secret'); },
    });
    for (const init of [accessor, proxy]) {
      const error = captureError(() => create(snapshot(), init as PublicationSnapshotPageResponseInit));
      expect(error.message).not.toMatch(/(next-getter|init-proxy)-secret/u);
    }
    expect(getterCalls).toBe(0);
    expect(traps).toBe(0);
  });

  it(`rejects accessor-bearing and Proxy Snapshot bodies without invoking traps ${evidence}`, () => {
    let getterCalls = 0;
    let traps = 0;
    const accessor = Object.defineProperty(snapshot(), 'page', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('page-getter-secret'); },
    });
    const proxied = new Proxy(snapshot(), {
      get() { traps += 1; throw new Error('body-proxy-secret'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('body-proxy-secret'); },
      getPrototypeOf() { traps += 1; throw new Error('body-proxy-secret'); },
      ownKeys() { traps += 1; throw new Error('body-proxy-secret'); },
    });
    for (const body of [accessor, proxied]) {
      const error = captureError(() => create(body));
      expect(error.message).not.toMatch(/(page-getter|body-proxy)-secret/u);
    }
    expect(getterCalls).toBe(0);
    expect(traps).toBe(0);
  });

  it(`detaches body, URL, and header data from later source mutation ${evidence}`, async () => {
    const value = snapshot();
    const headers = { Link: unrelated, Vary: 'Origin' };
    const init = { method: 'GET', nextUrl: sameOriginNext, headers } as const;
    const response = create(value, init);
    value.page.nextCursor = 'mutated';
    value.collection.title = 'mutated';
    headers.Link = '<https://attacker.example>; rel="next"';
    expect(link(response)).toBe(`${unrelated}, <${sameOriginNext}>; rel="next"`);
    expect((await response.json() as Snapshot).collection.title).not.toBe('mutated');
  });

  it(`returns independently mutable Response instances ${evidence}`, () => {
    const first = create();
    const second = create();
    first.headers.set('Link', '<https://attacker.example>; rel="next"');
    first.headers.set('Vary', 'X-Attacker');
    expect(link(second)).toBe(`<${sameOriginNext}>; rel="next"`);
    expect(second.headers.get('Vary')).toBeNull();
  });
});
