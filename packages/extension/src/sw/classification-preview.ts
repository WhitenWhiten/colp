import { classificationDestinationPolicy } from './classification-destination.js';
import type { ClassificationPreviewReply } from '../classification-preview-reply.js';
import type { AuthorityContext } from '../authority-fence.js';
import { reuseClassificationPreview, type ClassificationPreviewMessage } from '../classification-preview-store.js';
import { classificationTriggerReason } from '../classification-intent.js';
import { localClassificationEnabled, storedLocalClassification } from '../classification-local-session.js';
import { manualClassificationRequested } from '../manual-classification.js';
import { isActionPopup } from '../capture/messages.js';
import { assertCaptureScope, captureExistence, currentCaptureScope } from './capture-native.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { store } from './runtime.js';

/** All popup preview dispatches pass here; a DOM state never establishes bookmark identity. */
export async function runPopupClassification(message: ClassificationPreviewMessage, context: AuthorityContext, sender: chrome.runtime.MessageSender | undefined,
  execute: (message: ClassificationPreviewMessage) => Promise<ClassificationPreviewReply>): Promise<ClassificationPreviewReply> {
  const implicit = 'automatic' in message;
  if (implicit && (!sender || !await isActionPopup(sender) || !await manualClassificationRequested()
    || (await readEffectiveBookmarkPreferences()).captureMode !== 'manual')) {
    return { ok: false, error: 'manual_suggestions_disabled' };
  }
  const scope = await currentCaptureScope();
  const local = message.kind === 'known.classification.local-preview';
  if (!local) await store.fence.assertWritable(context.generation);
  if (implicit && !('bookmark' in message.document)) return { ok: false, error: 'manual_suggestions_disabled' };
  const reason = classificationTriggerReason(implicit && 'bookmark' in message.document
    ? { kind: 'form-open', existence: await captureExistence({ scope, url: message.document.bookmark.url }) }
    : { kind: 'user-request' });
  if (reason) return { ok: true, skipped: reason };
  if (implicit && local !== await localClassificationEnabled()) {
    return { ok: false, error: 'manual_suggestions_disabled' };
  }
  const destinationPolicy = await classificationDestinationPolicy.snapshot();
  if (!local) await classificationDestinationPolicy.assertCloudSupported();
  const providerGeneration = local ? (await storedLocalClassification())?.generation ?? null : null;
  const reply = await reuseClassificationPreview({ message, execute, storage: chrome.storage.session,
    binding: { ...scope, providerGeneration, destinationPolicyDigest: destinationPolicy.digest } });
  // Replayed suggestions cross the same authority boundary as live cloud results.
  if (!local) { await store.fence.assertWritable(context.generation); await assertCaptureScope(scope); }
  await classificationDestinationPolicy.assertCurrent(destinationPolicy.digest);
  if (reply.nativeFolder) await classificationDestinationPolicy.assertAllowed(reply.nativeFolder.nativeId, destinationPolicy.digest);
  return { ...reply, destinationPolicyDigest: destinationPolicy.digest };
}
