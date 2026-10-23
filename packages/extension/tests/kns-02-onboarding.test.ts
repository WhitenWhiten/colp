/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { countFolderContents } from '../src/bookmark-boundary.js';
import {
  FIRST_RUN_ENGINE_NOT_READY, FIRST_RUN_INTRO, FIRST_RUN_KEEP_COPY,
  FIRST_RUN_LATER, FIRST_RUN_LIBRARY_REQUIRED, FIRST_RUN_MERGE_COPY, FIRST_RUN_PERMISSION_ACTION,
  FIRST_RUN_PERMISSION_HINT, FIRST_RUN_START, FIRST_RUN_UNSYNCED,
  buildFirstRunConfirm, canStartFirstSync, collectPreviewSelection, confirmFailureCopy,
  firstRunIncomplete, firstRunOnboardingActive, folderCountCopy, parseFirstRunDraft, popupFirstRunStatus,
  restoreDraftSelection, shouldDefaultPreselect,
} from '../src/first-run-draft.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import type { PublicRootView } from '../src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readFromPackage(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8');
}

const viewOf = (roots: PublicRootView['roots']): PublicRootView => ({ viewId: 'view-1', status: 'ready', roots });

function node(partial: Partial<PublicRootView['roots'][number]> & Pick<PublicRootView['roots'][number], 'ref' | 'kind'>):
  PublicRootView['roots'][number] {
  return {
    title: partial.title ?? partial.kind, depth: partial.depth ?? 0, selected: partial.selected ?? false,
    privateLocal: false, managed: partial.managed ?? false, bookmarkCount: partial.bookmarkCount ?? 0,
    folderCount: partial.folderCount ?? 0, ...partial,
  };
}

describe('KNS-02 first-run copy and preview model', () => {
  test('locks product first-run copy and forbids protocol jargon', async () => {
    assert.equal(FIRST_RUN_INTRO, 'Choose folders to sync. You can select a subfolder without selecting its parent.');
    assert.equal(FIRST_RUN_PERMISSION_ACTION, 'Allow bookmark access');
    assert.equal(FIRST_RUN_PERMISSION_HINT, 'Allow bookmark access, then choose which folders to sync.');
    assert.equal(FIRST_RUN_START, 'Start first sync');
    assert.equal(FIRST_RUN_LATER, 'Later');
    assert.match(FIRST_RUN_MERGE_COPY, /browser and in your library/);
    assert.match(FIRST_RUN_KEEP_COPY, /are not deleted/);
    assert.equal(FIRST_RUN_UNSYNCED, 'Sync is off');
    assert.equal(FIRST_RUN_ENGINE_NOT_READY, 'Sync is not ready yet');
    assert.equal(FIRST_RUN_LIBRARY_REQUIRED, 'Connecting to your bookmark library…');
    const copy = await readFromPackage('src/first-run-draft.ts');
    for (const word of ['Replica', 'Sequence', 'Tombstone', 'bootstrapMode', 'folderRole', 'native mapping']) {
      assert.doesNotMatch(copy, new RegExp(word));
    }
  });

  test('default-preselects every editable browser root, including empty roots', () => {
    assert.equal(shouldDefaultPreselect({
      managed: false, depth: 0, bookmarkCount: 2, folderCount: 1, firstRun: 'none', hasCommittedSelection: false,
    }), true);
    assert.equal(shouldDefaultPreselect({
      managed: false, depth: 0, bookmarkCount: 0, folderCount: 0, firstRun: 'none', hasCommittedSelection: false,
    }), true);
    assert.equal(shouldDefaultPreselect({
      managed: true, depth: 0, bookmarkCount: 4, folderCount: 1, firstRun: 'none', hasCommittedSelection: false,
    }), false);
    assert.equal(shouldDefaultPreselect({
      managed: false, depth: 0, bookmarkCount: 4, folderCount: 0, firstRun: 'completed', hasCommittedSelection: false,
    }), false);
    assert.equal(shouldDefaultPreselect({
      managed: false, depth: 0, bookmarkCount: 4, folderCount: 1, firstRun: 'running', hasCommittedSelection: false,
    }), false);
  });

  test('onboarding chrome stays active while first-run is running; incomplete still treats running as committed', () => {
    assert.equal(firstRunOnboardingActive('running'), true);
    assert.equal(firstRunOnboardingActive('completed'), false);
    assert.equal(firstRunOnboardingActive('none'), true);
    assert.equal(firstRunOnboardingActive('deferred'), true);
    assert.equal(firstRunOnboardingActive(undefined), true);
    assert.equal(firstRunIncomplete('running'), false);
    assert.equal(firstRunIncomplete('completed'), false);
    assert.equal(firstRunIncomplete('none'), true);
  });

  test('counts folder contents for the root view and keeps managed exclusion copy', () => {
    const tree = {
      kind: 'folder', children: [
        { kind: 'bookmark', children: [] },
        { kind: 'folder', children: [{ kind: 'bookmark', children: [] }] },
      ],
    };
    assert.deepEqual(countFolderContents(tree), { bookmarkCount: 2, folderCount: 1 });
    assert.equal(folderCountCopy({ bookmarkCount: 28, folderCount: 6, managed: false }), '28 bookmarks · 6 folders');
    assert.equal(folderCountCopy({ bookmarkCount: 1, folderCount: 1, managed: false }), '1 bookmark · 1 folder');
    assert.match(folderCountCopy({ bookmarkCount: 0, folderCount: 0, managed: true }), /Managed by browser policy/);
  });

  test('preview selection sends checked refs and lets descendants inherit', () => {
    const tree = viewOf([
      node({ ref: 'bar', kind: 'bookmarks_bar', depth: 0, bookmarkCount: 2, folderCount: 1 }),
      node({ ref: 'research', kind: 'folder', depth: 1, title: '研究', bookmarkCount: 1 }),
      node({ ref: 'managed', kind: 'folder', depth: 0, managed: true, exclusionReason: 'managed', bookmarkCount: 3 }),
    ]);
    assert.deepEqual(collectPreviewSelection(tree, new Set(['bar', 'managed'])), {
      selectedRefs: ['bar'], excludedRefs: [],
    });
  });

  test('restores a later draft by stable folder identity', () => {
    const tree = viewOf([
      node({ ref: 'new-bar', kind: 'bookmarks_bar', title: '收藏夹栏', depth: 0, bookmarkCount: 2 }),
      node({ ref: 'new-other', kind: 'other', title: '其他收藏夹', depth: 0, bookmarkCount: 1 }),
    ]);
    const selected = restoreDraftSelection(tree, {
      deferred: true,
      selected: [{ ref: 'new-bar', kind: 'bookmarks_bar', title: '收藏夹栏', depth: 0 }],
    });
    assert.deepEqual([...selected], ['new-bar']);
    assert.equal(parseFirstRunDraft({ deferred: true, selected: [{ ref: 'new-other', kind: 'other', title: '其他收藏夹', depth: 0 }] })
      ?.deferred, true);
    assert.equal(parseFirstRunDraft({ deferred: true, selected: [{ kind: 'nope', title: 'x', depth: 0 }] }), undefined);
  });

  test('an explicitly cleared draft stays empty instead of restoring the default roots', () => {
    const tree = viewOf([node({ ref: 'bar', kind: 'bookmarks_bar', selected: true })]);
    assert.deepEqual([...restoreDraftSelection(tree, { deferred: false, selected: [] })], []);
    assert.deepEqual([...restoreDraftSelection(tree, undefined)], ['bar']);
  });

  test('confirm requires a real library id and never treats a draft title as created', () => {
    const preview = {
      ok: true as const, previewId: 'p1', boundaryVersion: '1', treeDigest: 'sha256:abc',
      bookmarkCount: 4, folderCount: 1, skippedCount: 0, warnings: [],
    };
    const tree = viewOf([node({ ref: 'bar', kind: 'bookmarks_bar', selected: true, bookmarkCount: 4, folderCount: 1 })]);
    assert.equal(canStartFirstSync({ libraryId: undefined, preview, view: tree, selectedCount: 1 }), false);
    assert.equal(canStartFirstSync({ libraryId: 'lib-1', preview, view: tree, selectedCount: 1 }), true);
    const confirm = buildFirstRunConfirm({ previewId: 'p1', libraryId: 'lib-1', confirmationId: 'c1' });
    assert.equal(confirm.kind, 'known.firstRun.confirm');
    assert.equal(confirm.libraryId, 'lib-1');
  });

  test('popup never shows Synced when first-run is deferred or unfinished', () => {
    assert.equal(popupFirstRunStatus({ connected: true, firstRun: 'deferred', deferredDraft: true }), "setup-required");
    assert.equal(popupFirstRunStatus({ connected: true, firstRun: 'none', deferredDraft: false }), "setup-required");
    assert.notEqual(popupFirstRunStatus({ connected: true, firstRun: 'none', deferredDraft: false }), "synced");
    assert.equal(popupFirstRunStatus({
      connected: true, firstRun: 'completed', deferredDraft: false,
      engine: { phase: 'idle', hasPendingWork: false },
    }), "synced");
    assert.equal(popupFirstRunStatus({
      connected: true, firstRun: 'running', deferredDraft: false,
      engine: { phase: 'idle', hasPendingWork: false },
    }), "syncing");
    assert.notEqual(popupFirstRunStatus({
      connected: true, firstRun: 'running', deferredDraft: false,
      engine: { phase: 'idle', hasPendingWork: false },
    }), "synced");
    assert.equal(confirmFailureCopy({ ok: false, error: 'not_implemented' }), FIRST_RUN_ENGINE_NOT_READY);
  });
});

describe('KNS-02 collection filter and later persistence', () => {
  test('later writes sync_scopes.firstRun deferred without activating mounts', async () => {
    const indexedDB = new IDBFactory();
    const store = createSyncStateStore({ indexedDB });
    const scope: SyncScope = {
      environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
      accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
      replicaId: 'replica-a', generation: 1,
    };
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [],
    });
    await store.setFirstRun(scope, 'deferred');
    const recorded = await store.getScope(scope);
    assert.equal(recorded?.firstRun, 'deferred');
    assert.deepEqual(recorded?.selectedRoots, []);
    assert.equal((await store.listMountBindings(scope)).length, 0);
  });
});

describe('KNS-02 UI wiring and confirm-before-upload', () => {
  test('options markup includes first-run copy, permission, later and start', async () => {
    const options = await readFromPackage('options.html');
    for (const marker of ['welcome-copy', 'first-run-confirm', 'first-run-start', 'first-run-later',
      'first-run-merge-copy', 'first-run-permission-hint', 'request-bookmark-permission',
      'first-run-view-attention',
      'first-run-attention-list']) {
      assert.match(options, new RegExp(`id="${marker}"`));
    }
    assert.match(options, /No account needed/);
    assert.match(options, /Start first sync/);
    assert.match(options, /id="first-run-later"/);
    assert.match(options, /Allow bookmark access/);
    assert.match(options, /Allow bookmark access, then choose which folders to sync\./);
  });

  test('PublicRootNode carries counts and managed exclusion without native ids', async () => {
    const types = await readFromPackage('src/types.ts');
    const slice = types.slice(types.indexOf('export interface PublicRootNode'),
      types.indexOf('export type ExtensionRequest'));
    assert.match(slice, /bookmarkCount: number/);
    assert.match(slice, /folderCount: number/);
    assert.match(slice, /exclusionReason\?: 'managed'/);
    assert.doesNotMatch(slice, /nativeId/);
  });

  test('permission-to-confirm path has no Node, Operation, Push or Product collection create', async () => {
    const files = await Promise.all([
      'src/first-run-ui.ts', 'src/first-run-draft.ts', 'src/sw/first-run.ts',
    ].map((file) => readFromPackage(file)));
    const source = files.join('\n');
    assert.match(source, /known\.firstRun\.preview/);
    assert.match(source, /known\.firstRun\.later/);
    assert.match(source, /known\.firstRun\.confirm/);
    assert.doesNotMatch(source, /known\.roots\.update/);
    assert.doesNotMatch(source, /syncPush|create_node|\/api\/v1\/collections/);
    assert.match(await readFromPackage('src/sw/first-run.ts'), /setFirstRun\(scope, 'deferred'\)/);
    assert.match(await readFromPackage('src/service-worker.ts'), /known\.firstRun\.confirm/);
    assert.match(await readFromPackage('src/first-run-ui.ts'), /同步引擎尚未就绪|FIRST_RUN_ENGINE_NOT_READY/);
  });

  test('startFirstRun and hydrate poll first-run status without sending confirm again', async () => {
    const ui = await readFromPackage('src/first-run-ui.ts');
    assert.match(ui, /setInterval\(\(\) => \{ void pollFirstRunStatus\(\); \}, STATUS_POLL_MS\)/);
    const hydrate = ui.slice(ui.indexOf('async function hydrate'), ui.indexOf('function applyRangeChrome'));
    const start = ui.slice(ui.indexOf('async function startFirstRun'), ui.indexOf('async function createLibrary'));
    const pollAt = ui.indexOf('async function pollFirstRunStatus');
    const poll = ui.slice(pollAt, ui.indexOf('async function deferFirstRun'));
    assert.match(hydrate, /pollIfSyncing: true/);
    assert.match(hydrate, /kind: 'known\.firstRun\.status'/);
    assert.match(start, /pollIfSyncing: true/);
    assert.match(poll, /kind: 'known\.firstRun\.status'/);
    assert.doesNotMatch(poll, /known\.firstRun\.confirm|buildFirstRunConfirm/);
    assert.match(start, /buildFirstRunConfirm/);
  });

});
