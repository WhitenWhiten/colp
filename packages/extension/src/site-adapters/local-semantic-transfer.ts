import { prepareLocalSlot, rememberLocalSourceSave } from './local-save-runtime.js';
import { managedContent } from './semantic-scope.js';
import { captureDeviceId } from '../sw/capture-history.js';
import type { CaptureScope } from '../capture/contracts.js';
import type { ContentBindingRow } from './content-bindings.js';
import type { NativeBinding } from './contracts.js';
/** Native success queues metadata only; it never waits for the server to adopt the association. */
export async function queueLocalSemanticAssociation(binding: ContentBindingRow, scope: CaptureScope) {
  if (!binding.native) return;
  if (binding.shared?.slot.kind === 'bookmark' && binding.shared.slot.copy.purpose === 'semantic') return;
  const node = (await chrome.bookmarks.get(binding.parentId).catch(() => []))[0];
  if (!node?.dateAdded) return;
  const parent: NativeBinding<'folder'> = { nativeId: node.id, dateAdded: node.dateAdded, deviceId: await captureDeviceId(),
    kind: 'folder', bindingId: binding.id, proof: { kind: 'explicitAdoption', id: binding.id } };
  const command = await prepareLocalSlot({ commandId: binding.commandId, kind: 'bookmark', ownerId: binding.id, logicalDigest: binding.requestDigest,
    connectionId: binding.connectionId ?? '', deviceId: parent.deviceId, parent, title: binding.title,
    bookmark: { planId: binding.id, effectId: 'semantic', representation: { connectionId: binding.connectionId ?? '', itemId: binding.content.itemId,
      purpose: 'semantic', sourceCollectionId: null, mountId: null, scopeId: binding.scopeId }, url: binding.url, scope, source: 'site-import' } },
  { kind: 'bookmark', copy: { purpose: 'semantic', content: managedContent(binding.content) } });
  await rememberLocalSourceSave(command, { status: 'confirmed', native: binding.native });
}
