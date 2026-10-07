/**
 * FO-02 durable favicon refresh job: records, ports and the enqueue command.
 *
 * The enqueue path (refreshBookmarkFavicon) persists a durable `refresh_one`
 * job carrying the account, node, URL identity, source revision and policy
 * revision AFTER re-verifying ownership, current policy and resource liveness.
 * The worker execution that consumes these jobs lives in
 * `favicon-job-execution.ts` (fetch → pre-PUT object id → atomic CAS →
 * retry/backoff), and the GC pending-deletion policy lives with it.
 */
import { randomUUID } from 'node:crypto';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
} from '../../access-policy/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
} from '../domain/index.js';
import {
  INITIAL_FAVICON_SOURCE_REVISION,
  iconSourceActsOnline,
  iconSourceEtag,
  parseIconSourceEtag,
  type BookmarkIconSourceReadPort,
} from './favicon-icon-source.js';
import {
  virtualFaviconPolicy,
  type FaviconPolicyReadPort,
  type FaviconPolicyRow,
} from './favicon-policy.js';
import {
  faviconHostnameFromBookmarkUrl,
  resolveFaviconProviderUrl,
} from './favicon-fetch-policy.js';
import type {
  CollectionWritePort,
  CollectionsClock,
  LockedNodeRow,
  NodeWritePort,
} from './ports.js';

export const FAVICON_REFRESH_COMMAND_CONTRACT_VERSION = '1.0.0';

/**
 * FO-03 extends the frozen IconJob operation set: batch jobs (fill_missing,
 * refresh_online, apply_force_online, restore_sources) were part of the FO-02
 * migration CHECK constraint but not creatable in FO-02.
 */
export type FaviconJobOperation =
  | 'refresh_one'
  | 'fill_missing'
  | 'refresh_online'
  | 'apply_force_online'
  | 'restore_sources';
export type FaviconJobStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'superseded';
export type FaviconJobErrorReason =
  | 'fetch_failed'
  | 'invalid_image'
  | 'unsafe_source'
  | 'stale_policy'
  | 'source_changed'
  | 'permission_changed'
  | 'storage_unavailable';

export function bookmarkFaviconRefreshRoute(collectionId: string, nodeId: string): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon-refresh`;
}

export function bookmarkFaviconRefreshCommandScope(collectionId: string, nodeId: string): string {
  return `collection:${collectionId}:node:${nodeId}:favicon:refresh`;
}

// ---------------------------------------------------------------------------
// Durable job records
// ---------------------------------------------------------------------------

export interface FaviconJobRecord {
  readonly jobId: string;
  readonly accountId: string;
  readonly ownerSubjectId: string;
  readonly operation: FaviconJobOperation;
  readonly policyRevision: bigint;
  readonly status: FaviconJobStatus;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errorNodeId: string | null;
  readonly errorReason: FaviconJobErrorReason | null;
  readonly collectionId: string | null;
  readonly nodeId: string | null;
  readonly sourceUrl: string | null;
  readonly sourceRevision: bigint | null;
  readonly nodeResourceRevision: string | null;
  readonly objectId: string | null;
  readonly objectContentType: string | null;
  readonly objectByteSize: number | null;
  readonly objectDigestSha256: Buffer | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * FO-08 worker lease ownership. The batch verifier uses the owner as the
   * per-item lease fence: a claim whose lease was lost (another worker
   * reclaimed the expired job) must never keep writing items or bindings.
   * Null while the job is pending/terminal (no lease held).
   */
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
}

export interface FaviconJobInsert {
  readonly jobId: string;
  readonly accountId: string;
  readonly ownerSubjectId: string;
  readonly policyRevision: bigint;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly sourceUrl: string;
  readonly sourceRevision: bigint;
  readonly nodeResourceRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Transaction-scoped job writes (enqueue + worker verify/CAS). */
export interface FaviconJobWritePort {
  insert(input: FaviconJobInsert): Promise<void>;
  findByJobId(jobId: string): Promise<FaviconJobRecord | null>;
  /**
   * FO-C-01: lock the job row FOR UPDATE so the binding CAS serializes with
   * a concurrent enqueue-supersede: a superseded job can no longer bind its
   * captured object over the superseding job's binding (the job-level
   * supersede only flips favicon_jobs.status, never the item rows).
   */
  lockByJobId(jobId: string): Promise<FaviconJobRecord | null>;
  /** Persist the pre-PUT target object id (durable before any external PUT). */
  setObjectId(input: { readonly jobId: string; readonly objectId: string; readonly updatedAt: Date }): Promise<void>;
  /** Persist object metadata once the bytes are fixed (binding CAS side). */
  setObjectMetadata(input: {
    readonly jobId: string;
    readonly objectId: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly digestSha256: Buffer;
    readonly updatedAt: Date;
  }): Promise<void>;
}

/** Per-node latest job lookup for the IconSource status projection. */
export interface FaviconJobReadPort {
  latestForNode(nodeId: string): Promise<{
    readonly status: FaviconJobStatus;
    readonly operation: FaviconJobOperation;
  } | null>;
}

/** Durable pending-deletion records for GC (transaction-scoped write). */
export interface FaviconGcWritePort {
  recordRetired(input: {
    readonly objectId: string;
    readonly nodeId: string;
    readonly collectionId: string;
    readonly retiredAt: Date;
    readonly deletableAt: Date;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Enqueue command (refreshBookmarkFavicon → 202 {jobId})
// ---------------------------------------------------------------------------

export interface FaviconRefreshEnqueuePorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly clock: CollectionsClock;
  readonly collections: Pick<CollectionWritePort, 'lockForUpdate'>;
  readonly nodes: Pick<NodeWritePort, 'getNode'>;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly sources: BookmarkIconSourceReadPort;
  readonly policies: FaviconPolicyReadPort;
  readonly jobs: FaviconJobWritePort;
}

export interface FaviconRefreshEnqueueInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly expectedEtag: string;
  readonly collectionId: string;
  readonly nodeId: string;
}

export type FaviconRefreshReceiptOutcome =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export type FaviconRefreshEnqueueResult =
  | { readonly kind: 'accepted'; readonly jobId: string; readonly etag: string }
  | FaviconRefreshReceiptOutcome;

export class FaviconRefreshCommandError extends Error {
  constructor(readonly code: 'invalid_request', message: string) {
    super(message);
    this.name = 'FaviconRefreshCommandError';
  }
}

export function faviconRefreshFingerprint(collectionId: string, nodeId: string): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: bookmarkFaviconRefreshRoute(collectionId, nodeId),
    mediaType: '',
    body: '',
  });
}

export interface FaviconAutoEnqueuePorts {
  readonly sources: Pick<BookmarkIconSourceReadPort, 'findByNodeId'>;
  readonly policies: FaviconPolicyReadPort;
  readonly jobs: Pick<FaviconJobWritePort, 'insert'>;
}

/**
 * FO-07: a bookmark created with the account default `online` must actually
 * fetch its icon — `newDefault` was only a projection before, so a Web-created
 * bookmark stayed empty until the owner pressed Refresh. Insert the durable
 * `refresh_one` job in the SAME transaction as the node create (the caller
 * passes transaction-scoped ports). Returns null when the new node is not an
 * online source (capture/none/uploads keep their existing flows) or the
 * provider URL cannot be resolved safely.
 */
export async function enqueueFaviconRefreshForNewBookmark(
  ports: FaviconAutoEnqueuePorts,
  input: {
    readonly accountId: string;
    readonly ownerSubjectId: string;
    readonly collectionId: string;
    readonly nodeId: string;
    readonly url: string;
    readonly nodeResourceRevision: string;
    readonly now: Date;
  },
): Promise<string | null> {
  const [sourceRow, policyRow] = await Promise.all([
    ports.sources.findByNodeId(input.nodeId),
    ports.policies.findByAccountId(input.accountId),
  ]);
  const policy = policyRow ?? virtualFaviconPolicy(input.accountId, input.now);
  const actsOnline = iconSourceActsOnline({
    sourceMode: sourceRow?.sourceMode ?? null,
    newDefault: policy.newDefault,
  });
  if (!actsOnline) return null;
  const hostname = faviconHostnameFromBookmarkUrl(input.url);
  const sourceUrl = hostname === null
    ? null
    : resolveFaviconProviderUrl(policy.providerTemplate, hostname);
  if (sourceUrl === null) return null;
  const jobId = randomUUID();
  await ports.jobs.insert({
    jobId,
    accountId: input.accountId,
    ownerSubjectId: input.ownerSubjectId,
    policyRevision: policy.revision,
    collectionId: input.collectionId,
    nodeId: input.nodeId,
    sourceUrl,
    sourceRevision: sourceRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION,
    nodeResourceRevision: input.nodeResourceRevision,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return jobId;
}

/**
 * Enqueue a single-node online refresh. Owner-only; the effective mode must be
 * online; the provider URL is resolved and pre-validated before the job row is
 * durable. Returns 202-style acceptance with the job id.
 */
export async function enqueueBookmarkFaviconRefresh(
  ports: FaviconRefreshEnqueuePorts,
  input: FaviconRefreshEnqueueInput,
): Promise<FaviconRefreshEnqueueResult> {
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new FaviconRefreshCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  const expected = parseIconSourceEtag(input.expectedEtag);
  if (expected === null) {
    throw new FaviconRefreshCommandError(
      'invalid_request',
      'If-Match must be a strong favicon-source entity-tag fencing the node and source revisions.',
    );
  }
  const binding = {
    principalId: input.actor.principalId,
    commandScope: bookmarkFaviconRefreshCommandScope(input.collectionId, input.nodeId),
    commandId,
  };
  const fingerprint = faviconRefreshFingerprint(input.collectionId, input.nodeId);
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapRefreshClaim(claim);

  const node = await loadRefreshOwnerNode(ports, input.actor, input.collectionId, input.nodeId);
  const [sourceRow, policyRow] = await Promise.all([
    ports.sources.findByNodeId(node.id),
    ports.policies.findByAccountId(input.actor.principalId),
  ]);
  const policy: FaviconPolicyRow = policyRow ?? virtualFaviconPolicy(input.actor.principalId, node.updatedAt);
  const currentRevision = sourceRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION;
  if (node.resourceRevision !== expected.nodeResourceRevision || currentRevision !== expected.sourceRevision) {
    throw new CollectionPreconditionError({
      currentEtag: iconSourceEtag(node.resourceRevision, currentRevision),
      precondition: 'resource',
      message: 'The favicon source ETag does not match the current representation.',
    });
  }
  const sourceMode = sourceRow?.sourceMode ?? 'inherit';
  // Same predicate the worker re-verifies with: inherit follows newDefault.
  const effectiveMode = iconSourceActsOnline({ sourceMode, newDefault: policy.newDefault })
    ? 'online'
    : sourceMode === 'inherit' ? policy.newDefault : sourceMode;
  if (effectiveMode !== 'online') {
    throw new FaviconRefreshCommandError(
      'invalid_request',
      'favicon refresh requires a node whose effective icon source is online.',
    );
  }
  const hostname = faviconHostnameFromBookmarkUrl(node.url ?? '');
  const sourceUrl = hostname === null
    ? null
    : resolveFaviconProviderUrl(policy.providerTemplate, hostname);
  if (sourceUrl === null) {
    throw new FaviconRefreshCommandError(
      'invalid_request',
      'The favicon provider URL cannot be resolved safely for this bookmark.',
    );
  }
  const now = await ports.clock.now();
  const jobId = randomUUID();
  await ports.jobs.insert({
    jobId,
    accountId: input.actor.principalId,
    ownerSubjectId: input.actor.subjectId,
    policyRevision: policy.revision,
    collectionId: node.collectionId,
    nodeId: node.id,
    sourceUrl,
    sourceRevision: currentRevision,
    nodeResourceRevision: node.resourceRevision,
    createdAt: now,
    updatedAt: now,
  });
  const etag = iconSourceEtag(node.resourceRevision, currentRevision);
  await ports.receipts.complete(binding, fingerprint, faviconRefreshAcceptedResult(jobId, etag));
  return {
    kind: 'accepted',
    jobId,
    etag,
  };
}

function faviconRefreshAcceptedResult(jobId: string, etag: string): ProductCommandResult {
  const body = JSON.stringify({ jobId });
  return {
    status: 202,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      'etag': etag,
    },
    mediaType: 'application/json',
    contractVersion: FAVICON_REFRESH_COMMAND_CONTRACT_VERSION,
    targetIdentity: jobId,
  };
}

function mapRefreshClaim(
  claim: Exclude<ProductCommandClaim, { kind: 'claimed' }>,
): FaviconRefreshReceiptOutcome {
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

async function loadRefreshOwnerNode(
  ports: Pick<FaviconRefreshEnqueuePorts, 'collections' | 'nodes' | 'accessPolicy'>,
  actor: { readonly principalId: string; readonly subjectId: string },
  collectionId: string,
  nodeId: string,
): Promise<LockedNodeRow> {
  const locked = await ports.collections.lockForUpdate(collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  if (locked.deletedAt !== null) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId,
    actor: { principalId: actor.principalId, subjectId: actor.subjectId, kind: 'account' as const },
    capability: 'update_node',
  });
  if (decision.outcome !== 'allow' || decision.effectiveRole !== 'owner') {
    if (decision.outcome !== 'allow') {
      throw new CollectionAuthorizationError({ outcome: decision.outcome, reasonCategory: decision.reasonCategory });
    }
    throw new CollectionAuthorizationError({ outcome: 'deny', reasonCategory: 'insufficient_role' });
  }
  const node = await ports.nodes.getNode(collectionId, nodeId);
  if (!node || node.deletedAt !== null || node.collectionId !== collectionId) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  if (node.kind !== 'bookmark') {
    throw new FaviconRefreshCommandError('invalid_request', 'favicon refresh is only available on bookmark nodes');
  }
  return node;
}

