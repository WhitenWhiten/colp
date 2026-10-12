import { describe, expect, it } from 'vitest';
import { translateSyncBrowserDelete } from '@know-n/colp/sync';

import {
  AdvancedPlanError, buildAdvancedPlan, type AdvancedPlan, type AdvancedStep,
} from '../src/bootstrap/advanced-plan.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';

const root: RemoteNodeFact = {
  nodeId: 'r-root', parentId: null, kind: 'folder', title: 'Collection', folderRole: 'root',
  revision: 'r-root-1', childrenRevision: 'children-root-1',
};
const mount: RemoteNodeFact = {
  nodeId: 'r-bar', parentId: root.nodeId, kind: 'folder', title: 'Bookmarks bar',
  folderRole: 'bookmarks-bar', revision: 'r-bar-1', childrenRevision: 'children-bar-1',
};
const mountFact: MountFact = {
  nativeRootId: 'n-bar', rootRole: 'bookmarks-bar', remoteMountNodeId: mount.nodeId,
};

it('preserves unsupported separators instead of creating folders or deleting them', () => {
  const separator = remote('separator', mount.nodeId, '', undefined, 'separator');
  for (const mode of ['upload', 'download', 'mirror'] as const) {
    const plan = buildAdvancedPlan(input({ mode, remote: [root, mount, separator] }));
    expect(plan.steps).toEqual([]);
  }
});

function local(nativeId: string, parentNativeId: string, title: string, url?: string,
  kind: LocalNodeFact['kind'] = url ? 'bookmark' : 'folder'): LocalNodeFact {
  return { nativeId, mountNativeRootId: mountFact.nativeRootId, parentNativeId, kind, title, ...(url ? { url } : {}) };
}
function remote(nodeId: string, parentId: string, title: string, url?: string,
  kind: RemoteNodeFact['kind'] = url ? 'bookmark' : 'folder', revision = `revision-${nodeId}`,
  childrenRevision?: string): RemoteNodeFact {
  return { nodeId, parentId, kind, title, revision, ...(url ? { url } : {}),
    ...(kind === 'folder' ? { childrenRevision: childrenRevision === undefined ? `children-${nodeId}` : childrenRevision } : {}) };
}
function input(overrides: Partial<Parameters<typeof buildAdvancedPlan>[0]> = {}): Parameters<typeof buildAdvancedPlan>[0] {
  return {
    confirmationId: 'confirm-1', mode: 'upload', remoteSnapshotId: 'snapshot-1',
    remoteRevision: 'collection-revision-1', remoteCursor: 'cursor-1',
    scopeFingerprint: 'sha256:scope', treeDigest: 'sha256:tree', rootNodeId: root.nodeId,
    local: [], remote: [root, mount], mappings: [], mounts: [mountFact], ...overrides,
  };
}

function stepsOf<Side extends AdvancedStep['side'], Action extends AdvancedStep['action']>(
  plan: AdvancedPlan, side: Side, action: Action,
): Extract<AdvancedStep, { side: Side; action: Action }>[] {
  return (plan.steps.filter((step) => step.side === side && step.action === action) as unknown as Extract<AdvancedStep, { side: Side; action: Action }>[]);
}
function errorCode(fn: () => unknown): string {
  try { fn(); } catch (error) { return error instanceof AdvancedPlanError ? error.code : String(error); }
  return '';
}

describe('advanced bootstrap pure plan', () => {
  it('plans upload creates parent-first and preserves mapped Node identity for update and move', () => {
    const remoteFolder = remote('r-work', mount.nodeId, 'Work', undefined, 'folder', 'r-work-1', 'children-work-1');
    const remoteDestination = remote('r-dest', mount.nodeId, 'Destination', undefined, 'folder', 'r-dest-1', 'children-dest-1');
    const remoteBookmark = remote('r-bookmark', remoteFolder.nodeId, 'Old title', 'https://example.test/old', 'bookmark', 'r-bookmark-1');
    const plan = buildAdvancedPlan(input({
      remote: [root, mount, remoteFolder, remoteDestination, remoteBookmark],
      local: [local('n-dest', mountFact.nativeRootId, 'Destination'),
        local('n-new-folder', mountFact.nativeRootId, 'New folder'),
        local('n-new-bookmark', 'n-new-folder', 'New bookmark', 'https://example.test/new'),
        local('n-bookmark', 'n-dest', 'New title', 'https://example.test/new-url')],
      mappings: [{ nativeId: 'n-dest', colpId: remoteDestination.nodeId },
        { nativeId: 'n-bookmark', colpId: remoteBookmark.nodeId }],
    }));
    const update = stepsOf(plan, 'remote', 'update').find((step) => step.target.nodeId === remoteBookmark.nodeId);
    const move = stepsOf(plan, 'remote', 'move').find((step) => step.target.nodeId === remoteBookmark.nodeId);
    expect(update).toMatchObject({ operation: 'update_node_content', target: { nodeId: 'r-bookmark', nativeId: 'n-bookmark' },
      payload: { targetId: 'r-bookmark', baseRevision: 'r-bookmark-1', base: { title: 'Old title', url: 'https://example.test/old' },
        value: { title: 'New title', url: 'https://example.test/new-url' } } });
    expect(move).toMatchObject({ operation: 'move_node', target: { nodeId: 'r-bookmark', nativeId: 'n-bookmark' },
      payload: { baseRevision: { kind: 'step', stepId: update?.stepId, field: 'revision' }, baseSourceParentRevision: 'children-work-1',
        baseTargetParentRevision: 'children-dest-1', newParent: { kind: 'remote-node', id: 'r-dest' } } });
    expect(update && move && update.order).toBeLessThan(move?.order ?? Number.POSITIVE_INFINITY);
    const creates = stepsOf(plan, 'remote', 'create');
    const folderCreate = creates.find((step) => step.source.nativeId === 'n-new-folder');
    const bookmarkCreate = creates.find((step) => step.source.nativeId === 'n-new-bookmark');
    expect(folderCreate).toBeDefined();
    expect(bookmarkCreate?.dependsOn).toContain(folderCreate?.stepId);
    expect(plan.matched).toEqual(expect.arrayContaining([
      { nativeId: 'n-dest', nodeId: 'r-dest' }, { nativeId: 'n-bookmark', nodeId: 'r-bookmark' },
    ]));
    expect(plan.steps.every((step) => step.order > 0 && step.order <= plan.steps.length)).toBe(true);
  });

  it('plans download updates/moves in place and creates remote-only descendants before deleting local leaves', () => {
    const remoteFolder = remote('r-folder', mount.nodeId, 'Remote folder', undefined, 'folder', 'r-folder-1', 'children-folder-1');
    const remoteDestination = remote('r-dest', mount.nodeId, 'Remote destination', undefined, 'folder', 'r-dest-1', 'children-dest-1');
    const remoteBookmark = remote('r-bookmark', remoteDestination.nodeId, 'Remote title', 'https://example.test/remote', 'bookmark', 'r-bookmark-1');
    const remoteOnlyBookmark = remote('r-new', remoteDestination.nodeId, 'New remote', 'https://example.test/new');
    const plan = buildAdvancedPlan(input({
      mode: 'download', remote: [root, mount, remoteFolder, remoteDestination, remoteBookmark, remoteOnlyBookmark],
      local: [local('n-folder', mountFact.nativeRootId, 'Old local folder'),
        local('n-dest', mountFact.nativeRootId, 'Old destination'), local('n-bookmark', 'n-folder', 'Old title', 'https://example.test/old'),
        local('n-local-only', 'n-folder', 'Remove me', 'https://example.test/remove')],
      mappings: [{ nativeId: 'n-folder', colpId: remoteFolder.nodeId },
        { nativeId: 'n-dest', colpId: remoteDestination.nodeId }, { nativeId: 'n-bookmark', colpId: remoteBookmark.nodeId }],
    }));
    const update = stepsOf(plan, 'local', 'update').find((step) => step.target.nativeId === 'n-bookmark');
    const move = stepsOf(plan, 'local', 'move').find((step) => step.target.nativeId === 'n-bookmark');
    expect(update).toMatchObject({ target: { nativeId: 'n-bookmark', nodeId: 'r-bookmark' },
      source: { fact: { nodeId: 'r-bookmark', revision: 'r-bookmark-1' } },
      payload: { before: { title: 'Old title', url: 'https://example.test/old' }, after: { title: 'Remote title', url: 'https://example.test/remote' } } });
    expect(move).toMatchObject({ parent: { kind: 'native-node', id: 'n-dest' },
      source: { fact: { nodeId: 'r-bookmark', revision: 'r-bookmark-1' } } });
    expect(update && move && update.order).toBeLessThan(move?.order ?? Number.POSITIVE_INFINITY);
    expect(stepsOf(plan, 'local', 'create').some((step) => step.source.nodeId === remoteOnlyBookmark.nodeId)).toBe(true);
    expect(stepsOf(plan, 'local', 'remove')).toHaveLength(1);
    expect(stepsOf(plan, 'local', 'remove')[0]).toMatchObject({ target: { nativeId: 'n-local-only' }, payload: { recursive: false } });
    expect(stepsOf(plan, 'local', 'create').some((step) => step.source.nodeId === 'r-bookmark')).toBe(false);
  });

  it('moves a retained descendant before deleting a remote-only folder and never deletes a mount', () => {
    const remoteOld = remote('r-old', mount.nodeId, 'Old container', undefined, 'folder', 'r-old-1', 'children-old-1');
    const remoteRetained = remote('r-retained', remoteOld.nodeId, 'Retained', 'https://example.test/keep', 'bookmark', 'r-retained-1');
    const remoteOther = remote('r-other', mount.nodeId, 'Other', undefined, 'folder', 'r-other-1', 'children-other-1');
    const plan = buildAdvancedPlan(input({
      remote: [root, mount, remoteOld, remoteRetained, remoteOther],
      local: [local('n-other', mountFact.nativeRootId, 'Other'), local('n-retained', 'n-other', 'Retained', 'https://example.test/keep')],
      mappings: [{ nativeId: 'n-other', colpId: remoteOther.nodeId }, { nativeId: 'n-retained', colpId: remoteRetained.nodeId }],
    }));
    const move = stepsOf(plan, 'remote', 'move').find((step) => step.target.nodeId === remoteRetained.nodeId);
    const remove = stepsOf(plan, 'remote', 'delete').find((step) => step.target.nodeId === remoteOld.nodeId);
    expect(move).toMatchObject({ parent: { kind: 'remote-node', id: remoteOther.nodeId } });
    expect(remove).toBeDefined();
    // F002: a remote-only folder is deleted as a subtree, matching the protocol
    // translation for the same target kind.
    expect(remove).toMatchObject({ operation: 'delete_subtree',
      payload: { type: 'delete_subtree', targetId: 'r-old', baseRevision: 'r-old-1' } });
    expect(remove!.payload.type).toBe(translateSyncBrowserDelete({ nodeId: 'r-old', nodeKind: 'folder' }).type);
    expect(move && remove && move.order).toBeLessThan(remove?.order ?? Number.POSITIVE_INFINITY);
    expect(stepsOf(plan, 'remote', 'move').some((step) => step.target.nodeId === mount.nodeId)).toBe(false);
    expect(stepsOf(plan, 'remote', 'delete').some((step) => step.target.nodeId === root.nodeId)).toBe(false);
  });

  it('creates a missing remote mount during download while preserving the native mount root', () => {
    const plan = buildAdvancedPlan(input({ mode: 'download', remote: [root],
      mounts: [{ ...mountFact, remoteMountNodeId: null }],
      local: [local('n-local', mountFact.nativeRootId, 'Local only', 'https://example.test/local')] }));
    const mountCreate = stepsOf(plan, 'remote', 'create').find((step) => step.source.nativeId === mountFact.nativeRootId);
    expect(mountCreate).toMatchObject({ operation: 'create_node', after: { node: { folderRole: 'bookmarks-bar' }, parent: { kind: 'remote-node', id: root.nodeId } } });
    expect(stepsOf(plan, 'local', 'remove')).toHaveLength(1);
    expect(stepsOf(plan, 'local', 'remove')[0]).toMatchObject({ target: { nativeId: 'n-local' } });
    expect(plan.mountBindings).toEqual([expect.objectContaining({ nativeRootId: mountFact.nativeRootId, createStepId: mountCreate?.stepId })]);
  });

  it('fails closed for duplicate IDs, cycles, missing parents, ambiguous identity, and missing parent revisions', () => {
    expect(errorCode(() => buildAdvancedPlan(input({ local: [local('duplicate', mountFact.nativeRootId, 'a'), local('duplicate', mountFact.nativeRootId, 'b')] }))))
      .toBe('advanced_duplicate_id');
    expect(errorCode(() => buildAdvancedPlan(input({ local: [local('a', 'b', 'a'), local('b', 'a', 'b')] }))))
      .toBe('advanced_parent_cycle');
    expect(errorCode(() => buildAdvancedPlan(input({ local: [local('a', 'missing', 'a')] }))))
      .toBe('advanced_parent_missing');
    expect(errorCode(() => buildAdvancedPlan(input({
      local: [local('one', mountFact.nativeRootId, 'Same', 'https://example.test/same'), local('two', mountFact.nativeRootId, 'Same', 'https://example.test/same')],
      remote: [root, mount, remote('r-one', mount.nodeId, 'Same', 'https://example.test/same')],
    })))).toBe('advanced_identity_ambiguous');
    expect(errorCode(() => buildAdvancedPlan(input({
      remote: [root, mount, { ...remote('r-dest', mount.nodeId, 'Dest', undefined, 'folder', 'r-dest-1'),
        childrenRevision: undefined }, remote('r-bookmark', mount.nodeId, 'Bookmark', 'https://example.test/b')],
      local: [local('n-dest', mountFact.nativeRootId, 'Dest'), local('n-bookmark', 'n-dest', 'Bookmark', 'https://example.test/b')],
      mappings: [{ nativeId: 'n-dest', colpId: 'r-dest' }, { nativeId: 'n-bookmark', colpId: 'r-bookmark' }],
    })))).toBe('advanced_parent_revision_missing');
  });

  it('keeps exact structural matches in place without URL identity guessing and returns an immutable checklist', () => {
    const remoteFolder = remote('r-folder', mount.nodeId, 'Folder', undefined, 'folder', 'r-folder-1', 'children-folder-1');
    const remoteBookmark = remote('r-bookmark', remoteFolder.nodeId, 'Exact', 'https://example.test/exact');
    const plan = buildAdvancedPlan(input({
      remote: [root, mount, remoteFolder, remoteBookmark],
      local: [local('n-folder', mountFact.nativeRootId, 'Folder'), local('n-bookmark', 'n-folder', 'Exact', 'https://example.test/exact')],
    }));
    expect(plan.matched).toEqual(expect.arrayContaining([
      { nativeId: 'n-folder', nodeId: 'r-folder' }, { nativeId: 'n-bookmark', nodeId: 'r-bookmark' },
    ]));
    expect(plan.steps).toHaveLength(0);
    expect(plan.checklist).toHaveLength(plan.steps.length);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(Object.isFrozen(plan.checklist)).toBe(true);
    expect(() => (plan.steps as AdvancedStep[]).push(plan.steps[0]!)).toThrow();
    const second = buildAdvancedPlan(input({ confirmationId: 'confirm-2',
      remote: [root, mount, remoteFolder, remoteBookmark],
      local: [local('n-folder', mountFact.nativeRootId, 'Folder'), local('n-bookmark', 'n-folder', 'Exact', 'https://example.test/exact')] }));
    expect(second.planId).not.toBe(plan.planId);
  });
});
