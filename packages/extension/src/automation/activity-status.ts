import { readBoundedJson } from '../json-response.js';
import { assertCredentialHostPermission, SERVER_HOST_PERMISSION_ERROR } from '../server-origin-permission.js';
import type { AutomationStateArea } from './bundle-store.js';
import { validActivitySummary, type ActivitySummary } from './activity-types.js';
import type { ServerProblem } from './server-status.js';

export const ACTIVITY_STATUS_KEY = 'known.automation.activity.v1';
export interface ActivityStatusRecord extends ActivitySummary {
  readonly version: 2;
  readonly ownerKey: string;
  readonly fetchedAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly failures: number;
  readonly problem: { readonly kind: ServerProblem; readonly at: number } | null;
}
export type ActivityRead = { readonly ok: true; readonly summary: ActivitySummary } | { readonly ok: false; readonly problem: ServerProblem };

/** Cookie authority only: activity remains available independently of automation flags. */
export async function readActivitySummary(serverOrigin: string, expectedAccountId: string, fetcher: typeof fetch = fetch): Promise<ActivityRead> {
  const url = `${serverOrigin.replace(/\/$/u, '')}/api/v1/me/activity/summary`;
  const init: RequestInit = { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } };
  let response: Response;
  try { await assertCredentialHostPermission(url, init); response = await fetcher(url, init); }
  catch (error) {
    if (error instanceof Error && error.message === SERVER_HOST_PERMISSION_ERROR) throw error;
    return { ok: false, problem: 'offline' };
  }
  if (!response.ok) return { ok: false, problem: response.status === 404 ? 'unavailable'
    : response.status === 401 || response.status === 403 ? 'signedOut'
      : response.status === 429 || response.status === 503 ? 'rateLimited' : 'server' };
  // Bind the data and its owner in the same response; a separate /me check races cookie changes.
  if (response.headers.get('Known-Activity-Account-Id') !== expectedAccountId) return { ok: false, problem: 'signedOut' };
  try {
    const body = await readBoundedJson(response, 64 * 1024, 'activity_summary_invalid');
    return validActivitySummary(body) ? { ok: true, summary: body } : { ok: false, problem: 'invalid' };
  } catch { return { ok: false, problem: 'invalid' }; }
}

/** The normal status cadence, with a missing endpoint remembered until Check now or sign-in. */
export function activityStatusDue(record: ActivityStatusRecord, now: number, manual = false): boolean {
  if (manual || record.lastAttemptAt === null) return true;
  if (record.problem?.kind === 'unavailable') return false;
  return now - record.lastAttemptAt >= Math.min(900_000, 60_000 * 2 ** Math.min(record.failures, 4));
}

export function createActivityStatusStore(area: AutomationStateArea, ownerKey: string) {
  const empty: ActivityStatusRecord = { version: 2, ownerKey, fetchedAt: null, unreadCount: 0, latest: null, revision: '0',
    lastAttemptAt: null, failures: 0, problem: null };
  async function current(): Promise<ActivityStatusRecord> {
    const value = await area.get(ACTIVITY_STATUS_KEY);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
    const record = value as Partial<ActivityStatusRecord>;
    return record.version === 2 && record.ownerKey === ownerKey && validActivitySummary(record) ? { ...empty, ...record } as ActivityStatusRecord : empty;
  }
  return {
    read: current,
    /** Signing in permits another summary read without waking Sync or changing read state. */
    async retryAfterSignIn(): Promise<void> {
      const before = await current();
      if (before.problem?.kind === 'unavailable' || before.problem?.kind === 'signedOut') {
        await area.set(ACTIVITY_STATUS_KEY, { ...before, lastAttemptAt: null, failures: 0 });
      }
    },
    async apply(result: ActivityRead, now: number): Promise<ActivityStatusRecord> {
      const before = await current();
      const record: ActivityStatusRecord = result.ok
        ? { ...before, ...result.summary, fetchedAt: now, lastAttemptAt: now, failures: 0, problem: null }
        : { ...(result.problem === 'signedOut' ? empty : before), lastAttemptAt: now, failures: before.failures + 1, problem: { kind: result.problem, at: now } };
      await area.set(ACTIVITY_STATUS_KEY, record);
      return record;
    },
  };
}
