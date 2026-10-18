import { REPLICA_HEALTH_MAX_BODY_BYTES, REPLICA_HEALTH_MAX_ITEMS, REPLICA_COMMAND_RESULTS_MAX,
  REPLICA_HEALTH_TITLE_MAX } from '../generated/replica-health-limits.js';
/**
 * The browser's own account of its sync, sent to the server's Sync center.
 *
 * A stopped engine makes no Session, Pull, Push or Ack request, so before this
 * report the server could not tell a stuck browser from an idle one. The report
 * is computed from the same read-only aggregate as the Status tab
 * (`handleSyncAttentionRequest`), so the two can never disagree. Sending it is
 * the only request a stopped engine makes: it needs no Session and renews
 * nothing on the server.
 *
 * The response hands over what the owner asked of this browser in the Sync
 * center. A command is carried out only when the report it answers still offers
 * its action, at most once (the record keeps every command seen), and its
 * result goes back in the next report.
 */
import { colpCredentialHeaders } from '../auth-client.js';
import { digestJson } from '../bookmark-event-codec.js';
import type { StorageArea } from '../credential-store.js';
import type { NativeWaitProjection } from '../native-create-executor.js';
import { projectNativeWaits } from '../native-wait.js';
import type { PersonalSyncMode } from '../personal-sync-policy.js';
import type { LocalIssueRecord, PullIssueRecord, QueueOperation, SyncScope } from '../sync-state-store.js';
import { classifySyncFailure, needsReplicaRebuild, persistentLocalSyncFailure } from '../sync-failure-class.js';
import type { PublicSyncAttention } from '../types.js';
import { handleSyncAttentionRequest, type SyncAttentionStore } from './sync-attention.js';

export const REPLICA_HEALTH_PATH = '/colp/v0.1/sync/replica-health';
export const REPLICA_HEALTH_RECORD_KEY = 'known.sync.health.v1';
/** A report goes out on every change, and at least this often while signed in. */
export const REPLICA_HEALTH_HEARTBEAT_MS = 15 * 60_000;
/** While something needs attention the browser checks in sooner, so a command from the Sync center runs soon. */
export const REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS = 5 * 60_000;
/** Commands remembered so a redelivered one never runs twice; the server expires them after seven days. */
const MAX_COMMANDS_KEPT = 32;
const MAX_RESULTS_SENT = REPLICA_COMMAND_RESULTS_MAX;
const MAX_ITEMS = REPLICA_HEALTH_MAX_ITEMS;
/** A server without the route answers 404; ask again later instead of on every pass. */
const UNSUPPORTED_RETRY_MS = 6 * 60 * 60_000;
/** A failed send is retried on a later pass, not on every engine wake. */
const FAILED_RETRY_MS = 60_000;
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
/** Identities that exist before the server has the node (see sync-progress.ts). */
const PROVISIONAL = /^(?:pending-|local-|mount:)/u;

export type ReplicaHealthState = 'syncing' | 'degraded' | 'stopped' | 'paused';
/** What this browser can do when the Sync center asks: for itself, or for one issue. */
export type ReplicaAction = 'retry' | 'rebuild';
export interface ReplicaCommand { readonly commandId: string; readonly action: string; readonly issueId?: string }
export interface ReplicaCommandOutcome {
  readonly outcome: 'done' | 'failed';
  readonly code?: string;
  /** The command replaced this replica (a rebuild); its result goes out under the old replica at once. */
  readonly replaced?: true;
}
export interface ReplicaCommandRunner {
  replica(action: ReplicaAction): Promise<ReplicaCommandOutcome>;
  issue(action: 'retry', issue: ReplicaHealthIssue): Promise<ReplicaCommandOutcome>;
}
export interface ReplicaHealthIssue {
  readonly issueId: string;
  readonly code: string;
  readonly direction: 'push' | 'pull' | 'local';
  readonly nodeId?: string;
  readonly opId?: string;
  readonly title?: string;
  readonly count: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly actions: readonly 'retry'[];
}
export interface ReplicaHealthProjection {
  readonly state: ReplicaHealthState;
  readonly code?: string;
  readonly issues: { readonly total: number; readonly items: readonly ReplicaHealthIssue[] };
  readonly actions: readonly ReplicaAction[];
}

/** One state for the whole browser; item problems make it degraded, never stopped. */
export function projectReplicaHealth(input: {
  readonly mode?: PersonalSyncMode;
  readonly attention: PublicSyncAttention;
  readonly issues: readonly ReplicaHealthIssue[];
}): ReplicaHealthProjection {
  const total = input.issues.length;
  // While paused nothing syncs, so the report names no bookmarks and offers nothing.
  if (input.mode === 'paused') return { state: 'paused', issues: { total, items: [] }, actions: [] };
  const issues = { total, items: input.issues.slice(0, MAX_ITEMS) };
  if (input.mode === 'target-unavailable') return { state: 'stopped', code: 'target_unavailable', issues, actions: [] };
  if (input.attention.retryAutomatic === false || input.attention.terminal) {
    const code = [input.attention.terminalCode, input.attention.lastError].find((value) => value && CODE.test(value));
    // A retry is a manual wake; it cannot end a stop whose only way out is a rebuild or a fix.
    const actions: ReplicaAction[] = needsReplicaRebuild(code) || persistentLocalSyncFailure(code) ? [] : ['retry'];
    // The same precondition as the extension's own Reset button (replica-rebuild.ts).
    if (input.attention.recoveryFrozen || input.attention.rebuildAvailable || total > 0) actions.push('rebuild');
    return { state: 'stopped', code: code ?? 'sync_stopped', issues, actions };
  }
  return { state: total > 0 ? 'degraded' : 'syncing', issues, actions: total > 0 ? ['rebuild'] : [] };
}

/** Uploads the server refused, held for a conflict, or set aside for another problem, one issue each. */
export function replicaIssuesFromQueue(rows: readonly QueueOperation[]): ReplicaHealthIssue[] {
  return rows.flatMap((row) => {
    if (row.recovery?.code === 'recaptured') return [];
    const conflict = row.status === 'blocked' && row.recovery?.code === 'conflict_pending';
    if (row.status !== 'rejected' && row.status !== 'set_aside' && !conflict) return [];
    const fallback = row.status === 'set_aside' ? 'set_aside' : 'push_rejected';
    const code = conflict ? 'conflict_pending' : CODE.test(row.recovery?.code ?? '') ? row.recovery!.code : fallback;
    const at = instant(row.payload.occurredAt);
    const nodeId = serverNodeId(row.payload.targetId);
    const title = titleOf(row.payload);
    // A change held for a decision about its own placement or identity goes through the same checks again.
    const retry = row.status === 'set_aside' && OPAQUE.test(row.opId) && classifySyncFailure(code)?.exit === 'decide';
    return [{ issueId: issueId(['push', code, row.opId]), code, direction: 'push' as const,
      ...(nodeId ? { nodeId } : {}), ...(OPAQUE.test(row.opId) ? { opId: row.opId } : {}),
      ...(title ? { title } : {}), count: 1, firstSeenAt: at, lastSeenAt: at, actions: retry ? ['retry' as const] : [] }];
  });
}

/** Remote nodes this browser set aside while taking in changes, one issue each. */
export function replicaIssuesFromPull(rows: readonly PullIssueRecord[]): ReplicaHealthIssue[] {
  return rows.flatMap((row) => {
    const nodeId = serverNodeId(row.nodeId);
    if (!nodeId || !CODE.test(row.code)) return [];
    const title = typeof row.title === 'string' ? bounded(row.title) : undefined;
    return [{ issueId: issueId(['pull', 'node', nodeId]), code: row.code, direction: 'pull' as const, nodeId,
      ...(title ? { title } : {}), count: Math.max(1, row.count), firstSeenAt: new Date(row.firstSeenAt).toISOString(),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(), actions: [] }];
  });
}

/** Browser changes that could not be tied to the library. Browser ids never leave the browser. */
export function replicaIssuesFromLocal(rows: readonly LocalIssueRecord[]): ReplicaHealthIssue[] {
  return rows.flatMap((row) => {
    if (!CODE.test(row.code)) return [];
    const title = typeof row.title === 'string' ? bounded(row.title) : undefined;
    return [{ issueId: issueId(['local', row.code, row.nativeId]), code: row.code, direction: 'local' as const,
      ...(title ? { title } : {}), count: Math.max(1, row.count), firstSeenAt: new Date(row.firstSeenAt).toISOString(),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(), actions: [] }];
  });
}

/** Cloud changes waiting for the user's decision about the browser's result. */
export function replicaIssuesFromWaits(waits: readonly NativeWaitProjection[]): ReplicaHealthIssue[] {
  return waits.map((wait) => {
    const nodeId = serverNodeId(wait.colpId);
    const title = typeof wait.title === 'string' ? bounded(wait.title) : undefined;
    const at = new Date(0).toISOString();
    return { issueId: issueId(['pull', wait.waitReason, wait.intentId]), code: wait.waitReason, direction: 'pull' as const,
      ...(nodeId ? { nodeId } : {}), ...(title ? { title } : {}), count: 1, firstSeenAt: at, lastSeenAt: at, actions: [] };
  });
}

interface SentRecord {
  readonly replicaId: string;
  readonly digest?: string;
  readonly sentAt?: number;
  readonly revision?: number;
  readonly unsupportedUntil?: number;
  /** The last unsent report and when it may be tried again. */
  readonly failed?: { readonly digest: string; readonly retryAt: number };
  /** When the current state began, kept even while a send keeps failing. */
  readonly observed?: { readonly state: ReplicaHealthState; readonly code?: string; readonly since: number };
  /** Every command seen, newest last; a result is sent until a report carrying it is accepted. */
  readonly commands?: readonly CommandRecord[];
}
interface CommandRecord {
  readonly commandId: string;
  readonly outcome?: 'done' | 'failed';
  readonly code?: string;
  readonly reported?: true;
}

export interface ReplicaHealthReporterDeps {
  readonly scope: SyncScope;
  readonly store: SyncAttentionStore & {
    readonly listPullIssues?: (scope: SyncScope) => Promise<PullIssueRecord[]>;
    readonly listLocalIssues?: (scope: SyncScope) => Promise<LocalIssueRecord[]>;
  };
  readonly mode: () => Promise<PersonalSyncMode | undefined>;
  readonly rebuildPending?: () => Promise<boolean>;
  readonly credential: () => Promise<{ readonly accessToken: string; readonly serverOrigin: string }>;
  readonly fetch: typeof fetch;
  readonly storage: Pick<StorageArea, 'get' | 'set'>;
  readonly origin: string;
  readonly extensionVersion?: string;
  readonly now: () => number;
  /** Carries out what the Sync center asks; without one, commands are left for a later report. */
  readonly commands?: ReplicaCommandRunner;
  /** Send even when nothing changed since the last report. */
  readonly force?: boolean;
}

/** `ran`: the report was sent and commands were carried out; report again to send their results. */
export type ReplicaHealthSendOutcome = 'sent' | 'ran' | 'unchanged' | 'unsupported' | 'disconnected' | 'failed';

export async function sendReplicaHealthReport(deps: ReplicaHealthReporterDeps): Promise<ReplicaHealthSendOutcome> {
  const mode = await deps.mode();
  // A deliberate disconnect is not a sync problem; the browser says nothing.
  if (mode === 'disconnected') return 'disconnected';
  const response = await handleSyncAttentionRequest({ scope: async () => deps.scope, store: deps.store,
    ...(deps.rebuildPending ? { rebuildPending: deps.rebuildPending } : {}) });
  if (response.ok !== true) return 'failed';
  const rows: QueueOperation[] = [];
  for (const status of ['blocked', 'rejected', 'set_aside'] as const) {
    rows.push(...await deps.store.listQueue(deps.scope, status, 0, 1_000).catch(() => []));
  }
  const waits = await projectNativeWaits(deps.store, deps.scope).catch(() => []);
  const pulled = await deps.store.listPullIssues?.(deps.scope).catch(() => []) ?? [];
  const local = await deps.store.listLocalIssues?.(deps.scope).catch(() => []) ?? [];
  const issues = [...replicaIssuesFromQueue(rows.sort((left, right) => left.sequence - right.sequence)),
    ...replicaIssuesFromPull(pulled), ...replicaIssuesFromLocal(local), ...replicaIssuesFromWaits(waits)];
  const projection = projectReplicaHealth({ ...(mode ? { mode } : {}), attention: response.attention, issues });
  // Times are display facts: a report that only moved a clock is not a change.
  const digest = digestJson({ state: projection.state, code: projection.code ?? null, total: projection.issues.total,
    items: projection.issues.items.map((item) => [item.issueId, item.count, ...item.actions]),
    actions: [...projection.actions] });
  const now = deps.now();
  const stored = (await deps.storage.get(REPLICA_HEALTH_RECORD_KEY))[REPLICA_HEALTH_RECORD_KEY] as SentRecord | undefined;
  const record: SentRecord = stored?.replicaId === deps.scope.replicaId ? stored : { replicaId: deps.scope.replicaId };
  const same = record.observed?.state === projection.state && record.observed.code === projection.code;
  const observed = same && record.observed ? record.observed
    : { state: projection.state, ...(projection.code ? { code: projection.code } : {}), since: now };
  if (!same) await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed } });
  const results = unreported(record.commands);
  if (!deps.force) {
    if ((record.unsupportedUntil ?? 0) > now) return 'unsupported';
    if (record.failed?.digest === digest && record.failed.retryAt > now) return 'unchanged';
    // Unsent results make a report due even when nothing else changed.
    const heartbeat = projection.state === 'syncing' || projection.state === 'paused'
      ? REPLICA_HEALTH_HEARTBEAT_MS : REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS;
    if (results.length === 0 && record.digest === digest && now - (record.sentAt ?? 0) < heartbeat) return 'unchanged';
  }
  const revision = Math.max(now, (record.revision ?? 0) + 1);
  const body = { replicaId: deps.scope.replicaId, revision, state: projection.state,
    ...(projection.code ? { code: projection.code } : {}), since: new Date(observed.since).toISOString(),
    issues: projection.issues, actions: projection.actions, ...(results.length > 0 ? { commandResults: results } : {}),
    ...(deps.extensionVersion ? { extensionVersion: deps.extensionVersion } : {}) };
  const failed = async (): Promise<'failed'> => {
    await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed,
      failed: { digest, retryAt: now + FAILED_RETRY_MS } } });
    return 'failed';
  };
  let sent: Response;
  try { sent = await post(deps, body); } catch { return failed(); }
  // The route's own 404 (unknown replica) is plain JSON; a server without the
  // route answers with the publication Problem.
  if (sent.status === 404 && !/^application\/json/iu.test(sent.headers.get('Content-Type') ?? '')) {
    await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed, unsupportedUntil: now + UNSUPPORTED_RETRY_MS } });
    return 'unsupported';
  }
  if (sent.status !== 200) return failed();
  // An accepted report carried these results; the server keeps them whatever its revision.
  const sentIds = new Set(results.map((result) => result.commandId));
  let commands = (record.commands ?? []).map((entry) => sentIds.has(entry.commandId) ? { ...entry, reported: true as const } : entry);
  const save = (list: readonly CommandRecord[]) => deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: {
    replicaId: deps.scope.replicaId, digest, sentAt: now, revision, observed, commands: kept(list) } satisfies SentRecord });
  await save(commands);
  const delivered = deliveredCommands(await sent.json().catch(() => undefined));
  let ran = false; let replaced = false;
  for (const command of delivered) {
    const seen = commands.find((entry) => entry.commandId === command.commandId);
    if (seen) {
      // Seen without a result: the worker stopped while carrying it out, so it is never run again.
      // Seen with one: the server has not taken it yet, so it goes out again.
      commands = commands.map((entry) => entry !== seen ? entry : entry.outcome
        ? { commandId: entry.commandId, outcome: entry.outcome, ...(entry.code ? { code: entry.code } : {}) }
        : { commandId: entry.commandId, outcome: 'failed', code: 'command_interrupted' });
      await save(commands); ran = true; continue;
    }
    if (replaced || !deps.commands) continue;
    commands = [...commands, { commandId: command.commandId }]; await save(commands);
    const outcome = await carryOut(command, projection, deps.commands);
    replaced ||= outcome.replaced === true; ran = true;
    commands = commands.map((entry) => entry.commandId === command.commandId ? { commandId: entry.commandId,
      outcome: outcome.outcome, ...(outcome.code ? { code: outcome.code } : {}) } : entry);
    await save(commands);
  }
  if (replaced) {
    // This replica is gone; its last word says so and carries the results.
    const final = unreported(commands);
    const farewell = await post(deps, { replicaId: deps.scope.replicaId, revision: revision + 1, state: 'stopped',
      code: 'replica_rebuilt', since: new Date(deps.now()).toISOString(), issues: { total: 0, items: [] },
      actions: [], commandResults: final }).catch(() => undefined);
    if (farewell?.status === 200) await save(commands.map((entry) => entry.outcome ? { ...entry, reported: true as const } : entry));
    return 'sent';
  }
  return ran ? 'ran' : 'sent';
}

async function post(deps: ReplicaHealthReporterDeps, body: Record<string, unknown>): Promise<Response> {
  const credential = await deps.credential();
  return deps.fetch(`${credential.serverOrigin.replace(/\/$/u, '')}${REPLICA_HEALTH_PATH}`, {
    method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: deps.origin,
      ...colpCredentialHeaders(credential.accessToken) },
    body: JSON.stringify(fitReplicaHealthBody(body)),
  });
}

/** Checks the command against what this browser offers now, not what it offered when the owner asked. */
async function carryOut(command: ReplicaCommand, projection: ReplicaHealthProjection,
  runner: ReplicaCommandRunner): Promise<ReplicaCommandOutcome> {
  try {
    if (command.issueId === undefined) {
      const action = projection.actions.find((offered) => offered === command.action);
      return action ? await runner.replica(action) : { outcome: 'failed', code: 'action_unavailable' };
    }
    const issue = projection.issues.items.find((item) => item.issueId === command.issueId);
    if (!issue) return { outcome: 'failed', code: 'issue_gone' };
    return command.action === 'retry' && issue.actions.includes('retry') ? await runner.issue('retry', issue)
      : { outcome: 'failed', code: 'action_unavailable' };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { outcome: 'failed', code: CODE.test(code) ? code : 'command_failed' };
  }
}

function deliveredCommands(value: unknown): ReplicaCommand[] {
  const list = value && typeof value === 'object' ? (value as { commands?: unknown }).commands : undefined;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const { commandId, action, issueId } = item as Record<string, unknown>;
    if (typeof commandId !== 'string' || !OPAQUE.test(commandId) || typeof action !== 'string' || !CODE.test(action)
        || (issueId !== undefined && (typeof issueId !== 'string' || !OPAQUE.test(issueId)))) return [];
    return [{ commandId, action, ...(typeof issueId === 'string' ? { issueId } : {}) }];
  });
}

function unreported(commands: readonly CommandRecord[] | undefined) {
  return (commands ?? []).filter((entry) => entry.outcome && !entry.reported).slice(0, MAX_RESULTS_SENT)
    .map((entry) => ({ commandId: entry.commandId, outcome: entry.outcome!, ...(entry.code ? { code: entry.code } : {}) }));
}

/** The newest commands, dropping reported ones first so a result is never lost. */
function kept(commands: readonly CommandRecord[]): CommandRecord[] {
  let list = [...commands];
  while (list.length > MAX_COMMANDS_KEPT) {
    const index = list.findIndex((entry) => entry.reported);
    list = list.filter((_, position) => position !== (index >= 0 ? index : 0));
  }
  return list;
}

function issueId(parts: readonly string[]): string { return digestJson([...parts]).slice('sha256:'.length, 'sha256:'.length + 32); }
function serverNodeId(value: unknown): string | undefined {
  return typeof value === 'string' && OPAQUE.test(value) && !PROVISIONAL.test(value) ? value : undefined;
}
function instant(value: unknown): string {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return new Date(Number.isNaN(time) ? 0 : time).toISOString();
}
function bounded(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.length > REPLICA_HEALTH_TITLE_MAX ? `${trimmed.slice(0, REPLICA_HEALTH_TITLE_MAX - 1)}…` : trimmed;
}
/** The title a create or edit carried, when the operation has one. */
function titleOf(operation: QueueOperation['payload']): string | undefined {
  const payload = operation.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const candidate of [record.node, record.value, record]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const title = (candidate as Record<string, unknown>).title;
      if (typeof title === 'string') return bounded(title);
    }
  }
  return undefined;
}

/** Bound the final wire JSON, reserving all state/actions/results before the issue prefix. */
export function fitReplicaHealthBody<T extends Record<string, unknown>>(body: T): T {
  const issues = body.issues as { total: number; items: readonly unknown[] };
  const fitted = { ...body, issues: { total: issues.total, items: [] as unknown[] } };
  const bytes = () => new TextEncoder().encode(JSON.stringify(fitted)).byteLength;
  if (bytes() > REPLICA_HEALTH_MAX_BODY_BYTES) throw new Error('health_required_fields_too_large');
  for (const item of issues.items.slice(0, MAX_ITEMS)) {
    fitted.issues.items.push(item);
    if (bytes() > REPLICA_HEALTH_MAX_BODY_BYTES) { fitted.issues.items.pop(); break; }
  }
  return fitted as T;
}
