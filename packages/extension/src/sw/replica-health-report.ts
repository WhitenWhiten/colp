import { readHealthReceipt } from './replica-health-receipt.js';
import { snapshotSyncIssues, issueId, serverNodeId, titleOf, instant, type ReplicaHealthIssue } from '../sync-issue-snapshot.js';
import { withResolvedTitles } from '../sync-issue-titles.js';
export { replicaIssuesFromQueue, replicaIssuesFromPull, replicaIssuesFromLocal, replicaIssuesFromWaits, type ReplicaHealthIssue } from '../sync-issue-snapshot.js';
import { readOpenSyncIssues } from '../sync-issues.js';
import { createHealthDelivery } from './replica-health-delivery.js';
import { REPLICA_HEALTH_MAX_BODY_BYTES, REPLICA_HEALTH_MAX_ITEMS, REPLICA_COMMAND_RESULTS_MAX } from '../generated/replica-health-limits.js';
/**
 * The browser's own account of its sync, sent to the server's Sync center.
 *
 * A stopped engine makes no Session, Pull, Push or Ack request, so before this
 * report the server could not tell a stuck browser from an idle one. The report
 * is computed from the same read-only aggregate as the Status tab
 * (`handleSyncAttentionRequest`), using a shared issue snapshot. Sending it is
 * the only request a stopped engine makes: it needs no Session and renews
 * nothing on the server.
 *
 * The response hands over what the owner asked of this browser in the Sync
 * center. A command is carried out only when the report it answers still offers
 * its action, at most once (the record keeps every command seen), and its
 * result goes back in the next report.
 */
import { colpCredentialHeaders } from '../auth-client.js';
import { assertCredentialHostPermission } from '../server-origin-permission.js';
import { digestJson } from '../bookmark-event-codec.js';
import type { StorageArea } from '../credential-store.js';
import type { PersonalSyncMode } from '../personal-sync-policy.js';
import type { LocalIssueRecord, PullIssueRecord, QueueOperation, SyncScope } from '../sync-state-store.js';
import { refreshesReplicaIntegrity } from '../sync-failure-class.js';
import { problemOffersRetry } from '../sync-problem-catalog.js';
import type { PublicSyncAttention } from '../types.js';
import { handleSyncAttentionRequest, readStalledUpload, type SyncAttentionStore } from './sync-attention.js';
import type { SyncWatchdog } from './sync-watchdog.js';
import { readVisibleWakeFailures, replicaIssuesFromUnreadable, replicaIssuesFromWakeFailures } from './engine-issues.js';
import { storageStopProjection } from './storage-attention.js';

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

export type ReplicaHealthState = 'syncing' | 'degraded' | 'stopped' | 'paused';
/** What this browser can do when the Sync center asks: for itself, or for one issue. */
export type ReplicaAction = 'retry' | 'rebuild';
export interface ReplicaCommand { readonly commandId: string; readonly action: string; readonly issueId?: string;
  readonly replicaRetired?: true }
export interface ReplicaCommandOutcome {
  readonly outcome: 'done' | 'failed';
  readonly code?: string;
  /** The command replaced this replica (a rebuild); its result goes out under the old replica at once. */
  readonly replaced?: true;
}
export interface ReplicaCommandRunner {
  run?<T>(work: () => Promise<T>): Promise<T>;
  replica(action: ReplicaAction): Promise<ReplicaCommandOutcome>;
  serverRebuild?(): Promise<ReplicaCommandOutcome>;
  issue(action: 'retry', issue: ReplicaHealthIssue): Promise<ReplicaCommandOutcome>;
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
  readonly total?: number;
  /** This reporter can archive uncertain work after the server fences the old replica. */
  readonly serverRebuild?: boolean;
}): ReplicaHealthProjection {
  const total = input.total ?? input.issues.length;
  // While paused nothing syncs, so the report names no bookmarks and offers nothing.
  if (input.mode === 'paused') return { state: 'paused', issues: { total, items: [] }, actions: [] };
  const issues = { total, items: input.issues.slice(0, MAX_ITEMS) };
  const canRebuild = input.attention.rebuildAvailable === true
    || input.serverRebuild && input.attention.rebuildUnavailableReason !== 'rebuild_not_required';
  if (input.mode === 'target-unavailable') return { state: 'stopped', code: 'target_unavailable', issues, actions: [] };
  // Access removed after setup: nothing can run and Retry cannot help; only a person can allow it again.
  if (input.attention.permissionRequired) return { state: 'stopped', code: 'permission_required', issues, actions: [] };
  // A breaker that tripped on something that ends by itself is a pause: the browser tries again on its own,
  // and a Retry skips the wait. It is not a stop, so the Sync center does not call it one.
  if (input.attention.coolingDown && !input.attention.terminal) {
    const code = [input.attention.lastError].find((value) => value && CODE.test(value));
    return { state: 'degraded', code: code ?? 'sync_failed', issues,
      actions: ['retry', ...(canRebuild && total > 0 ? ['rebuild' as const] : [])] };
  }
  // A stall nothing else names (`sync-watchdog.ts`): the Sync center is told it is stuck, with a Retry to try.
  if (input.attention.watchdog && !input.attention.terminal && input.attention.retryAutomatic !== false) {
    return { state: 'degraded', code: input.attention.watchdog.kind === 'stuck' ? 'sync_stuck' : 'sync_not_completing', issues,
      actions: ['retry', ...(canRebuild && total > 0 ? ['rebuild' as const] : [])] };
  }
  if (input.attention.retryAutomatic === false || input.attention.terminal
      || input.attention.recoveryFrozen && refreshesReplicaIntegrity(input.attention.lastError ?? input.attention.recoveryCode)) {
    const code = [input.attention.terminalCode, input.attention.lastError].find((value) => value && CODE.test(value));
    // A retry is a manual wake: a cheap probe worth offering for everything except a state that waits for
    // a Reset or a decision. The extension's own card follows the same rule (`problemOffersRetry`).
    const actions: ReplicaAction[] = problemOffersRetry(code) ? ['retry'] : [];
    // Local rebuild uses receipt guards; a negotiated server fence also makes
    // uncertain uploads recoverable without replaying them.
    if (canRebuild) actions.push('rebuild');
    return { state: 'stopped', code: code ?? 'sync_stopped', issues, actions };
  }
  return { state: total > 0 ? 'degraded' : 'syncing', issues, actions: [...(input.attention.retryAvailable ? ['retry' as const] : []),
    ...(canRebuild && total > 0 ? ['rebuild' as const] : [])] };
}

interface SentRecord {
  readonly replicaId: string;
  readonly digest?: string;
  readonly sentAt?: number;
  readonly revision?: number;
  readonly unsupportedUntil?: number;
  /** The last unsent report and when it may be tried again; `code` says why and `since` when it first failed. */
  readonly failed?: { readonly digest: string; readonly retryAt: number; readonly at?: number;
    readonly code?: string; readonly since?: number };
  /** When the current state began, kept even while a send keeps failing. */
  readonly observed?: { readonly state: ReplicaHealthState; readonly code?: string; readonly since: number };
  /** Every command seen, newest last; a result is sent until a report carrying it is accepted. */
  readonly commands?: readonly CommandRecord[];
}
interface CommandRecord {
  readonly commandId: string;
  readonly action?: string;
  readonly outcome?: 'done' | 'failed';
  readonly code?: string;
  readonly reported?: true;
}

export interface ReplicaHealthReporterDeps {
  readonly scope: SyncScope;
  readonly store: SyncAttentionStore & {
    readonly listBootstrapRuns: NonNullable<SyncAttentionStore['listBootstrapRuns']>;
    readonly listPullIssues?: (scope: SyncScope) => Promise<PullIssueRecord[]>;
    readonly listLocalIssues?: (scope: SyncScope) => Promise<LocalIssueRecord[]>;
    readonly exportArchive?: (scope: SyncScope) => Promise<{ readonly reason?: unknown }>;
  };
  readonly mode: () => Promise<PersonalSyncMode | undefined>;
  readonly rebuildPending?: () => Promise<boolean>;
  /** Whether the browser still lets this extension read and change bookmarks. */
  readonly bookmarkPermission?: () => Promise<boolean>;
  /** Notices a stall nothing else explains. */
  readonly watchdog?: SyncWatchdog;
  readonly credential: () => Promise<{ readonly accessToken: string; readonly serverOrigin: string; readonly subject?: string }>;
  readonly fetch: typeof fetch;
  readonly storage: Pick<StorageArea, 'get' | 'set'>;
  readonly origin: string;
  readonly replicaProof?: (scope: SyncScope) => Promise<string | undefined>;
  readonly extensionVersion?: string;
  readonly now: () => number;
  /** Carries out what the Sync center asks; without one, commands are left for a later report. */
  readonly commands?: ReplicaCommandRunner;
  /** Captured before dispatch, checked again inside the serialized execution lane. */
  readonly assertCommandCurrent?: () => Promise<void>;
  /** Send even when nothing changed since the last report. */
  readonly force?: boolean;
  readonly requestTimeoutMilliseconds?: number;
}

/** `ran`: the report was sent and commands were carried out; report again to send their results. */
export type ReplicaHealthSendOutcome = 'sent' | 'ran' | 'unchanged' | 'unsupported' | 'disconnected' | 'failed';

export async function sendReplicaHealthReport(deps: ReplicaHealthReporterDeps): Promise<ReplicaHealthSendOutcome> {
  const mode = await deps.mode();
  // A deliberate disconnect is not a sync problem; the browser says nothing.
  if (mode === 'disconnected') return 'disconnected';
  const delivery = await createHealthDelivery({ scope: deps.scope, storage: deps.storage, now: deps.now,
    post: (body, scope) => post({ ...deps, scope }, body), receiptTimeoutMilliseconds: deps.requestTimeoutMilliseconds, archive: deps.store.exportArchive });
  deps = { ...deps, storage: delivery.storage };
  const stored = (await deps.storage.get(REPLICA_HEALTH_RECORD_KEY))[REPLICA_HEALTH_RECORD_KEY] as SentRecord | undefined;
  const record: SentRecord = stored?.replicaId === deps.scope.replicaId ? stored : { replicaId: deps.scope.replicaId };
  // Diagnostics use IndexedDB; delivery uses the separate Chrome storage journal.
  // Preserve an unsent diagnostic failure even if IndexedDB recovers before retry.
  const unavailable: ReplicaHealthProjection = { state: 'stopped', code: 'sync_diagnostics_unavailable',
    issues: { total: 0, items: [] }, actions: deps.commands?.serverRebuild ? ['rebuild'] : [] };
  const projection = record.failed && record.observed?.code === unavailable.code ? unavailable
    : await readProjection(deps).catch(async () => await storageStopProjection(deps.store) ?? unavailable);
  // Times are display facts: a report that only moved a clock is not a change.
  const digest = digestJson({ state: projection.state, code: projection.code ?? null, total: projection.issues.total,
    items: projection.issues.items.map((item) => [item.issueId, item.code, item.title ?? null, item.count, ...item.actions]),
    actions: [...projection.actions] });
  const now = deps.now();
  const same = record.observed?.state === projection.state && record.observed.code === projection.code;
  const observed = same && record.observed && Number.isFinite(record.observed.since) ? record.observed
    : { state: projection.state, ...(projection.code ? { code: projection.code } : {}), since: now };
  if (!same) await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed } });
  const results = unreported(record.commands);
  if (!deps.force) {
    if ((record.unsupportedUntil ?? 0) > now) return 'unsupported';
    if (record.failed?.digest === digest && now >= (record.failed.at ?? record.failed.retryAt - FAILED_RETRY_MS) && record.failed.retryAt > now) return 'unchanged';
    // Unsent results make a report due even when nothing else changed.
    const heartbeat = projection.state === 'syncing' || projection.state === 'paused'
      ? REPLICA_HEALTH_HEARTBEAT_MS : REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS;
    if (!record.failed && results.length === 0 && record.digest === digest && now >= (record.sentAt ?? 0) && now - (record.sentAt ?? 0) < heartbeat) return 'unchanged';
  }
  const floor = Number.isSafeInteger(record.revision) && record.revision! >= 0 ? record.revision! : 0;
  const revision = Math.max(now, floor + 1);
  if (!Number.isSafeInteger(revision)) throw new Error('health_revision_exhausted');
  // Reserve before sending: a lost response or clock rollback cannot reuse the local revision.
  await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed, revision } });
  const body = { replicaId: deps.scope.replicaId, revision, state: projection.state,
    ...(projection.code ? { code: projection.code } : {}), since: new Date(observed.since).toISOString(),
    issues: projection.issues, actions: projection.actions, ...(results.length > 0 ? { commandResults: results } : {}),
    ...(deps.extensionVersion ? { extensionVersion: deps.extensionVersion } : {}) };
  const failed = async (code: string): Promise<'failed'> => {
    await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed, revision,
      failed: { digest, retryAt: now + FAILED_RETRY_MS, at: now, code, since: record.failed?.since ?? now } } });
    return 'failed';
  };
  let sent: Response;
  try { sent = await post(deps, body); } catch (error) { return failed(deliveryErrorCode(error)); }
  // The route's own 404 (unknown replica) is plain JSON; a server without the
  // route answers with the publication Problem.
  if (sent.status === 404 && !/^application\/json/iu.test(sent.headers.get('Content-Type') ?? '')) {
    await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed, unsupportedUntil: now + UNSUPPORTED_RETRY_MS } });
    return 'unsupported';
  }
  if (sent.status !== 200) return failed(`health_http_${sent.status}`);
  let document;
  try { document = await readHealthReceipt(sent, body, { timeoutMilliseconds: deps.requestTimeoutMilliseconds ?? 10_000 }); }
  catch { return failed('health_receipt_invalid'); }
  // An accepted report carried these results; the server keeps them whatever its revision.
  const sentIds = new Set(results.map((result) => result.commandId));
  let commands = (record.commands ?? []).map((entry) => sentIds.has(entry.commandId) ? { ...entry, reported: true as const } : entry);
  const save = (list: readonly CommandRecord[]) => deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: {
    replicaId: deps.scope.replicaId,
    ...(document.accepted ? { digest, sentAt: now } : { failed: { digest, retryAt: now + FAILED_RETRY_MS, at: now,
      code: 'health_not_accepted', since: record.failed?.since ?? now } }),
    revision: Math.max(revision, document.revision), observed, commands: kept(list) } satisfies SentRecord });
  await save(commands);
  const delivered = deliveredCommands(document);
  let ran = false; let replaced = false;
  for (const command of delivered) {
    const seen = commands.find((entry) => entry.commandId === command.commandId);
    if (seen && !(command.replicaRetired && command.action === 'rebuild' && !seen.outcome)) {
      // Seen without a result: the worker stopped while carrying it out, so it is never run again.
      // Seen with one: the server has not taken it yet, so it goes out again.
      commands = commands.map((entry) => entry !== seen ? entry : entry.outcome
        ? { commandId: entry.commandId, outcome: entry.outcome, ...(entry.code ? { code: entry.code } : {}) }
        : { commandId: entry.commandId, outcome: 'failed', code: 'command_interrupted' });
      await save(commands); ran = true; continue;
    }
    if (replaced || !deps.commands) continue;
    if (!seen) commands = [...commands, { commandId: command.commandId, action: command.action }];
    await save(commands);
    const outcome = await carryOut(command, deps, deps.commands);
    replaced ||= outcome.replaced === true; ran = true;
    commands = commands.map((entry) => entry.commandId === command.commandId ? { commandId: entry.commandId,
      outcome: outcome.outcome, ...(outcome.code ? { code: outcome.code } : {}) } : entry);
    await save(commands);
  }
  const locallyRebuilt = !replaced && (await deps.store.exportArchive?.(deps.scope).catch(() => undefined))?.reason === 'user_replica_rebuild';
  if (replaced || locallyRebuilt) {
    // This replica is gone; its last word says so and carries the results.
    const final = unreported(commands);
    await delivery.stageFinal({ replicaId: deps.scope.replicaId, revision: Math.max(revision, document.revision) + 1, state: 'stopped',
      code: 'replica_rebuilt', since: new Date(deps.now()).toISOString(), issues: { total: 0, items: [] },
      actions: [], commandResults: final });
    return 'sent';
  }
  return ran ? 'ran' : 'sent';
}

/** Why a send did not get an answer, as a code the Status card can show. */
function deliveryErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (CODE.test(message)) return message;
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'health_timeout' : 'health_unreachable';
}

export const REPLICA_DISCONNECTED_CODE = 'sync_disconnected';

/**
 * A deliberate disconnect says so once, before this browser leaves its library:
 * without it the Sync center keeps showing the last state the browser had until
 * the lease lapses. It goes out as a final delivery, which the journal keeps
 * retrying under the same account and profile after the replica is gone.
 */
export async function sendReplicaDisconnectReport(deps: ReplicaHealthReporterDeps): Promise<'sent' | 'unchanged'> {
  const delivery = await createHealthDelivery({ scope: deps.scope, storage: deps.storage, now: deps.now,
    post: (body, scope) => post({ ...deps, scope }, body), receiptTimeoutMilliseconds: deps.requestTimeoutMilliseconds, archive: deps.store.exportArchive });
  const stored = (await delivery.storage.get(REPLICA_HEALTH_RECORD_KEY))[REPLICA_HEALTH_RECORD_KEY] as SentRecord | undefined;
  const record: SentRecord = stored?.replicaId === deps.scope.replicaId ? stored : { replicaId: deps.scope.replicaId };
  if (record.observed?.code === REPLICA_DISCONNECTED_CODE) return 'unchanged';
  const now = deps.now();
  const revision = Math.max(now, (Number.isSafeInteger(record.revision) ? record.revision! : 0) + 1);
  await delivery.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, revision,
    observed: { state: 'paused', code: REPLICA_DISCONNECTED_CODE, since: now } } satisfies SentRecord });
  await delivery.stageFinal({ replicaId: deps.scope.replicaId, revision, state: 'paused', code: REPLICA_DISCONNECTED_CODE,
    since: new Date(now).toISOString(), issues: { total: 0, items: [] }, actions: [], commandResults: unreported(record.commands) });
  return 'sent';
}

async function post(deps: ReplicaHealthReporterDeps, body: Record<string, unknown>): Promise<Response> {
  const credential = await deps.credential();
  if (credential.subject !== deps.scope.accountId || credential.serverOrigin.replace(/\/$/u, '') !== deps.scope.serverOrigin.replace(/\/$/u, '')) {
    throw new Error('health_authority_mismatch');
  }
  const proof = await deps.replicaProof?.(deps.scope);
  const url = `${credential.serverOrigin.replace(/\/$/u, '')}${REPLICA_HEALTH_PATH}`;
  const init: RequestInit = {
    method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(deps.requestTimeoutMilliseconds ?? 10_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: deps.origin,
      ...colpCredentialHeaders(credential.accessToken), ...(proof ? { 'Known-Sync-Replica-Proof': proof } : {}) },
    body: JSON.stringify(fitReplicaHealthBody(body)),
  };
  if (deps.commands?.serverRebuild) (init.headers as Record<string, string>)['Known-Sync-Rebuild'] = 'retire';
  await assertCredentialHostPermission(url, init);
  return deps.fetch(url, init);
}

async function readProjection(deps: ReplicaHealthReporterDeps): Promise<ReplicaHealthProjection> {
  if (!deps.store.listBootstrapRuns) throw new Error('bootstrap_state_unavailable');
  const open = await readOpenSyncIssues(deps.store, deps.scope);
  const response = await handleSyncAttentionRequest({ scope: async () => deps.scope, store: deps.store, openIssues: open,
    ...(deps.rebuildPending ? { rebuildPending: deps.rebuildPending } : {}),
    ...(deps.bookmarkPermission ? { bookmarkPermission: deps.bookmarkPermission } : {}),
    ...(deps.watchdog ? { watchdog: deps.watchdog } : {}) });
  if (response.ok !== true) throw new Error('scope_unavailable');
  const issues = await withResolvedTitles(snapshotSyncIssues(open), deps.scope, deps.store.getMappingByColpId?.bind(deps.store));
  const stalled = await readStalledUpload(deps.store, deps.scope);
  if (stalled) issues.push(stalledUploadIssue(stalled.row, stalled.code, deps.now()));
  // Engine-level items no row carries: unreadable saved uploads (Rule C) and failing wake steps (Rule E).
  const unreadable = await deps.store.listUnreadableQueue?.(deps.scope).catch(() => []) ?? [];
  const failedSteps = await readVisibleWakeFailures(deps.scope.replicaId);
  issues.push(...replicaIssuesFromUnreadable(unreadable, deps.now()), ...replicaIssuesFromWakeFailures(failedSteps));
  const mode = await deps.mode();
  return projectReplicaHealth({ ...(mode ? { mode } : {}), attention: response.attention, issues,
    total: open.total + (stalled ? 1 : 0) + unreadable.length + failedSteps.length,
    serverRebuild: deps.commands?.serverRebuild !== undefined });
}

/** A sent change the server has kept unsettled; later uploads wait behind it, so the Sync center must see it. */
function stalledUploadIssue(row: QueueOperation, code: string, now: number): ReplicaHealthIssue {
  const nodeId = serverNodeId(row.payload.targetId); const title = titleOf(row.payload);
  return { issueId: issueId(['push', 'stalled', row.opId]), code: CODE.test(code) ? code : 'push_stalled', direction: 'push',
    ...(nodeId ? { nodeId } : {}), ...(OPAQUE.test(row.opId) ? { opId: row.opId } : {}), ...(title ? { title } : {}),
    count: Math.max(1, row.retry.attempt), firstSeenAt: instant(row.payload.occurredAt),
    lastSeenAt: new Date(now).toISOString(), actions: [] };
}

/** Checks the command against what this browser offers now, not what it offered when the owner asked. */
async function carryOut(command: ReplicaCommand, deps: ReplicaHealthReporterDeps,
  runner: ReplicaCommandRunner): Promise<ReplicaCommandOutcome> {
  try {
    // A restarted reset may already have archived/rotated the old scope. Its
    // durable archive proves completion of that phase; never rotate twice.
    if (command.replicaRetired && command.action === 'rebuild'
        && (await deps.store.exportArchive?.(deps.scope).catch(() => undefined))?.reason === 'user_replica_rebuild'
        && !await deps.rebuildPending?.()) return { outcome: 'done', replaced: true };
    const execute = async (): Promise<ReplicaCommandOutcome> => {
      await deps.assertCommandCurrent?.();
      // The user already confirmed this reset and the server committed the
      // retirement. A new local error or disappeared issue cannot cancel it.
      if (command.replicaRetired && command.action === 'rebuild' && command.issueId === undefined) {
        return runner.serverRebuild ? runner.serverRebuild() : { outcome: 'failed', code: 'action_unavailable' };
      }
      const projection = await readProjection(deps);
      if (command.issueId === undefined) {
        const action = projection.actions.find((offered) => offered === command.action);
        return action ? await runner.replica(action) : { outcome: 'failed', code: 'action_unavailable' };
      }
      const issue = projection.issues.items.find((item) => item.issueId === command.issueId);
      if (!issue) return { outcome: 'failed', code: 'issue_gone' };
      return command.action === 'retry' && issue.actions.includes('retry') ? await runner.issue('retry', issue)
        : { outcome: 'failed', code: 'action_unavailable' };
    };
    return runner.run ? await runner.run(execute) : await execute();
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
    const { commandId, action, issueId, replicaRetired } = item as Record<string, unknown>;
    if (typeof commandId !== 'string' || !OPAQUE.test(commandId) || typeof action !== 'string' || !CODE.test(action)
        || (issueId !== undefined && (typeof issueId !== 'string' || !OPAQUE.test(issueId)))) return [];
    return [{ commandId, action, ...(typeof issueId === 'string' ? { issueId } : {}),
      ...(replicaRetired === true ? { replicaRetired: true as const } : {}) }];
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
    if (index < 0) break;
    list = list.filter((_, position) => position !== index);
  }
  return list;
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
