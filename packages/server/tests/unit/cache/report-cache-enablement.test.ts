import assert from 'node:assert/strict';
import { test } from 'vitest';

import { isReportCacheInvalidationEnabled } from '../../../src/bootstrap/report-cache-enablement.js';
import { deliverReportSourceInvalidation } from '../../../src/infrastructure/outbox/report-source-invalidation-consumer.js';
import { OutboxContinuationRequested } from '../../../src/infrastructure/outbox/router.js';
import type { ReportInvalidationCursorStore } from '../../../src/infrastructure/outbox/report-source-invalidation-consumer.js';

function config(overrides: {
  reportsEnabled?: boolean;
  mode?: 'off' | 'shadow' | 'serve';
  metadataEnabled?: boolean;
  issuesEnabled?: boolean;
  directoryEnabled?: boolean;
} = {}) {
  return {
    reports: { enabled: overrides.reportsEnabled ?? true },
    cache: {
      redis: { mode: overrides.mode ?? 'serve' },
      reports: {
        metadataEnabled: overrides.metadataEnabled ?? false,
        issuesEnabled: overrides.issuesEnabled ?? false,
        directoryEnabled: overrides.directoryEnabled ?? false,
      },
    },
  };
}

test('report cache invalidation shares one enablement condition', () => {
  assert.equal(isReportCacheInvalidationEnabled(config({ metadataEnabled: true })), true);
  assert.equal(isReportCacheInvalidationEnabled(config({ directoryEnabled: true, mode: 'shadow' })), true);
  assert.equal(isReportCacheInvalidationEnabled(config({ metadataEnabled: true, reportsEnabled: false })), false);
  assert.equal(isReportCacheInvalidationEnabled(config({ metadataEnabled: true, mode: 'off' })), false);
  assert.equal(isReportCacheInvalidationEnabled(config()), false);
});

test('source invalidation rotates one page and continues without dropping the cursor early', async () => {
  const pages = [['a', 'b'], ['c']];
  let cursor: string | null = null;
  const rotated: string[][] = [];
  const store: ReportInvalidationCursorStore = {
    async readAfterSlug() { return cursor; },
    async writeAfterSlug(_eventId, afterSlug) { cursor = afterSlug; },
    async listSourceSlugs() { return pages.shift() ?? []; },
  };
  const invalidator = {
    async rotateSource(_signal: AbortSignal, slugs: readonly string[]) {
      rotated.push([...slugs]);
    },
  };
  await assert.rejects(
    () => deliverReportSourceInvalidation({
      store,
      invalidator,
      domainEventId: 'event-1',
      collectionId: 'collection-1',
      signal: new AbortController().signal,
      limit: 2,
    }),
    (error: unknown) => error instanceof OutboxContinuationRequested,
  );
  assert.equal(cursor, 'b');
  assert.deepEqual(rotated, [['a', 'b']]);

  await deliverReportSourceInvalidation({
    store,
    invalidator,
    domainEventId: 'event-1',
    collectionId: 'collection-1',
    signal: new AbortController().signal,
    limit: 2,
  });
  assert.deepEqual(rotated, [['a', 'b'], ['c']]);
  assert.equal(cursor, 'b');
});
