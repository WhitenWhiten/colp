/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import { canStartFirstSync } from '../src/first-run-draft.js';
import {
  EXTENSION_COLLECTIONS_PATH, libraryCreateIdempotency, postPrivateBookmarkLibrary,
} from '../src/library-create.js';
import { validRequest } from '../src/sw/messages.js';
import type { PublicRootView } from '../src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const COLP = `https://known.example${EXTENSION_COLLECTIONS_PATH}`;
const TOKEN = 'colp-access-token';
const ORIGIN = 'chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen';
const TITLE = 'Morning reads';
const CREATED = {
  id: 'library-created', title: TITLE, kind: 'bookmarks', visibility: 'private', rootNodeId: 'root-created',
};

async function readFromPackage(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8');
}

function spyFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (url, init) => {
    const href = String(url);
    const request = { url: href, init: init ?? {} };
    calls.push(request);
    return handler(href, init ?? {});
  };
  return { fetch: fetchFn, calls };
}

describe('KNS-02 live COLP library create', () => {
  test('POSTs title-only body with COLP credential and Idempotency-Key', async () => {
    const transport = spyFetch(() => Response.json(CREATED, { status: 201 }));
    const result = await postPrivateBookmarkLibrary({
      title: TITLE, serverOrigin: 'https://known.example', accessToken: TOKEN, origin: ORIGIN,
      idempotencyKey: 'create-library-1', fetch: transport.fetch,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.collection.id, 'library-created');
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0]!;
    assert.equal(call.url, COLP);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.credentials, 'omit');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get('Idempotency-Key'), 'create-library-1');
    assert.equal(headers.get('Origin'), ORIGIN);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('Cookie'), null);
    assert.deepEqual(JSON.parse(String(call.init.body)), { title: TITLE });
    assert.equal(Object.keys(JSON.parse(String(call.init.body))).join(','), 'title');
    assert.doesNotMatch(call.url, /\/api\/v1\/collections/);
    assert.doesNotMatch(String(call.init.body), /create_node|syncPush|kind|visibility/);
  });

  test('reuses the same Idempotency-Key for the same draft title retry', () => {
    const first = libraryCreateIdempotency(undefined, TITLE, () => 'key-one');
    const retry = libraryCreateIdempotency(first, TITLE, () => 'key-two');
    const other = libraryCreateIdempotency(first, 'Other library', () => 'key-three');
    assert.equal(first.key, 'key-one');
    assert.equal(retry.key, 'key-one');
    assert.equal(other.key, 'key-three');
  });

  test('maps 401 and network failure for website fallback, never Product cookie create', async () => {
    const unauthorized = spyFetch(() => new Response(null, { status: 401 }));
    const auth = await postPrivateBookmarkLibrary({
      title: TITLE, serverOrigin: 'https://known.example', accessToken: TOKEN, origin: ORIGIN,
      idempotencyKey: 'create-library-401', fetch: unauthorized.fetch,
    });
    assert.deepEqual(auth, { ok: false, error: 'collections_unauthorized' });
    const offline = spyFetch(() => { throw new TypeError('Failed to fetch'); });
    const network = await postPrivateBookmarkLibrary({
      title: TITLE, serverOrigin: 'https://known.example', accessToken: TOKEN, origin: ORIGIN,
      idempotencyKey: 'create-library-offline', fetch: offline.fetch,
    });
    assert.deepEqual(network, { ok: false, error: 'offline' });
    for (const call of [...unauthorized.calls, ...offline.calls]) {
      assert.doesNotMatch(call.url, /\/api\/v1\/collections|syncPush/);
    }
  });

  test('accepts replay 200 of the same Collection and rejects non-private results', async () => {
    const replay = spyFetch(() => Response.json(CREATED, { status: 200 }));
    const ok = await postPrivateBookmarkLibrary({
      title: TITLE, serverOrigin: 'https://known.example', accessToken: TOKEN, origin: ORIGIN,
      idempotencyKey: 'create-library-replay', fetch: replay.fetch,
    });
    assert.equal(ok.ok, true);
    const shared = spyFetch(() => Response.json({ ...CREATED, visibility: 'shared' }, { status: 201 }));
    const rejected = await postPrivateBookmarkLibrary({
      title: TITLE, serverOrigin: 'https://known.example', accessToken: TOKEN, origin: ORIGIN,
      idempotencyKey: 'create-library-shared', fetch: shared.fetch,
    });
    assert.deepEqual(rejected, { ok: false, error: 'collections_unavailable' });
  });

  test('create message requires a user gesture and a real title, confirm still needs libraryId', () => {
    assert.equal(validRequest({ kind: 'known.collections.create', title: TITLE, userGesture: true }), true);
    assert.equal(validRequest({ kind: 'known.collections.create', title: TITLE }), false);
    assert.equal(validRequest({ kind: 'known.collections.create', title: '   ', userGesture: true }), false);
    assert.equal(validRequest({ kind: 'known.collections.list' }), true);
    const preview = {
      ok: true as const, previewId: 'p1', boundaryVersion: '1', treeDigest: 'sha256:abc',
      bookmarkCount: 1, folderCount: 0, skippedCount: 0, warnings: [],
    };
    const view: PublicRootView = {
      viewId: 'view-1', status: 'ready',
      roots: [{
        ref: 'bar', title: 'Bar', kind: 'bookmarks_bar', depth: 0, selected: true, privateLocal: false,
        managed: false, bookmarkCount: 1, folderCount: 0,
      }],
    };
    assert.equal(canStartFirstSync({ libraryId: undefined, preview, view, selectedCount: 1 }), false);
    assert.equal(canStartFirstSync({ libraryId: 'library-created', preview, view, selectedCount: 1 }), true);
  });

  test('transport allows POST collections and forbids Product cookie, Push, and create_node before confirm', async () => {
    const files = await Promise.all([
      'src/library-create.ts', 'src/sw/collections.ts', 'src/first-run-ui.ts', 'src/first-run-draft.ts',
      'src/sw/first-run.ts', 'src/service-worker.ts', 'src/sw/messages.ts',
    ].map((file) => readFromPackage(file)));
    const source = files.join('\n');
    assert.match(source, /known\.collections\.create/);
    assert.match(source, /Idempotency-Key/);
    assert.match(source, /postPrivateBookmarkLibrary|method: 'POST'/);
    assert.match(source, /colp\/v0\.1\/sync\/collections/);
    assert.match(await readFromPackage('src/first-run-ui.ts'), /collections_unauthorized|FIRST_RUN_WEBSITE_CREATE/);
    assert.doesNotMatch(source, /\/api\/v1\/collections/);
    assert.doesNotMatch(await readFromPackage('src/library-create.ts'), /create_node|syncPush/);
    assert.doesNotMatch(await readFromPackage('src/sw/first-run.ts'), /known\.collections\.create|create_node/);
    assert.match(await readFromPackage('src/collections-cache.ts'), /kind === 'bookmarks' && item\.visibility === 'private'/);
  });
});
