import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { occupancyByNative, resolveCreateIdentity, virtualNativeId } from '../src/projection-native-occupancy.js';
import type { MappingInput } from '../src/sync-state-store.js';

const mapping = (nativeId: string, colpId: string): MappingInput => ({
  nativeId, colpId, rootNativeId: 'root', nodeKind: 'bookmark',
  projection: { revision: 'r', digest: `sha256:${colpId}`, content: { title: 'Equal', url: 'https://example.test/e' } },
});

describe('projection native occupancy', () => {
  test('virtual natives are not occupancy claims', () => {
    assert.equal(virtualNativeId('recovery:remote-a'), true);
    const occupied = occupancyByNative({
      seedMappings: [mapping('recovery:remote-a', 'remote-a'), mapping('created-1', 'remote-a')],
    });
    assert.equal(occupied.get('created-1'), 'remote-a');
    assert.equal(occupied.has('recovery:remote-a'), false);
  });

  test('live mappings and terminal intent observations occupy natives across restart', () => {
    const occupied = occupancyByNative({
      liveMappings: [mapping('n-live', 'colp-live')],
      intents: [{ colpId: 'remote-a', observedNativeId: 'created-1' }],
    });
    assert.equal(occupied.get('n-live'), 'colp-live');
    assert.equal(occupied.get('created-1'), 'remote-a');
  });

  test('equal-content sibling occupied by another node must create a new native', () => {
    const occupancy = occupancyByNative({
      intents: [{ colpId: 'remote-a', observedNativeId: 'created-1' }],
    });
    const resolution = resolveCreateIdentity({
      intent: { colpId: 'remote-b', title: 'Equal', url: 'https://example.test/e' },
      children: [{ id: 'created-1', title: 'Equal', url: 'https://example.test/e' }],
      occupancy,
    });
    assert.deepEqual(resolution, { action: 'create' });
  });

  test('this intent may reuse its own observed native after crash', () => {
    const occupancy = occupancyByNative({
      intents: [{ colpId: 'remote-a', observedNativeId: 'created-1' }],
    });
    const resolution = resolveCreateIdentity({
      intent: { colpId: 'remote-a', observedNativeId: 'created-1', title: 'Equal', url: 'https://example.test/e' },
      children: [{ id: 'created-1', title: 'Equal', url: 'https://example.test/e' }],
      occupancy,
    });
    assert.deepEqual(resolution, { action: 'reuse', nativeId: 'created-1' });
  });

  test('two unoccupied equal-content natives create an independent projection', () => {
    const resolution = resolveCreateIdentity({
      intent: { colpId: 'remote-a', title: 'Equal', url: 'https://example.test/e' },
      children: [
        { id: 'n1', title: 'Equal', url: 'https://example.test/e' },
        { id: 'n2', title: 'Equal', url: 'https://example.test/e' },
      ],
      occupancy: new Map(),
    });
    assert.deepEqual(resolution, { action: 'create' });
  });

  test('unique unoccupied title+URL is not reused without observedNativeId', () => {
    const children = [{ id: 'n1', title: 'Equal', url: 'https://example.test/e' }];
    const occupancy = new Map<string, string>();
    assert.deepEqual(resolveCreateIdentity({
      intent: { colpId: 'remote-a', title: 'Equal', url: 'https://example.test/e' },
      children, occupancy,
    }), { action: 'create' });
    assert.deepEqual(resolveCreateIdentity({
      intent: { state: 'pending', colpId: 'remote-a', title: 'Equal', url: 'https://example.test/e' },
      children, occupancy,
    }), { action: 'create' });
  });

  test.each(['executing', 'recovery'] as const)(
    'unique match with state %s and no observedNativeId is ambiguous', (state) => {
      const resolution = resolveCreateIdentity({
        intent: { state, colpId: 'remote-a', title: 'Equal', url: 'https://example.test/e' },
        children: [{ id: 'n1', title: 'Equal', url: 'https://example.test/e' }],
        occupancy: new Map(),
      });
      assert.deepEqual(resolution, { action: 'ambiguous' });
    });
});
