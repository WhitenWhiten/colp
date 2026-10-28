import type { NativeBinding } from './contracts.js';
import type { ManagedSlot } from './managed-client.js';
import { managedCopyKey, type DestinationOwner, type ManagedLibrary } from './copy-identity.js';
import { sourceKey } from './source-db.js';

/** Device authority survives login/logout; cloud ownership is an optional, separate binding. */
export const localSourceScopeId = (deviceId: string) => sourceKey('local', deviceId);
export function localSourceCopyKey(root: NativeBinding<'folder'>, slot: ManagedSlot): string {
  if (!root.deviceId || !root.nativeId || !root.dateAdded || root.kind !== 'folder') throw new Error('nativeIdentityUnproven');
  const identity = slot.kind === 'bookmark' ? managedCopyKey('local', slot.copy)
    : sourceKey('folder', slot.source.site, slot.source.identityVersion, slot.source.sourceAccount, slot.source.sourceCollectionId);
  return sourceKey('local-source-copy', 1, root.deviceId, root.nativeId, root.dateAdded, identity);
}
export function transferOwner(owner?: DestinationOwner | null): ManagedLibrary | null {
  return owner?.accountId && owner.collectionId
    ? { serverOrigin: new URL(owner.serverOrigin).origin, accountId: owner.accountId, collectionId: owner.collectionId } : null;
}
export interface LocalCopyTransfer {
  version: 1;
  commandId: string;
  connectionId?: string;
  ownerKey?: string;
  associatedAt?: number;
  key: string;
  native: NativeBinding;
  parent: NativeBinding<'folder'>;
  title: string;
  url: string | null;
  slot: ManagedSlot;
  /** Immutable transport destination. Never infer this from a later login. */
  owner: ManagedLibrary | null;
  copyPolicy?: import('./managed-client.js').ManagedSaveCommand['copyPolicy'];
  state: 'pending' | 'registered' | 'attention';
  createdAt: number;
  updatedAt: number;
  reason?: string;
}
export const localTransferKey = (commandId: string) => sourceKey('localSourceTransfer', commandId);
