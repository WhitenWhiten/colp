import type { ContentBindingRow } from './content-bindings.js';
import { destinationScopeId } from './destination-scope.js';
import { localTransferKey, type LocalCopyTransfer } from './local-identity.js';
import { get } from './source-db.js';

/** Recover pre-isolation records from retained ownership, never from the next login. */
export async function provenBindingScope(tx: IDBTransaction, binding: ContentBindingRow, deviceId: string): Promise<string | undefined> {
  const owner = binding.shared?.library ?? binding.managed?.library;
  if (owner) return destinationScopeId(owner, deviceId);
  const original = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(binding.commandId));
  const rebound = await get<{ commandId: string }>(tx, 'meta', `localOwnerBinding:${binding.commandId}`);
  const transfer = rebound ? await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(rebound.commandId)) : original;
  if (transfer && binding.native?.nativeId === transfer.native.nativeId && binding.native.dateAdded === transfer.native.dateAdded)
    return destinationScopeId(transfer.owner, deviceId);
  if (binding.scopeVersion === 2 || binding.scopeId && binding.scopeId !== destinationScopeId(null, deviceId)) return binding.scopeId;
  return undefined;
}
