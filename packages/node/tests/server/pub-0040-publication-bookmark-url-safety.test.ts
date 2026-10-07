import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import {
  assertPublicationSnapshotBookmarkUrls,
  createPublicationSnapshotNextLinkHeader,
  createPublicationSnapshotPageResponse,
  createPublicationSnapshotPageSeries,
  createPublicationSnapshotResponse,
  createPublicationSnapshotSinglePageResponse,
  mergePublicationSnapshotNextLinkHeaders,
  planPublicationSnapshotDelivery,
  releasePublicationSnapshotPage,
  type PublicationCollectionClassification,
  type PublicationSnapshotSinglePagePlan,
} from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:publication.bookmark-url-safety]';
const publicationFixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'collection-snapshot.json',
);
const syncFixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'sync-snapshot.json',
);

type PublicationVisibility = 'public' | 'protected' | 'private';

const unsafeUrls = [
  ['raw username', 'https://alice@example.test/private'],
  ['raw username and password', 'https://alice:secret@example.test/private'],
  ['password-only userinfo', 'https://:secret@example.test/private'],
  ['percent-encoded username data', 'https://alice%40corp@example.test/private'],
  ['percent-encoded colon in userinfo', 'https://alice%3Asecret@example.test/private'],
  ['FTP', 'ftp://files.example.test/private'],
  ['mailto', 'mailto:alice@example.test'],
  ['custom absolute scheme', 'git+ssh://git.example.test/private'],
  ['relative reference', '/private/bookmark'],
  ['scheme-relative reference', '//example.test/private'],
  ['malformed percent escape', 'https://example.test/%zz'],
] as const;

const safeUrls = [
  ['same-origin HTTPS', 'https://alice.example/collections/interface-systems?view=full'],
  ['cross-Origin HTTPS', 'https://cdn.other.example:9443/signed/item?sig=a%2Bb%3D'],
  ['mixed-case HTTP scheme', 'HtTp://localhost:8080/Bookmark?Q=Exact'],
  ['mixed-case HTTPS scheme', 'hTtPs://Example.TEST:443/%7Ealice?Q=A%2Fb'],
  ['encoded colon and at-sign in query', 'https://example.test/search?q=alice%3Asecret%40host&next=%2Fsafe'],
] as const;

function fixture(): Snapshot {
  return JSON.parse(readFileSync(publicationFixturePath, 'utf8')) as Snapshot;
}

function syncFixture(): Snapshot {
  return JSON.parse(readFileSync(syncFixturePath, 'utf8')) as Snapshot;
}

function bookmarkSnapshot(
  url: string,
  visibility: PublicationVisibility = 'public',
  page: { readonly sequence: number; readonly hasMore: boolean; readonly nextCursor: string | null } = {
    sequence: 1,
    hasMore: false,
    nextCursor: null,
  },
): Snapshot {
  const value = fixture();
  value.collection.visibility = visibility;
  const bookmark = value.nodes.find((node) => node.kind === 'bookmark');
  if (bookmark === undefined || bookmark.kind !== 'bookmark' || bookmark.redacted === true) {
    throw new TypeError('Fixture must contain a non-redacted Bookmark.');
  }
  (bookmark as { url: string }).url = url;
  if (visibility !== 'public') (bookmark as { visibility?: PublicationVisibility }).visibility = visibility;
  value.page = { ...page };
  value.complete = !page.hasMore;
  return value;
}

function redactedSnapshot(visibility: 'protected' | 'private'): Snapshot {
  const value = bookmarkSnapshot('https://discarded.example/', visibility);
  const index = value.nodes.findIndex((node) => node.kind === 'bookmark');
  const original = value.nodes[index]!;
  const { url: _url, canonicalUrl: _canonicalUrl, urlHash: _urlHash, ...rest } = original as typeof original & {
    readonly url?: string;
    readonly canonicalUrl?: string;
    readonly urlHash?: string;
  };
  value.nodes[index] = {
    ...rest,
    redacted: true,
    visibility,
    accessUrl: 'https://alice.example/access/restricted',
  } as Snapshot['nodes'][number];
  return value;
}

function bookmarkUrl(snapshot: Snapshot): string | undefined {
  const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark');
  return bookmark !== undefined && bookmark.kind === 'bookmark' && bookmark.redacted !== true
    ? bookmark.url
    : undefined;
}

function singlePagePlan(
  snapshot: Snapshot,
  classification: PublicationCollectionClassification = 'dynamic',
): PublicationSnapshotSinglePagePlan {
  const plan = planPublicationSnapshotDelivery({ classification, query: {}, snapshot });
  expect(plan.delivery).toBe('single-page');
  return plan as PublicationSnapshotSinglePagePlan;
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return error as Error;
  }
  throw new Error('Expected unsafe Publication Snapshot serialization to fail.');
}

describe(`PUB-0040 Publication Bookmark URL safety ${evidence}`, () => {
  it.each(safeUrls)(`accepts and preserves an exact safe %s ${evidence}`, async (_label, url) => {
    const value = bookmarkSnapshot(url);
    assertPublicationSnapshotBookmarkUrls(value);

    const response = createPublicationSnapshotPageResponse(value, { method: 'GET' });
    const serialized = await response.clone().text();
    expect(bookmarkUrl(await response.json() as Snapshot)).toBe(url);
    expect(serialized).toContain(JSON.stringify(url).slice(1, -1));
  });

  it.each(['public', 'protected', 'private'] as const)(
    `does not let %s Collection visibility or authorization relax the URL rule ${evidence}`,
    (visibility) => {
      for (const [_label, url] of unsafeUrls.slice(0, 8)) {
        const value = bookmarkSnapshot(url, visibility);
        expect(() => assertPublicationSnapshotBookmarkUrls(value)).toThrow(TypeError);
        expect(() => createPublicationSnapshotPageResponse(value, { method: 'GET' })).toThrow(TypeError);
        expect(() => planPublicationSnapshotDelivery({
          classification: 'dynamic',
          query: {},
          snapshot: value,
        })).toThrow(TypeError);
      }
    },
  );

  it.each(unsafeUrls)(`rejects hostile or malformed %s without reflecting credentials ${evidence}`, (_label, url) => {
    const value = bookmarkSnapshot(url);
    for (const operation of [
      () => assertPublicationSnapshotBookmarkUrls(value),
      () => createPublicationSnapshotPageResponse(value, { method: 'GET' }),
      () => planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: value }),
    ]) {
      const error = captureError(operation);
      expect(error.message).not.toContain(url);
      expect(error.message).not.toContain('alice:secret');
      expect(error.message).not.toContain(':secret@');
    }
  });

  it.each(['protected', 'private'] as const)(
    `allows an authorized %s redacted Bookmark to omit url ${evidence}`,
    async (visibility) => {
      const value = redactedSnapshot(visibility);
      assertPublicationSnapshotBookmarkUrls(value);
      const response = createPublicationSnapshotPageResponse(value, { method: 'GET', access: 'authorized-private' });
      const body = await response.json() as Snapshot;
      expect(body.nodes.find((node) => node.kind === 'bookmark')).not.toHaveProperty('url');
    },
  );

  it(`guards every exported Snapshot response/header serialization entry ${evidence}`, async () => {
    const unsafe = bookmarkSnapshot('https://alice:secret@example.test/private');
    expect(() => createPublicationSnapshotNextLinkHeader(unsafe)).toThrow(TypeError);
    expect(() => mergePublicationSnapshotNextLinkHeaders(unsafe)).toThrow(TypeError);
    expect(() => createPublicationSnapshotPageResponse(unsafe, { method: 'GET' })).toThrow(TypeError);
    expect(() => createPublicationSnapshotResponse(unsafe, { method: 'GET' })).toThrow(TypeError);

    const safe = bookmarkSnapshot('https://safe.example.test/exact%2Fbookmark?x=A%2Bb');
    expect(createPublicationSnapshotNextLinkHeader(safe)).toBeUndefined();
    expect(mergePublicationSnapshotNextLinkHeaders(safe).get('Link')).toBeNull();
    expect(bookmarkUrl(await createPublicationSnapshotResponse(safe, { method: 'GET' }).json() as Snapshot))
      .toBe('https://safe.example.test/exact%2Fbookmark?x=A%2Bb');
  });

  it.each(['GET', 'HEAD'] as const)(`rejects unsafe successful %s responses ${evidence}`, (method) => {
    const value = bookmarkSnapshot('https://alice:secret@example.test/private');
    expect(() => createPublicationSnapshotPageResponse(value, { method })).toThrow(TypeError);
    expect(() => createPublicationSnapshotPageResponse(value, { method, status: 304 })).toThrow(TypeError);
  });

  it(`keeps ordinary error bodies and stale navigation metadata credential-free ${evidence}`, async () => {
    const credential = 'alice:secret@example.test';
    const response = createPublicationSnapshotPageResponse(
      { type: 'about:blank', title: 'Not Found', status: 404 },
      {
        method: 'GET',
        status: 404,
        nextUrl: `https://${credential}/next?pageCursor=secret`,
        headers: {
          Link: '<https://safe.example.test/docs>; rel="describedby", <https://old.example.test/?pageCursor=old>; rel="next"',
          'X-Request-Id': 'request-40',
        },
      },
    );
    const serialized = `${await response.text()}\n${[...response.headers].map(([key, value]) => `${key}: ${value}`).join('\n')}`;
    expect(response.status).toBe(404);
    expect(response.headers.get('Link')).toBe('<https://safe.example.test/docs>; rel=describedby');
    expect(response.headers.get('X-Request-Id')).toBe('request-40');
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('pageCursor=secret');
  });

  it.each(['static', 'dynamic'] as const)(
    `preserves safe exact URLs through the %s delivery planner and single-page response ${evidence}`,
    async (classification) => {
      const url = 'hTtPs://Example.TEST:443/%7Ealice?q=user%3Apass%40host';
      const plan = singlePagePlan(bookmarkSnapshot(url), classification);
      expect(bookmarkUrl(plan.snapshot)).toBe(url);
      const get = createPublicationSnapshotSinglePageResponse(plan, { method: 'GET' });
      const head = createPublicationSnapshotSinglePageResponse(plan, { method: 'HEAD' });
      expect(bookmarkUrl(await get.json() as Snapshot)).toBe(url);
      expect(await head.text()).toBe('');
      expect(head.headers.get('content-type')).toBe('application/json; charset=utf-8');
    },
  );

  it(`rejects unsafe URLs on every paginated page while retaining safe Link behavior ${evidence}`, async () => {
    const nextUrl = 'https://pages.example.test/snapshot?pageCursor=cursor-2';
    const first = bookmarkSnapshot('https://safe.example.test/page-one', 'public', {
      sequence: 1,
      hasMore: true,
      nextCursor: 'cursor-2',
    });
    const firstResponse = createPublicationSnapshotPageResponse(first, { method: 'GET', nextUrl });
    expect(firstResponse.headers.get('Link')).toBe(`<${nextUrl}>; rel="next"`);
    expect(bookmarkUrl(await firstResponse.json() as Snapshot)).toBe('https://safe.example.test/page-one');

    for (const value of [
      bookmarkSnapshot('https://alice:secret@example.test/page-one', 'public', {
        sequence: 1,
        hasMore: true,
        nextCursor: 'cursor-2',
      }),
      bookmarkSnapshot('ftp://files.example.test/page-two', 'private', {
        sequence: 2,
        hasMore: false,
        nextCursor: null,
      }),
    ]) {
      expect(() => createPublicationSnapshotPageResponse(value, {
        method: 'GET',
        ...(value.page.hasMore ? { nextUrl } : {}),
      })).toThrow(TypeError);
    }
  });

  it(`guards creation and continuation release for the paginated page-series delivery API ${evidence}`, () => {
    const first = bookmarkSnapshot('https://safe.example.test/page-one', 'protected', {
      sequence: 1,
      hasMore: true,
      nextCursor: 'cursor-2',
    });
    const scope = {
      principal: 'authorized:alice',
      query: { include: ['annotations', 'attachments', 'relations'], limit: 25 },
    } as const;
    const started = createPublicationSnapshotPageSeries(first, scope);
    expect(bookmarkUrl(started.page)).toBe('https://safe.example.test/page-one');

    const second = bookmarkSnapshot('https://alice:secret@example.test/page-two', 'protected', {
      sequence: 2,
      hasMore: false,
      nextCursor: null,
    });
    expect(() => releasePublicationSnapshotPage(started.series, second, {
      principal: scope.principal,
      query: { ...scope.query, pageCursor: 'cursor-2' },
    })).toThrow(TypeError);
    expect(() => createPublicationSnapshotPageSeries(second, scope)).toThrow(TypeError);
  });

  it(`leaves broad Sync Bookmark URL semantics intact but refuses Sync at the Publication boundary ${evidence}`, () => {
    const sync = syncFixture();
    const bookmark = sync.nodes.find((node) => node.kind === 'bookmark');
    if (bookmark === undefined || bookmark.kind !== 'bookmark' || bookmark.redacted === true) {
      throw new TypeError('Sync fixture must contain a non-redacted Bookmark.');
    }
    (bookmark as { url: string }).url = 'ftp://files.example.test/authoritative-source';

    expect(validateSnapshotSemantics(sync)).toEqual({ valid: true, issues: [] });
    expect(() => assertPublicationSnapshotBookmarkUrls(sync)).toThrow(TypeError);
    expect(() => createPublicationSnapshotPageResponse(sync, { method: 'GET' })).toThrow(TypeError);
    expect(() => planPublicationSnapshotDelivery({ classification: 'dynamic', query: {}, snapshot: sync }))
      .toThrow(TypeError);
  });
});
