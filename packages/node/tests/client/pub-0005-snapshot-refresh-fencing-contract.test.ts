import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PublicationSnapshotReplacementError,
  PublicationSnapshotState,
} from '../../src/client/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = 'semantic.snapshot.assembly';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture<Value>(name: string): Promise<Value> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as Value;
}

/** Complete publication Snapshot with distinct authoritative identity fields. */
async function publication(label: string): Promise<Snapshot> {
  const snapshot = await fixture<Snapshot>('collection-snapshot.json');
  snapshot.snapshotId = `snapshot-${label}`;
  snapshot.revision = `revision-${label}`;
  snapshot.collection.title = label;
  return snapshot;
}

function identityOf(snapshot: Snapshot): { snapshotId: string; revision: string } {
  return { snapshotId: snapshot.snapshotId, revision: snapshot.revision };
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe(`PUB-0005 PublicationSnapshotState.refresh fencing [evidence:${evidence}]`, () => {
  it(`does not let a slow earlier loader overwrite a faster later refresh [evidence:${evidence}]`, async () => {
    const baseline = await publication('baseline');
    const earlierSnap = await publication('earlier-slow');
    const laterSnap = await publication('later-fast');
    const state = new PublicationSnapshotState();
    state.replace(baseline);

    const slowEarlier = deferred<Snapshot>();
    const replace = vi.spyOn(state, 'replace');

    const earlierRefresh = state.refresh(() => slowEarlier.promise);
    const laterRefresh = state.refresh(async () => laterSnap);

    await expect(laterRefresh).resolves.toEqual(
      expect.objectContaining(identityOf(laterSnap)),
    );
    expect(state.current).toEqual(expect.objectContaining(identityOf(laterSnap)));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]![0]).toEqual(expect.objectContaining(identityOf(laterSnap)));

    // Freshness inversion: older in-flight loader finishes after the newer commit.
    slowEarlier.resolve(earlierSnap);
    await expect(earlierRefresh).resolves.toEqual(
      expect.objectContaining(identityOf(laterSnap)),
    );

    expect(replace).toHaveBeenCalledTimes(1);
    expect(state.current).toEqual(expect.objectContaining(identityOf(laterSnap)));
    expect(state.current?.collection.title).toBe(laterSnap.collection.title);
    expect(state.current).not.toEqual(expect.objectContaining(identityOf(earlierSnap)));
  });

  it(`commits serial refreshes with updated snapshot id and revision [evidence:${evidence}]`, async () => {
    const first = await publication('serial-first');
    const second = await publication('serial-second');
    const state = new PublicationSnapshotState();
    const replace = vi.spyOn(state, 'replace');

    const returnedFirst = await state.refresh(async () => first);
    expect(returnedFirst).toEqual(expect.objectContaining(identityOf(first)));
    expect(state.current).toEqual(expect.objectContaining(identityOf(first)));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]![0]).toEqual(expect.objectContaining(identityOf(first)));

    const returnedSecond = await state.refresh(async () => second);
    expect(returnedSecond).toEqual(expect.objectContaining(identityOf(second)));
    expect(state.current).toEqual(expect.objectContaining(identityOf(second)));
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[1]![0]).toEqual(expect.objectContaining(identityOf(second)));
  });

  it(`preserves existing state when a loader rejects [evidence:${evidence}]`, async () => {
    const baseline = await publication('baseline-kept');
    const state = new PublicationSnapshotState();
    state.replace(baseline);
    const replace = vi.spyOn(state, 'replace');
    const failure = new Error('synthetic loader failure');

    await expect(state.refresh(async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(replace).not.toHaveBeenCalled();
    expect(state.current).toEqual(expect.objectContaining(identityOf(baseline)));
    expect(state.current?.collection.title).toBe(baseline.collection.title);
  });

  it(`preserves existing state when replacement validation rejects the loaded Snapshot [evidence:${evidence}]`, async () => {
    const baseline = await publication('baseline-validation');
    const incomplete = await publication('incomplete-rejected');
    incomplete.complete = false;
    const state = new PublicationSnapshotState();
    state.replace(baseline);

    await expect(state.refresh(async () => incomplete)).rejects.toBeInstanceOf(
      PublicationSnapshotReplacementError,
    );

    expect(state.current).toEqual(expect.objectContaining(identityOf(baseline)));
    expect(state.current).not.toEqual(expect.objectContaining(identityOf(incomplete)));
  });

  it(`keeps a newer committed refresh when an earlier loader rejects later [evidence:${evidence}]`, async () => {
    const baseline = await publication('baseline-concurrent-fail');
    const laterSnap = await publication('later-success');
    const state = new PublicationSnapshotState();
    state.replace(baseline);

    const slowEarlier = deferred<Snapshot>();
    const replace = vi.spyOn(state, 'replace');
    const earlierFailure = new Error('stale earlier loader failed');

    const earlierRefresh = state.refresh(() => slowEarlier.promise);
    const laterRefresh = state.refresh(async () => laterSnap);

    await expect(laterRefresh).resolves.toEqual(
      expect.objectContaining(identityOf(laterSnap)),
    );
    expect(state.current).toEqual(expect.objectContaining(identityOf(laterSnap)));
    expect(replace).toHaveBeenCalledTimes(1);

    slowEarlier.reject(earlierFailure);
    await expect(earlierRefresh).rejects.toBe(earlierFailure);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(state.current).toEqual(expect.objectContaining(identityOf(laterSnap)));
    expect(state.current?.revision).toBe(laterSnap.revision);
  });

  it(`commits an earlier refresh when the newer one fails without committing [evidence:${evidence}]`, async () => {
    const baseline = await publication('baseline-later-failed');
    const earlierSnap = await publication('earlier-still-commits');
    const state = new PublicationSnapshotState();
    state.replace(baseline);

    const slowEarlier = deferred<Snapshot>();
    const laterFailure = new Error('later loader failed without commit');

    const earlierRefresh = state.refresh(() => slowEarlier.promise);
    const laterRefresh = state.refresh(async () => {
      throw laterFailure;
    });

    await expect(laterRefresh).rejects.toBe(laterFailure);
    expect(state.current).toEqual(expect.objectContaining(identityOf(baseline)));

    // Nothing newer committed, so the earlier successful load is not discarded.
    slowEarlier.resolve(earlierSnap);
    await expect(earlierRefresh).resolves.toEqual(
      expect.objectContaining(identityOf(earlierSnap)),
    );
    expect(state.current).toEqual(expect.objectContaining(identityOf(earlierSnap)));
  });

  it(`commits overlapping refreshes in start order when the earlier one finishes first [evidence:${evidence}]`, async () => {
    const earlierSnap = await publication('earlier-finishes-first');
    const laterSnap = await publication('later-finishes-second');
    const state = new PublicationSnapshotState();

    const slowEarlier = deferred<Snapshot>();
    const slowLater = deferred<Snapshot>();

    const earlierRefresh = state.refresh(() => slowEarlier.promise);
    const laterRefresh = state.refresh(() => slowLater.promise);

    slowEarlier.resolve(earlierSnap);
    await expect(earlierRefresh).resolves.toEqual(
      expect.objectContaining(identityOf(earlierSnap)),
    );
    expect(state.current).toEqual(expect.objectContaining(identityOf(earlierSnap)));

    slowLater.resolve(laterSnap);
    await expect(laterRefresh).resolves.toEqual(
      expect.objectContaining(identityOf(laterSnap)),
    );
    expect(state.current).toEqual(expect.objectContaining(identityOf(laterSnap)));
    expect(state.current?.revision).toBe(laterSnap.revision);
  });

  it(`does not let an in-flight refresh overwrite a later explicit replace [evidence:${evidence}]`, async () => {
    const loaded = await publication('loaded-before-replace');
    const replaced = await publication('explicit-replace');
    const state = new PublicationSnapshotState();

    const slow = deferred<Snapshot>();
    const pending = state.refresh(() => slow.promise);
    state.replace(replaced);
    slow.resolve(loaded);

    await expect(pending).resolves.toEqual(expect.objectContaining(identityOf(replaced)));
    expect(state.current).toEqual(expect.objectContaining(identityOf(replaced)));
  });

  it('keeps a successful explicit replacement when an older refresh finishes', async () => {
    const state = new PublicationSnapshotState();
    const old = await publication('old-loading');
    const replacement = await publication('explicit-replacement');
    const pending = deferred<Snapshot>();
    const refresh = state.refresh(() => pending.promise);
    state.replace(replacement);
    pending.resolve(old);
    expect(await refresh).toMatchObject(identityOf(replacement));
    expect(state.current).toMatchObject(identityOf(replacement));
    const latest = await publication('subsequent-refresh');
    expect(await state.refresh(async () => latest)).toMatchObject(identityOf(latest));
  });

  it('does not invalidate a pending refresh when explicit replacement fails validation', async () => {
    const state = new PublicationSnapshotState();
    const loaded = await publication('pending-valid');
    const invalid = await publication('invalid-replacement');
    invalid.complete = false;
    const pending = deferred<Snapshot>();
    const refresh = state.refresh(() => pending.promise);
    expect(() => state.replace(invalid)).toThrow(PublicationSnapshotReplacementError);
    pending.resolve(loaded);
    expect(await refresh).toMatchObject(identityOf(loaded));
    expect(state.current).toMatchObject(identityOf(loaded));
  });
});
