import { DEVICE_BRIDGE_KEY, DEVICE_BRIDGE_STATUS_KEY } from '../automation/device-bridge.js';
import { automationRefreshProblem } from '../automation/refresh-problem.js';
import type { BundleAckInput } from '@know-n/colp/automation';
import { PAUSE_KEY, automationsPaused, createPauseStatusStore, pauseStatusDue, readPauseStatus } from '../automation/pause-status.js';
import { acknowledgeRuleBundle, fetchRuleBundle, postIntakeReceipt, type DeviceAuthority, type DeviceProblem } from '../automation/device-client.js';
import { readReplicaDeviceId } from '../automation/device-identity.js';
import { projectRule, type ProjectionDeps } from '../automation/binding-projector.js';
import { automationOwnerKey, bundleState, createBundleStore, refreshDue, type AutomationOwner, type BundleRecord,
  type RefreshProblem } from '../automation/bundle-store.js';
import { ruleCollectionId } from '../automation/runtime-profile.js';
import { ruleMatchView } from '../automation/rule-match.js';
import { createReceiptStore, newPlacementReceipt, settled, syncReceipts, type PlacementReceipt } from '../automation/receipt-sync.js';
import { syncReceiptEvidence } from '../automation/receipt-evidence.js';
import { decidePreSave, type PreSaveDecision, type PreSaveInput } from '../automation/pre-save.js';
import { createServerStatusStore, readServerStatus, serverStatusDue } from '../automation/server-status.js';
import { activityStatusDue, createActivityStatusStore, readActivitySummary } from '../automation/activity-status.js';
import { digestIndicator, toolbarBadge, type DigestIndicator } from '../automation/digest-indicator.js';
import { showAutomationBadge, writeAutomationBadge } from '../action-badge.js';
import { readSaveFeedback, saveFeedbackIsError } from '../save-feedback.js';
import { AUTOMATION_CHANGED_KEY, type AutomationMatchView, type AutomationPlacementView, type AutomationRequest, type AutomationResponse, type AutomationRuleView, type AutomationServerView,
  type AutomationStateView, type SavingFlowView } from '../automation/messages.js';
import { isAccountAutomation, type CaptureScope, type CaptureTask } from '../capture/contracts.js';
import { currentCaptureScope } from './capture-native.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { readCaptureControl } from '../capture/control.js';
import { localClassificationEnabled } from '../classification-local-session.js';
import { manualClassificationRequested } from '../manual-classification.js';
import { automationDatabase } from '../automation/indexeddb-store.js';
import type { SyncScope } from '../sync-state-store.js';
import { ensurePeriodicAlarm } from './reconcile-alarm.js';
import { browserListViews, browserPlacementViews, browserPreSaveDecision, recordBrowserPlacement, retireMovedBrowserRules,
  type AccountLink, type AccountRuleForOverlap, type BrowserPreSaveDecision } from './automation-browser.js';
import { browserRunViews } from './automation-run.js';
import { mappingLooksAuthoritative } from '../save-status.js';
import { t } from '../i18n.js';
import { extensionOrigin, hasBookmarkPermission, store, syncState } from './runtime.js';
import { currentSyncScope, loadConfig, pushSessionAuthority } from './scope.js';

/** Bundle and receipts live in the automation IndexedDB store. */
export const automationArea = () => automationDatabase().area();

/**
 * Keeps this browser's copy of the account's rule bundle current.
 *
 * The bundle is refreshed on a five-minute alarm (the pause propagation bound
 * the Automations page promises), when Options asks, and after sign-in. A
 * failed refresh never removes the installed bundle: it stays in force until
 * it expires, and the Options page shows how old it is.
 */
export const AUTOMATION_ALARM = 'known-automation';
export const AUTOMATION_REFRESH_MINUTES = 5;
const DEVICE_KEY = 'known.automation.device.v1';
const pauseArea = () => ({ get: async (key: string) => (await chrome.storage.local.get(key))[key],
  set: async (key: string, value: unknown) => chrome.storage.local.set({ [key]: value, [AUTOMATION_CHANGED_KEY]: crypto.randomUUID() }) });

let inFlight: { readonly promise: Promise<void>; readonly manual: boolean } | undefined;
let accountEpoch = 0;

async function currentOwner(): Promise<AutomationOwner | null> {
  const credential = await store.loadCredential().catch(() => null);
  return credential?.subject ? { serverOrigin: credential.serverOrigin, accountId: credential.subject } : null;
}

export function installAutomationRuntime(): void {
  void ensurePeriodicAlarm(chrome, AUTOMATION_ALARM, AUTOMATION_REFRESH_MINUTES);
  // The toolbar forgets its badge with the browser; the last answer is put back before the next read.
  void currentOwner().then((owner) => paintDigestBadge(owner, true)).catch(() => undefined);
  void refreshAutomation().catch(() => undefined);
}

/** One pass at a time. "Check now" during a background pass runs right after it, instead of being folded into it. */
export function refreshAutomation(options: { readonly manual?: boolean } = {}): Promise<void> {
  const manual = options.manual === true;
  if (inFlight && (inFlight.manual || !manual)) return inFlight.promise;
  const before = inFlight?.promise.catch(() => undefined) ?? Promise.resolve();
  const current = { manual, promise: before.then(() => run(manual)).finally(async () => {
    try { await (await import('./device-bridge.js')).refreshDeviceBridge(); } catch { /* Independent bridge failures never gate rule refresh. */ }
    if (inFlight === current) inFlight = undefined;
  }) };
  inFlight = current;
  return current.promise;
}

/** One worker pass: the server's status and the bundle when due, then any receipt whose retry is due. */
async function run(manual: boolean): Promise<void> {
  const epoch = accountEpoch;
  const owner = await currentOwner();
  if (!owner) { await paintDigestBadge(null); return; }
  const bundles = createBundleStore(automationArea(), owner), receipts = createReceiptStore(automationArea()), now = Date.now();
  const record = await bundles.read(), ownerKey = automationOwnerKey(owner);
  const isCurrent = async () => {
    const active = await currentOwner();
    return epoch === accountEpoch && active !== null && automationOwnerKey(active) === ownerKey;
  };
  const status = createServerStatusStore(automationArea(), ownerKey);
  const activity = createActivityStatusStore(automationArea(), ownerKey);
  const pause = createPauseStatusStore(pauseArea(), owner), pauseDue = pauseStatusDue(await pause.read(), now, manual);
  const activityDue = activityStatusDue(await activity.read(), now, manual);
  const bundleDue = manual || refreshDue(record, now);
  const statusDue = record.problem?.kind !== 'unavailable' && (manual || serverStatusDue(await status.read(), now));
  const receiptsDue = (await receipts.list()).some((receipt) => receipt.ownerKey === ownerKey && !settled(receipt.state) && receipt.nextAttemptAt <= now);
  if (!bundleDue && !receiptsDue && !statusDue && !activityDue && !pauseDue) return;
  // Read with the browser's web sign-in, apart from Sync's authority below.
  const reads = await Promise.allSettled([
    statusDue ? readServerStatus(owner.serverOrigin, owner.accountId).then(async (result) => { if (await isCurrent()) await status.apply(result, now); }) : null,
    activityDue ? readActivitySummary(owner.serverOrigin, owner.accountId).then(async (result) => { if (await isCurrent()) await activity.apply(result, now); }) : null,
    pauseDue ? readPauseStatus(owner).then(async (result) => { if (await isCurrent()) await pause.apply(result, now); }) : null,
  ]);
  // All reads settle before cleanup can run, including when one dependency rejects.
  if (!await isCurrent()) return;
  const failed = reads.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  if (statusDue || activityDue) await paintDigestBadge(owner);
  if (!bundleDue && !receiptsDue) return;
  let authority: Awaited<ReturnType<typeof pushSessionAuthority>>;
  try { authority = await pushSessionAuthority(); }
  catch (error) { if (bundleDue && await isCurrent()) await bundles.recordProblem(automationRefreshProblem(error), now); return; }
  if (!await isCurrent()) return;
  const device: DeviceAuthority = { serverOrigin: owner.serverOrigin, accessToken: authority.credential.accessToken,
    sessionId: authority.session.sessionId, origin: extensionOrigin() };
  if (bundleDue) await refreshBundle(owner, bundles, device);
  if (receiptsDue) await flushReceipts(owner, device, Number(authority.session.replicaLease.generation));
}

async function refreshBundle(owner: AutomationOwner, bundles: ReturnType<typeof createBundleStore>, device: DeviceAuthority): Promise<void> {
  const response = await fetchRuleBundle(device);
  if (!response.ok) { await bundles.recordProblem(refreshProblem(response.problem), Date.now()); return; }
  const outcome = await bundles.install(response.body, Date.now());
  // A rule the Owner moved to the account retires once the account's enabled copy is here (AW-71).
  const retired = await retireMovedBrowserRules(await accountRulesForOverlap(outcome.record, Date.now())).catch(() => []);
  for (const name of retired) {
    void chrome.runtime.sendMessage({ kind: 'known.automation.notice', attention: false,
      text: t('automation_movedToAccount', '“$1” now runs from your account, on every device.', name) }).catch(() => undefined);
  }
  const revision = response.body && typeof response.body === 'object' ? (response.body as { revision?: unknown }).revision : undefined;
  const binding = await store.loadBinding().catch(() => null);
  const deviceId = binding ? await replicaDeviceId(owner, binding.replicaId) : null;
  if (!deviceId || typeof revision !== 'string') return;
  const ack: BundleAckInput = { deviceId, bundleRevision: revision, status: outcome.kind === 'rejected' ? 'rejected' : 'applied',
    diagnostics: outcome.kind === 'rejected' ? [{ code: `bundle_${outcome.reason}`, severity: 'error', location: '/',
      message: 'The browser kept its previous rule bundle.' }] : [] };
  // The acknowledgement is advisory; a lost one changes nothing locally.
  await acknowledgeRuleBundle(device, ack, crypto.randomUUID()).catch(() => undefined);
}

async function flushReceipts(owner: AutomationOwner, device: DeviceAuthority, replicaGeneration: number): Promise<void> {
  const scope = await currentSyncScope().catch(() => null);
  if (!scope || !Number.isSafeInteger(replicaGeneration)) return;
  await syncReceipts(createReceiptStore(automationArea()), {
    ownerKey: automationOwnerKey(owner), collectionId: scope.collectionId, replicaId: scope.replicaId, generation: scope.generation,
    deviceId: await replicaDeviceId(owner, scope.replicaId), replicaGeneration, now: Date.now(),
    evidence: { ...syncReceiptEvidence(syncState, scope),
      present: async (nativeId) => (await chrome.bookmarks.get(nativeId).catch(() => [])).length > 0 },
    // Each attempt is a new command: the receipt id, not the command, makes a retry idempotent.
    post: (input) => postIntakeReceipt(device, input, crypto.randomUUID()),
  });
}

/** A new sign-in permits retrying a previously missing activity endpoint. */
export async function retryActivityAfterSignIn(owner: AutomationOwner): Promise<void> {
  await createActivityStatusStore(automationArea(), automationOwnerKey(owner)).retryAfterSignIn();
  await createPauseStatusStore(pauseArea(), owner).retryAfterSignIn();
}

/**
 * Signing out (AW-72, AU-33): the account's rule bundle, server status,
 * receipts, placement intents, pause, device id and toolbar count leave this
 * browser. Browser rules and the pages they filed belong to the browser, not
 * the account, and stay (design 01 §7.5).
 */
export async function clearAccountAutomation(owner: AutomationOwner): Promise<void> {
  accountEpoch++;
  const ownerKey = automationOwnerKey(owner);
  const clear = async () => {
    await automationDatabase().clearAccount(ownerKey);
    const local = await chrome.storage.local.get([PAUSE_KEY, DEVICE_KEY, DEVICE_BRIDGE_KEY, DEVICE_BRIDGE_STATUS_KEY]);
    const pause = local[PAUSE_KEY] as { ownerKey?: unknown } | undefined, device = local[DEVICE_KEY] as { key?: unknown } | undefined;
    const owned = [...local[DEVICE_BRIDGE_KEY] === ownerKey ? [DEVICE_BRIDGE_KEY] : [],
      ...(local[DEVICE_BRIDGE_STATUS_KEY] as { ownerKey?: string } | undefined)?.ownerKey === ownerKey ? [DEVICE_BRIDGE_STATUS_KEY] : [],
      ...pause?.ownerKey === ownerKey ? [PAUSE_KEY] : [], ...deviceOwner(device?.key) === ownerKey ? [DEVICE_KEY] : []];
    if (owned.length) await chrome.storage.local.remove(owned);
    await paintDigestBadge(await currentOwner());
  };
  await clear();
  // A pass that began before sign-out may still write; clear again once it ends, without waiting on it here.
  const pending = inFlight?.promise;
  if (pending) void pending.catch(() => undefined).then(clear).catch(() => undefined);
}
/** The account a cached device id was read for (replicaDeviceId's key). */
function deviceOwner(key: unknown): unknown {
  try { return typeof key === 'string' ? (JSON.parse(key) as unknown[])[0] : null; } catch { return null; }
}

/** Persist a placement this browser just made; it is sent once its Sync operations exist. */
export async function recordPlacementReceipt(receipt: PlacementReceipt): Promise<void> {
  if (await createReceiptStore(automationArea()).add(receipt, Date.now())) void refreshAutomation().catch(() => undefined);
}

/** The installed rules' decision for a save about to happen; null when automations do not apply here. */
export async function preSaveDecision(scope: CaptureScope, input: PreSaveInput): Promise<PreSaveDecision | null> {
  if (!scope.accountId || !scope.collectionId || !await hasBookmarkPermission()) return null;
  const owner = { serverOrigin: scope.serverOrigin, accountId: scope.accountId };
  const record = await createBundleStore(automationArea(), owner).read();
  if (automationsPaused(record, await createPauseStatusStore(pauseArea(), owner).read(), Date.now())) return null;
  if (!record.bundle) return null;
  // Rules place only while this browser syncs the collection they belong to.
  const sync = await currentSyncScope().catch(() => null);
  if (!sync || sync.accountId !== scope.accountId || sync.collectionId !== scope.collectionId) return null;
  return decidePreSave({ record, now: Date.now(), scope: sync, deps: projectionDeps(sync) }, input);
}

/** The account's pause is for every automation here: while it holds, this browser's own rules stand still too (design 01 §7.5). */
export async function sourceAutomationsPaused(): Promise<boolean> {
  const owner = await currentOwner();
  return owner ? automationsPaused(await createBundleStore(automationArea(), owner).read(),
    await createPauseStatusStore(pauseArea(), owner).read(), Date.now()) : false;
}

/** What rules decide before a save: the account's first; this browser's only where none of them speaks and nothing is paused. */
export async function rulesDecision(scope: CaptureScope, input: PreSaveInput): Promise<PreSaveDecision | BrowserPreSaveDecision | null> {
  const account = await preSaveDecision(scope, input).catch(() => null);
  if (account) return account;
  if (await sourceAutomationsPaused().catch(() => false)) return null;
  return browserPreSaveDecision(input).catch(() => null);
}

/**
 * A save the rules placed. The capture id is the receipt id, so acknowledging the save again adds nothing.
 * A browser rule's placement is only logged here: it has no receipt and nothing is sent.
 */
export async function recordPreSaveReceipt(task: CaptureTask): Promise<void> {
  const automation = task.automation;
  if (automation?.source === 'browser') { await recordBrowserPlacement(task); return; }
  if (!isAccountAutomation(automation) || automation.outcome !== 'placed' || !automation.destination || !task.nativeId || !task.scope.accountId
    || task.save !== 'local-saved' || task.disposition !== 'new') return;
  const { rule } = automation;
  await recordPlacementReceipt(newPlacementReceipt({
    ownerKey: automationOwnerKey({ serverOrigin: task.scope.serverOrigin, accountId: task.scope.accountId }),
    collectionId: automation.collectionId, replicaId: automation.replicaId, generation: automation.generation, path: 'preSave',
    rule: { id: rule.id, name: rule.name, revision: rule.revision, bindingRevision: rule.bindingRevision, bundleRevision: automation.bundleRevision },
    destination: automation.destination, destinationTitle: automation.folderTitle ?? '', satisfies: [...automation.satisfies],
    page: { title: task.title, url: task.url }, native: { nativeId: task.nativeId, destinationNativeId: task.targetNativeId },
  }, task.savedAt ?? Date.now(), task.captureId));
}

/**
 * Worker wake: a placed save whose receipt a worker stop cut off gets it now.
 * Receipts already written are left as they are; the receipt list is read once.
 */
export async function recoverPreSaveReceipts(tasks: readonly CaptureTask[]): Promise<number> {
  if (!tasks.length) return 0;
  const written = new Set((await createReceiptStore(automationArea()).list()).map((receipt) => receipt.localReceiptId));
  const missing = tasks.filter((task) => !written.has(task.captureId));
  for (const task of missing) await recordPreSaveReceipt(task);
  return missing.length;
}

/** What a save of this page would do, for the popup to show before Save. Never places anything. */
async function matchView(request: Extract<AutomationRequest, { kind: 'known.automation.match' }>): Promise<AutomationMatchView | null> {
  const scope = await currentCaptureScope().catch(() => null);
  if (!scope) return null;
  const page = { url: request.url, title: request.title, parentNativeId: request.parentNativeId, explicit: false };
  const decision = await rulesDecision(scope, page);
  if (!decision) return null;
  const { automation } = decision;
  return { outcome: automation.outcome, ruleName: automation.rule.name, sourceName: automation.source === 'browser' ? automation.sourceName ?? null : null,
    ruleCount: automation.ruleIds.length, folderNativeId: decision.targetNativeId, folderTitle: automation.folderTitle ?? null };
}

function refreshProblem(problem: DeviceProblem): Exclude<RefreshProblem, 'rejected'> {
  return problem === 'invalid' ? 'server' : problem;
}

/** Cached per account and replica; a new replica (reconnect, other collection) looks it up again. */
async function replicaDeviceId(owner: AutomationOwner, replicaId: string): Promise<string | null> {
  const key = JSON.stringify([automationOwnerKey(owner), replicaId]);
  const cached = (await chrome.storage.local.get(DEVICE_KEY))[DEVICE_KEY] as { key?: string; deviceId?: string } | undefined;
  if (cached?.key === key && typeof cached.deviceId === 'string') return cached.deviceId;
  const deviceId = await readReplicaDeviceId(owner.serverOrigin, replicaId);
  if (deviceId) await chrome.storage.local.set({ [DEVICE_KEY]: { key, deviceId } });
  return deviceId;
}

function projectionDeps(scope: SyncScope): ProjectionDeps {
  return {
    async mappingByColpId(colpId) {
      const mapping = await syncState.getMappingByColpId(scope, colpId);
      return mapping ? { nativeId: mapping.nativeId, ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}) } : null;
    },
    async mappingByNativeId(nativeId) {
      const mapping = await syncState.getMappingByNativeId(scope, nativeId);
      return mapping ? { colpId: mapping.colpId, ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}) } : null;
    },
    async nativeNode(nativeId) {
      try {
        const [node] = await chrome.bookmarks.get(nativeId);
        return node ? { id: node.id, title: node.title, ...(node.parentId ? { parentId: node.parentId } : {}),
          ...(node.url === undefined ? {} : { url: node.url }) } : null;
      } catch { return null; }
    },
  };
}
export { projectionDeps as automationProjectionDeps };

async function ruleViews(record: BundleRecord): Promise<AutomationRuleView[]> {
  const rules = record.bundle?.rules ?? [];
  const scope = await currentSyncScope({ allowStopped: true }).catch(() => null);
  const deps = scope && await hasBookmarkPermission() ? projectionDeps(scope) : null;
  const views: AutomationRuleView[] = [];
  for (const rule of rules) {
    const intake = rule.definition.intake!.folderRole;
    const local = deps && scope && ruleCollectionId(rule) === scope.collectionId ? await projectRule(rule, scope.collectionId, deps) : null;
    const destination = local?.folders[intake];
    views.push({ id: rule.ruleId, name: rule.definition.name, resolved: destination?.status === 'resolved',
      folder: destination?.status === 'resolved' ? destination.title : null, match: ruleMatchView(rule.definition.match) });
  }
  return views;
}

/** The account's rules in force here, with the folder each files into in this browser, for the overlap check (AW-69). */
async function accountRulesForOverlap(record: BundleRecord, now: number): Promise<AccountRuleForOverlap[]> {
  if (bundleState(record, now).state !== 'active') return [];
  const scope = await currentSyncScope().catch(() => null);
  if (!scope || !await hasBookmarkPermission()) return [];
  const deps = projectionDeps(scope);
  const rules: AccountRuleForOverlap[] = [];
  for (const rule of record.bundle?.rules ?? []) {
    if (ruleCollectionId(rule) !== scope.collectionId) continue;
    const destination = (await projectRule(rule, scope.collectionId, deps)).folders[rule.definition.intake!.folderRole];
    const resolved = destination?.status === 'resolved' ? destination : null;
    rules.push({ id: rule.ruleId, definition: rule.definition, name: rule.definition.name, folderNativeId: resolved?.nativeId ?? null,
      folderTitle: resolved?.title ?? null, key: `${rule.ruleRevision}:${rule.bindingRevision}` });
  }
  return rules;
}

const PLACEMENT_STATE: Record<PlacementReceipt['state'], AutomationPlacementView['state']> = {
  local: 'waitingForSync', waitingForSync: 'waitingForSync', accepted: 'confirmed', review: 'review', rejected: 'rejected', attention: 'attention' };

async function placementViews(ownerKey: string): Promise<AutomationPlacementView[]> {
  const receipts = (await createReceiptStore(automationArea()).list()).filter((receipt) => receipt.ownerKey === ownerKey).slice(0, 10);
  const recovery: AutomationPlacementView[] = (await automationDatabase().intents.list())
    .filter(intent => intent.ownerKey === ownerKey && intent.recoveryProblem)
    .map(intent => ({ id: `recovery:${intent.intentId}`, title: intent.page.title, host: '', url: intent.page.url,
      ruleName: intent.automation.rule.name, folder: intent.automation.folderTitle ?? '', at: intent.createdAt,
      path: 'observed', state: 'attention', recoveryProblem: intent.recoveryProblem }));
  return [...recovery, ...receipts.map((receipt) => {
    let host = '';
    try { host = new URL(receipt.page.url).hostname; } catch { /* the title stands alone */ }
    return { id: receipt.localReceiptId, title: receipt.page.title, host, url: receipt.page.url, ruleName: receipt.rule.name, folder: receipt.destinationTitle,
      at: receipt.createdAt, path: receipt.path, state: PLACEMENT_STATE[receipt.state] };
  })];
}

/** The server's last-read status, joined to rule names; null where the server has no automations. */
async function serverView(owner: AutomationOwner, record: BundleRecord, origin: string): Promise<AutomationServerView | null> {
  const status = await createServerStatusStore(automationArea(), automationOwnerKey(owner)).read();
  const activity = await createActivityStatusStore(automationArea(), automationOwnerKey(owner)).read();
  const activityAvailable = activity.fetchedAt !== null && activity.problem?.kind !== 'unavailable';
  if (!activityAvailable && (record.problem?.kind === 'unavailable' || status.problem?.kind === 'unavailable')) return null;
  const local = record.bundle?.rules ?? [], bundled = new Set(local.map((rule) => rule.ruleId));
  const names = new Map<string, string>([...local.map((rule) => [rule.ruleId, rule.definition.name] as const),
    ...status.rules.map((rule) => [rule.id, rule.name] as const)]);
  const problem = status.problem && (status.fetchedAt === null || status.problem.at >= status.fetchedAt) ? status.problem.kind : null;
  return {
    fetchedAt: status.fetchedAt, problem: problem === 'unavailable' ? null : problem,
    activity: activityAvailable ? { unreadCount: activity.unreadCount, latest: activity.latest, fetchedAt: activity.fetchedAt! } : null,
    activityProblem: activityAvailable && activity.problem ? activity.problem.kind : null,
    // A paused bundle carries no rules, so the rule's own definition says whether it files bookmarks here.
    rules: status.rules.map((rule) => ({ id: rule.id, name: rule.name, state: rule.state, inBrowser: rule.intake ?? bundled.has(rule.id),
      waiting: rule.usage?.waiting ?? null, held: rule.usage?.held ?? null, approvals: rule.usage?.approvals ?? null, cost: rule.usage?.cost || null })),
    runs: status.runs.map((run) => ({ id: run.id, ruleName: names.get(run.ruleId) ?? null, kind: run.kind, status: run.status, held: run.held,
      explanation: run.explanation, at: run.createdAt, unread: run.unread, outputCount: run.outputCount,
      url: `${origin.replace(/\/$/u, '')}/automations/runs/${encodeURIComponent(run.id)}` })),
  };
}

const webUrlFor = (origin: string) => `${origin.replace(/\/$/u, '')}/automations`;

/** New results the server reports for this account, from its last-read status. */
async function currentDigest(owner: AutomationOwner): Promise<DigestIndicator | null> {
  const record = await createBundleStore(automationArea(), owner).read();
  return digestIndicator(await serverView(owner, record, owner.serverOrigin), webUrlFor(owner.serverOrigin));
}

/**
 * Keeps the toolbar's count in step with the server's unread state. A save
 * problem keeps the badge, and fresh save feedback keeps the tooltip; the
 * count comes back when they clear (action-badge.ts).
 */
async function paintDigestBadge(owner: AutomationOwner | null, restore = false): Promise<void> {
  const indicator = owner ? await currentDigest(owner) : null;
  const active = await currentOwner();
  if ((active ? automationOwnerKey(active) : null) !== (owner ? automationOwnerKey(owner) : null)) return;
  const changed = await writeAutomationBadge(indicator ? toolbarBadge(indicator) : null);
  const feedback = await readSaveFeedback();
  if (feedback && saveFeedbackIsError(feedback.code)) return;
  await showAutomationBadge({ title: (changed || restore) && !feedback });
}

/** A folder here by its identity in the account's synced collection, once Sync has confirmed it. */
async function linkFor(owner: AutomationOwner, webUrl: string | null): Promise<AccountLink> {
  const scope = await currentSyncScope().catch(() => null);
  return { webUrl, async canonical(nativeId) {
    if (!scope || scope.accountId !== owner.accountId) return null;
    const mapping = await syncState.getMappingByNativeId(scope, nativeId);
    return mapping && mappingLooksAuthoritative(mapping) && (mapping.nodeKind === undefined || mapping.nodeKind === 'folder')
      ? { collectionId: scope.collectionId, nodeId: mapping.colpId } : null;
  } };
}

/** The signed-in account's link for a browser rule command (a new rule for all devices); null when signed out. */
export async function accountLink(): Promise<AccountLink | null> {
  const owner = await currentOwner();
  return owner ? linkFor(owner, webUrlFor(owner.serverOrigin)) : null;
}

/** Past the rules (follow-up U3): Automatic mode asks the AI in use here; Manual mode leaves the folder to the form. */
async function savingFlow(): Promise<SavingFlowView> {
  const [preferences, own, suggestInForm, scope] = await Promise.all([readEffectiveBookmarkPreferences().catch(() => null),
    localClassificationEnabled().catch(() => false), manualClassificationRequested().catch(() => false), currentCaptureScope().catch(() => null)]);
  // Know-N's suggestions count only with a live authorization for the collection saved into, as the capture path checks.
  const consent = !own && scope?.accountId ? (await readCaptureControl(scope).catch(() => null))?.consent : null;
  const knowN = Boolean(consent && consent.expiresAt > Date.now() && consent.collectionId === scope?.collectionId);
  return { mode: preferences?.captureMode === 'automatic' ? 'automatic' : 'manual', ai: own ? 'own' : knowN ? 'knowN' : null, suggestInForm };
}

export async function automationStateView(): Promise<AutomationStateView> {
  const owner = await currentOwner();
  const config = await loadConfig().catch(() => null);
  const origin = owner?.serverOrigin ?? config?.serverOrigin ?? null;
  const webUrl = origin ? webUrlFor(origin) : null;
  // This browser's own rules and what they filed show whether or not an account is signed in.
  const filed = await browserPlacementViews();
  if (!owner) {
    const browser = await browserListViews();
    return { account: 'signedOut', state: 'none', rules: [], placements: filed.slice(0, 10), browserRules: browser.rules, browserList: browser.list,
      browserRuns: await browserRunViews(), pausedAt: null,
      pausedBy: null, expiresAt: null, lastRefreshAt: null, problem: null, webUrl, server: null, saving: await savingFlow() };
  }
  const record = await createBundleStore(automationArea(), owner).read();
  const now = Date.now(), current = bundleState(record, now);
  const pauseStatus = await createPauseStatusStore(pauseArea(), owner).read();
  const paused = automationsPaused(record, pauseStatus, now);
  const state = paused ? 'paused' : current.state === 'paused' ? 'none' : current.state;
  // Signed in, each browser rule is compared with the account's rules in force here, and may move to the account.
  const browser = await browserListViews({ account: await accountRulesForOverlap(record, now), ...await linkFor(owner, webUrl) });
  const pause = pauseStatus.pause;
  const pausedAt = paused && pause?.pausedAt ? Date.parse(pause.pausedAt) : paused ? record.pausedSince : null;
  const bridgeStatus = (await chrome.storage.local.get(DEVICE_BRIDGE_STATUS_KEY))[DEVICE_BRIDGE_STATUS_KEY] as { ownerKey: string; code: string | null } | undefined;
  return { account: 'signedIn', state, webUrl, deviceBridgeEnabled: (await chrome.storage.local.get(DEVICE_BRIDGE_KEY))[DEVICE_BRIDGE_KEY] === automationOwnerKey(owner),
    deviceBridgeProblem: bridgeStatus?.ownerKey === automationOwnerKey(owner) ? bridgeStatus.code : null,
    rules: state === 'active' ? await ruleViews(record) : [], pauseProblem: pauseStatus.problem,
    receiptIssues: (await createReceiptStore(automationArea()).quarantine()).filter(issue => { const raw = issue.raw as { ownerKey?: string } | null; return typeof raw?.ownerKey !== 'string' || raw.ownerKey === automationOwnerKey(owner); }).map(issue => ({ id: issue.id, reason: issue.reason, at: issue.quarantinedAt })),
    placements: [...await placementViews(automationOwnerKey(owner)), ...filed].sort((a, b) => b.at - a.at).slice(0, 10),
    browserRules: browser.rules, browserList: browser.list, browserRuns: await browserRunViews(),
    pausedAt: Number.isFinite(pausedAt) ? pausedAt : null, pausedBy: paused ? pause?.pausedBy ?? null : null,
    expiresAt: current.state === 'active' || current.state === 'paused' ? current.expiresAt : current.state === 'expired' ? current.expiredAt : null,
    lastRefreshAt: record.lastRefreshAt, problem: record.problem?.kind ?? null, server: await serverView(owner, record, owner.serverOrigin),
    saving: await savingFlow() };
}

export async function handleAutomationRequest(request: AutomationRequest): Promise<AutomationResponse> {
  if (request.kind === 'known.automation.receipts.export') {
    const owner = await currentOwner();
    if (!owner) return { ok: false, error: 'signedOut' };
    const receipts = await createReceiptStore(automationArea()).quarantine();
    const owned = receipts.filter(issue => (issue.raw as { ownerKey?: unknown } | null)?.ownerKey === automationOwnerKey(owner));
    return { ok: true, backup: { filename: 'automation-receipt-recovery.json', content: JSON.stringify({ version: 1, quarantined: owned }, null, 2) } };
  }
  if (request.kind === 'known.automation.deviceBridge.enable') {
    const owner = await currentOwner();
    if (!owner) return { ok: false, error: 'signedOut' };
    await chrome.storage.local.set({ [DEVICE_BRIDGE_KEY]: request.enabled ? automationOwnerKey(owner) : null });
    void refreshAutomation({ manual: true }).catch(() => undefined);
    return { ok: true, state: await automationStateView() };
  }

  if (request.kind === 'known.automation.match') return { ok: true, match: await matchView(request) };
  if (request.kind === 'known.automation.digest') {
    // The popup shows the last answer at once; a due read follows and repaints the badge.
    const owner = await currentOwner();
    void refreshAutomation().catch(() => undefined);
    return { ok: true, digest: owner ? await currentDigest(owner) : null };
  }
  if (request.kind === 'known.automation.refresh') {
    await (await import('./automation-observed.js')).resumeObservedCreates();
    await refreshAutomation({ manual: true });
  }
  // Opening the page also nudges a due refresh; its result re-renders through storage.onChanged.
  else void refreshAutomation().catch(() => undefined);
  return { ok: true, state: await automationStateView() };
}
