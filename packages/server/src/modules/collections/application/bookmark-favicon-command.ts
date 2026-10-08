import { createHash, randomUUID } from 'node:crypto';
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
} from '../../access-policy/index.js';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  BookmarkFaviconValidationError,
  CollectionAuthorizationError,
  formatUtcDateTime,
  strongEntityTag,
} from '../domain/index.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  sniffBookmarkFaviconCanonicalMime,
  type BookmarkFaviconObjectStore,
} from './favicon-store.js';
import type { BookmarkNodeView } from './get-editor-page.js';
import {
  bookmarkIconUrlFromObjectId,
  projectBookmarkIconUrl,
} from './bookmark-icon-url.js';
import type { BookmarkIconRow, BookmarkIconWritePort, CollectionWritePort, CollectionsClock, LockedNodeRow, NodeWritePort } from './ports.js';
import type { FaviconGcWritePort } from './favicon-job.js';
import { faviconRetentionSeconds } from './favicon-job-execution.js';
import type { BookmarkIconSourceWritePort } from './favicon-icon-source.js';

export const BOOKMARK_FAVICON_COMMAND_CONTRACT_VERSION = '1.0.0';

export class BookmarkFaviconCommandError extends Error {
  readonly code: 'invalid_request' | 'payload_too_large';

  constructor(code: 'invalid_request' | 'payload_too_large', message: string) {
    super(message);
    this.name = 'BookmarkFaviconCommandError';
    this.code = code;
  }
}

export function bookmarkFaviconUploadCommandScope(collectionId: string, nodeId: string): string {
  return `collection:${collectionId}:node:${nodeId}:favicon:upload`;
}

export function bookmarkFaviconDeleteCommandScope(collectionId: string, nodeId: string): string {
  return `collection:${collectionId}:node:${nodeId}:favicon:delete`;
}

/** Canonical Product route used in receipts even when the HTTP call is the helper. */
export function bookmarkFaviconProductRoute(collectionId: string, nodeId: string): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon`;
}

/** SHA-256 hex of the upload body. Never `body.toString('hex')`. */
export function bookmarkFaviconBodyFingerprint(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface BookmarkFaviconCommandPorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly clock: CollectionsClock;
  readonly collections: Pick<CollectionWritePort, 'lockForUpdate'>;
  readonly nodes: Pick<NodeWritePort, 'getNode'>;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly bookmarkIcons: BookmarkIconWritePort;
  readonly faviconStore: BookmarkFaviconObjectStore;
  /** Durable retirement of the displaced object (retention window). */
  readonly faviconGc: Pick<FaviconGcWritePort, 'recordRetired'>;
  /** FO-01 source state; the real upload/delete persist uploaded/none here. */
  readonly faviconSources?: Pick<BookmarkIconSourceWritePort, 'setMode'>;
  readonly onOrphanCleanupFailure?: () => void;
  /**
   * FO-C-02: retire an object that never became a binding, in an INDEPENDENT
   * transaction. The command transaction is aborted/rolled back by the time
   * this runs (a SQL failure already occurred inside it), so reusing the
   * command-bound ports would be a no-op at best — the runner must open its
   * own transaction (F-A1 pattern, cf. the batch executor's verify runner).
   * Best-effort contract: the caller swallows failures.
   */
  readonly orphanLedger: (input: {
    readonly objectId: string;
    readonly nodeId: string;
    readonly collectionId: string;
    readonly at: Date;
  }) => Promise<void>;
}

export interface BookmarkFaviconCommandActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export interface UploadBookmarkFaviconInput {
  readonly actor: BookmarkFaviconCommandActor;
  readonly commandId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly productOrigin: string;
  readonly ownerOnly?: boolean;
}

export interface DeleteBookmarkFaviconInput {
  readonly actor: BookmarkFaviconCommandActor;
  readonly commandId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly productOrigin: string;
  readonly ownerOnly?: boolean;
}

export type BookmarkFaviconCommandResult =
  | { readonly kind: 'created'; readonly view: BookmarkNodeView }
  | { readonly kind: 'replay'; readonly result: ProductCommandResult }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export async function uploadBookmarkFavicon(
  ports: BookmarkFaviconCommandPorts,
  input: UploadBookmarkFaviconInput,
): Promise<BookmarkFaviconCommandResult> {
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new BookmarkFaviconCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  if (input.body.byteLength > BOOKMARK_FAVICON_MAX_BYTES) {
    throw new BookmarkFaviconCommandError(
      'payload_too_large',
      `favicon image must be at most ${BOOKMARK_FAVICON_MAX_BYTES} bytes`,
    );
  }
  const canonicalMime = sniffBookmarkFaviconCanonicalMime(input.body);
  if (!canonicalMime) {
    throw new BookmarkFaviconCommandError(
      'invalid_request',
      'favicon body is empty or is not a supported raster type',
    );
  }

  const binding: ProductCommandBinding = {
    principalId: input.actor.principalId,
    commandScope: bookmarkFaviconUploadCommandScope(input.collectionId, input.nodeId),
    commandId,
  };
  const fingerprint = canonicalCommandFingerprint({
    method: 'POST',
    route: bookmarkFaviconProductRoute(input.collectionId, input.nodeId),
    mediaType: input.contentType,
    body: bookmarkFaviconBodyFingerprint(input.body),
  });
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const node = await lockAuthorizeAndLoadNode(ports, input);
  const previous = await ports.bookmarkIcons.findByNodeId(node.id);
  const now = await ports.clock.now();
  const objectId = randomUUID();
  const iconUrl = bookmarkIconUrlFromObjectId(input.productOrigin, objectId);
  const digestSha256 = createHash('sha256').update(input.body).digest();
  const row: BookmarkIconRow = {
    nodeId: node.id,
    collectionId: node.collectionId,
    objectId,
    contentType: canonicalMime,
    byteSize: input.body.byteLength,
    digestSha256,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  await ports.faviconStore.put(objectId, input.body, canonicalMime);
  try {
    await ports.bookmarkIcons.upsert(row);
    await ports.faviconSources?.setMode({
      nodeId: node.id,
      collectionId: node.collectionId,
      sourceMode: 'uploaded',
      updatedAt: now,
    });
  } catch (error) {
    try {
      await ports.faviconStore.delete(objectId);
    } catch {
      // Best-effort orphan cleanup must not mask the DB error.
    }
    // FO-C-02: if the delete failed the object would stay unbound with no
    // durable record. Ledger it as immediately deletable (F-A1 pattern) so
    // the GC reclaims it; the binding was never committed in this branch.
    await recordUnboundUploadObjectIfWritten(ports, { nodeId: node.id, collectionId: node.collectionId }, objectId, now);
    throw error;
  }
  if (previous !== null) {
    // The replaced upload leaves the live binding; retire it through the
    // durable GC retention window (the object was served with a 1-year
    // immutable cache promise) instead of deleting it immediately.
    try {
      await ports.faviconGc.recordRetired({
        objectId: previous.objectId,
        nodeId: previous.nodeId,
        collectionId: previous.collectionId,
        retiredAt: now,
        deletableAt: new Date(now.getTime() + faviconRetentionSeconds() * 1_000),
      });
    } catch (error) {
      // FO-C-02: the retirement failed. The upload binding may have rolled
      // back with the outer unit of work — ledger the new object as unbound
      // (skipped when the binding did land) so it is reclaimed either way.
      await recordUnboundUploadObjectIfWritten(ports, { nodeId: node.id, collectionId: node.collectionId }, objectId, now);
      throw error;
    }
  }

  const view = toBookmarkNodeView(node, iconUrl);
  await ports.receipts.complete(binding, fingerprint, productResult(view));
  return { kind: 'created', view };
}

export async function deleteBookmarkFavicon(
  ports: BookmarkFaviconCommandPorts,
  input: DeleteBookmarkFaviconInput,
): Promise<BookmarkFaviconCommandResult> {
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new BookmarkFaviconCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  const binding: ProductCommandBinding = {
    principalId: input.actor.principalId,
    commandScope: bookmarkFaviconDeleteCommandScope(input.collectionId, input.nodeId),
    commandId,
  };
  const fingerprint = canonicalCommandFingerprint({
    method: 'DELETE',
    route: bookmarkFaviconProductRoute(input.collectionId, input.nodeId),
    mediaType: '',
    body: '',
  });
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const node = await lockAuthorizeAndLoadNode(ports, input);
  const previous = await ports.bookmarkIcons.deleteByNodeId(node.id);
  const now = await ports.clock.now();
  if (previous !== null) {
    // DELETE → none is explicit intent, but the retired object still enters
    // the durable GC retention window (never an immediate object delete).
    await ports.faviconGc.recordRetired({
      objectId: previous.objectId,
      nodeId: previous.nodeId,
      collectionId: previous.collectionId,
      retiredAt: now,
      deletableAt: new Date(now.getTime() + faviconRetentionSeconds() * 1_000),
    });
  }
  await ports.faviconSources?.setMode({
    nodeId: node.id,
    collectionId: node.collectionId,
    sourceMode: 'none',
    updatedAt: now,
  });

  const view = toBookmarkNodeView(
    node,
    await projectBookmarkIconUrl(ports.bookmarkIcons, node.id, input.productOrigin),
  );
  await ports.receipts.complete(binding, fingerprint, productResult(view));
  return { kind: 'created', view };
}

async function lockAuthorizeAndLoadNode(
  ports: BookmarkFaviconCommandPorts,
  input: {
    readonly actor: BookmarkFaviconCommandActor;
    readonly collectionId: string;
    readonly nodeId: string;
    readonly ownerOnly?: boolean;
  },
): Promise<LockedNodeRow> {
  const locked = await ports.collections.lockForUpdate(input.collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  const actor = {
    principalId: input.actor.principalId,
    subjectId: input.actor.subjectId,
    kind: 'account' as const,
  };
  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId: input.collectionId,
    actor,
    capability: 'update_node',
  });
  if (decision.outcome !== 'allow') {
    throw new CollectionAuthorizationError({
      outcome: decision.outcome,
      reasonCategory: decision.reasonCategory,
    });
  }
  if (input.ownerOnly === true && decision.effectiveRole !== 'owner') {
    throw new CollectionAuthorizationError({
      outcome: 'deny',
      reasonCategory: 'insufficient_role',
    });
  }
  if (locked.deletedAt !== null) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  const node = await ports.nodes.getNode(input.collectionId, input.nodeId);
  if (!node || node.deletedAt !== null) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }
  if (node.kind !== 'bookmark') {
    throw new BookmarkFaviconCommandError(
      'invalid_request',
      'favicon uploads are only allowed on bookmark nodes',
    );
  }
  if (node.collectionId !== input.collectionId) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }
  return node;
}

/**
 * FO-C-02: F-A1-style durable ledger for a PUT that never became a binding.
 * The object was persisted but the DB write failed (or the outer unit of
 * work rolled back); a plain object-store delete is best-effort and can
 * fail, leaving a permanent orphan. Record the object as immediately
 * deletable so the GC reclaims it — unless it IS the live binding (a
 * crashed run may have committed it before the failure surfaced).
 */
async function recordUnboundUploadObjectIfWritten(
  ports: BookmarkFaviconCommandPorts,
  node: { readonly nodeId: string; readonly collectionId: string },
  objectId: string,
  now: Date,
): Promise<void> {
  try {
    // The runner opens its own transaction: the command transaction is
    // already aborted on every path that reaches this helper, so the GC
    // ledger write cannot ride the command-bound ports.
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

function mapClaim(
  claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>,
): BookmarkFaviconCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', result: claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

function toBookmarkNodeView(node: LockedNodeRow, iconUrl: string | null): BookmarkNodeView {
  if (typeof node.url !== 'string' || node.url.length < 1) {
    throw new BookmarkFaviconCommandError('invalid_request', 'bookmark url is required');
  }
  if (typeof node.parentId !== 'string' || typeof node.positionToken !== 'string') {
    throw new BookmarkFaviconCommandError('invalid_request', 'bookmark parent and position are required');
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

function productResult(view: BookmarkNodeView): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(view), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: BOOKMARK_FAVICON_COMMAND_CONTRACT_VERSION,
    targetIdentity: view.id,
  };
}

export function mapBookmarkFaviconCommandError(
  error: unknown,
): BookmarkFaviconCommandError | CollectionAuthorizationError | BookmarkFaviconValidationError | null {
  if (error instanceof BookmarkFaviconCommandError) return error;
  if (error instanceof CollectionAuthorizationError) return error;
  if (error instanceof BookmarkFaviconValidationError) return error;
  return null;
}
