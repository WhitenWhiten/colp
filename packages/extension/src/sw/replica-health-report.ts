/**
 * The browser's own account of its sync, sent to the server's Sync center.
 *
 * A stopped engine makes no Session, Pull, Push or Ack request, so before this
 * report the server could not tell a stuck browser from an idle one. The report
 * is computed from the same read-only aggregate as the Status tab
 * (`handleSyncAttentionRequest`), so the two can never disagree. Sending it is
 * the only request a stopped engine makes: it needs no Session and renews
 * nothing on the server.
 */
import { colpCredentialHeaders } from '../auth-client.js';
import { digestJson } from '../bookmark-event-codec.js';
import type { StorageArea } from '../credential-store.js';
import type { NativeWaitProjection } from '../native-create-executor.js';
import { projectNativeWaits } from '../native-wait.js';
import type { PersonalSyncMode } from '../personal-sync-policy.js';
import type { QueueOperation, SyncScope } from '../sync-state-store.js';
import type { PublicSyncAttention } from '../types.js';
import { handleSyncAttentionRequest, type SyncAttentionStore } from './sync-attention.js';

export const REPLICA_HEALTH_PATH = '/colp/v0.1/sync/replica-health';
export const REPLICA_HEALTH_RECORD_KEY = 'known.sync.health.v1';
/** A report goes out on every change, and at least this often while signed in. */
export const REPLICA_HEALTH_HEARTBEAT_MS = 15 * 60_000;
const MAX_ITEMS = 50;
/** A server without the route answers 404; ask again later instead of on every pass. */
const UNSUPPORTED_RETRY_MS = 6 * 60 * 60_000;
/** A failed send is retried on a later pass, not on every engine wake. */
const FAILED_RETRY_MS = 60_000;
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
/** Identities that exist before the server has the node (see sync-progress.ts). */
const PROVISIONAL = /^(?:pending-|local-|mount:)/u;

export type ReplicaHealthState = 'syncing' | 'degraded' | 'stopped' | 'paused';
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
  readonly actions: readonly string[];
}
export interface ReplicaHealthProjection {
  readonly state: ReplicaHealthState;
  readonly code?: string;
  readonly issues: { readonly total: number; readonly items: readonly ReplicaHealthIssue[] };
}

/** One state for the whole browser; item problems make it degraded, never stopped. */
export function projectReplicaHealth(input: {
  readonly mode?: PersonalSyncMode;
  readonly attention: PublicSyncAttention;
  readonly issues: readonly ReplicaHealthIssue[];
}): ReplicaHealthProjection {
  const total = input.issues.length;
  // While paused nothing syncs, so the report names no bookmarks.
  if (input.mode === 'paused') return { state: 'paused', issues: { total, items: [] } };
  const issues = { total, items: input.issues.slice(0, MAX_ITEMS) };
  if (input.mode === 'target-unavailable') return { state: 'stopped', code: 'target_unavailable', issues };
  if (input.attention.retryAutomatic === false || input.attention.terminal) {
    const code = [input.attention.terminalCode, input.attention.lastError].find((value) => value && CODE.test(value));
    return { state: 'stopped', code: code ?? 'sync_stopped', issues };
  }
  return total > 0 ? { state: 'degraded', issues } : { state: 'syncing', issues };
}

/** Uploads the server refused, and uploads held for a conflict, one issue each. */
export function replicaIssuesFromQueue(rows: readonly QueueOperation[]): ReplicaHealthIssue[] {
  return rows.flatMap((row) => {
    const conflict = row.status === 'blocked' && row.recovery?.code === 'conflict_pending';
    if (row.status !== 'rejected' && !conflict) return [];
    const code = conflict ? 'conflict_pending' : CODE.test(row.recovery?.code ?? '') ? row.recovery!.code : 'push_rejected';
    const at = instant(row.payload.occurredAt);
    const nodeId = serverNodeId(row.payload.targetId);
    const title = titleOf(row.payload);
    return [{ issueId: issueId(['push', code, row.opId]), code, direction: 'push' as const,
      ...(nodeId ? { nodeId } : {}), ...(OPAQUE.test(row.opId) ? { opId: row.opId } : {}),
      ...(title ? { title } : {}), count: 1, firstSeenAt: at, lastSeenAt: at, actions: [] }];
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
}

export interface ReplicaHealthReporterDeps {
  readonly scope: SyncScope;
  readonly store: SyncAttentionStore;
  readonly mode: () => Promise<PersonalSyncMode | undefined>;
  readonly rebuildPending?: () => Promise<boolean>;
  readonly credential: () => Promise<{ readonly accessToken: string; readonly serverOrigin: string }>;
  readonly fetch: typeof fetch;
  readonly storage: Pick<StorageArea, 'get' | 'set'>;
  readonly origin: string;
  readonly extensionVersion?: string;
  readonly now: () => number;
  /** Send even when nothing changed since the last report. */
  readonly force?: boolean;
}

export type ReplicaHealthSendOutcome = 'sent' | 'unchanged' | 'unsupported' | 'disconnected' | 'failed';

export async function sendReplicaHealthReport(deps: ReplicaHealthReporterDeps): Promise<ReplicaHealthSendOutcome> {
  const mode = await deps.mode();
  // A deliberate disconnect is not a sync problem; the browser says nothing.
  if (mode === 'disconnected') return 'disconnected';
  const response = await handleSyncAttentionRequest({ scope: async () => deps.scope, store: deps.store,
    ...(deps.rebuildPending ? { rebuildPending: deps.rebuildPending } : {}) });
  if (response.ok !== true) return 'failed';
  const rows: QueueOperation[] = [];
  for (const status of ['blocked', 'rejected'] as const) {
    rows.push(...await deps.store.listQueue(deps.scope, status, 0, 1_000).catch(() => []));
  }
  const waits = await projectNativeWaits(deps.store, deps.scope).catch(() => []);
  const issues = [...replicaIssuesFromQueue(rows.sort((left, right) => left.sequence - right.sequence)),
    ...replicaIssuesFromWaits(waits)];
  const projection = projectReplicaHealth({ ...(mode ? { mode } : {}), attention: response.attention, issues });
  // Times are display facts: a report that only moved a clock is not a change.
  const digest = digestJson({ state: projection.state, code: projection.code ?? null, total: projection.issues.total,
    items: projection.issues.items.map((item) => [item.issueId, item.count]) });
  const now = deps.now();
  const stored = (await deps.storage.get(REPLICA_HEALTH_RECORD_KEY))[REPLICA_HEALTH_RECORD_KEY] as SentRecord | undefined;
  const record: SentRecord = stored?.replicaId === deps.scope.replicaId ? stored : { replicaId: deps.scope.replicaId };
  const same = record.observed?.state === projection.state && record.observed.code === projection.code;
  const observed = same && record.observed ? record.observed
    : { state: projection.state, ...(projection.code ? { code: projection.code } : {}), since: now };
  if (!same) await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed } });
  if (!deps.force) {
    if ((record.unsupportedUntil ?? 0) > now) return 'unsupported';
    if (record.digest === digest && now - (record.sentAt ?? 0) < REPLICA_HEALTH_HEARTBEAT_MS) return 'unchanged';
    if (record.failed?.digest === digest && record.failed.retryAt > now) return 'unchanged';
  }
  const revision = Math.max(now, (record.revision ?? 0) + 1);
  const body = { replicaId: deps.scope.replicaId, revision, state: projection.state,
    ...(projection.code ? { code: projection.code } : {}), since: new Date(observed.since).toISOString(),
    issues: projection.issues, ...(deps.extensionVersion ? { extensionVersion: deps.extensionVersion } : {}) };
  const failed = async (): Promise<'failed'> => {
    await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed,
      failed: { digest, retryAt: now + FAILED_RETRY_MS } } });
    return 'failed';
  };
  let sent: Response;
  try {
    const credential = await deps.credential();
    sent = await deps.fetch(`${credential.serverOrigin.replace(/\/$/u, '')}${REPLICA_HEALTH_PATH}`, {
      method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: deps.origin,
        ...colpCredentialHeaders(credential.accessToken) },
      body: JSON.stringify(body),
    });
  } catch { return failed(); }
  // The route's own 404 (unknown replica) is plain JSON; a server without the
  // route answers with the publication Problem.
  if (sent.status === 404 && !/^application\/json/iu.test(sent.headers.get('Content-Type') ?? '')) {
    await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { ...record, observed, unsupportedUntil: now + UNSUPPORTED_RETRY_MS } });
    return 'unsupported';
  }
  if (sent.status !== 200) return failed();
  await deps.storage.set({ [REPLICA_HEALTH_RECORD_KEY]: { replicaId: deps.scope.replicaId, digest, sentAt: now,
    revision, observed } satisfies SentRecord });
  return 'sent';
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
  return trimmed.length === 0 ? undefined : trimmed.length > 256 ? `${trimmed.slice(0, 255)}…` : trimmed;
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
