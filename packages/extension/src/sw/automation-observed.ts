import { createBundleStore, automationOwnerKey, bundleState, chromeLocalArea } from '../automation/bundle-store.js';
import type { CreateEvidence } from '../automation/causation.js';
import { SETTLE_MS, settleObservedCreate, type Observation, type ObservedPlacement, type ObservedPorts } from '../automation/observed-create.js';
import { decidePreSave } from '../automation/pre-save.js';
import { newPlacementReceipt } from '../automation/receipt-sync.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
import type { CaptureAutomation } from '../capture/contracts.js';
import { createLocalImportStore } from '../local-import/store.js';
import { presentSaveFeedback } from '../save-feedback.js';
import { observedSaveLine } from '../save-status.js';
import type { SyncScope } from '../sync-state-store.js';
import { automationProjectionDeps, recordPlacementReceipt } from './automation.js';
import { hasBookmarkPermission, sw, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';

/**
 * The worker side of observed creates (star button, the browser's bookmark
 * manager). Each creation is noted in session storage and judged once, after
 * the settle window, by observed-create.ts. An observation is taken out of
 * storage before it is judged, so a worker that dies mid-way never repeats a move.
 */
const OBSERVED_KEY = 'known.automation.observed.v1';
const REMOVED_KEY = 'known.automation.removed.v1';
const IMPORT_KEY = 'known.automation.import.v1';
const MAX_OBSERVED = 100, MAX_REMOVED = 300;
/** A page re-created this soon after it was removed is an undo or a restore, not a new save. */
const REMOVED_TTL_MS = 10 * 60_000;
/** The browser reports an import's end; its last creations may still arrive just after. */
const IMPORT_GRACE_MS = 5_000;
const ROOT_TYPES = new Set(['bookmarks-bar', 'other', 'mobile']);
const LEGACY_ROOT_IDS = new Set(['1', '2', '3']);

interface RemovedUrl { readonly url: string; readonly at: number }
interface ImportWindow { readonly active: boolean; readonly at: number }

const session = {
  async get<T>(key: string, fallback: T): Promise<T> { return ((await chrome.storage.session.get(key))[key] as T | undefined) ?? fallback; },
  async set(key: string, value: unknown): Promise<void> { await chrome.storage.session.set({ [key]: value }); },
};
let lane: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = lane.then(work, work); lane = run.catch(() => undefined); return run;
}

/** The scope bookmark capture uses (its evidence build may pin one). */
async function observedScope(): Promise<SyncScope | null> {
  return (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope().catch(() => null);
}

/** Only an account with rules in force pays for observing; everyone else's bookmarks are left alone. */
async function rulesInForce(): Promise<SyncScope | null> {
  const scope = await observedScope();
  if (!scope || !await hasBookmarkPermission()) return null;
  const record = await createBundleStore(chromeLocalArea(), { serverOrigin: scope.serverOrigin, accountId: scope.accountId }).read();
  return bundleState(record, Date.now()).state === 'active' && record.bundle?.rules.length ? scope : null;
}

export function installObservedCreates(): void {
  const mark = (active: boolean) => () => { void session.set(IMPORT_KEY, { active, at: Date.now() } satisfies ImportWindow).catch(() => undefined); };
  try { chrome.bookmarks?.onImportBegan?.addListener(mark(true)); chrome.bookmarks?.onImportEnded?.addListener(mark(false)); }
  catch { /* Without import events, a Know-N import is still recognized; a browser import may be judged as new bookmarks. */ }
  void settleDue().catch(() => undefined);
}

/** A bookmark appeared outside the extension's own saves: judge it after the settle window. */
export async function observeCreatedBookmark(nativeId: string, node: { readonly url?: string; readonly parentId?: string; readonly dateAdded?: number }): Promise<void> {
  if (node.url === undefined || !node.parentId || !await rulesInForce()) return;
  const observation: Observation = { nativeId, url: node.url, parentId: node.parentId, dateAdded: node.dateAdded ?? null, observedAt: Date.now() };
  await exclusive(async () => {
    const pending = (await session.get<Observation[]>(OBSERVED_KEY, [])).filter((item) => item.nativeId !== nativeId);
    await session.set(OBSERVED_KEY, [...pending, observation].slice(-MAX_OBSERVED));
  });
  setTimeout(() => { void settleDue().catch(() => undefined); }, SETTLE_MS + 50);
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
export function settleDue(now = Date.now()): Promise<void> {
  return exclusive(async () => {
    const pending = await session.get<Observation[]>(OBSERVED_KEY, []);
    const due = pending.filter((item) => now - item.observedAt >= SETTLE_MS);
    if (!due.length) return;
    // Handed over before judging: an interrupted judgement is never repeated.
    await session.set(OBSERVED_KEY, pending.filter((item) => now - item.observedAt < SETTLE_MS));
    for (const observation of due) await settleObservedCreate(observedPorts(), observation).catch(() => undefined);
  });
}

function observedPorts(): ObservedPorts {
  return {
    now: Date.now,
    async node(nativeId) { return (await chrome.bookmarks.get(nativeId).catch(() => []))[0] ?? null; },
    async intakeRoot(folderNativeId) {
      const [folder] = await chrome.bookmarks.get(folderNativeId).catch(() => []);
      if (!folder || folder.url !== undefined || folder.parentId !== '0' || folder.unmodifiable) return false;
      return folder.folderType !== undefined ? ROOT_TYPES.has(folder.folderType) : LEGACY_ROOT_IDS.has(folder.id);
    },
    evidence: createEvidence,
    async decide(input) {
      const scope = await observedScope();
      if (!scope) return null;
      const record = await createBundleStore(chromeLocalArea(), { serverOrigin: scope.serverOrigin, accountId: scope.accountId }).read();
      return decidePreSave({ record, now: Date.now(), scope, deps: automationProjectionDeps(scope) }, input);
    },
    async move(nativeId, parentNativeId) { await personalBookmarks.move(nativeId, { parentId: parentNativeId }); },
    record: recordObservedPlacement,
    async notify({ automation, title, nativeId }) {
      const line = observedSaveLine(automation, title);
      if (!line) return;
      await presentSaveFeedback({ code: 'saved', entry: 'page', message: line.text, nativeId });
      // An open, visible Know-N page shows it as a toast; the toolbar keeps it for the popup.
      void chrome.runtime.sendMessage({ kind: 'known.automation.notice', text: line.text, attention: line.attention }).catch(() => undefined);
    },
  };
}

async function createEvidence(observation: Observation): Promise<CreateEvidence> {
  const scope = await observedScope();
  const events = scope ? await syncState.listBookmarkEventsByNative(scope, observation.nativeId, 0, 50) : [];
  const create = events.find((event) => event.kind === 'create');
  const context = create?.details.context;
  const mapping = scope ? await syncState.getMappingByNativeId(scope, observation.nativeId) : null;
  const imported = await session.get<ImportWindow | null>(IMPORT_KEY, null);
  const knownImport = (await createLocalImportStore().plan().catch(() => undefined))?.state === 'running';
  const removed = await session.get<RemovedUrl[]>(REMOVED_KEY, []);
  return {
    localCreate: create ? { placement: Boolean(context && typeof context === 'object' && !Array.isArray(context) && 'placement' in context) }
      // A create the queue staged but has not written an event for yet still shows as a provisional mapping.
      : mapping?.colpId.startsWith('pending-') ? { placement: false } : null,
    projected: Boolean(mapping && !mapping.colpId.startsWith('pending-')),
    importing: knownImport || Boolean(imported && (imported.active || observation.observedAt - imported.at < IMPORT_GRACE_MS)),
    recentlyRemoved: removed.some((item) => item.url === observation.url && observation.observedAt - item.at < REMOVED_TTL_MS),
  };
}

async function recordObservedPlacement(placement: ObservedPlacement): Promise<void> {
  const automation: CaptureAutomation = placement.automation;
  const scope = await observedScope();
  if (!scope || !automation.destination) return;
  const { rule } = automation;
  await recordPlacementReceipt(newPlacementReceipt({
    ownerKey: automationOwnerKey({ serverOrigin: scope.serverOrigin, accountId: scope.accountId }),
    collectionId: automation.collectionId, replicaId: automation.replicaId, generation: automation.generation, path: 'observed',
    rule: { id: rule.id, name: rule.name, revision: rule.revision, bindingRevision: rule.bindingRevision, bundleRevision: automation.bundleRevision },
    destination: automation.destination, destinationTitle: automation.folderTitle ?? '', satisfies: [...automation.satisfies],
    ...(placement.beforeFolder ? { beforeFolder: placement.beforeFolder } : {}), page: placement.page, native: placement.native,
  }, placement.native.movedAt));
}
