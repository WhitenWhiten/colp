import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('community target and ranking SQL compose official hide/delist/restrict helpers', () => {
  const shared = readFileSync(
    join(root, 'src/infrastructure/community/community-target-shared-postgres.ts'),
    'utf8',
  );
  const ranking = readFileSync(
    join(root, 'src/infrastructure/community/community-ranking-postgres.ts'),
    'utf8',
  );
  const vote = readFileSync(
    join(root, 'src/infrastructure/community/community-vote-command-postgres.ts'),
    'utf8',
  );
  const comment = readFileSync(
    join(root, 'src/infrastructure/community/community-comment-command-postgres.ts'),
    'utf8',
  );
  assert.match(shared, /collectionHidePublicExistsSql/u);
  assert.match(shared, /bookmarkHidePublicExistsSql/u);
  assert.match(shared, /accountRestrictPublicationExistsSql/u);
  assert.match(shared, /accountRestrictInteractionExistsSql/u);
  assert.match(shared, /COMMUNITY_COLLECTION_HIDE_SQL/u);
  assert.match(ranking, /COMMUNITY_COLLECTION_DISCOVERY_SQL/u);
  assert.match(ranking, /COMMUNITY_BOOKMARK_DISCOVERY_SQL/u);
  assert.match(ranking, /COMMUNITY_SERIES_DISCOVERY_SQL/u);
  assert.match(ranking, /resolveCommunityTargetRow\(transaction, query, 'none', 'discovery'\)/u);
  assert.match(vote, /lockActiveCommunityAccount/u);
  assert.match(comment, /lockActiveCommunityAccount/u);
});
