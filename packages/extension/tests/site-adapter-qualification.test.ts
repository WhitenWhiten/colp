// @vitest-environment happy-dom
import { vi } from 'vitest';
import { qualifySiteAdapter } from './fixtures/site-adapters/qualification.js';
import { bilibiliDefinition } from '../src/site-adapters/bilibili/definition.js';
import { createBilibiliAdapter } from '../src/site-adapters/bilibili/adapter.js';
import { readLimits } from '../src/site-adapters/read-policy.js';
import { fixtures, video } from './fixtures/site-adapters/bilibili.js';
import { createPostsAdapter, postsDefinition, post, saved } from './fixtures/site-adapters/posts.js';
qualifySiteAdapter({ definition: bilibiliDefinition, accountId: '42', item: video, collection: { id: '101', identity: 'siteId', title: 'Collection', parentId: null },
  setup() {
    vi.stubGlobal('fetch', async (value: string | URL) => {
      const url = new URL(String(value)), path = url.pathname;
      const response = path.endsWith('/nav') ? fixtures.nav : path.endsWith('/list-all') ? fixtures.catalog
        : path.endsWith('/ids') ? url.searchParams.get('pn') === '1' ? fixtures.ids : fixtures.empty : path.endsWith('/view') ? fixtures.view : fixtures.details;
      return new Response(JSON.stringify(response));
    });
    return createBilibiliAdapter({ readPolicy: readLimits({ readPolicy: { spacingMs: 1, requestSpacingMs: 1 } }) });
  }, cleanup: () => vi.unstubAllGlobals() });
qualifySiteAdapter({ definition: postsDefinition, accountId: 'acct:reader', item: post, collection: saved, setup: () => createPostsAdapter() });
