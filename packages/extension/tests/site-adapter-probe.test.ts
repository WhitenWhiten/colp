// @vitest-environment happy-dom
import { test, expect } from 'vitest';
import { favoriteRequest } from '../src/site-adapters/bilibili/probe-wire.js';
const url = 'https://api.bilibili.com/x/v3/fav/resource/deal';
test('probe projects bounded IDs only, capturing the item before asynchronous completion', () => {
  expect(favoriteRequest(url, 'POST', 'rid=1&type=2&add_media_ids=101,102&del_media_ids=103&csrf=private')).toEqual({ itemId: 'video:av:1', added: ['101', '102'], removed: ['103'] });
  expect(favoriteRequest(url, 'POST', 'rid=1&type=2&add_media_ids=101&del_media_ids=101')).toBeNull();
  expect(favoriteRequest(url, 'GET', 'rid=1&type=2&add_media_ids=101')).toBeNull();
  expect(favoriteRequest('https://evil.test/x/v3/fav/resource/deal', 'POST', 'rid=1&type=2&add_media_ids=101')).toBeNull();
  expect(favoriteRequest(url, 'POST', 'rid=1&type=12&add_media_ids=101')).toBeNull();
  expect(favoriteRequest(url, 'POST', 'x'.repeat(8193))).toBeNull();
});
