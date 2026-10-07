import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import type { PublicationMetadataRecord } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const record: PublicationMetadataRecord = {
  id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection',
  summary: 'A summary.', visibility: 'public', publicationSlug: 'collection',
  rootNodeId: 'root-1', rootAvailable: true, contentRevision: 'c1', policyRevision: 'p1',
  tags: [], language: null, membershipRole: null,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
  deletedAt: null,
};

test('malformed public shells share the anonymous explore budget', async () => {
  let fetches = 0;
  const app = buildApiApp({
    config: loadConfig({
      DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
      PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      KNOWN_FEATURE_PUBLIC_SHELL_META: 'true', WEB_SHELL_ORIGIN: 'http://web:80',
    }),
    publicationMetadataQuery: {
      reads: { async load() { return record; } },
      origin: 'https://known.example',
      now: () => new Date('2026-07-24T00:00:00Z'),
      collectionControl: { async collectionControl() { return { hidePublic: false, delisted: false }; } },
    },
    publicShell: {
      cache: createWebShellCache({
        origin: 'http://web:80',
        fetch: async () => {
          fetches += 1;
          return new Response(PUBLIC_SHELL_FIXTURE, { status: 200, headers: { etag: '"shell"' } });
        },
      }),
      loadNodeCountBySlug: async () => 1,
      loadOwnerDisplayName: async () => 'Ada',
    },
    exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
      anonymousMaxRequests: 2, accountMaxRequests: 2, windowMs: 60_000,
    }),
  });
  try {
    const malformed = ['/c/UPPER', '/share/UPPER', '/path/UPPER', '/graph/UPPER'];
    const statuses: number[] = [];
    for (const url of malformed) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      statuses.push(response.statusCode);
    }
    const canonical = await app.inject({
      method: 'GET', url: '/c/collection', headers: { accept: 'text/html' },
    });
    assert.deepEqual(statuses, [404, 404, 429, 429]);
    assert.equal(canonical.statusCode, 429);
    assert.equal(fetches, 1);
  } finally {
    await app.close();
  }
});
