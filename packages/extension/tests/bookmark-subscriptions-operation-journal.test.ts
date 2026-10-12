import { expect, test } from 'vitest';
import { SETTLED_OPERATION_GRACE_MS, SETTLED_OPERATION_MAX } from '../src/bookmark-subscriptions/store.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { database, leaf, nativeFixture, owned, row } from './bookmark-subscriptions-fixture.js';

test('settled subscription operations stay within a fixed journal bound', async () => {
  const db = database();
  const mapping = row();
  const fixture = nativeFixture();
  const node = leaf();
  await db.put('mappings', mapping);
  fixture.nodes.set('child', { id: 'child', parentId: 'bar', title: node.title, url: node.url, index: 0 });
  await db.put('nodes', owned(mapping, node, 'child', 'bar'));
  const executor = createNativeExecutor(db, fixture.api);
  for (let index = 0; index < SETTLED_OPERATION_MAX + 20; index += 1) {
    const current = (await db.nodeForNative('child'))!;
    await executor.update(mapping, current, { ...current.node, title: `title-${index}` }, 'bar');
  }
  const sample = (await db.all('operations'))[0]!;
  await db.put('operations', { ...sample, id: 'keep-unsettled', settled: false, phase: 'issued', createdAt: 1 });
  await db.pruneSettledOperations(Date.now() + SETTLED_OPERATION_GRACE_MS + 1);
  const operations = await db.all('operations');
  expect(operations.some((operation) => operation.id === 'keep-unsettled' && operation.settled === false)).toBe(true);
  expect(operations.filter((operation) => operation.settled === true).length).toBeLessThanOrEqual(SETTLED_OPERATION_MAX);
  await db.close();
});
