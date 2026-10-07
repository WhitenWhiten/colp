import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { CatalogDisplayTarget, CatalogPreferencesStore, CatalogPreferencesView } from '../../../src/modules/governance/index.js';
import {
  createSearchGovernanceCursorSigner,
  searchGovernanceBindDigest,
} from '../../../src/modules/governance/index.js';
import { SearchQueryError, type SearchPrincipal, type SearchQueryInput, type SearchQueryResult, type SearchResult } from '../../../src/modules/search/index.js';
import {
  executeSearchWithCatalogPreferences,
  searchCatalogItemKey,
} from '../../../src/transport/product/search-catalog-mute.js';

const hmac = Buffer.alloc(32, 11).toString('base64url');
const principal: SearchPrincipal = {
  kind: 'account',
  accountId: 'acct-1',
  principalId: 'acct-1',
  subjectId: 'sub-1',
  securityEpoch: '1',
};

const emptyPrefs: CatalogPreferencesView = {
  hiddenOwnerAccountIds: [],
  hiddenTags: [],
  hiddenTitleKeywords: [],
  preferredLanguages: [],
  revision: '1',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function collection(id: string, title: string, rank = 1): SearchResult {
  return { resourceType: 'collection', resourceId: id, title, snippet: title, rank };
}

function node(id: string, title: string): SearchResult {
  return { resourceType: 'node', resourceId: id, collectionId: 'col-1', title, urlHost: null, snippet: title, rank: 1 };
}

function profile(handle: string, displayName: string): SearchResult {
  return { resourceType: 'profile', resourceId: handle, handle, displayName, avatarUrl: null, snippet: displayName, rank: 1 };
}

function page(
  items: readonly SearchResult[],
  nextCursor: string | null,
): SearchQueryResult {
  return {
    normalizedQuery: 'notes',
    types: ['collection'],
    items,
    page: { returnedCount: items.length, hasMore: nextCursor !== null, nextCursor },
    cache: { class: 'private-no-store', partition: null },
    consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
  };
}

function store(view: CatalogPreferencesView | null): CatalogPreferencesStore {
  return {
    load: async () => view,
    insertFirst: async () => 'inserted',
    updateIfRevision: async () => true,
  };
}

function facts(
  entries: ReadonlyArray<readonly [SearchResult, CatalogDisplayTarget]>,
): Map<string, Pick<CatalogDisplayTarget, 'ownerAccountId' | 'tags' | 'language'>> {
  const map = new Map<string, Pick<CatalogDisplayTarget, 'ownerAccountId' | 'tags' | 'language'>>();
  for (const [item, target] of entries) {
    map.set(searchCatalogItemKey(item), {
      ownerAccountId: target.ownerAccountId,
      tags: target.tags,
      language: target.language,
    });
  }
  return map;
}

async function run(options: {
  readonly execute: (input: SearchQueryInput) => Promise<SearchQueryResult>;
  readonly targets?: Map<string, Pick<CatalogDisplayTarget, 'ownerAccountId' | 'tags' | 'language'>>;
  readonly prefs?: CatalogPreferencesView | null;
  readonly pageSize?: number;
  readonly cursor?: string;
}): Promise<SearchQueryResult> {
  return executeSearchWithCatalogPreferences({
    query: {
      execute: options.execute,
      ...(options.targets ? { loadCatalogDisplayTargets: async () => options.targets! } : {}),
    },
    input: {
      principal,
      query: 'notes',
      types: ['collection'],
      pageSize: options.pageSize ?? 2,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    catalogPreferences: store(options.prefs === undefined ? emptyPrefs : options.prefs),
    accountCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    hmacKey: hmac,
  });
}

test('empty prefs keep every collection, node, and profile hit', async () => {
  const items = [
    collection('col-1', 'Systems Notes'),
    node('node-1', 'Linked Note'),
    profile('ada', 'Ada Lovelace'),
  ];
  const result = await run({
    execute: async () => page(items, null),
    targets: facts([
      [items[0]!, { ownerAccountId: 'owner-1', tags: ['Design'], title: 'Systems Notes', language: 'en' }],
      [items[1]!, { ownerAccountId: 'owner-1', tags: ['Design'], title: 'Linked Note', language: 'en' }],
      [items[2]!, { ownerAccountId: 'owner-2', tags: [], title: 'Ada Lovelace', language: null }],
    ]),
    prefs: emptyPrefs,
  });
  assert.deepEqual(result.items, items);
  assert.equal(result.page.returnedCount, 3);
});

test('muted collections, nodes, and profiles are dropped', async () => {
  const hiddenCol = collection('col-hidden', 'Spam Notes');
  const keptCol = collection('col-keep', 'Keep Notes');
  const hiddenNode = node('node-hidden', 'Spam Node');
  const hiddenProfile = profile('spamhandle', 'Spam Person');
  const result = await run({
    execute: async () => page([hiddenCol, keptCol, hiddenNode, hiddenProfile], null),
    targets: facts([
      [hiddenCol, { ownerAccountId: 'owner-hide', tags: ['spam'], title: hiddenCol.title, language: 'en' }],
      [keptCol, { ownerAccountId: 'owner-keep', tags: ['ok'], title: keptCol.title, language: 'en' }],
      [hiddenNode, { ownerAccountId: 'owner-hide', tags: [], title: hiddenNode.title, language: 'en' }],
      [hiddenProfile, { ownerAccountId: 'owner-hide', tags: [], title: hiddenProfile.displayName, language: null }],
    ]),
    prefs: { ...emptyPrefs, hiddenOwnerAccountIds: ['owner-hide'] },
  });
  assert.deepEqual(result.items, [keptCol]);
  assert.equal(result.page.hasMore, false);
});

test('filter-then-page fills from a subsequent inner page', async () => {
  const muted = collection('col-muted', 'Hidden Spam Notes');
  const kept = collection('col-keep', 'Keep Alpha Notes');
  const calls: Array<string | undefined> = [];
  const result = await run({
    pageSize: 1,
    execute: async (input) => {
      calls.push(input.cursor);
      if (input.cursor === undefined) return page([muted], 'inner-1');
      assert.equal(input.pageSize, undefined);
      return page([kept], null);
    },
    targets: facts([
      [muted, { ownerAccountId: 'owner-1', tags: ['spam'], title: muted.title, language: 'en' }],
      [kept, { ownerAccountId: 'owner-2', tags: ['ok'], title: kept.title, language: 'en' }],
    ]),
    prefs: { ...emptyPrefs, hiddenTags: ['spam'] },
  });
  assert.deepEqual(calls, [undefined, 'inner-1']);
  assert.deepEqual(result.items, [kept]);
  assert.equal(result.page.returnedCount, 1);
  assert.equal(result.page.hasMore, false);
});

test('outer cursor bind rejects a mismatched preference revision', async () => {
  const kept = collection('col-keep', 'Keep Notes');
  const first = await run({
    pageSize: 1,
    execute: async () => page([kept], 'inner-1'),
    prefs: emptyPrefs,
  });
  assert.equal(typeof first.page.nextCursor, 'string');
  await assert.rejects(
    () => run({
      pageSize: 1,
      cursor: first.page.nextCursor ?? undefined,
      execute: async () => page([kept], 'inner-2'),
      prefs: { ...emptyPrefs, revision: '2', hiddenTitleKeywords: ['keep'] },
    }),
    (error: unknown) => error instanceof SearchQueryError && error.code === 'invalid_cursor',
  );
  const signer = createSearchGovernanceCursorSigner(hmac);
  try {
    const decoded = signer.verify(first.page.nextCursor ?? '', new Date());
    assert.equal(decoded.inner, 'inner-1');
    assert.equal(decoded.bind, searchGovernanceBindDigest({ viewer: 'acct-1', prefRev: '1' }));
    assert.notEqual(decoded.bind, searchGovernanceBindDigest({ viewer: 'acct-1', prefRev: '2' }));
  } finally {
    signer.destroy();
  }
});
