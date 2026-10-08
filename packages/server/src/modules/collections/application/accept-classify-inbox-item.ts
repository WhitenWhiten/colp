import type { ClassificationEvidencePort } from './classification-hostname-prior.js';
import { applyClassificationContent, parseClassificationTagAdditions, type ClassificationVocabularyPort } from './classification-content.js';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import { CollectionPreconditionError, strongEntityTag } from '../domain/index.js';
import { isClassifyInboxEligible, type ClassifyInboxNodeKind } from './classify-inbox-eligibility.js';
import {
  moveCollectionNode,
  moveCollectionNodeCommandScope,
  type MoveCollectionNodeResult,
} from './move-collection-node.js';
import type {
  CollectionsClock,
  LockedNodeRow,
  ProductCollectionCanonicalPorts,
} from './ports.js';
import { ifMatchSatisfied } from './update-collection-metadata.js';
import type { ClassifyInboxDecisionReceipt, ClassifyInboxSidecarStatus } from './skip-classify-inbox-item.js';

export const CLASSIFY_INBOX_ACCEPT_COMMAND_SCOPE = 'collections:classify-inbox-accept:v1';
export const CLASSIFY_INBOX_ACCEPT_CONTRACT_VERSION = '1.0.0';
export const CLASSIFY_INBOX_ACCEPT_ROUTE = '/api/v1/me/classify-inbox/{nodeId}/accept';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export class ClassifyInboxAcceptError extends Error {
  readonly code: 'invalid_request' | 'invalid_document' | 'resource_not_found';

  constructor(code: 'invalid_request' | 'invalid_document' | 'resource_not_found', message: string) {
    super(message);
    this.name = 'ClassifyInboxAcceptError';
    this.code = code;
  }
}

export interface ClassifyInboxAcceptSnapshot {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly isOwner: boolean;
  readonly kind: ClassifyInboxNodeKind;
  readonly softDeleted: boolean;
  readonly url: string;
  readonly parentKind: ClassifyInboxNodeKind;
  readonly parentId: string | null;
  readonly resourceRevision: string;
  readonly sidecarStatus: ClassifyInboxSidecarStatus | null;
}

export type ClassifyInboxAcceptInsertResult = 'inserted' | 'already_accepted' | 'blocked';

export interface ClassifyInboxAcceptWritePort {
  loadEligibilitySnapshot(input: {
    readonly ownerSubjectId: string;
    readonly nodeId: string;
  }): Promise<ClassifyInboxAcceptSnapshot | null>;
  insertAccepted(input: {
    readonly nodeId: string;
    readonly collectionId: string;
    readonly accountSubjectId: string;
    readonly suggestionId: string;
    readonly decidedAt: Date;
  }): Promise<ClassifyInboxAcceptInsertResult>;
}

export type MoveCollectionNodeFn = (
  ports: ProductCollectionCanonicalPorts,
  input: Parameters<typeof moveCollectionNode>[1],
) => Promise<MoveCollectionNodeResult>;

export interface AcceptClassifyInboxItemPorts {
  readonly evidence?:ClassificationEvidencePort;
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly inbox: ClassifyInboxAcceptWritePort;
  readonly clock: CollectionsClock;
  readonly collection: ProductCollectionCanonicalPorts;
  readonly move: MoveCollectionNodeFn;
  readonly vocabulary: ClassificationVocabularyPort;
}

export interface AcceptClassifyInboxItemInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
  readonly body: unknown;
}

export type AcceptClassifyInboxItemResult =
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

export function parseClassifyInboxAcceptBody(raw: unknown): { readonly suggestionId: string; readonly addTags?: readonly string[] } {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClassifyInboxAcceptError('invalid_document', 'The classify-inbox accept body is invalid.');
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.includes('suggestionId') || keys.some(key => key !== 'suggestionId' && key !== 'addTags') || typeof record.suggestionId !== 'string'
    || !OPAQUE_ID.test(record.suggestionId)) {
    throw new ClassifyInboxAcceptError('invalid_document', 'The classify-inbox accept body is invalid.');
  }
  if (!Object.hasOwn(record, 'addTags')) return { suggestionId: record.suggestionId };
  try { return { suggestionId: record.suggestionId, addTags: parseClassificationTagAdditions(record.addTags) }; }
  catch { throw new ClassifyInboxAcceptError('invalid_document', 'addTags must contain at most 3 unique existing tags.'); }
}

export function acceptClassifyInboxFingerprint(
  nodeId: string,
  suggestionId: string,
  ifMatch: string,
  addTags?: readonly string[],
): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/api/v1/me/classify-inbox/${nodeId}/accept`,
    mediaType: 'application/json',
    body: JSON.parse(canonicalJson({ suggestionId, ...(addTags === undefined ? {} : {addTags}) })) as unknown,
    query: {},
    conditions: { ifMatch },
  });
}

export async function acceptClassifyInboxItem(
  ports: AcceptClassifyInboxItemPorts,
  input: AcceptClassifyInboxItemInput,
): Promise<AcceptClassifyInboxItemResult> {
  const body = parseClassifyInboxAcceptBody(input.body);
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new ClassifyInboxAcceptError('invalid_request', 'The classify-inbox accept actor is invalid.');
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new ClassifyInboxAcceptError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  if (typeof input.nodeId !== 'string' || !OPAQUE_ID.test(input.nodeId)) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }
  if (typeof input.ifMatch !== 'string' || input.ifMatch.length < 1) {
    throw new ClassifyInboxAcceptError('invalid_request', 'If-Match is required for this operation.');
  }
  const fingerprint = acceptClassifyInboxFingerprint(input.nodeId, body.suggestionId, input.ifMatch, body.addTags);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: CLASSIFY_INBOX_ACCEPT_COMMAND_SCOPE,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  let snapshot = await ports.inbox.loadEligibilitySnapshot({
    ownerSubjectId: input.actor.subjectId,
    nodeId: input.nodeId,
  });
  if (snapshot === null) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }
  const locked = await ports.collection.collections.lockForUpdate(snapshot.collectionId);
  if (locked === null) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }

  // Re-read eligibility after obtaining the lock; concurrent decisions/content may have changed.
  snapshot = await ports.inbox.loadEligibilitySnapshot({ownerSubjectId: input.actor.subjectId, nodeId: input.nodeId});
  if (!snapshot || snapshot.collectionId !== locked.id || locked.deletedAt !== null || locked.ownerSubjectId !== input.actor.subjectId) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }
  const applyTagsAndMove = () => applyClassificationContent({...ports.collection,vocabulary:ports.vocabulary},{
    actor:{principalId:input.actor.principalId,principalType:'account'},collectionId:locked.id,nodeId:input.nodeId,
    ifMatch:input.ifMatch,selection:{folderId:body.suggestionId,addTags:body.addTags!},
  });

  const folder = await ports.collection.nodes.getNode(snapshot.collectionId, body.suggestionId);
  if (!isLiveFolder(folder)) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }

  if (snapshot.sidecarStatus === 'skipped') {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }

  if (snapshot.sidecarStatus === 'accepted') {
    if (snapshot.parentId !== body.suggestionId) {
      throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
    }
    assertIfMatch(input.ifMatch, snapshot.resourceRevision);
    if (body.addTags !== undefined){
      const result=await applyTagsAndMove();
      if(result.operationIds.length)await ports.evidence?.append({ownerSubjectId:input.actor.subjectId,collectionId:locked.id,nodeId:input.nodeId,folderId:null,
        addTags:body.addTags,source:'classify_accept',commandId,taxonomyRevision:locked.contentRevision,operationId:result.operationIds[0]});
    }
    const receipt = acceptedReceipt(snapshot.nodeId, body.suggestionId);
    await ports.receipts.complete(binding, fingerprint, productResult(receipt));
    return { kind: 'succeeded', receipt };
  }

  const eligible = isClassifyInboxEligible({
    isOwner: snapshot.isOwner,
    kind: snapshot.kind,
    softDeleted: snapshot.softDeleted,
    url: snapshot.url,
    parentKind: snapshot.parentKind,
    hasSidecar: snapshot.sidecarStatus !== null,
  });
  const alreadyInFolder = snapshot.parentId === body.suggestionId;
  if (!eligible && !alreadyInFolder) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }

  const sourceParentId = snapshot.parentId;
  if (sourceParentId === null) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }
  const sourceParent = await ports.collection.nodes.getNode(snapshot.collectionId, sourceParentId);
  if (sourceParent === null || sourceParent.deletedAt !== null) {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }

  if (body.addTags !== undefined) {
    await applyTagsAndMove();
  } else {
    const moved = await ports.move(ports.collection, {
      actor: {
        principalId: input.actor.principalId,
        principalType: 'account',
        subjectId: input.actor.subjectId,
      },
      command: {
        commandId,
        fingerprint: nestedMoveFingerprint(input.nodeId, body.suggestionId, input.ifMatch),
        commandScope: moveCollectionNodeCommandScope(snapshot.collectionId, snapshot.nodeId),
      },
      collectionId: snapshot.collectionId,
      nodeId: snapshot.nodeId,
      ifMatch: input.ifMatch,
      newParentId: body.suggestionId,
      afterId: null,
      beforeId: null,
      baseSourceParentRevision: sourceParent.childrenRevision,
      baseTargetParentRevision: folder.childrenRevision,
    });
    if (moved.kind !== 'moved' && moved.kind !== 'replay') {
      throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
    }
  }

  const decidedAt = await ports.clock.now();
  const write = await ports.inbox.insertAccepted({
    nodeId: snapshot.nodeId,
    collectionId: snapshot.collectionId,
    accountSubjectId: input.actor.subjectId,
    suggestionId: body.suggestionId,
    decidedAt,
  });
  if (write === 'blocked') {
    throw new ClassifyInboxAcceptError('resource_not_found', 'The requested resource was not found.');
  }
  if(write==='inserted')await ports.evidence?.append({ownerSubjectId:input.actor.subjectId,collectionId:locked.id,nodeId:input.nodeId,folderId:body.suggestionId,
    addTags:body.addTags??[],source:'classify_accept',commandId,taxonomyRevision:locked.contentRevision});
  const receipt = acceptedReceipt(snapshot.nodeId, body.suggestionId);
  await ports.receipts.complete(binding, fingerprint, productResult(receipt));
  return { kind: 'succeeded', receipt };
}

function isLiveFolder(node: LockedNodeRow | null): node is LockedNodeRow {
  return node !== null
    && node.deletedAt === null
    && node.isRoot === false
    && node.kind === 'folder';
}

function assertIfMatch(ifMatch: string, resourceRevision: string): void {
  if (!ifMatchSatisfied(ifMatch, resourceRevision)) {
    throw new CollectionPreconditionError({
      currentEtag: strongEntityTag(resourceRevision),
    });
  }
}

function nestedMoveFingerprint(nodeId: string, suggestionId: string, ifMatch: string): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/api/v1/me/classify-inbox/${nodeId}/accept`,
    mediaType: 'application/json',
    body: JSON.parse(canonicalJson({ suggestionId, nested: 'moveCollectionNode' })) as unknown,
    query: {},
    conditions: { ifMatch },
  });
}

function acceptedReceipt(nodeId: string, folderId: string): ClassifyInboxDecisionReceipt {
  return { nodeId, decision: 'accepted', folderId };
}

function productResult(receipt: ClassifyInboxDecisionReceipt): ProductCommandResult {
  const body = JSON.stringify(receipt);
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
    },
    mediaType: 'application/json',
    contractVersion: CLASSIFY_INBOX_ACCEPT_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): AcceptClassifyInboxItemResult {
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
