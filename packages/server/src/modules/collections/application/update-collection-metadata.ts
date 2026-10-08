import {
  type AccessPolicyFactsPort,
} from '../../access-policy/index.js';
import {
  authorizeCollectionCapability,
  mapNonClaimed,
} from './product-mutation-admission.js';
import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  assertNonEmptyField,
  assertValidCollectionSummary,
  assertValidCollectionTitle,
  formatUtcDateTime,
  generateOpaqueId,
  strongEntityTag,
  type CollectionKind,
  type JsonObject,
} from '../domain/index.js';
import type {
  LockedCollectionRow,
  ProductCollectionCanonicalPorts,
} from './ports.js';

/**
 * Product command scope for a Collection metadata update.
 * Includes the concrete collectionId so receipts do not collide across resources.
 */
export function updateCollectionMetadataCommandScope(collectionId: string): string {
  return `collection:${collectionId}:metadata:update`;
}

/** Scope template documentation; prefer updateCollectionMetadataCommandScope(id). */
export const UPDATE_COLLECTION_METADATA_COMMAND_SCOPE =
  'collection:{collectionId}:metadata:update';
export const UPDATE_COLLECTION_METADATA_CONTRACT_VERSION = '1.0.0';
export const UPDATE_COLLECTION_PUBLICATION_CONTRACT_VERSION = '1.2.0';
export const UPDATE_COLLECTION_METADATA_OPERATION_TYPE = 'update_collection_metadata';
export const COLLECTION_UPDATED_EVENT_TYPE = 'collection.updated';
export const COLLECTION_UPDATED_EVENT_VERSION = 1;
export const COLLECTION_UPDATED_HANDLER_NAME = 'collection_updated_projection';

export interface UpdateCollectionMetadataActor {
  readonly principalId: string;
  readonly principalType: 'account';
  readonly subjectId: string;
}

export interface UpdateCollectionMetadataCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  /**
   * Defaults to a transport-neutral metadata-update intent for the collection.
   */
  readonly commandScope?: string;
}

/** RFC 7396 merge patch — at least one of title/summary after validation. */
export interface CollectionMetadataMergePatch {
  readonly title?: string;
  readonly summary?: string | null;
  readonly visibility?: 'private' | 'public' | 'unlisted';
  readonly publicationSlug?: string;
  readonly allowSearchIndexing?: boolean;
}

export interface UpdateCollectionMetadataInput {
  readonly actor: UpdateCollectionMetadataActor;
  readonly command: UpdateCollectionMetadataCommand;
  readonly collectionId: string;
  /**
   * Strong entity-tag (`"revision"`) or bare revision token from If-Match.
   * Missing If-Match is a transport concern (428); application only compares.
   */
  readonly ifMatch: string;
  readonly patch: CollectionMetadataMergePatch;
  /** Exact, pre-validated Product origin used to persist a canonical public-page Location. */
  readonly productOrigin?: string;
  /** Optional overrides for deterministic tests only. */
  readonly operationId?: string;
}

export interface UpdatedCollectionSnapshot {
  readonly id: string;
  readonly kind: CollectionKind;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
  readonly allowSearchIndexing: boolean;
  readonly publicationSlug?: string | null;
  readonly publishedAt?: string | null;
  readonly rootNodeId: string;
  readonly revision: string;
  readonly etag: string;
  readonly contentRevision: string;
  readonly contentEtag: string;
  readonly policyRevision: string;
  readonly policyEtag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type UpdateCollectionMetadataResult =
  | {
      readonly kind: 'updated';
      readonly collection: UpdatedCollectionSnapshot;
      readonly operationId: string;
      readonly commitOrdinal: bigint;
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

/** Product task-17 path: admission/authorization followed by one canonical mutation. */
export async function updateCollectionMetadataCanonical(
  ports: ProductCollectionCanonicalPorts,
  input: UpdateCollectionMetadataInput,
): Promise<UpdateCollectionMetadataResult> {
  const validated = validateInput(input);
  const binding: ProductCommandBinding = {
    principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope,
    commandId: validated.command.commandId,
  };
  const claim = await ports.receipts.claim(binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') return mapNonClaimed(claim);

  const locked = await ports.collections.lockForUpdate(validated.collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  await authorizeUpdate(ports.accessPolicy, validated, locked);
  const visibility = validated.patch.visibility ?? locked.visibility;
  if ((visibility === 'public' || visibility === 'unlisted') && ports.accountControl) {
    const decision = await ports.accountControl.accountControl(validated.actor.principalId);
    if (decision.restrictPublication) {
      throw new CollectionAuthorizationError({
        outcome: 'deny',
        reasonCategory: 'publication_restricted',
      });
    }
  }
  if (!ifMatchSatisfied(validated.ifMatch, locked.resourceRevision)) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(locked.resourceRevision) });
  }

  const title = validated.patch.title ?? locked.title;
  const summary = validated.patch.summary !== undefined ? validated.patch.summary : locked.summary;
  const allowSearchIndexing = validated.patch.allowSearchIndexing ?? locked.allowSearchIndexing ?? false;
  const publicationSlug = resolvePublicationSlug(locked, validated.patch, visibility);
  const operationId = validated.operationId ?? generateOpaqueId();
  const updatedAt = await ports.clock.now();
  const mutation = await ports.canonical.execute({
    operationId,
    collectionId: validated.collectionId,
    actor: {
      principalId: validated.actor.principalId,
      principalType: validated.actor.principalType,
    },
    mutation: {
      action: 'update',
      target: {
        collectionId: validated.collectionId,
        resourceId: validated.collectionId,
        resourceKind: 'collection',
      },
      parentId: null,
      expectedResourceRevision: locked.resourceRevision,
      fields: {
        kindFields: {
          title,
          summary,
          kind: locked.kind,
          visibility,
          allowSearchIndexing,
          ...(publicationSlug === null ? {} : { publicationSlug }),
        },
        extensions: {},
      },
    },
  });
  const resourceRevision = mutation.allocation.resourceRevision!;
  const contentRevision = mutation.allocation.contentRevision ?? locked.contentRevision;
  const includePublication = validated.patch.visibility !== undefined
    || validated.patch.publicationSlug !== undefined
    || validated.patch.allowSearchIndexing !== undefined;
  const collection = buildCollectionSnapshot({
    locked,
    title,
    summary,
    visibility,
    allowSearchIndexing,
    ...(includePublication ? {
      publicationSlug,
      publishedAt: (visibility === 'public' || visibility === 'unlisted')
        ? locked.publishedAt ?? updatedAt
        : locked.publishedAt ?? null,
    } : {}),
    policyRevision: mutation.allocation.policyRevision ?? locked.policyRevision,
    resourceRevision,
    contentRevision,
    updatedAt,
  });
  const productResult = buildProductResult(collection, canonicalPublicationLocation(
    validated.productOrigin,
    collection,
  ));
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult);
  return {
    kind: 'updated',
    collection,
    operationId,
    commitOrdinal: mutation.allocation.commitOrdinal,
    stableHeaders: productResult.stableHeaders,
    body: productResult.body,
    mediaType: productResult.mediaType,
  };
}

interface ValidatedUpdateCollectionMetadataInput {
  readonly actor: UpdateCollectionMetadataActor;
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly collectionId: string;
  readonly ifMatch: string;
  readonly patch: {
    readonly title?: string;
    readonly summary?: string | null;
    readonly visibility?: 'private' | 'public' | 'unlisted';
    readonly publicationSlug?: string;
    readonly allowSearchIndexing?: boolean;
  };
  readonly operationId?: string;
  readonly productOrigin?: string;
}

/**
 * COLP-style two-phase validation: structural shape first, then domain semantics.
 * Structural failures use invalid_collection_input / field codes; semantic uses title/summary codes.
 */
function validateInput(
  input: UpdateCollectionMetadataInput,
): ValidatedUpdateCollectionMetadataInput {
  // --- structural ---
  if (!input || typeof input !== 'object') {
    throw new CollectionsError('invalid_collection_input', 'input is required');
  }
  if (!input.actor || typeof input.actor !== 'object') {
    throw new CollectionsError('invalid_collection_input', 'actor is required');
  }
  if (!input.command || typeof input.command !== 'object') {
    throw new CollectionsError('invalid_collection_input', 'command is required');
  }
  if (input.actor.principalType !== 'account') {
    throw new CollectionsError(
      'invalid_collection_input',
      'actor.principalType must be account',
    );
  }

  const principalId = assertNonEmptyField(input.actor.principalId, 'actor.principalId');
  const subjectId = assertNonEmptyField(input.actor.subjectId, 'actor.subjectId');
  const commandId = assertCanonicalCommandId(
    assertNonEmptyField(input.command.commandId, 'command.commandId'),
  );
  const fingerprint = assertNonEmptyField(input.command.fingerprint, 'command.fingerprint');
  const collectionId = assertNonEmptyField(input.collectionId, 'collectionId');
  const ifMatch = assertNonEmptyField(input.ifMatch, 'ifMatch');
  const commandScope = input.command.commandScope?.trim()
    ? input.command.commandScope
    : updateCollectionMetadataCommandScope(collectionId);
  assertNonEmptyField(commandScope, 'command.commandScope');

  if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
    throw new CollectionsError('invalid_collection_input', 'patch is required');
  }

  const patchRecord = input.patch as Record<string, unknown>;
  const allowedKeys = new Set(['title', 'summary', 'visibility', 'publicationSlug', 'allowSearchIndexing']);
  for (const key of Object.keys(patchRecord)) {
    if (!allowedKeys.has(key)) {
      throw new CollectionsError(
        'invalid_collection_input',
        `patch property "${key}" is not allowed`,
      );
    }
  }

  const hasTitle = Object.hasOwn(patchRecord, 'title');
  const hasSummary = Object.hasOwn(patchRecord, 'summary');
  const hasVisibility = Object.hasOwn(patchRecord, 'visibility');
  const hasPublicationSlug = Object.hasOwn(patchRecord, 'publicationSlug');
  const hasAllowSearchIndexing = Object.hasOwn(patchRecord, 'allowSearchIndexing');
  if (!hasTitle && !hasSummary && !hasVisibility && !hasPublicationSlug && !hasAllowSearchIndexing) {
    throw new CollectionsError(
      'invalid_collection_input',
      'patch must include at least one supported field',
    );
  }

  let rawTitle: string | undefined;
  if (hasTitle) {
    if (patchRecord.title === null || patchRecord.title === undefined) {
      throw new CollectionsError(
        'invalid_collection_title',
        'title cannot be null',
      );
    }
    if (typeof patchRecord.title !== 'string') {
      throw new CollectionsError(
        'invalid_collection_title',
        'title must be a string',
      );
    }
    rawTitle = patchRecord.title;
  }

  let rawSummary: string | null | undefined;
  if (hasSummary) {
    if (patchRecord.summary !== null && typeof patchRecord.summary !== 'string') {
      throw new CollectionsError(
        'invalid_collection_summary',
        'summary must be a string or null',
      );
    }
    rawSummary = patchRecord.summary as string | null;
  }

  let visibility: 'private' | 'public' | 'unlisted' | undefined;
  if (hasVisibility) {
    if (!['private', 'public', 'unlisted'].includes(String(patchRecord.visibility))) {
      throw new CollectionsError('invalid_collection_input', 'visibility must be private, public, or unlisted');
    }
    visibility = patchRecord.visibility as typeof visibility;
  }
  let publicationSlug: string | undefined;
  if (hasPublicationSlug) {
    if (typeof patchRecord.publicationSlug !== 'string'
      || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(patchRecord.publicationSlug)) {
      throw new CollectionsError(
        'invalid_collection_input',
        'publicationSlug must be a canonical lowercase slug between 3 and 63 characters',
      );
    }
    publicationSlug = patchRecord.publicationSlug;
  }
  let allowSearchIndexing: boolean | undefined;
  if (hasAllowSearchIndexing) {
    if (typeof patchRecord.allowSearchIndexing !== 'boolean') {
      throw new CollectionsError('invalid_collection_input', 'allowSearchIndexing must be a boolean');
    }
    allowSearchIndexing = patchRecord.allowSearchIndexing;
  }

  // --- semantic (domain validators) ---
  let title: string | undefined;
  if (rawTitle !== undefined) {
    title = assertValidCollectionTitle(rawTitle);
  }
  let summary: string | null | undefined;
  if (rawSummary !== undefined) {
    summary = assertValidCollectionSummary(rawSummary);
  }

  return {
    actor: {
      principalId,
      principalType: 'account',
      subjectId,
    },
    command: {
      commandId,
      fingerprint,
      commandScope,
    },
    collectionId,
    ifMatch,
    patch: {
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(publicationSlug !== undefined ? { publicationSlug } : {}),
      ...(allowSearchIndexing !== undefined ? { allowSearchIndexing } : {}),
    },
    operationId: input.operationId,
    productOrigin: validateProductOrigin(input.productOrigin),
  };
}

function resolvePublicationSlug(
  locked: LockedCollectionRow,
  patch: ValidatedUpdateCollectionMetadataInput['patch'],
  visibility: LockedCollectionRow['visibility'],
): string | null {
  const existing = locked.publicationSlug ?? null;
  if (locked.publishedAt != null
    && existing !== null
    && patch.publicationSlug !== undefined
    && patch.publicationSlug !== existing) {
    throw new CollectionsError(
      'invalid_collection_input',
      'publicationSlug is immutable after first publication',
    );
  }
  if (locked.publishedAt == null && visibility === 'private' && patch.publicationSlug !== undefined) {
    throw new CollectionsError(
      'invalid_collection_input',
      'publicationSlug can only be assigned as part of the first public or unlisted publication',
    );
  }
  const slug = locked.publishedAt == null
    ? patch.publicationSlug ?? existing
    : existing ?? patch.publicationSlug ?? null;
  if ((visibility === 'public' || visibility === 'unlisted') && slug === null) {
    throw new CollectionsError(
      'invalid_collection_input',
      'publicationSlug is required when visibility is public or unlisted',
    );
  }
  return slug;
}

async function authorizeUpdate(
  accessPolicy: AccessPolicyFactsPort,
  validated: ValidatedUpdateCollectionMetadataInput,
  locked: LockedCollectionRow,
): Promise<void> {
  await authorizeCollectionCapability(accessPolicy, {
    collectionId: validated.collectionId,
    actor: validated.actor,
    capability: validated.patch.visibility !== undefined
      || validated.patch.publicationSlug !== undefined
      || validated.patch.allowSearchIndexing !== undefined
      ? 'manage_publication'
      : 'update_collection_metadata',
  }, locked);
}

/**
 * Accepts strong entity-tag `"revision"` or bare revision token.
 */
export function ifMatchSatisfied(ifMatch: string, resourceRevision: string): boolean {
  if (ifMatch === resourceRevision) return true;
  return ifMatch === strongEntityTag(resourceRevision);
}

function buildCollectionSnapshot(input: {
  readonly locked: LockedCollectionRow;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility?: LockedCollectionRow['visibility'];
  readonly allowSearchIndexing?: boolean;
  readonly publicationSlug?: string | null;
  readonly publishedAt?: Date | null;
  readonly policyRevision?: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly updatedAt: Date;
}): UpdatedCollectionSnapshot {
  return {
    id: input.locked.id,
    kind: input.locked.kind,
    title: input.title,
    summary: input.summary,
    visibility: input.visibility ?? input.locked.visibility,
    allowSearchIndexing: input.allowSearchIndexing ?? input.locked.allowSearchIndexing ?? false,
    ...(
      input.publicationSlug !== undefined
      || input.publishedAt !== undefined
        ? {
            publicationSlug: input.publicationSlug ?? input.locked.publicationSlug ?? null,
            publishedAt: input.publishedAt === undefined
              ? input.locked.publishedAt ? formatUtcDateTime(input.locked.publishedAt) : null
              : input.publishedAt ? formatUtcDateTime(input.publishedAt) : null,
          }
        : {}
    ),
    rootNodeId: input.locked.rootNodeId,
    revision: input.resourceRevision,
    etag: strongEntityTag(input.resourceRevision),
    contentRevision: input.contentRevision,
    contentEtag: strongEntityTag(input.contentRevision),
    policyRevision: input.policyRevision ?? input.locked.policyRevision,
    policyEtag: strongEntityTag(input.policyRevision ?? input.locked.policyRevision),
    createdAt: formatUtcDateTime(input.locked.createdAt),
    updatedAt: formatUtcDateTime(input.updatedAt),
  };
}

function buildProductResult(
  collection: UpdatedCollectionSnapshot,
  canonicalLocation?: string,
): ProductCommandResult {
  const bodyObject = {
    collection: {
      id: collection.id,
      kind: collection.kind,
      title: collection.title,
      summary: collection.summary,
      visibility: collection.visibility,
      allowSearchIndexing: collection.allowSearchIndexing,
      ...(collection.publicationSlug !== undefined ? { publicationSlug: collection.publicationSlug } : {}),
      ...(collection.publishedAt !== undefined ? { publishedAt: collection.publishedAt } : {}),
      rootNodeId: collection.rootNodeId,
      revision: collection.revision,
      etag: collection.etag,
      contentRevision: collection.contentRevision,
      contentEtag: collection.contentEtag,
      policyRevision: collection.policyRevision,
      policyEtag: collection.policyEtag,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    },
  };
  const bodyText = JSON.stringify(bodyObject);
  return {
    status: 200,
    body: new TextEncoder().encode(bodyText),
    stableHeaders: {
      etag: collection.etag,
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      ...(canonicalLocation ? { location: canonicalLocation } : {}),
    },
    mediaType: 'application/json',
    contractVersion: collection.publicationSlug === undefined
      ? UPDATE_COLLECTION_METADATA_CONTRACT_VERSION
      : UPDATE_COLLECTION_PUBLICATION_CONTRACT_VERSION,
    targetIdentity: collection.id,
  };
}

function validateProductOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CollectionsError('invalid_collection_input', 'productOrigin must be an exact HTTP(S) origin');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) {
    throw new CollectionsError(
      'invalid_collection_input',
      'productOrigin must be an exact HTTP(S) origin',
    );
  }
  return origin;
}

function canonicalPublicationLocation(
  productOrigin: string | undefined,
  collection: UpdatedCollectionSnapshot,
): string | undefined {
  if (!productOrigin || !collection.publicationSlug || collection.publishedAt == null) return undefined;
  return `${productOrigin}/c/${collection.publicationSlug}`;
}

/** Closed payload for collection.updated@1 — fail closed before outbox insert. */
export function assertCollectionUpdatedPayload(payload: unknown): asserts payload is {
  readonly collectionId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly title: string;
  readonly summary: string | null;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CollectionsError(
      'invalid_collection_input',
      'collection.updated payload must be an object',
    );
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'collectionId',
    'contentRevision',
    'resourceRevision',
    'summary',
    'title',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CollectionsError(
      'invalid_collection_input',
      'collection.updated payload must be a closed object',
    );
  }
  for (const key of ['collectionId', 'resourceRevision', 'contentRevision', 'title'] as const) {
    const value = record[key];
    if (typeof value !== 'string' || value.length < 1) {
      throw new CollectionsError(
        'invalid_collection_input',
        `collection.updated payload.${key} must be a non-empty string`,
      );
    }
  }
  if (record.summary !== null && typeof record.summary !== 'string') {
    throw new CollectionsError(
      'invalid_collection_input',
      'collection.updated payload.summary must be a string or null',
    );
  }
}
