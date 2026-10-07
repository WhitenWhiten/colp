import { FaviconFetchDeferred } from './favicon-fetch-deferred.js';
/**
 * FO-02 favicon refresh worker execution + GC pending-deletion policy.
 *
 * The execution module owns the worker-side claim processing: re-verification,
 * fetch/PUT idempotency (persisted object id), the atomic binding CAS and the
 * retry/terminal decision. It depends only on the job ports from
 * `favicon-job.js` and never on infrastructure.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  INITIAL_FAVICON_SOURCE_REVISION,
  iconSourceActsOnline,
  type BookmarkIconSourceReadPort,
} from './favicon-icon-source.js';
import {
  DEFAULT_FAVICON_PROVIDER_TEMPLATE,
  type FaviconPolicyReadPort,
} from './favicon-policy.js';
import {
  faviconHostnameFromBookmarkUrl,
  nextFaviconAttemptAt,
  resolveFaviconProviderUrl,
} from './favicon-fetch-policy.js';
import { decodeFaviconImage, type DecodedFaviconImage } from './favicon-image-decode.js';
import type {
  BookmarkIconRow,
  BookmarkIconWritePort,
  CollectionWritePort,
  CollectionsClock,
  NodeWritePort,
} from './ports.js';
import type {
  FaviconGcWritePort,
  FaviconJobErrorReason,
  FaviconJobOperation,
  FaviconJobStatus,
  FaviconJobWritePort,
} from './favicon-job.js';
// ---------------------------------------------------------------------------
// Worker-side execution (refresh_one)
// ---------------------------------------------------------------------------

export interface FaviconFetchedImage extends DecodedFaviconImage {
  readonly body: Buffer;
}

export interface FaviconFetchOptions {
  readonly url: string;
  readonly targetHostname?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxRedirects: number;
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  readonly connect?: (target: { readonly url: URL; readonly ip: string; readonly family: 4 | 6 }, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

/** Injected single-fetch transport; production is hardened egress, tests inject a controlled provider. */
export interface FaviconFetcher {
  (input: FaviconFetchOptions): Promise<FaviconFetchedImage>;
}

/** Pool-scoped worker outcome writes (lease-fenced). */
export interface FaviconJobWorkerPort {
  markRunning(input: { readonly jobId: string; readonly leaseOwner: string }): Promise<boolean>;
  scheduleRetry(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly attempts: number;
    readonly nextAttemptAt: Date;
    readonly errorNodeId: string;
    readonly errorReason: FaviconJobErrorReason;
  }): Promise<boolean>;
  markFailed(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly attempts: number;
    readonly errorNodeId: string;
    readonly errorReason: FaviconJobErrorReason;
  }): Promise<boolean>;
  markSucceeded(input: { readonly jobId: string; readonly leaseOwner: string; readonly completedAt: Date }): Promise<boolean>;
  /**
   * FO-03 batch-cycle outcome write: recompute the aggregate counters and
   * either release the job back to `pending` (items remain; `nextAttemptAt`
   * is the earliest item backoff) or land on a terminal status
   * (succeeded/partial/failed), clearing the lease in both cases.
   */
  updateBatch(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly status: 'pending' | 'succeeded' | 'partial' | 'failed';
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
    readonly nextAttemptAt: Date | null;
    readonly updatedAt: Date;
  }): Promise<boolean>;
  /**
   * FO-08 per-item lease renewal. The batch cycle can outlive the fixed 60s
   * lease (up to 100 serial fetches), so the worker re-arms `lease_until`
   * before every item. Returns false only when ownership was lost (another
   * worker re-claimed the expired job) — the caller must stop working the job
   * immediately so two workers never interleave item writes for one job. A
   * lapsed-but-still-owned lease is re-armed rather than abandoned.
   */
  renewLease(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean>;
}

export interface FaviconRefreshCasPorts {
  readonly jobs: FaviconJobWritePort;
  readonly gc: FaviconGcWritePort;
  readonly collections: Pick<CollectionWritePort, 'lockForUpdate'>;
  readonly nodes: Pick<NodeWritePort, 'getNode'>;
  readonly sources: BookmarkIconSourceWritePortLike;
  readonly policies: FaviconPolicyReadPort;
  readonly bookmarkIcons: BookmarkIconWritePort;
}

/** The worker CAS uses the source `setMode` (non-CAS; the collection lock serializes). */
export interface BookmarkIconSourceWritePortLike extends BookmarkIconSourceReadPort {
  setMode(input: {
    readonly nodeId: string;
    readonly collectionId: string;
    readonly sourceMode: 'online';
    readonly updatedAt: Date;
  }): Promise<void>;
}

/** Transaction runner for the worker's verify/CAS steps. */
export interface FaviconRefreshCasRunner {
  run<T>(work: (ports: FaviconRefreshCasPorts) => Promise<T>): Promise<T>;
}

export interface FaviconJobClaim {
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly accountId: string;
  readonly ownerSubjectId: string;
  /** FO-03: the loop dispatches refresh_one vs batch execution on this. */
  readonly operation: FaviconJobOperation;
  readonly status: FaviconJobStatus;
  readonly attempts: number;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly sourceUrl: string;
  readonly sourceRevision: string;
  readonly policyRevision: string;
  readonly nodeResourceRevision: string;
  readonly objectId: string | null;
}

export interface FaviconRefreshExecutionPorts {
  readonly verify: FaviconRefreshCasRunner;
  readonly worker: FaviconJobWorkerPort;
  readonly fetcher: FaviconFetcher;
  readonly store: {
    get(objectId: string): Promise<{ readonly contentType: string; readonly body: Buffer } | null>;
    put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  };
  readonly clock: CollectionsClock;
  readonly now: () => Date;
  readonly options: {
    readonly maxAttempts: number;
    readonly backoffSeconds: readonly number[];
    readonly retentionSeconds: number;
    readonly maxBytes: number;
    readonly maxDecompressedBytes: number;
    readonly fetchTimeoutMs: number;
    readonly maxRedirects: number;
  };
}

export type FaviconExecutionOutcome =
  | 'succeeded'
  | 'retry_scheduled'
  | 'failed'
  | 'lease_lost'
  | 'batch_released';

export interface FaviconExecutionResult {
  readonly jobId: string;
  readonly outcome: FaviconExecutionOutcome;
}

type FaviconIdentityVerdict =
  | { readonly kind: 'ready'; readonly hostname: string | null }
  | { readonly kind: 'terminal'; readonly reason: FaviconJobErrorReason }
  | { readonly kind: 'missing' };

/** Fetch-layer typed failure raised by the egress implementation. */
export class FaviconFetchError extends Error {
  constructor(
    readonly reason: 'fetch_failed' | 'invalid_image' | 'unsafe_source' | 'storage_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FaviconFetchError';
  }
}

/**
 * Re-verification failures that never retry: the URL identity or authority is
 * gone and a later attempt cannot self-heal.
 */
export function isFaviconTerminalReason(reason: FaviconJobErrorReason): boolean {
  return reason === 'unsafe_source'
    || reason === 'stale_policy'
    || reason === 'source_changed'
    || reason === 'permission_changed';
}

function toJobRevision(value: string | null | undefined): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value)) return 0n;
  const parsed = BigInt(value);
  return parsed >= 1n ? parsed : 0n;
}

/**
 * Re-verify the durable identity facts inside a transaction (also used by the
 * CAS). The same checks run at enqueue time; the worker re-runs them before
 * any write and again inside the CAS transaction.
 */
export async function verifyFaviconRefreshIdentity(
  tx: FaviconRefreshCasPorts,
  claim: FaviconJobClaim,
): Promise<FaviconIdentityVerdict> {
  // FO-08: the per-item lease fence, mirroring the batch verifier. A single
  // refresh claim can outlive its 60s lease (hung store PUT, event-loop
  // stall); a second worker may then reclaim the expired job and bind a
  // FRESHER object. The stale claim must release before it fetches or binds,
  // or its late CAS would silently displace the new binding — worst on
  // inherit nodes, whose source revision no longer advances on refresh.
  const job = await tx.jobs.findByJobId(claim.jobId);
  if (job === null || (job.status !== 'pending' && job.status !== 'running')) {
    return { kind: 'missing' };
  }
  if (job.leaseOwner !== claim.leaseOwner) {
    return { kind: 'missing' };
  }
  const locked = await tx.collections.lockForUpdate(claim.collectionId);
  if (!locked || locked.deletedAt !== null) {
    return { kind: 'terminal', reason: 'permission_changed' };
  }
  if (locked.ownerSubjectId !== claim.ownerSubjectId) {
    return { kind: 'terminal', reason: 'permission_changed' };
  }
  const node = await tx.nodes.getNode(claim.collectionId, claim.nodeId);
  if (!node || node.deletedAt !== null || node.kind !== 'bookmark' || node.collectionId !== claim.collectionId) {
    return { kind: 'terminal', reason: 'permission_changed' };
  }
  const sourceRow = await tx.sources.findByNodeId(node.id);
  const currentSourceRevision = sourceRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION;
  const policy = await tx.policies.findByAccountId(claim.accountId);
  const policyRevision = policy?.revision ?? 1n;
  // The enqueue accepted this node as online by effective mode (inherit under
  // an online default is online); the worker must re-verify with the same
  // predicate or every such job fails source_changed before fetching.
  const actsOnline = iconSourceActsOnline({
    sourceMode: sourceRow?.sourceMode ?? null,
    newDefault: policy?.newDefault ?? 'capture',
  });
  if (!actsOnline || currentSourceRevision !== toJobRevision(claim.sourceRevision)) {
    return { kind: 'terminal', reason: 'source_changed' };
  }
  if (policyRevision !== toJobRevision(claim.policyRevision)) {
    return { kind: 'terminal', reason: 'stale_policy' };
  }
  const hostname = faviconHostnameFromBookmarkUrl(node.url ?? '');
  const resolvedUrl = hostname === null
    ? null
    : resolveFaviconProviderUrl(policy?.providerTemplate ?? DEFAULT_FAVICON_PROVIDER_TEMPLATE, hostname);
  if (resolvedUrl === null || resolvedUrl !== claim.sourceUrl) {
    return { kind: 'terminal', reason: 'source_changed' };
  }
  return { kind: 'ready', hostname: faviconHostnameFromBookmarkUrl(node.url ?? '') };
}

/**
 * Execute one claimed refresh job. The worker loop owns the claim/lease; this
 * performs re-verify → persist object id → fetch/PUT → CAS and reports the
 * durable outcome. All failures are mapped to job state; nothing escapes.
 */
export async function processFaviconRefreshClaim(
  ports: FaviconRefreshExecutionPorts,
  claim: FaviconJobClaim,
): Promise<FaviconExecutionResult> {
  const identity = await ports.verify.run((tx) => verifyFaviconRefreshIdentity(tx, claim));
  if (identity.kind === 'missing') return { jobId: claim.jobId, outcome: 'lease_lost' };
  if (identity.kind === 'terminal') {
    return await markFaviconJobFailed(ports, claim, identity.reason);
  }
  const now = ports.now();

  // 1. Persist the target object id before any external PUT.
  let objectId = claim.objectId;
  if (objectId === null) {
    const allocated = await ports.verify.run(async (tx) => {
      const job = await tx.jobs.findByJobId(claim.jobId);
      if (job === null) return null;
      // FO-08: never allocate a fresh object id for a re-claimed lease.
      if (job.leaseOwner !== claim.leaseOwner) return null;
      if (job.objectId !== null) return job.objectId;
      const freshId = randomUUID();
      await tx.jobs.setObjectId({ jobId: claim.jobId, objectId: freshId, updatedAt: now });
      return freshId;
    });
    if (allocated === null) return { jobId: claim.jobId, outcome: 'lease_lost' };
    objectId = allocated;
  }

  // 2. Fetch (or reuse the bytes a crashed run already wrote) and PUT once.
  let fetched: FaviconFetchedImage;
  try {
    const existing = await ports.store.get(objectId);
    if (existing !== null) {
      const decoded = decodeFaviconImage(existing.body, ports.options.maxBytes, ports.options.maxDecompressedBytes);
      fetched = { body: existing.body, mime: decoded.mime, width: decoded.width, height: decoded.height };
    } else {
      fetched = await ports.fetcher({
        url: claim.sourceUrl,
        ...(identity.hostname === null ? {} : { targetHostname: identity.hostname }),
        timeoutMs: ports.options.fetchTimeoutMs,
        maxBytes: ports.options.maxBytes,
        maxDecompressedBytes: ports.options.maxDecompressedBytes,
        maxRedirects: ports.options.maxRedirects,
      });
      await ports.store.put(objectId, fetched.body, fetched.mime);
    }
  } catch (error) {
    return await handleRefreshFailure(ports, claim, error);
  }

  // 3. CAS-switch the binding in one transaction.
  const cas = await ports.verify.run((tx) => applyFaviconRefreshCas(
    tx, claim, objectId, fetched, now, ports.options.retentionSeconds,
  ));
  // F-A1: a terminal/gone CAS after a successful PUT leaves the written object
  // unbound forever (GC only collects durable pending-deletion records). Record
  // it with immediate deletability — it was never served.
  if (cas.kind !== 'applied') {
    await recordUnboundObjectIfWritten(ports, claim, objectId, now);
  }
  if (cas.kind === 'missing') return { jobId: claim.jobId, outcome: 'lease_lost' };
  if (cas.kind === 'terminal') {
    return await markFaviconJobFailed(ports, claim, cas.reason);
  }
  const succeeded = await ports.worker.markSucceeded({
    jobId: claim.jobId,
    leaseOwner: claim.leaseOwner,
    completedAt: ports.now(),
  });
  return { jobId: claim.jobId, outcome: succeeded ? 'succeeded' : 'lease_lost' };
}

/**
 * F-A1: the object id was persisted and PUT, but the CAS could not bind it
 * (terminal identity failure or the job is gone). Verify the bytes actually
 * reached the store, then durably retire the unbound object with
 * `deletableAt = now` (never served, so no retention window). Never record
 * when the object is already the node's binding — a crashed run may have
 * CAS'd the binding before this claim re-ran, and recording a live binding
 * as immediately deletable would be catastrophic.
 */
async function recordUnboundObjectIfWritten(
  ports: FaviconRefreshExecutionPorts,
  claim: FaviconJobClaim,
  objectId: string,
  now: Date,
): Promise<void> {
  const existing = await ports.store.get(objectId);
  if (existing === null) return;
  await ports.verify.run(async (tx) => {
    const current = await tx.bookmarkIcons.findByNodeId(claim.nodeId);
    if (current !== null && current.objectId === objectId) return;
    await tx.gc.recordRetired({
      objectId,
      nodeId: claim.nodeId,
      collectionId: claim.collectionId,
      retiredAt: now,
      deletableAt: now,
    });
  });
}

type FaviconCasVerdict =
  | { readonly kind: 'applied' }
  | { readonly kind: 'terminal'; readonly reason: FaviconJobErrorReason }
  | { readonly kind: 'missing' };

async function applyFaviconRefreshCas(
  tx: FaviconRefreshCasPorts,
  claim: FaviconJobClaim,
  objectId: string,
  fetched: FaviconFetchedImage,
  now: Date,
  retentionSeconds: number,
): Promise<FaviconCasVerdict> {
  const job = await tx.jobs.findByJobId(claim.jobId);
  if (job === null || (job.status !== 'pending' && job.status !== 'running')) return { kind: 'missing' };
  // FO-08: a re-claimed lease must never let this claim bind its stale object
  // (verifyFaviconRefreshIdentity below re-checks the same fence inside the
  // CAS transaction; this early check just avoids the allocation path).
  if (job.leaseOwner !== claim.leaseOwner) return { kind: 'missing' };
  const identity = await verifyFaviconRefreshIdentity(tx, claim);
  if (identity.kind !== 'ready') return identity;
  const nodeId = claim.nodeId;
  const current = await tx.bookmarkIcons.findByNodeId(nodeId);
  const digest = createHash('sha256').update(fetched.body).digest();
  if (current !== null && current.objectId === objectId) {
    // A crashed run already CASed the binding; only reconcile metadata.
    await tx.jobs.setObjectMetadata({
      jobId: claim.jobId,
      objectId,
      contentType: current.contentType,
      byteSize: current.byteSize,
      digestSha256: current.digestSha256,
      updatedAt: now,
    });
    return { kind: 'applied' };
  }
  if (current !== null) {
    await tx.gc.recordRetired({
      objectId: current.objectId,
      nodeId: current.nodeId,
      collectionId: current.collectionId,
      retiredAt: now,
      deletableAt: new Date(now.getTime() + retentionSeconds * 1_000),
    });
  }
  const row: BookmarkIconRow = {
    nodeId,
    collectionId: claim.collectionId,
    objectId,
    contentType: fetched.mime,
    byteSize: fetched.body.byteLength,
    digestSha256: digest,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  await tx.bookmarkIcons.upsert(row);
  // FO-08: refresh preserves the source mode. An inherit node (no row or an
  // explicit inherit row) must keep following the account default — writing an
  // explicit `online` row here would silently detach it from the default, so a
  // later default change (capture/none) would never affect it again, and the
  // batch refresh_online path (which never touches source rows) would disagree
  // with the single-node path. Only an explicit online source advances its
  // revision; inherit refresh binds the icon without materializing a mode.
  const source = await tx.sources.findByNodeId(nodeId);
  if (source !== null && source.sourceMode === 'online') {
    await tx.sources.setMode({ nodeId, collectionId: claim.collectionId, sourceMode: 'online', updatedAt: now });
  }
  await tx.jobs.setObjectMetadata({
    jobId: claim.jobId,
    objectId,
    contentType: fetched.mime,
    byteSize: fetched.body.byteLength,
    digestSha256: digest,
    updatedAt: now,
  });
  return { kind: 'applied' };
}

/**
 * The GC retention window (FAVICON_HISTORY_RETENTION_SECONDS).
 *
 * F-A7: this module-level value is NO LONGER read by the worker CAS paths —
 * `FaviconRefreshExecutionPorts`/`FaviconBatchExecutionPorts` carry
 * `options.retentionSeconds` and the CAS functions thread it through, so each
 * worker uses its own configured window (a process-global set by every worker
 * constructor was untestable and drifted between workers). The global remains
 * ONLY as a mirror of config for the non-worker command paths that build
 * retention records without an execution-ports object (favicon-icon-source.ts,
 * bookmark-favicon-command.ts, favicon-helper-capture.ts), which
 * favicon-worker.ts still seeds at worker construction.
 */
let activeRetentionSeconds = 31_536_000;
export function setFaviconRetentionSeconds(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new TypeError('favicon retention seconds must be a positive integer');
  }
  activeRetentionSeconds = seconds;
}
export function faviconRetentionSeconds(): number {
  return activeRetentionSeconds;
}

async function markFaviconJobFailed(
  ports: FaviconRefreshExecutionPorts,
  claim: FaviconJobClaim,
  reason: FaviconJobErrorReason,
): Promise<FaviconExecutionResult> {
  const ok = await ports.worker.markFailed({
    jobId: claim.jobId,
    leaseOwner: claim.leaseOwner,
    attempts: claim.attempts + 1,
    errorNodeId: claim.nodeId,
    errorReason: reason,
  });
  return { jobId: claim.jobId, outcome: ok ? 'failed' : 'lease_lost' };
}

async function handleRefreshFailure(
  ports: FaviconRefreshExecutionPorts,
  claim: FaviconJobClaim,
  error: unknown,
): Promise<FaviconExecutionResult> {
  if (error instanceof FaviconFetchDeferred) {
    const ok = await ports.worker.scheduleRetry({
      jobId: claim.jobId, leaseOwner: claim.leaseOwner, attempts: claim.attempts,
      nextAttemptAt: error.retryAt, errorNodeId: claim.nodeId, errorReason: 'fetch_failed',
    });
    return { jobId: claim.jobId, outcome: ok ? 'retry_scheduled' : 'lease_lost' };
  }
  const reason = classifyFaviconRefreshFailure(error);
  const attempts = claim.attempts + 1;
  if (isFaviconTerminalReason(reason)) {
    return await markFaviconJobFailed(ports, claim, reason);
  }
  const nextAttemptAt = nextFaviconAttemptAt(
    attempts,
    ports.options.maxAttempts,
    ports.options.backoffSeconds,
    ports.now(),
  );
  if (nextAttemptAt === null) {
    return await markFaviconJobFailed(ports, claim, reason);
  }
  const ok = await ports.worker.scheduleRetry({
    jobId: claim.jobId,
    leaseOwner: claim.leaseOwner,
    attempts,
    nextAttemptAt,
    errorNodeId: claim.nodeId,
    errorReason: reason,
  });
  return { jobId: claim.jobId, outcome: ok ? 'retry_scheduled' : 'lease_lost' };
}

function classifyFaviconRefreshFailure(error: unknown): FaviconJobErrorReason {
  if (error instanceof FaviconFetchError) return error.reason;
  if (typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'BookmarkFaviconImageError') {
    return 'invalid_image';
  }
  return 'fetch_failed';
}

// ---------------------------------------------------------------------------
// GC pending-deletion policy (pure)
// ---------------------------------------------------------------------------

export interface FaviconPendingDeletionRecord {
  readonly objectId: string;
  readonly nodeId: string;
  readonly collectionId: string;
  readonly retiredAt: Date;
  readonly deletableAt: Date;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date;
}

/**
 * A pending deletion is actionable only once its retention window has passed.
 * Current / not-yet-expired history references are never collected; the
 * reference recheck happens again right before the destructive delete.
 */
export function isFaviconGcActionable(
  record: Pick<FaviconPendingDeletionRecord, 'deletableAt'>,
  now: Date,
): boolean {
  return record.deletableAt.getTime() <= now.getTime();
}

/** GC retries use a conservative attempt cap; a still-referenced object is never collected. */
export const FAVICON_GC_MAX_ATTEMPTS = 10;

export function nextFaviconGcAttemptAt(
  attempts: number,
  backoffSeconds: readonly number[],
  now: Date,
): Date {
  if (backoffSeconds.length === 0) return new Date(now.getTime() + 60_000);
  const index = Math.min(Math.max(attempts, 0), backoffSeconds.length - 1);
  const delaySeconds = backoffSeconds[index] ?? backoffSeconds[backoffSeconds.length - 1] ?? 60;
  return new Date(now.getTime() + Math.max(delaySeconds, 1) * 1_000);
}
