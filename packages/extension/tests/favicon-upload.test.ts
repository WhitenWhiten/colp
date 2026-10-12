import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createFaviconSidecarStore } from '../src/favicon-sidecar-store.js';
import { drainFaviconSidecars, FAVICON_HELPER_MAX_ATTEMPTS } from '../src/favicon-upload.js';
import type { IconPolicyDto, IconSourceDto } from '../src/favicon-helper-client.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10, 0x20]);
const COLLECTION = 'collection-1';
const NODE = 'node-colp-1';
const NATIVE = 'bookmark-native-1';
const TOKEN = 'colp-access-token';
const ORIGIN = 'chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen';
const SERVER = 'https://known.example';
const COMMAND_A = 'c0ffee00-0000-4000-8000-000000000001';
const POLICY_ETAG = '"favicon-policy:1"';
const SOURCE_ETAG_V1 = '"favicon-source:bm-res-1:1"';
const SOURCE_ETAG_V2 = '"favicon-source:bm-res-1:2"';
const PAGE_URL = 'https://example.test/page';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

interface CapturedPost {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly token: string | null;
}

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

/** Per-POST status list; the last value repeats. */
function postStatusAt(index: number, list: readonly number[]): number {
  return list[Math.min(index, list.length - 1)] ?? 200;
}

function errorCodeFor(status: number): string {
  if (status === 428) return 'precondition_required';
  if (status === 403) return 'insufficient_permission';
  if (status === 404) return 'resource_not_found';
  if (status === 412) return 'precondition_failed';
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'command_id_reused';
  return 'internal_error';
}

interface HelperOptions {
  readonly policy?: IconPolicyDto;
  readonly policyStatus?: number;
  readonly policyByToken?: Record<string, IconPolicyDto>;
  /** Served from the second policy read onward (the 412/428 refresh). */
  readonly refreshedPolicy?: IconPolicyDto;
  readonly source?: IconSourceDto;
  readonly sourceStatus?: number;
  /** Served from the second source read onward (the 412 refresh). */
  readonly refreshedSource?: IconSourceDto;
  readonly postStatuses?: readonly number[];
}

function createHelper(options: HelperOptions = {}) {
  const posts: CapturedPost[] = [];
  const policyUrls: string[] = [];
  let sourceCalls = 0;
  let postCalls = 0;
  const policyFor = (token: string | null) => {
    if (options.policyByToken !== undefined) {
      return options.policyByToken[token ?? ''] ?? accountPolicy({ newDefault: 'none' });
    }
    return options.policy ?? accountPolicy();
  };
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
      policyUrls.push(href);
      const token = authorizationOf(init?.headers);
      if (options.policyStatus !== undefined && options.policyStatus !== 200) {
        return jsonResponse(options.policyStatus, { error: { code: 'service_unavailable' } });
      }
      const policy = policyUrls.length > 1 && options.refreshedPolicy !== undefined
        ? options.refreshedPolicy
        : policyFor(token);
      return jsonResponse(200, policy, { etag: POLICY_ETAG });
    }
    if (href.endsWith('/favicon-source')) {
      if (options.sourceStatus !== undefined && options.sourceStatus !== 200) {
        return jsonResponse(options.sourceStatus, { error: { code: 'resource_not_found' } });
      }
      const source = sourceAt();
      const etag = sourceCalls > 1 && options.refreshedSource !== undefined ? SOURCE_ETAG_V2 : SOURCE_ETAG_V1;
      return jsonResponse(200, source, { etag });
    }
    if (href.endsWith('/favicon')) {
      postCalls += 1;
      posts.push({ url: href, headers: new Headers(init?.headers), body: bytesOf(init?.body),
        token: authorizationOf(init?.headers) });
      const status = postStatusAt(postCalls - 1, options.postStatuses ?? []);
      if (status >= 200 && status < 300) return jsonResponse(status, { id: NODE, kind: 'bookmark' });
      return jsonResponse(status, { error: { code: errorCodeFor(status) } });
    }
    throw new Error(`unexpected helper fetch ${href}`);
  };

  return {
    posts,
    get policyUrls() { return policyUrls; },
    get sourceCalls() { return sourceCalls; },
    get postCalls() { return postCalls; },
    fetch: fetchImpl,
    async drain(sidecar: ReturnType<typeof createFaviconSidecarStore>, now: () => number, overrides: {
      accessToken?: string; randomUUID?: () => string; bookmarkUrl?: () => Promise<string | null>;
    } = {}) {
      const bookmarkUrl = overrides.bookmarkUrl ?? (async () => PAGE_URL);
      return drainFaviconSidecars({
        sidecar, lookupNodeId: async (nativeId) => (nativeId === NATIVE ? NODE : null),
        bookmarkUrl,
        accessToken: overrides.accessToken ?? TOKEN, origin: ORIGIN, serverOrigin: SERVER,
        collectionId: COLLECTION, fetch: fetchImpl, now,
        randomUUID: overrides.randomUUID,
      });
    },
  };
}

function authorizationOf(headers: HeadersInit | undefined): string | null {
  const value = new Headers(headers).get('authorization');
  return value === null ? null : value.replace(/^Bearer\s+/u, '');
}

function bytesOf(body: BodyInit | null | undefined): Uint8Array {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array();
}

/**
 * Seeds a row whose recorded page is `PAGE_URL` by default (the same URL the
 * harness drain resolves), so tests that post/defer exercise the policy/source
 * gates instead of the URL gate. Pass `pageUrl: null` for a pre-upgrade row
 * that carries NO recorded page.
 */
async function seedRow(
  sidecar: ReturnType<typeof createFaviconSidecarStore>,
  overrides: {
    nativeId?: string; attempts?: number; notBefore?: number; createdAt?: number;
    pageUrl?: string | null; origin?: 'import' | 'capture';
  } = {},
): Promise<void> {
  await sidecar.put({
    nativeId: overrides.nativeId ?? NATIVE, contentType: 'image/png', bytes: PNG,
    commandId: COMMAND_A, collectionId: COLLECTION,
    createdAt: overrides.createdAt ?? 1_000, attempts: overrides.attempts ?? 0,
    notBefore: overrides.notBefore ?? 0,
    ...(overrides.pageUrl === null ? {} : { pageUrl: overrides.pageUrl ?? PAGE_URL }),
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('FO-04 policy-aware favicon sidecar drain', () => {
  test('capture-default policy + inherit source posts with If-Match and Known-Favicon-Policy-Revision', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper();
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 1, discarded: 0, deferred: 0 });
    assert.equal(helper.posts.length, 1);
    const post = helper.posts[0]!;
    assert.match(post.url, /\/colp\/v0\.1\/sync\/collections\/collection-1\/nodes\/node-colp-1\/favicon$/);
    assert.equal(post.headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(post.headers.get('origin'), ORIGIN);
    assert.equal(post.headers.get('known-command-id'), COMMAND_A);
    assert.equal(post.headers.get('if-match'), SOURCE_ETAG_V1);
    assert.equal(post.headers.get('known-favicon-policy-revision'), '1');
    assert.equal(post.headers.get('content-type'), 'image/png');
    assert.deepEqual(post.body, PNG);
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('policy newDefault none and force-online discard queued bytes without a POST', async () => {
    for (const policy of [accountPolicy({ newDefault: 'none' }), accountPolicy({ forceAllOnline: true })]) {
      const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
      await seedRow(sidecar);
      const helper = createHelper({ policy });
      const result = await helper.drain(sidecar, () => 2_000);
      assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
      assert.equal(helper.posts.length, 0);
      assert.equal(await sidecar.get(NATIVE), null);
    }
  });

  test('uploaded and none source states discard old bytes (never displace user intent)', async () => {
    for (const source of [
      capturableSource({ sourceMode: 'uploaded', effectiveMode: 'uploaded', iconVersion: 'obj-1' }),
      capturableSource({ sourceMode: 'none', effectiveMode: 'none' }),
    ]) {
      const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
      await seedRow(sidecar);
      const helper = createHelper({ source });
      const result = await helper.drain(sidecar, () => 2_000);
      assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
      assert.equal(helper.posts.length, 0);
    }
  });

  test('a 404 favicon policy returns unsupported and does not post', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({ policyStatus: 404 });
    assert.equal(await helper.drain(sidecar, () => 2_000), 'unsupported');
    assert.equal(helper.posts.length, 0);
    assert.ok(await sidecar.get(NATIVE));
  });

  test('cloud off returns unsupported without reading the sidecar', async () => {
    const fetch = async () => { throw new Error('must not fetch'); };
    const sidecar = { list: async () => { throw new Error('must not list'); } } as unknown as ReturnType<typeof createFaviconSidecarStore>;
    assert.equal(await drainFaviconSidecars({
      sidecar, lookupNodeId: async () => null, bookmarkUrl: async () => null,
      accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER, collectionId: COLLECTION,
      fetch, cloudEnabled: false,
    }), 'unsupported');
  });

  test('offline policy defers conservatively, keeps the bytes, and posts after recovery', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({ policyStatus: 503 });
    const offline = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(offline, { posted: 0, discarded: 0, deferred: 1 });
    assert.equal(helper.posts.length, 0);
    const kept = await sidecar.get(NATIVE);
    assert.ok(kept, 'bytes must stay stashed while the policy is unreachable');
    assert.equal(kept!.attempts, 1);
    assert.ok(kept!.notBefore > 2_000);

    // Recovery: a healthy policy client now reads the policy and posts.
    const onlineHelper = createHelper();
    const recovered = await onlineHelper.drain(sidecar, () => 10_000);
    assert.deepEqual(recovered, { posted: 1, discarded: 0, deferred: 0 });
    assert.deepEqual(onlineHelper.posts[0]?.body, PNG);
  });

  test('stale If-Match rebuilds user intent with a fresh command id under the fresh source ETag', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({
      // The first POST is rejected 412 (the read source moved on the server).
      refreshedSource: capturableSource({ revision: '2' }),
      postStatuses: [412, 200],
    });
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 1, discarded: 0, deferred: 0 });
    assert.equal(helper.posts.length, 2);
    const first = helper.posts[0]!;
    const rebuilt = helper.posts[1]!;
    assert.equal(first.headers.get('if-match'), SOURCE_ETAG_V1);
    assert.equal(rebuilt.headers.get('if-match'), SOURCE_ETAG_V2);
    assert.notEqual(rebuilt.headers.get('known-command-id'), COMMAND_A);
    assert.match(rebuilt.headers.get('known-command-id') ?? '', UUID_RE);
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('412 caused by an advanced policy revision refreshes the policy and rebuilds, never discards', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({
      // The source row itself is unchanged (revision 1), but its recorded
      // policy revision advanced to 2: the server moved the account policy
      // mid-drain, so the first POST 412s on the policy, not on the source.
      refreshedSource: capturableSource({ revision: '1', policyRevision: '2' }),
      refreshedPolicy: accountPolicy({ revision: '2' }),
      postStatuses: [412, 200],
    });
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 1, discarded: 0, deferred: 0 });
    assert.equal(helper.posts.length, 2);
    const rebuilt = helper.posts[1]!;
    assert.equal(rebuilt.headers.get('known-favicon-policy-revision'), '2',
      'the rebuild must run under the FRESH policy revision');
    assert.equal(rebuilt.headers.get('if-match'), SOURCE_ETAG_V2);
    assert.notEqual(rebuilt.headers.get('known-command-id'), COMMAND_A);
    assert.match(rebuilt.headers.get('known-command-id') ?? '', UUID_RE);
    assert.equal(helper.policyUrls.length, 2, 'a policy-412 must re-fetch the account policy');
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('412 with a policy advanced to none defers the bytes instead of silently discarding them', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({
      // The server flipped the policy to newDefault none between the drain's
      // policy read and the first POST: the bytes must survive (never a
      // silent discard) so the next drain re-evaluates under the fresh policy.
      refreshedSource: capturableSource({ revision: '1', policyRevision: '2' }),
      refreshedPolicy: accountPolicy({ newDefault: 'none', revision: '2' }),
      postStatuses: [412],
    });
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 0, discarded: 0, deferred: 1 });
    assert.equal(helper.posts.length, 1);
    const kept = await sidecar.get(NATIVE);
    assert.ok(kept, 'the queued bytes must survive a mid-drain policy change');
    assert.equal(kept!.attempts, 1);
    assert.ok(kept!.notBefore > 2_000);
  });

  test('412 with a now-protected source drops the old bytes instead of blind-replaying them', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({
      // The node moved to a manual uploaded icon between read and write.
      refreshedSource: capturableSource({ sourceMode: 'uploaded', effectiveMode: 'uploaded', iconVersion: 'obj-9' }),
      postStatuses: [412],
    });
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 1);
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('capture records the page URL and still posts while the bookmark URL is unchanged', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar, { pageUrl: PAGE_URL });
    const stored = await sidecar.get(NATIVE);
    assert.equal(stored?.pageUrl, PAGE_URL);
    const helper = createHelper();
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 1, discarded: 0, deferred: 0 });
    assert.equal(helper.posts.length, 1);
  });

  test('a bookmark URL edit discards the old page capture instead of binding it to the new site', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar, { pageUrl: 'https://old-site.example/article' });
    const helper = createHelper();
    // The user edited the resource URL while the capture sat offline; the
    // source is still inherit/capture, so only the URL identity can tell.
    const result = await helper.drain(sidecar, () => 2_000, {
      bookmarkUrl: async () => 'https://new-site.example/other',
    });
    assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 0, 'the old site icon is never posted to the new URL');
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('a URL edit discards the capture even when the stale POST would have been accepted', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar, { pageUrl: 'https://old-site.example/a' });
    // The server would happily accept the bytes on the fresh source (the 412
    // replay path); the client must not ask.
    const helper = createHelper({ refreshedSource: capturableSource({ revision: '2' }), postStatuses: [412, 200] });
    const result = await helper.drain(sidecar, () => 2_000, {
      bookmarkUrl: async () => 'https://new-site.example/b',
    });
    assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 0);
  });

  test('a same-host URL edit (path change) also drops the capture', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar, { pageUrl: 'https://example.test/first' });
    const helper = createHelper();
    const result = await helper.drain(sidecar, () => 2_000, {
      bookmarkUrl: async () => 'https://example.test/second',
    });
    assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 0);
  });

  test('412 rebuild re-runs the pageUrl gate: a URL edit between read and rebuild never re-posts', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar, { pageUrl: PAGE_URL });
    // The first URL check passes; the user edits the URL while the 412
    // refresh is in flight. The server would accept the rebuilt bytes (the
    // mock answers 200), but the rebuild path must re-check identity first.
    let calls = 0;
    const helper = createHelper({
      refreshedSource: capturableSource({ revision: '2' }),
      postStatuses: [412, 200],
    });
    const result = await helper.drain(sidecar, () => 2_000, {
      bookmarkUrl: async () => {
        calls += 1;
        return calls === 1 ? PAGE_URL : 'https://example.test/edited';
      },
    });
    assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 1, 'the rebuilt bytes must never be posted to the edited URL');
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('import rows carry no captured page and keep the existing drain behavior', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar, { origin: 'import' });
    const helper = createHelper();
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 1, discarded: 0, deferred: 0 });
    assert.equal(helper.posts.length, 1);
  });

  test('429 and 5xx defer with backoff and reuse the same command id on retry', async () => {
    for (const postStatus of [429, 503]) {
      const sidecar = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
      await seedRow(sidecar);
      const helper = createHelper({ postStatuses: [postStatus] });
      const first = await helper.drain(sidecar, () => 2_000);
      assert.deepEqual(first, { posted: 0, discarded: 0, deferred: 1 });
      const kept = await sidecar.get(NATIVE);
      assert.equal(kept!.attempts, 1);
      const second = await helper.drain(sidecar, () => 30_000);
      if (second === 'unsupported') throw new Error('favicon drain unsupported');
      assert.equal(second.deferred, 1);
      assert.equal(helper.posts.length, 2);
      assert.equal(helper.posts[0]!.headers.get('known-command-id'), COMMAND_A);
      assert.equal(helper.posts[1]!.headers.get('known-command-id'), COMMAND_A);
    }
  });

  test('transient retries are bounded by the attempt cap, never infinite', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar, { createdAt: 1_000 });
    const helper = createHelper({ postStatuses: [503] });
    let t = 2_000;
    for (let round = 0; round < FAVICON_HELPER_MAX_ATTEMPTS + 1; round += 1) {
      await helper.drain(sidecar, () => t);
      t += 60_000;
    }
    assert.equal(helper.postCalls, FAVICON_HELPER_MAX_ATTEMPTS);
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('legacy queue migration: pre-upgrade rows without a recorded page URL are conservatively discarded', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    // A true pre-upgrade row: only the pre-FO-04 fields — no pageUrl (and not
    // an import). Its bytes can never be proven to match the current URL, so
    // posting them would risk binding the old site icon to a URL that may
    // have been edited; the drain drops them conservatively.
    await sidecar.put({
      nativeId: NATIVE, contentType: 'image/png', bytes: PNG, commandId: COMMAND_A,
      collectionId: COLLECTION, createdAt: 1_000, attempts: 0, notBefore: 0,
    });
    const helper = createHelper();
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 0, 'a pageUrl-less legacy row is never blind-posted');
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('helper URLs are exact contract paths, never a doubled leading slash', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper();
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 1, discarded: 0, deferred: 0 });
    const postUrl = helper.posts[0]!.url;
    assert.equal(new URL(postUrl).origin, SERVER);
    assert.match(postUrl, new RegExp(`^${SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/colp/v0\\.1/sync/collections/${COLLECTION}/nodes/${NODE}/favicon$`));
    assert.doesNotMatch(postUrl, /\/\/colp/u);
    assert.ok(helper.policyUrls.length >= 1);
    for (const policyUrl of helper.policyUrls) {
      assert.match(policyUrl, new RegExp(`^${SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/colp/v0\\.1/sync/favicon-policy$`));
      assert.doesNotMatch(policyUrl, /\/\/colp/u);
    }
  });

  test('428 (missing validators) refreshes policy and source and rebuilds with a fresh command id', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({ postStatuses: [428, 200] });
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 1, discarded: 0, deferred: 0 });
    assert.equal(helper.posts.length, 2);
    const rebuilt = helper.posts[1]!;
    assert.notEqual(rebuilt.headers.get('known-command-id'), COMMAND_A);
    assert.match(rebuilt.headers.get('known-command-id') ?? '', UUID_RE);
    assert.equal(rebuilt.headers.get('if-match'), SOURCE_ETAG_V1);
    assert.equal(rebuilt.headers.get('known-favicon-policy-revision'), '1');
    assert.equal(helper.policyUrls.length, 2, '428 always refreshes the account policy');
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('a second 428 after the refresh is permanent for the stale bytes', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    const helper = createHelper({ postStatuses: [428, 428] });
    const result = await helper.drain(sidecar, () => 2_000);
    assert.deepEqual(result, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(helper.posts.length, 2);
    assert.equal(await sidecar.get(NATIVE), null);
  });

  test('account switch: every drain re-reads the policy for the current credential', async () => {
    const sidecarA = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecarA);
    const helper = createHelper({
      policyByToken: {
        'account-a-token': accountPolicy({ newDefault: 'none' }),
        'account-b-token': accountPolicy(),
      },
    });
    // The old account has icons disabled by policy: discard.
    const forA = await helper.drain(sidecarA, () => 2_000, { accessToken: 'account-a-token' });
    assert.deepEqual(forA, { posted: 0, discarded: 1, deferred: 0 });
    assert.equal(await sidecarA.get(NATIVE), null);

    // The same bookmark captured under the switched account is capturable.
    const sidecarB = createFaviconSidecarStore({ indexedDB: new IDBFactory() });
    await seedRow(sidecarB);
    const forB = await helper.drain(sidecarB, () => 2_000, { accessToken: 'account-b-token' });
    assert.deepEqual(forB, { posted: 1, discarded: 0, deferred: 0 });
    assert.equal(helper.posts.length, 1);
    assert.equal(helper.posts[0]!.token, 'account-b-token');
  });
});

describe('FO-04 drain single-flight', () => {
  test('a second drain invocation never double-posts while one is in flight', async () => {
    const sidecar = createFaviconSidecarStore({ indexedDB });
    await seedRow(sidecar);
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    let postCalls = 0;
    const posts: CapturedPost[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const href = String(url);
      if (href.endsWith('/favicon-policy')) {
        return jsonResponse(200, accountPolicy(), { etag: POLICY_ETAG });
      }
      if (href.endsWith('/favicon-source')) {
        return jsonResponse(200, capturableSource(), { etag: SOURCE_ETAG_V1 });
      }
      if (href.endsWith('/favicon')) {
        postCalls += 1;
        posts.push({ url: href, headers: new Headers(init?.headers), body: bytesOf(init?.body),
          token: authorizationOf(init?.headers) });
        // The first drain hangs inside its POST; the second invocation must
        // not proceed while this gate is closed.
        if (postCalls === 1) await postGate;
        return jsonResponse(200, { id: NODE, kind: 'bookmark' });
      }
      throw new Error(`unexpected helper fetch ${href}`);
    };
    const input = (): Parameters<typeof drainFaviconSidecars>[0] => ({
      sidecar, lookupNodeId: async (nativeId) => (nativeId === NATIVE ? NODE : null),
      bookmarkUrl: async () => PAGE_URL,
      accessToken: TOKEN, origin: ORIGIN, serverOrigin: SERVER, collectionId: COLLECTION,
      fetch: fetchImpl, now: () => 2_000,
    });
    const first = drainFaviconSidecars(input());
    await waitUntil(() => postCalls === 1);
    const second = drainFaviconSidecars(input());
    // While the first drain still holds the row, the second invocation must
    // not mint its own command id / POST: exactly one POST total.
    assert.equal(postCalls, 1, 'the second invocation must not POST while the first drain is in flight');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(postCalls, 1);
    releasePost();
    const firstResult = await first;
    assert.deepEqual(firstResult, { posted: 1, discarded: 0, deferred: 0 });
    const trailing = await second;
    // The chained trailing re-run finds the row already posted by the first
    // drain, so it adds nothing.
    assert.deepEqual(trailing, { posted: 0, discarded: 0, deferred: 0 });
    assert.equal(postCalls, 1, 'two concurrent drains must never double-post the same row');
    assert.equal(await sidecar.get(NATIVE), null);
  });
});