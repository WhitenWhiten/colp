import { siteLedger } from './source-runtime.js';
import { get, put, sourceDigest, sourceKey } from './source-db.js';
import { managedClientForLibrary, projectManagedBinding } from './managed-runtime.js';
import { assertManagedReceipt } from './managed-saves.js';
import { assertTransferCurrent } from './local-transfer-authority.js';
import { managedLibraryKey } from './copy-identity.js';
import type { ManagedBinding, ManagedSaveCommand, ManagedSaveReceipt } from './managed-client.js';
import type { LocalCopyTransfer } from './local-identity.js';
import type { LocalTransferRegistration } from './local-transfer-queue.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
import { sharedBindingKey } from './shared-catalog.js';
import { assertConvergenceChildren } from './local-convergence-children.js';

export async function registerLocalTransfer(transfer: LocalCopyTransfer): Promise<LocalTransferRegistration> {
  if (!transfer.owner) throw Error('sourceSyncOwnerChanged');
  const owner = transfer.owner, client = await managedClientForLibrary(owner);
  const attemptKey = sourceKey('localAdoptAttempt', managedLibraryKey(owner), transfer.commandId);
  let command = await siteLedger.db.read<ManagedSaveCommand>('meta', attemptKey), receipt: ManagedSaveReceipt | null = null;
  const rejectedKey = `${attemptKey}:rejected`, replacedKey = `${attemptKey}:replaced`;
  let fenced: ManagedSaveCommand | undefined;
  if (command) {
    // A committed merge may already have removed/moved the provisional native. Recover its immutable receipt first.
    receipt = (await client.call<{ receipt: ManagedSaveReceipt | null }>('managed.recover', { commandId: command.commandId, digest: sourceDigest(command) })).receipt;
  }
  if (!receipt && command) {
    const rejected = await siteLedger.db.read<{ commandId: string }>('meta', rejectedKey);
    const current = await currentSyncScope();
    if (rejected?.commandId === command.commandId || (!await siteLedger.db.read('meta', replacedKey) && ['source_root_changed', 'source_copy_adoption_conflict'].includes(transfer.reason ?? '')) || current.replicaId !== command.replicaId) {
      await assertTransferCurrent(transfer);
      const profile = await client.profile(transfer.copyPolicy);
      if (profile?.managedCancel !== 1) throw Error('sourceSyncUpgradeRequired');
      const result = await client.call<{ receipt: ManagedSaveReceipt | null }>('managed.cancel', { commandId: command.commandId, digest: sourceDigest(command), collectionId: command.collectionId });
      if (result.receipt) receipt = result.receipt;
      else { fenced = command; command = undefined; }
    }
  }
  if (!receipt) {
    const { scope, native } = await assertTransferCurrent(transfer);
    const [mapping, parent] = await Promise.all([syncState.getMappingByNativeId(scope, native.id), syncState.getMappingByNativeId(scope, transfer.parent.nativeId)]);
    if (!mapping || !parent || mapping.quarantine || parent.quarantine || mapping.colpId.startsWith('pending-') || parent.colpId.startsWith('pending-')) throw Error('sourceSyncPending');
    // Complete an explicitly authorized move before the server observes this node for another role.
    // Otherwise its intermediate placement could become an immutable detached adoption receipt.
    if (await siteLedger.db.read('meta', `managedRelocate:${managedLibraryKey(owner)}:${mapping.colpId}`)) throw Error('sourceSyncPending');
    await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
      if (!await get(tx, 'meta', `localUploadObserved:${transfer.commandId}`)) put(tx, 'meta', `localUploadObserved:${transfer.commandId}`, Date.now());
    });
    const profile = await client.profile(transfer.copyPolicy);
    if (!command) {
      const id = `local-adopt:${sourceDigest({ owner, command: transfer.commandId, node: mapping.colpId, ...(fenced ? { previous: fenced.commandId, replica: scope.replicaId, parentRevision: parent.projection.resourceRevision ?? parent.projection.revision, nodeRevision: mapping.projection.resourceRevision ?? mapping.projection.revision } : {}) }).slice(7)}`;
      command = await siteLedger.db.read<ManagedSaveCommand>('meta', `localAdoptCommand:${id}`);
      if (!command) {
        let parentId = parent.colpId, parentRevision = parent.projection.resourceRevision ?? parent.projection.revision;
        if (profile?.managedLocalConvergence === 1 && transfer.slot.kind === 'bookmark' && transfer.slot.copy.purpose === 'sourceArchive') {
          const copy = transfer.slot.copy;
          const { binding } = await client.call<{ binding: ManagedBinding | null }>('managed.lookup', { collectionId: owner.collectionId, slot: { kind: 'folder', source: {
            site: copy.content.site, identityVersion: copy.content.identityVersion, sourceAccount: copy.sourceAccount, sourceCollectionId: copy.sourceCollectionId } } });
          if (!binding) throw Error('sourceSyncPending');
          if (binding.state !== 'active') throw Error(binding.state === 'suppressed' ? 'sourceCopySuppressed' : 'sourceCopyDetached');
          parentId = binding.node.nodeId; parentRevision = binding.node.revision;
        }
        command = { commandId: id, replicaId: scope.replicaId, collectionId: scope.collectionId, parentId, parentRevision,
          slot: transfer.slot, ...(transfer.copyPolicy ? { copyPolicy: transfer.copyPolicy } : {}), title: transfer.title, url: transfer.url,
          adopt: { nodeId: mapping.colpId, revision: mapping.projection.resourceRevision ?? mapping.projection.revision },
          ...(profile?.managedLocalConvergence === 1 ? { converge: { fromParentId: parent.colpId } } : {}) };
      }
      const frozen = command;
      await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
        const current = await get<ManagedSaveCommand>(tx, 'meta', attemptKey);
        if (fenced && (!current || sourceDigest(current) !== sourceDigest(fenced))) throw Error('sourceSyncPending');
        if (!fenced && current && sourceDigest(current) !== sourceDigest(frozen)) throw Error('sourceSyncPending');
        put(tx, 'meta', attemptKey, frozen); put(tx, 'meta', `localAdoptCommand:${frozen.commandId}`, frozen);
        if (fenced) { put(tx, 'meta', replacedKey, true); tx.objectStore('meta').delete(rejectedKey); }
      });
    }
    await assertTransferCurrent(transfer);
    try { receipt = await client.call<ManagedSaveReceipt>('managed.save', command); }
    catch (error) {
      if (error instanceof Error && ['source_root_changed', 'source_copy_adoption_conflict'].includes(error.message)) {
        const rejected = command!;
        await siteLedger.db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', rejectedKey, { commandId: rejected.commandId, reason: error.message }));
      }
      if (error instanceof Error && error.message === 'source_convergence_pending') await assertConvergenceChildren(transfer);
      throw error;
    }
  }
  assertManagedReceipt(receipt, command!);
  if (receipt.node.nodeId !== command!.adopt!.nodeId && (!command!.converge || receipt.convergedFrom !== command!.adopt!.nodeId)) throw Error('source_copy_adoption_conflict');
  if (receipt.disposition === 'suppressed' || receipt.disposition === 'detached') throw Error(receipt.disposition === 'suppressed' ? 'sourceCopySuppressed' : 'sourceCopyDetached');
  const scope = await currentSyncScope(); if (managedLibraryKey(scope) !== managedLibraryKey(owner)) throw Error('sourceSyncOwnerChanged');
  const binding: ManagedBinding = { collectionId: owner.collectionId, slot: transfer.slot, node: receipt.node, state: 'active', controlRevision: receipt.controlRevision ?? 0 };
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', sharedBindingKey(owner, transfer.slot), binding));
  const reference = { library: owner, slot: transfer.slot, nodeId: receipt.node.nodeId, controlRevision: receipt.controlRevision ?? 0 };
  if (receipt.convergedFrom || command!.converge && command!.parentId !== command!.converge.fromParentId) {
    const projection = await projectManagedBinding(owner, binding, `converged:${command!.commandId}`);
    if (!projection) throw Error('sourceSyncPending');
    return { ...reference, projection: { ...projection, title: receipt.node.title, url: receipt.node.url } };
  }
  return reference;
}
