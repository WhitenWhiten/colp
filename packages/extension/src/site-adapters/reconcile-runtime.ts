import { readReconcileData } from './reconcile-storage.js';
import { createReconcileRuns, type ReconcileRun, type ReconcileOperation } from './reconcile-run.js';
import { executeReconcileCommand, prepareReconcileCommand, assertReconcileOwnership, assertReconcileUndoState, type ReconcileReceipt } from './reconcile-executor.js';
import { installReconcileAuthorization } from './reconcile-authorization.js';
import { reconcileKey } from './reconcile-preview.js';
import type { ReconcileDecision, ReconcilePreview } from './reconcile-model.js';
import type { Representation, SourceFolderReservation, NativeBinding } from './contracts.js';
import type { SourcePolicyRecord, SourceMount } from './layout.js';
import type { LedgerEdge } from './ledger-types.js';
import { readConnectionAuthority } from './ledger.js';
import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { get, put, rows, sourceDigest, sourceKey } from './source-db.js';
import { representationKey } from './reservations.js';
import { assertCaptureOwner, assertCaptureScope, currentCaptureScope } from '../sw/capture-native.js';
import { assertSourceRoot, acknowledgePlannedNative } from '../sw/planned-capture.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { array, object, literal, str, jsonBytes } from './schema.js';
import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import type { PlannedNativeCommand } from './planned-types.js';
import { managedReference } from './managed-changes.js';
import { managedDestinations } from './managed-destinations.js';
import { scheduleNativeFoldersFirst } from '../sw/bookmark-folders-first.js';
import { sameNativeContentValue } from '../native-event-correlation.js';
import { reconcileTreeDigest } from './reconcile-inventory.js';
const schedule = () => { chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 1000 }); };
async function authorize(run: ReconcileRun, undo = false) {
  if (undo) { await assertCaptureOwner(run.scope); return; } await assertCaptureScope(run.scope);
  const a = await readConnectionAuthority(siteLedger.db, run.preview.context.connectionId), c = run.preview.context;
  const policy = await siteLedger.db.read<SourcePolicyRecord>('meta', `policy:${c.connectionId}`);
  if (!a?.enabled || a.installationGeneration !== c.installationGeneration || a.sourceSessionGeneration !== c.sourceSessionGeneration
    || !policy?.enabled || policy.policy.revision !== run.preview.policyRevision) throw new Error('sourceAuthorizationChanged');
  if (run.preview.destination && (await assertSourceRoot(run.preview.destination.root)).inRange !== (run.preview.destination.owner !== null)) throw new Error('sourceDestinationChanged');
}
async function parentFor(run: ReconcileRun, op: ReconcileOperation) {
  let nativeId = op.decision.destinationId;
  if (op.decision.choice === 'return' || op.decision.choice === 'restore' || op.decision.choice === 'adopt') {
    // Explicitly restrict the folder lookup to this connection's configured mount.
    const config = await siteLedger.db.read<{ ruleId: string }>('meta', `archiveConfig:${run.preview.context.connectionId}`);
    const mount = config && await siteLedger.db.read<SourceMount>('mounts', sourceKey(run.preview.context.connectionId, config.ruleId));
    const folder = mount && await siteLedger.db.read<SourceFolderReservation>('folderReservations', sourceKey(mount.id, op.difference.collectionId));
    if (op.difference.folder) nativeId = op.difference.folder.locationOverride?.nativeId ?? mount?.root.nativeId;
    else { if (!folder?.native || folder.state !== 'confirmed') throw new Error('sourceBindingNeedsReview'); nativeId = folder.native.nativeId; }
  }
  if (op.decision.choice === 'useLocation') nativeId = op.difference.expected?.parentId;
  if (op.decision.choice === 'updateTitle') nativeId = op.difference.expected?.parentId;
  if (!nativeId) throw new Error('reconcileDestinationRequired');
  const node = (await chrome.bookmarks.get(nativeId))[0]; if (!node || node.url || !node.dateAdded) throw new Error('bindingUnavailable');
  const parent: NativeBinding<'folder'> = { nativeId, dateAdded: node.dateAdded, deviceId: await captureDeviceId(), kind: 'folder', bindingId: op.id,
    proof: { kind: 'explicitAdoption', id: run.id } };
  const target = await assertSourceRoot(parent);
  const originalSynced = run.preview.destination ? run.preview.destination.owner !== null : !!(run.scope.accountId && run.scope.collectionId);
  if (originalSynced !== target.inRange) throw new Error('sourceDestinationChanged');
  if (op.decision.choice === 'move' || op.decision.choice === 'archive') {
    const mounts = (await managedDestinations(siteLedger.db)).filter(m => !m.id.startsWith('history:'));
    let id: string | undefined = nativeId; const seen = new Set<string>();
    while (id) {
      if (mounts.some(m => m.root.nativeId === id) || seen.has(id) || seen.size >= 256) throw new Error('reconcileDestinationMapped');
      seen.add(id); id = (await chrome.bookmarks.get(id))[0]?.parentId;
    }
    if (op.decision.choice === 'archive') {
      if (['0', '1', '2', '3'].includes(nativeId)) throw new Error('reconcileHistoryNeedsFolder');
      const known = await siteLedger.db.read('meta', `reconcileHistory:${nativeId}`);
      if (!known && (await chrome.bookmarks.getChildren(nativeId)).length) throw new Error('reconcileHistoryNeedsFolder');
      if (!known) await siteLedger.db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', `reconcileHistory:${nativeId}`, {
        id: `history:${nativeId}`, connectionId: run.preview.context.connectionId, rootRuleId: run.id, revision: 1, aiDestination: 'excluded', state: 'suppressed', root: parent,
      }));
    }
  }
  return parent;
}
async function currentOperation(run: ReconcileRun, op: ReconcileOperation, undo: boolean) {
  if (undo) return;
  if ((op.difference.source || op.difference.kind === 'sourceRemoved') && Date.now() - run.preview.createdAt > 10 * 60 * 1000) throw new Error('previewStale');
  if (op.difference.itemId && (op.difference.source || op.decision.choice === 'archive')) {
    const baseline = await siteLedger.db.read<{ baselineOrdinal: number }>('importRuns', run.preview.importId);
    if (!baseline) throw new Error('previewStale');
    const edge = await siteLedger.db.read<LedgerEdge>('memberships', sourceKey(run.preview.context.connectionId, op.difference.itemId, op.difference.collectionId));
    if (edge && edge.ordinal > baseline.baselineOrdinal && edge.state !== (op.decision.choice === 'archive' ? 'absent' : 'present')) throw new Error('sourceFactsChanged');
  }
  if (op.difference.source) {
    const item = await siteLedger.db.read<{ entity: unknown }>('items', sourceKey(run.preview.context.connectionId, op.difference.itemId));
    if (!item || sourceDigest(item.entity) !== sourceDigest(op.difference.source)) throw new Error('sourceFactsChanged');
  }
}
export const reconciliationRuns = createReconcileRuns(siteLedger.db, {
  authorize,
  async prepare(run, op, undo) {
    await currentOperation(run, op, undo);
    const parent = undo ? { kind: 'folder', nativeId: '', bindingId: '', deviceId: '', dateAdded: null, proof: { kind: 'explicitAdoption', id: '' } } as NativeBinding<'folder'> : await parentFor(run, op);
    return prepareReconcileCommand(run, op, parent, undo);
  },
  execute: (run, op, recover, undo) => executeReconcileCommand(run, op, recover, undo, async () => {
    await authorize(run, undo); await currentOperation(run, op, undo);
    if (undo) await assertReconcileUndoState(run, op); else await assertReconcileOwnership(run, op);
  }),
  async finish(run, op, undo) {
    await assertCaptureOwner(run.scope);
    const receipt = (undo ? op.undoReceipt : op.receipt) as ReconcileReceipt;
    const row = op.difference, old = row.representation;
    if (receipt.native && receipt.written) {
      const node = (await chrome.bookmarks.get(receipt.native.nativeId))[0], written = receipt.written;
      if (!node || receipt.native.deviceId !== await captureDeviceId() || node.dateAdded !== receipt.native.dateAdded
        || node.title !== written.title || node.parentId !== written.parentId
        || !sameNativeContentValue('url', node.url ?? null, written.url ?? null)) throw new Error('source_reconcile_conflict');
      if (receipt.native.kind === 'folder') {
        const tree = (await chrome.bookmarks.getSubTree(node.id))[0], original = op.receipt as ReconcileReceipt;
        const before = undo ? original.written : row.expected, digest = undo ? original.subtreeDigest : row.expected?.subtreeDigest;
        if (!tree || !before || !digest || reconcileTreeDigest({ ...tree, title: before.title, parentId: before.parentId }) !== digest) throw new Error('source_reconcile_conflict');
        receipt.subtreeDigest = reconcileTreeDigest(tree);
      }
    }
    if (!undo && receipt.native) {
      const node = (await chrome.bookmarks.get(receipt.native.nativeId))[0], annotations = createBookmarkAnnotationStore();
      try {
        if (node && op.decision.choice === 'restore' && old) await annotations.rebindExact({ id: old.native.nativeId, dateAdded: old.native.dateAdded ?? undefined, url: old.lastWritten?.url ?? row.source?.url }, node);
        if (node && receipt.annotationRevision === undefined) {
          const retained = await annotations.get(node); receipt.annotationRevision = retained?.version ?? 0;
          if (op.decision.choice === 'restore' && retained?.pinned && node.parentId) scheduleNativeFoldersFirst(node.parentId);
        }
      } finally { annotations.close(); }
    }
    if (!undo && op.decision.choice === 'archive' && receipt.written && receipt.native && !await siteLedger.db.read('meta', `reconcileHistory:${receipt.written.parentId}`)) {
      const parent = (await chrome.bookmarks.get(receipt.written.parentId))[0];
      if (parent?.dateAdded) await siteLedger.db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', `reconcileHistory:${parent.id}`, {
        id: `history:${parent.id}`, connectionId: run.preview.context.connectionId, rootRuleId: run.id, revision: 1, aiDestination: 'excluded', state: 'suppressed',
        root: { kind: 'folder', nativeId: parent.id, dateAdded: parent.dateAdded, deviceId: receipt.native!.deviceId, bindingId: op.id, proof: { kind: 'explicitAdoption', id: op.id } },
      }));
    }
    if (row.folder && receipt.native && receipt.written) {
      const previous = row.folder;
      const parentNode = (await chrome.bookmarks.get(receipt.written.parentId))[0];
      if (!parentNode?.dateAdded) throw new Error('source_reconcile_conflict');
      await siteLedger.db.transaction(['folderReservations'], 'readwrite', async tx => {
        const key = sourceKey(previous.mountId, previous.collectionId), latest = await get<SourceFolderReservation>(tx, 'folderReservations', key);
        if (!latest || latest.native?.nativeId !== previous.native?.nativeId || latest.native?.dateAdded !== previous.native?.dateAdded) throw new Error('source_reconcile_conflict');
        const restored = undo ? { ...previous } : { ...latest, state: 'confirmed', nativeTitle: receipt.written!.title,
          locationOverride: { nativeId: parentNode.id, dateAdded: parentNode.dateAdded!, deviceId: receipt.native!.deviceId, kind: 'folder', bindingId: op.id,
            proof: { kind: 'explicitAdoption', id: run.id } } };
        if (restored.shared && receipt.cloud) restored.shared = { ...restored.shared, controlRevision: receipt.cloud.controlRevision ?? 0 };
        put(tx, 'folderReservations', key, restored);
      }); return;
    }
    if (!row.itemId) return;
    await siteLedger.db.transaction(['representations', 'meta', 'mounts'], 'readwrite', async tx => {
      const config = await get<{ ruleId: string }>(tx, 'meta', `archiveConfig:${run.preview.context.connectionId}`);
      const mount = config && await get<SourceMount>(tx, 'mounts', sourceKey(run.preview.context.connectionId, config.ruleId));
      const role = { connectionId: run.preview.context.connectionId, itemId: row.itemId!, purpose: 'sourceArchive' as const,
        sourceCollectionId: row.collectionId, mountId: old?.mountId ?? mount?.id ?? null };
      const current = await get<Representation>(tx, 'representations', representationKey(role));
      if (current && old && current.manualRevision !== old.manualRevision) throw new Error('source_reconcile_conflict');
      const suppress = undo && (op.decision.choice === 'restore' || op.decision.choice === 'adopt');
      if (undo && old && !suppress) {
        put(tx, 'representations', representationKey(role), { ...old,
          ...(old.shared && receipt.cloud ? { shared: { ...old.shared, controlRevision: receipt.cloud.controlRevision ?? 0 } } : {}) });
        return;
      }
      if (!receipt.native || !receipt.written || suppress) {
        if (current) put(tx, 'representations', representationKey(role), { ...current, state: suppress ? 'suppressed' : current.state,
          ...(current.shared && receipt.cloud ? { shared: { ...current.shared, controlRevision: receipt.cloud.controlRevision ?? 0 } } : {}) }); return;
      }
      const shared = receipt.cloud?.slot && 'library' in (op.command as object) ? {
        library: (op.command as { library: import('./copy-identity.js').ManagedLibrary }).library, slot: receipt.cloud.slot, nodeId: receipt.cloud.after.nodeId, controlRevision: receipt.cloud.controlRevision ?? 0,
      } : current?.shared ?? await managedReference(tx, (op.command as { command?: PlannedNativeCommand }).command?.managed);
      const { localTitle: _localTitle, ...base } = current ?? {};
      put(tx, 'representations', representationKey(role), { ...base, ...role, native: { ...receipt.native, kind: 'bookmark' }, state: 'active',
        ...(op.decision.choice !== 'updateTitle' && row.source && receipt.written.title !== row.source.title ? { localTitle: receipt.written.title } : {}),
        manualRevision: current?.manualRevision ?? 0, lastWritten: receipt.written, ...(shared ? { shared } : {}) } satisfies Representation);
      tx.objectStore('meta').delete(sourceKey('reconcileKeep', role.mountId, row.collectionId, row.itemId));
    });
    const command = op.command as { mode: string; command?: PlannedNativeCommand };
    if (!undo && command.mode === 'create' && command.command) await acknowledgePlannedNative(command.command, sourceDigest(command.command));
  }, schedule,
});
export function installReconciliationRuntime() {
  installReconcileAuthorization(async task => {
    const run = task.planned && await reconciliationRuns.status(task.planned.planId), op = run?.operations.find(o => o.id === task.commandId);
    const command = (op?.command as { command?: PlannedNativeCommand } | undefined)?.command;
    if (!run || !command || sourceDigest(command) !== task.planned?.resolvedDigest) throw new Error('sourceAuthorizationChanged');
    await authorize(run); await assertSourceRoot(command.parent);
  });
}
const apply = object({ kind: literal('known.siteAdapters.reconcile.apply'), importId: str(128), digest: str(128),
  decisions: array(object({ id: str(1024), choice: literal('keep', 'adopt', 'restore', 'return', 'archive', 'move', 'updateTitle', 'useLocation'),
    nativeId: v => v === undefined || str(128)(v), destinationId: v => v === undefined || str(128)(v) }), 10000, 0, v => (v as { id: string }).id) });
const control = object({ kind: literal('known.siteAdapters.reconcile.retry', 'known.siteAdapters.reconcile.cancel', 'known.siteAdapters.reconcile.undo'), id: str(128), operationId: v => v === undefined || str(128)(v), destinationId: v => v === undefined || str(128)(v) });
const history = object({ kind: literal('known.siteAdapters.reconcile.history'), before: v => v === undefined || str(1024)(v) });
const details = object({ kind: literal('known.siteAdapters.reconcile.get'), id: str(128) });
export const validReconcileRequest = (raw: unknown) => jsonBytes(raw, 2 * 1024 * 1024) && (apply(raw) || control(raw) || history(raw) || details(raw));
export async function handleReconcileRequest(raw: unknown, connectionId: string) {
  if (history(raw)) {
    const page = await reconciliationRuns.history(connectionId, (raw as { before?: string }).before), runs = [];
    for (const row of page.runs) try { await assertCaptureOwner(row.scope); const { scope: _scope, ...summary } = row; runs.push(summary); } catch { /* Another library's history grants no current authority. */ }
    return { runs, next: page.next };
  }
  if (details(raw)) {
    const run = await reconciliationRuns.status((raw as { id: string }).id);
    if (!run || run.preview.context.connectionId !== connectionId) throw new Error('reconcileRunMissing');
    await assertCaptureOwner(run.scope); return { run };
  }
  if (apply(raw)) {
    const input = raw as { importId: string; digest: string; decisions: ReconcileDecision[] }, preview = await readReconcileData<ReconcilePreview>(siteLedger.db, reconcileKey(input.importId));
    if (!preview || preview.context.connectionId !== connectionId || preview.digest !== input.digest
      || sourceDigest({ ...preview, digest: '' }) !== preview.digest) throw new Error('previewStale');
    await reconciliationRuns.approve(preview, await currentCaptureScope(), input.decisions);
    const config = await siteLedger.db.read<{ ruleId: string }>('meta', `archiveConfig:${connectionId}`), mount = config && await siteLedger.db.read<SourceMount>('mounts', sourceKey(connectionId, config.ruleId));
    if (mount) await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
      for (const row of preview.differences) if (row.kind === 'candidate') put(tx, 'meta', sourceKey('reconcileKeep', mount.id, row.collectionId, row.itemId), { previewId: preview.id });
    }); return;
  }
  const input = raw as { kind: string; id: string; operationId?: string; destinationId?: string }, run = await reconciliationRuns.status(input.id);
  if (!run || run.preview.context.connectionId !== connectionId) throw new Error('reconcileRunMissing');
  await assertCaptureOwner(run.scope);
  if (input.kind.endsWith('.retry')) await reconciliationRuns.retry(input.id, input.destinationId);
  else if (input.kind.endsWith('.undo') && input.operationId) await reconciliationRuns.undo(input.id, input.operationId);
  else if (input.kind.endsWith('.cancel')) await reconciliationRuns.cancel(input.id);
  else throw new Error('invalid');
}
