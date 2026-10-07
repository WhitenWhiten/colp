/**
 * T07 unit tests (plan §6.4 T07 / §3.1 / §4.2 / §4.3): the anonymous-public
 * Directory first-page query cache decorator against a scripted CacheStore and
 * a counting read port.
 *
 * The tests import the production decorator, key builders, envelope codec and
 * read-through policy — no key/hash/TTL algorithm is copied into the test.
 * The fake CacheStore records every get/set/setIfAbsent/releaseIfOwner call
 * (with args) and the read port counts how many times PostgreSQL would have
 * been hit, so cache hit / bypass / epoch-rotation / heal evidence is asserted
 * by command and loader counts, never by value equality alone.
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
  getPublicationDirectoryPage,
  PUBLICATION_DIRECTORY_DEFAULT_LIMIT,
  PublicationDirectoryInvalidQueryError,
  type PublicationDirectoryPageResult,
  type PublicationDirectoryQueryInput,
  type PublicationDirectoryReadPort,
} from '../../../src/modules/publication/index.js';
import {
  ANONYMOUS,
  ENVIRONMENT,
  HARD_TTL_MS,
  KEY_PREFIX,
  MEMBER,
  ORIGIN,
  POLICY,
  ROWS,
  SOFT_TTL_MS,
  directoryDataKey,
  directoryDomain,
  encodeFresh,
  makeFixture,
  makePorts,
} from '../../support/publication-directory-cache-helpers.js';



describe('publication directory cache decorator', () => {
  test('the same default anonymous request is served on the second read without the read port', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const first = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(first.projection, 'public');
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 1, 'a miss must be written back');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'a miss refreshes under the distributed lock');

    const second = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(second.projection, 'public');
    assert.equal(handle.loadCount(), 1, 'a fresh hit must never call the read port');
    assert.equal(store.callsOf('set').length, 1, 'a hit must not write');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'a hit must not take the lock');
  });

  test('reads the global directory epoch key before the data key and embeds the epoch', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: directoryDomain() });
    store.data.set(epochKey, '3');

    await reader(handle.ports, { principal: ANONYMOUS });

    const gets = store.callsOf('get');
    assert.equal(gets.length, 2);
    assert.equal(gets[0].args[0], epochKey, 'the epoch key must be read first');
    assert.equal(gets[1].args[0], directoryDataKey(3, PUBLICATION_DIRECTORY_DEFAULT_LIMIT),
      'the data key must embed the epoch read from the epoch key');
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], directoryDataKey(3, PUBLICATION_DIRECTORY_DEFAULT_LIMIT));
  });

  test('a missing epoch key is treated as epoch 0', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, { principal: ANONYMOUS });
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT));
  });

  test('corrupt epoch never resurrects warm generation zero and preserves origin failure', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: directoryDomain() });
    await reader(handle.ports, { principal: ANONYMOUS });
    store.data.set(epochKey, '1');
    await reader(handle.ports, { principal: ANONYMOUS });
    handle.setFail(true);
    const commandsBefore = store.calls.length;
    store.data.set(epochKey, 'corrupt');
    await assert.rejects(reader(handle.ports, { principal: ANONYMOUS }), /postgres unavailable/);
    assert.equal(handle.loadCount(), 3);
    assert.deepEqual(store.calls.slice(commandsBefore).map(call => call.args[0]), [epochKey],
      'corruption reads no data key and writes no generation');
  });

  test('a malformed directory epoch bypasses data keys and counts corruption (FIX-L-024)', async () => {
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: directoryDomain() });
    const corruptionMetric = cacheEpochCorruptMetricName(POLICY.domain);
    const malformedValues = ['12abc', '12.5', '-1', '+1', ' 12', '12 ', '01', '1e3', '9007199254740992', ''];
    for (const malformed of malformedValues) {
      const { store, reader, metrics } = makeFixture();
      const handle = makePorts();
      store.data.set(epochKey, malformed);
      await reader(handle.ports, { principal: ANONYMOUS });
      const sets = store.callsOf('set');
      assert.equal(sets.length, 0);
      assert.equal(store.callsOf('get').length, 1, 'only the epoch key is read');
      assert.equal(handle.loadCount(), 1);
      assert.equal(metrics.get(corruptionMetric), 1,
        `${JSON.stringify(malformed)} must be recorded as epoch corruption`);
    }
  });

  test('a canonical directory epoch of 0 is accepted without corruption (FIX-L-024)', async () => {
    const { store, reader, metrics } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: directoryDomain() });
    store.data.set(epochKey, '0');
    await reader(handle.ports, { principal: ANONYMOUS });
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT));
    assert.equal(metrics.get(cacheEpochCorruptMetricName(POLICY.domain)), 0, 'canonical zero is not corruption');
  });

  test('a missing directory epoch key is the normal initial state, not corruption (FIX-L-024)', async () => {
    const { reader, metrics } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(metrics.get(cacheEpochCorruptMetricName(POLICY.domain)), 0);
  });

  test('any non-default single field bypasses the anonymous cache with zero cache commands', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const first = await getPublicationDirectoryPage(handle.ports, { principal: ANONYMOUS });
    assert.ok(first.nextCursor, 'the default first page must carry a continuation cursor for this fixture');

    const cases: { readonly label: string; readonly query: PublicationDirectoryQueryInput['query'] }[] = [
      { label: 'q', query: { q: 'book' } },
      { label: 'tag', query: { tag: 'tech' } },
      { label: 'creator', query: { creator: 'owner' } },
      { label: 'kind', query: { kind: 'bookmarks' } },
      { label: 'updatedSince', query: { updatedSince: '2026-07-01T00:00:00Z' } },
      { label: 'cursor', query: { cursor: first.nextCursor } },
      { label: 'limit', query: { limit: 10 } },
    ];
    for (const { label, query } of cases) {
      const commandsBefore = store.calls.length;
      const loadsBefore = handle.loadCount();
      const result = await reader(handle.ports, { principal: ANONYMOUS, query });
      assert.equal(result.projection, 'public');
      assert.equal(handle.loadCount(), loadsBefore + 1, `${label} must always load from origin`);
      assert.equal(store.calls.length, commandsBefore, `${label} must issue zero cache commands`);
    }
  });

  test('an explicit default limit and an absent query share the same cache entry', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);

    await reader(handle.ports, { principal: ANONYMOUS, query: { limit: PUBLICATION_DIRECTORY_DEFAULT_LIMIT } });
    assert.equal(handle.loadCount(), 1, 'an explicit default limit hits the same entry');
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1, 'no second entry is written for the explicit default limit');
  });

  test('authenticated/member reads bypass the anonymous cache with zero cache commands', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);
    const commandsBefore = store.calls.length;

    const member = await reader(handle.ports, { principal: MEMBER });
    assert.equal(member.projection, 'member');
    assert.ok(member.directory.collections.some((item) => item.id === 'protected-member'),
      'the member projection includes the authorized protected collection');
    assert.equal(handle.loadCount(), 2, 'authenticated reads must always hit the authoritative read port');
    assert.equal(store.calls.length, commandsBefore,
      'authenticated requests must not read or write any anonymous cache key');
  });

  test('a directory epoch rotation makes the old first page unreachable', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: directoryDomain() });

    await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);
    const oldDataKey = store.callsOf('set')[0].args[0] as string;
    assert.ok(oldDataKey.includes(':0:'), 'the first write used epoch 0');

    // T09 rotates the global Directory epoch when the public representation changes.
    store.data.set(epochKey, '1');
    const getsBefore = store.callsOf('get').length;
    const after = await reader(handle.ports, { principal: ANONYMOUS });
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

  test('a cache hit is equivalent to the uncached origin page (body, order, total, nextCursor)', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const reference = await getPublicationDirectoryPage(handle.ports, { principal: ANONYMOUS });
    assert.equal(reference.projection, 'public');
    assert.equal(reference.directory.collections.length, PUBLICATION_DIRECTORY_DEFAULT_LIMIT);
    assert.ok(reference.nextCursor, 'the fixture must have a nextCursor on the default first page');

    const first = await reader(handle.ports, { principal: ANONYMOUS });
    assert.deepEqual(first, reference, 'the first cached read must match the reference');
    const loadsAfterFirst = handle.loadCount();

    const second = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), loadsAfterFirst, 'the second read is served from cache');
    assert.deepEqual(second, reference, 'the cache-hit body/order/total/nextCursor must equal the reference');
    assert.deepEqual(
      second.directory.collections.map((item) => item.id),
      reference.directory.collections.map((item) => item.id),
      'collection order must be preserved exactly',
    );

    const decoded = decodeCacheEnvelope(store.callsOf('set')[0].args[1] as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const cached = decoded.envelope.value as PublicationDirectoryPageResult;
      assert.equal(cached.projection, 'public');
      assert.equal(cached.nextCursor, reference.nextCursor);
      assert.deepEqual(cached.directory, reference.directory, 'the stored value equals the reference public projection');
    }
  });

  test('the anonymous cached value only contains the public projection, never member/protected facts', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const first = await reader(handle.ports, { principal: ANONYMOUS });
    assert.ok(first.directory.collections.every((item) => item.visibility === 'public'));
    assert.ok(!first.directory.collections.some((item) => item.id === 'protected-member'));
    assert.ok(!first.directory.collections.some((item) => item.id === 'protected-not-member'));

    const decoded = decodeCacheEnvelope(store.callsOf('set')[0].args[1] as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const cached = decoded.envelope.value as { directory?: { collections?: readonly { id: string }[] } };
      assert.ok(cached.directory?.collections?.every((item) => item.id !== 'protected-member'));
      assert.ok(cached.directory?.collections?.every((item) => item.id !== 'protected-not-member'));
    }
  });

  test('a maxPageSize that shrinks the default limit keeps the smaller default page cacheable', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts({ maxPageSize: 20 });
    const first = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(first.directory.collections.length, 20, 'the origin default becomes 20');
    assert.equal(handle.loadCount(), 1);

    await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1, 'the smaller default page is cached');

    await reader(handle.ports, { principal: ANONYMOUS, query: { limit: 20 } });
    assert.equal(handle.loadCount(), 1, 'an explicit default-equal limit is still cached');

    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], directoryDataKey(0, 20), 'the query hash carries the normalized default limit');

    const commandsBefore = store.calls.length;
    await reader(handle.ports, { principal: ANONYMOUS, query: { limit: 19 } });
    assert.equal(handle.loadCount(), 2, 'a non-default limit bypasses');
    assert.equal(store.calls.length, commandsBefore, 'the non-default limit issues zero cache commands');
  });

  test('an invalid default-shape query is never cached and keeps the origin error', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const commandsBefore = store.calls.length;
    await assert.rejects(
      () => reader(handle.ports, { principal: ANONYMOUS, query: { limit: 1_000 } }),
      PublicationDirectoryInvalidQueryError,
    );
    assert.equal(store.calls.length, commandsBefore, 'an invalid query issues zero cache commands');
    assert.equal(handle.loadCount(), 0, 'normalization fails before the read port');
  });

  test('a soft-expired value is refreshed in the foreground with the new origin value', async () => {
    const { store, reader, setNow } = makeFixture();
    const handle = makePorts();
    setNow(0);
    await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);

    setNow(SOFT_TTL_MS + 1);
    const refreshed = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(refreshed.projection, 'public');
    assert.equal(handle.loadCount(), 2, 'soft-expired must refresh from origin (serveStale=false)');
    assert.equal(store.callsOf('set').length, 2, 'the refresh result is written back');
  });

  test('the domain cannot override serveStale: a stale value is never returned', async () => {
    const { store, reader, setNow } = makeFixture({ ...POLICY, serveStale: true });
    const handle = makePorts();
    setNow(0);
    await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);

    setNow(SOFT_TTL_MS + 1);
    handle.setFail(true);
    await assert.rejects(reader(handle.ports, { principal: ANONYMOUS }), /postgres unavailable/);
    assert.equal(handle.loadCount(), 2, 'the soft-expired value was refreshed instead of served stale');
  });

  test('a corrupt JSON envelope is treated as a miss and refreshed from origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    store.data.set(directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT), '{not-json');
    const result = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1, 'a corrupt value must fall back to origin');
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 1, 'the corrupt value is overwritten');
  });

  test('a forbidden-field envelope is treated as a miss and refreshed from origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const poisoned = JSON.stringify({
      schemaVersion: 1,
      writtenAtMs: 0,
      softExpiresAtMs: SOFT_TTL_MS,
      hardExpiresAtMs: HARD_TTL_MS,
      value: {
        projection: 'public',
        nextCursor: null,
        directory: { protocolVersion: '0.1', collections: [], nextCursor: null, policyRevision: 'secret' },
      },
    });
    store.data.set(directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT), poisoned);
    const result = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 1, 'the poisoned value is overwritten');
  });

  test('an invalid cached projection shape is never served and is healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const dataKey = directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT);
    store.data.set(dataKey, encodeFresh(
      { projection: 'member', directory: { protocolVersion: '0.1', collections: [], nextCursor: null }, nextCursor: null },
      0,
    ));

    const result = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1, 'an invalid cached projection must not be passed through');
    assert.equal(result.projection, 'public');

    assert.equal(store.callsOf('set').length, 1);
    assert.equal(store.callsOf('set')[0].args[0], dataKey);
    const healed = decodeCacheEnvelope(store.data.get(dataKey)!, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(healed.kind, 'ok');
    if (healed.kind === 'ok') {
      const value = healed.envelope.value as { projection?: string };
      assert.equal(value.projection, 'public', 'the healed entry holds the validated public projection');
    }
  });

  test('a cached value with a forged non-public collection is never served and is healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const dataKey = directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT);
    const forged = {
      projection: 'public',
      nextCursor: null,
      directory: {
        protocolVersion: '0.1',
        collections: [{
          id: 'protected-member',
          canonicalUrl: `${ORIGIN}/c/protected-member`,
          title: 'protected',
          kind: 'bookmarks',
          nodeCount: 2,
          updatedAt: '2026-07-24T01:00:00.000Z',
          visibility: 'protected',
          links: { self: `${ORIGIN}/colp/v0.1/collections/protected-member`, canonical: `${ORIGIN}/c/protected-member`, snapshot: `${ORIGIN}/colp/v0.1/collections/protected-member/snapshot` },
          extensions: {},
        }],
        nextCursor: null,
      },
    };
    store.data.set(dataKey, encodeFresh(forged, 0));

    const result = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1, 'a forged protected collection must never be served');
    assert.ok(!result.directory.collections.some((item) => item.id === 'protected-member'));
    assert.equal(store.callsOf('set').length, 1, 'the forged value is overwritten');
  });

  test('a schema-shaped directory value with an invalid timestamp is rejected and healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    await reader(handle.ports, { principal: ANONYMOUS });
    const dataKey = directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT);
    const decoded = decodeCacheEnvelope(store.data.get(dataKey)!, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const value = decoded.envelope.value as { directory: { collections: Array<{ updatedAt: string }> } };
      value.directory.collections[0]!.updatedAt = 'not-a-timestamp';
      store.data.set(dataKey, encodeFresh(value, 0));
    }

    const result = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 2, 'the COLP schema-invalid cache value must reload origin');
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 2, 'the invalid value is overwritten');
  });

  test('an unavailable epoch read fails open to origin without cache commands beyond the epoch read', async () => {
    const { store, reader } = makeFixture();
    store.failGet = true;
    const handle = makePorts();
    const result = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('get').length, 1, 'only the epoch read was attempted');
    assert.equal(store.callsOf('set').length, 0);
  });

  test('an oversized public directory page is served from origin and never written', async () => {
    const { store, reader } = makeFixture({ ...POLICY, maxEntryBytes: 64 });
    const handle = makePorts();
    const result = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);
    assert.equal(result.projection, 'public');
    assert.equal(store.callsOf('set').length, 0, 'an oversized envelope must never be written');
  });

  test('a schema/database failure is never written to the cache', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    handle.setFail(true);
    await assert.rejects(reader(handle.ports, { principal: ANONYMOUS }), /postgres unavailable/);
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 0, 'a failing origin must never write the cache');
  });
  test('a cached envelope whose cursor does not match the embedded directory cursor is never served and is healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts();
    const dataKey = directoryDataKey(0, PUBLICATION_DIRECTORY_DEFAULT_LIMIT);

    // Warm the cache with the origin value (miss + write).
    const reference = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 1);
    assert.ok(reference.nextCursor, 'the default first page must carry a continuation cursor for this fixture');

    // Tamper with the envelope-level cursor only, leaving directory.nextCursor intact.
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

    const second = await reader(handle.ports, { principal: ANONYMOUS });
    assert.equal(handle.loadCount(), 2, 'a mismatched cursor must not be served; the origin is reloaded');
    assert.equal(second.nextCursor, reference.nextCursor, 'the cursor is never regenerated or replaced');
    assert.equal(store.callsOf('set').length, 2, 'the tampered value is overwritten');
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
    const reads: PublicationDirectoryReadPort = {
      async loadPage(request) {
        observedSignal = request.signal;
        markEntered();
        await originGate;
        if (request.signal?.aborted) throw request.signal.reason;
        return ROWS;
      },
    };
    const ports = { ...handle.ports, reads };

    const pending = reader(ports, { principal: ANONYMOUS }, controller.signal);
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

