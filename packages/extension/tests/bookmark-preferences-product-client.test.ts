import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { BookmarkPreferencesProductError, createBookmarkPreferencesProductClient } from '../src/bookmark-preferences-product-client.js';

const remote = { bookmarkInsertPosition: 'bottom', foldersFirst: true, revision: '0', updatedAt: '2026-01-01T00:00:00.000Z' };
const session = { authenticated: true, csrfToken: 'csrf-token' };

describe('bookmark preference Product client', () => {
  test('GET bootstraps Product CSRF and verifies the Better Auth subject before reading', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createBookmarkPreferencesProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'user-a', fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/v1/session')) return Response.json(session);
      if (String(url).endsWith('/api/v1/auth/get-session')) return Response.json({ user: { id: 'user-a' }, session: { id: 'session-a' } });
      return new Response(JSON.stringify(remote), { status: 200, headers: { etag: '"0"', 'Known-Bookmark-Session': 'session-a' } });
    } });
    await assert.doesNotReject(async () => client.read());
    assert.deepEqual(calls.map((call) => call.url), [
      'https://known.example/api/v1/session', 'https://known.example/api/v1/auth/get-session',
      'https://known.example/api/v1/me/bookmark-preferences',
    ]);
    assert.equal((calls[2]?.init.headers as Record<string, string> | undefined)?.Origin, undefined);
    assert.equal(calls[2]?.init.credentials, 'include');
  });

  test('rejects a cookie whose Better Auth subject differs from the local authority', async () => {
    let preferenceRead = false;
    const client = createBookmarkPreferencesProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'user-a', fetch: async (url) => {
      if (String(url).endsWith('/api/v1/auth/get-session')) return Response.json({ user: { id: 'user-b' } });
      if (String(url).endsWith('/api/v1/me/bookmark-preferences')) preferenceRead = true;
      return Response.json(session);
    } });
    await assert.rejects(() => client.read(), (error: unknown) => error instanceof BookmarkPreferencesProductError && error.code === 'reconnect_required');
    assert.equal(preferenceRead, false);
  });

  test('PATCH carries CSRF, command identity and If-Match, and maps 412', async () => {
    const calls: RequestInit[] = [];
    const client = createBookmarkPreferencesProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'user-a', fetch: async (url, init = {}) => {
      calls.push(init);
      if (String(url).endsWith('/api/v1/session')) return Response.json(session);
      if (String(url).endsWith('/api/v1/auth/get-session')) return Response.json({ user: { id: 'user-a' }, session: { id: 'session-a' } });
      return new Response(JSON.stringify({ error: { code: 'revision_conflict' } }), { status: 412 });
    } });
    await assert.rejects(() => client.patch({ bookmarkInsertPosition: 'top', foldersFirst: false }, '11111111-1111-4111-8111-111111111111', '"0"'),
      (error: unknown) => error instanceof BookmarkPreferencesProductError && error.status === 412);
    const headers = calls.at(-1)?.headers as Record<string, string>;
    assert.equal(headers['X-CSRF-Token'], 'csrf-token');
    assert.equal(headers['Known-Command-Id'], '11111111-1111-4111-8111-111111111111');
    assert.equal(headers['If-Match'], '"0"');
    assert.equal(headers.Origin, undefined);
  });
});

for (const responseSession of ['session-b', 'rotated-session-a', undefined]) {
  test(`GET rejects data from a different or unbound cookie session (${responseSession})`, async () => {
    const client = createBookmarkPreferencesProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'user-a',
      assertCurrent: async () => { /* Extension credential remains A while the website changes its cookie. */ },
      fetch: async url => {
        if (String(url).endsWith('/api/v1/session')) return Response.json(session);
        if (String(url).endsWith('/api/v1/auth/get-session')) return Response.json({ user: { id: 'user-a' }, session: { id: 'session-a' } });
        return Response.json({ ...remote, revision: '99' }, { headers: { etag: '"99"',
          ...(responseSession ? { 'Known-Bookmark-Session': responseSession } : {}) } });
      },
    });
    await assert.rejects(client.read, (error: unknown) => error instanceof BookmarkPreferencesProductError
      && error.code === 'reconnect_required');
  });
}

for (const responseSession of ['session-b', undefined, 'session-a']) {
  test('PATCH checks response session including replay: ' + responseSession, async () => {
    const client = createBookmarkPreferencesProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'user-a',
      fetch: async url => {
        if (String(url).endsWith('/api/v1/session')) return Response.json(session);
        if (String(url).endsWith('/api/v1/auth/get-session')) return Response.json({ user: { id: 'user-a' }, session: { id: 'session-a' } });
        return Response.json(remote, { headers: { etag: '"0"', ...(responseSession ? { 'Known-Bookmark-Session': responseSession } : {}) } });
      },
    });
    const operation = () => client.patch({ subscriptionOnUnsubscribe: 'remove' }, '11111111-1111-4111-8111-111111111111', '"0"');
    if (responseSession === 'session-a') await assert.doesNotReject(operation);
    else await assert.rejects(operation, (error: unknown) => error instanceof BookmarkPreferencesProductError && error.code === 'reconnect_required');
  });
}

test('CSRF refresh verifies the account before retrying the mutation', async () => {
  let identities = 0; let writes = 0;
  const client = createBookmarkPreferencesProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'user-a',
    fetch: async url => {
      if (String(url).endsWith('/api/v1/session')) return Response.json(session);
      if (String(url).endsWith('/api/v1/auth/get-session')) return Response.json({ user: { id: ++identities === 1 ? 'user-a' : 'user-b' }, session: { id: 'session-a' } });
      writes++; return Response.json({ error: { code: 'csrf_failed' } }, { status: 403 });
    },
  });
  await assert.rejects(() => client.patch({ subscriptionOnUnfollow: 'remove' }, '11111111-1111-4111-8111-111111111111', '"0"'),
    (error: unknown) => error instanceof BookmarkPreferencesProductError && error.code === 'reconnect_required');
  assert.equal(writes, 1);
});
