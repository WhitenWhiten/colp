import { describe, expect, it } from 'vitest';

import {
  buildAnonymousCollectionDirectory,
  buildPublicationAuthorizedCollectionDirectory,
  buildPublicationDiscoveryOutput,
  createAnonymousCollectionDirectoryPage,
  createPublicationAuthorizedDirectoryPage,
  createPublicationDiscoveryPage,
  selectAnonymousDirectoryCandidates,
  selectPublicationAuthorizedDirectoryCandidates,
  selectPublicationDiscoveryCandidates,
} from '../../src/server/index.js';

/**
 * F-08 directory/discovery optimization behavioral regression (not a perf bench).
 *
 * Proves issued pages remain detached snapshots: post-page input mutation must not
 * rewrite an already-issued page, and clone boundaries must isolate siblings so a
 * later optimization cannot share mutable page shells or collection arrays.
 *
 * Existing pub-0009 / pub-0030 / authorized contracts remain the primary green suite.
 */
const anonymousEvidence = '[evidence:http.directory.unlisted]';
const discoveryEvidence = '[evidence:http.unlisted-discovery-controls]';
const authorizedEvidence = '[evidence:http.directory.protected-authorization]';

type Visibility = 'public' | 'unlisted' | 'protected' | 'private';

function directoryCollection(
  id: string,
  visibility: Visibility = 'public',
  overrides: Record<PropertyKey, unknown> = {},
): Record<PropertyKey, unknown> {
  return {
    id,
    canonicalUrl: `https://catalog.example/collections/${id}`,
    title: `Collection ${id}`,
    kind: 'knowledge_collection',
    nodeCount: 3,
    updatedAt: '2026-07-18T00:00:00.000Z',
    visibility,
    links: {
      self: `https://api.example/collections/${id}`,
      canonical: `https://catalog.example/collections/${id}`,
      snapshot: `https://cdn.example/snapshots/${id}.json`,
    },
    ...overrides,
  };
}

interface DiscoveryItem {
  readonly id: string;
  readonly visibility: Visibility;
  readonly updatedAt: string;
  readonly url: string;
}

function discoveryItem(
  id: string,
  visibility: Visibility = 'public',
  overrides: Record<PropertyKey, unknown> = {},
): Record<PropertyKey, unknown> {
  return {
    id,
    visibility,
    updatedAt: '2026-07-18T00:00:00.000Z',
    url: `https://catalog.example/items/${id}`,
    ...overrides,
  };
}

function isPublicDiscoveryItem(value: unknown): value is DiscoveryItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<DiscoveryItem>;
  return candidate.visibility === 'public'
    && typeof candidate.id === 'string'
    && typeof candidate.updatedAt === 'string'
    && typeof candidate.url === 'string';
}

describe('F-08 directory/discovery isolation regression', () => {
  it(`issued pages keep their snapshot after the page input shell is mutated ${anonymousEvidence} ${discoveryEvidence} ${authorizedEvidence}`, () => {
    // --- anonymous Directory (PUB-0009) ---
    const anonymousSelected = selectAnonymousDirectoryCandidates([
      directoryCollection('public-a'),
      directoryCollection('public-b'),
      directoryCollection('hidden', 'unlisted'),
    ]);
    const anonymousPageInput = {
      collections: anonymousSelected.collections.slice(),
      nextCursor: 'anon-cursor-1',
    };
    const anonymousIssued = createAnonymousCollectionDirectoryPage(
      anonymousSelected,
      anonymousPageInput,
    );

    expect(anonymousIssued).not.toBe(anonymousPageInput);
    expect(anonymousIssued.collections).not.toBe(anonymousPageInput.collections);
    expect(anonymousIssued.nextCursor).toBe('anon-cursor-1');
    expect(anonymousIssued.collections.map((item) => item.id)).toEqual(['public-a', 'public-b']);

    anonymousPageInput.nextCursor = 'anon-hijacked';
    anonymousPageInput.collections.pop();
    anonymousPageInput.collections.reverse();
    Reflect.set(anonymousPageInput, 'extra', 'should-not-bleed');

    expect(anonymousIssued.nextCursor).toBe('anon-cursor-1');
    expect(anonymousIssued.collections.map((item) => item.id)).toEqual(['public-a', 'public-b']);
    expect(Object.keys(anonymousIssued).sort()).toEqual(['collections', 'nextCursor']);
    expect(buildAnonymousCollectionDirectory(anonymousIssued)).toEqual({
      protocolVersion: '0.1',
      collections: anonymousIssued.collections,
      nextCursor: 'anon-cursor-1',
    });

    // --- multi-channel discovery (PUB-0030) ---
    const discoverySelected = selectPublicationDiscoveryCandidates(
      'search',
      [
        discoveryItem('public-a'),
        discoveryItem('public-b'),
        discoveryItem('hidden', 'unlisted'),
      ],
      isPublicDiscoveryItem,
    );
    const discoveryPageInput = {
      items: discoverySelected.items.slice(),
      nextCursor: 'search-cursor-1',
    };
    const discoveryIssued = createPublicationDiscoveryPage(discoverySelected, discoveryPageInput);

    expect(discoveryIssued).not.toBe(discoveryPageInput);
    expect(discoveryIssued.items).not.toBe(discoveryPageInput.items);
    expect(discoveryIssued.nextCursor).toBe('search-cursor-1');
    expect(discoveryIssued.items.map((item) => item.id)).toEqual(['public-a', 'public-b']);

    discoveryPageInput.nextCursor = 'search-hijacked';
    discoveryPageInput.items.length = 0;
    Reflect.set(discoveryPageInput, 'channel', 'sitemap');

    expect(discoveryIssued.nextCursor).toBe('search-cursor-1');
    expect(discoveryIssued.channel).toBe('search');
    expect(discoveryIssued.items.map((item) => item.id)).toEqual(['public-a', 'public-b']);
    expect(buildPublicationDiscoveryOutput(discoveryIssued)).toEqual({
      channel: 'search',
      items: discoveryIssued.items,
      nextCursor: 'search-cursor-1',
    });

    // --- authorized Directory (PUB-0031) ---
    const authorizedSelected = selectPublicationAuthorizedDirectoryCandidates([
      directoryCollection('public-a'),
      directoryCollection('protected-a', 'protected'),
      directoryCollection('hidden', 'unlisted'),
    ], (candidate) => candidate.id === 'protected-a');
    const authorizedPageInput = {
      collections: authorizedSelected.collections.slice(),
      nextCursor: 'auth-cursor-1',
    };
    const authorizedIssued = createPublicationAuthorizedDirectoryPage(
      authorizedSelected,
      authorizedPageInput,
    );

    expect(authorizedIssued).not.toBe(authorizedPageInput);
    expect(authorizedIssued.collections).not.toBe(authorizedPageInput.collections);
    expect(authorizedIssued.nextCursor).toBe('auth-cursor-1');
    expect(authorizedIssued.collections.map((item) => item.id)).toEqual([
      'public-a',
      'protected-a',
    ]);

    authorizedPageInput.nextCursor = 'auth-hijacked';
    authorizedPageInput.collections.splice(0, authorizedPageInput.collections.length);

    expect(authorizedIssued.nextCursor).toBe('auth-cursor-1');
    expect(authorizedIssued.collections.map((item) => item.id)).toEqual([
      'public-a',
      'protected-a',
    ]);
    expect(buildPublicationAuthorizedCollectionDirectory(authorizedIssued)).toEqual({
      protocolVersion: '0.1',
      collections: authorizedIssued.collections,
      nextCursor: 'auth-cursor-1',
    });
  });

  it(`clone boundaries isolate sibling pages and later selection reuse ${anonymousEvidence} ${discoveryEvidence} ${authorizedEvidence}`, () => {
    // Same selection yields independent page clones: mutating one page shell
    // is impossible (frozen), and sibling pages never share array/object identity.
    const anonymousSelected = selectAnonymousDirectoryCandidates([
      directoryCollection('public-a', 'public', { tags: ['alpha'] }),
      directoryCollection('public-b', 'public', { tags: ['beta'] }),
    ]);
    const anonymousFirst = createAnonymousCollectionDirectoryPage(anonymousSelected, {
      collections: [anonymousSelected.collections[0]!],
      nextCursor: 'anon-page-1',
    });
    const anonymousSecond = createAnonymousCollectionDirectoryPage(anonymousSelected, {
      collections: anonymousSelected.collections,
      nextCursor: 'anon-page-2',
    });

    expect(anonymousFirst).not.toBe(anonymousSecond);
    expect(anonymousFirst.collections).not.toBe(anonymousSecond.collections);
    expect(anonymousFirst.collections[0]).not.toBe(anonymousSelected.collections[0]);
    expect(anonymousSecond.collections[0]).not.toBe(anonymousSelected.collections[0]);
    expect(anonymousFirst.collections[0]).not.toBe(anonymousSecond.collections[0]);
    expect(anonymousFirst.nextCursor).toBe('anon-page-1');
    expect(anonymousSecond.nextCursor).toBe('anon-page-2');
    expect(anonymousFirst.collections.map((item) => item.id)).toEqual(['public-a']);
    expect(anonymousSecond.collections.map((item) => item.id)).toEqual(['public-a', 'public-b']);
    expect(Object.isFrozen(anonymousFirst)).toBe(true);
    expect(Object.isFrozen(anonymousSecond)).toBe(true);
    expect(Object.isFrozen(anonymousFirst.collections)).toBe(true);
    expect(Object.isFrozen(anonymousSecond.collections)).toBe(true);
    expect(Reflect.set(anonymousFirst as object, 'nextCursor', 'mutated')).toBe(false);
    expect(anonymousFirst.nextCursor).toBe('anon-page-1');
    expect(buildAnonymousCollectionDirectory(anonymousFirst).nextCursor).toBe('anon-page-1');
    expect(buildAnonymousCollectionDirectory(anonymousSecond).nextCursor).toBe('anon-page-2');

    const discoverySelected = selectPublicationDiscoveryCandidates(
      'sitemap',
      [
        discoveryItem('public-a', 'public', { metadata: { labels: ['alpha'] } }),
        discoveryItem('public-b', 'public', { metadata: { labels: ['beta'] } }),
      ],
      isPublicDiscoveryItem,
    );
    const discoveryFirst = createPublicationDiscoveryPage(discoverySelected, {
      items: [discoverySelected.items[0]!],
      nextCursor: 'site-page-1',
    });
    const discoverySecond = createPublicationDiscoveryPage(discoverySelected, {
      items: discoverySelected.items,
      nextCursor: null,
    });

    expect(discoveryFirst).not.toBe(discoverySecond);
    expect(discoveryFirst.items).not.toBe(discoverySecond.items);
    expect(discoveryFirst.items[0]).not.toBe(discoverySelected.items[0]);
    expect(discoverySecond.items[0]).not.toBe(discoverySelected.items[0]);
    expect(discoveryFirst.items[0]).not.toBe(discoverySecond.items[0]);
    expect(discoveryFirst.channel).toBe('sitemap');
    expect(discoverySecond.channel).toBe('sitemap');
    expect(discoveryFirst.nextCursor).toBe('site-page-1');
    expect(discoverySecond.nextCursor).toBeNull();
    expect(buildPublicationDiscoveryOutput(discoveryFirst).items.map((item) => item.id))
      .toEqual(['public-a']);
    expect(buildPublicationDiscoveryOutput(discoverySecond).items.map((item) => item.id))
      .toEqual(['public-a', 'public-b']);

    const authorizedSelected = selectPublicationAuthorizedDirectoryCandidates([
      directoryCollection('public-a'),
      directoryCollection('protected-a', 'protected'),
      directoryCollection('protected-b', 'protected'),
    ], (candidate) => candidate.id.startsWith('protected-'));
    const authorizedFirst = createPublicationAuthorizedDirectoryPage(authorizedSelected, {
      collections: [authorizedSelected.collections[0]!, authorizedSelected.collections[1]!],
      nextCursor: 'auth-page-1',
    });
    const authorizedSecond = createPublicationAuthorizedDirectoryPage(authorizedSelected, {
      collections: authorizedSelected.collections,
      nextCursor: 'auth-page-2',
    });

    expect(authorizedFirst).not.toBe(authorizedSecond);
    expect(authorizedFirst.collections).not.toBe(authorizedSecond.collections);
    expect(authorizedFirst.collections[0]).not.toBe(authorizedSelected.collections[0]);
    expect(authorizedSecond.collections[0]).not.toBe(authorizedSelected.collections[0]);
    expect(authorizedFirst.collections[0]).not.toBe(authorizedSecond.collections[0]);
    expect(authorizedFirst.collections.map((item) => item.id)).toEqual([
      'public-a',
      'protected-a',
    ]);
    expect(authorizedSecond.collections.map((item) => item.id)).toEqual([
      'public-a',
      'protected-a',
      'protected-b',
    ]);
    expect(Object.isFrozen(authorizedFirst.collections[1])).toBe(true);
    expect(buildPublicationAuthorizedCollectionDirectory(authorizedFirst).nextCursor)
      .toBe('auth-page-1');
    expect(buildPublicationAuthorizedCollectionDirectory(authorizedSecond).nextCursor)
      .toBe('auth-page-2');
  });
});
