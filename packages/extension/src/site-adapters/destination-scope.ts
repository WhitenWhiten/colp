import type { DestinationOwner } from './copy-identity.js';
import { managedLibraryKey } from './copy-identity.js';

export function destinationScopeId(owner: DestinationOwner | null | undefined, deviceId: string): string {
  return owner?.accountId && owner.collectionId
    ? managedLibraryKey({ serverOrigin: owner.serverOrigin, accountId: owner.accountId, collectionId: owner.collectionId })
    : JSON.stringify(['local', deviceId]);
}
