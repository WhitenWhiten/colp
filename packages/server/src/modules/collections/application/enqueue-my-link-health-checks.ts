import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';

export const LINK_HEALTH_CHECKS_COMMAND_SCOPE = 'collections:link-health-checks:v1';
export const LINK_HEALTH_CHECKS_CONTRACT_VERSION = '1.0.0';
export const LINK_HEALTH_CHECKS_ROUTE = '/api/v1/me/link-health/checks';
export const LINK_HEALTH_CHECKS_MAX_NODE_IDS = 100;

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export class LinkHealthChecksError extends Error {
  readonly code: 'invalid_request' | 'invalid_document';

  constructor(code: 'invalid_request' | 'invalid_document', message: string) {
    super(message);
    this.name = 'LinkHealthChecksError';
    this.code = code;
  }
}

export interface LinkHealthChecksFilter {
  readonly nodeIds?: readonly string[];
  readonly collectionId?: string;
}

export interface LinkHealthChecksWritePort {
  markOwnedPending(input: {
    readonly ownerSubjectId: string;
    readonly nodeIds?: readonly string[];
    readonly collectionId?: string;
  }): Promise<number>;
}

export interface EnqueueMyLinkHealthChecksPorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly checks: LinkHealthChecksWritePort;
}

export interface EnqueueMyLinkHealthChecksInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly filter: LinkHealthChecksFilter;
}

export type EnqueueMyLinkHealthChecksResult =
  | { readonly kind: 'succeeded'; readonly queued: number }
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

export function parseLinkHealthChecksFilter(raw: unknown): LinkHealthChecksFilter {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LinkHealthChecksError('invalid_document', 'The link-health checks body is invalid.');
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  for (const key of keys) {
    if (key !== 'nodeIds' && key !== 'collectionId') {
      throw new LinkHealthChecksError('invalid_document', 'The link-health checks body is invalid.');
    }
  }
  const filter: { nodeIds?: string[]; collectionId?: string } = {};
  if (Object.hasOwn(body, 'nodeIds')) {
    if (!Array.isArray(body.nodeIds) || body.nodeIds.length > LINK_HEALTH_CHECKS_MAX_NODE_IDS) {
      throw new LinkHealthChecksError('invalid_document', 'The link-health checks body is invalid.');
    }
    const seen = new Set<string>();
    const nodeIds: string[] = [];
    for (const id of body.nodeIds) {
      if (typeof id !== 'string' || !OPAQUE_ID.test(id) || seen.has(id)) {
        throw new LinkHealthChecksError('invalid_document', 'The link-health checks body is invalid.');
      }
      seen.add(id);
      nodeIds.push(id);
    }
    filter.nodeIds = nodeIds;
  }
  if (Object.hasOwn(body, 'collectionId')) {
    if (typeof body.collectionId !== 'string' || !OPAQUE_ID.test(body.collectionId)) {
      throw new LinkHealthChecksError('invalid_document', 'The link-health checks body is invalid.');
    }
    filter.collectionId = body.collectionId;
  }
  return filter;
}

export function linkHealthChecksFingerprint(filter: LinkHealthChecksFilter): string {
  const body: Record<string, unknown> = {};
  if (filter.collectionId !== undefined) body.collectionId = filter.collectionId;
  if (filter.nodeIds !== undefined) body.nodeIds = [...filter.nodeIds].sort();
  return canonicalCommandFingerprint({
    method: 'POST',
    route: LINK_HEALTH_CHECKS_ROUTE,
    mediaType: 'application/json',
    body: JSON.parse(canonicalJson(body)) as unknown,
  });
}

export async function enqueueMyLinkHealthChecks(
  ports: EnqueueMyLinkHealthChecksPorts,
  input: EnqueueMyLinkHealthChecksInput,
): Promise<EnqueueMyLinkHealthChecksResult> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new LinkHealthChecksError('invalid_request', 'The link-health checks actor is invalid.');
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new LinkHealthChecksError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  const filter = input.filter ?? {};
  const fingerprint = linkHealthChecksFingerprint(filter);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: LINK_HEALTH_CHECKS_COMMAND_SCOPE,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const queued = await ports.checks.markOwnedPending({
    ownerSubjectId: input.actor.subjectId,
    ...(filter.nodeIds !== undefined ? { nodeIds: filter.nodeIds } : {}),
    ...(filter.collectionId !== undefined ? { collectionId: filter.collectionId } : {}),
  });
  const receipt = { queued };
  await ports.receipts.complete(binding, fingerprint, productResult(receipt));
  return { kind: 'succeeded', queued };
}

function productResult(receipt: { readonly queued: number }): ProductCommandResult {
  const body = JSON.stringify(receipt);
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: LINK_HEALTH_CHECKS_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): EnqueueMyLinkHealthChecksResult {
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
