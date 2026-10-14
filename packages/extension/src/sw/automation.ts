import { validateAutomation, type BundleAckInput, type PauseState } from '@know-n/colp/automation';
import { acknowledgeRuleBundle, fetchRuleBundle, postIntakeReceipt, type DeviceAuthority, type DeviceProblem } from '../automation/device-client.js';
import { readReplicaDeviceId } from '../automation/device-identity.js';
import { projectRule, type ProjectionDeps } from '../automation/binding-projector.js';
import { automationOwnerKey, bundleState, chromeLocalArea, createBundleStore, type AutomationOwner, type BundleRecord,
  type RefreshProblem } from '../automation/bundle-store.js';
import { ruleCollectionId } from '../automation/runtime-profile.js';
import { createReceiptStore, newPlacementReceipt, settled, syncReceipts, type PlacementReceipt } from '../automation/receipt-sync.js';
import { syncReceiptEvidence } from '../automation/receipt-evidence.js';
import { decidePreSave, type PreSaveDecision, type PreSaveInput } from '../automation/pre-save.js';
import type { AutomationMatchView, AutomationPlacementView, AutomationRequest, AutomationResponse, AutomationRuleView,
  AutomationStateView } from '../automation/messages.js';
import type { CaptureScope, CaptureTask } from '../capture/contracts.js';
import { currentCaptureScope } from './capture-native.js';
import type { SyncScope } from '../sync-state-store.js';
import { readBoundedJson } from '../json-response.js';
import { ensurePeriodicAlarm } from './reconcile-alarm.js';
import { extensionOrigin, hasBookmarkPermission, store, syncState } from './runtime.js';
import { currentSyncScope, loadConfig, pushSessionAuthority } from './scope.js';

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
const MIN_REFRESH_GAP_MS = 60_000;
const DEVICE_KEY = 'known.automation.device.v1';
const PAUSE_KEY = 'known.automation.pause.v1';

let inFlight: Promise<void> | undefined;

async function currentOwner(): Promise<AutomationOwner | null> {
  const credential = await store.loadCredential().catch(() => null);
  return credential?.subject ? { serverOrigin: credential.serverOrigin, accountId: credential.subject } : null;
}

export function installAutomationRuntime(): void {
  void ensurePeriodicAlarm(chrome, AUTOMATION_ALARM, AUTOMATION_REFRESH_MINUTES);
  void refreshAutomation().catch(() => undefined);
}

export function refreshAutomation(options: { readonly manual?: boolean } = {}): Promise<void> {
  inFlight ??= run(options.manual === true).finally(() => { inFlight = undefined; });
  return inFlight;
}

/** One worker pass: the bundle when its refresh is due, then any receipt whose retry is due. */
async function run(manual: boolean): Promise<void> {
  const owner = await currentOwner();
  if (!owner) return;
  const bundles = createBundleStore(chromeLocalArea(), owner), receipts = createReceiptStore(chromeLocalArea()), now = Date.now();
  const record = await bundles.read(), ownerKey = automationOwnerKey(owner);
  const bundleDue = manual || record.lastAttemptAt === null || now - record.lastAttemptAt >= MIN_REFRESH_GAP_MS;
  const receiptsDue = (await receipts.list()).some((receipt) => receipt.ownerKey === ownerKey && !settled(receipt.state) && receipt.nextAttemptAt <= now);
  if (!bundleDue && !receiptsDue) return;
  let authority: Awaited<ReturnType<typeof pushSessionAuthority>>;
  try { authority = await pushSessionAuthority(); }
  catch { if (bundleDue) await bundles.recordProblem(navigator.onLine === false ? 'offline' : 'signedOut', now); return; }
  const device: DeviceAuthority = { serverOrigin: owner.serverOrigin, accessToken: authority.credential.accessToken,
    sessionId: authority.session.sessionId, origin: extensionOrigin() };
  if (bundleDue) await refreshBundle(owner, bundles, device);
  if (receiptsDue) await flushReceipts(owner, device, Number(authority.session.replicaLease.generation));
}

async function refreshBundle(owner: AutomationOwner, bundles: ReturnType<typeof createBundleStore>, device: DeviceAuthority): Promise<void> {
  const response = await fetchRuleBundle(device);
  if (!response.ok) { await bundles.recordProblem(refreshProblem(response.problem), Date.now()); return; }
  const outcome = await bundles.install(response.body, Date.now());
  const revision = response.body && typeof response.body === 'object' ? (response.body as { revision?: unknown }).revision : undefined;
  if (outcome.record.bundle?.paused) await readPause(owner);
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
  await syncReceipts(createReceiptStore(chromeLocalArea()), {
    ownerKey: automationOwnerKey(owner), collectionId: scope.collectionId, replicaId: scope.replicaId, generation: scope.generation,
    deviceId: await replicaDeviceId(owner, scope.replicaId), replicaGeneration, now: Date.now(),
    evidence: syncReceiptEvidence(syncState, scope),
    // Each attempt is a new command: the receipt id, not the command, makes a retry idempotent.
    post: (input) => postIntakeReceipt(device, input, crypto.randomUUID()),
  });
}

/** Persist a placement this browser just made; it is sent once its Sync operations exist. */
export async function recordPlacementReceipt(receipt: PlacementReceipt): Promise<void> {
  if (await createReceiptStore(chromeLocalArea()).add(receipt, Date.now())) void refreshAutomation().catch(() => undefined);
}

/** The installed rules' decision for a save about to happen; null when automations do not apply here. */
export async function preSaveDecision(scope: CaptureScope, input: PreSaveInput): Promise<PreSaveDecision | null> {
  if (!scope.accountId || !scope.collectionId || !await hasBookmarkPermission()) return null;
  const record = await createBundleStore(chromeLocalArea(), { serverOrigin: scope.serverOrigin, accountId: scope.accountId }).read();
  if (!record.bundle) return null;
  // Rules place only while this browser syncs the collection they belong to.
  const sync = await currentSyncScope().catch(() => null);
  if (!sync || sync.accountId !== scope.accountId || sync.collectionId !== scope.collectionId) return null;
  return decidePreSave({ record, now: Date.now(), scope: sync, deps: projectionDeps(sync) }, input);
}

/** A save the rules placed. The capture id is the receipt id, so acknowledging the save again adds nothing. */
export async function recordPreSaveReceipt(task: CaptureTask): Promise<void> {
  const automation = task.automation;
  if (automation?.outcome !== 'placed' || !automation.destination || !task.nativeId || !task.scope.accountId
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

/** What a save of this page would do, for the popup to show before Save. Never places anything. */
async function matchView(request: Extract<AutomationRequest, { kind: 'known.automation.match' }>): Promise<AutomationMatchView | null> {
  const scope = await currentCaptureScope().catch(() => null);
  if (!scope) return null;
  const decision = await preSaveDecision(scope, { url: request.url, title: request.title, parentNativeId: request.parentNativeId, explicit: false });
  if (!decision) return null;
  const { automation } = decision;
  return { outcome: automation.outcome, ruleName: automation.rule.name, ruleCount: automation.ruleIds.length,
    folderNativeId: decision.targetNativeId, folderTitle: automation.folderTitle ?? null };
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

/** Who paused and when, for "Paused by you on 12 Oct". The bundle only says that it is paused. */
async function readPause(owner: AutomationOwner): Promise<void> {
  try {
    const response = await fetch(`${owner.serverOrigin.replace(/\/$/u, '')}/api/v1/me/automations/pause`, { credentials: 'include',
      redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return;
    const body = await readBoundedJson(response, 16 * 1024, 'automation_pause_invalid');
    if (!validateAutomation('PauseState', body).valid) return;
    const pause = body as PauseState;
    await chrome.storage.local.set({ [PAUSE_KEY]: { ownerKey: automationOwnerKey(owner), pausedAt: pause.pausedAt, pausedBy: pause.pausedBy } });
  } catch { /* The paused state itself comes from the bundle; the date is a courtesy. */ }
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
      folder: destination?.status === 'resolved' ? destination.title : null });
  }
  return views;
}

const PLACEMENT_STATE: Record<PlacementReceipt['state'], AutomationPlacementView['state']> = {
  local: 'waitingForSync', waitingForSync: 'waitingForSync', accepted: 'confirmed', review: 'review', rejected: 'rejected', attention: 'attention' };

async function placementViews(ownerKey: string): Promise<AutomationPlacementView[]> {
  const receipts = (await createReceiptStore(chromeLocalArea()).list()).filter((receipt) => receipt.ownerKey === ownerKey).slice(0, 10);
  return receipts.map((receipt) => {
    let host = '';
    try { host = new URL(receipt.page.url).hostname; } catch { /* the title stands alone */ }
    return { id: receipt.localReceiptId, title: receipt.page.title, host, ruleName: receipt.rule.name, folder: receipt.destinationTitle,
      at: receipt.createdAt, path: receipt.path, state: PLACEMENT_STATE[receipt.state] };
  });
}

export async function automationStateView(): Promise<AutomationStateView> {
  const owner = await currentOwner();
  const config = await loadConfig().catch(() => null);
  const origin = owner?.serverOrigin ?? config?.serverOrigin ?? null;
  const webUrl = origin ? `${origin.replace(/\/$/u, '')}/automations` : null;
  const blank = { rules: [], placements: [], pausedAt: null, pausedBy: null, expiresAt: null, lastRefreshAt: null, problem: null, webUrl };
  if (!owner) return { account: 'signedOut', state: 'none', ...blank };
  const record = await createBundleStore(chromeLocalArea(), owner).read();
  const now = Date.now(), current = bundleState(record, now);
  const pause = (await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY] as { ownerKey?: string; pausedAt?: string | null; pausedBy?: AutomationStateView['pausedBy'] } | undefined;
  const pauseKnown = current.state === 'paused' && pause?.ownerKey === automationOwnerKey(owner);
  const pausedAt = pauseKnown && pause?.pausedAt ? Date.parse(pause.pausedAt) : current.state === 'paused' ? current.since : null;
  return { account: 'signedIn', state: current.state, webUrl,
    rules: current.state === 'active' ? await ruleViews(record) : [],
    placements: await placementViews(automationOwnerKey(owner)),
    pausedAt: Number.isFinite(pausedAt) ? pausedAt : null, pausedBy: pauseKnown ? pause?.pausedBy ?? null : null,
    expiresAt: current.state === 'active' || current.state === 'paused' ? current.expiresAt : current.state === 'expired' ? current.expiredAt : null,
    lastRefreshAt: record.lastRefreshAt, problem: record.problem?.kind ?? null };
}

export async function handleAutomationRequest(request: AutomationRequest): Promise<AutomationResponse> {
  if (request.kind === 'known.automation.match') return { ok: true, match: await matchView(request) };
  if (request.kind === 'known.automation.refresh') await refreshAutomation({ manual: true });
  // Opening the page also nudges a due refresh; its result re-renders through storage.onChanged.
  else void refreshAutomation().catch(() => undefined);
  return { ok: true, state: await automationStateView() };
}
