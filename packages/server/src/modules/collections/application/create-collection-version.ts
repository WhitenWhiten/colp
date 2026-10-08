import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  CollectionPreconditionError,
  formatUtcDateTime,
  strongEntityTag,
} from '../domain/index.js';
import { ifMatchSatisfied } from './update-collection-metadata.js';
import {
  buildCollectionTreeJson,
  captureCollectionTreeVersion,
  CollectionVersionInputError,
  CollectionVersionNotFoundError,
  diffCollectionTree,
  type CaptureCollectionTreeVersionPorts,
  type CollectionVersionChange,
  type CollectionVersionChangeCounts,
  type CollectionVersionLockedCollection,
  type CollectionVersionRecord,
} from './capture-collection-tree-version.js';

export const COLLECTION_VERSION_COMMAND_SCOPE = 'collections:versions:v1';
export const COLLECTION_VERSION_CONTRACT_VERSION = '1.0.0';
export const COLLECTION_VERSION_CREATE_COOLDOWN_MS = 10_000;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export class CollectionVersionRateLimitError extends Error {
  readonly code = 'rate_limited' as const;
  constructor(message = 'Too many collection-version create requests.') {
    super(message);
    this.name = 'CollectionVersionRateLimitError';
  }
}

export interface CollectionVersionDto {
  readonly versionId: string;
  readonly etag: string;
  readonly collectionId: string;
  readonly contentRevision: string;
  readonly kind: CollectionVersionRecord['kind'];
  readonly cause: CollectionVersionRecord['cause'];
  readonly label: string;
  readonly nodeCount: number;
  readonly createdAt: string;
  readonly changeCounts: CollectionVersionChangeCounts;
  readonly changes?: readonly CollectionVersionChange[];
  readonly truncated?: boolean;
}

export interface CollectionVersionReceiptPort {
  claim(binding: ProductCommandBinding, fingerprint: string): Promise<ProductCommandClaim>;
  complete(binding: ProductCommandBinding, fingerprint: string, result: ProductCommandResult): Promise<void>;
  lookup(
    binding: ProductCommandBinding,
    fingerprint: string,
  ): Promise<
    | { readonly kind: 'absent' }
    | Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>
  >;
}

export interface CreateCollectionVersionPorts extends CaptureCollectionTreeVersionPorts {
  readonly receipts: CollectionVersionReceiptPort;
}

export interface CreateCollectionVersionInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly collectionId: string;
  readonly ifMatch: string;
  readonly label?: string;
  readonly cause?: CollectionVersionRecord['cause'];
}

export type CreateCollectionVersionResult =
  | { readonly kind: 'succeeded'; readonly status: 200 | 201; readonly version: CollectionVersionDto }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };

export function collectionVersionListRoute(collectionId: string): string {
  return `/api/v1/collections/${collectionId}/versions`;
}

export function collectionVersionItemRoute(collectionId: string, versionId: string): string {
  return `/api/v1/collections/${collectionId}/versions/${versionId}`;
}

export function collectionVersionCreateFingerprint(input: {
  readonly collectionId: string;
  readonly ifMatch: string;
  readonly label?: string;
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: collectionVersionListRoute(input.collectionId),
    mediaType: 'application/json',
    body: input.label === undefined ? {} : { label: input.label },
    query: {},
    conditions: { ifMatch: input.ifMatch },
  });
}

export function toCollectionVersionDto(
  record: CollectionVersionRecord,
  changeCounts: CollectionVersionChangeCounts,
  extra: { readonly changes?: readonly CollectionVersionChange[]; readonly truncated?: boolean } = {},
): CollectionVersionDto {
  return {
    versionId: record.versionId,
    etag: record.etag,
    collectionId: record.collectionId,
    contentRevision: record.contentRevision,
    kind: record.kind,
    cause: record.cause,
    label: record.label,
    nodeCount: record.nodeCount,
    createdAt: formatUtcDateTime(record.createdAt),
    changeCounts,
    ...(extra.changes ? { changes: extra.changes, truncated: extra.truncated ?? false } : {}),
  };
}

export async function createCollectionVersion(
  ports: CreateCollectionVersionPorts,
  input: CreateCollectionVersionInput,
): Promise<CreateCollectionVersionResult> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new CollectionVersionInputError('The collection-version actor is invalid.');
  }
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)) {
    throw new CollectionVersionNotFoundError();
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new CollectionVersionInputError('commandId must be a canonical UUID v4.');
  }
  const fingerprint = collectionVersionCreateFingerprint({
    collectionId: input.collectionId,
    ifMatch: input.ifMatch,
    label: input.label,
  });
  const binding: ProductCommandBinding = {
    principalId: input.actor.principalId,
    commandScope: COLLECTION_VERSION_COMMAND_SCOPE,
    commandId,
  };
  const existingReceipt = await ports.receipts.lookup(binding, fingerprint);
  if (existingReceipt.kind !== 'absent') return mapClaim(existingReceipt);

  const collection = await ports.versions.lockOwnedLive(input.collectionId, input.actor.subjectId);
  if (!collection) throw new CollectionVersionNotFoundError();
  assertContentIfMatch(input.ifMatch, collection);

  const already = await ports.versions.getByCollectionAndRevision(
    input.actor.principalId,
    input.collectionId,
    collection.contentRevision,
  );
  if (already) {
    return finishCreate(ports, binding, fingerprint, already, collection, 200);
  }

  const members = await ports.versions.loadLiveMembers(input.collectionId);
  buildCollectionTreeJson(members);

  const now = await Promise.resolve(ports.clock.now());
  const cause = input.cause ?? 'web';
  const agentPlan = cause.startsWith('agent-plan:');
  if (!agentPlan) {
    const latest = await ports.versions.findLatestManualCreatedAt(
      input.actor.principalId,
      input.collectionId,
    );
    if (latest && now.getTime() - latest.getTime() < COLLECTION_VERSION_CREATE_COOLDOWN_MS) {
      throw new CollectionVersionRateLimitError();
    }
  }

  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  try {
    const captured = await captureCollectionTreeVersion(ports, {
      accountId: input.actor.principalId,
      collection,
      kind: agentPlan ? 'pre_mutation' : 'manual',
      cause,
      label: input.label,
    });
    const status = captured.kind === 'existing' ? 200 : 201;
    return finishCreate(ports, binding, fingerprint, captured.record, collection, status, true);
  } catch (error: unknown) {
    if (error instanceof CollectionVersionRateLimitError) {
      await ports.receipts.complete(binding, fingerprint, rateLimitedResult());
    }
    throw error;
  }
}

async function finishCreate(
  ports: CreateCollectionVersionPorts,
  binding: ProductCommandBinding,
  fingerprint: string,
  record: CollectionVersionRecord,
  collection: CollectionVersionLockedCollection,
  status: 200 | 201,
  claimed = false,
): Promise<CreateCollectionVersionResult> {
  const live = await ports.versions.loadLiveMembers(collection.collectionId);
  const { changeCounts } = diffCollectionTree(record.treeJson, live);
  const version = toCollectionVersionDto(record, changeCounts);
  if (!claimed) {
    const claim = await ports.receipts.claim(binding, fingerprint);
    if (claim.kind !== 'claimed') return mapClaim(claim);
  }
  await ports.receipts.complete(binding, fingerprint, productResult(version, status));
  return { kind: 'succeeded', status, version };
}

export function assertContentIfMatch(
  ifMatch: string,
  collection: { readonly contentRevision: string },
): void {
  if (ifMatchSatisfied(ifMatch, collection.contentRevision)) return;
  throw new CollectionPreconditionError({
    currentEtag: strongEntityTag(collection.contentRevision),
    precondition: 'content',
  });
}

function productResult(version: CollectionVersionDto, status: 200 | 201): ProductCommandResult {
  const body = Buffer.from(JSON.stringify(version), 'utf8');
  return {
    status,
    body,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      etag: version.etag,
      location: collectionVersionItemRoute(version.collectionId, version.versionId),
    },
    mediaType: 'application/json',
    contractVersion: COLLECTION_VERSION_CONTRACT_VERSION,
  };
}

function rateLimitedResult(): ProductCommandResult {
  const body = Buffer.from(JSON.stringify({
    error: { code: 'rate_limited', message: 'Too many collection-version create requests.' },
  }), 'utf8');
  return {
    status: 429,
    body,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: COLLECTION_VERSION_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CreateCollectionVersionResult {
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
