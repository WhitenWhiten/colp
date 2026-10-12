/**
 * LP-05 link preview request command.
 *
 * An owner or editor explicitly asks for the previews of bookmarks they are
 * looking at (Gallery on a private collection). That consent is what lets the
 * worker fetch a private collection's pages; public and unlisted collections
 * are swept without it.
 *
 * Product command order: syntax and identity → receipt claim (replay when
 * complete) → only then the write. Readers (viewer role) are refused;
 * non-members see nothing (conceal).
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
import { CollectionAuthorizationError } from '../domain/errors.js';
import { linkPreviewTargetIdentity, type LinkPreviewTargetIdentity } from './link-preview-policy.js';

export const LINK_PREVIEW_COMMAND_CONTRACT_VERSION = '1.0.0';
export const LINK_PREVIEW_REQUEST_MAX_NODES = 100;
export type BookmarkPreviewMode = 'auto' | 'none';

const NODE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

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
}

export interface LinkPreviewCommandStore {
  /** Live bookmark nodes of the collection among `nodeIds`, with their preview mode. */
  loadBookmarks(collectionId: string, nodeIds: readonly string[]): Promise<LinkPreviewBookmarkRow[]>;
  enqueue(identities: readonly LinkPreviewTargetIdentity[]): Promise<number>;
}

export interface LinkPreviewCommandPorts {
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly previews: LinkPreviewCommandStore;
}

export interface LinkPreviewCommandUnitOfWork {
  execute<Result>(work: (ports: LinkPreviewCommandPorts) => Promise<Result>): Promise<Result>;
}

export interface LinkPreviewActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export type LinkPreviewReceiptOutcome =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };

export function linkPreviewRequestRoute(collectionId: string): string {
  return `/api/v1/collections/${collectionId}/link-preview-requests`;
}

export function parseLinkPreviewRequestBody(raw: unknown): readonly string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LinkPreviewCommandError('invalid_document', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'nodeIds') {
    throw new LinkPreviewCommandError('invalid_document', 'The request body must contain exactly nodeIds.');
  }
  const { nodeIds } = body;
  if (!Array.isArray(nodeIds) || nodeIds.length < 1 || nodeIds.length > LINK_PREVIEW_REQUEST_MAX_NODES
    || !nodeIds.every((id) => typeof id === 'string' && NODE_ID.test(id))
    || new Set(nodeIds).size !== nodeIds.length) {
    throw new LinkPreviewCommandError(
      'invalid_document', `nodeIds must hold 1 to ${LINK_PREVIEW_REQUEST_MAX_NODES} distinct node ids.`,
    );
  }
  return nodeIds as string[];
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

function jsonResult(status: number, value: unknown): ProductCommandResult {
  return {
    status,
    body: Buffer.from(JSON.stringify(value), 'utf8'),
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' },
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
