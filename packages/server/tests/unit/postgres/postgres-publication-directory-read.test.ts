import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationDirectoryStatement,
  COLLECTION_CATALOG_TAGS_SQL,
  createPostgresPublicationDirectoryReadPort,
  escapeLikePattern,
} from '../../../src/infrastructure/publication/index.js';

test('pushes visibility, filters, full keyset comparator, and limit+1 into PostgreSQL', async () => {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith('select id from collections')) return { rows: [{ id: 'anchor-id' }] };
      return { rows: [{
        id: 'collection-1', owner_subject_id: 'owner', title: 'Title', summary: null,
        kind: 'bookmarks', visibility: 'protected', publication_slug: 'slug', tags: ['tag'],
        language: 'en', node_count: '2', updated_at: new Date('2026-07-24T00:00:00Z'),
        ordering_updated_at_micros: '1784851200123456',
        protected_authorized: true,
      }] };
    },
    release() {},
  };
  const runtime = {
    pool: { async connect() { return client; } },
    cancelBackend: async () => true,
  } as unknown as Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>;
  const result = await createPostgresPublicationDirectoryReadPort(runtime).loadPage({
    principal: { subjectId: 'member' },
    filter: { tag: 'tag', creator: 'owner', kind: 'bookmarks', updatedSince: '2026-07-01T00:00:00Z', q: 'title' },
    limit: 10,
    after: { orderingUpdatedAtMicros: '1784505600123456', idLocator: '0123456789abcdef0123456789abcdef' },
  });
  assert.equal(result[0]?.id, 'collection-1');
  assert.equal(result[0]?.updatedAt, '2026-07-24T00:00:00.000Z');
  assert.equal(result[0]?.orderingUpdatedAtMicros, '1784851200123456');
  const locatorQuery = calls.find((call) => call.sql.includes('publication_locator_sha256_128'))!;
  assert.match(locatorQuery.sql, /publication_locator_sha256_128\(id\)/u);
  assert.doesNotMatch(locatorQuery.sql, /convert_to/u);
  const query = calls.at(-1)!;
  assert.match(query.sql, /c\.visibility = 'public'/u);
  // Owner lifecycle fence: a missing owner row is legal (owner_subject_id is
  // not a foreign key), so the fence is a coalesce'd scalar subquery rather
  // than a mandatory exists/join on an active account row.
  assert.match(query.sql, /coalesce\(\(\s*select owner_account\.status = 'active' and owner_account\.deleted_at is null/u);
  assert.match(query.sql, /from accounts owner_account/u);
  assert.match(query.sql, /\), true\)/u);
  assert.doesNotMatch(query.sql, /join accounts/u);
  assert.match(query.sql, /c\.visibility = 'protected'/u);
  assert.match(query.sql, /collection_members/u);
  assert.match(query.sql, /payload_json->'extensions'->'tags'/u);
  assert.match(query.sql, /payload_json->'tags'/u);
  assert.match(query.sql, /timestamp with time zone 'epoch'/u);
  assert.match(query.sql, /c\.id collate "C" > \$[0-9]+::text collate "C"/u);
  assert.match(query.sql, /order by c\.updated_at desc, c\.id collate "C" asc/u);
  assert.match(query.sql, /extract\(epoch from c\.updated_at\) \* 1000000/u);
  assert.match(query.sql, /select count\(\*\)::int\s*from nodes n/u);
  assert.match(query.sql, /n\.visibility = 'inherit'/u);
  assert.match(query.sql, /target_ancestors/u);
  assert.match(query.sql, /ma\.target_id = n\.id/u);
  assert.doesNotMatch(query.sql, /GREATEST\s*\(/u);
  assert.match(query.sql, /as node_count/u);
  assert.equal(query.values?.at(-1), 11);
});

test('anonymous PostgreSQL selection cannot enumerate unlisted, protected, or private rows', async () => {
  let captured = '';
  const runtime = {
    pool: {
      async connect() {
        return {
          async query(sql: string) { captured = sql; return { rows: [] }; },
          release() {},
        };
      },
    },
    cancelBackend: async () => true,
  } as unknown as Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>;
  await createPostgresPublicationDirectoryReadPort(runtime).loadPage({
    principal: 'anonymous', filter: {}, limit: 20,
  });
  assert.match(captured, /c\.visibility = 'public'/u);
  assert.doesNotMatch(captured, /collection_members/u);
  assert.match(captured, /c\.published_at is not null/u);
});

test('escapeLikePattern escapes backslash, percent, and underscore as literal LIKE data', () => {
  assert.equal(escapeLikePattern('plain'), 'plain');
  assert.equal(escapeLikePattern('50%'), '50\\%');
  assert.equal(escapeLikePattern('snake_case'), 'snake\\_case');
  assert.equal(escapeLikePattern('C:\\temp'), 'C:\\\\temp');
  assert.equal(escapeLikePattern('a\\b%c_d'), 'a\\\\b\\%c\\_d');
  // Escaping is idempotent-free: an already-escaped user string is escaped again
  // (the user may genuinely search for the literal backslash sequence).
  assert.equal(escapeLikePattern('50\\%'), '50\\\\\\%');
});

test('q predicate collapses to a single normalized generated column with an escaped literal pattern', () => {
  const statement = buildPublicationDirectoryStatement({
    principal: 'anonymous', filter: { q: 'hello 50%' }, limit: 10,
  });
  assert.match(statement.text, /c\.directory_search_text like '%' \|\| \$1 \|\| '%' escape '\\'/u);
  // The old per-field OR must not survive the R10 unification.
  assert.doesNotMatch(statement.text, /lower\(c\.title\) like/u);
  assert.equal(statement.values[0], 'hello 50\\%');
  assert.equal(statement.values.at(-1), 11);
});

test('tag predicate matches only array tags through the exact coalesced expression', () => {
  const statement = buildPublicationDirectoryStatement({
    principal: 'anonymous', filter: { tag: 'apple' }, limit: 10,
  });
  assert.ok(statement.text.includes(COLLECTION_CATALOG_TAGS_SQL));
  assert.match(statement.text, /jsonb_typeof\(coalesce\(/u);
  assert.ok(statement.text.includes(`${COLLECTION_CATALOG_TAGS_SQL} ? $1`));
  assert.equal(statement.values[0], 'apple');
  assert.doesNotMatch(statement.text, /like/u);
});

test('combined q and tag filters keep authorization, keyset, and limit+1 semantics', () => {
  const statement = buildPublicationDirectoryStatement({
    principal: { subjectId: 'member' },
    filter: { tag: 'apple', q: 'hello 50%', creator: 'owner', kind: 'bookmarks', updatedSince: '2026-07-01T00:00:00Z' },
    limit: 10,
    after: { orderingUpdatedAtMicros: '1784505600123456', idLocator: '0123456789abcdef0123456789abcdef' },
  }, 'anchor-id');
  assert.match(statement.text, /c\.directory_search_text like '%' \|\| \$[0-9]+ \|\| '%' escape '\\'/u);
  assert.ok(statement.text.includes(COLLECTION_CATALOG_TAGS_SQL));
  assert.match(statement.text, /jsonb_typeof\(coalesce\(/u);
  assert.match(statement.text, /\? \$[0-9]+/u);
  assert.match(statement.text, /collection_members/u);
  assert.match(statement.text, /c\.updated_at <=/u);
  assert.match(statement.text, /c\.id collate "C" > \$[0-9]+::text collate "C"/u);
  assert.match(statement.text, /order by c\.updated_at desc, c\.id collate "C" asc/u);
  const tagIndex = statement.values.indexOf('apple');
  const qIndex = statement.values.indexOf('hello 50\\%');
  assert.ok(tagIndex > 0, 'tag parameter must be present');
  assert.ok(qIndex > tagIndex, 'q parameter must be parameterized after the tag filter');
  assert.equal(statement.values.at(-1), 11);
});

test('directory SELECT derives node count from the anonymous public visibility policy', () => {
  const statement = buildPublicationDirectoryStatement({
    principal: 'anonymous', filter: {}, limit: 24,
  });
  assert.match(statement.text, /select count\(\*\)::int\s*from nodes n/u);
  assert.match(statement.text, /n\.visibility = 'inherit'/u);
  assert.match(statement.text, /target_ancestors/u);
  assert.doesNotMatch(statement.text, /c\.live_node_count/u);
  assert.doesNotMatch(statement.text, /GREATEST\s*\(/u);
  assert.match(statement.text, /as node_count/u);
});
