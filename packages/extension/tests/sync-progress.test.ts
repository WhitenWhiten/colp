/**
 * First-sync progress: the projection counts what the first-sync scan counts
 * and what already has a server mapping; the copy says how far along it is,
 * why it is not moving, and what is safe to do meanwhile.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import type { BoundaryNodeClass } from '../src/bookmark-boundary.js';
import type { NormalizedBookmarkNode } from '../src/chrome-bookmark-tree.js';
import { validSyncProgressRequest } from '../src/sw/messages.js';
import { projectSyncProgress, type SyncProgressFacts } from '../src/sync-progress.js';
import { describeSyncProgress, paintSyncBar, syncProgressState } from '../src/sync-progress-ui.js';
import { projectSyncStatus } from '../src/sync-status.js';
import type { PublicSyncProgress } from '../src/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function node(nativeId: string, kind: 'folder' | 'bookmark', children: NormalizedBookmarkNode[] = []): NormalizedBookmarkNode {
  return { nativeId, title: nativeId, kind, managed: false, children, ...(kind === 'bookmark' ? { url: `https://${nativeId}.example` } : {}) };
}

// bar (special root) > design (folder, synced) > a, b ; bar > c ; other (out of boundary) > d
const tree = [node('bar', 'folder', [node('design', 'folder', [node('a', 'bookmark'), node('b', 'bookmark')]), node('c', 'bookmark')]),
  node('other', 'folder', [node('d', 'bookmark')])];
const classes = new Map<string, BoundaryNodeClass>([
  ['bar', 'special-root'], ['design', 'ordinary-folder'], ['a', 'ordinary-folder'], ['b', 'ordinary-folder'],
  ['c', 'ordinary-folder'], ['other', 'out-of-boundary'], ['d', 'out-of-boundary'],
]);

function facts(overrides: Partial<SyncProgressFacts> = {}): SyncProgressFacts {
  return { firstRun: 'completed', roots: tree, classifications: classes, mappedNativeIds: new Set(), liveWork: true, ...overrides };
}

function progress(overrides: Partial<PublicSyncProgress> = {}): PublicSyncProgress {
  return { stage: 'syncing', firstSync: true, liveWork: true, bookmarks: { synced: 1240, total: 5312 },
    folders: { synced: 38, total: 214 }, ...overrides };
}

describe('projectSyncProgress', () => {
  test('counts in-boundary bookmarks and folders, and the ones with a server mapping', () => {
    const result = projectSyncProgress(facts({ mappedNativeIds: new Set(['bar', 'design', 'a', 'd']) }));
    assert.deepEqual(result, { stage: 'syncing', firstSync: false, liveWork: true,
      bookmarks: { synced: 1, total: 3 }, folders: { synced: 2, total: 2 } });
  });

  test('is done once every counted item is mapped, and reports nothing before sync is set up', () => {
    assert.equal(projectSyncProgress(facts({ mappedNativeIds: new Set(['bar', 'design', 'a', 'b', 'c']) }))?.stage, 'done');
    assert.equal(projectSyncProgress(facts({ firstRun: 'none' })), null);
    assert.equal(projectSyncProgress(facts({ firstRun: 'deferred' })), null);
  });

  test('a bootstrap still comparing the trees is preparing, and a running one is the first sync', () => {
    assert.equal(projectSyncProgress(facts({ firstRun: 'running', runPhase: 'matching' }))?.stage, 'preparing');
    assert.equal(projectSyncProgress(facts({ firstRun: 'running', runPhase: 'syncing' }))?.firstSync, true);
    assert.equal(projectSyncProgress(facts({ runPhase: 'completed' }))?.firstSync, false);
  });
});

describe('describeSyncProgress', () => {
  test('shows counts, a value, and what is safe to do while the first sync runs', () => {
    const view = describeSyncProgress(progress());
    assert.equal(view.show, true);
    assert.equal(view.title, 'First sync in progress');
    assert.equal(view.detail, '1,240 of 5,312 bookmarks synced · 38 of 214 folders');
    assert.equal(view.short, 'Syncing 1,278 of 5,526');
    assert.ok(Math.abs(view.value - 1278 / 5526) < 1e-9);
    assert.equal(view.note, undefined);
    assert.equal(view.guidance.length, 3);
    assert.match(view.guidance.join(' '), /close this page/u);
    assert.match(view.guidance.join(' '), /don’t sign out, disconnect, or change which folders sync/u);
  });

  test('says why the bar is not moving', () => {
    assert.match(describeSyncProgress(progress(), projectSyncStatus('waiting-network')).note ?? '', /Waiting for the network/u);
    assert.match(describeSyncProgress(progress(), projectSyncStatus('paused')).note ?? '', /until you resume/u);
    assert.match(describeSyncProgress(progress({ firstSync: false, liveWork: false })).note ?? '', /haven’t been uploaded/u);
    assert.equal(describeSyncProgress(progress(), projectSyncStatus('syncing')).note, undefined);
  });

  test('a paused sync says it is paused and stops looking busy', () => {
    const paused = describeSyncProgress(progress(), projectSyncStatus('paused'));
    assert.equal(paused.paused, true);
    assert.equal(paused.title, 'First sync paused');
    assert.equal(paused.detail, '1,240 of 5,312 bookmarks synced · 38 of 214 folders');
    assert.equal(paused.short, 'Paused at 1,278 of 5,526');
    assert.deepEqual(paused.guidance, []);
    assert.equal(syncProgressState(paused), 'paused');
    assert.equal(describeSyncProgress(progress({ firstSync: false }), projectSyncStatus('paused')).title, 'Sync paused');
    // Paused before it had a count: no sliding bar either.
    const preparing = describeSyncProgress(progress({ stage: 'preparing' }), projectSyncStatus('paused'));
    assert.equal(preparing.indeterminate, false);
    assert.equal(preparing.title, 'First sync paused');
    assert.equal(preparing.short, 'Sync paused');
  });

  test('every bar moves only while the count can move', () => {
    const bar = () => { const attributes = new Map<string, string>();
      return { dataset: {} as Record<string, string>, style: { setProperty: () => undefined },
        setAttribute: (name: string, value: string) => attributes.set(name, value), removeAttribute: (name: string) => attributes.delete(name) }; };
    const paint = (view: ReturnType<typeof describeSyncProgress>) => { const target = bar(); paintSyncBar(target as never, view); return target.dataset.state; };
    assert.equal(paint(describeSyncProgress(progress())), 'running');
    assert.equal(paint(describeSyncProgress(progress({ stage: 'preparing' }))), 'indeterminate');
    assert.equal(paint(describeSyncProgress(progress(), projectSyncStatus('paused'))), 'paused');
    assert.equal(paint(describeSyncProgress(progress({ stage: 'preparing' }), projectSyncStatus('paused'))), 'paused');
    assert.equal(paint(describeSyncProgress(progress({ stage: 'preparing' }), projectSyncStatus('waiting-network'))), 'stalled');
  });

  test('stays hidden once personal sync is disconnected', () => {
    assert.equal(describeSyncProgress(progress(), projectSyncStatus('local-only')).show, false);
  });

  test('runs without a value while preparing, and ends on Sync complete only when watched', () => {
    const preparing = describeSyncProgress(progress({ stage: 'preparing' }));
    assert.equal(preparing.indeterminate, true);
    assert.equal(preparing.title, 'Preparing your first sync');
    const done = progress({ stage: 'done', bookmarks: { synced: 5312, total: 5312 }, folders: { synced: 214, total: 214 } });
    assert.equal(describeSyncProgress(done).show, false);
    const shown = describeSyncProgress(done, undefined, { showDone: true });
    assert.equal(shown.done, true);
    assert.equal(shown.detail, 'All 5,312 bookmarks are synced.');
    assert.equal(describeSyncProgress(null).show, false);
  });
});

describe('known.sync.progress.get', () => {
  test('is parameterless', () => {
    assert.equal(validSyncProgressRequest({ kind: 'known.sync.progress.get' }), true);
    assert.equal(validSyncProgressRequest({ kind: 'known.sync.progress.get', scope: 'x' }), false);
    assert.equal(validSyncProgressRequest([]), false);
  });

  test('is routed by the worker and painted by both pages', async () => {
    const worker = await readFile(resolve(root, 'src/service-worker.ts'), 'utf8');
    assert.match(worker, /validSyncProgressRequest\(message\)/u);
    assert.match(await readFile(resolve(root, 'options.html'), 'utf8'), /id="sync-progress"/u);
    assert.match(await readFile(resolve(root, 'popup.html'), 'utf8'), /id="sync-progress-strip"/u);
  });
});
