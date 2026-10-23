import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBookmarkImportCoordinator } from '../src/bookmark-import-plan.js';
import { decodeBookmarkFaviconDataUrl } from '../src/favicon-import.js';
import { createFaviconSidecarStore } from '../src/favicon-sidecar-store.js';
import { drainFaviconSidecars } from '../src/favicon-upload.js';
import {
  previewChromeBookmarkImport,
  previewNetscapeBookmarkImport,
  type ImportConversionResult,
} from '../src/import-preview.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const COMMAND_ID = 'c0ffee00-0000-4000-8000-0000000000bf';
const COLLECTION_ID = 'collection';
const NODE_ID = 'node-colp-import-1';
const ORIGIN = 'chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen';
const SERVER = 'https://known.example';
const TOKEN = 'colp-access-token';
const HELPER = `${SERVER}/colp/v0.1/sync/collections/${COLLECTION_ID}/nodes/${NODE_ID}/favicon`;
const ICON_URI = 'https://cdn.example/favicon.ico';
const INTRANET_PUBLIC_FORM = 'https://intranet.example.test/home';
const INTRANET_DENIED = 'https://files.intranet/doc';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'known', serverOrigin: SERVER,
  accountId: 'account', browserProfileId: 'profile', collectionId: COLLECTION_ID, replicaId: 'replica', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('BF-I Netscape ICON data URL decode (no fetch)', () => {
  test('accepts PNG data URL and optional charset; sniffs PNG bytes declared as ICO', () => {
    assert.deepEqual(decodeBookmarkFaviconDataUrl(pngDataUrl(PNG, 'image/png')), {
      contentType: 'image/png', bytes: PNG,
    });
    assert.deepEqual(decodeBookmarkFaviconDataUrl(pngDataUrl(PNG, 'image/png;charset=utf-8')), {
      contentType: 'image/png', bytes: PNG,
    });
    assert.equal(decodeBookmarkFaviconDataUrl(pngDataUrl(PNG, 'image/x-icon'))?.contentType, 'image/png');
    assert.deepEqual(decodeBookmarkFaviconDataUrl(`data:;base64,${b64(PNG)}`)?.bytes, PNG);
  });

  test('rejects html svg http(s) ICON_URI oversize and bad magic without throwing', () => {
    assert.equal(decodeBookmarkFaviconDataUrl(`data:text/html;base64,${b64(PNG)}`), null);
    assert.equal(decodeBookmarkFaviconDataUrl(`data:image/svg+xml;base64,${b64(SVG)}`), null);
    assert.equal(decodeBookmarkFaviconDataUrl('https://cdn.example/favicon.ico'), null);
    assert.equal(decodeBookmarkFaviconDataUrl(ICON_URI), null);
    assert.equal(decodeBookmarkFaviconDataUrl(`data:image/png;base64,${b64(SVG)}`), null);
    assert.equal(decodeBookmarkFaviconDataUrl('data:image/png;base64,QQ=='), null);
    const oversized = new Uint8Array(65_537);
    oversized.set(PNG.subarray(0, 8));
    assert.equal(decodeBookmarkFaviconDataUrl(pngDataUrl(oversized)), null);
    assert.equal(decodeBookmarkFaviconDataUrl(`data:image/png;base64,${'A'.repeat(100_000)}`), null);
  });
});

describe('BF-I preview remains fetch-free sidecar warning', () => {
  test('ICON=data PNG preview warns favicon_sidecar_only with zero fetch and no helper POST', () => {
    const fetched = installFetchRecorder();
    const helper = recordHelper();
    try {
      const conversion = previewNetscapeBookmarkImport(folderHtml({
        href: 'https://example.test/', icon: pngDataUrl(PNG, 'image/x-icon'), title: 'Example',
      }));
      assert.ok(conversion.preview.warnings.some((warning) => warning.code === 'favicon_sidecar_only'));
      assert.ok(!conversion.preview.warnings.some((warning) => warning.code === 'unknown_extension_preserved_remote_only'));
      assert.equal(conversion.tree[0]?.children[0]?.icon, pngDataUrl(PNG, 'image/x-icon'));
      assert.equal(conversion.tree[0]?.children[0]?.extensions, undefined);
      assert.deepEqual(fetched.urls, []);
      assert.equal(helper.posts.length, 0);
    } finally {
      fetched.restore();
    }
  });
});

describe('BF-I import commit materializes ICON=data into the BF-06 sidecar', () => {
  test('commit of PNG-as-ICO data URL sidecars import nativeId then drain POSTs helper once', async () => {
    const fetched = installFetchRecorder();
    const helper = recordHelper();
    try {
      const { coordinator, sidecar } = await setup();
      const conversion = previewNetscapeBookmarkImport(folderHtml({
        href: 'https://example.test/', icon: pngDataUrl(PNG, 'image/x-icon'), title: 'Example',
      }));
      const bookmark = conversion.tree[0]!.children[0]!;
      const plan = await coordinator.commit({
        conversion, choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
        randomUUID: () => COMMAND_ID, now: () => 1_000,
      });
      assert.equal(plan.progress.skipped, 0);
      const nativeId = `import:${plan.planId}:${bookmark.sourceNodeId}`;
      const row = await sidecar.get(nativeId);
      assert.equal(row?.contentType, 'image/png');
      assert.equal(row?.origin, 'import');
      assert.equal(row?.commandId, COMMAND_ID);
      assert.deepEqual(new Uint8Array(row!.bytes), PNG);

      const stored = plan.nodes.find((item) => item.sourceNodeId === bookmark.sourceNodeId)?.node;
      assert.deepEqual(stored, { kind: 'bookmark', title: 'Example', url: 'https://example.test/' });
      assert.doesNotMatch(JSON.stringify(stored), /data:/);

      const drain = await drainFaviconSidecars(baseDrain({
        sidecar, fetch: helper.fetch, nativeId,
        bookmarkUrl: async () => null,
      }));
      if (drain === 'unsupported') throw new Error('favicon drain unsupported');
      assert.equal(drain.posted, 1);
      assert.equal(helper.posts.length, 1);
      const post = helper.posts[0]!;
      assert.equal(post.url, HELPER);
      assert.equal(post.headers.get('Authorization'), `Bearer ${TOKEN}`);
      assert.equal(post.headers.get('Known-Command-Id'), COMMAND_ID);
      assert.equal(post.headers.get('Content-Type'), 'image/png');
      assert.equal(post.headers.get('Origin'), ORIGIN);
      assert.doesNotMatch(post.url, /\/api\/v1\/collections\//);
      assert.deepEqual(post.body, PNG);
      assert.equal(fetched.urls.filter((url) => url.includes('cdn.example') || url.startsWith('data:')).length, 0);
    } finally {
      fetched.restore();
    }
  });

  test('ICON_URI-only keeps the warning and never fetches or helper POSTs', async () => {
    const fetched = installFetchRecorder();
    const helper = recordHelper();
    try {
      const { coordinator, sidecar } = await setup();
      const conversion = previewNetscapeBookmarkImport(folderHtml({
        href: 'https://example.test/', iconUri: ICON_URI, title: 'Example',
      }));
      assert.ok(conversion.preview.warnings.some((warning) => warning.code === 'favicon_sidecar_only'));
      assert.equal(conversion.tree[0]?.children[0]?.icon, undefined);
      const plan = await coordinator.commit({
        conversion, choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
        randomUUID: () => COMMAND_ID, now: () => 1_000,
      });
      assert.equal((await sidecar.list(COLLECTION_ID)).length, 0);
      await drainFaviconSidecars(baseDrain({
        sidecar, fetch: async (url, init) => {
          fetched.urls.push(String(url));
          return helper.fetch(url, init);
        },
        nativeId: `import:${plan.planId}:${conversion.tree[0]!.children[0]!.sourceNodeId}`,
      }));
      assert.equal(helper.posts.length, 0);
      assert.deepEqual(fetched.urls, []);
    } finally {
      fetched.restore();
    }
  });

  test('oversize ICON=data still imports with no sidecar', async () => {
    const oversized = new Uint8Array(65_537);
    oversized.set(PNG.subarray(0, 8));
    const { coordinator, sidecar } = await setup();
    const conversion = previewNetscapeBookmarkImport(folderHtml({
      href: 'https://example.test/', icon: pngDataUrl(oversized), title: 'Huge',
    }));
    const plan = await coordinator.commit({
      conversion, choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
      randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    assert.equal(plan.progress.total, 2);
    assert.equal((await sidecar.list(COLLECTION_ID)).length, 0);
  });

  test('SVG ICON=data does not sidecar', async () => {
    const { coordinator, sidecar } = await setup();
    const conversion = previewNetscapeBookmarkImport(folderHtml({
      href: 'https://example.test/', icon: `data:image/svg+xml;base64,${b64(SVG)}`, title: 'Svg',
    }));
    await coordinator.commit({
      conversion, choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
      randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    assert.equal((await sidecar.list(COLLECTION_ID)).length, 0);
  });

  test('Chrome JSON/tree import writes zero sidecar rows', async () => {
    const { coordinator, sidecar } = await setup();
    const conversion = previewChromeBookmarkImport([{
      id: '0', title: '', children: [
        {
          id: '1', parentId: '0', index: 0, title: 'Bar', type: 'folder', children: [
            { id: '2', parentId: '1', index: 0, title: 'Example', url: 'https://example.test/' },
          ],
        },
      ],
    }]);
    assert.equal(conversion.tree[0]?.children[0]?.icon, undefined);
    await coordinator.commit({
      conversion, choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
      randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    assert.equal((await sidecar.list(COLLECTION_ID)).length, 0);
  });

  test('skipped folder choice does not sidecar those bookmarks', async () => {
    const { coordinator, sidecar } = await setup();
    const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode(
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>'
      + '<DT><H3>Keep</H3><DL><p>'
      + `<DT><A HREF="https://example.test/keep" ICON="${pngDataUrl(PNG)}">Keep</A></DL><p>`
      + '<DT><H3>Skip me</H3><DL><p>'
      + `<DT><A HREF="https://example.test/skip" ICON="${pngDataUrl(PNG)}">Skip</A></DL><p></DL><p>`,
    ));
    const plan = await coordinator.commit({
      conversion, choices: [
        { sourceNodeId: conversion.tree[0]!.sourceNodeId, action: 'import', target: {
          nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } },
        { sourceNodeId: conversion.tree[1]!.sourceNodeId, action: 'skip' },
      ], sidecar, collectionId: COLLECTION_ID, randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    const keepId = `import:${plan.planId}:${conversion.tree[0]!.children[0]!.sourceNodeId}`;
    const skipId = `import:${plan.planId}:${conversion.tree[1]!.children[0]!.sourceNodeId}`;
    assert.ok(await sidecar.get(keepId));
    assert.equal(await sidecar.get(skipId), null);
    assert.equal((await sidecar.list(COLLECTION_ID)).length, 1);
  });

  test('intranet ICON=data PNG sidecars and drain POSTs; host denylist does not apply to import bytes', async () => {
    const helper = recordHelper();
    const { coordinator, sidecar } = await setup();
    const conversion = previewNetscapeBookmarkImport(folderHtml({
      href: INTRANET_PUBLIC_FORM, icon: pngDataUrl(PNG), title: 'Intranet',
    }));
    const bookmark = conversion.tree[0]!.children[0]!;
    const plan = await coordinator.commit({
      conversion, choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
      randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    const nativeId = `import:${plan.planId}:${bookmark.sourceNodeId}`;
    assert.equal((await sidecar.get(nativeId))?.origin, 'import');
    const drain = await drainFaviconSidecars(baseDrain({
      sidecar, fetch: helper.fetch, nativeId,
      bookmarkUrl: async () => INTRANET_DENIED,
    }));
    if (drain === 'unsupported') throw new Error('favicon drain unsupported');
    assert.equal(drain.posted, 1);
    assert.equal(helper.posts.length, 1);
  });

  test('capture-origin sidecar without import marker for intranet host is still discarded at drain', async () => {
    const helper = recordHelper();
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await sidecar.put({
      nativeId: 'bookmark-native-1', contentType: 'image/png', bytes: PNG, commandId: COMMAND_ID,
      collectionId: COLLECTION_ID, createdAt: 1_000, attempts: 0, notBefore: 0,
    });
    const drain = await drainFaviconSidecars(baseDrain({
      sidecar, fetch: helper.fetch, nativeId: 'bookmark-native-1',
      bookmarkUrl: async () => INTRANET_DENIED,
    }));
    if (drain === 'unsupported') throw new Error('favicon drain unsupported');
    assert.equal(drain.posted, 0);
    assert.equal(drain.discarded, 1);
    assert.equal(helper.posts.length, 0);
    assert.equal(await sidecar.get('bookmark-native-1'), null);
  });

  test('replay commit last-write-wins the same import nativeId and drain POSTs once', async () => {
    const helper = recordHelper();
    const { coordinator, sidecar } = await setup();
    const conversion = previewNetscapeBookmarkImport(folderHtml({
      href: 'https://example.test/', icon: pngDataUrl(PNG, 'image/x-icon'), title: 'Example',
    }));
    const first = await coordinator.commit({
      conversion, choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
      randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    const replay = await coordinator.commit({
      conversion: structuredClone(conversion), choices: importAll(conversion), sidecar, collectionId: COLLECTION_ID,
      randomUUID: () => COMMAND_ID, now: () => 1_000,
    });
    assert.equal(replay.planId, first.planId);
    const nativeId = `import:${first.planId}:${conversion.tree[0]!.children[0]!.sourceNodeId}`;
    assert.equal((await sidecar.list(COLLECTION_ID)).length, 1);
    const drain = await drainFaviconSidecars(baseDrain({ sidecar, fetch: helper.fetch, nativeId }));
    if (drain === 'unsupported') throw new Error('favicon drain unsupported');
    assert.equal(drain.posted, 1);
    assert.equal(helper.posts.length, 1);
  });
});

describe('BF-I source contracts', () => {
  test('does not add all_urls, Product CSRF helper mix, or COLP create_attachment', async () => {
    const root = resolve(import.meta.dirname, '..');
    const files = [
      'src/favicon-import.ts', 'src/bookmark-import-plan.ts', 'src/import-preview.ts',
      'src/favicon-upload.ts', 'src/favicon-sidecar-store.ts', 'src/favicon-helper-client.ts',
      'src/options.ts', 'src/sync-state-store.ts', 'src/sync-state/schema.ts',
    ];
    const source = `${await readServiceWorkerGraph(root)}\n${(await Promise.all(files.map((file) => readFile(resolve(root, file), 'utf8')))).join('\n')}`;
    assert.doesNotMatch(source, /<all_urls>/);
    assert.doesNotMatch(source, /\/api\/v1\/collections\/.*\/favicon/);
    assert.doesNotMatch(source, /create_attachment/);
    assert.match(source, /DATABASE_VERSION = 22/);
    assert.match(source, /Known-Command-Id/);
    assert.match(source, /colp\/v0\.1\/sync\/collections/);
    const preview = await readFile(resolve(root, 'src/import-preview.ts'), 'utf8');
    assert.doesNotMatch(preview, /fetch\s*\(/);
    const decoder = await readFile(resolve(root, 'src/favicon-import.ts'), 'utf8');
    assert.doesNotMatch(decoder, /fetch\s*\(|canvas|ICON_URI/);
    const options = await readFile(resolve(root, 'src/sync-import.ts'), 'utf8');
    assert.match(options, /FAVICON_SIDECAR_ALARM/);
    const worker = await readServiceWorkerGraph(root);
    assert.match(worker, /sidecar:\s*faviconSidecar/);
  });
});

async function setup() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r1', cursor: 'c1' }, selectedRoots: ['root'],
  });
  await store.putMapping(scope, {
    nativeId: 'native-root', colpId: 'server-root', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'children-r1', digest: 'sha256:root' },
  });
  return {
    store,
    coordinator: createBookmarkImportCoordinator({ store, scope, now: () => 100 }),
    sidecar: createFaviconSidecarStore({ indexedDB }),
  };
}

function importAll(conversion: ImportConversionResult) {
  return conversion.tree.map((node) => ({
    sourceNodeId: node.sourceNodeId, action: 'import' as const,
    target: { nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' },
  }));
}

function folderHtml(options: { href: string; icon?: string; iconUri?: string; title: string }): Uint8Array {
  const attrs = [`HREF="${options.href}"`];
  if (options.icon !== undefined) attrs.push(`ICON="${options.icon}"`);
  if (options.iconUri !== undefined) attrs.push(`ICON_URI="${options.iconUri}"`);
  return new TextEncoder().encode(
    `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Reading</H3><DL><p>`
    + `<DT><A ${attrs.join(' ')}>${options.title}</A></DL><p></DL><p>`,
  );
}

function pngDataUrl(bytes: Uint8Array, declared = 'image/png'): string {
  return `data:${declared};base64,${b64(bytes)}`;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function recordHelper() {
  const posts: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('/api/v1/collections/')) throw new Error(`product csrf favicon must not be called: ${href}`);
    if (href.endsWith('/favicon-policy')) {
      return new Response(JSON.stringify({
        revision: '1', newDefault: 'capture', providerTemplate: 'https://favicone.com/{hostname}',
        fillMissing: false, forceAllOnline: false, updatedAt: '2026-09-14T00:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json', etag: '"favicon-policy:1"' } });
    }
    if (href.endsWith('/favicon-source')) {
      return new Response(JSON.stringify({
        collectionId: COLLECTION_ID, nodeId: NODE_ID, revision: '1', policyRevision: '1',
        sourceMode: 'inherit', effectiveMode: 'capture', iconUrl: null, iconVersion: null,
        directUrl: null, status: 'missing', restorable: false, updatedAt: '2026-09-14T00:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json', etag: '"favicon-source:node-colp-1:1"' } });
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

function baseDrain(overrides: Partial<Parameters<typeof drainFaviconSidecars>[0]> & {
  sidecar: ReturnType<typeof createFaviconSidecarStore>; fetch: typeof fetch; nativeId: string;
}): Parameters<typeof drainFaviconSidecars>[0] {
  const nativeId = overrides.nativeId;
  return {
    lookupNodeId: async (id) => id === nativeId ? NODE_ID : null,
    bookmarkUrl: async () => 'https://example.test/', accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER,
    collectionId: COLLECTION_ID, now: () => 2_000, ...overrides,
  };
}

function installFetchRecorder(): { urls: string[]; restore(): void } {
  const urls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    throw new Error(`BF-I must not fetch ${String(url)}`);
  }) as typeof fetch;
  return {
    urls,
    restore() { globalThis.fetch = prior; },
  };
}
