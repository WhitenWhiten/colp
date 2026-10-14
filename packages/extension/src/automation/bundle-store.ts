import type { RuleBundle } from '@know-n/colp/automation';
import { checkBundle, type BundleRejection } from './runtime-profile.js';
import { AUTOMATION_BUNDLE_KEY } from './messages.js';

/**
 * The installed rule bundle for one account on one server.
 *
 * The whole record is replaced in one write, so a reader sees the previous
 * bundle or the next one, never a mix. A rejected bundle leaves the previous
 * valid one in force. Ordering uses the server's monotonic settingsRevision
 * (bundle revisions are opaque): an older settings sequence is refused even
 * while it has not expired, and a learned pause is never undone by a bundle
 * that is not newer than the one that carried it.
 *
 * An offline device learns a pause only on its next refresh, and stops
 * placing when its copy expires; the Options page says so.
 */
export { AUTOMATION_BUNDLE_KEY };

export interface AutomationOwner { readonly serverOrigin: string; readonly accountId: string }
export const automationOwnerKey = (owner: AutomationOwner) => JSON.stringify([owner.serverOrigin, owner.accountId]);

export type RefreshProblem = 'offline' | 'signedOut' | 'unavailable' | 'rateLimited' | 'server' | 'rejected';
export interface BundleRecord {
  readonly version: 1;
  readonly ownerKey: string;
  readonly bundle: RuleBundle | null;
  /** All bundle folders share one server identity; receipts name it. */
  readonly serverUuid: string | null;
  readonly installedAt: number | null;
  /** Last time the server answered with a bundle this device accepted (new or unchanged). */
  readonly lastRefreshAt: number | null;
  readonly lastAttemptAt: number | null;
  /** When this device first saw the current pause. */
  readonly pausedSince: number | null;
  readonly problem: { readonly kind: RefreshProblem; readonly reason?: BundleRejection | 'stale'; readonly at: number } | null;
}

export type InstallOutcome = { readonly kind: 'installed' | 'unchanged'; readonly record: BundleRecord }
  | { readonly kind: 'rejected'; readonly reason: BundleRejection | 'stale'; readonly record: BundleRecord };

export type BundleState =
  | { readonly state: 'none' }
  | { readonly state: 'active'; readonly bundle: RuleBundle; readonly expiresAt: number }
  | { readonly state: 'paused'; readonly since: number | null; readonly expiresAt: number }
  | { readonly state: 'expired'; readonly expiredAt: number };

export interface AutomationStateArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function chromeLocalArea(): AutomationStateArea {
  return {
    async get(key) { return (await chrome.storage.local.get(key))[key]; },
    async set(key, value) { await chrome.storage.local.set({ [key]: value }); },
  };
}

const empty = (ownerKey: string): BundleRecord => ({ version: 1, ownerKey, bundle: null, serverUuid: null, installedAt: null,
  lastRefreshAt: null, lastAttemptAt: null, pausedSince: null, problem: null });

function parseRecord(value: unknown, ownerKey: string): BundleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty(ownerKey);
  const record = value as Partial<BundleRecord>;
  // Another account's rules are never this account's: start empty rather than reuse them.
  if (record.version !== 1 || record.ownerKey !== ownerKey) return empty(ownerKey);
  return { ...empty(ownerKey), ...record } as BundleRecord;
}

/** What the installed bundle allows right now. Expiry disables placement; it does not delete the record. */
export function bundleState(record: BundleRecord, now: number): BundleState {
  const bundle = record.bundle;
  if (!bundle) return { state: 'none' };
  const expiresAt = Date.parse(bundle.expiresAt);
  if (!(expiresAt > now)) return { state: 'expired', expiredAt: expiresAt };
  return bundle.paused ? { state: 'paused', since: record.pausedSince, expiresAt } : { state: 'active', bundle, expiresAt };
}

/** Older settings never replace newer ones; an equal sequence may only refresh expiry, never lift a pause. */
function supersedes(next: RuleBundle, previous: RuleBundle | null): boolean {
  if (!previous) return true;
  if (next.settingsRevision !== previous.settingsRevision) return next.settingsRevision > previous.settingsRevision;
  return next.paused === previous.paused;
}

/** One read-modify-write of the record at a time inside this worker, whichever store instance asks. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

export function createBundleStore(area: AutomationStateArea, owner: AutomationOwner) {
  const ownerKey = automationOwnerKey(owner);
  const read = async () => parseRecord(await area.get(AUTOMATION_BUNDLE_KEY), ownerKey);
  const write = async (record: BundleRecord) => { await area.set(AUTOMATION_BUNDLE_KEY, record); return record; };

  return {
    ownerKey,
    read,
    async state(now: number): Promise<BundleState> { return bundleState(await read(), now); },
    install(value: unknown, now: number): Promise<InstallOutcome> {
      return exclusive(async () => {
        const current = await read();
        const check = checkBundle(value, now);
        const reason = !check.ok ? check.reason : supersedes(check.bundle, current.bundle) ? undefined : 'stale' as const;
        if (!check.ok || reason) {
          const record = await write({ ...current, lastAttemptAt: now,
            problem: { kind: 'rejected', reason: reason ?? (check as { reason: BundleRejection }).reason, at: now } });
          return { kind: 'rejected', reason: reason ?? (check as { reason: BundleRejection }).reason, record };
        }
        const next = check.bundle, previous = current.bundle;
        const unchanged = previous?.digest === next.digest;
        const pausedSince = next.paused ? (previous?.paused ? current.pausedSince : now) : null;
        const record = await write({ ...current, bundle: next, serverUuid: check.serverUuid ?? current.serverUuid,
          installedAt: unchanged ? current.installedAt : now, lastRefreshAt: now, lastAttemptAt: now, pausedSince, problem: null });
        return { kind: unchanged ? 'unchanged' : 'installed', record };
      });
    },
    /** A refresh that did not reach a bundle: the installed one stays in force until it expires. */
    recordProblem(kind: Exclude<RefreshProblem, 'rejected'>, now: number): Promise<BundleRecord> {
      return exclusive(async () => write({ ...await read(), lastAttemptAt: now, problem: { kind, at: now } }));
    },
  };
}
export type BundleStore = ReturnType<typeof createBundleStore>;
