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
  const parent: NativeBinding<'folder'> = { nativeId: node.id, dateAdded: node.dateAdded, kind: 'folder', deviceId: await captureDeviceId(),
    bindingId: input.captureIntentId, proof: { kind: 'explicitAdoption', id: input.commandId } };
  const command: PlannedNativeCommand = { commandId: input.commandId, ownerId: input.captureIntentId, connectionId: '', kind: 'bookmark', parent,
    title: input.title, logicalDigest: sourceDigest(input), deviceId: parent.deviceId,
    bookmark: { planId: input.captureIntentId, effectId: 'semantic', representation: { connectionId: '', itemId: content.itemId, purpose: 'semantic', sourceCollectionId: null, mountId: null }, url: input.url, scope, source: 'site-import' } };
  const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', identityDefinition(content.siteKey, content.identityVersion).adapterId);
  const policy = authority?.enabled && authority.connectionId ? await siteLedger.db.read<import('./layout.js').SourcePolicyRecord>('meta', `policy:${authority.connectionId}`) : undefined;
  const prepared = await managedSaves.prepareForSlot(command, { kind: 'bookmark', copy: { purpose: 'semantic', content: managedContent(content) } }, policy?.enabled ? policy.policy.copies : undefined);
  const managed = prepared.managed;
  if (!managed) return {};
  const client = await managedClientForLibrary(managed.library); await client.semanticProfile();
  const claim = await client.call<SemanticClaimResult>('managed.semantic.claim', { collectionId: managed.library.collectionId,
    copy: { purpose: 'semantic', content: managedContent(content) }, ownerId: input.commandId, replicaId: managed.command.replicaId });
  if (claim.status === 'waiting') throw new Error('semantic_save_pending');
  if (claim.status === 'claimed') managed.command.semanticClaim = claim.claim;
  return { managed, managedParent: parent };
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
