import { createHash, randomUUID } from 'node:crypto';
import type { AccessPolicyFactsPort } from '../../access-policy/index.js';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import { CollectionAuthorizationError, formatUtcDateTime, strongEntityTag } from '../domain/index.js';
import {
  bookmarkFaviconBodyFingerprint,
} from './bookmark-favicon-command.js';
import { bookmarkIconUrlFromObjectId, projectBookmarkIconUrl } from './bookmark-icon-url.js';
import type { BookmarkNodeView } from './get-editor-page.js';
import {
  INITIAL_FAVICON_SOURCE_REVISION,
  iconSourceEtag,
  loadOwnerBookmarkNode,
  parseIconSourceEtag,
  type BookmarkIconSourceWritePort,
} from './favicon-icon-source.js';
import {
  faviconPolicyEtag,
  virtualFaviconPolicy,
  type FaviconPolicyReadPort,
  type FaviconPolicyRow,
} from './favicon-policy.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  sniffBookmarkFaviconCanonicalMime,
  type BookmarkFaviconObjectStore,
} from './favicon-store.js';
import type {
  BookmarkIconRow,
  BookmarkIconWritePort,
  CollectionsClock,
  CollectionWritePort,
  LockedNodeRow,
  NodeWritePort,
} from './ports.js';
import type { FaviconGcWritePort } from './favicon-job.js';
import { faviconRetentionSeconds } from './favicon-job-execution.js';
import { CollectionPreconditionError } from '../domain/index.js';

export const FAVICON_HELPER_CAPTURE_CONTRACT_VERSION = '1.0.0';

/** Canonical helper capture route used in receipts (never the Product route). */
export function bookmarkFaviconHelperRoute(collectionId: string, nodeId: string): string {
  return `/colp/v0.1/sync/collections/${collectionId}/nodes/${nodeId}/favicon`;
}

export function bookmarkFaviconHelperCaptureCommandScope(collectionId: string, nodeId: string): string {
  return `collection:${collectionId}:node:${nodeId}:favicon:helper-capture`;
}

export function bookmarkFaviconHelperClearCommandScope(collectionId: string, nodeId: string): string {
  return `collection:${collectionId}:node:${nodeId}:favicon:helper-clear`;
}

export class FaviconHelperCaptureCommandError extends Error {
  constructor(readonly code: 'invalid_request' | 'payload_too_large', message: string) {
    super(message);
    this.name = 'FaviconHelperCaptureCommandError';
  }
}

/**
 * FO-04 automatic-capture command ports. `sources` and `policies` are
 * required so every capture is fenced against the current source ETag and the
 * current account policy revision; `faviconStore` is the shared object store
 * used by the Product upload path.
 */
export interface FaviconHelperCapturePorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly clock: CollectionsClock;
  readonly collections: Pick<CollectionWritePort, 'lockForUpdate'>;
  readonly nodes: Pick<NodeWritePort, 'getNode'>;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly sources: BookmarkIconSourceWritePort;
  readonly policies: FaviconPolicyReadPort;
  readonly bookmarkIcons: BookmarkIconWritePort;
  /** Shared object store: PUT of the captured bytes + orphan cleanup only. */
  readonly faviconStore: BookmarkFaviconObjectStore;
  /** Durable retirement of the displaced object (retention window). */
  readonly gc: Pick<FaviconGcWritePort, 'recordRetired'>;
  /**
   * FO-C-02: retire an object that never became a binding in an INDEPENDENT
   * transaction (the command transaction is already aborted/rolled back when
   * this runs). Same contract as bookmark-favicon-command.orphanLedger.
   */
  readonly orphanLedger: (input: {
    readonly objectId: string;
    readonly nodeId: string;
    readonly collectionId: string;
    readonly at: Date;
  }) => Promise<void>;
  readonly onOrphanCleanupFailure?: () => void;
}

export interface FaviconHelperCaptureActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export interface FaviconHelperCaptureInput {
  readonly actor: FaviconHelperCaptureActor;
  readonly commandId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly productOrigin: string;
  /** The strong favicon-source ETag read from getExtensionFaviconSource. */
  readonly expectedSourceEtag: string;
  /** The current account policy revision read from getExtensionFaviconPolicy. */
  readonly expectedPolicyRevision: bigint;
}

export interface FaviconHelperClearInput {
  readonly actor: FaviconHelperCaptureActor;
  readonly commandId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly productOrigin: string;
  /** The strong favicon-source ETag read from getExtensionFaviconSource. */
  readonly expectedSourceEtag: string;
  /** The current account policy revision read from getExtensionFaviconPolicy. */
  readonly expectedPolicyRevision: bigint;
}

export type FaviconHelperCommandResult =
  | { readonly kind: 'created'; readonly view: BookmarkNodeView; readonly etag: string }
  | { readonly kind: 'replay'; readonly result: ProductCommandResult }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

/**
 * FO-04 helper capture: automatic upload only. Receipt claim comes BEFORE the
 * If-Match / policy-revision freshness checks so an exact retry of the first
 * command replays the saved outcome even with its now-old validators (contract
 * `receiptOrder`). Missing validators are transport-level 428; malformed are
 * transport-level 400; stale source ETag or policy revision is 412; protected
 * source state (uploaded / none / force-online) and non-owner actors are 403.
 */
export async function captureBookmarkFavicon(
  ports: FaviconHelperCapturePorts,
  input: FaviconHelperCaptureInput,
): Promise<FaviconHelperCommandResult> {
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new FaviconHelperCaptureCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  if (input.body.byteLength > BOOKMARK_FAVICON_MAX_BYTES) {
    throw new FaviconHelperCaptureCommandError(
      'payload_too_large',
      `favicon image must be at most ${BOOKMARK_FAVICON_MAX_BYTES} bytes`,
    );
  }
  const canonicalMime = sniffBookmarkFaviconCanonicalMime(input.body);
  if (!canonicalMime) {
    throw new FaviconHelperCaptureCommandError(
      'invalid_request',
      'favicon body is empty or is not a supported raster type',
    );
  }
  const expected = parseIconSourceEtag(input.expectedSourceEtag);
  if (expected === null) {
    throw new FaviconHelperCaptureCommandError(
      'invalid_request',
      'If-Match must be a strong favicon-source entity-tag fencing the node and source revisions.',
    );
  }

  const binding = {
    principalId: input.actor.principalId,
    commandScope: bookmarkFaviconHelperCaptureCommandScope(input.collectionId, input.nodeId),
    commandId,
  };
  const fingerprint = canonicalCommandFingerprint({
    method: 'POST',
    route: bookmarkFaviconHelperRoute(input.collectionId, input.nodeId),
    mediaType: input.contentType,
    body: bookmarkFaviconBodyFingerprint(input.body),
  });
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapHelperClaim(claim);

  const { node, collectionOwnerSubjectId, collectionVisibility } =
    await loadOwnerBookmarkNode(ports, input.actor, input.collectionId, input.nodeId);
  const currentRow = await ports.sources.findByNodeId(node.id);
  const currentSourceRevision = currentRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION;
  if (node.resourceRevision !== expected.nodeResourceRevision || currentSourceRevision !== expected.sourceRevision) {
    throw new CollectionPreconditionError({
      currentEtag: iconSourceEtag(node.resourceRevision, currentSourceRevision),
      precondition: 'resource',
      message: 'The favicon source ETag does not match the current representation.',
    });
  }
  const policyRow = await currentPolicy(ports, node, input.actor.principalId);
  if (policyRow.revision !== input.expectedPolicyRevision) {
    throw new CollectionPreconditionError({
      currentEtag: faviconPolicyEtag(policyRow.revision),
      precondition: 'resource',
      message: 'The favicon policy revision does not match the current account policy.',
    });
  }
  refuseProtectedSourceState(currentRow?.sourceMode ?? 'inherit', policyRow, node);

  const previous = await ports.bookmarkIcons.findByNodeId(node.id);
  const now = await ports.clock.now();
  const objectId = randomUUID();
  const iconUrl = bookmarkIconUrlFromObjectId(input.productOrigin, objectId);
  const row: BookmarkIconRow = {
    nodeId: node.id,
    collectionId: node.collectionId,
    objectId,
    contentType: canonicalMime,
    byteSize: input.body.byteLength,
    digestSha256: createHash('sha256').update(input.body).digest(),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  await ports.faviconStore.put(objectId, input.body, canonicalMime);
  let sourceRevision: bigint;
  try {
    await ports.bookmarkIcons.upsert(row);
    const written = await ports.sources.update({
      nodeId: node.id,
      collectionId: node.collectionId,
      sourceMode: currentRow?.sourceMode ?? 'inherit',
      expectedRevision: currentSourceRevision,
      updatedAt: now,
    });
    if (written.kind === 'stale') {
      throw new CollectionPreconditionError({
        currentEtag: iconSourceEtag(node.resourceRevision, written.currentRevision),
        precondition: 'resource',
        message: 'The favicon source ETag does not match the current representation.',
      });
    }
    sourceRevision = written.row.revision;
  } catch (error) {
    try {
      await ports.faviconStore.delete(objectId);
    } catch {
      // Best-effort orphan cleanup must not mask the DB error.
    }
    // FO-C-02: ledger the unbound object as immediately deletable when the
    // plain delete could not run, so the GC reclaims it (F-A1 pattern).
    await recordUnboundHelperObjectIfWritten(ports, { nodeId: node.id, collectionId: node.collectionId }, objectId, now);
    throw error;
  }
  if (previous !== null) {
    // The displaced automatic-capture object is retired through the durable
    // GC retention window, never deleted immediately; public reads revoke the
    // displaced binding before serving bytes.
    try {
      await ports.gc.recordRetired({
        objectId: previous.objectId,
        nodeId: previous.nodeId,
        collectionId: previous.collectionId,
        retiredAt: now,
        deletableAt: new Date(now.getTime() + faviconRetentionSeconds() * 1_000),
      });
    } catch (error) {
      // FO-C-02: retirement failed; the helper binding may have rolled back
      // with the outer unit of work — ledger the new object either way.
      await recordUnboundHelperObjectIfWritten(ports, { nodeId: node.id, collectionId: node.collectionId }, objectId, now);
      throw error;
    }
  }

  const view = toBookmarkNodeView(node, iconUrl);
  // The composite source ETag is snapshotted once at write time and stored in
  // the receipt, so an exact replay returns the original validators verbatim
  // instead of recomputing against rows that may have moved on (lost update)
  // or been purged (missing ETag).
  const etag = iconSourceEtag(node.resourceRevision, sourceRevision);
  await ports.receipts.complete(binding, fingerprint, helperProductResult(view, etag));
  return { kind: 'created', view, etag };
}

/**
 * FO-04 helper clear: removes the automatic capture binding and re-fences the
 * source revision. Same receipt order, validators and protected-state rules as
 * capture; the node view after clearing has no icon binding.
 */
export async function clearCapturedBookmarkFavicon(
  ports: FaviconHelperCapturePorts,
  input: FaviconHelperClearInput,
): Promise<FaviconHelperCommandResult> {
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new FaviconHelperCaptureCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  const expected = parseIconSourceEtag(input.expectedSourceEtag);
  if (expected === null) {
    throw new FaviconHelperCaptureCommandError(
      'invalid_request',
      'If-Match must be a strong favicon-source entity-tag fencing the node and source revisions.',
    );
  }

  const binding = {
    principalId: input.actor.principalId,
    commandScope: bookmarkFaviconHelperClearCommandScope(input.collectionId, input.nodeId),
    commandId,
  };
  const fingerprint = canonicalCommandFingerprint({
    method: 'DELETE',
    route: bookmarkFaviconHelperRoute(input.collectionId, input.nodeId),
    mediaType: '',
    body: '',
  });
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapHelperClaim(claim);

  const { node } = await loadOwnerBookmarkNode(ports, input.actor, input.collectionId, input.nodeId);
  const currentRow = await ports.sources.findByNodeId(node.id);
  const currentSourceRevision = currentRow?.revision ?? INITIAL_FAVICON_SOURCE_REVISION;
  if (node.resourceRevision !== expected.nodeResourceRevision || currentSourceRevision !== expected.sourceRevision) {
    throw new CollectionPreconditionError({
      currentEtag: iconSourceEtag(node.resourceRevision, currentSourceRevision),
      precondition: 'resource',
      message: 'The favicon source ETag does not match the current representation.',
    });
  }
  const policyRow = await currentPolicy(ports, node, input.actor.principalId);
  if (policyRow.revision !== input.expectedPolicyRevision) {
    throw new CollectionPreconditionError({
      currentEtag: faviconPolicyEtag(policyRow.revision),
      precondition: 'resource',
      message: 'The favicon policy revision does not match the current account policy.',
    });
  }
  refuseProtectedSourceState(currentRow?.sourceMode ?? 'inherit', policyRow, node);

  const previous = await ports.bookmarkIcons.deleteByNodeId(node.id);
  const now = await ports.clock.now();
  if (previous !== null) {
    // Helper clear (auto icon off): the retired capture object enters the
    // durable GC retention window, never an immediate object delete.
    await ports.gc.recordRetired({
      objectId: previous.objectId,
      nodeId: previous.nodeId,
      collectionId: previous.collectionId,
      retiredAt: now,
      deletableAt: new Date(now.getTime() + faviconRetentionSeconds() * 1_000),
    });
  }
  const written = await ports.sources.update({
    nodeId: node.id,
    collectionId: node.collectionId,
    sourceMode: currentRow?.sourceMode ?? 'inherit',
    expectedRevision: currentSourceRevision,
    updatedAt: now,
  });
  if (written.kind === 'stale') {
    throw new CollectionPreconditionError({
      currentEtag: iconSourceEtag(node.resourceRevision, written.currentRevision),
      precondition: 'resource',
      message: 'The favicon source ETag does not match the current representation.',
    });
  }

  // Same write-time ETag snapshot as the capture path above.
  const etag = iconSourceEtag(node.resourceRevision, written.row.revision);
  const view = toBookmarkNodeView(
    node,
    await projectBookmarkIconUrl(ports.bookmarkIcons, node.id, input.productOrigin),
  );
  await ports.receipts.complete(binding, fingerprint, helperProductResult(view, etag));
  return { kind: 'created', view, etag };
}

async function currentPolicy(
  ports: Pick<FaviconHelperCapturePorts, 'policies'>,
  node: LockedNodeRow,
  accountId: string,
): Promise<FaviconPolicyRow> {
  const stored = await ports.policies.findByAccountId(accountId);
  if (stored !== null) return stored;
  return virtualFaviconPolicy(accountId, node.updatedAt);
}

/**
 * Server protection semantics for automatic capture/clear: a manual uploaded
 * icon, an explicit none, and the temporary force-online override are never
 * displaced by the helper; non-owner actors are already rejected by
 * loadOwnerBookmarkNode.
 */
/**
 * FO-C-02: F-A1-style durable ledger for a helper PUT that never became a
 * binding. Same rationale as recordUnboundUploadObjectIfWritten in
 * bookmark-favicon-command.ts: a failed object-store delete leaves a
 * permanent orphan unless the GC has a durable record; skip when the
 * object IS the live binding (a crashed run may have committed it).
 */
async function recordUnboundHelperObjectIfWritten(
  ports: FaviconHelperCapturePorts,
  node: { readonly nodeId: string; readonly collectionId: string },
  objectId: string,
  now: Date,
): Promise<void> {
  try {
    await ports.orphanLedger({
      objectId,
      nodeId: node.nodeId,
      collectionId: node.collectionId,
      at: now,
    });
  } catch {
    // This bookkeeping must never mask the original failure.
  }
}

function refuseProtectedSourceState(
  sourceMode: 'inherit' | 'online' | 'uploaded' | 'none',
  policy: FaviconPolicyRow,
  node: LockedNodeRow,
): void {
  const forceOn = policy.forceAllOnline && node.kind === 'bookmark' && (node.url ?? '').trim().length > 0;
  if (sourceMode === 'uploaded' || sourceMode === 'none' || forceOn) {
    throw new CollectionAuthorizationError({
      outcome: 'deny',
      reasonCategory: 'protected_source_state',
    });
  }
}

function toBookmarkNodeView(node: LockedNodeRow, iconUrl: string | null): BookmarkNodeView {
  if (typeof node.url !== 'string' || node.url.length < 1) {
    throw new FaviconHelperCaptureCommandError('invalid_request', 'bookmark url is required');
  }
  if (typeof node.parentId !== 'string' || typeof node.positionToken !== 'string') {
    throw new FaviconHelperCaptureCommandError('invalid_request', 'bookmark parent and position are required');
  }
  return {
    id: node.id,
    collectionId: node.collectionId,
    kind: 'bookmark',
    parentId: node.parentId,
    position: node.positionToken,
    title: node.title,
    url: node.url,
    description: node.description,
    tags: [...node.tags],
    visibility: node.visibility,
    revision: node.resourceRevision,
    etag: strongEntityTag(node.resourceRevision),
    readOnly: false,
    readOnlyReason: null,
    createdAt: formatUtcDateTime(node.createdAt),
    updatedAt: formatUtcDateTime(node.updatedAt),
    iconUrl,
  };
}

function helperProductResult(view: BookmarkNodeView, etag: string): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(view), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      // The response ETag is stored with the receipt so an exact replay
      // restores the original validators verbatim — the same snapshot the
      // Product favicon commands persist.
      'etag': etag,
    },
    mediaType: 'application/json',
    contractVersion: FAVICON_HELPER_CAPTURE_CONTRACT_VERSION,
    targetIdentity: view.id,
  };
}

function mapHelperClaim(
  claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>,
): FaviconHelperCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', result: claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

export function mapFaviconHelperCommandError(
  error: unknown,
): FaviconHelperCaptureCommandError | CollectionPreconditionError | CollectionAuthorizationError | null {
  if (error instanceof FaviconHelperCaptureCommandError) return error;
  if (error instanceof CollectionPreconditionError) return error;
  if (error instanceof CollectionAuthorizationError) return error;
  return null;
}
