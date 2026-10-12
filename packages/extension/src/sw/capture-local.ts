import { isSubscriptionExcluded, personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { readCaptureControl } from '../capture/control.js';
import type { AuthorityContext } from '../authority-fence.js';
import type { CaptureTask } from '../capture/contracts.js';
import type { CaptureStore } from '../capture/store.js';
import { localClassificationEnabled, localClassificationCanRunOffline } from '../classification-local-session.js';
import { classificationDocument, classificationTriggerReason } from '../classification-intent.js';
import { handleBookmarkPreferencesRequest } from './bookmark-preferences.js';
import { effectiveAiTagMode } from '../bookmark-preferences.js';
import { nativeCaptureLocation } from './capture-native.js';
import { runLocalClassification } from './classification-local.js';
import { workCoordinator } from './runtime.js';
import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';

/** This browser's tag preference for an automatic save (local: through the user's own AI). */
export async function captureTagMode(local: boolean) {
  const preference = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
  return effectiveAiTagMode(preference.ok ? preference.preferences : undefined, local);
}

/** Why a local automatic step must not act now; null when it may. */
async function stopReason(task: CaptureTask): Promise<string | null> {
  const preference = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
  if (!preference.ok || preference.preferences.captureMode !== 'automatic') return 'manual';
  if (preference.conflict) return 'preferences_conflict';
  const control = await readCaptureControl(task.scope);
  if (control.generation !== task.controlGeneration) return 'execution_control_changed';
  if (control.paused) return 'paused';
  if (control.manualOverride) return 'manual';
  if (Date.now() - task.createdAt >= 86400000) return 'authorization_expired';
  if (!await localClassificationEnabled()) return 'manual';
  if (await isSubscriptionExcluded(task.nativeId!)) return 'subscription_capture_excluded';
  const [native] = await chrome.bookmarks.get(task.nativeId!).catch(() => []);
  // Any user rename or move since the save wins over the model.
  if (!native || native.url !== (task.localLocation?.url ?? task.url) || native.title !== task.title
    || native.parentId !== task.targetNativeId) return 'manually_edited';
  if (!preference.preferences.resumeClassificationWhenOnline && Date.now() - task.createdAt > 60000) return 'resume_disabled';
  if (navigator.onLine === false && !await localClassificationCanRunOffline()) return 'offline';
  return null;
}

/**
 * Local-first automatic classification: the same "classify and apply" semantics
 * as the server path, but the provider is the user's own key, the candidates are
 * this browser's folders and applying is a native move. No account, collection,
 * credits or server decision is involved. The user can still change the folder
 * from the result panel, the options page or Know-N.
 */
export function classifyLocalCapture(task: CaptureTask, ledger: CaptureStore): Promise<CaptureTask> {
  return workCoordinator.run('local-classification', context => classifyOnce(task, ledger, context).catch(async error => {
    const current = await ledger.get(task.scope, task.captureId);
    // A concurrent writer won the CAS: the durable intent is intact and the next resume continues it.
    if (error instanceof Error && error.message === 'capture_revision_conflict') return current ?? task;
    // Any other failure becomes a readable reason instead of a save that silently stays "waiting".
    if (!current || !['waiting', 'running'].includes(current.classification)) return current ?? task;
    const next: CaptureTask = { ...current, revision: current.revision + 1, updatedAt: Date.now(), classification: 'manual',
      reason: 'local_classification_failed',
      ...(current.local ? { local: { ...current.local, state: current.local.state === 'running' ? 'unknown' as const : current.local.state } } : {}) };
    await ledger.update(next, current.revision).catch(() => undefined);
    return next;
  }));
}

async function classifyOnce(task: CaptureTask, ledger: CaptureStore, context: AuthorityContext): Promise<CaptureTask> {
  let current = await ledger.get(task.scope, task.captureId) ?? task;
  const write = async (patch: Partial<CaptureTask>, attempts = 3): Promise<CaptureTask> => {
    const next: CaptureTask = { ...current, ...patch, revision: current.revision + 1, updatedAt: Date.now() };
    try { await ledger.update(next, current.revision); current = next; return next; }
    catch (error) {
      // A sync-status write won the CAS: re-apply onto the fresh record, unless the user acted meanwhile.
      const fresh = error instanceof Error && error.message === 'capture_revision_conflict' ? await ledger.get(task.scope, task.captureId) : null;
      if (!fresh || attempts <= 1) throw error;
      if (fresh.manualFence !== current.manualFence) return fresh;
      current = fresh; return write(patch, attempts - 1);
    }
  };
  const local = current.local;
  if (!local || !current.nativeId || classificationTriggerReason({ kind: 'saved-capture', task: current })) return current;
  // A restart during the provider call: its command id is spent, so never call again.
  if (local.state === 'running') return write({ classification: 'manual', reason: 'local_result_unknown', local: { ...local, state: 'unknown' } });
  const stop = await stopReason(current);
  if (stop) return write({ reason: stop, ...(stop === 'offline' ? {} : { classification: 'manual' as const }),
    ...(stop === 'manually_edited' ? { manualFence: current.manualFence + 1 } : {}) });
  const commandId = crypto.randomUUID(), tagMode = await captureTagMode(true);
  await write({ classification: 'running', reason: null, local: { ...local, commandId, state: 'running', fromNativeId: current.targetNativeId } });
  const document = classificationDocument(current, { tags: tagMode !== 'off' });
  const reply = await runLocalClassification({ document, commandId, generation: context.generation, signal: context.signal, excludeBookmarkId: current.nativeId! });
  current = await ledger.get(task.scope, task.captureId) ?? current;
  const running = current.local ?? local;
  if (!reply.ok) return write({ classification: 'manual', reason: reply.error, local: { ...running, state: 'unknown' } });
  const folder = reply.nativeFolder;
  if (!folder || reply.result.folder?.decision === 'later') {
    const folderCandidateCount = reply.result.candidateCoverage.l1Included;
    return write({ classification: 'manual', reason: folderCandidateCount === 0 ? 'local_no_folders' : 'local_no_folder',
      local: { ...running, state: 'later', folderCandidateCount } });
  }
  // The tags the model selected: Add writes them with the move, Suggest leaves them for the result panel.
  const selectedTags = reply.result.tags?.candidates.filter(candidate => candidate.selected !== false).map(candidate => candidate.tag).slice(0, 3) ?? [];
  const suggestion = { folderNativeId: folder.nativeId, folderTitle: folder.title,
    ...tagMode === 'suggest' && selectedTags.length ? { suggestedTags: selectedTags } : {} };
  const late = current.manualFence ? 'manually_edited' : await stopReason(current);
  if (late) return write({ classification: 'manual', reason: late, local: { ...running, ...suggestion, state: 'unknown' } });
  const addedTags = tagMode === 'add' ? selectedTags : [];
  if (addedTags.length) {
    const annotations = createBookmarkAnnotationStore();
    try {
      const [bookmark] = await chrome.bookmarks.get(current.nativeId!);
      if (!bookmark) throw new Error('capture_bookmark_changed');
      const row = await annotations.get(bookmark), base = { tags: row?.tags ?? [], note: row?.note ?? null };
      await annotations.save(bookmark, { tags: [...new Set([...base.tags, ...addedTags])], note: base.note }, { preserveTags: true, base });
    } finally { annotations.close(); }
  }
  if (folder.nativeId !== current.targetNativeId) await personalBookmarks.move(current.nativeId!, { parentId: folder.nativeId });
  const location = await nativeCaptureLocation(current.nativeId!, current.scope).catch(() => current.localLocation);
  return write({ classification: 'applied', classificationAppliedAt: Date.now(), reason: null, localLocation: location,
    local: { ...running, ...suggestion, state: folder.nativeId === current.targetNativeId ? 'kept' : 'applied' } });
}

/** Undo for a local automatic move: put the bookmark back where it was saved. */
export async function undoLocalCapture(task: CaptureTask, ledger: CaptureStore): Promise<CaptureTask> {
  const local = task.local;
  if (!task.nativeId || local?.state !== 'applied' || !local.fromNativeId) throw new Error('capture_undo_unavailable');
  const [native] = await chrome.bookmarks.get(task.nativeId).catch(() => []);
  if (!native || native.parentId !== local.folderNativeId) throw new Error('capture_bookmark_changed');
  await personalBookmarks.move(task.nativeId, { parentId: local.fromNativeId });
  const location = await nativeCaptureLocation(task.nativeId, task.scope).catch(() => task.localLocation);
  const next: CaptureTask = { ...task, revision: task.revision + 1, updatedAt: Date.now(), classification: 'manual',
    reason: 'classification_undone', localLocation: location, manualFence: task.manualFence + 1, local: { ...local, state: 'kept' } };
  await ledger.update(next, task.revision); return next;
}
