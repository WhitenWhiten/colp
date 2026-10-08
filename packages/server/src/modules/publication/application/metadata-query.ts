import { createValidatorRegistry } from '@know-n/colp/schema';
import type { CollectionMetadata, HttpUrl } from '@know-n/colp/types';
import { isHiddenPublicCollection, type CollectionHideControlPort } from './collection-control-gate.js';
import type { PublicationPrincipal } from './snapshot-query.js';
import type { PublicationMetadataReadPort, PublicationMetadataRecord } from './metadata-read.js';

export interface PublicationMetadataQueryPorts {
  readonly reads: PublicationMetadataReadPort;
  readonly origin: string;
  readonly now?: () => Date;
  readonly collectionControl?: CollectionHideControlPort;
}

export type PublicationMetadataQueryInput =
  | ({ readonly collectionId: string; readonly publicationSlug?: never }
    | { readonly collectionId?: never; readonly publicationSlug: string })
  & { readonly principal: PublicationPrincipal };

export type PublicationMetadataResult =
  | {
      readonly kind: 'metadata';
      readonly metadata: Readonly<CollectionMetadata>;
      readonly projection: 'public' | 'member';
      readonly revision: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: 'gone';
      readonly deletedAt: string;
      readonly canonicalUrl: string;
    };

export class PublicationMetadataNotFoundError extends Error {
  readonly code = 'resource_not_found';
  constructor() {
    super('Publication Collection Metadata was not found.');
    this.name = 'PublicationMetadataNotFoundError';
  }
}

/**
 * T06 internal discriminator: the resource is *confirmed absent* rather than
 * merely hidden from the caller (no row, no publication slug, or a tombstone
 * that passed its retention window). Only this subclass is eligible for the
 * anonymous public not-found negative cache; permission concealment, an
 * unavailable declared root and schema/database failures keep the base error.
 * It extends `PublicationMetadataNotFoundError` so the transport still maps
 * every variant to `resource_not_found` without any route change.
 */
export class PublicationMetadataConfirmedNotFoundError extends PublicationMetadataNotFoundError {
  constructor() {
    super();
    this.name = 'PublicationMetadataConfirmedNotFoundError';
  }
}

const validators = createValidatorRegistry();
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Shared COLP schema guard used by both the authoritative query and Redis hits. */
export function isValidPublicationCollectionMetadata(value: unknown): value is CollectionMetadata {
  return validators.validate('collectionMetadata', value).valid;
}

export async function getPublicationCollectionMetadata(
  ports: PublicationMetadataQueryPorts,
  input: PublicationMetadataQueryInput,
  signal?: AbortSignal,
): Promise<PublicationMetadataResult> {
  const record = await ports.reads.load({
    ...(input.collectionId !== undefined
      ? { collectionId: input.collectionId }
      : { publicationSlug: input.publicationSlug }),
    ...(input.principal.kind === 'account' ? { actorSubjectId: input.principal.subjectId } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  if (record === null || record.publicationSlug === null) throw new PublicationMetadataConfirmedNotFoundError();
  const member = input.principal.kind === 'account'
    && (record.ownerSubjectId === input.principal.subjectId || record.membershipRole !== null);
  if (!member && record.visibility !== 'public' && record.visibility !== 'unlisted') {
    throw new PublicationMetadataNotFoundError();
  }
  if (await isHiddenPublicCollection(ports.collectionControl, record.id, member ? 'member' : 'public')) {
    throw new PublicationMetadataNotFoundError();
  }
  if (record.deletedAt !== null) {
    const deletedAt = Date.parse(record.deletedAt);
    if (!Number.isFinite(deletedAt) || (ports.now?.() ?? new Date()).getTime() >= deletedAt + RETENTION_MS) {
      throw new PublicationMetadataConfirmedNotFoundError();
    }
    return Object.freeze({
      kind: 'gone',
      deletedAt: record.deletedAt,
      canonicalUrl: `${ports.origin}/c/${record.publicationSlug}`,
    });
  }
  if (!record.rootAvailable) throw new PublicationMetadataNotFoundError();
  const projection = member ? 'member' : 'public';
  const revision = `${record.contentRevision}.${record.policyRevision}`;
  const metadata = mapMetadata(ports.origin, record, revision);
  const validation = validators.validate('collectionMetadata', metadata);
  if (!validation.valid) {
    throw new Error(`Publication Collection Metadata failed COLP Schema validation: ${JSON.stringify(validation.errors)}`);
  }
  return Object.freeze({ kind: 'metadata', metadata: Object.freeze(metadata), projection, revision, updatedAt: record.updatedAt });
}

function mapMetadata(origin: string, record: PublicationMetadataRecord, revision: string): CollectionMetadata {
  const canonical = `${origin}/c/${record.publicationSlug}` as HttpUrl;
  return {
    collection: {
      schemaVersion: '0.1',
      id: record.id,
      canonicalUrl: canonical,
      slug: record.publicationSlug!,
      kind: record.kind,
      title: record.title,
      ...(record.summary === null ? {} : { summary: record.summary }),
      ...(record.tags.length === 0 ? {} : { tags: [...record.tags] }),
      ...(record.language === null ? {} : { language: record.language }),
      rootNodeId: record.rootNodeId,
      visibility: record.visibility,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision,
      extensions: {},
    },
    links: {
      self: `${origin}/colp/v0.1/collections/${record.id}` as HttpUrl,
      canonical,
      snapshot: `${origin}/colp/v0.1/collections/${record.id}/snapshot` as HttpUrl,
    },
  };
}
