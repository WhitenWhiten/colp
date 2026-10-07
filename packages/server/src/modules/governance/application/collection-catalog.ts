import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type CollectionCapability,
} from '../../access-policy/index.js';
import {
  ifMatchSatisfied,
  type ProductCollectionCanonicalPorts,
  type LockedCollectionRow,
  CollectionAuthorizationError,
  CollectionPreconditionError,
  strongEntityTag,
  type JsonObject,
} from '../../collections/index.js';
import { assertCanonicalCommandId } from '../../commands/index.js';
import {
  mergeCatalogExtensions,
  parseCatalogPatch,
  readCatalogFromExtensions,
  type CatalogFields,
  type CatalogPatch,
} from '../domain/catalog.js';

export const COLLECTION_CATALOG_CONTRACT_VERSION = '1.0.0';

async function authorizeCatalogCapability(
  accessPolicy: AccessPolicyFactsPort,
  input: {
    readonly collectionId: string;
    readonly actor: CollectionCatalogActor;
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

export interface CollectionCatalogActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export interface CollectionCatalogView extends CatalogFields {
  readonly revision: string;
  readonly etag: string;
}

export type UpdateCollectionCatalogResult =
  | {
      readonly kind: 'updated';
      readonly catalog: CollectionCatalogView;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
      readonly mediaType: string;
    }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

function catalogView(revision: string, fields: CatalogFields): CollectionCatalogView {
  return Object.freeze({
    tags: Object.freeze([...fields.tags]),
    language: fields.language,
    revision,
    etag: strongEntityTag(revision),
  });
}

function catalogBody(catalog: CollectionCatalogView): {
  readonly body: Uint8Array;
  readonly stableHeaders: Readonly<Record<string, string>>;
} {
  const payload = { tags: [...catalog.tags], language: catalog.language, revision: catalog.revision };
  return {
    body: new TextEncoder().encode(JSON.stringify(payload)),
    stableHeaders: Object.freeze({
      etag: catalog.etag,
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    }),
  };
}

export interface CollectionCatalogReadPorts {
  readonly collections: {
    lockForShare?(collectionId: string): Promise<LockedCollectionRow | null>;
    lockForUpdate(collectionId: string): Promise<LockedCollectionRow | null>;
  };
  readonly accessPolicy: AccessPolicyFactsPort;
}

export async function getCollectionCatalog(
  ports: CollectionCatalogReadPorts,
  input: { readonly actor: CollectionCatalogActor; readonly collectionId: string },
): Promise<CollectionCatalogView> {
  const locked = ports.collections.lockForShare
    ? await ports.collections.lockForShare(input.collectionId)
    : await ports.collections.lockForUpdate(input.collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  await authorizeCatalogCapability(ports.accessPolicy, {
    collectionId: input.collectionId,
    actor: input.actor,
    capability: 'read_editor',
  }, locked);
  const fields = readCatalogFromExtensions(locked.payloadJson?.extensions);
  return catalogView(locked.resourceRevision, fields);
}

export async function updateCollectionCatalog(
  ports: ProductCollectionCanonicalPorts,
  input: {
    readonly actor: CollectionCatalogActor;
    readonly collectionId: string;
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly ifMatch: string;
    readonly patch: CatalogPatch;
  },
): Promise<UpdateCollectionCatalogResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const locked = await ports.collections.lockForUpdate(input.collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  await authorizeCatalogCapability(ports.accessPolicy, {
    collectionId: input.collectionId,
    actor: input.actor,
    capability: 'update_collection_metadata',
  }, locked);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: input.commandScope,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind !== 'claimed') return claim;
  if (!ifMatchSatisfied(input.ifMatch, locked.resourceRevision)) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(locked.resourceRevision) });
  }
  const current = readCatalogFromExtensions(locked.payloadJson?.extensions);
  const extensions = mergeCatalogExtensions(
    (locked.payloadJson?.extensions ?? {}) as Record<string, unknown>,
    input.patch,
  );
  const mutation = await ports.canonical.execute({
    operationId: commandId,
    collectionId: input.collectionId,
    actor: { principalId: input.actor.principalId, principalType: 'account' },
    mutation: {
      action: 'update',
      target: {
        collectionId: input.collectionId,
        resourceId: input.collectionId,
        resourceKind: 'collection',
      },
      parentId: null,
      expectedResourceRevision: locked.resourceRevision,
      fields: {
        kindFields: {
          title: locked.title,
          summary: locked.summary,
          kind: locked.kind,
          visibility: locked.visibility,
          allowSearchIndexing: locked.allowSearchIndexing ?? false,
          ...(locked.publicationSlug ? { publicationSlug: locked.publicationSlug } : {}),
        },
        extensions: extensions as JsonObject,
      },
      trustedFacts: { replaceExtensions: true },
    },
  });
  const revision = mutation.allocation.resourceRevision ?? locked.resourceRevision;
  const catalog = catalogView(revision, {
    tags: input.patch.tags ?? current.tags,
    language: input.patch.language !== undefined ? input.patch.language : current.language,
  });
  const product = catalogBody(catalog);
  await ports.receipts.complete(binding, input.fingerprint, {
    status: 200,
    body: product.body,
    stableHeaders: product.stableHeaders,
    mediaType: 'application/json',
    contractVersion: COLLECTION_CATALOG_CONTRACT_VERSION,
    targetIdentity: input.collectionId,
  });
  return { kind: 'updated', catalog, ...product, mediaType: 'application/json' };
}

export { parseCatalogPatch };
