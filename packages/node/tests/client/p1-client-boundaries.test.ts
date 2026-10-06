/** Cross-boundary regressions: request identity and response-link egress. No real network I/O. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ColpClient } from '../../src/client/index.js';
import type { Manifest, Snapshot } from '../../src/types/index.js';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../fixtures/protocol/examples/${name}.json`, import.meta.url), 'utf8')) as T;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const json = (body: unknown, extra: Record<string, string> = {}) => Response.json(body, {
  headers: { ETag: '"review-current"', 'Cache-Control': 'private, no-cache', ...extra },
});

async function concurrentSnapshots(method: 'refreshSnapshot' | 'getSnapshot', firstIdentity: string, laterIdentity: string, sharedPartition?: string) {
  const manifest = fixture<Manifest>('public-manifest');
  const base = fixture<Snapshot>('collection-snapshot');
  const firstAtSnapshot = deferred<void>();
  const releaseFirst = deferred<void>();
  let identity = firstIdentity;
  let identityCaptures = 0;
  const client = new ColpClient({
    manifestUrl,
    requestIdentityProvider: () => {
      identityCaptures += 1;
      const captured = identity;
      return { cachePartition: sharedPartition ?? captured, credentialProvider: () => ({ Authorization: captured }) };
    },
    fetch: async (url, init) => {
      const captured = new Headers(init?.headers).get('Authorization');
      if (String(url) === manifestUrl) return json(manifest);
      if (captured === firstIdentity) {
        firstAtSnapshot.resolve();
        await releaseFirst.promise;
      }
      const body = structuredClone(base);
      // Represents distinct, already-authorized projections of the SAME Collection.
      body.snapshotId = `snapshot-${captured}`;
      body.revision = `revision-${captured}`;
      body.collection.title = `${captured}-projection`;
      return json(body);
    },
  });
  // Capture rejection immediately to avoid unhandled promise rejection races.
  const first = client[method](base.collection.id).then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  );
  await firstAtSnapshot.promise;
  identity = laterIdentity;
  let later: Snapshot;
  try {
    later = await client[method](base.collection.id);
  } finally {
    releaseFirst.resolve();
  }
  return { first: await first, later: later!, client, identityCaptures };
}

describe('R2-01: concurrent Publication snapshots must preserve authorization partition', () => {
  it.each([
    ['alice', 'bob'],
    ['alice-limited-grant', 'alice-admin-grant'],
  ])('does not return the %s request a later %s projection', async (firstIdentity, laterIdentity) => {
    const result = await concurrentSnapshots('refreshSnapshot', firstIdentity, laterIdentity);
    expect(result.later.snapshotId).toBe(`snapshot-${laterIdentity}`);
    expect(result.identityCaptures).toBe(2);
    expect(result.first.ok).toBe(true);
    if (result.first.ok) {
      expect(result.first.value.snapshotId).toBe(`snapshot-${firstIdentity}`);
      expect(result.first.value.collection.title).toBe(`${firstIdentity}-projection`);
    }
    expect(result.client.currentSnapshot).toBeUndefined();
    expect(() => result.client.replaceSnapshot(result.later)).toThrow('Dynamic-context');
  });

  it('control: getSnapshot alone keeps concurrent captured identities separate', async () => {
    const result = await concurrentSnapshots('getSnapshot', 'alice', 'bob');
    expect(result.later.snapshotId).toBe('snapshot-bob');
    expect(result.identityCaptures).toBe(2);
    expect(result.first.ok).toBe(true);
    if (result.first.ok) expect(result.first.value.snapshotId).toBe('snapshot-alice');
  });
});

function paginatedHarness(nextUrl: string, mode: 'default' | 'restrictive' | 'allow' = 'default') {
  const manifest = fixture<Manifest>('public-manifest');
  const complete = fixture<Snapshot>('collection-snapshot');
  const first = structuredClone(complete);
  const second = structuredClone(complete);
  first.nodes = complete.nodes.slice(0, 1);
  first.annotations = [];
  first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
  second.nodes = complete.nodes.slice(1);
  second.page = { nextCursor: null, hasMore: false, sequence: 2 };
  const fetchUrls: string[] = [];
  const credentialUrls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const href = input instanceof Request ? input.url : String(input);
    fetchUrls.push(new URL(href).href);
    if (href === manifestUrl) return json(manifest);
    if (new URL(href).searchParams.get('pageCursor') === 'page-2') return json(second);
    return json(first, { Link: `<${nextUrl}>; rel="next"` });
  });
  const client = new ColpClient({
    manifestUrl, fetch: fetch as typeof globalThis.fetch,
    credentialProvider(url) { credentialUrls.push(url.href); return undefined; },
    ...(mode === 'restrictive' ? { egressPolicy: (url: URL) => url.origin === 'https://alice.example' }
      : mode === 'allow' ? { egressPolicy: () => true } : {}),
  });
  return { client, collectionId: complete.collection.id, fetchUrls, credentialUrls };
}

describe('R2-02: response-provided continuation is not a trusted initial URL', () => {
  it.each([
    'https://127.0.0.1/private?pageCursor=page-2',
    'https://10.0.0.1/private?pageCursor=page-2',
    'https://169.254.169.254/private?pageCursor=page-2',
    'https://[::1]/private?pageCursor=page-2',
  ])('default policy refuses private rel=next BEFORE credentials/fetch: %s', async next => {
    const h = paginatedHarness(next);
    await expect(h.client.getSnapshot(h.collectionId)).rejects.toThrow('Egress policy denied');
    expect(h.fetchUrls).not.toContain(next);
    expect(h.credentialUrls).not.toContain(next);
  });

  it('control: an explicit restrictive policy already blocks a private continuation', async () => {
    const next = 'https://127.0.0.1/private?pageCursor=page-2';
    const h = paginatedHarness(next, 'restrictive');
    await expect(h.client.getSnapshot(h.collectionId)).rejects.toThrow('Egress policy denied');
    expect(h.fetchUrls).not.toContain(next);
    expect(h.credentialUrls).not.toContain(next);
  });

  it('control: public cross-origin continuation remains usable without a same-origin-only restriction', async () => {
    const next = 'https://cdn.example/page?pageCursor=page-2';
    const h = paginatedHarness(next);
    await expect(h.client.getSnapshot(h.collectionId)).resolves.toMatchObject({ complete: true });
    expect(h.fetchUrls).toContain(next);
  });
});


describe('P1 client compatibility controls', () => {
  it('retains explicit local endpoint opt-in for an audited custom egress policy', async () => {
    const next = 'https://127.0.0.1/private?pageCursor=page-2';
    const h = paginatedHarness(next, 'allow');
    await expect(h.client.getSnapshot(h.collectionId)).resolves.toMatchObject({ complete: true });
    expect(h.fetchUrls).toContain(next);
  });

  it('fixed-context clients still support detached explicit Snapshot replacement', () => {
    const client = new ColpClient({ manifestUrl, fetch: vi.fn() });
    const snapshot = fixture<Snapshot>('collection-snapshot');
    client.replaceSnapshot(snapshot);
    expect(client.currentSnapshot).toEqual(snapshot);
    const detached = client.currentSnapshot!;
    detached.collection.title = 'mutated by caller';
    expect(client.currentSnapshot?.collection.title).toBe(snapshot.collection.title);
  });

  it('legacy dynamic credential providers cannot expose shared synchronous Snapshot state', () => {
    const client = new ColpClient({ manifestUrl, credentialProvider: () => undefined, fetch: vi.fn() });
    expect(client.currentSnapshot).toBeUndefined();
    expect(() => client.replaceSnapshot(fixture<Snapshot>('collection-snapshot'))).toThrow('Dynamic-context');
  });
});


it('does not use an accidentally shared cachePartition string as authority to share Snapshot state', async () => {
  const result = await concurrentSnapshots('refreshSnapshot', 'alice', 'bob', 'same-partition');
  expect(result.first.ok).toBe(true);
  if (result.first.ok) expect(result.first.value.snapshotId).toBe('snapshot-alice');
  expect(result.later.snapshotId).toBe('snapshot-bob');
  expect(result.client.currentSnapshot).toBeUndefined();
  expect(result.identityCaptures).toBe(2);
});
