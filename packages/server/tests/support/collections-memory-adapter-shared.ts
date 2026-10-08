import assert from 'node:assert/strict';
import type {
  AccessPolicyFactsPort,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../src/modules/access-policy/index.js';
import type { LockedNodeRow } from '../../src/modules/collections/index.js';
import {
  assertCanonicalCommandId,
  stableReplayHeaders,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../src/modules/commands/index.js';
/** Keep observable receipt semantics aligned with the production adapter. */
function snapshotProductCommandResult(result: ProductCommandResult): ProductCommandResult {
  return {
    status: result.status,
    body: Buffer.from(result.body),
    stableHeaders: { ...stableReplayHeaders(result.stableHeaders) },
    mediaType: result.mediaType,
    contractVersion: result.contractVersion,
    ...(result.targetIdentity === undefined ? {} : { targetIdentity: result.targetIdentity }),
  };
}

export interface CollectionsMemoryReceiptRow {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
  resultDigest?: string | null;
  expired?: boolean;
}

export interface CollectionsMemoryMembershipRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt?: Date;
}

export interface CollectionsMemoryReceiptState {
  readonly receipts: Map<string, CollectionsMemoryReceiptRow>;
  readonly forceInProgress?: boolean;
}

export interface CollectionsMemoryAccessPolicyState {
  readonly collections: ReadonlyMap<string, {
    readonly id: string;
    readonly ownerSubjectId: string;
    readonly visibility: ResourcePolicyFacts['visibility'];
    readonly policyRevision: string;
    readonly deletedAt: Date | null;
  }>;
  readonly memberships: readonly CollectionsMemoryMembershipRow[];
}

export function collectionsMemoryReceiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

export function snapshotLockedNode(row: LockedNodeRow): LockedNodeRow {
  return {
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    kind: row.kind,
    isRoot: row.isRoot,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: [...row.tags],
    visibility: row.visibility,
    positionToken: row.positionToken,
    resourceRevision: row.resourceRevision,
    childrenRevision: row.childrenRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function createCollectionsMemoryReceipts(
  state: CollectionsMemoryReceiptState,
): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      assertCanonicalCommandId(binding.commandId);
      if (state.forceInProgress) {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      const key = collectionsMemoryReceiptKey(binding);
      const existing = state.receipts.get(key);
      if (!existing) {
        state.receipts.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) {
        return { kind: 'reused' };
      }
      if (existing.expired) {
        return { kind: 'expired', resultDigest: existing.resultDigest ?? null };
      }
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed receipt must retain result');
      return { kind: 'replay', result: snapshotProductCommandResult(existing.result) };
    },
    async complete(binding, fingerprint, result): Promise<void> {
      const key = collectionsMemoryReceiptKey(binding);
      const existing = state.receipts.get(key);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new Error('complete without matching claim');
      }
      if (existing.status === 'completed') {
        throw new Error('receipt already completed');
      }
      const snapshot = snapshotProductCommandResult(result);
      existing.status = 'completed';
      existing.result = snapshot;
      existing.resultDigest = 'digest';
    },
    async purgeExpired() {
      return 0;
    },
    async deletePrincipalReceipts(principalId) {
      let count = 0;
      for (const [key] of state.receipts) {
        if (key.startsWith(`${principalId}\0`)) {
          state.receipts.delete(key);
          count += 1;
        }
      }
      return count;
    },
  };
}

export function createCollectionsMemoryAccessPolicyFacts(
  state: CollectionsMemoryAccessPolicyState,
): AccessPolicyFactsPort {
  return {
    async loadCollectionFacts(input): Promise<ResourcePolicyFacts | null> {
      const collection = state.collections.get(input.collectionId);
      if (!collection) return null;
      const membership = state.memberships.find(
        (item) => item.collectionId === input.collectionId && item.subjectId === input.actorSubjectId,
      );
      return {
        collectionId: collection.id,
        ownerSubjectId: collection.ownerSubjectId,
        visibility: collection.visibility,
        policyRevision: collection.policyRevision,
        membershipRole: membership?.role ?? null,
        deleted: collection.deletedAt !== null,
      };
    },
  };
}
