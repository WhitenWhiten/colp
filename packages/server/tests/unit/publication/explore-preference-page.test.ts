import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildExplorePageStatement } from '../../../src/infrastructure/publication/postgres-explore-page.js';
import {
  EXPLORE_POPULAR_AGGREGATIONS_PER_REQUEST,
  EXPLORE_PREFERENCE_SCAN_ROW_BUDGET,
  type ExplorePageReadPort,
  type ExplorePageRecord,
} from '../../../src/modules/publication/index.js';
import {
  isHiddenByCatalogPreferences,
  type CatalogPreferencesView,
} from '../../../src/modules/governance/index.js';
import {
  loadEligibleExplorePage,
  selectExplorePreferencePage,
} from '../../../src/transport/product/explore-preference-page.js';
import {
  EXPLORE_UNKNOWN_CREATOR,
  exploreCreatorFilterAccountId,
  mapExploreCreatorDto,
} from '../../../src/transport/product/explore-routes.js';

const window = { fromDayInclusive: '2026-01-01', toDayExclusive: '2026-01-31' };

const emptyPrefs: CatalogPreferencesView = {
  hiddenOwnerAccountIds: [],
  hiddenTags: [],
  hiddenTitleKeywords: [],
  preferredLanguages: [],
  revision: '1',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function record(id: string, extras: Partial<ExplorePageRecord> = {}): ExplorePageRecord {
  return {
    id,
    ownerSubjectId: `subject-${id}`,
    title: extras.title ?? `Title ${id}`,
    summary: null,
    kind: 'bookmarks',
    visibility: 'public',
    publicationSlug: id,
    tags: extras.tags ?? [],
    language: extras.language === undefined ? 'en' : extras.language,
    ownerAccountId: extras.ownerAccountId ?? 'owner-visible',
    nodeCount: extras.nodeCount ?? 1,
    orderingNodeCount: extras.orderingNodeCount ?? 4,
    viewCount: extras.viewCount ?? 0,
    updatedAt: '2026-08-01T00:00:00.000Z',
    orderingUpdatedAtMicros: extras.orderingUpdatedAtMicros ?? String(1_000 + Number(id.replace(/\D/gu, '') || 0)),
    hiddenPublic: false,
    ...(extras.preferenceHidden === undefined ? {} : { preferenceHidden: extras.preferenceHidden }),
  };
}

test('preference window resumes at the last returned match and does not mix display count', () => {
  const rows = [
    record('1', { orderingNodeCount: 9, nodeCount: 1 }),
    record('2', { orderingNodeCount: 8, nodeCount: 7 }),
    record('3', { orderingNodeCount: 7, nodeCount: 9 }),
  ];
  const page = selectExplorePreferencePage({
    window: rows, limit: 1, budget: 10, prefs: emptyPrefs,
  });
  assert.equal(page.records[0]?.id, '1');
  assert.equal(page.records[0]?.nodeCount, 1);
  assert.equal(page.resume?.orderingNodeCount, 9);
  assert.notEqual(page.resume?.nodeCount, page.resume?.orderingNodeCount);
  assert.equal(page.budgetExhausted, false);
});

test('budget exhaustion on an empty page keeps a resume cursor', () => {
  const hidden = [record('1'), record('2'), record('3')].map((row) => ({
    ...row, preferenceHidden: true,
  }));
  const page = selectExplorePreferencePage({
    window: hidden, limit: 2, budget: 2, prefs: emptyPrefs,
  });
  assert.deepEqual(page.records, []);
  assert.equal(page.budgetExhausted, true);
  assert.equal(page.resume?.id, '2');
});

test('a short window without a probe is the end of the catalog', () => {
  const page = selectExplorePreferencePage({
    window: [{ ...record('1'), preferenceHidden: true }],
    limit: 2,
    budget: 2,
    prefs: emptyPrefs,
  });
  assert.deepEqual(page.records, []);
  assert.equal(page.resume, null);
  assert.equal(page.budgetExhausted, false);
});

test('owner, tag, keyword, and language rules match the application predicate', () => {
  const prefs: CatalogPreferencesView = {
    ...emptyPrefs,
    hiddenOwnerAccountIds: ['owner-hide'],
    hiddenTags: ['Design'],
    hiddenTitleKeywords: ['notes'],
    preferredLanguages: ['en'],
  };
  const rows = [
    record('owner', { ownerAccountId: 'owner-hide', title: 'Keep' }),
    record('tag', { tags: ['Design'], title: 'Keep' }),
    record('tag-case', { tags: ['design'], title: 'Keep' }),
    record('keyword', { title: 'Systems Notes' }),
    record('keyword-case', { title: 'NOTES elsewhere' }),
    record('language-null', { language: null, title: 'Keep' }),
    record('language-fr', { language: 'fr', title: 'Keep' }),
    record('keep', { title: 'Keep', language: 'en', tags: ['design'] }),
  ];
  const page = selectExplorePreferencePage({
    window: rows, limit: 10, budget: 10, prefs,
  });
  assert.deepEqual(page.records.map((row) => row.id), ['tag-case', 'keep']);
  for (const row of rows) {
    const hidden = isHiddenByCatalogPreferences({
      ownerAccountId: row.ownerAccountId ?? '',
      tags: row.tags,
      title: row.title,
      language: row.language,
    }, prefs);
    assert.equal(page.records.some((item) => item.id === row.id), !hidden, row.id);
  }
});

test('one preference request calls the page reader once and passes the scan budget', async () => {
  let calls = 0;
  const port: ExplorePageReadPort = {
    async loadPage(request) {
      calls += 1;
      assert.equal(request.scanBudget, EXPLORE_PREFERENCE_SCAN_ROW_BUDGET);
      assert.deepEqual(request.catalogPreference?.hiddenTitleKeywords, ['notes']);
      const budget = request.scanBudget ?? 0;
      return Array.from({ length: budget + 1 }, (_, index) => record(String(index), {
        title: `Systems Notes ${index}`,
      }));
    },
  };
  const page = await loadEligibleExplorePage(port, {
    filter: {},
    sort: 'popular',
    limit: 24,
    prefs: { ...emptyPrefs, hiddenTitleKeywords: ['notes'] },
  });
  assert.equal(calls, EXPLORE_POPULAR_AGGREGATIONS_PER_REQUEST);
  assert.equal(page.records.length, 0);
  assert.equal(page.budgetExhausted, true);
  assert.equal(page.resume?.id, String(EXPLORE_PREFERENCE_SCAN_ROW_BUDGET - 1));
});

test('popular preference SQL aggregates the 30-day view once and binds every mute', () => {
  const statement = buildExplorePageStatement({
    filter: {},
    sort: 'popular',
    limit: 24,
    scanBudget: EXPLORE_PREFERENCE_SCAN_ROW_BUDGET,
    catalogPreference: {
      hiddenOwnerAccountIds: ['owner-1'],
      hiddenTags: ['Design'],
      hiddenTitleKeywords: ['notes'],
      preferredLanguages: ['en'],
    },
  }, window);
  assert.equal(
    statement.text.match(/view_counts as materialized/gu)?.length,
    EXPLORE_POPULAR_AGGREGATIONS_PER_REQUEST,
  );
  assert.equal(statement.values.filter((value) => value === EXPLORE_PREFERENCE_SCAN_ROW_BUDGET + 1).length, 1);
  assert.ok(statement.values.some((value) => Array.isArray(value) && value[0] === 'owner-1'));
  assert.ok(statement.values.some((value) => Array.isArray(value) && value[0] === 'Design'));
  assert.ok(statement.values.some((value) => Array.isArray(value) && value[0] === 'notes'));
  assert.ok(statement.values.some((value) => Array.isArray(value) && value[0] === 'en'));
  assert.match(statement.text, /lower\(normalize\(coalesce\(ranked\.title, ''\)\) collate "und-x-icu"\)/u);
  assert.doesNotMatch(statement.text, /GREATEST\s*\(/u);
});

test('links order and keyset use raw live_node_count, not the displayed count', () => {
  const statement = buildExplorePageStatement({
    filter: {}, sort: 'links', limit: 10,
    after: { micros: '10', id: 'cursor-id', nodeCount: 4 },
  }, window);
  assert.match(statement.text, /c\.live_node_count as ordering_node_count/u);
  assert.match(statement.text, /order by c\.live_node_count desc/u);
  assert.match(statement.text, /order by page\.ordering_node_count desc/u);
  assert.match(statement.text, /c\.live_node_count < \$/u);
  assert.doesNotMatch(statement.text, /order by page\.node_count/u);
  assert.doesNotMatch(statement.text, /GREATEST\s*\(/u);
});

test('restricted creator DTO is one sentinel and is not a filter key', () => {
  const restricted = mapExploreCreatorDto('subject-secret', {
    ownerSubjectId: 'subject-secret',
    accountId: 'account-secret',
    displayName: 'Ada',
    handle: 'ada',
    avatarUrl: 'https://cdn.example/ada.png',
    publicationRestricted: true,
  });
  assert.deepEqual(restricted, EXPLORE_UNKNOWN_CREATOR);
  assert.equal(JSON.stringify(restricted).includes('subject-secret'), false);
  assert.equal(JSON.stringify(restricted).includes('account-secret'), false);
  assert.equal(JSON.stringify(restricted).includes('ada'), false);
  assert.equal(exploreCreatorFilterAccountId(restricted.id), null);
  assert.equal(exploreCreatorFilterAccountId('subject:subject-secret'), null);
  assert.equal(exploreCreatorFilterAccountId('account:account-ok'), 'account-ok');
  const visible = mapExploreCreatorDto('subject-ok', {
    ownerSubjectId: 'subject-ok',
    accountId: 'account-ok',
    displayName: 'Ada',
    handle: 'ada',
    avatarUrl: null,
  });
  assert.equal(visible.id, 'account:account-ok');
  assert.equal(mapExploreCreatorDto('subject-missing', undefined).id, 'subject:subject-missing');
});
