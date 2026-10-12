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
  FIRST_RUN_CREATE_ACTION, FIRST_RUN_CREATE_HINT, FIRST_RUN_ENGINE_NOT_READY, FIRST_RUN_INTRO, FIRST_RUN_KEEP_COPY,
  FIRST_RUN_LATER, FIRST_RUN_LIBRARY_REQUIRED, FIRST_RUN_MERGE_COPY, FIRST_RUN_PERMISSION_ACTION,
  FIRST_RUN_PERMISSION_HINT, FIRST_RUN_START, FIRST_RUN_SYNCED, FIRST_RUN_SYNCING, FIRST_RUN_UNSYNCED,
  FIRST_RUN_WEBSITE_CREATE, buildFirstRunConfirm, canStartFirstSync, collectPreviewSelection, confirmFailureCopy,
  firstRunIncomplete, firstRunOnboardingActive, folderCountCopy, parseFirstRunDraft, popupFirstRunStatus,
  restoreDraftSelection, shouldDefaultPreselect,
} from '../src/first-run-draft.js';
import { selectPrivateBookmarkLibraries } from '../src/collections-cache.js';
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
    assert.equal(FIRST_RUN_INTRO, "Keep using this browser's bookmarks. Search, organize, and open them in Know-N on every device.");
    assert.equal(FIRST_RUN_PERMISSION_ACTION, 'Allow bookmark access');
    assert.equal(FIRST_RUN_PERMISSION_HINT, 'Read and sync the bookmark folders you choose');
    assert.equal(FIRST_RUN_START, 'Start first sync');
    assert.equal(FIRST_RUN_LATER, 'Later');
    assert.match(FIRST_RUN_MERGE_COPY, /this browser and in Know-N/);
    assert.match(FIRST_RUN_KEEP_COPY, /are not deleted/);
    assert.equal(FIRST_RUN_UNSYNCED, 'Sync is off');
    assert.equal(FIRST_RUN_ENGINE_NOT_READY, 'Sync is not ready yet');
    assert.match(FIRST_RUN_WEBSITE_CREATE, /Know-N website/);
    assert.equal(FIRST_RUN_CREATE_HINT, 'Name the collection this device will sync.');
    assert.equal(FIRST_RUN_CREATE_ACTION, 'Create collection');
    assert.equal(FIRST_RUN_LIBRARY_REQUIRED, 'Create or choose a collection first.');
    const copy = await readFromPackage('src/first-run-draft.ts');
    for (const word of ['Replica', 'Sequence', 'Tombstone', 'bootstrapMode', 'folderRole', 'native mapping']) {
      assert.doesNotMatch(copy, new RegExp(word));
    }
  });

  test('default-preselects editable roots that have content', () => {
    assert.equal(shouldDefaultPreselect({
      managed: false, depth: 0, bookmarkCount: 2, folderCount: 1, firstRun: 'none', hasCommittedSelection: false,
    }), true);
    assert.equal(shouldDefaultPreselect({
      managed: false, depth: 0, bookmarkCount: 0, folderCount: 0, firstRun: 'none', hasCommittedSelection: false,
    }), false);
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

  test('restores a later/cancel draft by kind, title and depth', () => {
    const tree = viewOf([
      node({ ref: 'new-bar', kind: 'bookmarks_bar', title: '收藏夹栏', depth: 0, bookmarkCount: 2 }),
      node({ ref: 'new-other', kind: 'other', title: '其他收藏夹', depth: 0, bookmarkCount: 1 }),
    ]);
    const selected = restoreDraftSelection(tree, {
      deferred: true,
      selected: [{ kind: 'bookmarks_bar', title: '收藏夹栏', depth: 0 }],
    });
    assert.deepEqual([...selected], ['new-bar']);
    assert.equal(parseFirstRunDraft({ deferred: true, selected: [{ kind: 'other', title: '其他收藏夹', depth: 0 }] })
      ?.deferred, true);
    assert.equal(parseFirstRunDraft({ deferred: true, selected: [{ kind: 'nope', title: 'x', depth: 0 }] }), undefined);
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
    assert.equal('libraryDraft' in confirm, false);
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
  test('keeps visibility and only lists private bookmarks libraries', () => {
    const items = [
      { id: 'a', title: 'Private bookmarks', kind: 'bookmarks', visibility: 'private' },
      { id: 'b', title: 'Shared', kind: 'bookmarks', visibility: 'shared' },
      { id: 'c', title: 'Reading', kind: 'reading_path', visibility: 'private' },
      { id: 'd', title: 'Draft-looking', kind: 'bookmarks' },
    ];
    assert.deepEqual(selectPrivateBookmarkLibraries(items).map((item) => item.id), ['a']);
  });

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
      'library-create', 'library-create-title', 'library-create-submit', 'first-run-view-attention',
      'first-run-attention-list']) {
      assert.match(options, new RegExp(`id="${marker}"`));
    }
    assert.match(options, /No account needed/);
    assert.match(options, /Start first sync/);
    assert.match(options, /id="first-run-later"/);
    assert.match(options, /Allow bookmark access/);
    assert.match(options, /Read and sync the bookmark folders you choose/);
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
      'src/first-run-ui.ts', 'src/first-run-draft.ts', 'src/sw/first-run.ts', 'src/sw/first-run-stubs.ts',
    ].map((file) => readFromPackage(file)));
    const source = files.join('\n');
    assert.match(source, /known\.firstRun\.preview/);
    assert.match(source, /known\.firstRun\.later/);
    assert.match(source, /known\.firstRun\.confirm/);
    assert.doesNotMatch(source, /known\.roots\.update/);
    assert.doesNotMatch(source, /syncPush|create_node|\/api\/v1\/collections/);
    const collections = await readFromPackage('src/sw/collections.ts');
    assert.match(collections, /method: 'POST'|postPrivateBookmarkLibrary/);
    assert.match(collections, /colp\/v0\.1\/sync\/collections/);
    assert.doesNotMatch(collections, /\/api\/v1\/collections|syncPush|create_node/);
    assert.match(await readFromPackage('src/sw/first-run.ts'), /setFirstRun\(scope, 'deferred'\)/);
    assert.match(await readFromPackage('src/service-worker.ts'), /known\.firstRun\.confirm/);
    assert.match(await readFromPackage('src/sw/first-run-stubs.ts'), /error: 'not_implemented'/);
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

  test('collections list keeps visibility and filters private bookmarks libraries', async () => {
    const source = `${await readFromPackage('src/sw/collections.ts')}\n${await readFromPackage('src/library-create.ts')}`;
    const cache = await readFromPackage('src/collections-cache.ts');
    assert.match(source, /visibility: record\.visibility/);
    assert.match(source, /selectPrivateBookmarkLibraries/);
    assert.match(cache, /kind === 'bookmarks' && item\.visibility === 'private'/);
    assert.doesNotMatch(source, /kind === 'library'/);
    assert.match(await readFromPackage('src/sync-collections.ts'), /selectPrivateBookmarkLibraries/);
    assert.match(await readFromPackage('src/popup-bound-collection.ts'), /selectPrivateBookmarkLibraries/);
  });
});
