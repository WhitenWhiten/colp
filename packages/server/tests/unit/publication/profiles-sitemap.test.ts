import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildProfilesSitemapUrlset,
  PROFILES_SITEMAP_MAX_BYTES,
  PROFILES_SITEMAP_MAX_URLS,
  profilesSitemapLastmod,
} from '../../../src/infrastructure/http/index.js';
import {
  buildProfileSitemapStatement,
  PROFILE_SITEMAP_CANDIDATE_LIMIT,
} from '../../../src/infrastructure/publication/postgres-profile-sitemap-read.js';
import { composeProfileSitemapQuery } from '../../../src/bootstrap/public-profile-projection.js';

test('profile sitemap SQL pins the M-09 identity, publication, and usable-root authority', () => {
  const statement = buildProfileSitemapStatement();
  assert.match(statement.text, /join accounts a/u);
  assert.match(statement.text, /a\.status = 'active'/u);
  assert.match(statement.text, /a\.deleted_at is null/u);
  assert.match(statement.text, /join profiles p/u);
  assert.match(statement.text, /from profile_handles h/u);
  assert.match(statement.text, /c\.owner_subject_id = a\.subject_id/u);
  assert.match(statement.text, /c\.visibility = \$1/u);
  assert.match(statement.text, /c\.deleted_at is null/u);
  assert.match(statement.text, /c\.publication_slug is not null/u);
  assert.match(statement.text, /c\.published_at is not null/u);
  assert.match(statement.text, /root\.id = c\.root_node_id/u);
  assert.match(statement.text, /root\.is_root/u);
  assert.match(statement.text, /root\.deleted_at is null/u);
  assert.match(statement.text, /max\(c\.updated_at\)/u);
  assert.doesNotMatch(statement.text, /array_agg|collection_ids/u);
  assert.match(statement.text, /order by max\(c\.updated_at\) desc, lower\(h\.handle\) collate "C" asc/u);
  assert.deepEqual(statement.values, ['public', PROFILE_SITEMAP_CANDIDATE_LIMIT]);
  assert.equal(PROFILE_SITEMAP_CANDIDATE_LIMIT, PROFILES_SITEMAP_MAX_URLS);
  assert.equal(PROFILES_SITEMAP_MAX_URLS, 50_000);
  assert.equal(PROFILES_SITEMAP_MAX_BYTES, 50 * 1024 * 1024);
});

test('empty profiles catalog is a valid empty urlset', () => {
  const xml = buildProfilesSitemapUrlset([]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset /u);
  assert.match(xml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/u);
  assert.doesNotMatch(xml, /<url>/u);
});

test('profile loc is canonical and lastmod comes from the max public collection updated_at', () => {
  const updatedAt = '2026-08-30T12:34:56.789Z';
  const xml = buildProfilesSitemapUrlset([{ canonicalHandle: 'ada_curator', updatedAt }]);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/u\/ada_curator<\/loc>/u);
  assert.match(xml, /<lastmod>2026-08-30T12:34:56\.789Z<\/lastmod>/u);
  assert.equal(profilesSitemapLastmod(updatedAt), updatedAt);
});

test('rejects non-canonical handles and XML-escapes serialized values', () => {
  assert.throws(
    () => buildProfilesSitemapUrlset([{ canonicalHandle: 'Ada&Curator', updatedAt: '2026-08-30T00:00:00Z' }]),
    /canonical handle/u,
  );
  const xml = buildProfilesSitemapUrlset([{ canonicalHandle: 'ada~curator', updatedAt: '2026-08-30T00:00:00Z' }]);
  assert.match(xml, /ada~curator/u);
  assert.doesNotMatch(xml, /&(?!(?:amp|lt|gt|quot);)/u);
});

test('single-file output stops at 50k URLs and stays below the aligned 50MB ceiling', () => {
  const entries = Array.from({ length: PROFILES_SITEMAP_MAX_URLS + 1 }, (_, index) => ({
    canonicalHandle: `profile_${index}`,
    updatedAt: '2026-08-30T00:00:00.000Z',
  }));
  const xml = buildProfilesSitemapUrlset(entries);
  assert.equal((xml.match(/<url>/gu) ?? []).length, PROFILES_SITEMAP_MAX_URLS);
  assert.doesNotMatch(xml, /profile_50000/u);
  assert.ok(Buffer.byteLength(xml, 'utf8') <= PROFILES_SITEMAP_MAX_BYTES);
});

test('byte ceiling omits the next complete URL and keeps a closed valid UTF-8 urlset', () => {
  const first = { canonicalHandle: 'abc', updatedAt: '2026-08-30T00:00:00.000Z' };
  const second = { canonicalHandle: 'second_profile', updatedAt: '2026-08-31T00:00:00.000Z' };
  const oneUrlBudget = Buffer.byteLength(buildProfilesSitemapUrlset([first]), 'utf8');
  const xml = buildProfilesSitemapUrlset([first, second], { maxBytes: oneUrlBudget });
  assert.equal((xml.match(/<url>/gu) ?? []).length, 1);
  assert.match(xml, /\/u\/abc/u);
  assert.doesNotMatch(xml, /second_profile/u);
  assert.match(xml, /<\/urlset>\n$/u);
  assert.ok(Buffer.byteLength(xml, 'utf8') <= oneUrlBudget);
});

test('limit overrides require positive safe integers', () => {
  for (const options of [
    { maxUrls: 0 },
    { maxUrls: 1.5 },
    { maxBytes: 0 },
    { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => buildProfilesSitemapUrlset([], options), /positive safe integer/u);
  }
});

test('composition validates canonical handles without querying attachment exposure facts', async () => {
  const query = composeProfileSitemapQuery({
    candidates: {
      async listCandidates() {
        return [{
          canonicalHandle: 'ada_curator',
          updatedAt: '2026-08-30T00:00:00.000Z',
        }];
      },
    },
  });
  assert.deepEqual(await query.listIndexable(), [{
    canonicalHandle: 'ada_curator',
    updatedAt: '2026-08-30T00:00:00.000Z',
  }]);
});
