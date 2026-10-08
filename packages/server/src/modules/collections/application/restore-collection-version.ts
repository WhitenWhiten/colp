import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandResult,
} from '../../commands/index.js';
import { NodeConflictError } from '../domain/index.js';
import type { ProductCollectionCanonicalPorts } from './ports.js';
import {
  captureCollectionTreeVersion,
  CollectionVersionInputError,
  CollectionVersionNodeLimitError,
  CollectionVersionNotFoundError,
  diffCollectionTree,
  type CollectionTreeLiveMember,
  type CollectionTreeSnapshotNode,
  type CollectionVersionLockedCollection,
  type CollectionVersionRecord,
} from './capture-collection-tree-version.js';
import {
  assertContentIfMatch,
  COLLECTION_VERSION_CONTRACT_VERSION,
  collectionVersionItemRoute,
  type CreateCollectionVersionPorts,
  type CreateCollectionVersionResult,
} from './create-collection-version.js';
import {
  applyDeletes,
  applyFieldUpdates,
  applyParentChanges,
  applySiblingOrder,
  RestoreCollectionVersionInnerCommandError,
} from './restore-collection-version-apply.js';
import { createRestoreLiveNodeLookup } from './restore-collection-version-live-nodes.js';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const MISSING_TITLE_LIMIT = 5;

export const COLLECTION_VERSION_RESTORE_CONTRACT_VERSION = COLLECTION_VERSION_CONTRACT_VERSION;

/** FIFO cap for restore-receipt rows per collection_id (mirrors collection-tree version FIFO). */
export const COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT = 50;

export { RestoreCollectionVersionInnerCommandError };

export class CollectionVersionRestoreReceiptConflictError extends Error {
  constructor() {
    super('collection-version restore receipt command id reused');
    this.name = 'CollectionVersionRestoreReceiptConflictError';
  }
}

export interface CollectionVersionRestoreReceiptDto {
  readonly versionId: string;
  readonly noop: boolean;
  readonly updatedNodeIds: readonly string[];
  readonly movedNodeIds: readonly string[];
  readonly deletedNodeIds: readonly string[];
  readonly preRestoreVersionId: string | null;
}

export interface CollectionVersionRestoreInnerCommands {
  readonly updateCommandIds: readonly string[];
  readonly moveCommandIds: readonly string[];
  readonly deleteCommandIds: readonly string[];
}

export interface CollectionVersionRestoreReceiptRow {
  readonly commandId: string;
  readonly versionId: string;
  readonly collectionId: string;
  readonly accountId: string;
  readonly innerCommands: CollectionVersionRestoreInnerCommands;
  readonly result: CollectionVersionRestoreReceiptDto;
  readonly createdAt: Date;
}

export interface CollectionVersionRestoreReceiptStore {
  getByCommandId(accountId: string, commandId: string): Promise<CollectionVersionRestoreReceiptRow | null>;
  persist(row: CollectionVersionRestoreReceiptRow): Promise<void>;
}

export interface RestoreCollectionVersionPorts extends CreateCollectionVersionPorts {
  readonly mutations: ProductCollectionCanonicalPorts;
  readonly restoreReceipts: CollectionVersionRestoreReceiptStore;
  readonly commandIds?: { next(): string };
}

export interface RestoreCollectionVersionInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly collectionId: string;
  readonly versionId: string;
  readonly ifMatch: string;
  /** Undo passes `undo`. Omitted restores record `restore`. */
  readonly cause?: 'undo' | 'restore';
}

export type RestoreCollectionVersionResult =
  | { readonly kind: 'succeeded'; readonly receipt: CollectionVersionRestoreReceiptDto }
  | Exclude<CreateCollectionVersionResult, { readonly kind: 'succeeded' }>;

export function collectionVersionRestoreRoute(collectionId: string, versionId: string): string {
  return `${collectionVersionItemRoute(collectionId, versionId)}/restore`;
}

export function collectionVersionRestoreCommandScope(collectionId: string, versionId: string): string {
  return `collection:${collectionId}:version:${versionId}:restore`;
}

export function collectionVersionRestoreFingerprint(input: {
  readonly collectionId: string;
  readonly versionId: string;
  readonly ifMatch: string;
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: collectionVersionRestoreRoute(input.collectionId, input.versionId),
    mediaType: 'application/json',
    body: {},
    query: {},
    conditions: { ifMatch: input.ifMatch },
  });
}

export async function restoreCollectionVersion(
  ports: RestoreCollectionVersionPorts,
  input: RestoreCollectionVersionInput,
): Promise<RestoreCollectionVersionResult> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new CollectionVersionInputError('The collection-version actor is invalid.');
  }
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)
    || typeof input.versionId !== 'string' || !OPAQUE_ID.test(input.versionId)) {
    throw new CollectionVersionNotFoundError();
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new CollectionVersionInputError('commandId must be a canonical UUID v4.');
  }

  const fingerprint = collectionVersionRestoreFingerprint({
    collectionId: input.collectionId,
    versionId: input.versionId,
    ifMatch: input.ifMatch,
  });
  const binding: ProductCommandBinding = {
    principalId: input.actor.principalId,
    commandScope: collectionVersionRestoreCommandScope(input.collectionId, input.versionId),
    commandId,
  };
  const existingReceipt = await ports.receipts.lookup(binding, fingerprint);
  if (existingReceipt.kind !== 'absent') return mapClaim(existingReceipt);

  const existingRestore = await ports.restoreReceipts.getByCommandId(input.actor.principalId, commandId);
  if (existingRestore) {
    // The outer product_command_receipts row is the fingerprint authority and
    // should have replayed above; reaching here means it is gone (for example
    // trimmed). Only a receipt bound to this exact Collection and Version may
    // be reported as reused — a command id replayed against a different target
    // must not answer 200 for work it never performed.
    assertRestoreReceiptBinding(existingRestore, input);
    return { kind: 'reused' };
  }

  const collection = await ports.versions.lockOwnedLive(input.collectionId, input.actor.subjectId);
  // Admission may have waited for an identical restore to commit. Its receipt
  // wins over the mutable collection preconditions observed after that wait.
  const admittedReceipt = await ports.receipts.lookup(binding, fingerprint);
  if (admittedReceipt.kind !== 'absent') return mapClaim(admittedReceipt);
  const admittedRestore = await ports.restoreReceipts.getByCommandId(input.actor.principalId, commandId);
  if (admittedRestore) {
    assertRestoreReceiptBinding(admittedRestore, input);
    return { kind: 'reused' };
  }
  if (!collection) throw new CollectionVersionNotFoundError();
  assertContentIfMatch(input.ifMatch, collection);

  const target = await ports.versions.getById(
    input.actor.principalId,
    input.collectionId,
    input.versionId,
  );
  if (!target) throw new CollectionVersionNotFoundError();

  const live = await ports.versions.loadLiveMembers(input.collectionId);
  assertSnapshotNodesStillLive(target.treeJson, live);

  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const preRestoreVersionId = await capturePreRestore(
    ports,
    input.actor.principalId,
    collection,
    target,
    input.cause,
  );
  const equivalent = isEquivalentTree(target.treeJson, live);
  const actor = {
    principalId: input.actor.principalId,
    principalType: 'account' as const,
    subjectId: input.actor.subjectId,
  };
  const inner: { updateCommandIds: string[]; moveCommandIds: string[]; deleteCommandIds: string[] } = {
    updateCommandIds: [],
    moveCommandIds: [],
    deleteCommandIds: [],
  };
  const updatedNodeIds: string[] = [];
  const movedNodeIds: string[] = [];
  const deletedNodeIds: string[] = [];

  if (!equivalent) {
    const liveNodes = await createRestoreLiveNodeLookup(ports.mutations.nodes, collection.collectionId);
    await applyParentChanges(ports, actor, collection, target.treeJson, inner, movedNodeIds, liveNodes);
    await applySiblingOrder(ports, actor, collection, target.treeJson, inner, movedNodeIds, liveNodes);
    await applyFieldUpdates(ports, actor, input.collectionId, target.treeJson, inner, updatedNodeIds, liveNodes);
    await applyDeletes(ports, actor, collection, target.treeJson, live, inner, deletedNodeIds, liveNodes);
  }

  const receipt: CollectionVersionRestoreReceiptDto = {
    versionId: target.versionId,
    noop: equivalent,
    updatedNodeIds,
    movedNodeIds,
    deletedNodeIds,
    preRestoreVersionId,
  };
  const now = await Promise.resolve(ports.clock.now());
  try {
    await ports.restoreReceipts.persist({
      commandId,
      versionId: target.versionId,
      collectionId: input.collectionId,
      accountId: input.actor.principalId,
      innerCommands: inner,
      result: receipt,
      createdAt: now,
    });
  } catch (error: unknown) {
    if (error instanceof CollectionVersionRestoreReceiptConflictError) {
      throw new RestoreCollectionVersionInnerCommandError({ kind: 'reused' });
    }
    throw error;
  }
  await ports.receipts.complete(binding, fingerprint, productResult(receipt));
  return { kind: 'succeeded', receipt };
}

/**
 * A persisted restore receipt only proves the command succeeded for the
 * Collection/Version it recorded. Re-reading it under a caller-supplied
 * command id must not report `reused` for a different target, otherwise a
 * stale command id would answer 200 for a restore that never happened.
 */
function assertRestoreReceiptBinding(
  store: { readonly collectionId: string; readonly versionId: string },
  input: { readonly collectionId: string; readonly versionId: string },
): void {
  if (store.collectionId !== input.collectionId || store.versionId !== input.versionId) {
    throw new CollectionVersionRestoreReceiptConflictError();
  }
}

function assertSnapshotNodesStillLive(
  snapshot: readonly CollectionTreeSnapshotNode[],
  live: readonly CollectionTreeLiveMember[],
): void {
  const liveById = new Map(live.map((member) => [member.id, member]));
  const missingTitles: string[] = [];
  for (const node of snapshot) {
    const current = liveById.get(node.id);
    if (!current || current.kind !== node.kind) missingTitles.push(node.title);
  }
  if (missingTitles.length === 0) return;
  const listed = missingTitles.slice(0, MISSING_TITLE_LIMIT).join(', ');
  throw new NodeConflictError(
    'revision_conflict',
    `Snapshot nodes are missing or changed kind: ${listed}.`,
  );
}

function isEquivalentTree(
  snapshot: readonly CollectionTreeSnapshotNode[],
  live: readonly CollectionTreeLiveMember[],
): boolean {
  const { changeCounts } = diffCollectionTree(snapshot, live);
  return changeCounts.added === 0
    && changeCounts.removed === 0
    && changeCounts.moved === 0
    && changeCounts.renamed === 0
    && changeCounts.retargeted === 0;
}

async function capturePreRestore(
  ports: RestoreCollectionVersionPorts,
  accountId: string,
  collection: CollectionVersionLockedCollection,
  target: CollectionVersionRecord,
  cause?: 'undo' | 'restore',
): Promise<string | null> {
  const existing = await ports.versions.getByCollectionAndRevision(
    accountId,
    collection.collectionId,
    collection.contentRevision,
  );
  if (existing) return null;
  try {
    const captured = await captureCollectionTreeVersion(ports, {
      accountId,
      collection,
      kind: 'pre_restore',
      cause: cause ?? 'restore',
      label: 'Before restore',
      restoringVersionId: target.versionId,
    });
    return captured.record.versionId;
  } catch (error: unknown) {
    if (!(error instanceof CollectionVersionNodeLimitError)) throw error;
    return null;
  }
}

function productResult(receipt: CollectionVersionRestoreReceiptDto): ProductCommandResult {
  const body = Buffer.from(JSON.stringify(receipt), 'utf8');
  return {
    status: 200,
    body,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: COLLECTION_VERSION_RESTORE_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): RestoreCollectionVersionResult {
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
