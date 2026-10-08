import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type CollectionCapability,
} from '../../access-policy/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
} from '../../commands/index.js';
import {
  CollectionAuthorizationError,
  CollectionsError,
  formatUtcDateTime,
  strongEntityTag,
  type NodeKind,
  type NodeVisibility,
} from '../domain/index.js';
import type {
  LockedCollectionRow,
  ProductCollectionCanonicalPorts,
} from './ports.js';
import type {
  BookmarkNodeView,
  EditableNodeView,
  FolderNodeView,
} from './get-editor-page.js';

/**
 * Shared non-claimed receipt outcomes for product mutations.
 * Status/headers/body bytes are forwarded from the receipt port unchanged.
 */
export type ProductMutationNonClaimedResult =
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
      readonly contractVersion: string;
      readonly targetIdentity?: string;
    }
  | {
      readonly kind: 'in_progress';
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: 'reused' }
  | {
      readonly kind: 'expired';
      readonly resultDigest: string | null;
    };

export function mapNonClaimed(
  claim: Exclude<ProductCommandClaim, { kind: 'claimed' }>,
): ProductMutationNonClaimedResult {
  switch (claim.kind) {
    case 'replay':
      return {
        kind: 'replay',
        status: claim.result.status,
        body: claim.result.body,
        stableHeaders: claim.result.stableHeaders,
        mediaType: claim.result.mediaType,
        contractVersion: claim.result.contractVersion,
        targetIdentity: claim.result.targetIdentity,
      };
    case 'in_progress':
      return {
        kind: 'in_progress',
        retryAfterSeconds: claim.retryAfterSeconds,
      };
    case 'reused':
      return { kind: 'reused' };
    case 'expired':
      return { kind: 'expired', resultDigest: claim.resultDigest };
    default: {
      const _exhaustive: never = claim;
      return _exhaustive;
    }
  }
}

export async function claimProductMutation(
  ports: Pick<ProductCollectionCanonicalPorts, 'receipts'>,
  binding: ProductCommandBinding,
  fingerprint: string,
): Promise<{ readonly kind: 'claimed' } | ProductMutationNonClaimedResult> {
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') {
    return mapNonClaimed(claim);
  }
  return claim;
}

export async function authorizeCollectionCapability(
  accessPolicy: AccessPolicyFactsPort,
  input: {
    readonly collectionId: string;
    readonly actor: { readonly principalId: string; readonly subjectId: string };
    readonly capability: CollectionCapability;
  },
  locked: LockedCollectionRow,
): Promise<void> {
  const decision = await authorizeCapability(accessPolicy, {
    collectionId: input.collectionId,
    actor: {
      principalId: input.actor.principalId,
      subjectId: input.actor.subjectId,
      kind: 'account',
    },
    capability: input.capability,
    expectedPolicyRevision: locked.policyRevision,
  });

  if (decision.outcome !== 'allow') {
    throw new CollectionAuthorizationError({
      outcome: decision.outcome,
      reasonCategory: decision.reasonCategory,
    });
  }

  if (locked.deletedAt !== null) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }
}

export function projectEditableNodeView(input: {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string;
  readonly kind: NodeKind;
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
  readonly position: string;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly iconUrl: string | null;
}): EditableNodeView {
  const common = {
    id: input.id,
    collectionId: input.collectionId,
    parentId: input.parentId,
    position: input.position,
    title: input.title,
    description: input.description,
    tags: [...input.tags],
    visibility: input.visibility,
    revision: input.resourceRevision,
    etag: strongEntityTag(input.resourceRevision),
    readOnly: false as const,
    readOnlyReason: null,
    createdAt: formatUtcDateTime(input.createdAt),
    updatedAt: formatUtcDateTime(input.updatedAt),
  };

  if (input.kind === 'folder') {
    const folder: FolderNodeView = {
      ...common,
      kind: 'folder',
      folderRole: null,
      childrenRevision: input.childrenRevision,
      childrenEtag: strongEntityTag(input.childrenRevision),
    };
    return folder;
  }

  if (typeof input.url !== 'string' || input.url.length < 1) {
    throw new CollectionsError('invalid_node_url', 'bookmark url is required');
  }
  const bookmark: BookmarkNodeView = {
    ...common,
    kind: 'bookmark',
    url: input.url,
    iconUrl: input.iconUrl,
  };
  return bookmark;
}
