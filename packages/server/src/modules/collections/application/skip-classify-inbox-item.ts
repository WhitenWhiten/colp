import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import { isClassifyInboxEligible, type ClassifyInboxNodeKind } from './classify-inbox-eligibility.js';
import type { CollectionsClock } from './ports.js';

export const CLASSIFY_INBOX_SKIP_COMMAND_SCOPE = 'collections:classify-inbox-skip:v1';
export const CLASSIFY_INBOX_SKIP_CONTRACT_VERSION = '1.0.0';
export const CLASSIFY_INBOX_SKIP_ROUTE = '/api/v1/me/classify-inbox/{nodeId}/skip';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export class ClassifyInboxSkipError extends Error {
  readonly code: 'invalid_request' | 'invalid_document' | 'resource_not_found';

  constructor(code: 'invalid_request' | 'invalid_document' | 'resource_not_found', message: string) {
    super(message);
    this.name = 'ClassifyInboxSkipError';
    this.code = code;
  }
}

export type ClassifyInboxSidecarStatus = 'skipped' | 'accepted';

export interface ClassifyInboxSkipSnapshot {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly isOwner: boolean;
  readonly kind: ClassifyInboxNodeKind;
  readonly softDeleted: boolean;
  readonly url: string;
  readonly parentKind: ClassifyInboxNodeKind;
  readonly sidecarStatus: ClassifyInboxSidecarStatus | null;
}

export type ClassifyInboxSkipInsertResult = 'inserted' | 'already_skipped' | 'blocked';

export interface ClassifyInboxSkipWritePort {
  loadEligibilitySnapshot(input: {
    readonly ownerSubjectId: string;
    readonly nodeId: string;
  }): Promise<ClassifyInboxSkipSnapshot | null>;
  insertSkipped(input: {
    readonly nodeId: string;
    readonly collectionId: string;
    readonly accountSubjectId: string;
    readonly decidedAt: Date;
  }): Promise<ClassifyInboxSkipInsertResult>;
}

export interface SkipClassifyInboxItemPorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly inbox: ClassifyInboxSkipWritePort;
  readonly clock: CollectionsClock;
}

export interface SkipClassifyInboxItemInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly nodeId: string;
  readonly body: unknown;
}

export interface ClassifyInboxDecisionReceipt {
  readonly nodeId: string;
  readonly decision: 'skipped' | 'accepted';
  readonly folderId?: string;
}

export type SkipClassifyInboxItemResult =
  | { readonly kind: 'succeeded'; readonly receipt: ClassifyInboxDecisionReceipt }
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

export function parseClassifyInboxSkipBody(raw: unknown): Record<string, never> {
  if (raw === undefined || raw === null) {
    throw new ClassifyInboxSkipError('invalid_document', 'The classify-inbox skip body is invalid.');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClassifyInboxSkipError('invalid_document', 'The classify-inbox skip body is invalid.');
  }
  if (Object.keys(raw as Record<string, unknown>).length !== 0) {
    throw new ClassifyInboxSkipError('invalid_document', 'The classify-inbox skip body is invalid.');
  }
  return {};
}

export function skipClassifyInboxFingerprint(nodeId: string): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/api/v1/me/classify-inbox/${nodeId}/skip`,
    mediaType: 'application/json',
    body: JSON.parse(canonicalJson({})) as unknown,
  });
}

export async function skipClassifyInboxItem(
  ports: SkipClassifyInboxItemPorts,
  input: SkipClassifyInboxItemInput,
): Promise<SkipClassifyInboxItemResult> {
  parseClassifyInboxSkipBody(input.body);
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new ClassifyInboxSkipError('invalid_request', 'The classify-inbox skip actor is invalid.');
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new ClassifyInboxSkipError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  if (typeof input.nodeId !== 'string' || !OPAQUE_ID.test(input.nodeId)) {
    throw new ClassifyInboxSkipError('resource_not_found', 'The requested resource was not found.');
  }
  const fingerprint = skipClassifyInboxFingerprint(input.nodeId);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: CLASSIFY_INBOX_SKIP_COMMAND_SCOPE,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const snapshot = await ports.inbox.loadEligibilitySnapshot({
    ownerSubjectId: input.actor.subjectId,
    nodeId: input.nodeId,
  });
  if (snapshot === null) {
    throw new ClassifyInboxSkipError('resource_not_found', 'The requested resource was not found.');
  }
  if (snapshot.sidecarStatus === 'skipped') {
    const receipt = skippedReceipt(input.nodeId);
    await ports.receipts.complete(binding, fingerprint, productResult(receipt));
    return { kind: 'succeeded', receipt };
  }
  if (!isClassifyInboxEligible({
    isOwner: snapshot.isOwner,
    kind: snapshot.kind,
    softDeleted: snapshot.softDeleted,
    url: snapshot.url,
    parentKind: snapshot.parentKind,
    hasSidecar: snapshot.sidecarStatus !== null,
  })) {
    throw new ClassifyInboxSkipError('resource_not_found', 'The requested resource was not found.');
  }
  const decidedAt = await ports.clock.now();
  const write = await ports.inbox.insertSkipped({
    nodeId: snapshot.nodeId,
    collectionId: snapshot.collectionId,
    accountSubjectId: input.actor.subjectId,
    decidedAt,
  });
  if (write === 'blocked') {
    throw new ClassifyInboxSkipError('resource_not_found', 'The requested resource was not found.');
  }
  const receipt = skippedReceipt(snapshot.nodeId);
  await ports.receipts.complete(binding, fingerprint, productResult(receipt));
  return { kind: 'succeeded', receipt };
}

function skippedReceipt(nodeId: string): ClassifyInboxDecisionReceipt {
  return { nodeId, decision: 'skipped' };
}

function productResult(receipt: ClassifyInboxDecisionReceipt): ProductCommandResult {
  const body = JSON.stringify(receipt);
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: CLASSIFY_INBOX_SKIP_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): SkipClassifyInboxItemResult {
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
