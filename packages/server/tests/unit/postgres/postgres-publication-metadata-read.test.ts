import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicationMetadataReadPort } from '../../../src/infrastructure/publication/index.js';

test('loads active or deleted metadata locator facts with optional membership in one query', async () => {
  let captured: { sql: string; values?: readonly unknown[] } | undefined;
  const instant = new Date('2026-07-24T00:00:00Z');
  const runtime = {
    pool: {
      async query(sql: string, values?: readonly unknown[]) {
        captured = { sql, values };
        return { rows: [{
          id: 'c', owner_subject_id: 'owner', kind: 'bookmarks', title: 'C', summary: null,
          visibility: 'protected', publication_slug: 'c', root_node_id: 'r', content_revision: 'c1',
          root_available: true,
          policy_revision: 'p1', tags: ['tag'], language: 'en', membership_role: 'viewer',
          created_at: instant, updated_at: instant, deleted_at: null,
        }] };
      },
    },
    cancelBackend: async () => true,
  } as unknown as Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>;
  const result = await createPostgresPublicationMetadataReadPort(runtime).load({
    collectionId: 'c', actorSubjectId: 'member',
  });
  assert.equal(result?.membershipRole, 'viewer');
  assert.deepEqual(result?.tags, ['tag']);
  assert.match(captured?.sql ?? '', /left join collection_members/u);
  assert.match(captured?.sql ?? '', /left join nodes root/u);
  assert.match(captured?.sql ?? '', /c\.deleted_at/u);
  // Owner lifecycle fence: a missing owner row is legal (owner_subject_id is
  // not a foreign key), so the fence is a coalesce'd scalar subquery rather
  // than a mandatory exists/join on an active account row.
  assert.match(captured?.sql ?? '', /coalesce\(\(\s*select owner_account\.status = 'active' and owner_account\.deleted_at is null/u);
  assert.match(captured?.sql ?? '', /from accounts owner_account/u);
  assert.match(captured?.sql ?? '', /\), true\)/u);
  assert.doesNotMatch(captured?.sql ?? '', /join accounts/u);
  assert.deepEqual(captured?.values, ['c', 'member']);

  await createPostgresPublicationMetadataReadPort(runtime).load({ publicationSlug: 'canonical-c' });
  assert.match(captured?.sql ?? '', /where c\.publication_slug = \$1/u);
  assert.deepEqual(captured?.values, ['canonical-c', '']);
});
