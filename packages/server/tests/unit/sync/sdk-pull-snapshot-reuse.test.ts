import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { validateAuthoritativePullEvent } from '@know-n/colp/sync';
import { canonicalOperationDigest, canonicalAuthoritativeEffectDigest, canonicalJsonSnapshot } from '@know-n/colp/sync/canonical';
import type { SyncPullEventV02 } from '@know-n/colp/types';

test('the installed production SDK reuses owned Pull DTOs across canonical and validation entry points', () => {
  const example = JSON.parse(readFileSync(new URL('../../../../../protocol/examples/sync-pull-v02.json', import.meta.url), 'utf8'))
    .events[0] as Extract<SyncPullEventV02, { kind: 'operation' }>;
  const effect = { ...example.effect, operationDigest: canonicalOperationDigest(example.operation) };
  const owned = validateAuthoritativePullEvent({ ...example,
    effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } }, '0.2');
  assert.equal(validateAuthoritativePullEvent(owned, '0.2'), owned);
  if (owned.kind !== 'operation' || !owned.operation) throw new Error('Expected a validated Operation');
  assert.equal(canonicalJsonSnapshot(owned.operation, 'Operation'), owned.operation);
  assert.equal(Object.isFrozen(owned.operation.payload), true);
  assert.notEqual(owned.operation, example.operation);
});
