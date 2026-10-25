import type { ManagedLibrary } from './copy-identity.js';
import type { ManagedNode, ManagedSlot, ManagedDestination, ManagedReconcileCommand, ManagedReconcileReceipt } from './managed-client.js';
import type { ReconcileRun, ReconcileOperation } from './reconcile-run.js';
import type { NativeBinding } from './contracts.js';
import type { PlannedNativeCommand } from './planned-types.js';
import { siteLedger } from './source-runtime.js';
import { readSourceConnection } from './content-identity.js';
import { identityDefinition } from './registry.js';
import { managedSaves, managedClientForLibrary, projectManagedBinding } from './managed-runtime.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState, workCoordinator } from '../sw/runtime.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertSourceRoot, executePlannedNative, recoverPlannedNative } from '../sw/planned-capture.js';
import { sourceDigest } from './source-db.js';
import { sameNativeContentValue } from '../native-event-correlation.js';
import { restoreReconcileProjection } from './reconcile-projection.js';
import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import { nativeEventCorrelation } from '../native-event-correlation.js';
import { reconcileInventory, reconcileTreeDigest } from './reconcile-inventory.js';
import { assertCaptureOwner } from '../sw/capture-native.js';
import { scheduleSyncEngineWake } from '../sw/engine.js';
import { representationKey } from './reservations.js';
import { cursorPage } from '../sync-state/idb.js';
import type { Representation } from './contracts.js';
import type { ContentBindingRow } from './content-bindings.js';
type Command = { mode: 'cloud'; library: ManagedLibrary; input: ManagedReconcileCommand | { commandId: string; collectionId: string; replicaId: string; original: string }; undo: boolean }
  | { mode: 'adopt'; command: PlannedNativeCommand }
  | { mode: 'create'; command: PlannedNativeCommand }
  | { mode: 'native'; native: NativeBinding; target?: NativeBinding<'folder'>; origin?: NativeBinding<'folder'>;
    before: { title: string; parentId: string; url: string | null }; after: { title: string; parentId: string; url: string | null } | null; id: string };
export interface ReconcileReceipt { native?: NativeBinding; written?: { title: string; parentId: string; url?: string }; cloud?: ManagedReconcileReceipt; before?: Command; annotationRevision?: number; subtreeDigest?: string }
async function nativeNode(native: NativeBinding) {
  const node = (await chrome.bookmarks.get(native.nativeId).catch(() => []))[0];
  if (!node || node.dateAdded !== native.dateAdded || native.deviceId !== await captureDeviceId()) throw new Error('source_reconcile_conflict'); return node;
}
async function parentProof(nativeId: string, id: string): Promise<NativeBinding<'folder'>> {
  const node = (await chrome.bookmarks.get(nativeId))[0]; if (!node?.dateAdded || node.url) throw new Error('source_reconcile_conflict');
  return { nativeId, dateAdded: node.dateAdded, kind: 'folder', deviceId: await captureDeviceId(), bindingId: id, proof: { kind: 'explicitAdoption', id } };
}
async function slot(run: ReconcileRun, op: ReconcileOperation): Promise<ManagedSlot | null> {
  const c = await readSourceConnection(siteLedger.db, run.preview.context.connectionId), definition = identityDefinition(c.siteKey, c.identityVersion);
  if (op.difference.folder) return { kind: 'folder', source: { site: c.siteKey, identityVersion: c.identityVersion, sourceAccount: c.accountId, sourceCollectionId: op.difference.collectionId } };
  if (!op.difference.itemId) return null;
  return { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: c.accountId, sourceCollectionId: op.difference.collectionId,
    content: { site: c.siteKey, identityVersion: c.identityVersion, itemId: op.difference.itemId, accountId: definition.contentIdScope === 'site' ? null : c.accountId } } };
}
export async function assertReconcileOwnership(run: ReconcileRun, op: ReconcileOperation) {
  const row = op.difference, candidate = op.decision.choice === 'adopt' ? row.candidates?.find(n => n.native.nativeId === op.decision.nativeId) : row.expected;
  if (!candidate) return;
  const inventory = await reconcileInventory(siteLedger.db, run.preview.context.connectionId, run.preview.snapshots.map(s => s.collectionId));
  const fresh = inventory.nodes.find(n => n.native.nativeId === candidate.native.nativeId) ?? inventory.movedFolders.find(f => f.node.native.nativeId === candidate.native.nativeId)?.node;
  if (!fresh || fresh.protected || inventory.representations.some(r => r.native.nativeId === candidate.native.nativeId
    && (!row.representation || representationKey(r) !== representationKey(row.representation)))) throw new Error('source_copy_protected');
}
async function assertUndoNativeOwnership(run: ReconcileRun, op: ReconcileOperation, native: NativeBinding) {
  const tree = (await chrome.bookmarks.getSubTree(native.nativeId))[0], ids = new Set<string>();
  const visit = (n: chrome.bookmarks.BookmarkTreeNode, depth = 0) => {
    if (depth > 128 || ids.size >= 100000) throw new Error('capacity'); ids.add(n.id); for (const c of n.children ?? []) visit(c, depth + 1);
  }; if (tree) visit(tree);
  const data = await siteLedger.db.transaction(['representations', 'contentBindings'], 'readonly', async tx => ({
    reps: await cursorPage<Representation>(tx.objectStore('representations'), null, 100001),
    bindings: await cursorPage<ContentBindingRow>(tx.objectStore('contentBindings'), null, 100001),
  }));
  if (data.reps.length > 100000 || data.bindings.length > 100000) throw new Error('capacity');
  const row = op.difference;
  if (data.bindings.some(b => b.native && ids.has(b.native.nativeId) && !b.supersededBy)
    || data.reps.some(r => ids.has(r.native.nativeId) && (r.connectionId !== run.preview.context.connectionId || r.purpose !== 'sourceArchive'
      || r.sourceCollectionId !== row.collectionId || native.kind === 'bookmark' && r.itemId !== row.itemId
      || row.representation && r.mountId !== row.representation.mountId))) throw new Error('source_copy_protected');
}
export async function assertReconcileUndoState(run: ReconcileRun, op: ReconcileOperation) {
  const receipt = op.receipt as ReconcileReceipt;
  if (!receipt.native || !receipt.written) throw new Error('source_reconcile_conflict');
  const node = await nativeNode(receipt.native), expected = receipt.written;
  if (node.title !== expected.title || node.parentId !== expected.parentId || !sameNativeContentValue('url', node.url ?? null, expected.url ?? null)) throw new Error('source_reconcile_conflict');
  const annotations = createBookmarkAnnotationStore(), row = await annotations.get(node).finally(() => annotations.close());
  if ((row?.version ?? 0) !== (receipt.annotationRevision ?? 0)) throw new Error('source_reconcile_conflict');
  if (receipt.native.kind === 'folder') {
    const tree = (await chrome.bookmarks.getSubTree(receipt.native.nativeId))[0];
    if (!tree || !receipt.subtreeDigest || reconcileTreeDigest(tree) !== receipt.subtreeDigest) throw new Error('source_reconcile_conflict');
  }
  await assertUndoNativeOwnership(run, op, receipt.native);
}
export async function prepareReconcileCommand(run: ReconcileRun, op: ReconcileOperation, parent: NativeBinding<'folder'>, undo: boolean): Promise<Command> {
  const choice = op.decision.choice, row = op.difference, receipt = op.receipt as ReconcileReceipt | undefined;
  if (undo) {
    await assertReconcileUndoState(run, op);
    const original = op.command as Command;
    if (original.mode === 'cloud') return { mode: 'cloud', library: original.library, undo: true,
      input: { commandId: `undo:${op.id}`, collectionId: original.library.collectionId, replicaId: (await currentSyncScope()).replicaId, original: original.input.commandId } };
    if (original.mode === 'adopt') {
      const managed = original.command.managed!, client = await managedClientForLibrary(managed.library);
      const role = (await client.call<{ binding: { node: ManagedNode; controlRevision?: number } }>('managed.lookup', { collectionId: managed.library.collectionId, slot: managed.command.slot })).binding;
      if (!role) throw new Error('sourceBindingNeedsReview');
      return { mode: 'cloud', library: managed.library, undo: false, input: { commandId: `undo:${op.id}`, collectionId: managed.library.collectionId,
        replicaId: (await currentSyncScope()).replicaId, action: 'unlink', expected: role.node, slot: managed.command.slot,
        parentId: role.node.parentId, title: role.node.title, retire: false, associationRevision: role.controlRevision ?? 0 } };
    }
    if (!receipt?.native || !receipt.written) throw new Error('source_reconcile_conflict');
    await nativeNode(receipt.native);
    return { mode: 'native', id: `undo:${op.id}`, native: receipt.native,
      ...(original.mode === 'native' ? { target: original.origin, origin: original.target } : original.mode === 'create' ? { origin: original.command.parent } : {}),
      before: { ...receipt.written, url: receipt.written.url ?? null }, after: original.mode === 'create' ? null : original.mode === 'native' ? original.before : null };
  }
  const role = await slot(run, op), deviceId = await captureDeviceId();
  const candidate = choice === 'adopt' ? row.candidates?.find(n => n.native.nativeId === op.decision.nativeId) : row.expected;
  if (candidate) {
    const actual = await nativeNode(candidate.native);
    if (actual.title !== candidate.title || actual.parentId !== candidate.parentId || !sameNativeContentValue('url', actual.url ?? null, candidate.url)) throw new Error('source_reconcile_conflict');
    await assertReconcileOwnership(run, op);
    if (candidate.native.kind === 'folder') {
      const tree = (await chrome.bookmarks.getSubTree(candidate.native.nativeId))[0];
      if (!tree || candidate.subtreeDigest !== reconcileTreeDigest(tree)) throw new Error('source_reconcile_conflict');
    }
    if (['archive', 'move', 'return'].includes(choice)) {
      const annotations = createBookmarkAnnotationStore(), latest = await annotations.get(actual).finally(() => annotations.close());
      if ((latest?.version ?? 0) !== (candidate.annotationRevision ?? 0)) throw new Error('source_reconcile_conflict');
    }
  }
  const target = await assertSourceRoot(parent);
  if (target.inRange) {
    const sync = await currentSyncScope(), library = { serverOrigin: sync.serverOrigin, accountId: sync.accountId, collectionId: sync.collectionId };
    const client = await managedClientForLibrary(library); await client.reconcileProfile();
    let canonicalId = row.representation?.shared?.nodeId;
    if (candidate) canonicalId = (await syncState.getMappingByNativeId(sync, candidate.native.nativeId))?.colpId;
    if (!canonicalId && role) canonicalId = (await client.call<{ binding: { node: ManagedNode } | null }>('managed.lookup', { collectionId: sync.collectionId, slot: role })).binding?.node.nodeId;
    if (!canonicalId) throw new Error('sourceBindingNeedsReview');
    const expected = (await client.call<{ node: ManagedNode | null }>('managed.node', { collectionId: sync.collectionId, nodeId: canonicalId })).node;
    if (!expected) throw new Error('sourceBindingNeedsReview');
    if (candidate) {
      const sourceParent = await syncState.getMappingByNativeId(sync, candidate.parentId);
      if (!sourceParent || sourceParent.quarantine) throw new Error('sourceSyncPending');
      if (expected.deleted || expected.parentId !== sourceParent.colpId || expected.title !== candidate.title
        || !sameNativeContentValue('url', candidate.url, expected.url)) throw new Error('source_reconcile_conflict');
    }
    const parentMapping = await syncState.getMappingByNativeId(sync, parent.nativeId); if (!parentMapping || parentMapping.quarantine) throw new Error('sourceSyncPending');
    if (choice === 'adopt') {
      const command = await managedSaves.prepareForSlot({ commandId: op.id, ownerId: run.id, connectionId: run.preview.context.connectionId, kind: 'bookmark', parent,
        title: candidate!.title, deviceId, logicalDigest: sourceDigest(op.decision), bookmark: { planId: run.id, effectId: `reconcile:${op.id}`, representation: {
          connectionId: run.preview.context.connectionId, itemId: row.itemId!, purpose: 'sourceArchive', sourceCollectionId: row.collectionId, mountId: row.representation?.mountId ?? null },
        url: candidate!.url!, scope: run.scope, source: 'site-import' } }, role!);
      command.managed!.command.adopt = { nodeId: expected.nodeId, revision: expected.revision }; return { mode: 'adopt', command };
    }
    const currentRole = role ? (await client.call<{ binding: { controlRevision?: number } | null }>('managed.lookup', { collectionId: sync.collectionId, slot: role })).binding : null;
    const shared = row.representation?.shared ?? row.folder?.shared;
    if (shared && (shared.nodeId !== expected.nodeId || (shared.controlRevision ?? 0) !== (currentRole?.controlRevision ?? 0))) throw new Error('source_association_changed');
    return { mode: 'cloud', library, undo: false, input: { commandId: op.id, collectionId: sync.collectionId, replicaId: sync.replicaId,
      action: choice === 'updateTitle' ? 'rename' : choice === 'restore' || choice === 'useLocation' ? 'restore' : 'move', expected, slot: role,
      parentId: parentMapping.colpId, title: choice === 'updateTitle' ? row.source!.title : expected.title, retire: choice === 'archive', ...(role ? { associationRevision: currentRole?.controlRevision ?? 0 } : {}) } };
  }
  if (choice === 'adopt') return { mode: 'native', id: op.id, native: candidate!.native, target: parent, origin: await parentProof(candidate!.parentId, op.id), before: { title: candidate!.title, parentId: candidate!.parentId, url: candidate!.url },
    after: { title: candidate!.title, parentId: candidate!.parentId, url: candidate!.url } };
  if (choice === 'restore' && !candidate) return { mode: 'create', command: { commandId: op.id, ownerId: run.id, connectionId: run.preview.context.connectionId,
    kind: 'bookmark', parent, title: row.representation?.localTitle ?? row.source!.title, deviceId, logicalDigest: sourceDigest(op.decision), bookmark: { planId: run.id, effectId: `reconcile:${op.id}`,
      representation: { connectionId: run.preview.context.connectionId, itemId: row.itemId!, purpose: 'sourceArchive', sourceCollectionId: row.collectionId, mountId: null },
      url: row.source!.url, scope: run.scope, source: 'site-import' } } };
  if (!candidate) throw new Error('sourceBindingNeedsReview');
  return { mode: 'native', id: op.id, native: candidate.native, target: parent, origin: await parentProof(candidate.parentId, op.id), before: { title: candidate.title, parentId: candidate.parentId, url: candidate.url },
    after: { title: choice === 'updateTitle' ? row.source!.title : candidate.title, parentId: parent.nativeId, url: candidate.url } };
}
export async function executeReconcileCommand(run: ReconcileRun, op: ReconcileOperation, recover: boolean, undo: boolean, authorize: () => Promise<void>): Promise<{ receipt: ReconcileReceipt } | null> {
  const command = (undo ? op.undoCommand : op.command) as Command;
  if (command.mode === 'cloud') {
    const client = await managedClientForLibrary(command.library), hash = sourceDigest(command.input);
    const found = await client.call<{ receipt: ManagedReconcileReceipt | null }>('managed.reconcile.recover', { commandId: command.input.commandId, digest: hash });
    if (!found.receipt && recover) return null;
    if (!found.receipt) await authorize();
    const receipt = found.receipt ?? await client.call<ManagedReconcileReceipt>(command.undo ? 'managed.reconcile.undo' : 'managed.reconcile', command.input);
    void scheduleSyncEngineWake('manual').catch(() => undefined);
    if (receipt.after.deleted || undo && op.decision.choice === 'restore' && !op.difference.expected && !receipt.keepPhysical) {
      const original = op.receipt as ReconcileReceipt | undefined;
      if (undo && original?.native && original.written) {
        const { native, written } = original;
        await workCoordinator.run('engine', async () => {
        const actual = (await chrome.bookmarks.get(native.nativeId).catch(() => []))[0];
        if (actual) {
          if (actual.dateAdded !== native.dateAdded || actual.title !== written.title || actual.parentId !== written.parentId
            || !sameNativeContentValue('url', actual.url ?? null, written.url ?? null)) throw new Error('source_reconcile_conflict');
          const scope = await currentSyncScope(), echo = `reconcile-delete:${op.id}`;
          if (!await syncState.getApplyIntent(scope, echo)) await syncState.createApplyIntent(scope, { intentId: echo,
            correlationId: nativeEventCorrelation('remove', actual.id, { parentId: actual.parentId!, index: actual.index! }),
            expected: { kind: 'remove', nativeId: actual.id }, expiresAt: Date.now() + 300000, state: 'intent_prepared', generation: scope.generation });
          const local: Command = { mode: 'native', id: echo, native, before: { ...written, url: written.url ?? null }, after: null };
          await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(local, `reconcileNative:${actual.id}`); });
          await chrome.bookmarks.remove(actual.id);
        }
        });
      }
      return { receipt: { cloud: receipt, before: command } };
    }
    let projected = await projectManagedBinding(command.library, { collectionId: command.library.collectionId, slot: receipt.slot ?? (receipt.after.url === null
      ? { kind: 'folder', source: { site: 'known.personal', identityVersion: 1, sourceAccount: 'personal', sourceCollectionId: 'personal' } }
      : { kind: 'bookmark', copy: { purpose: 'semantic', content: { site: 'known.personal', identityVersion: 1, itemId: receipt.after.nodeId, accountId: null } } }), node: receipt.after, state: 'active' }, op.id).catch(async e => {
      if (e instanceof Error && e.message === 'sourceCopyDetached') {
        const latest = (await client.call<{ node: ManagedNode }>('managed.node', { collectionId: command.library.collectionId, nodeId: receipt.after.nodeId })).node;
        if (latest && latest.parentId === receipt.after.parentId && latest.title === receipt.after.title && latest.url === receipt.after.url) return null;
        throw new Error('source_reconcile_conflict');
      } throw e;
    });
    if (!projected && op.decision.choice === 'restore') {
      const node = await restoreReconcileProjection(command.library, receipt.after, op.id, async () => {
        await assertCaptureOwner(run.scope);
        const current = (await client.call<{ node: ManagedNode | null }>('managed.node', { collectionId: command.library.collectionId, nodeId: receipt.after.nodeId })).node;
        if (!current || current.revision !== receipt.after.revision) throw new Error('source_reconcile_conflict');
      });
      projected = { native: { nativeId: node.id, kind: 'bookmark', deviceId: await captureDeviceId(), dateAdded: node.dateAdded!, bindingId: op.id, proof: { kind: 'writeReceipt', id: op.id } }, parentId: node.parentId! };
    }
    if (!projected) throw new Error('sourceSyncPending');
    return { receipt: { cloud: receipt, native: projected.native, written: { title: receipt.after.title, parentId: projected.parentId, ...(receipt.after.url ? { url: receipt.after.url } : {}) }, before: command } };
  }
  if (command.mode === 'adopt' || command.mode === 'create') {
    const result = command.mode === 'adopt' ? recover ? await managedSaves.recover(command.command) : await managedSaves.execute(command.command, authorize)
      : recover ? await recoverPlannedNative(command.command, sourceDigest(command.command)) : await executePlannedNative(command.command, sourceDigest(command.command), authorize);
    if (!result) return null; if (result.status !== 'confirmed') throw new Error(result.reason);
    return { receipt: { native: result.native, written: result.written ?? { title: command.command.title, parentId: command.command.parent.nativeId, url: command.command.bookmark!.url }, before: command } };
  }
  const node = (await chrome.bookmarks.get(command.native.nativeId).catch(() => []))[0];
  const matches = (expected: NonNullable<typeof command.after>) => node?.dateAdded === command.native.dateAdded && node.title === expected.title && node.parentId === expected.parentId && sameNativeContentValue('url', node.url ?? null, expected.url);
  if (command.after ? matches(command.after) : !node) return { receipt: { native: command.native, ...(command.after ? { written: { title: command.after.title, parentId: command.after.parentId, ...(command.after.url ? { url: command.after.url } : {}) } } : {}), before: command } };
  if (recover) return null;
  if (!matches(command.before)) throw new Error('source_reconcile_conflict');
  const destination = command.after ? command.target : command.origin;
  if (destination && (await assertSourceRoot(destination)).inRange !== (run.preview.destination?.owner != null)) throw new Error('sourceDestinationChanged');
  if (undo) await assertUndoNativeOwnership(run, op, command.native);
  await authorize();
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(command, `reconcileNative:${command.native.nativeId}`); });
  if (!command.after) await chrome.bookmarks.remove(command.native.nativeId);
  else {
    if (node!.parentId !== command.after.parentId) await chrome.bookmarks.move(node!.id, { parentId: command.after.parentId });
    if (node!.title !== command.after.title) await chrome.bookmarks.update(node!.id, { title: command.after.title });
  }
  return executeReconcileCommand(run, op, true, undo, authorize);
}
export async function isReconcileNativeMutation(id: string, removedDate?: number) {
  const command = await siteLedger.db.read<Extract<Command, { mode: 'native' }> & { consumed?: boolean }>('meta', `reconcileNative:${id}`); if (!command || command.consumed) return false;
  const node = (await chrome.bookmarks.get(id).catch(() => []))[0];
  const matches = command.after ? node?.dateAdded === command.native.dateAdded && node.title === command.after.title && node.parentId === command.after.parentId && sameNativeContentValue('url', node.url ?? null, command.after.url) : !node && removedDate === command.native.dateAdded;
  if (matches) await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { const request = tx.objectStore('meta').get(`reconcileNative:${id}`);
    request.onsuccess = () => { if (request.result?.id === command.id) tx.objectStore('meta').put({ ...request.result, consumed: true }, `reconcileNative:${id}`); }; });
  return matches;
}
