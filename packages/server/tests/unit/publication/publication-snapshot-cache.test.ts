/**
 * T08 unit tests (plan §6.4 T08 / §3.1 / §4.2 / §4.3): the anonymous-public
 * Snapshot default-first-page query cache decorator against a scripted
 * CacheStore and a counting read port.
 *
 * The tests import the production decorator, key builders, envelope codec and
 * read-through policy — no key/hash/TTL algorithm is copied into the test.
 * The fake CacheStore records every get/set/setIfAbsent/releaseIfOwner call
 * (with args) and the read port counts how many times PostgreSQL would have
 * been hit, so cache hit / bypass / epoch-rotation / heal / error evidence is
 * asserted by command and loader counts, never by value equality alone.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CacheAbortError,
  buildCacheEpochKey,
  cacheEpochCorruptMetricName,
  decodeCacheEnvelope,
  encodeCacheEnvelope,
} from '../../../src/infrastructure/cache/index.js';
import {
  getPublicationSnapshotPage,
  PublicationNotFoundError,
  PublicationSnapshotExpiredError,
  PUBLICATION_SNAPSHOT_CURSOR_TTL_MS,
  PUBLICATION_SNAPSHOT_DEFAULT_LIMIT,
  type PublicationSnapshotQueryInput,
  type PublicationSnapshotReadPort,
} from '../../../src/modules/publication/index.js';
import {
  ANONYMOUS,
  DEFAULT_QUERY,
  ENVIRONMENT,
  HARD_TTL_MS,
  KEY_PREFIX,
  MEMBER,
  POLICY,
  SOFT_TTL_MS,
  collection,
  encodeFresh,
  makeFixture,
  makePorts,
  minimalSnapshot,
  snapshotDataKey,
  snapshotDomain,
} from '../../support/publication-snapshot-cache-helpers.js';


describe('publication snapshot cache decorator', () => {
  test('first anonymous request loads from origin and the second is served without the read port', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const first = await reader(handle.ports, ANONYMOUS);
    assert.equal(first.projection, 'public');
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 1, 'a miss must be written back');
    assert.equal(store.callsOf('set')[0].args[2], HARD_TTL_MS,
      'the envelope hard TTL must equal the 30s page-cursor cap (never extended upward)');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'a miss refreshes under the distributed lock');

    const second = await reader(handle.ports, ANONYMOUS);
    assert.equal(second.projection, 'public');
    assert.equal(handle.loadCount(), 1, 'a fresh hit must never call the read port');
    assert.deepEqual(second.snapshot, first.snapshot, 'body bytes must equal the reference snapshot');
    assert.equal(second.nextCursor, first.nextCursor, 'the cursor must be byte-identical to the reference');
    assert.equal(second.byteLength, first.byteLength, 'byteLength must equal the reference');
    assert.equal(store.callsOf('set').length, 1, 'a hit must not write');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'a hit must not take the lock');
  });

  test('reads the epoch key before the data key and embeds the epoch in the data key', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: snapshotDomain() });
    store.data.set(epochKey, '3');

    await reader(handle.ports, ANONYMOUS);

    const gets = store.callsOf('get');
    assert.equal(gets.length, 2);
    assert.equal(gets[0].args[0], epochKey, 'the epoch key must be read first');
    assert.equal(gets[1].args[0], snapshotDataKey(3), 'the data key must embed the epoch read from the epoch key');
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], snapshotDataKey(3));
  });

  test('a missing epoch key is treated as epoch 0', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, ANONYMOUS);
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], snapshotDataKey(0));
  });

  test('corrupt epoch never resurrects warm generation zero and preserves origin failure', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: snapshotDomain() });
    await reader(handle.ports, ANONYMOUS);
    store.data.set(epochKey, '1');
    await reader(handle.ports, ANONYMOUS);
    handle.setFail(true);
    const commandsBefore = store.calls.length;
    store.data.set(epochKey, 'corrupt');
    await assert.rejects(reader(handle.ports, ANONYMOUS), /postgres unavailable/);
    assert.equal(handle.loadCount(), 3);
    assert.deepEqual(store.calls.slice(commandsBefore).map(call => call.args[0]), [epochKey],
      'corruption reads no data key and writes no generation');
  });

  test('a malformed snapshot epoch bypasses data keys and counts corruption (FIX-L-024)', async () => {
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: snapshotDomain() });
    const corruptionMetric = cacheEpochCorruptMetricName(POLICY.domain);
    const malformedValues = ['12abc', '12.5', '-1', '+1', ' 12', '12 ', '01', '1e3', '9007199254740992', ''];
    for (const malformed of malformedValues) {
      const { store, reader, metrics } = makeFixture();
      const handle = makePorts();
      store.data.set(epochKey, malformed);
      await reader(handle.ports, ANONYMOUS);
      const sets = store.callsOf('set');
      assert.equal(sets.length, 0);
      assert.equal(store.callsOf('get').length, 1, 'only the epoch key is read');
      assert.equal(handle.loadCount(), 1);
      assert.equal(metrics.get(corruptionMetric), 1,
        `${JSON.stringify(malformed)} must be recorded as epoch corruption`);
    }
  });

  test('a canonical snapshot epoch of 0 is accepted without corruption (FIX-L-024)', async () => {
    const { store, reader, metrics } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: snapshotDomain() });
    store.data.set(epochKey, '0');
    await reader(handle.ports, ANONYMOUS);
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], snapshotDataKey(0));
    assert.equal(metrics.get(cacheEpochCorruptMetricName(POLICY.domain)), 0, 'canonical zero is not corruption');
  });

  test('a missing snapshot epoch key is the normal initial state, not corruption (FIX-L-024)', async () => {
    const { reader, metrics } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, ANONYMOUS);
    assert.equal(metrics.get(cacheEpochCorruptMetricName(POLICY.domain)), 0);
  });

  test('the query hash carries root/depth/include/limit/pageCursor and the collection domain', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, ANONYMOUS);
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], snapshotDataKey(0, DEFAULT_QUERY));
    assert.ok((sets[0].args[0] as string).includes('{pub:collection-1}'), 'the domain hash tag carries the collection');
  });

  test('an explicit default limit shares the same cache entry as an absent query', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);

    await reader(handle.ports, { ...ANONYMOUS, query: { limit: PUBLICATION_SNAPSHOT_DEFAULT_LIMIT } });
    assert.equal(handle.loadCount(), 1, 'an explicit default limit hits the same entry');
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1, 'no second entry is written for the explicit default limit');
  });

  test('changing pageCursor/include/root/depth/limit never crosses cache entries and bypasses with zero cache commands', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const first = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    assert.ok(first.nextCursor, 'the default first page fixture must carry a continuation cursor');

    const cases: readonly { readonly label: string; readonly query: PublicationSnapshotQueryInput['query'] }[] = [
      { label: 'pageCursor', query: { pageCursor: first.nextCursor! } },
      { label: 'include', query: { include: ['annotations'] } },
      { label: 'root', query: { root: 'n-000' } },
      { label: 'depth', query: { depth: 1 } },
      { label: 'limit', query: { limit: 100 } },
    ];
    for (const { label, query } of cases) {
      const commandsBefore = store.calls.length;
      const loadsBefore = handle.loadCount();
      await reader(handle.ports, { ...ANONYMOUS, query });
      assert.ok(handle.loadCount() > loadsBefore, `${label} must always load from origin`);
      assert.equal(store.calls.length, commandsBefore, `${label} must issue zero cache commands`);
    }

    const loadsBefore = handle.loadCount();
    const after = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), loadsBefore, 'the default entry is untouched by the varied shapes');
    assert.deepEqual(after.snapshot, first.snapshot);
    assert.equal(store.callsOf('set').length, 1, 'no varied shape was ever written');
  });

  test('an invalid query bypasses with zero cache commands and keeps the origin error', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const commandsBefore = store.calls.length;
    await assert.rejects(
      () => reader(handle.ports, { ...ANONYMOUS, query: { limit: 1 } }),
      /Publication Snapshot limit must be between 2 and 500/,
    );
    assert.equal(store.calls.length, commandsBefore, 'an invalid query issues zero cache commands');
    assert.equal(handle.loadCount(), 0, 'normalization fails before the read port');
  });
  test('authenticated/member reads bypass the anonymous cache with zero cache commands', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts([], { member: true });
    await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    const commandsBefore = store.calls.length;

    const member = await reader(handle.ports, MEMBER);
    assert.equal(member.projection, 'member');
    assert.equal(handle.loadCount(), 3, 'one anonymous read plus member fence and candidate reads must hit the authoritative port');
    assert.equal(handle.loadRequests[1]?.metadataOnly, true);
    assert.equal(handle.loadRequests[2]?.metadataOnly, undefined);
    assert.equal(handle.loadRequests[2]?.projection, 'member');
    assert.equal(store.calls.length, commandsBefore,
      'authenticated requests must not read or write any anonymous cache key');
  });

  test('a snapshot epoch rotation makes the old first page unreachable', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: snapshotDomain() });

    await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    const oldDataKey = store.callsOf('set')[0].args[0] as string;
    assert.ok(oldDataKey.includes(':0:'), 'the first write used epoch 0');

    // T09 rotates the collection epoch when the public representation changes.
    store.data.set(epochKey, '1');
    const getsBefore = store.callsOf('get').length;
    const after = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 2, 'a new epoch must not hit the old data key');
    assert.equal(after.projection, 'public');

    const newGets = store.callsOf('get').slice(getsBefore);
    assert.equal(newGets.length, 2);
    assert.equal(newGets[0].args[0], epochKey);
    assert.notEqual(newGets[1].args[0], oldDataKey);
    assert.ok((newGets[1].args[0] as string).includes(':1:'), 'the new epoch is embedded in the new data key');
    assert.equal(store.callsOf('get').filter((call) => call.args[0] === oldDataKey).length, 1,
      'the old epoch data key is never read again');
  });

  test('a cache hit is equivalent to the uncached origin page (snapshot, nextCursor, byteLength)', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const reference = await getPublicationSnapshotPage(handle.ports, ANONYMOUS);
    assert.equal(reference.projection, 'public');
    assert.equal(reference.snapshot.nodes.length, PUBLICATION_SNAPSHOT_DEFAULT_LIMIT);
    assert.ok(reference.nextCursor, 'the fixture must have a nextCursor on the default first page');

    const first = await reader(handle.ports, ANONYMOUS);
    assert.deepEqual(first.snapshot, reference.snapshot, 'the first cached read must match the reference body');
    assert.equal(first.nextCursor, reference.nextCursor);
    assert.equal(first.byteLength, reference.byteLength);
    const loadsAfterFirst = handle.loadCount();

    const second = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), loadsAfterFirst, 'the second read is served from cache');
    assert.deepEqual(second.snapshot, reference.snapshot, 'the cache-hit body must equal the reference');
    assert.equal(second.nextCursor, reference.nextCursor, 'the cache-hit cursor must equal the reference');
    assert.equal(second.byteLength, reference.byteLength, 'the cache-hit byteLength must equal the reference');

    const decoded = decodeCacheEnvelope(store.callsOf('set')[0].args[1] as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const cached = decoded.envelope.value as Record<string, unknown>;
      assert.deepEqual(cached, {
        projection: 'public',
        snapshot: reference.snapshot,
        nextCursor: reference.nextCursor,
        byteLength: reference.byteLength,
      }, 'the stored value is exactly the validated public projection minus ownerSubjectId');
    }
  });

  test('the anonymous cached value never contains ownerSubjectId or other forbidden authority facts', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, ANONYMOUS);
    const decoded = decodeCacheEnvelope(store.callsOf('set')[0].args[1] as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const cached = decoded.envelope.value as Record<string, unknown>;
      assert.deepEqual(Object.keys(cached).sort(), ['byteLength', 'nextCursor', 'projection', 'snapshot']);
      assert.ok(!JSON.stringify(cached).includes('ownerSubjectId'), 'ownerSubjectId must never be written');
    }
  });

  test('an oversized public snapshot is served from origin and never written', async () => {
    const { store, reader } = makeFixture({ ...POLICY, maxEntryBytes: 256 });
    const handle = makePorts();
    const result = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    assert.equal(result.projection, 'public');
    assert.equal(result.snapshot.nodes.length, PUBLICATION_SNAPSHOT_DEFAULT_LIMIT);
    assert.equal(store.callsOf('set').length, 0, 'an oversized envelope must never be written');
  });

  test('a soft-expired value is refreshed in the foreground with the new origin value', async () => {
    const { store, reader, setNow } = makeFixture();
    const handle = makePorts();
    setNow(0);
    await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);

    setNow(SOFT_TTL_MS + 1);
    const refreshed = await reader(handle.ports, ANONYMOUS);
    assert.equal(refreshed.projection, 'public');
    assert.equal(handle.loadCount(), 2, 'soft-expired must refresh from origin (serveStale=false)');
    assert.equal(store.callsOf('set').length, 2, 'the refresh result is written back');
  });

  test('a hard-expired value is a miss and is reloaded from origin', async () => {
    const { store, reader, setNow } = makeFixture();
    const handle = makePorts();
    setNow(0);
    await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);

    setNow(HARD_TTL_MS + 1);
    const reloaded = await reader(handle.ports, ANONYMOUS);
    assert.equal(reloaded.projection, 'public');
    assert.equal(handle.loadCount(), 2, 'past the hard TTL the origin is consulted again');
    assert.equal(store.callsOf('set').length, 2);
  });

  test('the domain cannot override serveStale: a stale value is never returned', async () => {
    const { store, reader, setNow } = makeFixture({ ...POLICY, serveStale: true });
    const handle = makePorts();
    setNow(0);
    await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);

    setNow(SOFT_TTL_MS + 1);
    handle.setFail(true);
    await assert.rejects(reader(handle.ports, ANONYMOUS), /postgres unavailable/);
    assert.equal(handle.loadCount(), 2, 'the soft-expired value was refreshed instead of served stale');
  });
  test('a cache hit never resets or extends the embedded continuation cursor expiry', async () => {
    const { store, reader, setNow } = makeFixture();
    const handle = makePorts();
    setNow(0);
    const first = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    assert.ok(first.nextCursor, 'the fixture must have a cursor');

    // Still within the cache fresh window (just under the soft TTL): a hit must
    // return the byte-identical cursor (the origin-signed expiry stays untouched)
    // and must not rewrite, so the Redis envelope cannot extend any expiry either.
    // The snapshot generator clock is advanced past the cursor TTL, so a
    // regeneration from origin would sign a different cursor.
    setNow(SOFT_TTL_MS - 1);
    handle.ports.now = () => new Date(NOW_DATE.getTime() + PUBLICATION_SNAPSHOT_CURSOR_TTL_MS + 1);
    const second = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1, 'a fresh hit must not consult the origin');
    assert.equal(second.nextCursor, first.nextCursor, 'the cached cursor is never re-signed or regenerated');
    assert.equal(store.callsOf('set').length, 1, 'a hit must not rewrite the envelope');
  });

  test('a corrupt JSON envelope is treated as a miss and refreshed from origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    store.data.set(snapshotDataKey(0), '{not-json');
    const result = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1, 'a corrupt value must fall back to origin');
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 1, 'the corrupt value is overwritten');
  });

  test('a forbidden-field envelope (ownerSubjectId) is treated as a miss and refreshed from origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const poisoned = JSON.stringify({
      schemaVersion: 1,
      writtenAtMs: 0,
      softExpiresAtMs: SOFT_TTL_MS,
      hardExpiresAtMs: HARD_TTL_MS,
      value: {
        projection: 'public',
        snapshot: minimalSnapshot(),
        nextCursor: null,
        byteLength: 0,
        ownerSubjectId: 'owner',
      },
    });
    store.data.set(snapshotDataKey(0), poisoned);
    const result = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 1, 'the poisoned value is overwritten');
  });

  test('an invalid cached projection shape is never served and is healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    store.data.set(snapshotDataKey(0), encodeFresh({
      projection: 'member',
      snapshot: minimalSnapshot(),
      nextCursor: null,
      byteLength: 0,
    }, 0));

    const result = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1, 'an invalid cached projection must not be passed through');
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 1);
    assert.equal(store.callsOf('set')[0].args[0], snapshotDataKey(0));
    const healed = decodeCacheEnvelope(store.data.get(snapshotDataKey(0))!, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(healed.kind, 'ok');
    if (healed.kind === 'ok') {
      const value = healed.envelope.value as { projection?: string };
      assert.equal(value.projection, 'public', 'the healed entry holds the validated public projection');
    }
  });

  test('a cached snapshot for another collection is never served and is healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const forgedSnapshot = minimalSnapshot();
    (forgedSnapshot.collection as Record<string, unknown>).id = 'other-collection';
    store.data.set(snapshotDataKey(0), encodeFresh({
      projection: 'public',
      snapshot: forgedSnapshot,
      nextCursor: null,
      byteLength: 0,
    }, 0));

    const result = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1, 'a forged foreign collection must never be served');
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 1, 'the forged value is overwritten');
  });

  test('a schema-shaped snapshot with a non-HTTP bookmark URL is rejected and healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, ANONYMOUS);
    const dataKey = snapshotDataKey(0);
    const decoded = decodeCacheEnvelope(store.data.get(dataKey)!, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const value = decoded.envelope.value as { snapshot: { nodes: Array<{ kind: string; url?: string }> } };
      const bookmark = value.snapshot.nodes.find((item) => item.kind === 'bookmark');
      assert.ok(bookmark);
      bookmark.url = 'javascript:alert(1)';
      store.data.set(dataKey, encodeFresh(value, 0));
    }

    const result = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 2, 'the COLP semantic-invalid cache value must reload origin');
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 2, 'the invalid value is overwritten');
  });
  test('a cached envelope whose cursor does not match the snapshot page cursor is never served and is healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();

    const reference = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    assert.ok(reference.nextCursor, 'the default first page must carry a continuation cursor');

    const dataKey = snapshotDataKey(0);
    const stored = store.data.get(dataKey)!;
    const decoded = decodeCacheEnvelope(stored, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const times = {
        writtenAtMs: decoded.envelope.writtenAtMs,
        softExpiresAtMs: decoded.envelope.softExpiresAtMs,
        hardExpiresAtMs: decoded.envelope.hardExpiresAtMs,
      };
      const value = decoded.envelope.value as { nextCursor: string | null };
      const encoded = encodeCacheEnvelope(
        { ...value, nextCursor: 'forged-cursor' },
        times,
        { maxEntryBytes: POLICY.maxEntryBytes },
      );
      assert.equal(encoded.kind, 'ok');
      if (encoded.kind === 'ok') store.data.set(dataKey, encoded.encoded);
    }

    const second = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 2, 'a mismatched cursor must not be served; the origin is reloaded');
    assert.equal(second.nextCursor, reference.nextCursor, 'the cursor is never regenerated or replaced');
    assert.equal(store.callsOf('set').length, 2, 'the tampered value is overwritten');
  });

  test('an unavailable epoch read fails open to origin without cache commands beyond the epoch read', async () => {
    const { store, reader } = makeFixture();
    store.failGet = true;
    const handle = makePorts();
    const result = await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 1);
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('get').length, 1, 'only the epoch read was attempted');
    assert.equal(store.callsOf('set').length, 0);
  });

  test('a collection ID outside the cache key alphabet fails open to origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts([], { current: () => collection({ id: 'weird~id' }) });
    const result = await reader(handle.ports, { collectionId: 'weird~id', principal: { kind: 'anonymous' as const } });
    assert.equal(handle.loadCount(), 1);
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('get').length, 0, 'no cache key is touched when the domain is not key-addressable');
    assert.equal(store.callsOf('set').length, 0);
  });

  test('a schema/database failure is never written to the cache', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    handle.setFail(true);
    await assert.rejects(reader(handle.ports, ANONYMOUS), /postgres unavailable/);
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 0, 'a failing origin must never write the cache');
  });

  test('a concealed private collection (resource_not_found) is never cached', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts([], { current: () => collection({ visibility: 'private' }) });
    await assert.rejects(reader(handle.ports, ANONYMOUS), PublicationNotFoundError);
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 0, 'a not-found origin must never be written as a success envelope');
  });

  test('a snapshot_expired origin error is never cached and keeps its own error class', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts([], { fail: () => new PublicationSnapshotExpiredError() });
    await assert.rejects(reader(handle.ports, ANONYMOUS), PublicationSnapshotExpiredError);
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 0,
      'snapshot_expired must not be converted into not-found or serialized as a success envelope');
  });

  test('a failed owner lifecycle fence never serves a cached snapshot hit', async () => {
    const { reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, ANONYMOUS);
    handle.setFresh(false);
    await reader(handle.ports, ANONYMOUS);
    assert.equal(handle.loadCount(), 2);
  });

  test('a request abort reaches the origin read port, rejects with CacheAbortError and never writes', async () => {
    const { store, reader } = makeFixture();
    const controller = new AbortController();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseOrigin!: () => void;
    const originGate = new Promise<void>((resolve) => { releaseOrigin = resolve; });
    let observedSignal: AbortSignal | undefined;
    const handle = makePorts();
    const reads: PublicationSnapshotReadPort = {
      async loadPage(request) {
        observedSignal = request.signal;
        markEntered();
        await originGate;
        if (request.signal?.aborted) throw request.signal.reason;
        return handle.ports.reads.loadPage(request);
      },
    };
    const ports = { ...handle.ports, reads };

    const pending = reader(ports, ANONYMOUS, controller.signal);
    await entered;
    controller.abort();
    releaseOrigin();
    await assert.rejects(pending, CacheAbortError);
    assert.equal(observedSignal?.aborted, true, 'the origin read port must observe the request abort');
    assert.equal(store.callsOf('set').length, 0, 'a cancelled origin must never write the cache');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'the miss still used the refresh lock');
    assert.equal(store.callsOf('releaseIfOwner').length, 1, 'the acquired lock must still be released');
  });
});


