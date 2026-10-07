import { knownFaviconForUrl } from './favicon-known-domains.js';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import { authorizeCapability, type AccessPolicyFactsPort } from '../../access-policy/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
} from '../domain/index.js';
import { bookmarkIconUrlFromObjectId } from './bookmark-icon-url.js';
import {
  DEFAULT_FAVICON_PROVIDER_TEMPLATE,
  formatPolicyTimestamp,
  type FaviconPolicyReadPort,
  type FaviconPolicyRow,
} from './favicon-policy.js';
import type {
  BookmarkIconRow,
  BookmarkIconWritePort,
  CollectionsClock,
  CollectionWritePort,
  LockedNodeRow,
  NodeWritePort,
} from './ports.js';
import type {
  FaviconGcWritePort,
  FaviconJobReadPort,
} from './favicon-job.js';
import type { FaviconSourceRestoreRow } from './favicon-batch-policy.js';
import { faviconRetentionSeconds } from './favicon-job-execution.js';
import {
  faviconHostnameFromBookmarkUrl,
  resolveFaviconProviderUrl,
} from './favicon-fetch-policy.js';

export const FAVICON_SOURCE_COMMAND_CONTRACT_VERSION = '1.0.0';
export const FAVICON_SOURCE_ETAG_SCOPE = 'favicon-source';
export const INITIAL_FAVICON_SOURCE_REVISION = 1n;
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const OPAQUE_REVISION_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;

export type IconSourceMode = 'inherit' | 'online' | 'uploaded' | 'none';
export type IconEffectiveMode = 'capture' | 'online' | 'uploaded' | 'none';
export type IconSourceStatus = 'ready' | 'missing' | 'pending' | 'failed';

/**
 * Does this bookmark's icon source act as online right now? `inherit` follows
 * the account default, so an untouched node under `newDefault: online` is an
 * online source even though no source row exists. Enqueue and the worker must
 * share this predicate: a literal `source_mode = 'online'` check rejects every
 * inherit node the enqueue just accepted (and every pre-FO-01 row).
 */
export function iconSourceActsOnline(input: {
  readonly sourceMode: IconSourceMode | null | undefined;
  readonly newDefault: 'capture' | 'online' | 'none';
}): boolean {
  const mode = input.sourceMode ?? 'inherit';
  if (mode === 'online') return true;
  if (mode === 'none' || mode === 'uploaded') return false;
  return input.newDefault === 'online';
}

export function bookmarkFaviconSourceRoute(collectionId: string, nodeId: string): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon-source`;
}

export function bookmarkFaviconSourceCommandScope(collectionId: string, nodeId: string): string {
  return `collection:${collectionId}:node:${nodeId}:favicon:source`;
}

/** Per-node explicit source state; `uploaded` enters only through real upload. */
export interface BookmarkIconSourceRow {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly sourceMode: IconSourceMode;
  readonly revision: bigint;
  readonly updatedAt: Date;
}

export interface BookmarkIconSourceReadPort {
  findByNodeId(nodeId: string): Promise<BookmarkIconSourceRow | null>;
}

/** FO-02: does a non-owner member read this collection? (drives directUrl exposure) */
export interface FaviconSourceMembershipReadPort {
  hasNonOwnerMember(collectionId: string, ownerSubjectId: string): Promise<boolean>;
}

/**
 * F-A8: pending force-restore lookup. A `favicon_source_restores` row for the
 * node means forceAllOnline displaced its original icon and force-off will
 * restore it — the source is `restorable`. Minimal structural port so transport
 * wiring stays optional (absent ⇒ fail closed with restorable false).
 */
export interface FaviconRestoreReadPortLike {
  findByNodeId(nodeId: string): Promise<FaviconSourceRestoreRow | null>;
}

export interface BookmarkIconSourceWritePort extends BookmarkIconSourceReadPort {
  /**
   * CAS upsert. A missing row only accepts `expectedRevision` 1 (fencing the
   * virtual default); otherwise the stored revision must equal the expected
   * one. Returns `stale` with the current revision on conflict.
   */
  update(input: {
    readonly nodeId: string;
    readonly collectionId: string;
    readonly sourceMode: IconSourceMode;
    readonly expectedRevision: bigint;
    readonly updatedAt: Date;
  }): Promise<{ readonly kind: 'updated'; readonly row: BookmarkIconSourceRow }
    | { readonly kind: 'stale'; readonly currentRevision: bigint }>;
  /**
   * Non-CAS internal write used only by the real Product upload (uploaded) and
   * explicit Product delete (none); the caller holds the collection write lock,
   * so the upsert always advances the revision deterministically.
   */
  setMode(input: {
    readonly nodeId: string;
    readonly collectionId: string;
    readonly sourceMode: IconSourceMode;
    readonly updatedAt: Date;
  }): Promise<void>;
}

export class FaviconSourceCommandError extends Error {
  constructor(readonly code: 'invalid_request', message: string) {
    super(message);
    this.name = 'FaviconSourceCommandError';
  }
}

export interface IconSourceView {
  readonly collectionId: string;
  readonly nodeId: string;
  /** Internal: node resource revision used to fence the composite ETag. */
  readonly nodeResourceRevision: string;
  readonly revision: bigint;
  readonly policyRevision: bigint;
  readonly sourceMode: IconSourceMode;
  readonly effectiveMode: IconEffectiveMode;
  readonly iconUrl: string | null;
  readonly iconVersion: string | null;
  readonly directUrl: string | null;
  readonly status: IconSourceStatus;
  /** F-A8: a pending force-restore row exists for this node. */
  readonly restorable: boolean;
  readonly updatedAt: Date;
}

export interface IconSourceDto {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly revision: string;
  readonly policyRevision: string;
  readonly sourceMode: IconSourceMode;
  readonly effectiveMode: IconEffectiveMode;
  readonly iconUrl: string | null;
  readonly iconVersion: string | null;
  readonly directUrl: string | null;
  readonly status: IconSourceStatus;
  readonly restorable: boolean;
  readonly updatedAt: string;
}

export interface GetBookmarkFaviconSourceInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly collectionId: string;
  readonly nodeId: string;
  readonly productOrigin: string | undefined;
}

export interface SetBookmarkFaviconSourceInput extends GetBookmarkFaviconSourceInput {
  readonly commandId: string;
  readonly expectedEtag: string;
  readonly sourceMode: 'inherit' | 'none' | 'online';
}

export interface SetBookmarkFaviconSourcePorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly clock: CollectionsClock;
  readonly collections: Pick<CollectionWritePort, 'lockForUpdate'>;
  readonly nodes: Pick<NodeWritePort, 'getNode'>;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly sources: BookmarkIconSourceWritePort;
  readonly policies: FaviconPolicyReadPort;
  readonly bookmarkIcons: Pick<BookmarkIconWritePort, 'findByNodeId' | 'deleteByNodeId'> & Partial<Pick<BookmarkIconWritePort, 'findObjectIdsByNodeIds'>>;
  /** Durable object retirement (retention window), never an immediate delete. */
  readonly gc: Pick<FaviconGcWritePort, 'recordRetired'>;
  /** FO-02 online status projection. */
  readonly jobs?: FaviconJobReadPort;
  /** FO-02 unshared-private directUrl exposure. */
  readonly collectionMembers?: FaviconSourceMembershipReadPort;
  /** F-A8: pending force-restore lookup (restorable projection). */
  readonly restores?: FaviconRestoreReadPortLike;
}

export interface GetBookmarkFaviconSourcePorts {
  readonly collections: Pick<CollectionWritePort, 'lockForShare'>;
  readonly nodes: Pick<NodeWritePort, 'getNode'>;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly sources: BookmarkIconSourceReadPort;
  readonly policies: FaviconPolicyReadPort;
  readonly bookmarkIcons: Pick<BookmarkIconWritePort, 'findByNodeId'> & Partial<Pick<BookmarkIconWritePort, 'findObjectIdsByNodeIds'>>;
  /** FO-02 online status projection (latest refresh job for the node). */
  readonly jobs?: FaviconJobReadPort;
  /** FO-02 unshared-private directUrl exposure. Absent ⇒ fail closed (no directUrl). */
  readonly collectionMembers?: FaviconSourceMembershipReadPort;
  /** F-A8: pending force-restore lookup. Absent ⇒ restorable false. */
  readonly restores?: FaviconRestoreReadPortLike;
}

export type SetBookmarkFaviconSourceReceiptOutcome =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export type SetBookmarkFaviconSourceResult =
  | { readonly kind: 'succeeded'; readonly view: IconSourceView; readonly changed: boolean }
  | SetBookmarkFaviconSourceReceiptOutcome;

/** Composite strong ETag fencing both the node resource revision and the source revision. */
export function iconSourceEtag(nodeResourceRevision: string, sourceRevision: bigint): string {
  return `"${FAVICON_SOURCE_ETAG_SCOPE}:${nodeResourceRevision}:${sourceRevision.toString()}"`;
}

export function parseIconSourceEtag(etag: string): {
  readonly nodeResourceRevision: string;
  readonly sourceRevision: bigint;
} | null {
  const prefix = `"${FAVICON_SOURCE_ETAG_SCOPE}:`;
  if (!etag.startsWith(prefix) || !etag.endsWith('"')) return null;
  const middle = etag.slice(prefix.length, -1);
  const separator = middle.lastIndexOf(':');
  if (separator < 1) return null;
  const nodeResourceRevision = middle.slice(0, separator);
  const revision = middle.slice(separator + 1);
  if (!OPAQUE_REVISION_PATTERN.test(nodeResourceRevision)) return null;
  if (!REVISION_PATTERN.test(revision)) return null;
  const value = BigInt(revision);
  if (value < 1n) return null;
  return { nodeResourceRevision, sourceRevision: value };
}

export function toIconSourceDto(view: IconSourceView): IconSourceDto {
  return {
    collectionId: view.collectionId,
    nodeId: view.nodeId,
    revision: view.revision.toString(),
    policyRevision: view.policyRevision.toString(),
    sourceMode: view.sourceMode,
    effectiveMode: view.effectiveMode,
    iconUrl: view.iconUrl,
    iconVersion: view.iconVersion,
    directUrl: view.directUrl,
    status: view.status,
    restorable: view.restorable,
    updatedAt: formatPolicyTimestamp(view.updatedAt),
  };
}

/** Owner-only access + live bookmark load; concealed 404 for missing/foreign targets. */
export async function loadOwnerBookmarkNode(
  ports: Pick<SetBookmarkFaviconSourcePorts, 'collections' | 'nodes' | 'accessPolicy'>,
  actor: { readonly principalId: string; readonly subjectId: string },
  collectionId: string,
  nodeId: string,
): Promise<{ readonly node: LockedNodeRow; readonly collectionOwnerSubjectId: string; readonly collectionVisibility: 'private' | 'protected' | 'unlisted' | 'public' }> {
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
    // Owner-only per the favicon-source contract (x-access: owner).
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
    throw new FaviconSourceCommandError('invalid_request', 'favicon sources are only available on bookmark nodes');
  }
  return {
    node,
    collectionOwnerSubjectId: locked.ownerSubjectId,
    collectionVisibility: locked.visibility,
  };
}

/**
 * Project the effective source state from source row + uploaded binding +
 * account policy (+ latest refresh job). Binding presence wins when the row is
 * absent or inherit, so pre-FO-01 uploads (bindings without a source row)
 * still read uploaded.
 *
 * FO-02 online projection:
 * - a pending/running refresh job yields status `pending`; a terminal failed
 *   refresh yields `failed` — an intact old binding stays renderable
 *   (contract renderFallback);
 * - shared-readable collections always expose the pinned object and never a
 *   provider directUrl; only a truly unshared PRIVATE online bookmark exposes
 *   the provider URL so the owner's client may connect directly (public,
 *   unlisted, protected and member-shared private are all shared-readable);
 * - F-A8: a pending favicon_source_restores row for this node makes the source
 *   `restorable` (forceAllOnline displaced the original; force-off restores it).
 */
export async function projectIconSource(
  ports: Pick<GetBookmarkFaviconSourcePorts, 'sources' | 'policies' | 'bookmarkIcons' | 'jobs' | 'collectionMembers' | 'restores'>,
  node: LockedNodeRow,
  actorPrincipalId: string,
  ownerSubjectId: string,
  productOrigin: string | undefined,
  collectionVisibility: 'private' | 'protected' | 'unlisted' | 'public' | undefined,
): Promise<IconSourceView> {
  const [sourceRow, binding, policyRow, jobState, sharedByMembers, restoreRow] = await Promise.all([
    ports.sources.findByNodeId(node.id),
    ports.bookmarkIcons.findByNodeId(node.id),
    ports.policies.findByAccountId(actorPrincipalId),
    ports.jobs === undefined ? Promise.resolve(null) : ports.jobs.latestForNode(node.id),
    ports.collectionMembers === undefined
      ? Promise.resolve(null)
      : ports.collectionMembers.hasNonOwnerMember(node.collectionId, ownerSubjectId),
    ports.restores === undefined ? Promise.resolve(null) : ports.restores.findByNodeId(node.id),
  ]);
  const policy: FaviconPolicyRow = policyRow ?? {
    accountId: actorPrincipalId,
    newDefault: 'capture',
    providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
    fillMissing: false,
    forceAllOnline: false,
    revision: 1n,
    updatedAt: node.updatedAt,
  };
  const sourceMode: IconSourceMode = sourceRow?.sourceMode ?? 'inherit';
  const bindingPresent = binding !== null;
  // FO-03 forceAllOnline: the owner explicitly enables a TEMPORARY override of
  // every icon (including uploaded/none); the original source row and binding
  // are preserved (favicon_source_restores) and restored on force-off.
  const forceOn = policy.forceAllOnline && node.kind === 'bookmark' && (node.url ?? '').trim().length > 0;
  let effectiveMode: IconEffectiveMode;
  if (forceOn) {
    effectiveMode = 'online';
  } else if (sourceMode === 'none') {
    effectiveMode = 'none';
  } else if (sourceMode === 'online') {
    effectiveMode = 'online';
  } else if (sourceMode === 'inherit' && policy.newDefault === 'online' && bindingPresent) {
    // An inherit node under an online default: an automatic online capture
    // (fill/refresh) reads as online, never as a manual upload.
    effectiveMode = 'online';
  } else if (bindingPresent) {
    effectiveMode = 'uploaded';
  } else if (sourceMode === 'inherit') {
    effectiveMode = policy.newDefault;
  } else {
    effectiveMode = 'uploaded';
  }
  const projectedObjectId = effectiveMode === 'online'
    ? (await ports.bookmarkIcons.findObjectIdsByNodeIds?.([node.id]))?.get(node.id) ?? binding?.objectId
    : binding?.objectId;
  let status: IconSourceStatus;
  let directUrl: string | null = null;
  if (effectiveMode === 'online') {
    const jobPending = jobState !== null
      && (jobState.status === 'pending' || jobState.status === 'running');
    const jobFailed = jobState !== null && jobState.status === 'failed';
    status = jobPending ? 'pending' : jobFailed ? 'failed' : projectedObjectId ? 'ready' : 'missing';
    const hostname = faviconHostnameFromBookmarkUrl(node.url ?? '');
    // Fail closed: only a PRIVATE collection with no non-owner member is
    // unshared enough for a provider directUrl.
    if (knownFaviconForUrl(node.url) === null && collectionVisibility === 'private' && sharedByMembers === false && hostname !== null) {
      directUrl = resolveFaviconProviderUrl(policy.providerTemplate, hostname);
    }
  } else {
    status = effectiveMode === 'uploaded' && bindingPresent ? 'ready' : 'missing';
  }
  return {
    collectionId: node.collectionId,
    nodeId: node.id,
    nodeResourceRevision: node.resourceRevision,
    revision: sourceRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION,
    policyRevision: policy.revision,
    sourceMode,
    effectiveMode,
    iconUrl: projectedObjectId !== undefined && productOrigin !== undefined && productOrigin.length > 0
      ? bookmarkIconUrlFromObjectId(productOrigin, projectedObjectId)
      : null,
    iconVersion: projectedObjectId ?? null,
    directUrl,
    status,
    // F-A8: reflect reality — a pending force-restore row means force-off can
    // restore the original icon; without one the source is not restorable.
    restorable: restoreRow !== null,
    updatedAt: sourceRow?.updatedAt ?? node.updatedAt,
  };
}

export async function getBookmarkFaviconSource(
  ports: GetBookmarkFaviconSourcePorts,
  input: GetBookmarkFaviconSourceInput,
): Promise<IconSourceView> {
  const locked = await ports.collections.lockForShare(input.collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  if (locked.deletedAt !== null) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId: input.collectionId,
    actor: { principalId: input.actor.principalId, subjectId: input.actor.subjectId, kind: 'account' as const },
    capability: 'update_node',
  });
  if (decision.outcome !== 'allow' || decision.effectiveRole !== 'owner') {
    if (decision.outcome !== 'allow') {
      throw new CollectionAuthorizationError({ outcome: decision.outcome, reasonCategory: decision.reasonCategory });
    }
    throw new CollectionAuthorizationError({ outcome: 'deny', reasonCategory: 'insufficient_role' });
  }
  const node = await ports.nodes.getNode(input.collectionId, input.nodeId);
  if (!node || node.deletedAt !== null || node.collectionId !== input.collectionId) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  if (node.kind !== 'bookmark') {
    throw new FaviconSourceCommandError('invalid_request', 'favicon sources are only available on bookmark nodes');
  }
  return projectIconSource(
    ports,
    node,
    input.actor.principalId,
    locked.ownerSubjectId,
    input.productOrigin,
    locked.visibility,
  );
}

export async function setBookmarkFaviconSource(
  ports: SetBookmarkFaviconSourcePorts,
  input: SetBookmarkFaviconSourceInput,
): Promise<SetBookmarkFaviconSourceResult> {
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new FaviconSourceCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  const expected = parseIconSourceEtag(input.expectedEtag);
  if (expected === null) {
    throw new FaviconSourceCommandError(
      'invalid_request',
      'If-Match must be a strong favicon-source entity-tag fencing the node and source revisions.',
    );
  }
  const fingerprint = canonicalCommandFingerprint({
    method: 'PUT',
    route: bookmarkFaviconSourceRoute(input.collectionId, input.nodeId),
    mediaType: 'application/json',
    body: canonicalJson({ sourceMode: input.sourceMode }),
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: bookmarkFaviconSourceCommandScope(input.collectionId, input.nodeId),
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapSourceClaim(claim);

  const { node, collectionOwnerSubjectId, collectionVisibility } = await loadOwnerBookmarkNode(ports, input.actor, input.collectionId, input.nodeId);
  const currentRow = await ports.sources.findByNodeId(node.id);
  const currentRevision = currentRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION;
  if (node.resourceRevision !== expected.nodeResourceRevision || currentRevision !== expected.sourceRevision) {
    throw new CollectionPreconditionError({
      currentEtag: iconSourceEtag(node.resourceRevision, currentRevision),
      precondition: 'resource',
      message: 'The favicon source ETag does not match the current representation.',
    });
  }

  if ((currentRow?.sourceMode ?? 'inherit') === input.sourceMode) {
    const view = await projectIconSource(ports, node, input.actor.principalId, collectionOwnerSubjectId, input.productOrigin, collectionVisibility);
    await ports.receipts.complete(binding, fingerprint, sourceProductResult(view));
    return { kind: 'succeeded', view, changed: false };
  }

  // Source switching never destroys a valid version.
  //
  // - target `online` is a replacement *request*: the current binding stays
  //   bound and renderable until the refresh CAS swaps it ("替换失败：有旧版
  //   本就保留，失败不能先清空有效绑定"). The CAS path retires the displaced
  //   object with the retention window.
  // - targets `inherit`/`none` deliberately drop the binding; the retired
  //   object then enters the durable GC retention window (covered cache
  //   promise) instead of being deleted out from under caches.
  const now = await ports.clock.now();
  const previousBinding = await ports.bookmarkIcons.findByNodeId(node.id);
  if (previousBinding !== null && input.sourceMode !== 'online') {
    await ports.bookmarkIcons.deleteByNodeId(node.id);
    await ports.gc.recordRetired({
      objectId: previousBinding.objectId,
      nodeId: previousBinding.nodeId,
      collectionId: previousBinding.collectionId,
      retiredAt: now,
      deletableAt: new Date(now.getTime() + faviconRetentionSeconds() * 1_000),
    });
  }

  const written = await ports.sources.update({
    nodeId: node.id,
    collectionId: node.collectionId,
    sourceMode: input.sourceMode,
    expectedRevision: currentRevision,
    updatedAt: now,
  });
  if (written.kind === 'stale') {
    throw new CollectionPreconditionError({
      currentEtag: iconSourceEtag(node.resourceRevision, written.currentRevision),
      precondition: 'resource',
      message: 'The favicon source ETag does not match the current representation.',
    });
  }
  const view = await projectIconSource(ports, node, input.actor.principalId, collectionOwnerSubjectId, input.productOrigin, collectionVisibility);
  await ports.receipts.complete(binding, fingerprint, sourceProductResult(view));
  return { kind: 'succeeded', view, changed: true };
}

function sourceProductResult(view: IconSourceView): ProductCommandResult {
  const body = JSON.stringify(toIconSourceDto(view));
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      'etag': iconSourceEtag(view.nodeResourceRevision, view.revision),
    },
    mediaType: 'application/json',
    contractVersion: FAVICON_SOURCE_COMMAND_CONTRACT_VERSION,
    targetIdentity: view.nodeId,
  };
}

function mapSourceClaim(
  claim: Exclude<ProductCommandClaim, { kind: 'claimed' }>,
): SetBookmarkFaviconSourceResult {
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

export function mapFaviconSourceCommandError(
  error: unknown,
): FaviconSourceCommandError | CollectionPreconditionError | CollectionAuthorizationError | null {
  if (error instanceof FaviconSourceCommandError) return error;
  if (error instanceof CollectionPreconditionError) return error;
  if (error instanceof CollectionAuthorizationError) return error;
  return null;
}