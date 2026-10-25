import { managedCopyKey, managedLibraryKey, type ManagedLibrary } from './copy-identity.js';
import type { ManagedDestination, ManagedSaveCommand, ManagedSaveReceipt, ManagedSlot, ManagedBinding } from './managed-client.js';
import type { PlannedNativeCommand, PlannedNativeResult } from './planned-types.js';
import type { NativeBinding, SaveEffect, SavePlan } from './contracts.js';
import { sourceDigest, type SourceDatabase } from './source-db.js';
export interface ManagedSavePorts {
  destination(parent: NativeBinding<'folder'>): Promise<{ library: ManagedLibrary; replicaId: string; parentId: string; parentRevision: string } | null>;
  slot(plan: SavePlan, effect: SaveEffect): Promise<ManagedSlot>;
  client(library: ManagedLibrary): Promise<{ profile(): Promise<void>; call<T>(action: 'managed.save' | 'managed.recover' | 'managed.lookup', input: unknown): Promise<T> }>;
  projection(destination: ManagedDestination, receipt: ManagedSaveReceipt): Promise<{ native: NativeBinding; parentId: string } | null>;
  wake(): void;
}
export function managedSlotKey(collectionId: string, slot: ManagedSlot) {
  if (slot.kind === 'bookmark') return managedCopyKey(collectionId, slot.copy);
  const s = slot.source;
  return JSON.stringify(['site-folder', 1, collectionId, s.site, s.identityVersion, s.sourceAccount, s.sourceCollectionId]);
}
export function assertManagedReceipt(value: ManagedSaveReceipt, command: ManagedSaveCommand) {
  const n = value?.node;
  if (value?.version !== 1 || value.commandId !== command.commandId || value.digest !== sourceDigest(command)
    || value.key !== managedSlotKey(command.collectionId, command.slot) || !n || !n.nodeId || !n.parentId || !n.revision
    || typeof n.title !== 'string' || !(n.url === null || typeof n.url === 'string')
    || !['created', 'reused', 'detached', 'suppressed'].includes(value.disposition)
    || ['created', 'reused'].includes(value.disposition) && (n.deleted
      || value.disposition === 'created' && (n.parentId !== command.parentId || n.url !== command.url)
      || n.parentId !== command.parentId && !(command.slot.kind === 'bookmark' && command.slot.copy.purpose === 'semantic'))) throw new Error('sourceSyncInvalid');
}
/** Shared creation is complete before ordinary Sync projects a native node. No competing local create. */
export function createManagedSaves(db: SourceDatabase, ports: ManagedSavePorts) {
  async function prepareForSlot(command: PlannedNativeCommand, slot: () => Promise<ManagedSlot>) {
    const target = await ports.destination(command.parent); if (!target) return command;
    const managed: ManagedDestination = { library: target.library, command: { commandId: command.commandId, replicaId: target.replicaId,
      collectionId: target.library.collectionId, parentId: target.parentId, parentRevision: target.parentRevision,
      slot: await slot(), title: command.title, url: command.bookmark?.url ?? null } };
    return { ...command, managed };
  }
  const receiptKey = (d: ManagedDestination) => `managedReceipt:${managedLibraryKey(d.library)}:${d.command.commandId}`;
  async function remember(d: ManagedDestination, receipt: ManagedSaveReceipt) {
    assertManagedReceipt(receipt, d.command);
    await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(receipt, receiptKey(d)); });
    return receipt;
  }
  async function project(command: PlannedNativeCommand, receipt: ManagedSaveReceipt): Promise<PlannedNativeResult> {
    const d = command.managed!;
    if (receipt.disposition === 'suppressed' || receipt.disposition === 'detached') return { status: 'blocked', reason: receipt.disposition === 'suppressed' ? 'sourceCopySuppressed' : 'sourceCopyDetached' };
    ports.wake();
    const projected = await ports.projection(d, receipt);
    if (!projected) {
      const { binding } = await (await ports.client(d.library)).call<{ binding: ManagedBinding | null }>('managed.lookup', { collectionId: d.command.collectionId, slot: d.command.slot });
      if (binding && (binding.state === 'suppressed' || binding.state === 'detached')) return { status: 'blocked', reason: binding.state === 'suppressed' ? 'sourceCopySuppressed' : 'sourceCopyDetached' };
    }
    return projected ? { status: 'confirmed', native: projected.native, written: { title: receipt.node.title, parentId: projected.parentId, ...(receipt.node.url === null ? {} : { url: receipt.node.url }) } }
      : { status: 'unknown', reason: 'sourceSyncPending' };
  }
  return {
    async prepare(command: PlannedNativeCommand, plan: SavePlan, effect: SaveEffect) {
      return prepareForSlot(command, () => ports.slot(plan, effect));
    },
    prepareForSlot: (command: PlannedNativeCommand, slot: ManagedSlot) => prepareForSlot(command, async () => slot),
    async execute(command: PlannedNativeCommand, authorize: () => Promise<void>): Promise<PlannedNativeResult> {
      const d = command.managed; if (!d) throw new Error('managedDestinationRequired');
      const client = await ports.client(d.library);
      let receipt = await db.read<ManagedSaveReceipt>('meta', receiptKey(d));
      if (!receipt) {
        try {
          await client.profile(); await authorize();
          receipt = await remember(d, await client.call<ManagedSaveReceipt>('managed.save', d.command));
        } catch (error) { if (error instanceof Error && error.message === 'sourceSyncPending') ports.wake(); throw error; }
      }
      assertManagedReceipt(receipt, d.command);
      return project(command, receipt);
    },
    async recover(command: PlannedNativeCommand): Promise<PlannedNativeResult | null> {
      const d = command.managed; if (!d) return null;
      const client = await ports.client(d.library);
      let receipt = await db.read<ManagedSaveReceipt>('meta', receiptKey(d));
      if (!receipt) {
        const r = await client.call<{ receipt: ManagedSaveReceipt | null }>('managed.recover', { commandId: d.command.commandId, digest: sourceDigest(d.command) })
          .catch(error => { if (error instanceof Error && error.message === 'sourceSyncPending') ports.wake(); throw error; });
        if (!r.receipt) return null;
        receipt = await remember(d, r.receipt);
      }
      assertManagedReceipt(receipt, d.command);
      return project(command, receipt);
    },
  };
}
