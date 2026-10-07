import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import type { AccessPolicyFactsPort } from '../../access-policy/index.js';
import { normalizeBookmarkUrl } from './link-health-url.js';
import {
  freezeReadableReplicaEtag,
  projectReadableReplicaView,
  ReadableReplicaNotFoundError,
  type ReadableReplicaRow,
  type ReadableReplicaView,
} from './get-node-readable-replica.js';

export const READABLE_REPLICA_EXTRACT_CONTRACT_VERSION = '1.0.0';

export class ReadableReplicaExtractError extends Error {
  readonly code: 'invalid_request' | 'invalid_document';

  constructor(code: 'invalid_request' | 'invalid_document', message: string) {
    super(message);
    this.name = 'ReadableReplicaExtractError';
    this.code = code;
  }
}

export class ReadableReplicaCooldownError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Readable replica extract is cooling down.');
    this.name = 'ReadableReplicaCooldownError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function readableReplicaExtractCommandScope(collectionId: string, nodeId: string): string {
  return `collection:${collectionId}:node:${nodeId}:readable:enqueue`;
}

export function readableReplicaExtractRoute(collectionId: string, nodeId: string): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/readable`;
}

export function readableReplicaExtractFingerprint(input: {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly force: boolean;
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: readableReplicaExtractRoute(input.collectionId, input.nodeId),
    mediaType: 'application/json',
    body: JSON.parse(canonicalJson(input.force === true ? { force: true } : {})) as unknown,
  });
}

export function parseReadableReplicaExtractRequest(raw: unknown): { readonly force: boolean } {
  if (raw === undefined || raw === null) return { force: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReadableReplicaExtractError('invalid_document', 'The readable replica extract body is invalid.');
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== 'force') {
      throw new ReadableReplicaExtractError('invalid_document', 'The readable replica extract body is invalid.');
    }
  }
  if (Object.hasOwn(body, 'force') && typeof body.force !== 'boolean') {
    throw new ReadableReplicaExtractError('invalid_document', 'The readable replica extract body is invalid.');
  }
  return { force: body.force === true };
}

export type ReadableReplicaEnqueueState = {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly bookmarkUrl: string;
  readonly replica: ReadableReplicaRow | null;
  readonly enqueuedAt: Date | null;
};

export interface ReadableReplicaEnqueuePort {
  loadEnqueueState(input: {
    readonly collectionId: string;
    readonly nodeId: string;
  }): Promise<ReadableReplicaEnqueueState | null>;
  savePending(input: {
    readonly nodeId: string;
    readonly collectionId: string;
    readonly sourceUrl: string;
    readonly etag: string;
    readonly commandId: string;
    readonly enqueuedAt: Date;
  }): Promise<ReadableReplicaRow>;
}

export interface ReadableReplicaEnqueuePorts {
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly replicas: ReadableReplicaEnqueuePort;
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly clock: { now(): Promise<Date> };
}

export interface ReadableReplicaEnqueueUnitOfWork {
  execute<Result>(
    work: (ports: ReadableReplicaEnqueuePorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export interface EnqueueNodeReadableExtractInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly force: boolean;
  readonly cooldownMs: number;
}

export type EnqueueNodeReadableExtractResult =
  | { readonly kind: 'succeeded'; readonly view: ReadableReplicaView }
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

export async function enqueueNodeReadableExtract(
  ports: ReadableReplicaEnqueuePorts,
  input: EnqueueNodeReadableExtractInput,
): Promise<EnqueueNodeReadableExtractResult> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new ReadableReplicaExtractError('invalid_request', 'The readable replica extract actor is invalid.');
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new ReadableReplicaExtractError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  if (!Number.isInteger(input.cooldownMs) || input.cooldownMs < 1) {
    throw new ReadableReplicaExtractError('invalid_request', 'Readable replica cooldown is invalid.');
  }

  const facts = await ports.accessPolicy.loadCollectionFacts({
    collectionId: input.collectionId,
    actorSubjectId: input.actor.subjectId,
  });
  if (!facts || facts.deleted) throw new ReadableReplicaNotFoundError();
  if (facts.ownerSubjectId !== input.actor.subjectId && facts.membershipRole === null) {
    throw new ReadableReplicaNotFoundError();
  }

  const loaded = await ports.replicas.loadEnqueueState({
    collectionId: input.collectionId,
    nodeId: input.nodeId,
  });
  if (!loaded) throw new ReadableReplicaNotFoundError();

  const now = await ports.clock.now();
  const force = input.force === true;
  const fingerprint = readableReplicaExtractFingerprint({
    collectionId: input.collectionId,
    nodeId: input.nodeId,
    force,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: readableReplicaExtractCommandScope(input.collectionId, input.nodeId),
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const decision = decideEnqueue(loaded, force, input.cooldownMs, now);
  if (decision.action === 'cooldown') {
    throw new ReadableReplicaCooldownError(decision.retryAfterSeconds);
  }

  let view: ReadableReplicaView;
  if (decision.action === 'return_current') {
    view = projectReadableReplicaView({
      nodeId: loaded.nodeId,
      collectionId: loaded.collectionId,
      bookmarkUrl: loaded.bookmarkUrl,
      replica: loaded.replica,
    });
  } else {
    const sourceUrl = normalizeBookmarkUrl(loaded.bookmarkUrl) ?? loaded.bookmarkUrl;
    const pendingRow: ReadableReplicaRow = {
      status: 'pending',
      sourceUrl,
      title: null,
      byline: null,
      wordCount: 0,
      extractedAt: null,
      failureCode: null,
      sections: [],
      etag: freezeReadableReplicaEtag({
        nodeId: loaded.nodeId,
        status: 'pending',
        sourceUrl,
        extractedAt: null,
        sections: [],
      }),
    };
    const saved = await ports.replicas.savePending({
      nodeId: loaded.nodeId,
      collectionId: loaded.collectionId,
      sourceUrl: pendingRow.sourceUrl,
      etag: pendingRow.etag,
      commandId,
      enqueuedAt: now,
    });
    view = projectReadableReplicaView({
      nodeId: loaded.nodeId,
      collectionId: loaded.collectionId,
      bookmarkUrl: loaded.bookmarkUrl,
      replica: saved,
    });
  }

  await ports.receipts.complete(binding, fingerprint, productResult(view));
  return { kind: 'succeeded', view };
}

function decideEnqueue(
  loaded: ReadableReplicaEnqueueState,
  force: boolean,
  cooldownMs: number,
  now: Date,
):
  | { readonly action: 'enqueue' }
  | { readonly action: 'return_current' }
  | { readonly action: 'cooldown'; readonly retryAfterSeconds: number } {
  const replica = loaded.replica;
  if (replica === null) return { action: 'enqueue' };
  if (replica.status === 'pending' && !force) return { action: 'return_current' };
  if (
    replica.status === 'ready'
    && !force
    && sameNormalizedUrl(replica.sourceUrl, loaded.bookmarkUrl)
  ) {
    return { action: 'return_current' };
  }
  if (withinCooldown(loaded.enqueuedAt, cooldownMs, now)) {
    return {
      action: 'cooldown',
      retryAfterSeconds: retryAfterSeconds(loaded.enqueuedAt!, cooldownMs, now),
    };
  }
  return { action: 'enqueue' };
}

function sameNormalizedUrl(left: string, right: string): boolean {
  return normalizeBookmarkUrl(left) === normalizeBookmarkUrl(right);
}

function withinCooldown(enqueuedAt: Date | null, cooldownMs: number, now: Date): boolean {
  if (enqueuedAt === null) return false;
  return now.getTime() < enqueuedAt.getTime() + cooldownMs;
}

function retryAfterSeconds(enqueuedAt: Date, cooldownMs: number, now: Date): number {
  return Math.max(1, Math.ceil((enqueuedAt.getTime() + cooldownMs - now.getTime()) / 1000));
}

function productResult(view: ReadableReplicaView): ProductCommandResult {
  const body = JSON.stringify(view);
  const stableHeaders: Record<string, string> = {
    'cache-control': 'private, no-store',
    'content-type': 'application/json',
  };
  if (view.etag !== null) stableHeaders.etag = view.etag;
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders,
    mediaType: 'application/json',
    contractVersion: READABLE_REPLICA_EXTRACT_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): EnqueueNodeReadableExtractResult {
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
