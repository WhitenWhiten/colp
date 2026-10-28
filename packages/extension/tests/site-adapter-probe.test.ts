// @vitest-environment happy-dom
import { test, expect } from 'vitest';
import { favoriteRequest } from '../src/site-adapters/bilibili/probe-wire.js';
import { favoriteFetchRequest } from '../src/site-adapters/bilibili/probe-body.js';
const url = 'https://api.bilibili.com/x/v3/fav/resource/deal';
test('probe projects bounded IDs only, capturing the item before asynchronous completion', () => {
  expect(favoriteRequest(url, 'POST', 'rid=1&type=2&add_media_ids=101,102&del_media_ids=103&csrf=private')).toEqual({ itemId: 'video:av:1', added: ['101', '102'], removed: ['103'] });
  expect(favoriteRequest(url, 'POST', 'rid=1&type=2&add_media_ids=101&del_media_ids=101')).toBeNull();
  expect(favoriteRequest(url, 'GET', 'rid=1&type=2&add_media_ids=101')).toBeNull();
  expect(favoriteRequest('https://evil.test/x/v3/fav/resource/deal', 'POST', 'rid=1&type=2&add_media_ids=101')).toBeNull();
  expect(favoriteRequest(url, 'POST', 'rid=1&type=12&add_media_ids=101')).toBeNull();
  expect(favoriteRequest(url, 'POST', 'x'.repeat(8193))).toBeNull();
});
test('Request bodies and FormData yield only bounded IDs without consuming the original request', async () => {
  const body = 'rid=1&type=2&add_media_ids=101&csrf=private';
  const request = new Request(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  expect(await favoriteFetchRequest(request)).toEqual({ itemId: 'video:av:1', added: ['101'], removed: [] });
  expect(request.bodyUsed).toBe(false); expect(await request.text()).toBe(body);
  const form = new FormData(); for (const [key, value] of new URLSearchParams(body)) form.append(key, value);
  expect(favoriteRequest(url, 'POST', form)).toMatchObject({ added: ['101'] });
  form.append('rid', '2'); expect(favoriteRequest(url, 'POST', form)).toBeNull();
  const large = new Request(url, { method: 'POST', body: body + '&x=' + 'x'.repeat(8192), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  expect(await favoriteFetchRequest(large)).toBeNull(); expect(large.bodyUsed).toBe(false);
  await large.body?.cancel();
});
