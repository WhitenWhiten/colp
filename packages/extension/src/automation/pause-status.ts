import { validateAutomation, type PauseState } from '@know-n/colp/automation';
import { readBoundedJson } from '../json-response.js';
import { assertCredentialHostPermission } from '../server-origin-permission.js';
import { automationOwnerKey, bundleState, type AutomationOwner, type AutomationStateArea, type BundleRecord } from './bundle-store.js';
import { automationRefreshProblem } from './refresh-problem.js';
import type { AutomationProblem } from './messages.js';

export const PAUSE_KEY = 'known.automation.pause.v1';
export interface PauseStatusRecord {
  readonly version: 2;
  readonly ownerKey: string;
  readonly pause: PauseState | null;
  /** Request start, so a concurrent read cannot lift a subsequently learned bundle pause. */
  readonly requestedAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly problem: AutomationProblem | null;
}
type PauseRead = { ok: true; pause: PauseState } | { ok: false; problem: AutomationProblem };
const validPause = (value: unknown): value is PauseState => validateAutomation('PauseState', value).valid
  && /^\d{1,128}$/u.test((value as PauseState).revision);

/** Cookie authority and the response's account header are independent of Sync. */
export async function readPauseStatus(owner: AutomationOwner, fetcher: typeof fetch = fetch): Promise<PauseRead> {
  const url = `${owner.serverOrigin.replace(/\/$/u, '')}/api/v1/me/automations/pause`;
  const init: RequestInit = { credentials: 'include', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) };
  try {
    await assertCredentialHostPermission(url, init);
    const response = await fetcher(url, init);
    if (!response.ok) return { ok: false, problem: response.status === 404 ? 'unavailable'
      : response.status === 401 || response.status === 403 ? 'signedOut'
        : response.status === 429 || response.status === 503 ? 'rateLimited' : 'server' };
    if (response.headers.get('Known-Automation-Account-Id') !== owner.accountId) return { ok: false, problem: 'signedOut' };
    const pause = await readBoundedJson(response, 16 * 1024, 'automation_pause_invalid');
    return validPause(pause) ? { ok: true, pause } : { ok: false, problem: 'rejected' };
  } catch (error) { return { ok: false, problem: automationRefreshProblem(error) }; }
}

/** Pause revisions and bundle configuration epochs are different sequences.
 * A learned pause survives expiry/failures. Only a later pause read may lift
 * a bundle pause; a newer bundle can always stop work conservatively. */
export function automationsPaused(record: BundleRecord, status: PauseStatusRecord, now: number): boolean {
  if (status.pause?.paused) return true;
  return bundleState(record, now).state === 'paused'
    && (!status.pause || status.requestedAt === null || status.requestedAt <= (record.lastRefreshAt ?? Infinity));
}

export function pauseStatusDue(record: PauseStatusRecord, now: number, manual = false): boolean {
  return manual || record.lastAttemptAt === null || record.problem !== 'unavailable' && now - record.lastAttemptAt >= 60_000;
}

let queue: Promise<unknown> = Promise.resolve();
export function createPauseStatusStore(area: AutomationStateArea, owner: AutomationOwner) {
  const ownerKey = automationOwnerKey(owner);
  const empty: PauseStatusRecord = { version: 2, ownerKey, pause: null, requestedAt: null, lastAttemptAt: null, problem: null };
  const read = async (): Promise<PauseStatusRecord> => {
    const value = await area.get(PAUSE_KEY) as Partial<PauseStatusRecord> | null;
    if (value?.version !== 2 || value.ownerKey !== ownerKey || value.pause !== null && !validPause(value.pause)) return empty;
    const time = (at: unknown) => typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : null;
    return { ...empty, pause: value.pause ?? null, requestedAt: time(value.requestedAt), lastAttemptAt: time(value.lastAttemptAt),
      problem: typeof value.problem === 'string' ? value.problem : null };
  };
  return { read,
    async retryAfterSignIn() { const before = await read(); await area.set(PAUSE_KEY, { ...before, lastAttemptAt: null }); },
    apply(result: PauseRead, requestedAt: number): Promise<void> {
      const apply = queue.then(async () => {
        const before = await read();
        const sameRevision = result.ok && before.pause && BigInt(result.pause.revision) === BigInt(before.pause.revision);
        const stale = result.ok && before.pause && (BigInt(result.pause.revision) < BigInt(before.pause.revision)
          || sameRevision && result.pause.paused !== before.pause.paused);
        await area.set(PAUSE_KEY, result.ok && !stale
          ? { ...before, pause: result.pause, requestedAt: sameRevision ? Math.max(before.requestedAt ?? 0, requestedAt) : requestedAt,
            lastAttemptAt: requestedAt, problem: null }
          : { ...before, lastAttemptAt: requestedAt, problem: result.ok ? 'rejected' : result.problem });
      });
      queue = apply.catch(() => undefined);
      return apply;
    },
  };
}
