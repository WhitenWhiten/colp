/**
 * LP-05 link preview commands.
 *
 * - requestCollectionLinkPreviews: an owner/editor explicitly asks for the
 *   previews of bookmarks they are looking at (Gallery on a private
 *   collection). This consent is what lets the worker fetch private URLs.
 * - get/setBookmarkPreviewMode: the owner veto per bookmark (auto / none).
 *
 * Both writes follow the Product command order: syntax and identity →
 * receipt claim (replay when complete) → only then If-Match and the write.
 * Readers (viewer role) are refused; non-members see nothing (conceal).
 */
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import type { AccessPolicyFactsPort } from '../../access-policy/index.js';
import { CollectionAuthorizationError, CollectionPreconditionError } from '../domain/errors.js';
import { attachBookmarkPreviewImages, type BookmarkPreviewImageView, type LinkPreviewReadPort } from './link-preview-read.js';
import { linkPreviewTargetIdentity, type LinkPreviewTargetIdentity } from './link-preview-policy.js';

export const LINK_PREVIEW_COMMAND_CONTRACT_VERSION = '1.0.0';
export const LINK_PREVIEW_REQUEST_MAX_NODES = 100;
export type BookmarkPreviewMode = 'auto' | 'none';

const NODE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const MODE_ETAG = /^"preview-mode:([1-9][0-9]{0,18})"$/u;

export class LinkPreviewCommandError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_document', message: string) {
    super(message);
    this.name = 'LinkPreviewCommandError';
  }
}

export interface LinkPreviewBookmarkRow {
  readonly nodeId: string;
  readonly url: string;
  readonly mode: BookmarkPreviewMode;
  /** Pref revision; 1 when no row exists yet. */
  readonly revision: bigint;
}

export interface LinkPreviewCommandStore {
  /** Live bookmark nodes of the collection among `nodeIds`, with their preview mode. */
  loadBookmarks(collectionId: string, nodeIds: readonly string[]): Promise<LinkPreviewBookmarkRow[]>;
  enqueue(identities: readonly LinkPreviewTargetIdentity[]): Promise<number>;
  /** CAS on the pref revision; the first write creates the row at revision 2. */
  writeMode(input: {
    readonly collectionId: string;
    readonly nodeId: string;
    readonly mode: BookmarkPreviewMode;
    readonly expectedRevision: bigint;
  }): Promise<{ readonly kind: 'written'; readonly revision: bigint } | { readonly kind: 'stale'; readonly currentRevision: bigint }>;
}

export interface LinkPreviewCommandPorts {
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly previews: LinkPreviewCommandStore;
  readonly reads: LinkPreviewReadPort;
  readonly productOrigin?: string;
}

export interface LinkPreviewCommandUnitOfWork {
  execute<Result>(work: (ports: LinkPreviewCommandPorts) => Promise<Result>): Promise<Result>;
}

export interface LinkPreviewActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export interface BookmarkPreviewModeView {
  readonly nodeId: string;
  readonly mode: BookmarkPreviewMode;
  /** What the bookmark shows now; null when hidden or not fetched yet. */
  readonly previewImage: BookmarkPreviewImageView | null;
  readonly etag: string;
}

export type LinkPreviewReceiptOutcome =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };

export function bookmarkPreviewModeEtag(revision: bigint): string {
  return `"preview-mode:${revision.toString()}"`;
}

export function linkPreviewRequestRoute(collectionId: string): string {
  return `/api/v1/collections/${collectionId}/link-preview-requests`;
}

export function bookmarkPreviewModeRoute(collectionId: string, nodeId: string): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/preview-image-mode`;
}

function closedBody(raw: unknown, key: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LinkPreviewCommandError('invalid_document', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== key) {
    throw new LinkPreviewCommandError('invalid_document', `The request body must contain exactly ${key}.`);
  }
  return body;
}

export function parseLinkPreviewRequestBody(raw: unknown): readonly string[] {
  const { nodeIds } = closedBody(raw, 'nodeIds');
  if (!Array.isArray(nodeIds) || nodeIds.length < 1 || nodeIds.length > LINK_PREVIEW_REQUEST_MAX_NODES
    || !nodeIds.every((id) => typeof id === 'string' && NODE_ID.test(id))
    || new Set(nodeIds).size !== nodeIds.length) {
    throw new LinkPreviewCommandError(
      'invalid_document', `nodeIds must hold 1 to ${LINK_PREVIEW_REQUEST_MAX_NODES} distinct node ids.`,
    );
  }
  return nodeIds as string[];
}

export function parseBookmarkPreviewModeBody(raw: unknown): BookmarkPreviewMode {
  const { mode } = closedBody(raw, 'mode');
  if (mode !== 'auto' && mode !== 'none') {
    throw new LinkPreviewCommandError('invalid_document', 'mode must be auto or none.');
  }
  return mode;
}

async function authorizeEditor(ports: LinkPreviewCommandPorts, actor: LinkPreviewActor, collectionId: string): Promise<void> {
  const facts = await ports.accessPolicy.loadCollectionFacts({ collectionId, actorSubjectId: actor.subjectId });
  const owner = facts !== null && facts.ownerSubjectId === actor.subjectId;
  const role = facts?.membershipRole ?? null;
  if (facts === null || facts.deleted || (!owner && role === null)) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  if (!owner && role !== 'owner' && role !== 'editor') {
    throw new CollectionAuthorizationError({ outcome: 'deny', reasonCategory: 'insufficient_role' });
  }
}

function commandId(raw: string): string {
  try {
    return assertCanonicalCommandId(raw);
  } catch {
    throw new LinkPreviewCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
}

function mapClaim(claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>): LinkPreviewReceiptOutcome {
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
  if (claim.kind === 'expired') return { kind: 'expired' };
  return { kind: 'reused' };
}

function jsonResult(status: number, value: unknown, headers: Record<string, string> = {}): ProductCommandResult {
  return {
    status,
    body: Buffer.from(JSON.stringify(value), 'utf8'),
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json', ...headers },
    mediaType: 'application/json',
    contractVersion: LINK_PREVIEW_COMMAND_CONTRACT_VERSION,
  };
}

export async function requestCollectionLinkPreviews(
  ports: LinkPreviewCommandPorts,
  input: {
    readonly actor: LinkPreviewActor;
    readonly commandId: string;
    readonly collectionId: string;
    readonly nodeIds: readonly string[];
  },
): Promise<{ readonly kind: 'succeeded'; readonly enqueued: number } | LinkPreviewReceiptOutcome> {
  const id = commandId(input.commandId);
  await authorizeEditor(ports, input.actor, input.collectionId);
  const fingerprint = canonicalCommandFingerprint({
    method: 'POST',
    route: linkPreviewRequestRoute(input.collectionId),
    mediaType: 'application/json',
    body: JSON.parse(canonicalJson({ nodeIds: [...input.nodeIds].sort() })) as unknown,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: `collection:${input.collectionId}:link-previews:request`,
    commandId: id,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  // Unknown, foreign, folder and vetoed ids are skipped silently: the caller
  // learns nothing it could not already read.
  const rows = await ports.previews.loadBookmarks(input.collectionId, input.nodeIds);
  const identities = rows
    .filter((row) => row.mode === 'auto')
    .map((row) => linkPreviewTargetIdentity(row.url))
    .filter((identity): identity is LinkPreviewTargetIdentity => identity !== null);
  const enqueued = await ports.previews.enqueue(identities);
  await ports.receipts.complete(binding, fingerprint, jsonResult(202, { enqueued }));
  return { kind: 'succeeded', enqueued };
}

async function loadBookmark(
  ports: LinkPreviewCommandPorts,
  actor: LinkPreviewActor,
  collectionId: string,
  nodeId: string,
): Promise<LinkPreviewBookmarkRow> {
  await authorizeEditor(ports, actor, collectionId);
  const [row] = await ports.previews.loadBookmarks(collectionId, [nodeId]);
  if (row === undefined) throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  return row;
}

async function modeView(ports: LinkPreviewCommandPorts, row: LinkPreviewBookmarkRow): Promise<BookmarkPreviewModeView> {
  const [node] = await attachBookmarkPreviewImages(ports.reads, ports.productOrigin, [
    { id: row.nodeId, kind: 'bookmark', url: row.mode === 'none' ? null : row.url },
  ]);
  const previewImage = (node as { previewImage?: BookmarkPreviewImageView | null } | undefined)?.previewImage ?? null;
  return { nodeId: row.nodeId, mode: row.mode, previewImage, etag: bookmarkPreviewModeEtag(row.revision) };
}

export async function getBookmarkPreviewMode(
  ports: LinkPreviewCommandPorts,
  input: { readonly actor: LinkPreviewActor; readonly collectionId: string; readonly nodeId: string },
): Promise<BookmarkPreviewModeView> {
  return modeView(ports, await loadBookmark(ports, input.actor, input.collectionId, input.nodeId));
}

export async function setBookmarkPreviewMode(
  ports: LinkPreviewCommandPorts,
  input: {
    readonly actor: LinkPreviewActor;
    readonly commandId: string;
    readonly collectionId: string;
    readonly nodeId: string;
    readonly mode: BookmarkPreviewMode;
    readonly expectedEtag: string;
  },
): Promise<{ readonly kind: 'succeeded'; readonly view: BookmarkPreviewModeView } | LinkPreviewReceiptOutcome> {
  const id = commandId(input.commandId);
  const expected = MODE_ETAG.exec(input.expectedEtag);
  if (expected === null) {
    throw new LinkPreviewCommandError('invalid_request', 'If-Match must be a preview-mode entity-tag.');
  }
  const row = await loadBookmark(ports, input.actor, input.collectionId, input.nodeId);
  const fingerprint = canonicalCommandFingerprint({
    method: 'PUT',
    route: bookmarkPreviewModeRoute(input.collectionId, input.nodeId),
    mediaType: 'application/json',
    body: JSON.parse(canonicalJson({ mode: input.mode })) as unknown,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: `collection:${input.collectionId}:node:${input.nodeId}:preview-mode`,
    commandId: id,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const precondition = (current: bigint) => new CollectionPreconditionError({
    currentEtag: bookmarkPreviewModeEtag(current),
    precondition: 'resource',
    message: 'The preview mode ETag does not match the current representation.',
  });
  if (BigInt(expected[1]!) !== row.revision) throw precondition(row.revision);
  let current = row;
  if (row.mode !== input.mode) {
    const written = await ports.previews.writeMode({
      collectionId: input.collectionId, nodeId: input.nodeId, mode: input.mode, expectedRevision: row.revision,
    });
    if (written.kind === 'stale') throw precondition(written.currentRevision);
    current = { ...row, mode: input.mode, revision: written.revision };
  }
  const view = await modeView(ports, current);
  await ports.receipts.complete(binding, fingerprint, jsonResult(200, view, { etag: view.etag }));
  return { kind: 'succeeded', view };
}
