import { FaviconFetchDeferred } from './favicon-fetch-deferred.js';
/**
 * FO-03 favicon batch job worker execution.
 *
 * Bounded cycles re-verify ownership, source/policy revisions and URL identity,
 * persist an object ID before PUT, then CAS-switch each binding. Fetch failures
 * retry per item; provider admission waits do not consume attempts. At cycle end,
 * durable item counters decide whether to release or finish the job.
 *
 * apply_force_online records a favicon_source_restores row before displacing
 * a binding so force-off can restore the exact original; restore_sources
 * consumes those rows. GC protects restore-referenced objects (see
 * favicon-source-restore reference recheck in the postgres GC adapter).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  INITIAL_FAVICON_SOURCE_REVISION,
} from './favicon-icon-source.js';
import {
  DEFAULT_FAVICON_PROVIDER_TEMPLATE,
  type FaviconPolicyReadPort,
} from './favicon-policy.js';
import {
  faviconHostnameFromBookmarkUrl,
  resolveFaviconProviderUrl,
} from './favicon-fetch-policy.js';
import { decodeFaviconImage } from './favicon-image-decode.js';
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
  FaviconJobWritePort,
} from './favicon-job.js';
import {
  isFaviconTerminalReason,
  FaviconFetchError,
  type FaviconExecutionOutcome,
  type FaviconFetchedImage,
  type FaviconFetcher,
  type FaviconJobClaim,
  type FaviconJobWorkerPort,
  type FaviconRefreshCasPorts,
} from './favicon-job-execution.js';
import {
  faviconBatchTerminalStatus,
  type FaviconBatchItemWritePort,
  type FaviconBatchJobReadPort,
  type FaviconJobItemRow,
  type FaviconRestoreGenerationPage,
  type FaviconSourceRestoreRow,
  type FaviconSourceRestoreWritePort,
} from './favicon-batch-policy.js';

export interface FaviconBatchCasPorts extends FaviconRefreshCasPorts {
  readonly items: FaviconBatchItemWritePort & FaviconBatchJobReadPort & FaviconRestoreGapWritePort;
  readonly restores: FaviconSourceRestoreWritePort;
}

/**
 * F-A2: a force CAS after the keyset cursor still has to enter the job.
 * Gap pages are not cursored. Completion waits until the scan is finished.
 */
export interface FaviconRestoreGapWritePort {
  /**
   * Insert one bounded page of pending items for restore rows with no item in
   * this job. Repeat until a short page; a single call does not cover the account.
   */
  insertRestoreGapItems(input: {
    readonly jobId: string;
    readonly accountId: string;
    readonly now: Date;
  }): Promise<readonly string[]>;
  extendRestoreGeneration(input: {
    readonly jobId: string;
    readonly accountId: string;
    readonly now: Date;
    readonly leaseOwner: string | null;
  }): Promise<FaviconRestoreGenerationPage>;
}

export interface FaviconBatchCasRunner {
  run<T>(work: (ports: FaviconBatchCasPorts) => Promise<T>): Promise<T>;
}

export interface FaviconBatchExecutionPorts {
  readonly verify: FaviconBatchCasRunner;
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
    readonly batchSize: number;
    /** FO-08: the job lease duration the worker re-arms before every item. */
    readonly leaseDurationMs: number;
  };
}

type FaviconBatchItemVerdict =
  | { readonly kind: 'ready'; readonly hostname: string | null }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'terminal'; readonly reason: FaviconJobErrorReason }
  | { readonly kind: 'job_gone' };

/**
 * Re-verify the durable identity facts for one batch item inside a
 * transaction. The same facts were captured at enqueue; any change since then
 * disqualifies the item: a concurrent manual upload / explicit none supersedes
 * the job (skipped), while URL/policy/owner drift is a terminal error that
 * surfaces in the job's error list and is never retried.
 */
export async function verifyFaviconBatchItemIdentity(
  tx: FaviconBatchCasPorts,
  claim: FaviconJobClaim,
  item: FaviconJobItemRow,
): Promise<FaviconBatchItemVerdict> {
  const job = await tx.jobs.findByJobId(claim.jobId);
  if (job === null || (job.status !== 'pending' && job.status !== 'running')) {
    return { kind: 'job_gone' };
  }
  // FO-08: the per-item lease fence. The claim's 60s lease can lapse inside a
  // long cycle and be re-claimed by another worker; every verify/CAS must then
  // release this claim so two workers never interleave item writes for one
  // job (this is the durable part of the fence — the cycle also renews the
  // lease up front so the takeover normally never happens).
  if (job.leaseOwner !== claim.leaseOwner) {
    return { kind: 'job_gone' };
  }
  const itemRow = await tx.items.findByJobAndNode(claim.jobId, item.nodeId);
  if (itemRow === null || itemRow.status === 'succeeded' || itemRow.status === 'skipped') {
    return { kind: 'skipped' };
  }
  const locked = await tx.collections.lockForUpdate(item.collectionId);
  if (!locked || locked.deletedAt !== null || locked.ownerSubjectId !== claim.ownerSubjectId) {
    return { kind: 'terminal', reason: 'permission_changed' };
  }
  const node = await tx.nodes.getNode(item.collectionId, item.nodeId);
  if (!node || node.deletedAt !== null || node.kind !== 'bookmark' || node.collectionId !== item.collectionId) {
    return { kind: 'terminal', reason: 'permission_changed' };
  }
  // FO-08 restore policy gating: restoring the ORIGINAL binding is a pure
  // undo of a force window and does not depend on the account policy revision.
  // An unrelated policy change (e.g. provider template) after force-off must
  // never turn restore items into terminal failures — and the terminal branch
  // drops the durable restore snapshot, which would make the original
  // unrecoverable. The policy revision gate therefore applies to capture jobs
  // only.
  const policy = claim.operation !== 'restore_sources'
    ? await tx.policies.findByAccountId(claim.accountId)
    : null;
  if (claim.operation !== 'restore_sources') {
    const policyRevision = policy?.revision ?? 1n;
    if (policyRevision !== claimPolicyRevision(claim)) {
      return { kind: 'terminal', reason: 'stale_policy' };
    }
  }
  const sourceRow = await tx.sources.findByNodeId(node.id);
  const currentSourceRevision = sourceRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION;
  // A concurrent explicit none / uploaded / mode change supersedes the job.
  if (currentSourceRevision !== item.sourceRevision) return { kind: 'skipped' };
  if (claim.operation !== 'restore_sources') {
    const hostname = faviconHostnameFromBookmarkUrl(node.url ?? '');
    const resolvedUrl = hostname === null
      ? null
      : resolveFaviconProviderUrl(policy?.providerTemplate ?? DEFAULT_FAVICON_PROVIDER_TEMPLATE, hostname);
    if (resolvedUrl === null || resolvedUrl !== item.sourceUrl) {
      return { kind: 'terminal', reason: 'source_changed' };
    }
  }
  return { kind: 'ready', hostname: faviconHostnameFromBookmarkUrl(node.url ?? '') };
}

function claimPolicyRevision(claim: FaviconJobClaim): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(claim.policyRevision)) return 0n;
  const parsed = BigInt(claim.policyRevision);
  return parsed >= 1n ? parsed : 0n;
}

export type FaviconBatchItemOutcome =
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'retry_scheduled'
  | 'job_gone';

/**
 * Execute one pending batch item: verify → persist pre-PUT object id → fetch →
 * CAS. Never throws for expected failures; the durable item row records the
 * exact outcome.
 */
export async function processFaviconBatchItem(
  ports: FaviconBatchExecutionPorts,
  claim: FaviconJobClaim,
  item: FaviconJobItemRow,
): Promise<FaviconBatchItemOutcome> {
  const identity = await ports.verify.run((tx) => verifyFaviconBatchItemIdentity(tx, claim, item));
  if (identity.kind === 'job_gone') return 'job_gone';
  if (identity.kind === 'skipped') {
    await ports.verify.run(async (tx) => {
      if (claim.operation === 'restore_sources') {
        // A newer source state supersedes the restore; release the GC-protected
        // restore reference so the original object is never leaked.
        await tx.restores.deleteByNodeId(item.nodeId);
      }
      await tx.items.markSkipped(claim.jobId, item.nodeId, ports.now());
    });
    return 'skipped';
  }
  if (identity.kind === 'terminal') {
    await ports.verify.run((tx) => tx.items.markFailed(
      claim.jobId, item.nodeId, item.attempts + 1, identity.reason, ports.now(),
    ));
    return 'failed';
  }
  if (claim.operation === 'restore_sources') {
    return await restoreOneItem(ports, claim, item);
  }
  return await captureOneItem(ports, claim, item, identity.hostname);
}

async function captureOneItem(
  ports: FaviconBatchExecutionPorts,
  claim: FaviconJobClaim,
  item: FaviconJobItemRow,
  hostname: string | null,
): Promise<FaviconBatchItemOutcome> {
  const now = ports.now();
  let objectId = item.objectId;
  if (objectId === null) {
    const allocated = await ports.verify.run(async (tx) => {
      const fresh = await tx.items.findByJobAndNode(claim.jobId, item.nodeId);
      if (fresh === null || fresh.objectId !== null) return fresh?.objectId ?? null;
      const id = randomUUID();
      await tx.items.setObjectId(claim.jobId, item.nodeId, id, now);
      return id;
    });
    if (allocated === null) return 'job_gone';
    objectId = allocated;
  }
  let fetched: FaviconFetchedImage;
  try {
    const existing = await ports.store.get(objectId);
    if (existing !== null) {
      const decoded = decodeFaviconImage(existing.body, ports.options.maxBytes, ports.options.maxDecompressedBytes);
      fetched = { body: existing.body, mime: decoded.mime, width: decoded.width, height: decoded.height };
    } else {
      fetched = await ports.fetcher({
        url: item.sourceUrl,
        ...(hostname === null ? {} : { targetHostname: hostname }),
        timeoutMs: ports.options.fetchTimeoutMs,
        maxBytes: ports.options.maxBytes,
        maxDecompressedBytes: ports.options.maxDecompressedBytes,
        maxRedirects: ports.options.maxRedirects,
      });
      await ports.store.put(objectId, fetched.body, fetched.mime);
    }
  } catch (error) {
    return await handleBatchItemFailure(ports, claim, item, error);
  }
  const cas = await ports.verify.run((tx) => applyBatchCaptureCas(
    tx, claim, item, objectId, fetched, now, ports.options.retentionSeconds,
  ));
  // F-A1: a terminal/gone CAS after a successful PUT leaves the object at
  // objectId unbound forever (GC only collects durable records). Record it as
  // immediately deletable — it was never served.
  if (cas.kind !== 'applied') {
    await recordUnboundBatchObjectIfWritten(ports, item, objectId, now);
  }
  if (cas.kind === 'gone') return 'job_gone';
  if (cas.kind === 'skipped') return 'skipped';
  if (cas.kind === 'terminal') {
    await ports.verify.run((tx) => tx.items.markFailed(
      claim.jobId, item.nodeId, item.attempts + 1, cas.reason, ports.now(),
    ));
    return 'failed';
  }
  return 'succeeded';
}

/** F-A1: PUT succeeded but CAS did not bind; ledger the unbound object as
 * immediately deletable unless it already is the node's live binding. */
async function recordUnboundBatchObjectIfWritten(
  ports: FaviconBatchExecutionPorts,
  item: FaviconJobItemRow,
  objectId: string,
  now: Date,
): Promise<void> {
  const existing = await ports.store.get(objectId);
  if (existing === null) return;
  await ports.verify.run(async (tx) => {
    const current = await tx.bookmarkIcons.findByNodeId(item.nodeId);
    if (current !== null && current.objectId === objectId) return;
    await tx.gc.recordRetired({
      objectId,
      nodeId: item.nodeId,
      collectionId: item.collectionId,
      retiredAt: now,
      deletableAt: now,
    });
  });
}

type BatchCasVerdict =
  | { readonly kind: 'applied' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'terminal'; readonly reason: FaviconJobErrorReason };

/** FO-C-01 CAS verdict. Exported for the race regression tests. */
export async function applyBatchCaptureCas(
  tx: FaviconBatchCasPorts,
  claim: FaviconJobClaim,
  item: FaviconJobItemRow,
  objectId: string,
  fetched: FaviconFetchedImage,
  now: Date,
  retentionSeconds: number,
): Promise<BatchCasVerdict> {
  // FO-C-01: lock the JOB row first so enqueue-supersede cannot late-bind.
  const lockedJob = await tx.jobs.lockByJobId(claim.jobId);
  if (lockedJob === null || (lockedJob.status !== 'pending' && lockedJob.status !== 'running')) return { kind: 'gone' };
  const identity = await verifyFaviconBatchItemIdentity(tx, claim, item);
  if (identity.kind === 'job_gone') return { kind: 'gone' };
  if (identity.kind === 'skipped') return { kind: 'skipped' };
  if (identity.kind === 'terminal') return { kind: 'terminal', reason: identity.reason };
  const digest = createHash('sha256').update(fetched.body).digest();
  const current = await tx.bookmarkIcons.findByNodeId(item.nodeId);
  if (current !== null && current.objectId === objectId) {
    // A crashed run already applied the CAS; reconcile item metadata only.
    await tx.items.setObjectMetadata({
      jobId: claim.jobId, nodeId: item.nodeId, objectId,
      contentType: current.contentType, byteSize: current.byteSize, digestSha256: current.digestSha256,
      updatedAt: now,
    });
    await tx.items.markSucceeded(claim.jobId, item.nodeId, now);
    return { kind: 'applied' };
  }
  const row: BookmarkIconRow = {
    nodeId: item.nodeId,
    collectionId: item.collectionId,
    objectId,
    contentType: fetched.mime,
    byteSize: fetched.body.byteLength,
    digestSha256: digest,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (claim.operation === 'apply_force_online') {
    // Preserve the pre-force state durably BEFORE displacing the binding; the
    // original object becomes a GC-protected restore reference (never retired).
    const sourceRow = await tx.sources.findByNodeId(item.nodeId);
    await tx.restores.upsert({
      nodeId: item.nodeId,
      collectionId: item.collectionId,
      accountId: claim.accountId,
      originalSourceMode: sourceRow?.sourceMode ?? 'inherit',
      originalObjectId: current?.objectId ?? null,
      originalContentType: current?.contentType ?? null,
      originalByteSize: current?.byteSize ?? null,
      originalDigestSha256: current?.digestSha256 ?? null,
      sourceRevision: item.sourceRevision,
      createdAt: now,
      updatedAt: now,
    });
  } else if (current !== null) {
    await tx.gc.recordRetired({
      objectId: current.objectId,
      nodeId: current.nodeId,
      collectionId: current.collectionId,
      retiredAt: now,
      deletableAt: new Date(now.getTime() + retentionSeconds * 1_000),
    });
  }
  await tx.bookmarkIcons.upsert(row);
  await tx.items.setObjectMetadata({
    jobId: claim.jobId, nodeId: item.nodeId, objectId,
    contentType: fetched.mime, byteSize: fetched.body.byteLength, digestSha256: digest,
    updatedAt: now,
  });
  await tx.items.markSucceeded(claim.jobId, item.nodeId, now);
  return { kind: 'applied' };
}

async function restoreOneItem(
  ports: FaviconBatchExecutionPorts,
  claim: FaviconJobClaim,
  item: FaviconJobItemRow,
): Promise<FaviconBatchItemOutcome> {
  // Restore consumes the durable record; if the restore row is already gone,
  // the node's state was already restored (or superseded) — nothing to do, but
  // the item MUST still transition to a terminal ledger state, otherwise the
  // aggregate never reaches pendingCount 0 and the restore job cycles forever
  // without landing on succeeded/partial/failed (a job the client can neither
  // observe finishing nor retry).
  const restoreRow = await ports.verify.run((tx) => tx.restores.findByNodeId(item.nodeId));
  if (restoreRow === null) {
    await ports.verify.run((tx) => tx.items.markSkipped(claim.jobId, item.nodeId, ports.now()));
    return 'skipped';
  }
  const now = ports.now();
  const applied = await ports.verify.run((tx) => applyRestoreCas(
    tx, claim, item, restoreRow, now, ports.options.retentionSeconds,
  ));
  if (applied.kind === 'gone') return 'job_gone';
  if (applied.kind === 'skipped') return 'skipped';
  if (applied.kind === 'terminal') {
    // The node's state no longer matches the force window; drop the stale
    // restore record so it never fights the user's newer intent.
    await ports.verify.run(async (tx) => {
      await tx.restores.deleteByNodeId(item.nodeId);
      await tx.items.markFailed(claim.jobId, item.nodeId, item.attempts + 1, applied.reason, ports.now());
    });
    return 'failed';
  }
  return 'succeeded';
}

export async function applyRestoreCas(
  tx: FaviconBatchCasPorts,
  claim: FaviconJobClaim,
  item: FaviconJobItemRow,
  restore: FaviconSourceRestoreRow,
  now: Date,
  retentionSeconds: number,
): Promise<BatchCasVerdict> {
  // FO-C-01: same job-row lock as applyBatchCaptureCas — restore also binds.
  const lockedJob = await tx.jobs.lockByJobId(claim.jobId);
  if (lockedJob === null || (lockedJob.status !== 'pending' && lockedJob.status !== 'running')) return { kind: 'gone' };
  const identity = await verifyFaviconBatchItemIdentity(tx, claim, item);
  if (identity.kind === 'job_gone') return { kind: 'gone' };
  if (identity.kind === 'skipped') return { kind: 'skipped' };
  if (identity.kind === 'terminal') return { kind: 'terminal', reason: identity.reason };
  const current = await tx.bookmarkIcons.findByNodeId(item.nodeId);
  if (restore.originalObjectId !== null) {
    const row: BookmarkIconRow = {
      nodeId: item.nodeId,
      collectionId: item.collectionId,
      objectId: restore.originalObjectId,
      contentType: restore.originalContentType ?? 'image/png',
      byteSize: restore.originalByteSize ?? 0,
      digestSha256: restore.originalDigestSha256 ?? Buffer.alloc(32),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await tx.bookmarkIcons.upsert(row);
  } else {
    await tx.bookmarkIcons.deleteByNodeId(item.nodeId);
  }
  if (current !== null && current.objectId !== restore.originalObjectId) {
    await tx.gc.recordRetired({
      objectId: current.objectId,
      nodeId: current.nodeId,
      collectionId: current.collectionId,
      retiredAt: now,
      deletableAt: new Date(now.getTime() + retentionSeconds * 1_000),
    });
  }
  await tx.restores.deleteByNodeId(item.nodeId);
  await tx.items.markSucceeded(claim.jobId, item.nodeId, now);
  return { kind: 'applied' };
}

async function handleBatchItemFailure(
  ports: FaviconBatchExecutionPorts,
  claim: FaviconJobClaim,
  item: FaviconJobItemRow,
  error: unknown,
): Promise<FaviconBatchItemOutcome> {
  if (error instanceof FaviconFetchDeferred) {
    await ports.verify.run((tx) => tx.items.scheduleRetry(
      claim.jobId, item.nodeId, item.attempts, error.retryAt, 'fetch_failed', ports.now(),
    ));
    return 'retry_scheduled';
  }
  const reason = classifyBatchItemFailure(error);
  const attempts = item.attempts + 1;
  if (isFaviconTerminalReason(reason) || attempts >= ports.options.maxAttempts) {
    await ports.verify.run((tx) => tx.items.markFailed(claim.jobId, item.nodeId, attempts, reason, ports.now()));
    return 'failed';
  }
  const nextAttemptAt = nextBatchItemAttemptAt(attempts, ports.options.backoffSeconds, ports.now());
  await ports.verify.run((tx) => tx.items.scheduleRetry(
    claim.jobId, item.nodeId, attempts, nextAttemptAt, reason, ports.now(),
  ));
  return 'retry_scheduled';
}

function classifyBatchItemFailure(error: unknown): FaviconJobErrorReason {
  if (error instanceof FaviconFetchError) return error.reason;
  if (typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'BookmarkFaviconImageError') {
    return 'invalid_image';
  }
  return 'fetch_failed';
}

function nextBatchItemAttemptAt(attempts: number, backoffSeconds: readonly number[], now: Date): Date {
  const index = Math.min(Math.max(attempts - 1, 0), backoffSeconds.length - 1);
  const delaySeconds = backoffSeconds[index] ?? 1;
  return new Date(now.getTime() + Math.max(delaySeconds, 1) * 1_000);
}

/**
 * Execute one claimed batch job cycle: process up to batchSize due items, then
 * recompute the aggregate counters and either release the job back to pending
 * (items remain) or land on a terminal status. All writes are lease-fenced.
 */
export async function processFaviconBatchClaim(
  ports: FaviconBatchExecutionPorts,
  claim: FaviconJobClaim,
): Promise<{ readonly jobId: string; readonly outcome: FaviconExecutionOutcome }> {
  const batchSize = ports.options.batchSize;
  let processed = 0;
  while (processed < batchSize) {
    // FO-08: re-arm the 60s job lease before every item. A cycle of up to 100
    // serial fetches can outlive the original lease; renewal keeps the claim
    // exclusive. A failed renew means another worker re-claimed the job —
    // abort the cycle before its next item write.
    const renewed = await ports.worker.renewLease({
      jobId: claim.jobId,
      leaseOwner: claim.leaseOwner,
      leaseDurationMs: ports.options.leaseDurationMs,
    });
    if (!renewed) return { jobId: claim.jobId, outcome: 'lease_lost' };
    const due = await ports.verify.run((tx) => tx.items.listDueItems({
      jobId: claim.jobId,
      limit: batchSize - processed,
      now: ports.now(),
    }));
    if (due.length === 0) break;
    for (const item of due) {
      const outcome = await processFaviconBatchItem(ports, claim, item);
      processed += 1;
      if (outcome === 'job_gone') return { jobId: claim.jobId, outcome: 'lease_lost' };
    }
  }
  const now = ports.now();
  let generationOpen = false;
  if (claim.operation === 'restore_sources') {
    const page = await ports.verify.run((tx) => tx.items.extendRestoreGeneration({
      jobId: claim.jobId, accountId: claim.accountId, now, leaseOwner: claim.leaseOwner,
    }));
    if (page.inactive) return { jobId: claim.jobId, outcome: 'lease_lost' };
    // Pending items alone are not completion: the keyset scan may still be open,
    // including the empty job created before its first page.
    generationOpen = !page.scanComplete || !page.gapCaughtUp;
  }
  const aggregate = await ports.verify.run((tx) => tx.items.aggregateItems(claim.jobId));
  if (aggregate.pendingCount === 0 && !generationOpen) {
    const status = faviconBatchTerminalStatus({
      succeeded: aggregate.succeeded,
      failed: aggregate.failed,
      skipped: aggregate.skipped,
    });
    const ok = await ports.worker.updateBatch({
      jobId: claim.jobId,
      leaseOwner: claim.leaseOwner,
      status,
      succeeded: aggregate.succeeded,
      failed: aggregate.failed,
      skipped: aggregate.skipped,
      nextAttemptAt: null,
      updatedAt: now,
    });
    return { jobId: claim.jobId, outcome: ok ? 'succeeded' : 'lease_lost' };
  }
  const released = await ports.worker.updateBatch({
    jobId: claim.jobId,
    leaseOwner: claim.leaseOwner,
    status: 'pending',
    succeeded: aggregate.succeeded,
    failed: aggregate.failed,
    skipped: aggregate.skipped,
    nextAttemptAt: aggregate.nextAttemptAt ?? now,
    updatedAt: now,
  });
  return { jobId: claim.jobId, outcome: released ? 'batch_released' : 'lease_lost' };
}