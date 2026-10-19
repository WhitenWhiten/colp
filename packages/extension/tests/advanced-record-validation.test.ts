import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import {
  parseAdvancedPlanMetadata, parseAdvancedStepDefinition, parseRemoteNodeFact,
} from '../src/bootstrap/advanced-record-validation.js';
import { activateAdvancedPlan, executeActiveAdvancedPlan } from '../src/bootstrap/advanced-run.js';
import type { AdvancedNativeApi } from '../src/bootstrap/advanced-local-executor.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { active, scope } from './kns-03-bootstrap-harness.js';

const legacyMetadata = {
  mode: 'upload', confirmationId: 'confirm-1', treeDigest: 'tree-1',
  mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'remote-bar' }],
};

test('parses a legacy plan with only the fields it actually had', () => {
  const metadata = parseAdvancedPlanMetadata(legacyMetadata);
  assert.equal(metadata.mode, 'upload');
  assert.equal(metadata.mounts[0]?.nativeRootId, 'bar');
  assert.equal(metadata.boundaryVersion, undefined);
  assert.equal(metadata.selectedNativeIds, undefined);
});

test('rejects corrupt mounts, facts and step definitions instead of casting them', () => {
  for (const mounts of [
    'not-an-array',
    [],
    [{ nativeRootId: 'bar', rootRole: 'not-a-role', remoteMountNodeId: null }],
    [{ nativeRootId: 'bar', remoteMountNodeId: null }, { nativeRootId: 'bar', remoteMountNodeId: null }],
  ]) {
    assert.throws(() => parseAdvancedPlanMetadata({ ...legacyMetadata, mounts }), /advanced_plan_corrupt/u);
  }
  assert.throws(() => parseRemoteNodeFact({ nodeId: 'x', parentId: null, kind: 'nope', title: 'x', revision: 'r' }),
    /advanced_plan_corrupt/u);
  assert.throws(() => parseAdvancedStepDefinition({ kind: 'snapshot-fact', fact: { nodeId: 'x' } }),
    /advanced_plan_corrupt/u);
  assert.throws(() => parseAdvancedStepDefinition({ stepId: 's', order: -1, dependsOn: [], side: 'remote',
    action: 'create', operation: 'create_node' }), /advanced_plan_corrupt/u);
});

test('a corrupt mount record fails activation before any mount, bootstrap or first-run write', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await active(store);
  const before = await store.getScope(scope);
  const committed = await store.commitAdvancedPlan(scope, { planId: 'corrupt-mount',
    metadata: { ...legacyMetadata, mounts: [{ nativeRootId: 'bar', rootRole: 'bogus', remoteMountNodeId: null }] },
    steps: [], now: 10 });
  await assert.rejects(() => activateAdvancedPlan(store, scope, committed), /advanced_plan_corrupt/u);
  assert.deepEqual(await store.listMountBindings(scope), []);
  assert.deepEqual(await store.listBootstrapRuns(scope), []);
  assert.deepEqual(await store.getScope(scope), before);
});

test('a corrupt persisted step fails before the executor transitions or queues anything', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await active(store);
  const committed = await store.commitAdvancedPlan(scope, { planId: 'corrupt-step',
    metadata: legacyMetadata,
    steps: [{ kind: 'snapshot-fact', fact: { nodeId: 'remote-bar' }, nativeId: null }], now: 10 });
  const api: AdvancedNativeApi = {
    async get() { return []; }, async getChildren() { return []; },
    async create(): Promise<never> { throw new Error('unexpected'); },
    async update(): Promise<never> { throw new Error('unexpected'); },
    async move(): Promise<never> { throw new Error('unexpected'); },
    async remove(): Promise<never> { throw new Error('unexpected'); },
  };
  await assert.rejects(() => executeActiveAdvancedPlan(store, scope, api), /advanced_plan_corrupt/u);
  const after = await store.readAdvancedPlan(scope, committed.planId);
  assert.equal(after?.steps[0]?.state, 'pending');
  assert.deepEqual(await store.listQueue(scope), []);
  assert.equal(after?.plan.state, 'active');
});
