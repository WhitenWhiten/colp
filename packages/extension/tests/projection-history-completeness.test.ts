import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { scope, setup } from './sync-recovery-hardening-fixture.js';

test('reads and replaces pending projection work beyond ten thousand terminal records', async () => {
  const store = await setup();
  const terminal = Array.from({ length: 10_000 }, (_, index) => ({ intentId: `aaa-${String(index).padStart(5, '0')}`,
    kind: 'create' as const, colpId: `old-${index}`, order: index + 1, suppression: `old-${index}`,
    generation: 1, state: 'terminal' as const }));
  const pending = { intentId: 'zzz-new', kind: 'create' as const, colpId: 'new-child', order: 10001,
    suppression: 'pending', generation: 1, state: 'pending' as const };
  await store.replaceProjectionIntents(scope, [...terminal, pending]);
  const read = await store.listProjectionIntents(scope);
  assert.equal(read.length, 10001);
  assert.equal(read.find(row => row.intentId === pending.intentId)?.state, 'pending');
  await store.replaceProjectionIntents(scope, [{ ...pending, intentId: 'zzz-replacement' }]);
  const replaced = await store.listProjectionIntents(scope);
  assert.equal(replaced.length, 10001, 'old pending work beyond the former ceiling is removed');
  assert.equal(replaced.some(row => row.intentId === pending.intentId), false);
  assert.equal(replaced.at(-1)?.intentId, 'zzz-replacement');
  store.close();
}, 30_000);
