import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import {
  parseAdvancedPlanMetadata, parseAdvancedStepDefinition, parseRemoteNodeFact,
} from '../src/bootstrap/advanced-record-validation.js';
import { activateAdvancedPlan, executeActiveAdvancedPlan } from '../src/bootstrap/advanced-run.js';
import type { AdvancedNativeApi } from '../src/bootstrap/advanced-local-executor.js';
import type { AdvancedLocalMoveStep, AdvancedParentRef } from '../src/bootstrap/advanced-plan-types.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { active, scope } from './kns-03-bootstrap-harness.js';

const legacyMetadata = {
  mode: 'upload', confirmationId: 'confirm-1', treeDigest: 'tree-1',
  mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'remote-bar' }],
};

const localMoveStep: AdvancedLocalMoveStep = {
  stepId: 'move-bookmark', order: 0, dependsOn: [], side: 'local', action: 'move', operation: 'move',
  source: { nodeId: 'remote-bookmark', fact: {
    nodeId: 'remote-bookmark', parentId: 'remote-folder', kind: 'bookmark', title: 'Bookmark',
    url: 'https://example.test/', revision: 'r1',
  } },
  target: { nativeId: 'bookmark', nodeId: 'remote-bookmark' },
  parent: { kind: 'native-node', id: 'folder' },
  payload: { type: 'move', nativeId: 'bookmark', newParent: { kind: 'native-node', id: 'folder' }, index: 0 },
  before: { nativeId: 'bookmark', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
    title: 'Bookmark', url: 'https://example.test/', index: 0 },
  after: { nativeId: 'bookmark', parent: { kind: 'native-node', id: 'folder' },
    node: { kind: 'bookmark', title: 'Bookmark', url: 'https://example.test/' }, index: 0 },
};

test('local move definitions retain every supported parent reference', () => {
  const parents: readonly AdvancedParentRef[] = [
    { kind: 'native-node', id: 'folder' },
    { kind: 'remote-node', id: 'remote-folder' },
    { kind: 'step', stepId: 'create-folder' },
  ];
  for (const parent of parents) {
    const step = { ...localMoveStep, parent, payload: { ...localMoveStep.payload, newParent: parent },
      after: { ...localMoveStep.after, parent } };
    assert.deepEqual(parseAdvancedStepDefinition(JSON.parse(JSON.stringify(step))), step);
  }
});

test('local move definitions reject a missing or malformed parent', () => {
  const missingParent = Object.fromEntries(Object.entries(localMoveStep).filter(([key]) => key !== 'parent'));
  assert.throws(() => parseAdvancedStepDefinition(missingParent), /advanced_plan_corrupt/u);
  for (const parent of [undefined, null, {}, { kind: 'native-node' },
    { kind: 'native-node', id: '' }, { kind: 'step' }, { kind: 'unsupported', id: 'folder' }]) {
    assert.throws(() => parseAdvancedStepDefinition({ ...localMoveStep, parent }), /advanced_plan_corrupt/u);
  }
});

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
