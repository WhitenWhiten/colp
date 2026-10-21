import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createFaviconSidecarStore } from '../src/favicon-sidecar-store.js';
import { resolveSelectedRootNativeId, saveBookmarkWithFaviconCapture,
} from '../src/favicon-save.js';
import { drainFaviconSidecars } from '../src/favicon-upload.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10, 0x20]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const COMMAND_ID = 'c0ffee00-0000-4000-8000-000000000001';
const COLLECTION_ID = 'collection-1';
const NODE_ID = 'node-colp-1';
const NATIVE_ID = 'bookmark-native-1';
const PARENT_NATIVE = 'folder-native-1';
const TAB_URL = 'https://example.test/page';
const TAB_ICON = 'https://example.test/favicon.png';
const ORIGIN = 'chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen';
const SERVER = 'https://known.example';
const HELPER = `${SERVER}/colp/v0.1/sync/collections/${COLLECTION_ID}/nodes/${NODE_ID}/favicon`;
const TOKEN = 'colp-access-token';
const SOURCE_ETAG = '"favicon-source:node-colp-1:1"';
const POLICY_BODY = {
  revision: '1', newDefault: 'capture', providerTemplate: 'https://favicone.com/{hostname}',
  fillMissing: false, forceAllOnline: false, updatedAt: '2026-09-14T00:00:00.000Z',
};
const SOURCE_BODY = {
  collectionId: COLLECTION_ID, nodeId: NODE_ID, revision: '1', policyRevision: '1',
  sourceMode: 'inherit', effectiveMode: 'capture', iconUrl: null, iconVersion: null,
  directUrl: null, status: 'missing', restorable: false, updatedAt: '2026-09-14T00:00:00.000Z',
};
const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: SERVER, serverOrigin: SERVER, accountId: 'account-a',
  browserProfileId: 'profile-a', collectionId: COLLECTION_ID, replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('BF-06 popup save + helper upload pipeline', () => {
  test('bound collection + selectedRoots[0] same-origin PNG uploads once via helper POST', async () => {
    const helper = recordHelper();
    const created: Array<Record<string, unknown>> = [];
    const sidecar = createFaviconSidecarStore({ indexedDB });
    const saved = await saveBookmarkWithFaviconCapture({
      title: 'Example', url: TAB_URL, favIconUrl: TAB_ICON, privateLocal: false,
      parentNativeId: PARENT_NATIVE, collectionId: COLLECTION_ID,
      bookmarks: {
        create: async (bookmark) => {
          created.push({ ...bookmark });
          return { id: NATIVE_ID, title: String(bookmark.title ?? ''), url: bookmark.url };
        },
      },
      fetch: async (url, init) => {
        if (String(url) === TAB_ICON) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        return helper.fetch(url, init);
      },
      sidecar, randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.parentId, PARENT_NATIVE);
    assert.equal(saved.nativeId, NATIVE_ID);
    assert.equal(saved.captured, true);
    assert.equal(helper.posts.length, 0, 'popup must not POST; sidecar must persist first');
    // FO-07 fix: the queued capture records the page it came from, so a later
    // URL edit can never bind these bytes to another site.
    assert.equal((await sidecar.get(NATIVE_ID))?.pageUrl, TAB_URL);

    const drain = await drainFaviconSidecars({
      sidecar, lookupNodeId: async (nativeId) => nativeId === NATIVE_ID ? NODE_ID : null,
      bookmarkUrl: async () => TAB_URL, accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER,
      collectionId: COLLECTION_ID, fetch: helper.fetch, now: () => 2_000,
    });
    if (drain === 'unsupported') throw new Error('favicon drain unsupported');
    assert.equal(drain.posted, 1);
    assert.equal(helper.posts.length, 1);
    const post = helper.posts[0]!;
    assert.equal(post.url, HELPER);
    assert.equal(post.headers.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(post.headers.get('Known-Command-Id'), COMMAND_ID);
    assert.equal(post.headers.get('Content-Type'), 'image/png');
    assert.equal(post.headers.get('Origin'), ORIGIN);
    // FO-04: the drain re-reads policy/source and posts with the fresh validators.
    assert.equal(post.headers.get('If-Match'), SOURCE_ETAG);
    assert.equal(post.headers.get('Known-Favicon-Policy-Revision'), '1');
    assert.equal(post.headers.get('Idempotency-Key'), null);
    assert.doesNotMatch(post.url, /\/api\/v1\/collections\//);
    assert.deepEqual(post.body, PNG);
    assert.equal(await sidecar.get(NATIVE_ID), null);
  });

  test('a gzip-weakened helper ETag still posts a strong If-Match', async () => {
    const helper = recordHelper({
      policyEtag: 'W/"favicon-policy:1"',
      sourceEtag: `W/${SOURCE_ETAG}`,
    });
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await saveBookmarkWithFaviconCapture({
      title: 'Example', url: TAB_URL, favIconUrl: TAB_ICON, privateLocal: false,
      parentNativeId: PARENT_NATIVE, collectionId: COLLECTION_ID,
      bookmarks: {
        create: async (bookmark) => ({ id: NATIVE_ID, title: String(bookmark.title ?? ''), url: bookmark.url }),
      },
      fetch: async (url, init) => {
        if (String(url) === TAB_ICON) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        return helper.fetch(url, init);
      },
      sidecar, randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    const drain = await drainFaviconSidecars({
      sidecar, lookupNodeId: async (nativeId) => nativeId === NATIVE_ID ? NODE_ID : null,
      bookmarkUrl: async () => TAB_URL, accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER,
      collectionId: COLLECTION_ID, fetch: helper.fetch, now: () => 2_000,
    });
    if (drain === 'unsupported') throw new Error('favicon drain unsupported');
    assert.equal(drain.posted, 1);
    assert.equal(helper.posts[0]?.headers.get('If-Match'), SOURCE_ETAG);
    assert.equal(helper.posts[0]?.headers.get('Known-Favicon-Policy-Revision'), '1');
  });

  test('a URL edit after the popup save drops the queued capture before any POST', async () => {
    const helper = recordHelper();
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await saveBookmarkWithFaviconCapture({
      title: 'Example', url: TAB_URL, favIconUrl: TAB_ICON, privateLocal: false,
      parentNativeId: PARENT_NATIVE, collectionId: COLLECTION_ID,
      bookmarks: {
        create: async (bookmark) => ({ id: NATIVE_ID, title: String(bookmark.title ?? ''), url: bookmark.url }),
      },
      fetch: async (url, init) => {
        if (String(url) === TAB_ICON) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        return helper.fetch(url, init);
      },
      sidecar, randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    const drain = await drainFaviconSidecars({
      sidecar, lookupNodeId: async (nativeId) => nativeId === NATIVE_ID ? NODE_ID : null,
      // The user edited the resource URL before the drain ran.
      bookmarkUrl: async () => 'https://elsewhere.example/other', accessToken: TOKEN,
      origin: ORIGIN, serverOrigin: SERVER, collectionId: COLLECTION_ID,
      fetch: helper.fetch, now: () => 2_000,
    });
    assert.deepEqual(drain, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 0, 'the old page icon is never bound to the new URL');
    assert.equal(await sidecar.get(NATIVE_ID), null);
  });

  test('helper 5xx retries reuse the gesture Known-Command-Id', async () => {
    const helper = recordHelper();
    const sidecar = createFaviconSidecarStore({ indexedDB });
    let helperCalls = 0;
    const fetchMock: typeof fetch = async (url, init) => {
      if (String(url) === TAB_ICON) return new Response(PNG);
      // Only the capture POST is flaky; policy/source reads always succeed.
      if (String(url).endsWith('/favicon') && init?.method === 'POST') {
        helperCalls += 1;
        if (helperCalls === 1) {
          await helper.fetch(url, init);
          return new Response('', { status: 503 });
        }
      }
      return helper.fetch(url, init);
    };
    await saveBookmarkWithFaviconCapture(baseSave({ sidecar, fetch: fetchMock }));
    const first = await drainFaviconSidecars(baseDrain({ sidecar, fetch: fetchMock, now: () => 2_000 }));
    if (first === 'unsupported') throw new Error('favicon drain unsupported');
    assert.equal(first.posted, 0);
    assert.equal(helper.posts.length, 1);
    const second = await drainFaviconSidecars(baseDrain({ sidecar, fetch: fetchMock, now: () => 10_000 }));
    if (second === 'unsupported') throw new Error('favicon drain unsupported');
    assert.equal(second.posted, 1);
    assert.equal(helper.posts.length, 2);
    assert.equal(helper.posts[0]?.headers.get('Known-Command-Id'), COMMAND_ID);
    assert.equal(helper.posts[1]?.headers.get('Known-Command-Id'), COMMAND_ID);
    assert.notEqual(helper.posts[1]?.headers.get('Known-Command-Id'), crypto.randomUUID());
  });

  test('parentId is selectedRoots[0] native mapping and skips when roots or mapping are missing', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-a', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r1', cursor: 'c1' }, selectedRoots: [],
    });
    assert.equal(await resolveSelectedRootNativeId(store, scope), undefined);
    await store.putMapping(scope, {
      nativeId: PARENT_NATIVE, colpId: 'root-colp-first', rootNativeId: PARENT_NATIVE, nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'sha256:r1' },
    });
    await store.putMapping(scope, {
      nativeId: 'folder-native-2', colpId: 'root-colp-second', rootNativeId: 'folder-native-2', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'sha256:r2' },
    });
    await store.configureBrowserRoots(scope, {
      discovered: [
        { nativeId: PARENT_NATIVE, ancestorNativeIds: [] },
        { nativeId: 'folder-native-2', ancestorNativeIds: [] },
      ],
      selectedNativeIds: [PARENT_NATIVE, 'folder-native-2'], privateNativeIds: [], status: 'ready',
    });
    assert.equal(await resolveSelectedRootNativeId(store, scope), PARENT_NATIVE);
  });

  test('binds a mount mapping so configureBrowserRoots reuses that colpId', async () => {
    const store = createSyncStateStore({ indexedDB });
    const fresh = { ...scope, collectionId: 'collection-seed' };
    await store.registerScope({
      ...fresh, lifecycle: 'active', lease: { leaseId: 'lease-seed', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'c1', cursor: 'cursor-1' }, selectedRoots: [],
    });
    assert.equal(await store.bindMountMapping(fresh, {
      nativeId: PARENT_NATIVE, colpId: 'p3-27-root', mountId: 'mount-1', revision: 'c1',
    }), true);
    assert.equal(await store.bindMountMapping(fresh, {
      nativeId: PARENT_NATIVE, colpId: 'other-root', mountId: 'mount-1', revision: 'c1',
    }), false);
    await store.configureBrowserRoots(fresh, {
      discovered: [{ nativeId: PARENT_NATIVE, ancestorNativeIds: [] }],
      selectedNativeIds: [PARENT_NATIVE], privateNativeIds: [], status: 'ready',
    });
    assert.equal(await resolveSelectedRootNativeId(store, fresh), PARENT_NATIVE);
    assert.equal((await store.getMappingByNativeId(fresh, PARENT_NATIVE))?.colpId, 'p3-27-root');
    assert.equal((await store.getMappingByNativeId(fresh, PARENT_NATIVE))?.projection.revision, 'c1');
  });

  test('a local lookup for collection B never falls back to collection A', async () => {
    const store = createSyncStateStore({ indexedDB });
    const scopeA = { ...scope, collectionId: 'collection-a' };
    const scopeB = { ...scope, collectionId: 'collection-b' };
    await seedSelectedRoot(store, scopeA, 'folder-a', 'root-colp-a');
    await seedSelectedRoot(store, scopeB, 'folder-b', 'root-colp-b');
    assert.equal(await resolveSelectedRootNativeId(store, scopeA), 'folder-a');
    const bound = { parentNativeId: await resolveSelectedRootNativeId(store, scopeB) };
    assert.equal(bound.parentNativeId, 'folder-b');
    const created: Array<Record<string, unknown>> = [];
    await saveBookmarkWithFaviconCapture(baseSave({
      sidecar: createFaviconSidecarStore({ indexedDB: new IDBFactory() }),
      collectionId: 'collection-b', parentNativeId: bound.parentNativeId,
      bookmarks: {
        create: async (bookmark) => {
          created.push({ ...bookmark });
          return { id: NATIVE_ID, title: String(bookmark.title ?? ''), url: bookmark.url };
        },
      },
    }));
    assert.equal(created[0]?.parentId, 'folder-b');
    assert.notEqual(created[0]?.parentId, 'folder-a');
  });

  test('an unavailable local root skips capture without failing the native save', async () => {
    const created: Array<Record<string, unknown>> = [];
    const store = createSyncStateStore({ indexedDB });
    const bound = { parentNativeId: await resolveSelectedRootNativeId(store, scope) };
    assert.equal(bound.parentNativeId, undefined);
    const saved = await saveBookmarkWithFaviconCapture(baseSave({
      sidecar: createFaviconSidecarStore({ indexedDB: new IDBFactory() }),
      parentNativeId: bound.parentNativeId, collectionId: 'collection-b',
      bookmarks: {
        create: async (bookmark) => {
          created.push({ ...bookmark });
          return { id: NATIVE_ID, title: 'Example', url: bookmark.url };
        },
      },
    }));
    assert.equal('parentId' in (created[0] ?? {}), false);
    assert.equal(saved.captured, false);
    assert.equal(saved.nativeId, NATIVE_ID);
  });
});

describe('BF-06 expected skips (zero helper POST)', () => {
  test('non-http(s) favIconUrl must not fetch that URL', async () => {
    await assertSkip({
      favIconUrl: 'chrome://favicon/https://example.test/',
      forbiddenFetch: ['chrome://favicon/https://example.test/'],
    });
    await assertSkip({
      favIconUrl: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/icon.png',
      forbiddenFetch: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/icon.png'],
    });
    await assertSkip({
      favIconUrl: 'data:image/png;base64,iVBORw0KGgo=',
      forbiddenFetch: ['data:image/png;base64,iVBORw0KGgo='],
    });
  });

  test('cross-origin favIconUrl does not POST', async () => {
    await assertSkip({ favIconUrl: 'https://cdn.other.test/favicon.png', tabUrl: TAB_URL,
      forbiddenFetch: ['https://cdn.other.test/favicon.png'] });
  });

  test('SVG bytes do not POST', async () => {
    await assertSkip({
      favIconUrl: 'https://example.test/icon.svg',
      iconBody: SVG,
      iconType: 'image/svg+xml',
    });
  });

  test('body over 64 KiB does not POST', async () => {
    const oversized = new Uint8Array(65_537);
    oversized.set(PNG.subarray(0, 8));
    await assertSkip({ iconBody: oversized });
  });

  test('bookmark host denylist does not POST', async () => {
    await assertSkip({ url: 'http://localhost/app', favIconUrl: 'http://localhost/favicon.png', tabUrl: 'http://localhost/app' });
    await assertSkip({ url: 'http://foo.local/x', favIconUrl: 'http://foo.local/favicon.png', tabUrl: 'http://foo.local/x' });
    await assertSkip({ url: 'http://127.0.0.1/', favIconUrl: 'http://127.0.0.1/favicon.png', tabUrl: 'http://127.0.0.1/' });
  });

  test('no selectedRoots / no mapping creates without parentId and does not POST', async () => {
    const helper = recordHelper();
    const created: Array<Record<string, unknown>> = [];
    const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
    await saveBookmarkWithFaviconCapture(baseSave({
      sidecar, parentNativeId: undefined, collectionId: COLLECTION_ID,
      bookmarks: {
        create: async (bookmark) => {
          created.push({ ...bookmark });
          return { id: NATIVE_ID, title: 'Example', url: bookmark.url };
        },
      },
      fetch: helper.fetch,
    }));
    assert.equal('parentId' in (created[0] ?? {}), false);
    await drainFaviconSidecars(baseDrain({ sidecar, fetch: helper.fetch }));
    assert.equal(helper.posts.length, 0);
  });

  test('private save lands in the private-local root and still never POSTs', async () => {
    const fetched: string[] = [];
    const helper = recordHelper();
    const created: Array<Record<string, unknown>> = [];
    const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
    const saved = await saveBookmarkWithFaviconCapture(baseSave({
      sidecar, privateLocal: true, parentNativeId: PARENT_NATIVE, privateParentNativeId: 'private-native-1',
      bookmarks: {
        create: async (bookmark) => {
          created.push({ ...bookmark });
          return { id: NATIVE_ID, title: 'Example', url: bookmark.url };
        },
      },
      fetch: async (url, init) => {
        fetched.push(String(url));
        return helper.fetch(url, init);
      },
    }));
    assert.equal(created[0]?.parentId, 'private-native-1');
    assert.equal(saved.captured, false);
    assert.equal('parentId' in saved, false, 'private saves must not report a synced parent');
    assert.deepEqual(fetched, []);
    await drainFaviconSidecars(baseDrain({ sidecar, fetch: helper.fetch }));
    assert.equal(helper.posts.length, 0);
  });

  test('private toggle skips capture and creates without parentId', async () => {
    const fetched: string[] = [];
    const helper = recordHelper();
    const created: Array<Record<string, unknown>> = [];
    const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
    await saveBookmarkWithFaviconCapture(baseSave({
      sidecar, privateLocal: true, parentNativeId: PARENT_NATIVE,
      bookmarks: {
        create: async (bookmark) => {
          created.push({ ...bookmark });
          return { id: NATIVE_ID, title: 'Example', url: bookmark.url };
        },
      },
      fetch: async (url, init) => {
        fetched.push(String(url));
        return helper.fetch(url, init);
      },
    }));
    assert.equal('parentId' in (created[0] ?? {}), false);
    assert.deepEqual(fetched, []);
    await drainFaviconSidecars(baseDrain({ sidecar, fetch: helper.fetch }));
    assert.equal(helper.posts.length, 0);
  });

  test('mapping timeout / 15 min discard does not POST after discard', async () => {
    const helper = recordHelper();
    const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
    await saveBookmarkWithFaviconCapture(baseSave({
      sidecar, now: () => 1_000,
      fetch: async (url, init) => {
        if (String(url) === TAB_ICON) return new Response(PNG);
        return helper.fetch(url, init);
      },
    }));
    await drainFaviconSidecars(baseDrain({
      sidecar, fetch: helper.fetch, now: () => 1_000 + 15 * 60 * 1_000 + 1,
      lookupNodeId: async () => null,
    }));
    assert.equal(helper.posts.length, 0);
    assert.equal(await sidecar.get(NATIVE_ID), null);
  });

  test('helper 4xx keeps saved success and does not throw', async () => {
    const helper = recordHelper();
    const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
    const saved = await saveBookmarkWithFaviconCapture(baseSave({
      sidecar,
      fetch: async (url, init) => {
        if (String(url) === TAB_ICON) return new Response(PNG);
        return helper.fetch(url, init);
      },
    }));
    assert.equal(saved.nativeId, NATIVE_ID);
    const fetch4xx: typeof fetch = async (url, init) => {
      if (String(url) === TAB_ICON) return new Response(PNG);
      // Only the capture POST is rejected; policy/source reads succeed.
      if (String(url).endsWith('/favicon') && init?.method === 'POST') {
        await helper.fetch(url, init);
        return new Response('', { status: 400 });
      }
      return helper.fetch(url, init);
    };
    await drainFaviconSidecars(baseDrain({ sidecar, fetch: fetch4xx }));
    assert.equal(helper.posts.length, 1);
    await drainFaviconSidecars(baseDrain({ sidecar, fetch: fetch4xx, now: () => 20_000 }));
    assert.equal(helper.posts.length, 1);
  });
});

describe('BF-06 source contracts', () => {
  test('does not add all_urls or Product CSRF upload', async () => {
    const root = resolve(import.meta.dirname, '..');
    const files = ['src/popup.ts', 'src/favicon-upload.ts', 'src/favicon-save.ts',
      'src/favicon-capture.ts', 'src/favicon-sidecar-store.ts', 'src/favicon-helper-client.ts',
      'src/sync-state-store.ts', 'src/sync-state/schema.ts'];
    const source = `${await readServiceWorkerGraph(root)}\n${(await Promise.all(files.map((file) => readFile(resolve(root, file), 'utf8')))).join('\n')}`;
    assert.doesNotMatch(source, /<all_urls>/);
    assert.doesNotMatch(source, /\/api\/v1\/collections\/.*\/favicon/);
    assert.match(source, /DATABASE_VERSION = 21/);
    assert.match(source, /known-favicon-sidecar/);
    assert.match(source, /Known-Command-Id/);
    assert.match(source, /colp\/v0\.1\/sync\/collections/);
    assert.match(source, /waitUntilBookmarkIngressOpen/);
    assert.match(source, /recoveryFrozen/);
    // The popup save must not hang on first-run bootstrap: the ingress wait
    // is bounded to seconds, and the unfreeze reconcile repairs a save that
    // proceeded while ingress was still frozen.
    assert.match(source, /INGRESS_OPEN_WAIT_MS = 3_000/);
    assert.doesNotMatch(source, /Date\.now\(\) \+ 20_000/);
  });
});

function recordHelper(etags?: { policyEtag?: string; sourceEtag?: string }) {
  const posts: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('/api/v1/collections/')) throw new Error(`product csrf favicon must not be called: ${href}`);
    if (href.endsWith('/favicon-policy')) {
      return new Response(JSON.stringify(POLICY_BODY), {
        status: 200, headers: { 'content-type': 'application/json', etag: etags?.policyEtag ?? '"favicon-policy:1"' },
      });
    }
    if (href.endsWith('/favicon-source')) {
      return new Response(JSON.stringify(SOURCE_BODY), {
        status: 200, headers: { 'content-type': 'application/json', etag: etags?.sourceEtag ?? SOURCE_ETAG },
      });
    }
    if (!href.includes('/colp/v0.1/sync/collections/') || !href.endsWith('/favicon')) {
      throw new Error(`unexpected fetch ${href}`);
    }
    const raw = init?.body;
    const body = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw)
      : new Uint8Array();
    posts.push({ url: href, headers: new Headers(init?.headers), body });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { posts, fetch: fetchImpl };
}

function baseSave(overrides: Partial<Parameters<typeof saveBookmarkWithFaviconCapture>[0]> & {
  sidecar: ReturnType<typeof createFaviconSidecarStore>;
}): Parameters<typeof saveBookmarkWithFaviconCapture>[0] {
  return {
    title: 'Example', url: TAB_URL, favIconUrl: TAB_ICON, privateLocal: false,
    parentNativeId: PARENT_NATIVE, collectionId: COLLECTION_ID,
    bookmarks: {
      create: async (bookmark) => ({ id: NATIVE_ID, title: String(bookmark.title ?? ''), url: bookmark.url }),
    },
    fetch: async () => new Response(PNG), randomUUID: () => COMMAND_ID, now: () => 1_000,
    ...overrides,
  };
}

function baseDrain(overrides: Partial<Parameters<typeof drainFaviconSidecars>[0]> & {
  sidecar: ReturnType<typeof createFaviconSidecarStore>; fetch: typeof fetch;
}): Parameters<typeof drainFaviconSidecars>[0] {
  return {
    lookupNodeId: async (nativeId) => nativeId === NATIVE_ID ? NODE_ID : null,
    bookmarkUrl: async () => TAB_URL, accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER,
    collectionId: COLLECTION_ID, now: () => 2_000, ...overrides,
  };
}

async function seedSelectedRoot(store: ReturnType<typeof createSyncStateStore>, item: SyncScope,
  nativeId: string, colpId: string): Promise<void> {
  await store.registerScope({
    ...item, lifecycle: 'active', lease: { leaseId: `lease-${item.collectionId}`, expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r1', cursor: 'c1' }, selectedRoots: [],
  });
  await store.putMapping(item, {
    nativeId, colpId, rootNativeId: nativeId, nodeKind: 'folder',
    projection: { revision: 'r1', digest: `sha256:${colpId}` },
  });
  await store.configureBrowserRoots(item, {
    discovered: [{ nativeId, ancestorNativeIds: [] }],
    selectedNativeIds: [nativeId], privateNativeIds: [], status: 'ready',
  });
}

async function assertSkip(options: {
  url?: string; tabUrl?: string; favIconUrl?: string; iconBody?: Uint8Array; iconType?: string;
  forbiddenFetch?: readonly string[]; parentNativeId?: string; privateLocal?: boolean;
}): Promise<void> {
  const helper = recordHelper();
  const fetched: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
  const favIconUrl = options.favIconUrl ?? TAB_ICON;
  const tabUrl = options.tabUrl ?? options.url ?? TAB_URL;
  await saveBookmarkWithFaviconCapture({
    title: 'Example', url: options.url ?? TAB_URL, favIconUrl, privateLocal: options.privateLocal ?? false,
    parentNativeId: options.parentNativeId === undefined ? PARENT_NATIVE : options.parentNativeId,
    collectionId: COLLECTION_ID,
    bookmarks: {
      create: async (bookmark) => {
        created.push({ ...bookmark });
        return { id: NATIVE_ID, title: 'Example', url: bookmark.url };
      },
    },
    fetch: async (url, init) => {
      fetched.push(String(url));
      if (options.forbiddenFetch?.includes(String(url))) throw new Error(`must not fetch ${String(url)}`);
      if (String(url) === favIconUrl) {
        return new Response(options.iconBody ?? PNG, {
          headers: { 'content-type': options.iconType ?? 'image/png' },
        });
      }
      return helper.fetch(url, init);
    },
    sidecar, randomUUID: () => COMMAND_ID, now: () => 1_000,
  });
  await drainFaviconSidecars(baseDrain({
    sidecar, fetch: async (url, init) => {
      fetched.push(String(url));
      return helper.fetch(url, init);
    },
    bookmarkUrl: async () => options.url ?? TAB_URL,
  }));
  assert.equal(helper.posts.length, 0);
  for (const url of options.forbiddenFetch ?? []) assert.equal(fetched.includes(url), false, url);
}
