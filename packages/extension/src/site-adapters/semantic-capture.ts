import { siteLedger } from './source-runtime.js';
import { identityDefinition } from './registry.js';
import type { CaptureScope, CaptureTask } from '../capture/contracts.js';
import type { ContentIdentity, NativeBinding } from './contracts.js';
import type { ManagedDestination, SemanticClaimResult } from './managed-client.js';
import type { PlannedNativeCommand } from './planned-types.js';
import { managedContent } from './semantic-scope.js';
import { sourceDigest } from './source-db.js';
import { managedSaves, managedClientForLibrary } from './managed-runtime.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertCaptureContent } from '../capture/content-binding.js';
import { assertCaptureScope } from '../sw/capture-native.js';

/** A popup and an automatic task reserve the same shared role before either can create it. */
export async function prepareSemanticCapture(input: { commandId: string; captureIntentId: string; parentId: string; title: string; url: string }, content: ContentIdentity, scope: CaptureScope) {
  const node = (await chrome.bookmarks.get(input.parentId))[0];
  if (!node || node.url || !node.dateAdded) throw new Error('bindingUnavailable');
  void content; void scope;
  return {} as { managed?: ManagedDestination; managedParent?: NativeBinding<'folder'> };
}

export async function releaseSemanticCaptureClaim(managed?: ManagedDestination) {
  if (!managed?.command.semanticClaim || managed.command.slot.kind !== 'bookmark') return;
  await (await managedClientForLibrary(managed.library)).call('managed.semantic.release', { collectionId: managed.library.collectionId,
    copy: managed.command.slot.copy, claim: managed.command.semanticClaim });
}
export async function saveSemanticCapture(task: CaptureTask, recover: boolean) {
  const intent = task.contentIntent;
  if (!intent?.managed || !intent.managedParent) throw new Error('content_binding_changed');
  const command: PlannedNativeCommand = { commandId: task.commandId, ownerId: task.captureId, connectionId: intent.connectionId ?? '', kind: 'bookmark',
    parent: intent.managedParent, title: task.title, logicalDigest: sourceDigest(intent.managed.command), deviceId: intent.managedParent.deviceId,
    managed: intent.managed };
  const authorize = async () => { await assertCaptureScope(task.scope); await assertCaptureContent(task); };
  let result = recover ? await managedSaves.recover(command) : null;
  if (!result) { await authorize(); result = await managedSaves.execute(command, authorize); }
  if (result.status === 'blocked') throw new Error(result.reason);
  return result.status === 'confirmed' ? { nativeId: result.native.nativeId, savedAt: result.native.dateAdded!,
    ...(result.reusedFrom ? { reuseMode: result.reusedFrom === 'semantic' ? 'reuse' as const : intent.managed.command.copyPolicy === 'singlePreferSemantic' ? 'reclassify' as const : 'suggest' as const } : {}) } : null;
}
