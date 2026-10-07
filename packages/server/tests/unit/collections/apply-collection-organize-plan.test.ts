import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, test, vi } from 'vitest';
import {
  COLLECTION_TREE_VERSION_MAX_NODES,
  NodeConflictError,
  OrganizePlanInputError,
  OrganizePlanInnerCommandError,
  applyCollectionOrganizePlan,
  createCollectionNodeCommandScope,
  freezeOrganizePlanEtag,
  moveCollectionNodeCommandScope,
  type ApplyCollectionOrganizePlanPorts,
  type CollectionTreeLiveMember,
  type CollectionVersionRecord,
  type CollectionVersionStorePort,
  type OrganizePlanRecord,
} from '../../../src/modules/collections/index.js';
import * as createNodeModule from '../../../src/modules/collections/application/create-collection-node.js';
import * as moveNodeModule from '../../../src/modules/collections/application/move-collection-node.js';
import {
  COLLECTION_ID,
  CONTENT_REV,
  PRINCIPAL_OWNER,
  ROOT_ID,
  SUBJECT_OWNER,
  createMemoryPorts,
  createState,
  seedCollection,
  seedNode,
  type MemoryState,
} from '../../support/move-collection-node-memory.js';
import {
  createMemoryProductCommandReceiptPort,
  productCommandReceiptKey,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';

const APPLY_SOURCE = readFileSync(
  join(import.meta.dirname, '../../../src/modules/collections/application/apply-collection-organize-plan.ts'),
  'utf8',
);
const UNSORTED = 'folder-unsorted-apply';
const BM_A = 'bm-apply-a';
const BM_B = 'bm-apply-b';
const ACTION_CREATE = 'action-create-folder';
const ACTION_OTHER = 'action-unselected';
const PLAN_ID = 'plan-apply-1';
const NOW = new Date('2026-08-23T08:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

function organizeReceipts(receipts: MemoryProductCommandReceipts) {
  const base = createMemoryProductCommandReceiptPort(receipts);
  return {
    claim: (binding: Parameters<typeof base.claim>[0], fingerprint: string) =>
      base.claim(binding, fingerprint),
    complete: (
      binding: Parameters<typeof base.complete>[0],
      fingerprint: string,
      result: Parameters<typeof base.complete>[2],
    ) => base.complete(binding, fingerprint, result),
    async lookup(binding: Parameters<typeof base.claim>[0], fingerprint: string) {
      const existing = receipts.get(productCommandReceiptKey(binding));
      if (!existing) return { kind: 'absent' as const };
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' as const };
      if (existing.expired) {
        return { kind: 'expired' as const, resultDigest: existing.resultDigest ?? null };
      }
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress' as const, retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed receipt must retain result');
      return {
        kind: 'replay' as const,
        result: {
          status: existing.result.status,
          body: existing.result.body.slice(),
          stableHeaders: { ...existing.result.stableHeaders },
          mediaType: existing.result.mediaType,
          contractVersion: existing.result.contractVersion,
          targetIdentity: existing.result.targetIdentity,
        },
      };
    },
  };
}

function snapshot(state: MemoryState, plans: OrganizePlanRecord[]) {
  return {
    nodes: new Map([...state.nodes.entries()].map(([id, row]) => [id, { ...row, tags: [...row.tags] }])),
    collections: new Map([...state.collections.entries()].map(([id, row]) => [id, { ...row }])),
    plans: plans.map((plan) => ({ ...plan })),
  };
}

function restore(
  state: MemoryState,
  plans: OrganizePlanRecord[],
  snap: ReturnType<typeof snapshot>,
): void {
  state.nodes.clear();
  for (const [id, row] of snap.nodes) state.nodes.set(id, { ...row, tags: [...row.tags] });
  state.collections.clear();
  for (const [id, row] of snap.collections) state.collections.set(id, { ...row });
  plans.splice(0, plans.length, ...snap.plans.map((plan) => ({ ...plan })));
}

function seedApplyTree(state: MemoryState): void {
  seedCollection(state, { contentRevision: CONTENT_REV });
  seedNode(state, {
    id: UNSORTED, parentId: ROOT_ID, kind: 'folder', title: 'Unsorted', childrenRevision: 'unsorted-ch',
  });
  seedNode(state, {
    id: BM_A, parentId: UNSORTED, kind: 'bookmark', title: 'Repo A',
    url: 'https://github.com/acme/a', resourceRevision: 'bm-a-res',
  });
  seedNode(state, {
    id: BM_B, parentId: UNSORTED, kind: 'bookmark', title: 'Repo B',
    url: 'https://github.com/acme/b', resourceRevision: 'bm-b-res',
  });
}

function createFolderAction(): OrganizePlanRecord['actions'][number] {
  return {
    id: ACTION_CREATE,
    sourceFolderId: UNSORTED,
    sourceFolderTitle: 'Unsorted',
    target: { type: 'create_folder', parentId: ROOT_ID, title: 'GitHub' },
    nodeIds: [BM_A, BM_B],
    count: 2,
    reason: 'Same host "github.com" (2 bookmarks).',
    confidence: 90,
  };
}

function openPlan(actions: OrganizePlanRecord['actions']): OrganizePlanRecord {
  const actionIds = actions.map((action) => action.id);
  return {
    planId: PLAN_ID,
    accountId: PRINCIPAL_OWNER,
    collectionId: COLLECTION_ID,
    collectionRevision: CONTENT_REV,
    plannerId: 'heuristic.v1.host_cluster',
    status: 'open',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    etag: freezeOrganizePlanEtag({
      planId: PLAN_ID, contentRevision: CONTENT_REV, actionIds,
    }),
    truncated: false,
    actions,
    appliedActionIds: null,
    applyReceipt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seedHappy(): { state: MemoryState; plans: OrganizePlanRecord[]; etag: string } {
  const state = createState();
  seedApplyTree(state);
  const plans = [openPlan([createFolderAction()])];
  return { state, plans, etag: plans[0]!.etag };
}

function applyInput(etag: string): Parameters<typeof applyCollectionOrganizePlan>[1] {
  return {
    actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
    commandId: randomUUID(), collectionId: COLLECTION_ID, planId: PLAN_ID,
    ifMatch: etag, actionIds: [ACTION_CREATE],
  };
}

function memoryVersionStore(seed: {
  readonly members?: readonly CollectionTreeLiveMember[];
  readonly rows?: CollectionVersionRecord[];
  readonly insert?: (row: CollectionVersionRecord) => Promise<void>;
} = {}): { store: CollectionVersionStorePort; rows: CollectionVersionRecord[]; insertCount: number } {
  const rows = [...(seed.rows ?? [])];
  const store: CollectionVersionStorePort & { insertCount: number } = {
    insertCount: 0,
    async lockOwnedLive() { return null; },
    async getOwnedLive() { return null; },
    async loadLiveMembers() { return seed.members ?? []; },
    async getByCollectionAndRevision(_a, collectionId, contentRevision) {
      return rows.find((row) => row.collectionId === collectionId && row.contentRevision === contentRevision) ?? null;
    },
    async getById() { return null; },
    async list() { return rows; },
    async insert(row) {
      store.insertCount += 1;
      if (seed.insert) await seed.insert(row);
      else rows.push(row);
    },
    async count() { return rows.length; },
    async deleteOldest() {},
    async findLatestManualCreatedAt() { return null; },
  };
  return { store, rows, get insertCount() { return store.insertCount; } };
}

function portsFor(
  state: MemoryState,
  plans: OrganizePlanRecord[],
  receipts: MemoryProductCommandReceipts = new Map(),
  treeVersions?: ApplyCollectionOrganizePlanPorts['treeVersions'],
): ApplyCollectionOrganizePlanPorts {
  return {
    receipts: organizeReceipts(receipts),
    plans: {
      async getById(accountId, collectionId, planId) {
        return plans.find((plan) =>
          plan.accountId === accountId
          && plan.collectionId === collectionId
          && plan.planId === planId) ?? null;
      },
      async expireOpen() { /* unused in apply tests */ },
      async insert() { /* unused in apply tests */ },
      async findLatestCreatedAt() { return null; },
      async persistApplyReceipt(input) {
        const plan = plans.find((row) => row.planId === input.planId);
        if (!plan) return;
        (plan as { applyReceipt: unknown }).applyReceipt = input.applyReceipt;
        (plan as { updatedAt: Date }).updatedAt = input.now;
      },
      async markApplied(input) {
        const plan = plans.find((row) => row.planId === input.planId);
        if (!plan) return;
        (plan as { status: string }).status = 'applied';
        (plan as { appliedActionIds: readonly string[] }).appliedActionIds = input.appliedActionIds;
        (plan as { updatedAt: Date }).updatedAt = input.now;
      },
    },
    collections: {
      async lockOwnedLive(collectionId, ownerSubjectId) {
        const row = state.collections.get(collectionId);
        if (!row || row.ownerSubjectId !== ownerSubjectId || row.deletedAt) return null;
        return {
          collectionId: row.id,
          ownerSubjectId: row.ownerSubjectId,
          contentRevision: row.contentRevision,
          rootNodeId: row.rootNodeId,
        };
      },
      async loadLiveTree() {
        return { folders: [], bookmarks: [] };
      },
    },
    mutations: createMemoryPorts(state),
    clock: { now: () => NOW },
    ...(treeVersions === undefined ? {} : { treeVersions }),
  };
}

async function applyWithRollback(
  state: MemoryState,
  plans: OrganizePlanRecord[],
  ports: ApplyCollectionOrganizePlanPorts,
  input: Parameters<typeof applyCollectionOrganizePlan>[1],
) {
  const snap = snapshot(state, plans);
  try {
    return await applyCollectionOrganizePlan(ports, input);
  } catch (error: unknown) {
    restore(state, plans, snap);
    throw error;
  }
}

describe('applyCollectionOrganizePlan', () => {
  test('source imports createCollectionNode and moveCollectionNode without fetch', () => {
    assert.match(APPLY_SOURCE, /createCollectionNode\(/u);
    assert.match(APPLY_SOURCE, /moveCollectionNode\(/u);
    assert.match(APPLY_SOURCE, /captureCollectionTreeVersion\(/u);
    assert.match(APPLY_SOURCE, /from '\.\/capture-collection-tree-version\.js'/u);
    assert.doesNotMatch(APPLY_SOURCE, /loadLiveTree/u);
    assert.doesNotMatch(APPLY_SOURCE, /\bfetch\s*\(/u);
    assert.doesNotMatch(APPLY_SOURCE, /node:http/u);
  });

  test('invokes createCollectionNode and moveCollectionNode in-process for two moves into one new folder', async () => {
    const createSpy = vi.spyOn(createNodeModule, 'createCollectionNode');
    const moveSpy = vi.spyOn(moveNodeModule, 'moveCollectionNode');
    const state = createState();
    seedApplyTree(state);
    const plans = [openPlan([createFolderAction()])];
    const ports = portsFor(state, plans);
    const result = await applyCollectionOrganizePlan(ports, {
      actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
      commandId: randomUUID(),
      collectionId: COLLECTION_ID,
      planId: PLAN_ID,
      ifMatch: plans[0]!.etag,
      actionIds: [ACTION_CREATE],
    });
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(createSpy.mock.calls.length, 1);
    assert.equal(moveSpy.mock.calls.length, 2);
    assert.equal(
      createSpy.mock.calls[0]![1].command.commandScope,
      createCollectionNodeCommandScope(COLLECTION_ID),
    );
    assert.equal(
      moveSpy.mock.calls[0]![1].command.commandScope,
      moveCollectionNodeCommandScope(COLLECTION_ID, BM_A),
    );
    assert.equal(typeof createSpy.mock.calls[0]![0].canonical.execute, 'function');
    assert.equal(result.receipt.createdFolderIds.length, 1);
    const folderId = result.receipt.createdFolderIds[0]!;
    assert.equal(state.nodes.get(folderId)?.kind, 'folder');
    assert.equal(state.nodes.get(folderId)?.parentId, ROOT_ID);
    assert.equal(state.nodes.get(BM_A)?.parentId, folderId);
    assert.equal(state.nodes.get(BM_B)?.parentId, folderId);
    assert.equal(plans[0]?.status, 'applied');
    assert.deepEqual(result.receipt.movedNodeIds, [BM_A, BM_B]);
    const receipt = plans[0]?.applyReceipt as {
      readonly [actionId: string]: {
        readonly createCommandId?: string;
        readonly moveCommandIds: readonly string[];
      };
    };
    const mapped = receipt[ACTION_CREATE];
    assert.equal(typeof mapped?.createCommandId, 'string');
    assert.equal(mapped?.moveCommandIds.length, 2);
    for (const commandId of [mapped!.createCommandId, ...mapped!.moveCommandIds]) {
      assert.match(
        commandId!,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });

  test('inner in_progress, reused, and expired outcomes surface without becoming unhandled errors', async () => {
    const state = createState();
    seedApplyTree(state);
    const plans = [openPlan([createFolderAction()])];
    const ports = portsFor(state, plans);

    const createSpy = vi.spyOn(createNodeModule, 'createCollectionNode');
    createSpy.mockResolvedValueOnce({
      kind: 'in_progress',
      retryAfterSeconds: 2,
    } as never);
    await assert.rejects(
      () => applyCollectionOrganizePlan(ports, {
        actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
        commandId: randomUUID(),
        collectionId: COLLECTION_ID,
        planId: PLAN_ID,
        ifMatch: plans[0]!.etag,
        actionIds: [ACTION_CREATE],
      }),
      (error: unknown) => error instanceof OrganizePlanInnerCommandError
        && error.outcome.kind === 'in_progress',
    );

    createSpy.mockResolvedValueOnce({ kind: 'reused' } as never);
    await assert.rejects(
      () => applyCollectionOrganizePlan(ports, {
        actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
        commandId: randomUUID(),
        collectionId: COLLECTION_ID,
        planId: PLAN_ID,
        ifMatch: plans[0]!.etag,
        actionIds: [ACTION_CREATE],
      }),
      (error: unknown) => error instanceof OrganizePlanInnerCommandError
        && error.outcome.kind === 'reused',
    );

    createSpy.mockResolvedValueOnce({ kind: 'expired' } as never);
    await assert.rejects(
      () => applyCollectionOrganizePlan(ports, {
        actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
        commandId: randomUUID(),
        collectionId: COLLECTION_ID,
        planId: PLAN_ID,
        ifMatch: plans[0]!.etag,
        actionIds: [ACTION_CREATE],
      }),
      (error: unknown) => error instanceof OrganizePlanInnerCommandError
        && error.outcome.kind === 'expired',
    );
  });

  test('failure does not half-move; parents roll back', async () => {
    const realMove = moveNodeModule.moveCollectionNode;
    const moveSpy = vi.spyOn(moveNodeModule, 'moveCollectionNode');
    moveSpy.mockImplementation(async (ports, input) => {
      if (moveSpy.mock.calls.length >= 2) throw new NodeConflictError('revision_conflict');
      return realMove(ports, input);
    });
    const state = createState();
    seedApplyTree(state);
    const plans = [openPlan([createFolderAction()])];
    const ports = portsFor(state, plans);
    await assert.rejects(
      () => applyWithRollback(state, plans, ports, {
        actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
        commandId: randomUUID(),
        collectionId: COLLECTION_ID,
        planId: PLAN_ID,
        ifMatch: plans[0]!.etag,
        actionIds: [ACTION_CREATE],
      }),
      NodeConflictError,
    );
    assert.equal(state.nodes.get(BM_A)?.parentId, UNSORTED);
    assert.equal(state.nodes.get(BM_B)?.parentId, UNSORTED);
    assert.equal(plans[0]?.status, 'open');
  });

  test('empty actionIds is invalid_request', async () => {
    const state = createState();
    seedApplyTree(state);
    const plans = [openPlan([createFolderAction()])];
    const ports = portsFor(state, plans);
    await assert.rejects(
      () => applyCollectionOrganizePlan(ports, {
        actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
        commandId: randomUUID(),
        collectionId: COLLECTION_ID,
        planId: PLAN_ID,
        ifMatch: plans[0]!.etag,
        actionIds: [],
      }),
      (error: unknown) => error instanceof OrganizePlanInputError && error.code === 'invalid_request',
    );
  });

  test('collection revision mismatch is 409 revision_conflict and parents stay in Unsorted', async () => {
    const state = createState();
    seedApplyTree(state);
    const plans = [openPlan([createFolderAction()])];
    const collection = state.collections.get(COLLECTION_ID)!;
    collection.contentRevision = 'rev-changed-after-plan';
    const ports = portsFor(state, plans);
    await assert.rejects(
      () => applyCollectionOrganizePlan(ports, {
        actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
        commandId: randomUUID(),
        collectionId: COLLECTION_ID,
        planId: PLAN_ID,
        ifMatch: plans[0]!.etag,
        actionIds: [ACTION_CREATE],
      }),
      (error: unknown) => error instanceof NodeConflictError && error.code === 'revision_conflict',
    );
    assert.equal(state.nodes.get(BM_A)?.parentId, UNSORTED);
    assert.equal(state.nodes.get(BM_B)?.parentId, UNSORTED);
  });

  test('same Known-Command-Id replays and does not move twice', async () => {
    const moveSpy = vi.spyOn(moveNodeModule, 'moveCollectionNode');
    const state = createState();
    seedApplyTree(state);
    const plans = [openPlan([
      createFolderAction(),
      {
        id: ACTION_OTHER,
        sourceFolderId: UNSORTED,
        sourceFolderTitle: 'Unsorted',
        target: { type: 'existing', folderId: ROOT_ID, title: 'Root' },
        nodeIds: [BM_A],
        count: 1,
        reason: 'unused',
        confidence: 40,
      },
    ])];
    const receipts: MemoryProductCommandReceipts = new Map();
    const ports = portsFor(state, plans, receipts);
    const commandId = randomUUID();
    const first = await applyCollectionOrganizePlan(ports, {
      actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
      commandId,
      collectionId: COLLECTION_ID,
      planId: PLAN_ID,
      ifMatch: plans[0]!.etag,
      actionIds: [ACTION_CREATE],
    });
    assert.equal(first.kind, 'succeeded');
    const callsAfterFirst = moveSpy.mock.calls.length;
    assert.equal(callsAfterFirst, 2);
    const folderId = first.kind === 'succeeded' ? first.receipt.createdFolderIds[0] : undefined;
    const second = await applyCollectionOrganizePlan(ports, {
      actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
      commandId,
      collectionId: COLLECTION_ID,
      planId: PLAN_ID,
      ifMatch: plans[0]!.etag,
      actionIds: [ACTION_CREATE],
    });
    assert.equal(second.kind, 'replay');
    assert.equal(moveSpy.mock.calls.length, callsAfterFirst);
    assert.equal(state.nodes.get(BM_A)?.parentId, folderId);
    assert.equal(state.nodes.get(BM_B)?.parentId, folderId);
  });

  test('skips snapshot when treeVersions is absent or disabled and still moves', async () => {
    const versions = memoryVersionStore();
    for (const treeVersions of [undefined, { enabled: false, versions: versions.store }] as const) {
      const { state, plans, etag } = seedHappy();
      const result = await applyCollectionOrganizePlan(
        portsFor(state, plans, new Map(), treeVersions),
        applyInput(etag),
      );
      assert.equal(result.kind, 'succeeded');
      assert.notEqual(state.nodes.get(BM_A)?.parentId, UNSORTED);
    }
    assert.equal(versions.insertCount, 0);
  });

  test('captures one pre_mutation Before organize row when treeVersions is enabled', async () => {
    const { state, plans, etag } = seedHappy();
    const versions = memoryVersionStore();
    const result = await applyCollectionOrganizePlan(
      portsFor(state, plans, new Map(), { enabled: true, versions: versions.store }),
      applyInput(etag),
    );
    assert.equal(result.kind, 'succeeded');
    assert.equal(versions.rows.length, 1);
    assert.equal(versions.rows[0]?.kind, 'pre_mutation');
    assert.equal(versions.rows[0]?.label, 'Before organize');
    assert.notEqual(state.nodes.get(BM_A)?.parentId, UNSORTED);
  });

  test('skips snapshot when live members exceed 2000 and still applies', async () => {
    const { state, plans, etag } = seedHappy();
    const versions = memoryVersionStore({
      members: Array.from({ length: COLLECTION_TREE_VERSION_MAX_NODES + 1 }, (_, index) => ({
        id: `x${index}`, kind: 'bookmark' as const, parentId: UNSORTED, title: 't',
        url: 'https://example.test/x', positionToken: `p${index}`,
      })),
    });
    const result = await applyCollectionOrganizePlan(
      portsFor(state, plans, new Map(), { enabled: true, versions: versions.store }),
      applyInput(etag),
    );
    assert.equal(result.kind, 'succeeded');
    assert.equal(versions.rows.length, 0);
    assert.notEqual(state.nodes.get(BM_A)?.parentId, UNSORTED);
  });

  test('keeps the existing revision row and still applies', async () => {
    const { state, plans, etag } = seedHappy();
    const existing: CollectionVersionRecord = {
      versionId: 'ver-kept', accountId: PRINCIPAL_OWNER, collectionId: COLLECTION_ID,
      contentRevision: CONTENT_REV, kind: 'manual', label: 'Kept', etag: '"ver-kept"',
      nodeCount: 0, treeJson: [], createdAt: NOW,
    };
    const versions = memoryVersionStore({ rows: [existing] });
    const result = await applyCollectionOrganizePlan(
      portsFor(state, plans, new Map(), { enabled: true, versions: versions.store }),
      applyInput(etag),
    );
    assert.equal(result.kind, 'succeeded');
    assert.equal(versions.rows.length, 1);
    assert.equal(versions.rows[0]?.versionId, 'ver-kept');
    assert.notEqual(state.nodes.get(BM_A)?.parentId, UNSORTED);
  });

  test('does not snapshot when the outer claim returns in_progress', async () => {
    const { state, plans, etag } = seedHappy();
    const versions = memoryVersionStore();
    const ports = portsFor(state, plans, new Map(), { enabled: true, versions: versions.store });
    Object.assign(ports.receipts, {
      claim: async () => ({ kind: 'in_progress' as const, retryAfterSeconds: 1 }),
    });
    const result = await applyCollectionOrganizePlan(ports, applyInput(etag));
    assert.equal(result.kind, 'in_progress');
    assert.equal(versions.rows.length, 0);
    assert.equal(state.nodes.get(BM_A)?.parentId, UNSORTED);
  });

  test('rolls back apply when capture throws a non-limit error', async () => {
    const { state, plans, etag } = seedHappy();
    const versions = memoryVersionStore({ insert: async () => { throw new Error('capture failed'); } });
    await assert.rejects(() => applyWithRollback(
      state, plans,
      portsFor(state, plans, new Map(), { enabled: true, versions: versions.store }),
      applyInput(etag),
    ));
    assert.equal(state.nodes.get(BM_A)?.parentId, UNSORTED);
    assert.equal(plans[0]?.status, 'open');
  });
});
