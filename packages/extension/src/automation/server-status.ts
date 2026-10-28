import { validateAutomation, type Rule, type RulePage, type Run, type RunPage } from '@know-n/colp/automation';
import { readBoundedJson } from '../json-response.js';
import { assertCredentialHostPermission, SERVER_HOST_PERMISSION_ERROR } from '../server-origin-permission.js';
import type { AutomationStateArea } from './bundle-store.js';

/**
 * What the server says its automations are doing, as this browser last read it.
 *
 * The rules and recent runs are read with the browser's web sign-in (a cookie
 * GET; the Sync bearer is never sent), checked against the contract, and kept
 * with the time they were read. Nothing is worked out here: states, counts,
 * costs and explanations are the server's own. A failed read keeps the last
 * good copy and records why, so pages can say how old it is.
 */
export const SERVER_STATUS_KEY = 'known.automation.server.v1';
const RULES_PATH = '/api/v1/me/automations/rules?limit=100';
const RUNS_PATH = '/api/v1/me/automations/runs?limit=20';
const MAX_BYTES = 1_200_000;
const TIMEOUT_MS = 15_000;

export type ServerProblem = 'offline' | 'signedOut' | 'unavailable' | 'rateLimited' | 'server' | 'invalid';

export interface ServerRuleStatus {
  readonly id: string;
  readonly name: string;
  readonly state: Rule['effectiveState'];
  /**
   * It files new bookmarks (an intake part), so browsers carry it in their
   * bundle while it is on. Missing from a copy read before this was kept.
   */
  readonly intake?: boolean;
  /** The server's usage projection (M2); null before it reports one. */
  readonly usage: {
    readonly since: number; readonly runs: number; readonly waiting: number; readonly held: number;
    readonly approvals: number | null; readonly cost: string;
  } | null;
}
export interface ServerRunStatus {
  readonly id: string;
  readonly ruleId: string;
  readonly kind: Run['kind'];
  readonly status: Run['status'];
  readonly held: boolean;
  readonly unread: boolean;
  readonly outputCount: number;
  readonly explanation: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ServerStatusRecord {
  readonly version: 2;
  readonly ownerKey: string;
  /** When the copy below was read; null before the first good read. */
  readonly fetchedAt: number | null;
  readonly rules: readonly ServerRuleStatus[];
  /** Newest first, as the server lists them. */
  readonly runs: readonly ServerRunStatus[];
  readonly lastAttemptAt: number | null;
  readonly failures: number;
  readonly problem: { readonly kind: ServerProblem; readonly at: number } | null;
}

export type ServerRead = { readonly ok: true; readonly rules: readonly Rule[]; readonly runs: readonly Run[] }
  | { readonly ok: false; readonly problem: ServerProblem };

function problemFor(status: number): ServerProblem {
  if (status === 401 || status === 403) return 'signedOut';
  if (status === 404) return 'unavailable';
  if (status === 429 || status === 503) return 'rateLimited';
  return 'server';
}

async function read(serverOrigin: string, path: string, schema: 'RulePage' | 'RunPage', expectedAccountId: string, fetcher: typeof fetch)
  : Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly problem: ServerProblem }> {
  let response: Response;
  const url = `${serverOrigin.replace(/\/$/u, '')}${path}`;
  const init: RequestInit = { method: 'GET', credentials: 'include', redirect: 'error',
    cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } };
  try {
    await assertCredentialHostPermission(url, init);
    response = await fetcher(url, init);
  } catch (error) {
    if (error instanceof Error && error.message === SERVER_HOST_PERMISSION_ERROR) throw error;
    return { ok: false, problem: 'offline' };
  }
  if (!response.ok) return { ok: false, problem: problemFor(response.status) };
  if (response.headers.get('Known-Automation-Account-Id') !== expectedAccountId) return { ok: false, problem: 'signedOut' };
  let body: unknown;
  try { body = await readBoundedJson(response, MAX_BYTES, 'automation_status_invalid'); } catch { return { ok: false, problem: 'invalid' }; }
  return validateAutomation(schema, body).valid ? { ok: true, body } : { ok: false, problem: 'invalid' };
}

/** The account's rules and its 20 newest runs. */
export async function readServerStatus(serverOrigin: string, expectedAccountId: string, fetcher: typeof fetch = fetch): Promise<ServerRead> {
  const rules = await read(serverOrigin, RULES_PATH, 'RulePage', expectedAccountId, fetcher);
  if (!rules.ok) return rules;
  const runs = await read(serverOrigin, RUNS_PATH, 'RunPage', expectedAccountId, fetcher);
  if (!runs.ok) return runs;
  return { ok: true, rules: (rules.body as RulePage).items, runs: (runs.body as RunPage).items };
}

function ruleStatus(rule: Rule): ServerRuleStatus {
  const usage = rule.usage;
  return { id: rule.id, name: rule.definition.name, state: rule.effectiveState, intake: rule.definition.intake !== undefined,
    usage: usage ? { since: Date.parse(usage.periodStart), runs: usage.admittedRuns, waiting: usage.readyJobs, held: usage.heldJobs,
      approvals: usage.awaitingApprovalJobs ?? null, cost: usage.costDisplay } : null };
}

function runStatus(run: Run): ServerRunStatus {
  return { id: run.id, ruleId: run.ruleId, kind: run.kind, status: run.status, held: run.held === true, unread: run.unread,
    outputCount: run.outputCount, explanation: run.explanation ?? null, createdAt: Date.parse(run.createdAt), updatedAt: Date.parse(run.updatedAt) };
}

/** Same rhythm as the bundle: at least a minute apart, doubling after failures up to 15 minutes. */
export function serverStatusDue(record: ServerStatusRecord, now: number): boolean {
  if (record.lastAttemptAt === null) return true;
  return now - record.lastAttemptAt >= Math.min(900_000, 60_000 * 2 ** Math.min(record.failures, 4));
}

export function createServerStatusStore(area: AutomationStateArea, ownerKey: string) {
  const empty: ServerStatusRecord = { version: 2, ownerKey, fetchedAt: null, rules: [], runs: [], lastAttemptAt: null, failures: 0, problem: null };
  async function current(): Promise<ServerStatusRecord> {
    const value = await area.get(SERVER_STATUS_KEY);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
    const record = value as Partial<ServerStatusRecord>;
    // Another account's status is never shown for this one.
    return record.version === 2 && record.ownerKey === ownerKey ? { ...empty, ...record } as ServerStatusRecord : empty;
  }
  async function write(record: ServerStatusRecord): Promise<ServerStatusRecord> { await area.set(SERVER_STATUS_KEY, record); return record; }
  return {
    read: current,
    /** Applies one read: a good one replaces the copy, a failed one keeps it and records why. */
    async apply(result: ServerRead, now: number): Promise<ServerStatusRecord> {
      const before = await current();
      if (!result.ok) return write({ ...(result.problem === 'signedOut' ? empty : before), lastAttemptAt: now, failures: before.failures + 1, problem: { kind: result.problem, at: now } });
      return write({ ...before, fetchedAt: now, rules: result.rules.map(ruleStatus), runs: result.runs.map(runStatus),
        lastAttemptAt: now, failures: 0, problem: null });
    },
  };
}
