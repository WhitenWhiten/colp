/**
 * T06 unit tests (plan §6.4 T06 / §7.1 / §7.2): the anonymous-public Metadata
 * query cache decorator against a scripted CacheStore and a counting read port.
 *
 * The tests import the production decorator, key builders, envelope codec and
 * read-through policy — no key/hash/TTL algorithm is copied into the test.
 * The fake CacheStore records every get/set/setIfAbsent/releaseIfOwner call
 * (with args) and the read port counts how many times PostgreSQL would have
 * been hit, so cache hit / bypass / negative-cache / epoch-rotation evidence is
 * asserted by command and loader counts, never by value equality alone.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CacheAbortError,
  CacheBulkhead,
  CacheCircuitBreaker,
  CacheSingleflight,
  buildCacheEpochKey,
  cacheEpochCorruptMetricName,
  decodeCacheEnvelope,
  createCacheFailurePolicy,
} from '../../../src/infrastructure/cache/index.js';
import {
  createPublicationMetadataCache,
} from '../../../src/infrastructure/publication/index.js';
import {
  PublicationMetadataNotFoundError,
  type PublicationMetadataQueryPorts,
  type PublicationMetadataReadPort,
  type PublicationMetadataRecord,
} from '../../../src/modules/publication/index.js';
import { FakeCacheStore } from '../../support/cache-test-fixtures.js';
import {
  COLLECTION_ID,
  ENVIRONMENT,
  HARD_TTL_MS,
  KEY_PREFIX,
  NEGATIVE_TTL_MS,
  NOW_DATE,
  ORIGIN,
  POLICY,
  SLUG,
  SOFT_TTL_MS,
  anonymousIdInput,
  anonymousSlugInput,
  collectionDomain,
  encodeFresh,
  makeFixture,
  makePorts,
  metadataDataKey,
  record,
} from '../../support/publication-metadata-cache-helpers.js';


describe('publication metadata cache decorator', () => {
  test('first anonymous request loads from origin and the second is served without the read port', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    const first = await reader(handle.ports, anonymousIdInput);
    assert.equal(first.kind, 'metadata');
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 1, 'a miss must be written back');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'a miss refreshes under the distributed lock');

    const second = await reader(handle.ports, anonymousIdInput);
    assert.equal(second.kind, 'metadata');
    assert.equal(handle.loadCount(), 1, 'a fresh hit must never call the read port');
    assert.equal(store.callsOf('set').length, 1, 'a hit must not write');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'a hit must not take the lock');
  });

  test('reads the epoch key before the data key and embeds the epoch in the data key', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    const epochKey = buildCacheEpochKey({
      environment: ENVIRONMENT,
      keyPrefix: KEY_PREFIX,
      domain: collectionDomain(COLLECTION_ID),
    });
    store.data.set(epochKey, '3');

    await reader(handle.ports, anonymousIdInput);

    const gets = store.callsOf('get');
    assert.equal(gets.length, 2);
    assert.equal(gets[0].args[0], epochKey, 'the epoch key must be read first');
    assert.equal(gets[1].args[0], metadataDataKey(COLLECTION_ID, 3, { collectionId: COLLECTION_ID }),
      'the data key must embed the epoch read from the epoch key');
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], metadataDataKey(COLLECTION_ID, 3, { collectionId: COLLECTION_ID }));
  });

  test('a missing epoch key is treated as epoch 0', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    await reader(handle.ports, anonymousIdInput);
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID }));
  });

  test('a malformed epoch value bypasses data keys and counts corruption (FIX-L-024)', async () => {
    const epochKey = buildCacheEpochKey({
      environment: ENVIRONMENT,
      keyPrefix: KEY_PREFIX,
      domain: collectionDomain(COLLECTION_ID),
    });
    const corruptionMetric = cacheEpochCorruptMetricName(POLICY.domain);
    const malformedValues = ['12abc', '12.5', '-1', '+1', ' 12', '12 ', '01', '1e3', '9007199254740992', ''];
    for (const malformed of malformedValues) {
      const { store, reader, metrics } = makeFixture();
      const handle = makePorts(() => record());
      store.data.set(epochKey, malformed);
      await reader(handle.ports, anonymousIdInput);
      const sets = store.callsOf('set');
      assert.equal(sets.length, 0);
      assert.equal(store.callsOf('get').length, 1, 'only the epoch key is read');
      assert.equal(handle.loadCount(), 1);
      assert.equal(metrics.get(corruptionMetric), 1,
        `${JSON.stringify(malformed)} must be recorded as epoch corruption`);
    }
  });

  test('a canonical epoch of 0 is accepted without corruption (FIX-L-024)', async () => {
    const { store, reader, metrics } = makeFixture();
    const handle = makePorts(() => record());
    const epochKey = buildCacheEpochKey({
      environment: ENVIRONMENT,
      keyPrefix: KEY_PREFIX,
      domain: collectionDomain(COLLECTION_ID),
    });
    store.data.set(epochKey, '0');
    await reader(handle.ports, anonymousIdInput);
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID }));
    assert.equal(metrics.get(cacheEpochCorruptMetricName(POLICY.domain)), 0, 'canonical zero is not corruption');
  });

  test('a missing epoch key is the normal initial state, not corruption (FIX-L-024)', async () => {
    const { reader, metrics } = makeFixture();
    const handle = makePorts(() => record());
    await reader(handle.ports, anonymousIdInput);
    assert.equal(metrics.get(cacheEpochCorruptMetricName(POLICY.domain)), 0);
  });

  test('authenticated owner/member always bypass the anonymous cache with zero cache commands', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);
    const commandsBefore = store.calls.length;

    const memberResult = await reader(handle.ports, {
      collectionId: COLLECTION_ID,
      principal: { kind: 'account', principalId: 'account-1', subjectId: 'owner' },
    });
    assert.equal(memberResult.kind, 'metadata');
    if (memberResult.kind === 'metadata') assert.equal(memberResult.projection, 'member');
    assert.equal(handle.loadCount(), 2, 'authenticated reads must always hit the authoritative read port');
    assert.equal(store.calls.length, commandsBefore,
      'authenticated requests must not read or write any anonymous cache key');
  });

  test('hidden private/protected results never enter the anonymous cache and are not negative-cached', async () => {
    for (const visibility of ['private', 'protected'] as const) {
      const { store, reader } = makeFixture();
      const handle = makePorts(() => record({ visibility }));
      await assert.rejects(reader(handle.ports, anonymousIdInput), PublicationMetadataNotFoundError);
      assert.equal(handle.loadCount(), 1);
      assert.equal(store.callsOf('set').length, 0,
        `a ${visibility} result is concealment, never a confirmed not-found, so nothing is written`);
      assert.equal(store.callsOf('setIfAbsent').length, 1, 'the miss still used the refresh lock');

      // advance well past any 5s negative-cache window: the origin must be consulted again
      const before = handle.loadCount();
      // no marker was written, so the next read is a plain miss -> origin -> concealed again
      await assert.rejects(reader(handle.ports, anonymousIdInput), PublicationMetadataNotFoundError);
      assert.equal(handle.loadCount(), before + 1, 'a concealed result must never be negative-cached');
      assert.equal(store.callsOf('set').length, 0);
    }
  });

  test('unlisted projections are public and cacheable for anonymous readers', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ visibility: 'unlisted' }));
    await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);
    await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1, 'unlisted must hit on the second anonymous read');
    assert.equal(store.callsOf('set').length, 1);
  });

  test('ID and slug lookups never share values and keep distinct keys', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);

    await reader(handle.ports, anonymousSlugInput);
    assert.equal(handle.loadCount(), 2, 'a slug lookup must not hit the ID-scoped entry');

    await reader(handle.ports, anonymousIdInput);
    await reader(handle.ports, anonymousSlugInput);
    assert.equal(handle.loadCount(), 2, 'both entries now hit independently');

    const sets = store.callsOf('set');
    assert.equal(sets.length, 2);
    const [idKey, slugKey] = sets.map((call) => call.args[0] as string);
    assert.notEqual(idKey, slugKey, 'ID and slug must produce different data keys');
    assert.equal(idKey, metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID }));
    assert.equal(slugKey, metadataDataKey(SLUG, 0, { publicationSlug: SLUG }, 'pubslug'));
  });

  test('an ID and an unrelated slug that share a string keep isolated epochs (A.id === B.slug)', async () => {
    // Collection A is addressed by its ID; an unrelated collection B has a slug
    // equal to A's ID. The locator kind must namespace the epoch keys so a
    // purge of B's slug never invalidates A's ID-scoped entry and vice versa.
    const shared = 'shared-identity';
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    const idEpochKey = buildCacheEpochKey({
      environment: ENVIRONMENT,
      keyPrefix: KEY_PREFIX,
      domain: collectionDomain(shared),
    });
    const slugEpochKey = buildCacheEpochKey({
      environment: ENVIRONMENT,
      keyPrefix: KEY_PREFIX,
      domain: collectionDomain(shared, 'pubslug'),
    });
    assert.notEqual(idEpochKey, slugEpochKey, 'the ID and slug epochs of the same string must be distinct keys');

    // A's ID-scoped entry is written under epoch 0.
    await reader(handle.ports, { collectionId: shared, principal: { kind: 'anonymous' as const } });
    assert.equal(handle.loadCount(), 1);

    // B's slug purge rotates only the slug-scoped epoch: A's ID-scoped entry
    // must survive (its own epoch is untouched).
    store.data.set(slugEpochKey, '1');
    await reader(handle.ports, { collectionId: shared, principal: { kind: 'anonymous' as const } });
    assert.equal(handle.loadCount(), 1, 'an ID-scoped entry must survive a slug-scoped rotation');

    // The same slug purge does invalidate slug-scoped lookups themselves: the
    // next slug lookup loads from origin again and writes under epoch 1.
    await reader(handle.ports, { publicationSlug: shared, principal: { kind: 'anonymous' as const } });
    assert.equal(handle.loadCount(), 2, 'a slug-scoped rotation must invalidate slug-scoped entries');

    // A's ID purge rotates only the ID-scoped epoch: B's slug-scoped entry
    // (written under slug epoch 1) must survive.
    store.data.set(idEpochKey, '1');
    await reader(handle.ports, { publicationSlug: shared, principal: { kind: 'anonymous' as const } });
    assert.equal(handle.loadCount(), 2, 'a slug-scoped entry must survive an ID-scoped rotation');

    // And the ID purge does invalidate ID-scoped lookups themselves.
    await reader(handle.ports, { collectionId: shared, principal: { kind: 'anonymous' as const } });
    assert.equal(handle.loadCount(), 3, 'an ID-scoped rotation must invalidate ID-scoped entries');
  });

  test('a soft-expired value is refreshed in the foreground with the new origin value', async () => {
    const { store, reader, setNow } = makeFixture();
    let current = record({ title: 'first', updatedAt: '2026-07-01T00:00:00.000Z' });
    const handle = makePorts(() => current);

    setNow(0);
    const first = await reader(handle.ports, anonymousIdInput);
    assert.equal(first.kind, 'metadata');
    assert.equal(handle.loadCount(), 1);

    current = record({ title: 'second', updatedAt: '2026-07-02T00:00:00.000Z' });
    setNow(SOFT_TTL_MS + 1);
    const refreshed = await reader(handle.ports, anonymousIdInput);
    assert.equal(refreshed.kind, 'metadata');
    if (refreshed.kind === 'metadata') assert.equal(refreshed.metadata.collection.title, 'second');
    assert.equal(handle.loadCount(), 2, 'soft-expired must refresh from origin (serveStale=false)');
    assert.equal(store.callsOf('set').length, 2, 'the refresh result is written back');
  });

  test('refresh failure at soft-expiry never returns the stale value', async () => {
    const { store, reader, setNow } = makeFixture();
    const handle = makePorts(() => record({ title: 'stale-title' }));
    setNow(0);
    await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);

    setNow(SOFT_TTL_MS + 1);
    handle.setFail(true);
    await assert.rejects(reader(handle.ports, anonymousIdInput), /postgres unavailable/);
    assert.equal(handle.loadCount(), 2, 'the refresh attempted an origin load');
    assert.equal(store.callsOf('set').length, 1, 'a failed refresh writes nothing');
  });

  test('a hard-expired value is treated as a miss and reloaded from origin', async () => {
    const { store, reader, setNow } = makeFixture();
    let current = record({ title: 'old' });
    const handle = makePorts(() => current);
    setNow(0);
    await reader(handle.ports, anonymousIdInput);
    current = record({ title: 'new' });
    setNow(HARD_TTL_MS + 1);
    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 2);
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'new');
    assert.equal(store.callsOf('set').length, 2);
  });

  test('epoch rotation makes the old data key unreachable and re-reads from origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ title: 'v1' }));
    const epochKey = buildCacheEpochKey({
      environment: ENVIRONMENT,
      keyPrefix: KEY_PREFIX,
      domain: collectionDomain(COLLECTION_ID),
    });

    await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);
    const oldDataKey = store.callsOf('set')[0].args[0] as string;
    assert.ok(oldDataKey.includes(':0:'), 'the first write used epoch 0');

    // T09 rotates the collection epoch; the new request must never touch the old data key.
    store.data.set(epochKey, '1');
    const getsBefore = store.callsOf('get').length;
    await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 2, 'a new epoch must not hit the old data key');
    const newGets = store.callsOf('get').slice(getsBefore);
    assert.equal(newGets.length, 2);
    assert.equal(newGets[0].args[0], epochKey);
    assert.notEqual(newGets[1].args[0], oldDataKey);
    assert.ok((newGets[1].args[0] as string).includes(':1:'), 'the new epoch is embedded in the new data key');
    assert.equal(store.callsOf('get').filter((call) => call.args[0] === oldDataKey).length, 1,
      'the old epoch data key is never read again');
  });

  test('after a slug change the old slug value is unreachable once its epoch rotates', async () => {
    const { store, reader } = makeFixture();
    const slugDomain = collectionDomain(SLUG, 'pubslug');
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: slugDomain });
    let current: PublicationMetadataRecord | null = record();
    const handle = makePorts(() => current);

    await reader(handle.ports, anonymousSlugInput);
    assert.equal(handle.loadCount(), 1);
    const oldDataKey = store.callsOf('set')[0].args[0] as string;

    // The collection's slug changed: the old slug no longer resolves and the
    // purge rotation advanced the slug-scoped epoch.
    current = null;
    store.data.set(epochKey, '1');
    await assert.rejects(reader(handle.ports, anonymousSlugInput), PublicationMetadataNotFoundError);
    assert.equal(handle.loadCount(), 2, 'the old slug must be re-resolved from origin after rotation');
    assert.equal(store.callsOf('get').filter((call) => call.args[0] === oldDataKey).length, 1,
      'the old epoch data key is never read again');
  });

  test('a corrupt JSON envelope is treated as a miss and refreshed from origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ title: 'fresh' }));
    store.data.set(metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID }), '{not-json');
    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1, 'a corrupt value must fall back to origin');
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'fresh');
    assert.equal(store.callsOf('set').length, 1, 'the corrupt value is overwritten');
  });

  test('a forbidden-field envelope is treated as a miss and refreshed from origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ title: 'clean' }));
    const poisoned = JSON.stringify({
      schemaVersion: 1,
      writtenAtMs: 0,
      softExpiresAtMs: SOFT_TTL_MS,
      hardExpiresAtMs: HARD_TTL_MS,
      value: { kind: 'metadata', policyRevision: 'secret', metadata: { collection: {}, links: {} } },
    });
    store.data.set(metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID }), poisoned);
    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'clean');
    assert.equal(store.callsOf('set').length, 1, 'the poisoned value is overwritten');
  });

  test('a versioned cache value with an invalid projection shape is never served and is healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ title: 'correct' }));
    const dataKey = metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID });
    store.data.set(dataKey, encodeFresh(
      { kind: 'metadata', metadata: { broken: true }, projection: 'public', revision: 'x', updatedAt: 'y' },
      0,
    ));

    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1, 'an invalid cached projection must not be passed through');
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'correct');

    assert.equal(store.callsOf('set').length, 1);
    assert.equal(store.callsOf('set')[0].args[0], dataKey);
    const healed = decodeCacheEnvelope(store.data.get(dataKey)!, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(healed.kind, 'ok');
    if (healed.kind === 'ok') {
      const value = healed.envelope.value as { kind?: string; metadata?: { collection?: { title?: string } } };
      assert.equal(value.kind, 'metadata');
      assert.equal(value.metadata?.collection?.title, 'correct', 'the healed entry holds the validated projection');
    }
  });

  test('a schema-shaped metadata value with an invalid canonical URL is rejected and healed', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ title: 'validated-origin' }));
    await reader(handle.ports, anonymousIdInput);
    const dataKey = metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID });
    const decoded = decodeCacheEnvelope(store.data.get(dataKey)!, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const value = decoded.envelope.value as { metadata: { collection: { canonicalUrl: string } } };
      value.metadata.collection.canonicalUrl = 'not-an-http-url';
      store.data.set(dataKey, encodeFresh(value, 0));
    }

    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 2, 'the COLP schema-invalid cache value must reload origin');
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'validated-origin');
    assert.equal(store.callsOf('set').length, 2, 'the invalid value is overwritten');
  });

  test('a confirmed anonymous not-found is negative-cached for 5s with a hard TTL', async () => {
    const { store, reader, setNow } = makeFixture();
    const handle = makePorts(() => null);
    const dataKey = metadataDataKey(COLLECTION_ID, 0, { collectionId: COLLECTION_ID });

    setNow(0);
    await assert.rejects(reader(handle.ports, anonymousIdInput), PublicationMetadataNotFoundError);
    assert.equal(handle.loadCount(), 1);
    const sets = store.callsOf('set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].args[0], dataKey);
    assert.equal(sets[0].args[2], NEGATIVE_TTL_MS, 'the negative entry uses the 5s hard TTL');
    const decoded = decodeCacheEnvelope(sets[0].args[1] as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      assert.deepEqual(decoded.envelope.value, { kind: 'not_found' });
      assert.equal(decoded.envelope.hardExpiresAtMs - decoded.envelope.writtenAtMs, NEGATIVE_TTL_MS);
    }

    setNow(4_999);
    await assert.rejects(reader(handle.ports, anonymousIdInput), PublicationMetadataNotFoundError);
    assert.equal(handle.loadCount(), 1, 'within the 5s window the read port is not called again');

    setNow(5_001);
    await assert.rejects(reader(handle.ports, anonymousIdInput), PublicationMetadataNotFoundError);
    assert.equal(handle.loadCount(), 2, 'after the 5s window the origin is re-checked and re-cached');
    assert.equal(store.callsOf('set').length, 2);
  });

  test('an expired tombstone (past retention) is a confirmed not-found and is negative-cached', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ deletedAt: '2026-06-24T00:00:00.000Z' }));
    await assert.rejects(reader(handle.ports, anonymousIdInput), PublicationMetadataNotFoundError);
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 1);
    const decoded = decodeCacheEnvelope(store.callsOf('set')[0].args[1] as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') assert.deepEqual(decoded.envelope.value, { kind: 'not_found' });
  });

  test('a public tombstone (gone) is returned but never written to the cache', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ deletedAt: '2026-07-01T00:00:01.000Z' }));
    const first = await reader(handle.ports, anonymousIdInput);
    assert.equal(first.kind, 'gone');
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 0, 'a tombstone locator is never cached');
    assert.equal(store.callsOf('setIfAbsent').length, 1, 'the miss still used the refresh lock');

    const second = await reader(handle.ports, anonymousIdInput);
    assert.equal(second.kind, 'gone');
    assert.equal(handle.loadCount(), 2, 'tombstones always re-resolve from origin');
    assert.equal(store.callsOf('set').length, 0);
  });

  test('an unavailable epoch read fails open to origin without cache commands beyond the epoch read', async () => {
    const { store, reader } = makeFixture();
    store.failGet = true;
    const handle = makePorts(() => record({ title: 'direct' }));
    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'direct');
    assert.equal(store.callsOf('get').length, 1, 'only the epoch read was attempted');
    assert.equal(store.callsOf('set').length, 0);
  });

  test('a collection ID outside the cache key alphabet fails open to origin', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record({ id: 'weird~id' }));
    const result = await reader(handle.ports, {
      collectionId: 'weird~id',
      principal: { kind: 'anonymous' as const },
    });
    assert.equal(handle.loadCount(), 1);
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.id, 'weird~id');
    assert.equal(store.callsOf('get').length, 0, 'no cache key is touched when the domain is not key-addressable');
    assert.equal(store.callsOf('set').length, 0);
  });

  test('the domain cannot override serveStale: a stale value is never returned', async () => {
    const store = new FakeCacheStore();
    const singleflight = new CacheSingleflight();
    const bulkhead = new CacheBulkhead(4);
    const failurePolicy = createCacheFailurePolicy(
      new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 }),
      bulkhead,
    );
    let nowMs = 0;
    const reader = createPublicationMetadataCache({
      policy: { ...POLICY, serveStale: true },
      deps: {
        store,
        singleflight,
        bulkhead,
        failurePolicy,
        clock: () => nowMs,
        random: () => 0,
        tokenFactory: () => 'token-1',
      },
      key: { environment: ENVIRONMENT, keyPrefix: KEY_PREFIX },
    });
    const handle = makePorts(() => record({ title: 'stale-title' }));
    await reader(handle.ports, anonymousIdInput);
    nowMs = SOFT_TTL_MS + 1;
    handle.setFail(true);
    await assert.rejects(reader(handle.ports, anonymousIdInput), /postgres unavailable/);
    assert.equal(handle.loadCount(), 2, 'the soft-expired value was refreshed instead of served stale');
  });

  test('an oversized public projection is served from origin and never written', async () => {
    const { store, reader } = makeFixture({ ...POLICY, maxEntryBytes: 64 });
    const handle = makePorts(() => record());
    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(handle.loadCount(), 1);
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'Collection');
    assert.equal(store.callsOf('set').length, 0, 'an oversized envelope must never be written');
  });

  test('a schema/database failure is never written to the cache', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    // Simulate a database failure on the first origin load.
    handle.setFail(true);
    await assert.rejects(reader(handle.ports, anonymousIdInput), /postgres unavailable/);
    assert.equal(handle.loadCount(), 1);
    assert.equal(store.callsOf('set').length, 0, 'a failing origin must never write the cache');
  });

  test('a failed owner lifecycle fence never serves a cached metadata hit', async () => {
    const { reader } = makeFixture();
    const handle = makePorts(() => record({ title: 'origin-after-delete' }));
    await reader(handle.ports, anonymousIdInput);
    handle.setFresh(false);
    const result = await reader(handle.ports, anonymousIdInput);
    assert.equal(result.kind, 'metadata');
    if (result.kind === 'metadata') assert.equal(result.metadata.collection.title, 'origin-after-delete');
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
    const reads: PublicationMetadataReadPort = {
      async load(input) {
        observedSignal = input.signal;
        markEntered();
        await originGate;
        if (input.signal?.aborted) throw input.signal.reason;
        return record();
      },
    };
    const ports: PublicationMetadataQueryPorts = {
      reads,
      origin: ORIGIN,
      now: () => NOW_DATE,
    };

    const pending = reader(ports, anonymousIdInput, controller.signal);
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
