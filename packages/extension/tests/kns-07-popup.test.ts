/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  commitSaveFolder, FOLDER_DEFAULT_BINDING, FOLDER_ONCE_BINDING, folderIsInMount,
  parseFolderBinding, rememberSaveFolder, resolveSaveFolder,
} from '../src/save-folder.js';
import { buildFolderRows } from '../src/folder-tree-model.js';
import { NATIVE_SAVE_INGRESS, savePagesThroughNativeIngress } from '../src/save-entry.js';
import { FIRST_RUN_SYNC_RETRYING, popupFirstRunStatus } from '../src/first-run-draft.js';
import {
  FIRST_RUN_ACTION_REQUIRED, FIRST_RUN_LOCAL_ONLY, FIRST_RUN_NEEDS_ATTENTION,
  FIRST_RUN_REVIEW_CONFLICTS, FIRST_RUN_SYNCED, FIRST_RUN_SYNCING, FIRST_RUN_UNSYNCED,
  FIRST_RUN_WAIT_NETWORK, parseLastSave, projectSaveStatus, SAVE_SAVED_TO_BROWSER, type SaveStatusFacts,
} from '../src/save-status.js';
import { ICON_POLICY_DISABLED_COPY, ICON_POLICY_UNREACHABLE_COPY } from '../src/icon-policy-feedback.js';
import { collectSaveStatusFacts, type SaveStatusStore } from '../src/save-status-facts.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';
import type { BookmarkEventRecord, QueueOperation, SyncScope } from '../src/sync-state/types.js';

const packageRoot = resolve(import.meta.dirname, '..');
const scope: SyncScope = {
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
};

async function readFrom(relativePath: string): Promise<string> {
  return readFile(resolve(packageRoot, relativePath), 'utf8');
}

function baseFacts(overrides: Partial<SaveStatusFacts> = {}): SaveStatusFacts {
  return {
    paint: 'projected', localCreateSucceeded: true, inSyncRange: true, firstRunIncomplete: false,
    online: true, pendingWork: false, needsAttention: false, hasAuthoritativeReceipt: false,
    hasApplyEvidence: false, ...overrides,
  };
}

function fakeStore(input: {
  readonly firstRun?: string;
  readonly mapping?: { colpId: string; projection: { revision: string } } | null;
  readonly events?: BookmarkEventRecord[];
  readonly queue?: Record<string, QueueOperation>;
  readonly intents?: { nativeId?: string; observedNativeId?: string; state: string }[];
  readonly phase?: string;
  readonly bootstrapPhase?: string;
}): SaveStatusStore {
  return {
    async getScope() { return { firstRun: input.firstRun ?? 'completed' }; },
    async getMappingByNativeId() { return input.mapping ?? null; },
    async listBookmarkEvents() { return input.events ?? []; },
    async getQueueByOpId(_scope, opId) { return input.queue?.[opId] ?? null; },
    async listProjectionIntents() { return input.intents ?? []; },
    async getEngineState() { return input.phase ? { phase: input.phase } : null; },
    async listBootstrapRuns() {
      return input.bootstrapPhase
        ? [{ phase: input.bootstrapPhase, updatedAt: 1 }] : [];
    },
  };
}

function queueRow(opId: string, status: QueueOperation['status'], recovery?: { code: string }): QueueOperation {
  return {
    scopeKey: 'scope', sequence: 1, opId, batchId: `batch-${opId}`, idempotencyKey: opId,
    digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: null, operationRevision: 'local-1', status, retry: { attempt: 0, notBefore: 0 },
    ...(recovery ? { recovery } : {}),
    payload: { type: 'create_node' },
  };
}

describe('KNS-07 popup save status selector', () => {
  test('first paint after local create is Saved to this browser', () => {
    assert.equal(projectSaveStatus(baseFacts({ paint: 'local', pendingWork: true })), "saved-locally");
    assert.equal(SAVE_SAVED_TO_BROWSER, 'Saved to this browser');
    assert.equal(ICON_POLICY_DISABLED_COPY, 'Automatic icons are off for new bookmarks.');
    assert.equal(ICON_POLICY_UNREACHABLE_COPY, 'The icon will be added when you are back online.');
  });

  test('local-only and unfinished first-run never show Synced', () => {
    assert.equal(projectSaveStatus(baseFacts({
      inSyncRange: false, hasAuthoritativeReceipt: true, hasApplyEvidence: true,
    })), "local-only");
    assert.equal(projectSaveStatus(baseFacts({
      firstRunIncomplete: true, hasAuthoritativeReceipt: true, hasApplyEvidence: true,
    })), "setup-required");
    assert.notEqual(projectSaveStatus(baseFacts({ inSyncRange: false })), "synced");
    assert.equal(FIRST_RUN_LOCAL_ONLY, 'No Know-N sync');
    assert.equal(FIRST_RUN_UNSYNCED, 'Sync is off');
  });

  test('does not show Synced before an authoritative receipt or apply evidence', () => {
    assert.equal(projectSaveStatus(baseFacts({ pendingWork: true })), "syncing");
    assert.equal(projectSaveStatus(baseFacts({
      pendingWork: false, hasAuthoritativeReceipt: false, hasApplyEvidence: false,
    })), "syncing");
    assert.equal(projectSaveStatus(baseFacts({
      hasAuthoritativeReceipt: true, pendingWork: false,
    })), "synced");
    assert.equal(FIRST_RUN_SYNCED, 'Synced');
    assert.equal(FIRST_RUN_SYNCING, 'Syncing');
    assert.equal(popupFirstRunStatus({
      connected: true, firstRun: 'running', deferredDraft: false,
      engine: { phase: 'idle', hasPendingWork: false },
    }), "syncing");
    assert.notEqual(popupFirstRunStatus({
      connected: true, firstRun: 'running', deferredDraft: false,
      engine: { phase: 'idle', hasPendingWork: false },
    }), "synced");
  });

  test('reopen projection keeps pending and needs_attention from persisted facts', () => {
    const pending = baseFacts({ paint: 'projected', pendingWork: true });
    const attention = baseFacts({ paint: 'projected', needsAttention: true, pendingWork: true });
    assert.equal(projectSaveStatus(pending), "syncing");
    assert.equal(projectSaveStatus(pending), projectSaveStatus({ ...pending }));
    assert.equal(projectSaveStatus(attention), "action-required");
    assert.equal(projectSaveStatus(attention), projectSaveStatus({ ...attention }));
    assert.equal(FIRST_RUN_ACTION_REQUIRED, 'Action required');
    assert.equal(projectSaveStatus(baseFacts({ online: false, pendingWork: true })), "waiting-network");
    assert.equal(FIRST_RUN_WAIT_NETWORK, 'Waiting for network');
  });

  test('only a transport failure reads as a network wait', () => {
    // The engine parks every retried failure in its offline phase.
    const label = (errorCode?: string) => popupFirstRunStatus({
      connected: true, firstRun: 'completed', deferredDraft: false,
      engine: { phase: 'offline', hasPendingWork: false, ...(errorCode ? { errorCode } : {}) },
    });
    assert.equal(label('network_unavailable'), "waiting-network");
    assert.equal(label(), "waiting-network");
    assert.equal(label('pull_failed'), "retrying");
    assert.equal(label('session_authority_invalid'), "retrying");
    assert.equal(FIRST_RUN_SYNC_RETRYING, 'Sync error, retrying');
  });

  test('favicon enhancement failure does not become a sync failure', () => {
    assert.equal(projectSaveStatus(baseFacts({
      hasAuthoritativeReceipt: true, enhancementFailed: true,
    })), "synced");
    assert.notEqual(projectSaveStatus(baseFacts({
      paint: 'local', enhancementFailed: true, pendingWork: true,
    })), "action-required");
  });

  test('last-save cache round-trips native id and local-only for reopen', () => {
    const parsed = parseLastSave({
      nativeId: 'bm-1', parentNativeId: 'folder-1', localOnly: false, collectionId: 'col-1', updatedAt: 10,
    });
    assert.equal(parsed?.nativeId, 'bm-1');
    assert.equal(parsed?.localOnly, false);
    assert.equal(parseLastSave({ nativeId: 'bm-1', localOnly: true }), undefined);
  });
});

describe('KNS-07 collector reads run/queue/receipt/apply facts', () => {
  test('pending mapping without receipt is not Synced; rebound mapping with terminal queue is', async () => {
    const pendingEvent: BookmarkEventRecord = {
      scopeKey: 'scope', ordinal: 1, status: 'pending', eventId: 'e1', dedupeKey: 'd1', opId: null,
      occurredAt: '2026-09-06T00:00:00Z', kind: 'create', nativeId: 'bm-1', details: {},
    };
    const pending = await collectSaveStatusFacts({
      store: fakeStore({
        mapping: { colpId: 'pending-op-1', projection: { revision: 'local-1' } },
        events: [pendingEvent],
      }),
      scope, nativeId: 'bm-1', inSyncRange: true, paint: 'projected', localCreateSucceeded: true, online: true,
    });
    assert.equal(projectSaveStatus(pending), "syncing");
    assert.equal(pending.hasAuthoritativeReceipt, false);

    const processed: BookmarkEventRecord = { ...pendingEvent, status: 'processed', opId: 'op-1' };
    const synced = await collectSaveStatusFacts({
      store: fakeStore({
        mapping: { colpId: 'node-1', projection: { revision: 'r-1' } },
        events: [processed],
        queue: { 'op-1': queueRow('op-1', 'terminal') },
      }),
      scope, nativeId: 'bm-1', inSyncRange: true, paint: 'projected', localCreateSucceeded: true, online: true,
    });
    assert.equal(projectSaveStatus(synced), "synced");
    assert.equal(synced.hasAuthoritativeReceipt, true);

    const conflicted = await collectSaveStatusFacts({
      store: fakeStore({
        mapping: { colpId: 'pending-op-2', projection: { revision: 'local-1' } },
        events: [{ ...processed, opId: 'op-2' }],
        queue: { 'op-2': queueRow('op-2', 'blocked', { code: 'conflict_pending' }) },
      }),
      scope, nativeId: 'bm-1', inSyncRange: true, paint: 'projected', localCreateSucceeded: true, online: true,
    });
    assert.equal(projectSaveStatus(conflicted), "review-conflicts");
  });
});

describe('KNS-07 default vs one-off folder and native folder order', () => {
  test('lists folders in native order and marks mount descendants as synced without reordering', () => {
    const tree = [{
      id: '0', title: '', children: [
        { id: 'bar', title: '收藏夹栏', folderType: 'bookmarks-bar', children: [{ id: 'research', title: '研究资料', children: [] }] },
        { id: 'other', title: '其他收藏夹', folderType: 'other', children: [{ id: 'scratch', title: '草稿', children: [] }] },
      ],
    }];
    const rows = buildFolderRows(tree, { mounts: new Set(['other']), excluded: new Set() });
    // The invisible root holds no bookmarks, so it is never a pickable row.
    assert.deepEqual(rows.map((row) => [row.id, row.depth, row.synced]),
      [['bar', 0, false], ['research', 1, false], ['other', 0, true], ['scratch', 1, true]]);
    assert.deepEqual(buildFolderRows(tree, { mounts: new Set(), excluded: new Set(['bar']) }).map((row) => row.id),
      ['other', 'scratch']);
    assert.equal(folderIsInMount('research', ['bar', '0'], new Set(['bar'])), true);
    assert.equal(folderIsInMount('scratch', ['other', '0'], new Set(['bar'])), false);
  });

  test('resolves one-off separately from the in-range default', () => {
    const resolved = resolveSaveFolder({
      once: { collectionId: 'col', folderNativeId: 'scratch' },
      fallback: { collectionId: 'col', folderNativeId: 'research' }, collectionId: 'col', mountNativeIds: new Set(['bar']),
    });
    assert.deepEqual(resolved, { folderNativeId: 'scratch', oneOff: true });
    const def = resolveSaveFolder({
      fallback: { collectionId: 'col', folderNativeId: 'research' }, collectionId: 'col', mountNativeIds: new Set(['bar']),
      fallbackAncestors: ['bar'],
    });
    assert.deepEqual(def, { folderNativeId: 'research', oneOff: false });
    assert.equal(FOLDER_DEFAULT_BINDING, 'known.sync.folder.v1');
    assert.equal(FOLDER_ONCE_BINDING, 'known.sync.folder.once.v1');
    assert.equal(parseFolderBinding({ collectionId: 'col', folderNativeId: 'x' })?.folderNativeId, 'x');
  });

  test('an out-of-range folder saves without a prompt; sync is passive status and never changes topology', async () => {
    const ui = await readFrom('src/save-folder-ui.ts');
    const popup = await readFrom('src/popup.ts');
    const note = await readFrom('src/popup-dest-sync.ts');
    assert.doesNotMatch(`${ui}\n${popup}`, /rangePrompt|pendingOutOfRange|acceptLocalOnly/);
    assert.match(note, /This folder stays on this browser/);
    assert.match(note, /options\.html#sync\/folders\?native=/);
    assert.doesNotMatch(note, /requestSave/); // changing sync coverage never saves implicitly
    // Settings links only navigate: the popup never rebinds scope or edits the sync range.
    assert.doesNotMatch(`${ui}\n${popup}\n${note}`, /known\.roots\.update|known\.scope\.rejoin|known\.scope\.detach/);
    // Saving never rebinds a collection or waits for a cloud session mint.
    assert.doesNotMatch(popup, /known\.collection\.select|bindCollectionForSave/);
    assert.doesNotMatch(popup, /allocateSequenceAndEnqueue|createOutboundPushWorker/);
    void rememberSaveFolder; void commitSaveFolder;
  });
});

describe('KNS-07 native entry points share KNS-04 ingress', () => {
  test('popup, context menu, shortcut and window tabs create native bookmarks only', async () => {
    const popup = await readFrom('src/popup.ts');
    const entry = await readFrom('src/save-entry.ts');
    const native = await readFrom('src/sw/save-entry.ts');
    const runner = await readFrom('src/save-native.ts');
    const manager = await readFrom('src/bookmark-manager.ts');
    const manifest = await readFrom('manifest.base.json');
    const worker = await readServiceWorkerGraph();
    assert.equal(NATIVE_SAVE_INGRESS, 'chrome.bookmarks.create');
    assert.match(manifest, /contextMenus/);
    assert.match(manifest, /save-window-tabs/);
    assert.match(entry, /saveBookmarkWithFaviconCapture/);
    assert.match(popup, /savePopupNativePage/);
    assert.match(await readFrom('src/popup-native-save.ts'), /known\.capture\.start/);
    assert.match(await readFrom('src/sw/capture-native.ts'), /savePagesThroughNativeIngress/);
    assert.match(runner, /savePagesThroughNativeIngress/);
    assert.match(native, /runNativeSave/);
    assert.match(native, /saveThroughNativeEntry/);
    assert.match(native, /commands\.onCommand/);
    assert.match(native, /contextMenus/);
    assert.match(native, /save-window-tabs|SAVE_WINDOW_COMMAND/);
    assert.match(worker, /known\.save\.native/);
    // The row module owns the right-click menu; the page binds its Delete/F2/menu keys on the list.
    assert.match(await readFrom('src/bookmark-manager-rows.ts'), /addEventListener\('contextmenu'/);
    assert.match(manager, /\bcreateManagerNode\(/);
    assert.match(await readFrom('src/bookmark-manager-create.ts'), /api\.create/);
    assert.match(worker, /installNativeSaveEntries/);
    assert.match(worker, /known\.save\.status/);
    assert.match(worker, /saveThroughNativeEntry\(message\.entry\)/);
    assert.doesNotMatch(native, /if \(!await hasBookmarkPermission\(\)\) return;/);
    assert.match(runner, /presentSaveFeedback/);
    assert.match(runner, /resolveInRangeSaveParent/);
    assert.doesNotMatch(`${popup}\n${entry}\n${native}\n${runner}`, /allocateSequenceAndEnqueue|createOutboundPushWorker|settleClaimedPush/);
    const saved = await savePagesThroughNativeIngress({
      pages: [{ title: 'Page', url: 'https://example.test/a' }],
      parentNativeId: 'folder-1', collectionId: 'col-1',
      bookmarks: { create: async (bookmark) => ({ id: 'bm-created', title: String(bookmark.title ?? ''), url: bookmark.url }) },
      sidecar: { close() { /* test double */ }, put: async () => undefined } as never,
    });
    assert.equal(saved[0]?.nativeId, 'bm-created');
  });

  test('locks user-visible status words and known.save.status contract', async () => {
    const types = await readFrom('src/types.ts');
    const html = await readFrom('popup.html');
    assert.match(types, /known\.save\.status/);
    // The save lane's facts share the popup's one note line (and the status line says where a save went).
    assert.match(html, /id="pp-note"/);
    assert.match(html, /id="capture-status"/);
    // No blocking out-of-range question on the save lane.
    assert.doesNotMatch(html, /local-only-prompt|Keep on this device|Open folder sync settings/);
    for (const word of ['Replica', 'Sequence', 'Tombstone', 'bootstrapMode']) {
      assert.doesNotMatch(await readFrom('src/save-status.ts'), new RegExp(word));
    }
  });
});
