import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createFaviconSidecarStore } from '../src/favicon-sidecar-store.js';
import { clearCapturedFavicon } from '../src/favicon-clear.js';
import type { IconPolicyDto, IconSourceDto } from '../src/favicon-helper-client.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10, 0x20]);
const COLLECTION = 'collection-1';
const NODE = 'node-colp-1';
const NATIVE = 'bookmark-native-1';
const TOKEN = 'colp-access-token';
const ORIGIN = 'chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen';
const SERVER = 'https://known.example';
const COMMAND_ID = 'c0ffee00-0000-4000-8000-000000000001';
const SOURCE_ETAG_V1 = '"favicon-source:bm-res-1:1"';
const SOURCE_ETAG_V2 = '"favicon-source:bm-res-1:2"';

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

function capturableSource(overrides: Partial<IconSourceDto> = {}): IconSourceDto {
  return {
    collectionId: COLLECTION, nodeId: NODE, revision: '1', policyRevision: '1',
    sourceMode: 'inherit', effectiveMode: 'capture', iconUrl: null, iconVersion: null,
    directUrl: null, status: 'missing', restorable: false,
    updatedAt: '2026-09-14T00:00:00.000Z', ...overrides,
  };
}

function accountPolicy(overrides: Partial<IconPolicyDto> = {}): IconPolicyDto {
  return {
    revision: '1', newDefault: 'capture', providerTemplate: 'https://favicone.com/{hostname}',
    fillMissing: false, forceAllOnline: false, updatedAt: '2026-09-14T00:00:00.000Z', ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface ClearHelperOptions {
  readonly policy?: IconPolicyDto;
  readonly source?: IconSourceDto;
  readonly sourceStatus?: number;
  /** Served from the second source read onward (the 412 refresh). */
  readonly refreshedSource?: IconSourceDto;
  /** Per-DELETE status list; the last value repeats. */
  readonly deleteStatuses?: readonly number[];
}

function createClearHelper(options: ClearHelperOptions = {}) {
  const deletes: Array<{ url: string; method: string; headers: Headers }> = [];
  let sourceCalls = 0;
  let deleteCalls = 0;
  const sourceAt = (() => {
    if (options.refreshedSource !== undefined) {
      return () => {
        sourceCalls += 1;
        return sourceCalls > 1 ? options.refreshedSource! : (options.source ?? capturableSource());
      };
    }
    return () => { sourceCalls += 1; return options.source ?? capturableSource(); };
  })();

  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/favicon-policy')) {
      return jsonResponse(200, options.policy ?? accountPolicy(), { etag: '"favicon-policy:1"' });
    }
    if (href.endsWith('/favicon-source')) {
      if (options.sourceStatus === 404) return jsonResponse(404, { error: { code: 'resource_not_found' } });
      const source = sourceAt();
      const etag = sourceCalls > 1 && options.refreshedSource !== undefined ? SOURCE_ETAG_V2 : SOURCE_ETAG_V1;
      return jsonResponse(200, source, { etag });
    }
    if (href.endsWith('/favicon') && init?.method === 'DELETE') {
      deleteCalls += 1;
      deletes.push({ url: href, method: String(init?.method), headers: new Headers(init?.headers) });
      const status = (options.deleteStatuses ?? [200])[
        Math.min(deleteCalls - 1, (options.deleteStatuses ?? [200]).length - 1)] ?? 200;
      if (status >= 200 && status < 300) return jsonResponse(status, { id: NODE, kind: 'bookmark' });
      return jsonResponse(status, { error: { code: 'precondition_failed' } });
    }
    throw new Error(`unexpected helper fetch ${href} ${String(init?.method)}`);
  };

  return {
    deletes,
    get sourceCalls() { return sourceCalls; },
    get deleteCalls() { return deleteCalls; },
    fetch: fetchImpl,
    async run(sidecar: ReturnType<typeof createFaviconSidecarStore>, overrides: {
      randomUUID?: () => string;
    } = {}) {
      return clearCapturedFavicon({
        sidecar, collectionId: COLLECTION, nativeId: NATIVE, nodeId: NODE,
        accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER,
        fetch: fetchImpl, randomUUID: overrides.randomUUID,
      });
    },
  };
}

describe('FO-04 clearExtensionCapturedFavicon consumer', () => {
  test('clear DELETE sends If-Match + policy revision + a fresh command id and discards the queued row', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await sidecar.put({
      nativeId: NATIVE, contentType: 'image/png', bytes: PNG, commandId: COMMAND_ID,
      collectionId: COLLECTION, createdAt: 1_000, attempts: 0, notBefore: 0,
      pageUrl: 'https://example.test/page',
    });
    const helper = createClearHelper();
    const outcome = await helper.run(sidecar, { randomUUID: () => COMMAND_ID });
    assert.deepEqual(outcome, { status: 'cleared' });
    assert.equal(helper.deletes.length, 1);
    const del = helper.deletes[0]!;
    assert.match(del.url, /\/colp\/v0\.1\/sync\/collections\/collection-1\/nodes\/node-colp-1\/favicon$/);
    assert.equal(del.method, 'DELETE');
    assert.equal(del.headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(del.headers.get('origin'), ORIGIN);
    assert.equal(del.headers.get('known-command-id'), COMMAND_ID);
    assert.equal(del.headers.get('if-match'), SOURCE_ETAG_V1);
    assert.equal(del.headers.get('known-favicon-policy-revision'), '1');
    assert.equal(await sidecar.get(NATIVE), null, 'the queued bytes must never replay the cleared icon');
  });

  test('an automatic binding remains clearable when its rendered effective mode is uploaded', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    const helper = createClearHelper({ source: capturableSource({ sourceMode: 'inherit',
      effectiveMode: 'uploaded', iconVersion: 'automatic-object', status: 'ready' }) });
    assert.deepEqual(await helper.run(sidecar), { status: 'cleared' });
    assert.equal(helper.deletes.length, 1);
  });

  test('uploaded and none sources refuse the clear with no DELETE', async () => {
    for (const source of [
      capturableSource({ sourceMode: 'uploaded', effectiveMode: 'uploaded', iconVersion: 'obj-1' }),
      capturableSource({ sourceMode: 'none', effectiveMode: 'none' }),
    ]) {
      const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
      const helper = createClearHelper({ source });
      assert.deepEqual(await helper.run(sidecar), { status: 'protected' });
      assert.equal(helper.deletes.length, 0, 'uploaded/none sources are never cleared');
    }
  });

  test('forceAllOnline policy refuses the clear with no DELETE', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    const helper = createClearHelper({ policy: accountPolicy({ forceAllOnline: true }) });
    assert.deepEqual(await helper.run(sidecar), { status: 'protected' });
    assert.equal(helper.deletes.length, 0);
  });

  test('a node without a helper source (404) is a noop, never a DELETE', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    const helper = createClearHelper({ sourceStatus: 404 });
    assert.deepEqual(await helper.run(sidecar), { status: 'noop' });
    assert.equal(helper.deletes.length, 0);
  });

  test('an offline helper is unavailable, never a DELETE', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    const outcome = await clearCapturedFavicon({
      sidecar, collectionId: COLLECTION, nativeId: NATIVE, nodeId: NODE,
      accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER,
      fetch: async () => { throw new TypeError('fetch failed'); },
    });
    assert.deepEqual(outcome, { status: 'unavailable' });
    assert.equal(await sidecar.get(NATIVE), null, 'an unavailable clear must not touch queued bytes');
  });

  test('412 refreshes source + policy once and retries with the fresh validators', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    const helper = createClearHelper({
      refreshedSource: capturableSource({ revision: '2' }),
      deleteStatuses: [412, 200],
    });
    const outcome = await helper.run(sidecar);
    assert.deepEqual(outcome, { status: 'cleared' });
    assert.equal(helper.deletes.length, 2);
    assert.equal(helper.deletes[0]!.headers.get('if-match'), SOURCE_ETAG_V1);
    assert.equal(helper.deletes[1]!.headers.get('if-match'), SOURCE_ETAG_V2,
      'the retry must run under the fresh source ETag');
    assert.notEqual(helper.deletes[1]!.headers.get('known-command-id'),
      helper.deletes[0]!.headers.get('known-command-id'));
    assert.equal(helper.sourceCalls, 2);
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('a second 412 after the refresh is unavailable, never a DELETE success', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await sidecar.put({
      nativeId: NATIVE, contentType: 'image/png', bytes: PNG, commandId: COMMAND_ID,
      collectionId: COLLECTION, createdAt: 1_000, attempts: 0, notBefore: 0,
      pageUrl: 'https://example.test/page',
    });
    const helper = createClearHelper({ refreshedSource: capturableSource({ revision: '2' }), deleteStatuses: [412, 412] });
    const outcome = await helper.run(sidecar);
    assert.deepEqual(outcome, { status: 'unavailable' });
    assert.equal(helper.deletes.length, 2);
    assert.ok(await sidecar.get(NATIVE), 'a failed clear must not discard queued bytes');
  });
});
