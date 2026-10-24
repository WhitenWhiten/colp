import { REPLICA_HEALTH_MAX_ITEMS, REPLICA_HEALTH_MAX_BODY_BYTES, REPLICA_HEALTH_TITLE_MAX, REPLICA_COMMAND_RESULTS_MAX } from './generated/replica-health-limits.js';
export { REPLICA_HEALTH_MAX_ITEMS, REPLICA_HEALTH_MAX_BODY_BYTES, REPLICA_COMMAND_RESULTS_MAX } from './generated/replica-health-limits.js';
import type { VerifiedExtensionCredential } from '../identity/index.js';
import { replicaReportTextIsSafe } from './replica-report-text.js';
export { replicaReportTextIsSafe } from './replica-report-text.js';

/**
 * A replica's own account of its sync, reported by the browser extension so the
 * Sync center can show why a browser stopped or what it has set aside. The
 * report is a display fact: it never renews a lease, moves a cursor or changes
 * replica lifecycle.
 */
export const REPLICA_HEALTH_STATES = ['syncing', 'degraded', 'stopped', 'paused'] as const;
export type ReplicaHealthState = (typeof REPLICA_HEALTH_STATES)[number];
export const REPLICA_ISSUE_DIRECTIONS = ['push', 'pull', 'local'] as const;
export type ReplicaIssueDirection = (typeof REPLICA_ISSUE_DIRECTIONS)[number];
export const REPLICA_ISSUE_ACTIONS = ['retry', 'use_server', 'keep_local', 'discard_local',
  'delete', 'keep', 'resume', 'rebuild'] as const;
export type ReplicaIssueAction = (typeof REPLICA_ISSUE_ACTIONS)[number];
/** Actions about the whole replica rather than one issue. */
export const REPLICA_ACTIONS = ['retry', 'resume', 'rebuild'] as const satisfies readonly ReplicaIssueAction[];
/** Results one report may carry, and commands one response may deliver. */
export const REPLICA_COMMANDS_DELIVERED_MAX = 8;
/** Commands not yet carried out, per replica; a ninth waits for one of them to finish. */
export const REPLICA_COMMANDS_OPEN_MAX = 8;
export const REPLICA_COMMAND_TTL_MS = 7 * 24 * 60 * 60_000;

export interface ReplicaHealthIssue {
  readonly issueId: string;
  readonly code: string;
  readonly direction: ReplicaIssueDirection;
  readonly nodeId?: string;
  readonly opId?: string;
  /** Display only; dropped when it carries a credential or a browser id (see `replicaReportTextIsSafe`). */
  readonly title?: string;
  readonly count: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly actions: readonly ReplicaIssueAction[];
}

export interface ReplicaHealthReport {
  readonly replicaId: string;
  /** Client-chosen monotonic revision, advanced past the server receipt high-water mark. */
  readonly revision: number;
  readonly state: ReplicaHealthState;
  readonly code?: string;
  readonly since: string;
  readonly issues: { readonly total: number; readonly items: readonly ReplicaHealthIssue[] };
  /** What the Sync center may ask of the whole replica now. */
  readonly actions: readonly ReplicaIssueAction[];
  /** Outcomes of commands the replica carried out since its last accepted report. */
  readonly commandResults: readonly ReplicaCommandResult[];
  readonly extensionVersion?: string;
}

export type ReplicaCommandState = 'pending' | 'delivered' | 'done' | 'failed' | 'expired';
/** What a replica is asked to do: an action and at most one issue it reported, never data. */
export interface ReplicaCommand {
  readonly commandId: string;
  readonly action: ReplicaIssueAction;
  readonly issueId?: string;
  /** Negotiated rebuild receipt: the old replica can no longer write. */
  readonly replicaRetired?: true;
}
export interface ReplicaCommandResult {
  readonly commandId: string;
  readonly outcome: 'done' | 'failed';
  readonly code?: string;
}

export interface ReplicaAckWarning { readonly code: string; readonly message: string; readonly path?: string }

export type ReplicaHealthErrorCode = 'invalid_document' | 'invalid_token' | 'resource_not_found' | 'replica_retired';

export class ReplicaHealthError extends Error {
  constructor(readonly code: ReplicaHealthErrorCode) {
    super(`Replica health report denied: ${code}`);
    this.name = 'ReplicaHealthError';
  }
}

export interface ReplicaHealthRecorder {
  /** Stores the report unless a newer revision is already stored. */
  /**
   * Stores the report unless a newer revision is already stored, settles the
   * commands it reports on either way, and hands over the commands still open.
   */
  record(input: { readonly credential: VerifiedExtensionCredential; readonly report: ReplicaHealthReport; readonly replicaProof?: string;
    readonly supportsFencedRebuild?: boolean }):
    Promise<{ readonly accepted: boolean; readonly revision: number; readonly commands: readonly ReplicaCommand[] }>;
  /** Keeps the latest Ack warnings of a replica; an empty list clears them. */
  recordAckWarnings(input: { readonly replicaId: string; readonly warnings: readonly ReplicaAckWarning[] }): Promise<void>;
}

const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/u;

export function parseReplicaHealthReport(value: unknown): ReplicaHealthReport {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > REPLICA_HEALTH_MAX_BODY_BYTES) throw invalid();
  const document = object(value, ['replicaId', 'revision', 'state', 'code', 'since', 'issues', 'actions',
    'commandResults', 'extensionVersion']);
  const state = oneOf(document.state, REPLICA_HEALTH_STATES);
  const code = document.code === undefined ? undefined : pattern(document.code, CODE);
  if (state === 'stopped' && code === undefined) throw invalid();
  const issues = object(document.issues, ['total', 'items']);
  if (!Array.isArray(issues.items) || issues.items.length > REPLICA_HEALTH_MAX_ITEMS) throw invalid();
  const items = issues.items.map(parseIssue);
  const total = integer(issues.total, items.length, 100_000);
  if (new Set(items.map((item) => item.issueId)).size !== items.length) throw invalid();
  const actions = document.actions === undefined ? [] : actionList(document.actions, REPLICA_ACTIONS);
  const results = document.commandResults === undefined ? [] : document.commandResults;
  if (!Array.isArray(results) || results.length > REPLICA_COMMAND_RESULTS_MAX) throw invalid();
  const commandResults = results.map(parseCommandResult);
  if (new Set(commandResults.map((result) => result.commandId)).size !== commandResults.length) throw invalid();
  return Object.freeze({
    replicaId: pattern(document.replicaId, OPAQUE),
    revision: integer(document.revision, 1, Number.MAX_SAFE_INTEGER),
    state, ...(code === undefined ? {} : { code }),
    since: instant(document.since),
    issues: Object.freeze({ total, items: Object.freeze(items) }),
    actions, commandResults: Object.freeze(commandResults),
    ...(document.extensionVersion === undefined ? {} : { extensionVersion: pattern(document.extensionVersion, VERSION) }),
  });
}

function parseIssue(value: unknown): ReplicaHealthIssue {
  const issue = object(value, ['issueId', 'code', 'direction', 'nodeId', 'opId', 'title', 'count',
    'firstSeenAt', 'lastSeenAt', 'actions']);
  const actions = actionList(issue.actions, REPLICA_ISSUE_ACTIONS);
  if (issue.title !== undefined && (typeof issue.title !== 'string' || issue.title.length > REPLICA_HEALTH_TITLE_MAX)) throw invalid();
  const title = typeof issue.title === 'string' && issue.title.trim().length > 0
    && replicaReportTextIsSafe(issue.title) ? issue.title : undefined;
  return Object.freeze({
    issueId: pattern(issue.issueId, OPAQUE), code: pattern(issue.code, CODE),
    direction: oneOf(issue.direction, REPLICA_ISSUE_DIRECTIONS),
    ...(issue.nodeId === undefined ? {} : { nodeId: pattern(issue.nodeId, OPAQUE) }),
    ...(issue.opId === undefined ? {} : { opId: pattern(issue.opId, OPAQUE) }),
    ...(title === undefined ? {} : { title }),
    count: integer(issue.count, 1, 1_000_000),
    firstSeenAt: instant(issue.firstSeenAt), lastSeenAt: instant(issue.lastSeenAt),
    actions,
  });
}

function parseCommandResult(value: unknown): ReplicaCommandResult {
  const result = object(value, ['commandId', 'outcome', 'code']);
  const outcome = oneOf(result.outcome, ['done', 'failed'] as const);
  return Object.freeze({ commandId: pattern(result.commandId, OPAQUE), outcome,
    ...(result.code === undefined ? {} : { code: pattern(result.code, CODE) }) });
}

/** Parses a command a person asks for; an issue-less command must be about the whole replica. */
export function parseReplicaCommandRequest(value: unknown): { readonly action: ReplicaIssueAction; readonly issueId?: string } {
  const body = object(value, ['action', 'issueId']);
  const action = oneOf(body.action, REPLICA_ISSUE_ACTIONS);
  if (body.issueId === undefined) {
    if (!(REPLICA_ACTIONS as readonly string[]).includes(action)) throw invalid();
    return Object.freeze({ action });
  }
  return Object.freeze({ action, issueId: pattern(body.issueId, OPAQUE) });
}

function actionList<T extends ReplicaIssueAction>(value: unknown, allowed: readonly T[]): readonly T[] {
  if (!Array.isArray(value) || value.length > allowed.length) throw invalid();
  const actions = value.map((action) => oneOf(action, allowed));
  if (new Set(actions).size !== actions.length) throw invalid();
  return Object.freeze(actions);
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid();
  return value as T;
}
function pattern(value: unknown, expression: RegExp): string {
  if (typeof value !== 'string' || !expression.test(value)) throw invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
  return value as number;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      || Number.isNaN(Date.parse(value))) throw invalid();
  return new Date(value).toISOString();
}
function invalid() { return new ReplicaHealthError('invalid_document'); }
