import { createBundleStore, automationOwnerKey, bundleState } from '../automation/bundle-store.js';
import type { CreateEvidence } from '../automation/causation.js';
import { OBSERVATION_TTL_MS, SETTLE_MS, settleObservedCreate, type Observation, type ObservedPlacement, type ObservedPorts } from '../automation/observed-create.js';
import { decidePreSave } from '../automation/pre-save.js';
import { automationDatabase, type AutomationDatabase, type PlacementIntent } from '../automation/indexeddb-store.js';
import { RECEIPT_MAX_AGE_MS } from '../automation/receipt-sync.js';
import { recoverPlacementIntents } from '../automation/recovery.js';
import { newPlacementReceipt } from '../automation/receipt-sync.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { createLocalImportStore } from '../local-import/store.js';
import { presentSaveFeedback } from '../save-feedback.js';
import { observedSaveLine } from '../save-status.js';
import type { SyncScope } from '../sync-state-store.js';
import { automationArea, automationProjectionDeps, recordPlacementReceipt, sourceAutomationsPaused } from './automation.js';
import { hasBookmarkPermission, sw, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';
import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { OBSERVED_ALARM, type PendingObservation, type ObservationProblem, type ObservationStage } from '../automation/observed-queue.js';
import { observationProblem, observedProblemMessage } from '../automation/observed-problem.js';
import { scopeKey } from '../sync-state/scope-key.js';
import { logBackgroundFailure } from './background-failure.js';

/** Evaluation survives worker and browser stops. Before a native call, its
 * observation is atomically handed to a placement intent; only native evidence
 * can settle that intent, and evaluation can never issue its move again. */
const OBSERVED_KEY = 'known.automation.observed.v1';
const REMOVED_KEY = 'known.automation.removed.v1';
const IMPORT_KEY = 'known.automation.import.v1';
const MAX_REMOVED = 300;
/** A page re-created this soon after it was removed is an undo or a restore, not a new save. */
const REMOVED_TTL_MS = 10 * 60_000;
/** The browser reports an import's end; its last creations may still arrive just after. */
const IMPORT_GRACE_MS = 5_000;
/**
 * B5-3: a retained placement intent is re-checked after its native evidence failed, but never faster than this
 * cadence, doubling per attempt. It used to be re-armed at a fixed 5 s for as long as the intent lived (up to the
 * receipt lifetime), which for a deferred permission problem is a week of polling.
 */
const INTENT_RECOVERY_INITIAL_MS = 5_000;
const INTENT_RECOVERY_MAX_MS = 5 * 60_000;
/** Attempt and deadline state for that cadence. Session-scoped: it only paces this browser session's wakes. */
const INTENT_RECOVERY_KEY = 'known.automation.intent-recovery.v1';
/**
 * A recovery problem no wake can end: without the bookmark permission the native read is refused however often it
 * is retried. Such an intent waits for a permission grant, the account's own wake, or its receipt lifetime.
 */
const TERMINAL_RECOVERY_PROBLEMS: ReadonlySet<string> = new Set(['permission_required']);
const ROOT_TYPES = new Set(['bookmarks-bar', 'other', 'mobile']);
const LEGACY_ROOT_IDS = new Set(['1', '2', '3']);

interface RemovedUrl { readonly url: string; readonly at: number }
interface ImportWindow { readonly active: boolean; readonly at: number }
interface IntentRecoveryState { readonly attempts: number; readonly notBefore: number }

const session = {
  async get<T>(key: string, fallback: T): Promise<T> { return ((await chrome.storage.session.get(key))[key] as T | undefined) ?? fallback; },
  async set(key: string, value: unknown): Promise<void> { await chrome.storage.session.set({ [key]: value }); },
};
const wakes = new WeakMap<AutomationDatabase, { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }>();
let lane: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = lane.then(work, work); lane = run.catch(() => undefined); return run;
}

/** The scope bookmark capture uses (its evidence build may pin one). */
async function observedScope(): Promise<SyncScope | null> {
  return (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope();
}

/** Only an account with rules in force pays for observing; everyone else's bookmarks are left alone. */
async function rulesInForce(knownScope?: SyncScope): Promise<SyncScope | null> {
  const scope = knownScope ?? await observedScope();
  if (!scope || !await hasBookmarkPermission() || await sourceAutomationsPaused()) return null;
  const record = await createBundleStore(automationArea(), { serverOrigin: scope.serverOrigin, accountId: scope.accountId }).read();
  return bundleState(record, Date.now()).state === 'active' && record.bundle?.rules.length ? scope : null;
}

export function installObservedCreates(): void {
  const mark = (active: boolean) => () => { void session.set(IMPORT_KEY, { active, at: Date.now() } satisfies ImportWindow).catch(() => undefined); };
  try { chrome.bookmarks?.onImportBegan?.addListener(mark(true)); chrome.bookmarks?.onImportEnded?.addListener(mark(false)); }
  catch { /* Without import events, a Know-N import is still recognized; a browser import may be judged as new bookmarks. */ }
  // A granted bookmark permission retries terminal intents through the service
  // worker's single chrome.permissions.onAdded listener (see service-worker.ts):
  // registering a second listener here duplicated the event owner and made the
  // permission-grant path depend on listener registration order.
  void resumeObservedCreates().catch(error => logBackgroundFailure('startup.observed-creates', error));
}

/** Worker start, the automation alarm and Check now: finish moves a crash cut short, then judge what is due. */
export async function resumeObservedCreates(options: { readonly manual?: boolean; readonly retryTerminal?: boolean } = {}): Promise<void> {
  const scope = await observedScope();
  const database = automationDatabase();
  const now = Date.now();
  // A person's explicit retry and a permission grant are the two wakes that may re-attempt a terminal problem.
  const retryTerminal = options.manual === true || options.retryTerminal === true;
  await exclusive(async () => {
    if (scope) await migrateLegacyObservations(scope).catch(error => logBackgroundFailure('observation.legacy-migration', error));
    const ownerKey = scope ? automationOwnerKey(scope) : null;
    const due = await duePlacementIntents(ownerKey, now, retryTerminal);
    await recoverPlacementIntents({
      ownerKey, now,
      list: async () => due,
      remove: intentId => database.intents.remove(intentId),
      node: readNativeBookmark,
      record: intent => recordObservedPlacement(intent, intent.ownerKey),
      async abandon(intent) {
        if (!intent.observation) return;
        const problem = { stage: 'move', code: 'move_not_confirmed', retryable: false } as const;
        if (await database.observations.abandon(intent.intentId, problem)) await notifyProblem(intent.observation, problem);
      },
      defer: async (intent, recoveryProblem) => { await database.intents.defer(intent.intentId, recoveryProblem); },
    });
    if (ownerKey) await recordIntentRecovery(ownerKey, due, now).catch(error => logBackgroundFailure('observation.recovery-state', error));
  }).catch(error => logBackgroundFailure('observation.intent-recovery', error));
  await settleDue(now, options.manual);
}

/** A bookmark appeared outside the extension's own saves: judge it after the settle window. */
export async function observeCreatedBookmark(nativeId: string, node: { readonly url?: string; readonly title?: string; readonly parentId?: string; readonly dateAdded?: number }): Promise<void> {
  const observedAt = Date.now();
  if (node.url === undefined || !node.parentId) return;
  // B5-4: a browser import creates hundreds of pages that all classify as `import` and are then discarded. Return
  // before the bundle, pause, evidence and IndexedDB work the judgement would throw away anyway.
  const imported = await session.get<ImportWindow | null>(IMPORT_KEY, null).catch(() => null);
  if (importWindowActive(imported, observedAt)) return;
  const scope = await observedScope();
  if (!scope) return;
  let problem: ObservationProblem | undefined;
  const active = await rulesInForce(scope).catch(error => { problem = observationProblem('rules', error); return null; });
  if (!active && !problem) return;
  const ownerKey = automationOwnerKey(scope);
  const localCausation = await sessionCausation(observedAt, node.url).catch(() => {
    problem = observationProblem('evidence', new Error('observation_interrupted')); return undefined;
  });
  const observation: PendingObservation = { id: JSON.stringify([ownerKey, nativeId, node.dateAdded ?? observedAt]),
    ownerKey, scope, title: node.title ?? '', nativeId, url: node.url, parentId: node.parentId,
    dateAdded: node.dateAdded ?? null, observedAt, state: localCausation ? 'pending' : 'attention', attempts: 0, nextAttemptAt: observedAt + SETTLE_MS,
    ...(localCausation ? { localCausation } : {}), ...(problem ? { problem } : {}) };
  let backpressure = false;
  await exclusive(async () => {
    await requireObservedScope(observation);
    await automationDatabase().observations.save(observation).catch(async error => {
      // A full queue is backpressure, not this bookmark's problem: no notice, no wake. It clears as the queue settles.
      if (error instanceof Error && error.message === 'observation_queue_full') { backpressure = true; return; }
      await notifyProblem(observation, observationProblem('intent', error)); throw error;
    });
  });
  if (backpressure) return;
  if (problem) await notifyProblem(observation, problem);
  await scheduleObservedWake(observation.nextAttemptAt);
}

/** Old session entries have no account fence. Preserve an explanation, but never execute them under a new identity. */
async function migrateLegacyObservations(scope: SyncScope): Promise<void> {
  const legacy = await session.get<Observation[]>(OBSERVED_KEY, []);
  for (const item of legacy) await automationDatabase().observations.save({ ...item,
    id: `legacy:${item.nativeId}:${item.observedAt}`, ownerKey: automationOwnerKey(scope), scope, title: '',
    state: 'attention', attempts: 0, nextAttemptAt: item.observedAt,
    problem: { stage: 'intent', code: 'observation_interrupted', retryable: false } });
  if (legacy.length) await chrome.storage.session.remove(OBSERVED_KEY);
}

async function scheduleObservedWake(at: number): Promise<void> {
  // The timer handles an awake worker; the alarm survives a worker stop.
  const database = automationDatabase(), previous = wakes.get(database);
  if (previous && previous.at <= at && previous.at > Date.now()) return;
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    wakes.delete(database);
    void resumeObservedCreates().catch(error => logBackgroundFailure('timer.observed-creates', error));
  }, Math.max(50, at - Date.now()));
  wakes.set(database, { at, timer });
  try { await chrome.alarms?.create(OBSERVED_ALARM, { when: at }); }
  catch (error) { logBackgroundFailure('alarm.observed-schedule', error); }
}

/** Removed pages are remembered briefly, so their undo or restore is not taken for a new save. */
export async function observeRemovedBookmark(removal: { readonly node?: { readonly url?: string; readonly children?: readonly unknown[] } | null }): Promise<void> {
  const urls: string[] = [], pending = removal.node ? [removal.node] : [];
  while (pending.length && urls.length < MAX_REMOVED) {
    const node = pending.pop() as { url?: string; children?: unknown[] };
    if (typeof node.url === 'string') urls.push(node.url);
    pending.push(...(node.children ?? []) as typeof pending);
  }
  if (!urls.length || !await rulesInForce()) return;
  const now = Date.now();
  await exclusive(async () => {
    const kept = (await session.get<RemovedUrl[]>(REMOVED_KEY, [])).filter((item) => now - item.at < REMOVED_TTL_MS);
    await session.set(REMOVED_KEY, [...kept, ...urls.map((url) => ({ url, at: now }))].slice(-MAX_REMOVED));
  });
}

/** Judge every observation whose settle window has passed; also run on the automation alarm after a worker restart. */
export function settleDue(now = Date.now(), manual = false): Promise<void> {
  return exclusive(async () => {
    const database = automationDatabase(), scope = await observedScope();
    if (!scope) return;
    const ownerKey = automationOwnerKey(scope);
    for (const pending of await database.observations.list()) {
      if (pending.ownerKey !== ownerKey) continue;
      try {
        const entry = await database.observations.claim(pending.id, now, manual);
        if (!entry) continue;
        await scheduleObservedWake(now + 5_000);
        await processObservation(entry);
      } catch (error) { logBackgroundFailure('observation.recovery', error); }
    }
    const remaining = (await database.observations.list()).filter(item => item.ownerKey === ownerKey && item.state !== 'attention');
    const intentDeadline = remaining.length ? undefined : await nextIntentRecoveryDeadline(ownerKey, database, now);
    if (remaining.length) await scheduleObservedWake(Math.min(...remaining.map(item => item.nextAttemptAt)));
    else if (intentDeadline !== undefined) await scheduleObservedWake(intentDeadline);
    else {
      const wake = wakes.get(database);
      if (wake) clearTimeout(wake.timer);
      wakes.delete(database);
      await chrome.alarms?.clear(OBSERVED_ALARM);
    }
  });
}

/**
 * The intents a recovery pass may read now (B5-3). A retryable problem waits for its own deadline, so the cadence
 * grows instead of polling every five seconds.
 *
 * A terminal problem is a missing bookmark permission: no wake can grant it, so the cadence never re-arms one. The
 * intent is read again only when that precondition can have changed — the permission is currently granted (a grant
 * that arrived while the worker was stopped, or a classification the browser has since stopped repeating), or a
 * person asked with Check now. While the permission really is absent it is not read, however often a pass runs.
 */
async function duePlacementIntents(ownerKey: string | null, now: number, retryTerminal: boolean): Promise<PlacementIntent[]> {
  const states = await intentRecoveryStates();
  const permissionGranted = retryTerminal || await hasBookmarkPermission().catch(() => false);
  return (await automationDatabase().intents.list()).filter(intent => {
    if (intent.ownerKey !== ownerKey) return now - intent.createdAt > RECEIPT_MAX_AGE_MS; // another account's stale intent
    if (now - intent.createdAt > RECEIPT_MAX_AGE_MS) return true;
    if (intent.recoveryProblem && TERMINAL_RECOVERY_PROBLEMS.has(intent.recoveryProblem)) return permissionGranted;
    if (retryTerminal) return true;
    const state = states[intent.intentId];
    return state === undefined || now >= state.notBefore;
  });
}

/**
 * When the retained intents deserve their next recovery pass, if they ever do. Terminal problems have no deadline:
 * the permission grant, Check now or the receipt expiry wakes them instead of a timer that cannot change anything.
 */
async function nextIntentRecoveryDeadline(ownerKey: string, database: AutomationDatabase, now: number): Promise<number | undefined> {
  const intents = (await database.intents.list()).filter(intent => intent.ownerKey === ownerKey);
  if (!intents.length) return undefined;
  const states = await intentRecoveryStates();
  const deadlines = intents
    .filter(intent => !intent.recoveryProblem || !TERMINAL_RECOVERY_PROBLEMS.has(intent.recoveryProblem))
    .map(intent => states[intent.intentId]?.notBefore ?? now + INTENT_RECOVERY_INITIAL_MS);
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

/** Attempt state for the intent cadence; a malformed entry is simply forgotten. */
async function intentRecoveryStates(): Promise<Record<string, IntentRecoveryState>> {
  const stored = await session.get<Record<string, IntentRecoveryState>>(INTENT_RECOVERY_KEY, {});
  const states: Record<string, IntentRecoveryState> = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return states;
  for (const [intentId, value] of Object.entries(stored)) {
    if (!value || typeof value !== 'object') continue;
    const { attempts, notBefore } = value as Partial<IntentRecoveryState>;
    if (typeof attempts === 'number' && Number.isFinite(attempts)
        && typeof notBefore === 'number' && Number.isFinite(notBefore)) states[intentId] = { attempts, notBefore };
  }
  return states;
}

/** Records the pass for every intent it read and that still needs recovery, so the next wake waits longer. */
async function recordIntentRecovery(ownerKey: string, attempted: readonly PlacementIntent[], now: number): Promise<void> {
  const attemptedIds = new Set(attempted.map(intent => intent.intentId));
  const states = await intentRecoveryStates();
  const next: Record<string, IntentRecoveryState> = {};
  for (const intent of (await automationDatabase().intents.list()).filter(item => item.ownerKey === ownerKey)) {
    // A terminal problem waits for a permission grant, not for a cadence, and has no deadline to record (B5-3).
    if (intent.recoveryProblem && TERMINAL_RECOVERY_PROBLEMS.has(intent.recoveryProblem)) continue;
    const prior = states[intent.intentId];
    if (!attemptedIds.has(intent.intentId)) {
      next[intent.intentId] = prior ?? { attempts: 0, notBefore: now };
      continue;
    }
    const attempts = (prior?.attempts ?? 0) + 1;
    next[intent.intentId] = { attempts, notBefore: now + Math.min(INTENT_RECOVERY_MAX_MS,
      INTENT_RECOVERY_INITIAL_MS * 2 ** Math.min(attempts - 1, 8)) };
  }
  await session.set(INTENT_RECOVERY_KEY, next);
}

async function processObservation(entry: PendingObservation): Promise<void> {
  const database = automationDatabase();
  const progress: { stage: ObservationStage; placementId?: string } = { stage: 'bookmark' };
  try {
    const ports = observedPorts(entry, value => { progress.stage = value; }, id => { progress.placementId = id; });
    const outcome = await settleObservedCreate(ports, entry);
    if (outcome.kind === 'skipped' && outcome.reason === 'stale') throw new Error('observation_expired');
    await database.observations.remove(entry.id);
  } catch (error) {
    const problem = observationProblem(progress.stage, error);
    const failed = await database.observations.fail(entry.id, problem, Date.now());
    if (failed) {
      if (!entry.problem || entry.problem.code !== failed.problem?.code || entry.problem.retryable !== failed.problem?.retryable)
        await notifyProblem(entry, failed.problem!);
    } else if (progress.placementId) {
      // Handoff committed: retain only native reconciliation, never another move attempt.
      if (await database.intents.defer(progress.placementId, progress.stage === 'receipt' ? 'receipt_unavailable'
        : problem.code === 'permission_required' ? 'permission_required' : 'bookmark_unavailable')) await notifyProblem(entry, problem);
    }
  }
}

async function notifyProblem(entry: PendingObservation, problem: ObservationProblem): Promise<void> {
  const text = observedProblemMessage(problem);
  await presentSaveFeedback({ code: 'automation_unavailable', entry: 'page', message: text, nativeId: entry.nativeId })
    .catch(error => logBackgroundFailure('observation.notice', error));
  void chrome.runtime.sendMessage({ kind: 'known.automation.notice', text, attention: true }).catch(() => undefined);
}

async function requireObservedScope(entry: PendingObservation): Promise<SyncScope> {
  const scope = await observedScope();
  if (!scope || scopeKey(scope) !== scopeKey(entry.scope)) throw new Error('observation_context_changed');
  return scope;
}

async function readNativeBookmark(nativeId: string): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  try {
    const [node] = await chrome.bookmarks.get(nativeId);
    if (!node) throw new Error('bookmark_lookup_empty');
    return node;
  } catch (error) { if (classifyBookmarkApiFailure(error) === 'not_found') return null; throw error; }
}

function observedPorts(entry: PendingObservation, mark: (stage: ObservationStage) => void, intending: (id: string) => void): ObservedPorts {
  return {
    now: Date.now,
    async node(nativeId) { mark('bookmark'); await requireObservedScope(entry); return readNativeBookmark(nativeId); },
    async intakeRoot(folderNativeId) {
      mark('bookmark');
      const folder = await readNativeBookmark(folderNativeId);
      if (!folder || folder.url !== undefined || folder.parentId !== '0' || folder.unmodifiable) return false;
      return folder.folderType !== undefined ? ROOT_TYPES.has(folder.folderType) : LEGACY_ROOT_IDS.has(folder.id);
    },
    async evidence() { mark('evidence'); return createEvidence(entry, await requireObservedScope(entry)); },
    async decide(input) {
      mark('rules');
      const scope = await requireObservedScope(entry);
      if (await sourceAutomationsPaused()) return null;
      const record = await createBundleStore(automationArea(), scope).read();
      return decidePreSave({ record, now: Date.now(), scope, deps: automationProjectionDeps(scope) }, input);
    },
    id: () => crypto.randomUUID(),
    async intend(placement, from) {
      mark('intent'); intending(placement.id);
      await requireObservedScope(entry);
      if (Date.now() - entry.observedAt > OBSERVATION_TTL_MS) throw new Error('observation_expired');
      await automationDatabase().observations.handoff(entry, { ...placement, intentId: placement.id,
        fromParentId: from.parentId, dateAdded: from.dateAdded, ownerKey: entry.ownerKey, createdAt: Date.now() });
    },
    async move(nativeId, parentNativeId) {
      mark('move');
      if (await sourceAutomationsPaused()) throw new Error('sourceAutomationPaused');
      await requireObservedScope(entry);
      if (Date.now() - entry.observedAt > OBSERVATION_TTL_MS) throw new Error('observation_expired');
      await personalBookmarks.move(nativeId, { parentId: parentNativeId });
    },
    async record(placement) {
      mark('receipt');
      await recordObservedPlacement(placement, entry.ownerKey);
      await automationDatabase().intents.remove(placement.id);
    },
    async notify({ automation, title, nativeId }) {
      const line = observedSaveLine(automation, title);
      if (!line) return;
      await presentSaveFeedback({ code: 'saved', entry: 'page', message: line.text, nativeId })
        .catch(error => logBackgroundFailure('observation.notice', error));
      void chrome.runtime.sendMessage({ kind: 'known.automation.notice', text: line.text, attention: line.attention }).catch(() => undefined);
    },
  };
}

/** A browser import and its short grace tail: every creation in it classifies as `import` and is not intake. */
function importWindowActive(imported: ImportWindow | null, at: number): boolean {
  return Boolean(imported && (imported.active || at - imported.at < IMPORT_GRACE_MS));
}

async function sessionCausation(observedAt: number, url: string) {
  const imported = await session.get<ImportWindow | null>(IMPORT_KEY, null);
  const removed = await session.get<RemovedUrl[]>(REMOVED_KEY, []);
  return { importing: importWindowActive(imported, observedAt),
    recentlyRemoved: removed.some(item => item.url === url && observedAt - item.at < REMOVED_TTL_MS) };
}

async function createEvidence(observation: PendingObservation, scope: SyncScope): Promise<CreateEvidence> {
  if (!observation.localCausation) throw new Error('observation_interrupted');
  const events = await syncState.listBookmarkEventsByNative(scope, observation.nativeId, 0, 50);
  const create = events.find((event) => event.kind === 'create');
  const context = create?.details.context;
  const mapping = await syncState.getMappingByNativeId(scope, observation.nativeId);
  const current = await sessionCausation(observation.observedAt, observation.url);
  const knownImport = (await createLocalImportStore().plan())?.state === 'running';
  return {
    localCreate: create ? { placement: Boolean(context && typeof context === 'object' && !Array.isArray(context) && 'placement' in context) }
      // A create the queue staged but has not written an event for yet still shows as a provisional mapping.
      : mapping?.colpId.startsWith('pending-') ? { placement: false } : null,
    projected: Boolean(mapping && !mapping.colpId.startsWith('pending-')),
    importing: knownImport || current.importing || observation.localCausation.importing,
    recentlyRemoved: current.recentlyRemoved || observation.localCausation.recentlyRemoved,
  };
}

/** The receipt carries the placement's id, so writing it again after a crash adds nothing. */
async function recordObservedPlacement(placement: ObservedPlacement, ownerKey: string): Promise<void> {
  const { automation } = placement;
  if (!automation.destination) return;
  const { rule } = automation;
  await recordPlacementReceipt(newPlacementReceipt({
    ownerKey,
    collectionId: automation.collectionId, replicaId: automation.replicaId, generation: automation.generation, path: 'observed',
    rule: { id: rule.id, name: rule.name, revision: rule.revision, bindingRevision: rule.bindingRevision, bundleRevision: automation.bundleRevision },
    destination: automation.destination, destinationTitle: automation.folderTitle ?? '', satisfies: [...automation.satisfies],
    ...(placement.beforeFolder ? { beforeFolder: placement.beforeFolder } : {}), page: placement.page, native: placement.native,
  }, placement.native.movedAt, placement.id));
}
