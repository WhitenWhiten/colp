import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessSharedExposureScope } from '../../../src/modules/attachments/shared-exposure-facts-port.js';

test('an output with no attachment candidates never reads attachment history', async () => {
  const verdicts = await assessSharedExposureScope({
    async listBlobFacts() { throw new Error('must not load unrelated history'); },
  }, { collectionId: 'collection', blobIds: [] });
  assert.deepEqual(verdicts, []);
});

test('explicit candidates remain denied and inherit the caller cancellation signal', async () => {
  const signal = new AbortController().signal;
  const verdicts = await assessSharedExposureScope({ async listBlobFacts(scope, options) {
    assert.deepEqual(scope.blobIds, ['blob']);
    assert.equal(options?.signal, signal);
    return [{ blobId: 'blob', logicalState: 'attached_private', currentGenerationState: 'active' }];
  } }, { collectionId: 'collection', blobIds: ['blob'] }, { signal });
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]?.eligible, false);
  assert.equal(verdicts[0]?.reason, 'no_content_safety_evidence');
});

test('malformed or oversized candidate scope is rejected before port work', async () => {
  let reads = 0;
  const port = { async listBlobFacts() { reads++; return []; } };
  for (const blobIds of [undefined, [''], Array.from({ length: 1001 }, (_, i) => `blob-${i}`)]) {
    await assert.rejects(assessSharedExposureScope(port, {
      collectionId: 'collection', blobIds: blobIds as string[],
    }), TypeError);
  }
  assert.equal(reads, 0);
});

test('unrequested or duplicated facts fail closed', async () => {
  const blob = { blobId: 'blob', logicalState: 'attached_private' as const, currentGenerationState: 'active' as const };
  for (const facts of [[{ ...blob, blobId: 'other' }], [blob, blob]]) {
    await assert.rejects(assessSharedExposureScope({ async listBlobFacts() { return facts; } },
      { collectionId: 'collection', blobIds: ['blob'] }), /bounded output candidates/u);
  }
});

test('already aborted scopes cannot start even an empty assessment', async () => {
  await assert.rejects(assessSharedExposureScope({ async listBlobFacts() { throw new Error('must not run'); } },
    { collectionId: 'collection', blobIds: [] }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
