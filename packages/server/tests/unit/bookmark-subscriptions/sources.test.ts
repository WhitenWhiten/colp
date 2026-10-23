import { expect, test, vi } from 'vitest';
import type { CompiledQuery } from 'kysely';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/unit-of-work.js';
import type { ActorCollectionReadPort } from '../../../src/modules/collections/index.js';
import { createBookmarkSubscriptionSources } from '../../../src/infrastructure/bookmark-subscriptions/sources.js';

const actor = { accountId: 'account', subjectId: 'subject' };
const collections: ActorCollectionReadPort = {
  metadata: async () => null, metadataMany: async () => new Map(),
  nodes: async () => null, annotations: async () => [],
};

function sources(reportsEnabled: boolean) {
  const executeQuery = vi.fn(async (_query: CompiledQuery) => ({ rows: [] }));
  const tx = { executeQuery } as unknown as DatabaseTransaction;
  return { port: createBookmarkSubscriptionSources(tx, { origin: 'https://example.test', reportsEnabled }, collections), executeQuery };
}

test('the default source request works with reports disabled and never reads report tables', async () => {
  const { port, executeQuery } = sources(false);
  await expect(port.list(actor, {})).resolves.toEqual([]);
  expect(executeQuery).toHaveBeenCalledOnce();
  expect(executeQuery.mock.calls[0]?.[0].sql).toContain('from collections');
  expect(executeQuery.mock.calls[0]?.[0].sql).not.toMatch(/digest_series|digest_follows|digest_members/);
  await expect(port.list(actor, { sourceType: 'collection' })).resolves.toEqual([]);
});

test('an explicit disabled source type is rejected before any query', async () => {
  const { port, executeQuery } = sources(false);
  await expect(port.list(actor, { sourceType: 'digest_series' })).rejects.toMatchObject({ code: 'feature_temporarily_unavailable' });
  expect(executeQuery).not.toHaveBeenCalled();
});
