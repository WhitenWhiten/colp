import { inspectCaptureDecision } from './capture-result-recovery.js';
import { currentCaptureScope, assertCaptureScope } from './capture-native.js';
import { effectiveCaptureState, effectiveSaveState, readCaptureControl, updateCaptureControl } from '../capture/control.js';
import { canResumeCapture, type CaptureControlRequest, type CaptureRuntimeView } from '../capture/runtime-control.js';
import { captureStore, resumeCapture } from './capture.js';
import { handleBookmarkPreferencesRequest } from './bookmark-preferences.js';
import { createClassificationProductClient } from '../classification-product-client.js';
import { loadManifestCloud } from '../cloud-capability.js';
import { createCreditOverviewClient, resolveCreditBusinessAccountId } from '../credits-ledger.js';
import { hasBookmarkPermission } from './runtime.js';
import { captureTarget } from './capture-target.js';
import { FOLDER_DEFAULT_BINDING } from '../save-folder.js';
import { captureScopeKey, type CaptureScope, type CaptureTask } from '../capture/contracts.js';
import { t } from '../i18n.js';
import { localClassificationEnabled, localClassificationCanRunOffline } from '../classification-local-session.js';
export async function captureCreditQuote(scope: CaptureScope) {
  if (!scope.accountId || navigator.onLine === false) throw new Error('credit_price_unavailable');
  const businessAccountId = await resolveCreditBusinessAccountId({ serverOrigin: scope.serverOrigin, expectedSubject: scope.accountId, signal: AbortSignal.timeout(5000) });
  const cloud = await loadManifestCloud(scope.serverOrigin);
  const client = createCreditOverviewClient({ cloudEnabled: cloud, getAuthority: async () => {
    await assertCaptureScope(scope); return { status: 'connected', serverOrigin: scope.serverOrigin, accountKey: scope.accountId!,
      businessAccountId, generation: scope.authorityGeneration };
  } });
  const overview = await client.load(AbortSignal.timeout(5000));
  if (overview === 'unsupported') throw new Error('credit_price_unavailable');
  const price = overview.prices.find(price => price.operationType === 'bookmark.classify');
  if (!price) throw new Error('credit_price_unavailable');
  return { priceVersion: price.priceVersion, unitPoints: price.unitPoints, available: overview.balance.available };
}
async function tasksForScope(scope: CaptureScope) {
  const tasks: CaptureTask[] = []; let before: readonly [number, string] | undefined;
  for (;;) { const page = await captureStore.listForOwner(scope, before); tasks.push(...page); const last = page.at(-1);
    if (!last || page.length < 50) return tasks; before = [last.createdAt, last.captureId]; }
}
export async function captureRuntimeView(retry = true): Promise<CaptureRuntimeView> {
  const scope = await currentCaptureScope(), control = await readCaptureControl(scope);
  const preferences = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
  if (!preferences.ok) throw new Error('preferences_unavailable');
  const permission = await hasBookmarkPermission();
  let target: CaptureRuntimeView['target'] = null, targetError: string | null = null, policy = false, policyUnknown = false;
  if (permission) { try { target = await captureTarget(scope); } catch { targetError = t('capture_configuredFolderUnavailableChoose', 'The configured folder is unavailable. Choose a folder to continue.'); } }
  const local = await localClassificationEnabled();
  const localOffline = local && navigator.onLine === false && await localClassificationCanRunOffline();
  if (!local && control.consent && scope.accountId && navigator.onLine !== false && preferences.preferences.captureMode === 'automatic') {
    try {
      const capability = await createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId,
        assertCurrent: () => assertCaptureScope(scope) }).captureCapabilities();
      policy = capability !== 'unsupported' && capability.automaticFolderAvailable;
    } catch { policyUnknown = true; }
  }
  const tasks = await tasksForScope(scope), counts = { resumable: 0, suggestions: 0, checking: 0, manual: 0 };
  for (const task of tasks) {
    if (task.automatic?.applySubmitted && task.classification !== 'applied' || task.automatic && !task.automatic.decision) counts.checking++;
    else if (task.automatic?.decision?.status === 'suggested' && !task.automatic.applySubmitted) counts.suggestions++;
    else if (canResumeCapture(task, scope, Date.now())) counts.resumable++;
    else if (task.automaticIntent && task.classification === 'manual') counts.manual++;
  }
  let classificationState: string = !local && !control.consent ? 'off' : effectiveCaptureState(preferences.preferences, control, { account: Boolean(scope.accountId), permission, policy,
    collectionId: scope.collectionId, now: Date.now(), online: navigator.onLine, conflict: preferences.conflict, inRange: target?.inRange ?? false, local, localOffline });
  if (classificationState === 'policy_unavailable' && policyUnknown) classificationState = 'policy_unknown';
  if (classificationState === 'automatic' && !local) {
    try {
      const quote = await captureCreditQuote(scope);
      if (!control.consent || quote.priceVersion !== control.consent.priceVersion || quote.unitPoints > control.consent.maxPoints) classificationState = 'authorization_required';
      else if (quote.available < quote.unitPoints) classificationState = 'credits_required';
    } catch { classificationState = 'credits_unavailable'; }
  }
  await assertCaptureScope(scope);
  if ((await readCaptureControl(scope)).generation !== control.generation) {
    if (retry) return captureRuntimeView(false); throw new Error('capture_control_conflict');
  }
  const state = effectiveSaveState(preferences.preferences, control, { permission, target: Boolean(target) });
  return { ok: true, scopeKey: captureScopeKey(scope), control, mode: preferences.preferences.captureMode ?? 'manual', pending: preferences.pending, state, classificationState, permission,
    signedIn: Boolean(scope.accountId), local, target, targetError, counts };
}
export async function handleCaptureControl(request: CaptureControlRequest) {
  if (request.kind === 'known.capture.control') return captureRuntimeView();
  const scope = await currentCaptureScope();
  if (request.kind === 'known.capture.control.quote') return { ok: true, quote: await captureCreditQuote(scope) };
  if (request.scopeKey !== captureScopeKey(scope)) throw new Error('capture_scope_changed');
  const fingerprint = JSON.stringify(request), previous = await readCaptureControl(scope);
  if (previous.lastCommand?.id === request.commandId) {
    if (previous.lastCommand.fingerprint !== fingerprint) throw new Error('command_id_reused');
    if (request.kind === 'known.capture.control.change' && request.action === 'resume') await resumeEligible(scope, previous.generation);
    return captureRuntimeView();
  }
  let consent = previous.consent, values: Record<string, unknown> = {};
  if (request.kind === 'known.capture.control.authorize') {
    if (request.collectionId !== scope.collectionId) throw new Error('capture_scope_changed');
    const target = await captureTarget(scope), quote = await captureCreditQuote(scope);
    if (!target.inRange) throw new Error('target_not_mapped');
    if (quote.priceVersion !== request.priceVersion || quote.unitPoints > request.maxPoints) throw new Error('credit_price_changed');
    if (quote.available < quote.unitPoints) throw new Error('insufficient_credits');
    consent = { collectionId: request.collectionId, priceVersion: request.priceVersion, maxPoints: request.maxPoints,
      periodPoints: request.periodPoints, expiresAt: Date.now() + 86400000 };
  }
  if (request.kind === 'known.capture.control.target') {
    await captureTarget(scope, request.nativeId);
    values = { [FOLDER_DEFAULT_BINDING]: { collectionId: scope.collectionId ?? 'device', folderNativeId: request.nativeId } };
  }
  await assertCaptureScope(scope);
  const next = await updateCaptureControl(scope, current => {
    if (current.lastCommand?.id === request.commandId) { if (current.lastCommand.fingerprint !== fingerprint) throw new Error('command_id_reused'); return current; }
    if (current.generation !== request.generation) throw new Error('capture_control_conflict');
    return { ...current, generation: current.generation + 1,
      ...(request.kind === 'known.capture.control.change' ? { paused: request.action === 'pause' } : {}),
      ...(request.kind === 'known.capture.control.authorize' ? { consent } : {}), lastCommand: { id: request.commandId, fingerprint } };
  }, values);
  if (request.kind === 'known.capture.control.change' && request.action === 'resume') {
    await resumeEligible(scope, next.generation);
  }
  return captureRuntimeView();
}

async function resumeEligible(scope: CaptureScope, generation: number) {
    for (const task of await tasksForScope(scope)) if (canResumeCapture(task, scope, Date.now())) {
      const resumed: CaptureTask = { ...task, controlGeneration: generation, classification: 'waiting', reason: null, revision: task.revision + 1, updatedAt: Date.now() };
      try { await captureStore.update(resumed, task.revision); void resumeCapture(resumed).catch(() => undefined); }
      catch { /* Concurrent manual edits win; no stale task is dispatched. */ }
    }
    for (const task of await tasksForScope(scope)) if (task.automatic && task.classification !== 'applied') {
      try { await inspectCaptureDecision(task, captureStore); } catch { /* Keep unknown results for explicit read-only retry. */ }
    }
}
