import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpClientLimitError,
  ColpProblemError,
  PublicationSnapshotReplacementError,
  PublicationSnapshotState,
  type SnapshotRetrievalLimits,
} from '../../src/client/index.js';
import type { Snapshot, SnapshotQuery } from '../../src/types/index.js';

const evidence = 'semantic.snapshot.assembly';
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture<Value>(name: string): Promise<Value> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as Value;
}

async function publication(label: string): Promise<Snapshot> {
  const snapshot = await fixture<Snapshot>('collection-snapshot.json');
  snapshot.snapshotId = `snapshot-${label}`;
  snapshot.collection.title = label;
  return snapshot;
}

function urlOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function protocolJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('etag')) headers.set('ETag', '"pub-0005"');
  return Response.json(value, { ...init, headers });
}

function splitPages(source: Snapshot): [Snapshot, Snapshot] {
  const first = structuredClone(source);
  const second = structuredClone(source);
  first.nodes = source.nodes.slice(0, 1);
  first.annotations = [];
  first.attachments = [];
  first.relations = [];
  first.tombstones = [];
  first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
  second.nodes = source.nodes.slice(1);
  second.page = { nextCursor: null, hasMore: false, sequence: 2 };
  return [first, second];
}

async function makeClient(
  serveSnapshot: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  snapshotLimits?: Partial<SnapshotRetrievalLimits>,
): Promise<ColpClient> {
  const manifest = await fixture<unknown>('public-manifest.json');
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    return url.href === manifestUrl ? protocolJson(manifest) : serveSnapshot(url, init);
  });
  return new ColpClient({
    manifestUrl,
    fetch: fetch as typeof globalThis.fetch,
    ...(snapshotLimits === undefined ? {} : { snapshotLimits }),
  });
}

function pageResponse(page: Snapshot, link?: string): Response {
  return protocolJson(page, link === undefined ? {} : { headers: { Link: link } });
}

function normalLink(cursor = 'page-2'): string {
  return `<https://pages.example/snapshot?pageCursor=${cursor}>; rel="next"`;
}

async function paginatedClient(
  first: Snapshot,
  second: Snapshot,
  firstLink = normalLink(),
  limits?: Partial<SnapshotRetrievalLimits>,
): Promise<ColpClient> {
  return makeClient(
    (url) => url.searchParams.has('pageCursor')
      ? pageResponse(second)
      : pageResponse(first, firstLink),
    limits,
  );
}

async function expectFailedRefreshPreserves(
  client: ColpClient,
  oldSnapshot: Snapshot,
  query: SnapshotQuery = {},
): Promise<unknown> {
  client.replaceSnapshot(oldSnapshot);
  let rejection: unknown;
  try {
    await client.refreshSnapshot(collectionId, query);
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeDefined();
  expect(client.currentSnapshot).toEqual(oldSnapshot);
  return rejection;
}

describe(`PUB-0005 atomic Publication Snapshot state [evidence:${evidence}]`, () => {
  it(`replaces old state exactly once after a one-page complete Snapshot [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old');
    const replacement = await publication('one-page');
    const state = new PublicationSnapshotState();
    state.replace(oldSnapshot);
    const replace = vi.spyOn(state, 'replace');

    const returned = await state.refresh(async () => replacement);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(returned).toEqual(replacement);
    expect(state.current).toEqual(replacement);
  });

  it(`commits a one-page complete Snapshot through ColpClient refreshSnapshot [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old');
    const replacement = await publication('one-page-client');
    const client = await makeClient(() => pageResponse(replacement));
    client.replaceSnapshot(oldSnapshot);

    await expect(client.refreshSnapshot(collectionId)).resolves.toEqual(replacement);
    expect(client.currentSnapshot).toEqual(replacement);
  });

  it(`keeps old state while page two is deferred, then commits once at the terminal page [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old');
    const replacement = await publication('two-page');
    replacement.annotations = [];
    const [first, second] = splitPages(replacement);
    let releaseSecond!: () => void;
    let markRequested!: () => void;
    const secondRequested = new Promise<void>((resolveRequested) => { markRequested = resolveRequested; });
    const secondGate = new Promise<void>((resolveSecond) => { releaseSecond = resolveSecond; });
    const client = await makeClient(async (url) => {
      if (!url.searchParams.has('pageCursor')) return pageResponse(first, normalLink());
      markRequested();
      await secondGate;
      return pageResponse(second);
    });
    client.replaceSnapshot(oldSnapshot);
    const replace = vi.spyOn(PublicationSnapshotState.prototype, 'replace');

    const refresh = client.refreshSnapshot(collectionId);
    try {
      await secondRequested;
      expect(replace).not.toHaveBeenCalled();
      expect(client.currentSnapshot).toEqual(oldSnapshot);
      expect(client.currentSnapshot?.annotations).toHaveLength(oldSnapshot.annotations.length);
    } finally {
      releaseSecond();
    }
    await expect(refresh).resolves.toEqual(expect.objectContaining({ snapshotId: replacement.snapshotId }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(client.currentSnapshot?.snapshotId).toBe(replacement.snapshotId);
    expect(client.currentSnapshot?.annotations).toEqual([]);
  });

  it(`removes objects absent from the new Snapshot only after successful complete replacement [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old-with-annotation');
    const replacement = await publication('new-without-annotation');
    replacement.annotations = [];
    const client = await makeClient(() => pageResponse(replacement));
    client.replaceSnapshot(oldSnapshot);

    expect(client.currentSnapshot?.annotations).toHaveLength(1);
    await client.refreshSnapshot(collectionId);
    expect(client.currentSnapshot?.annotations).toEqual([]);
  });

  it(`allows cropped getSnapshot output but rejects it as replacement state [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old');
    const cropped = await publication('cropped');
    cropped.complete = false;
    const client = await makeClient(() => pageResponse(cropped));
    client.replaceSnapshot(oldSnapshot);

    const received = await client.getSnapshot(collectionId, { depth: 1 });
    expect(received.complete).toBe(false);
    expect(() => client.replaceSnapshot(received)).toThrow(PublicationSnapshotReplacementError);
    expect(client.currentSnapshot).toEqual(oldSnapshot);
  });

  it.each([
    ['missing Link', undefined],
    ['duplicate Link', `${normalLink()}, ${normalLink()}`],
    ['mismatched Link cursor', normalLink('wrong-cursor')],
  ] as const)(
    `preserves old state when a non-final page has %s [evidence:${evidence}]`,
    async (_label, link) => {
      const oldSnapshot = await publication('old');
      const [first, second] = splitPages(await publication('bad-link'));
      const client = await makeClient((url) => url.searchParams.has('pageCursor')
        ? pageResponse(second)
        : pageResponse(first, link));
      await expectFailedRefreshPreserves(client, oldSnapshot);
    },
  );

  it.each([
    ['revision', 'changed-revision'],
    ['snapshotId', 'changed-snapshot'],
    ['mode', 'sync'],
    ['complete', false],
    ['sequence', 3],
  ] as const)(
    `preserves old state when page two changes %s [evidence:${evidence}]`,
    async (field, value) => {
      const oldSnapshot = await publication('old');
      const [first, second] = splitPages(await publication(`changed-${field}`));
      if (field === 'sequence') second.page.sequence = value;
      else (second as unknown as Record<string, unknown>)[field] = value;
      const client = await paginatedClient(first, second);
      await expectFailedRefreshPreserves(client, oldSnapshot);
    },
  );

  it.each([
    ['a cross-page duplicate live ID', (first: Snapshot, second: Snapshot) => {
      second.nodes.unshift(structuredClone(first.nodes[0]!));
    }],
    ['an invalid assembled Parent graph', (_first: Snapshot, second: Snapshot) => {
      const child = second.nodes[0] as unknown as { parentId: string };
      child.parentId = 'missing-parent';
    }],
  ] as const)(
    `preserves old state when complete assembly contains %s [evidence:${evidence}]`,
    async (_label, mutate) => {
      const oldSnapshot = await publication('old');
      const [first, second] = splitPages(await publication('invalid-assembly'));
      mutate(first, second);
      const client = await paginatedClient(first, second);
      await expectFailedRefreshPreserves(client, oldSnapshot);
    },
  );

  it(`preserves old state when page two returns snapshot_expired 409 [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old');
    const [first] = splitPages(await publication('expired'));
    const problem = {
      type: 'https://collectionprotocol.org/problems/snapshot-expired',
      title: 'Snapshot revision expired',
      status: 409,
      code: 'snapshot_expired',
      retryable: true,
    };
    const client = await makeClient((url) => url.searchParams.has('pageCursor')
      ? new Response(JSON.stringify(problem), {
          status: 409,
          headers: { 'Content-Type': 'application/problem+json' },
        })
      : pageResponse(first, normalLink()));

    const rejection = await expectFailedRefreshPreserves(client, oldSnapshot);
    expect(rejection).toBeInstanceOf(ColpProblemError);
    expect(rejection).toMatchObject({ problem: { code: 'snapshot_expired', status: 409 } });
  });

  it.each([
    ['maxPages', { maxPages: 1 }],
    ['maxBytes', { maxBytes: 128 }],
    ['maxObjects', { maxObjects: 1 }],
  ] as const)(
    `preserves old state when retrieval exceeds %s [evidence:${evidence}]`,
    async (_label, limits) => {
      const oldSnapshot = await publication('old');
      const [first, second] = splitPages(await publication(`limit-${_label}`));
      const client = await paginatedClient(first, second, normalLink(), limits);
      const rejection = await expectFailedRefreshPreserves(client, oldSnapshot);
      expect(rejection).toBeInstanceOf(ColpClientLimitError);
    },
  );

  it(`preserves old state when Snapshot retrieval times out [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old');
    const client = await makeClient(
      (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
      { timeoutMs: 5 },
    );
    const rejection = await expectFailedRefreshPreserves(client, oldSnapshot);
    expect(rejection).toBeInstanceOf(ColpClientLimitError);
  });

  it.each(['replace return', 'current getter'] as const)(
    `does not expose internal state through a mutable %s clone [evidence:${evidence}]`,
    async (surface) => {
      const snapshot = await publication(`clone-${surface}`);
      const client = await makeClient(() => pageResponse(snapshot));
      const value = surface === 'replace return'
        ? client.replaceSnapshot(snapshot)
        : (client.replaceSnapshot(snapshot), client.currentSnapshot!);
      value.collection.title = 'mutated outside';
      value.nodes.splice(0);

      expect(client.currentSnapshot?.collection.title).toBe(snapshot.collection.title);
      expect(client.currentSnapshot?.nodes).toHaveLength(snapshot.nodes.length);
    },
  );

  it(`does not commit when preparing the detached return value fails [evidence:${evidence}]`, async () => {
    const oldSnapshot = await publication('old');
    const replacement = await publication('clone-failure');
    const state = new PublicationSnapshotState();
    state.replace(oldSnapshot);
    const originalStructuredClone = globalThis.structuredClone;
    let cloneCalls = 0;
    const cloneFailure = new DOMException('synthetic clone failure', 'DataCloneError');
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(function cloneValue<Value>(
      value: Value,
    ): Value {
      cloneCalls += 1;
      if (cloneCalls === 2) throw cloneFailure;
      return originalStructuredClone(value);
    });

    expect(() => state.replace(replacement)).toThrow(cloneFailure);
    expect(cloneCalls).toBe(2);
    clone.mockRestore();
    expect(state.current).toEqual(oldSnapshot);
  });
});
