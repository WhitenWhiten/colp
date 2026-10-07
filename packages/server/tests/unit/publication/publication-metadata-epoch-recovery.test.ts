import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildCacheEpochKey } from '../../../src/infrastructure/cache/index.js';
import { makeFixture, makePorts, record, COLLECTION_ID, ENVIRONMENT, KEY_PREFIX, collectionDomain, anonymousIdInput } from '../../support/publication-metadata-cache-helpers.js';

  test('corrupt epoch never resurrects warm generation zero and preserves origin failure', async () => {
    const { store, reader } = makeFixture();
    const handle = makePorts(() => record());
    const epochKey = buildCacheEpochKey({ environment: ENVIRONMENT, keyPrefix: KEY_PREFIX, domain: collectionDomain(COLLECTION_ID) });
    await reader(handle.ports, anonymousIdInput);
    store.data.set(epochKey, '1');
    await reader(handle.ports, anonymousIdInput);
    handle.setFail(true);
    const commandsBefore = store.calls.length;
    store.data.set(epochKey, 'corrupt');
    await assert.rejects(reader(handle.ports, anonymousIdInput), /postgres unavailable/);
    assert.equal(handle.loadCount(), 3);
    assert.deepEqual(store.calls.slice(commandsBefore).map(call => call.args[0]), [epochKey],
      'corruption reads no data key and writes no generation');
  });

