import { createHash } from 'node:crypto';
import { createValidatorRegistry, isRfc3339DateTime } from '@know-n/colp/schema';
import {
  buildAnonymousCollectionDirectory,
  buildPublicationAuthorizedCollectionDirectory,
  createAnonymousCollectionDirectoryPage,
  createPublicationAuthorizedDirectoryPage,
  createPublicationDirectoryFilterDigest,
  DEFAULT_PUBLICATION_DIRECTORY_SORT,
  selectAnonymousDirectoryCandidates,
  selectPublicationAuthorizedDirectoryCandidates,
} from '@know-n/colp/server';
import type { CollectionDirectory, DirectoryCollection, HttpUrl } from '@know-n/colp/types';
import type { PublicationCursorKeyring } from './cursor-keyring.js';
import {
  PublicationDirectoryAnchorNotFoundError,
  type PublicationDirectoryFilter,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
} from './directory-read.js';
import type { PublicationPrincipal } from './snapshot-query.js';

export const PUBLICATION_DIRECTORY_DEFAULT_LIMIT = 50;
export const PUBLICATION_DIRECTORY_MAX_LIMIT = 500;

export interface PublicationDirectoryQueryPorts {
  readonly reads: PublicationDirectoryReadPort;
  readonly cursors: PublicationCursorKeyring;
  readonly origin: string;
  readonly maxPageSize?: number;
}

export interface PublicationDirectoryQueryInput {
  readonly principal: PublicationPrincipal;
  readonly query?: PublicationDirectoryFilter & {
    readonly limit?: number;
    readonly cursor?: string;
  };
}

export interface PublicationDirectoryPageResult {
  readonly directory: Readonly<CollectionDirectory>;
  readonly projection: 'public' | 'member';
  readonly nextCursor: string | null;
}

export class PublicationDirectoryCursorError extends Error {
  readonly code = 'invalid_cursor_scope';
  constructor() {
    super('Publication Directory cursor is invalid for this request scope.');
    this.name = 'PublicationDirectoryCursorError';
  }
}

export class PublicationDirectoryInvalidQueryError extends TypeError {
  readonly code = 'invalid_query';
  constructor() {
    super('Publication Directory query is invalid.');
    this.name = 'PublicationDirectoryInvalidQueryError';
  }
}

const validators = createValidatorRegistry();

/** Shared COLP schema guard used by both the authoritative query and Redis hits. */
export function isValidPublicationCollectionDirectory(value: unknown): value is CollectionDirectory {
  return validators.validate('collectionDirectory', value).valid;
}

export async function getPublicationDirectoryPage(
  ports: PublicationDirectoryQueryPorts,
  input: PublicationDirectoryQueryInput,
  signal?: AbortSignal,
): Promise<PublicationDirectoryPageResult> {
  const normalized = normalizePublicationDirectoryQuery(input.query, ports.maxPageSize ?? PUBLICATION_DIRECTORY_MAX_LIMIT);
  const projection = input.principal.kind === 'anonymous' ? 'public' : 'member';
  const principal = input.principal.kind === 'anonymous'
    ? 'anonymous'
    : `account:${input.principal.principalId}`;
  const filterDigest = createPublicationDirectoryFilterDigest(normalized.filter);
  const cursorContext = {
    principal,
    filterDigest,
    sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
    limit: normalized.limit,
    protocolVersion: '0.1',
  };
  let after;
  if (normalized.cursor !== undefined) {
    const verification = ports.cursors.directory.verify(normalized.cursor, cursorContext);
    if (!verification.valid) throw new PublicationDirectoryCursorError();
    after = decodePosition(verification.nextPosition);
  }
  let records: readonly PublicationDirectoryRecord[];
  try {
    records = await ports.reads.loadPage({
      principal: input.principal.kind === 'anonymous'
        ? 'anonymous'
        : { subjectId: input.principal.subjectId },
      filter: normalized.filter,
      limit: normalized.limit,
      ...(after ? { after } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof PublicationDirectoryAnchorNotFoundError) throw new PublicationDirectoryCursorError();
    throw error;
  }
  const selected = records.slice(0, normalized.limit);
  const hasMore = records.length > normalized.limit;
  const last = selected.at(-1);
  const nextCursor = hasMore && last
    ? ports.cursors.directory.sign({
        ...cursorContext,
        nextPosition: encodePosition(last),
      })
    : null;
  const candidates = selected.map((record) => mapDirectoryCollection(ports.origin, record));
  let directory: Readonly<CollectionDirectory>;
  if (projection === 'public') {
    const candidateSet = selectAnonymousDirectoryCandidates(candidates);
    directory = buildAnonymousCollectionDirectory(createAnonymousCollectionDirectoryPage(
      candidateSet,
      { collections: candidateSet.collections, nextCursor },
    ));
  } else {
    const candidateSet = selectPublicationAuthorizedDirectoryCandidates(
      candidates,
      (candidate) => selected.find((record) => record.id === candidate.id)?.protectedAuthorized === true,
    );
    directory = buildPublicationAuthorizedCollectionDirectory(createPublicationAuthorizedDirectoryPage(
      candidateSet,
      { collections: candidateSet.collections, nextCursor },
    ));
  }
  const validation = validators.validate('collectionDirectory', directory);
  if (!validation.valid) {
    throw new Error(`Publication Directory failed COLP Schema validation: ${JSON.stringify(validation.errors)}`);
  }
  return Object.freeze({ directory, projection, nextCursor });
}

export function normalizePublicationDirectoryQuery(
  query: PublicationDirectoryQueryInput['query'],
  configuredMax: number,
): { readonly filter: PublicationDirectoryFilter; readonly limit: number; readonly cursor?: string } {
  const value = query ?? {};
  const invalid = (): never => { throw new PublicationDirectoryInvalidQueryError(); };
  const allowed = new Set(['tag', 'creator', 'kind', 'updatedSince', 'q', 'limit', 'cursor']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid();
  if (!Number.isSafeInteger(configuredMax) || configuredMax < 1) invalid();
  const max = Math.min(PUBLICATION_DIRECTORY_MAX_LIMIT, configuredMax);
  const limit = value.limit ?? Math.min(PUBLICATION_DIRECTORY_DEFAULT_LIMIT, max);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) invalid();
  const text = (field: keyof PublicationDirectoryFilter): string | undefined => {
    const candidate = value[field];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string' || candidate.trim() === '') invalid();
    return candidate.trim().normalize('NFC');
  };
  const updatedSince = text('updatedSince');
  const canonicalUpdatedSince = updatedSince === undefined ? undefined : canonicalizeDateTime(updatedSince);
  const kind = text('kind')?.toLocaleLowerCase('en-US');
  if (kind !== undefined && !['bookmarks', 'reading_path', 'knowledge_collection', 'mixed'].includes(kind)) {
    invalid();
  }
  const filter = Object.freeze({
    ...(text('tag') ? { tag: text('tag')!.toLocaleLowerCase('en-US') } : {}),
    ...(text('creator') ? { creator: text('creator')! } : {}),
    ...(kind ? { kind } : {}),
    ...(canonicalUpdatedSince ? { updatedSince: canonicalUpdatedSince } : {}),
    ...(text('q') ? { q: text('q')!.toLocaleLowerCase('en-US') } : {}),
  });
  return Object.freeze({
    filter,
    limit,
    ...(Object.hasOwn(value, 'cursor') ? { cursor: requireCursor(value.cursor) } : {}),
  });
}

function encodePosition(record: PublicationDirectoryRecord): string {
  if (!isExactOrderingMicros(record.orderingUpdatedAtMicros)) {
    throw new Error('Publication Directory row has invalid orderingUpdatedAtMicros');
  }
  return `${BigInt(record.orderingUpdatedAtMicros).toString(36)}~${createHash('sha256').update(record.id).digest('hex').slice(0, 32)}`;
}

function decodePosition(value: string): { readonly orderingUpdatedAtMicros: string; readonly idLocator: string } {
  const [compactMicros, idLocator, ...extra] = value.split('~');
  if (extra.length > 0 || !compactMicros || !/^-?[0-9a-z]{1,16}$/u.test(compactMicros) || !idLocator || !/^[0-9a-f]{32}$/u.test(idLocator)) {
    throw new PublicationDirectoryCursorError();
  }
  const orderingUpdatedAtMicros = parseBase36(compactMicros).toString(10);
  if (!isExactOrderingMicros(orderingUpdatedAtMicros)) throw new PublicationDirectoryCursorError();
  return { orderingUpdatedAtMicros, idLocator };
}

function requireCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new PublicationDirectoryInvalidQueryError();
  return value;
}

function canonicalizeDateTime(value: string): string {
  if (!isRfc3339DateTime(value) || /-00:00$/iu.test(value)) throw new PublicationDirectoryInvalidQueryError();
  const match = /^(\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) throw new PublicationDirectoryInvalidQueryError();
  const fraction = match[2] ?? '';
  const milliseconds = fraction.padEnd(3, '0').slice(0, 3);
  const instant = new Date(`${match[1]}.${milliseconds}${match[3]}`);
  if (!Number.isFinite(instant.getTime())) throw new PublicationDirectoryInvalidQueryError();
  const significantFraction = fraction.replace(/0+$/u, '');
  return `${instant.toISOString().slice(0, 19)}${significantFraction ? `.${significantFraction}` : ''}Z`;
}

function isExactOrderingMicros(value: string): boolean {
  return /^-?\d{1,20}$/u.test(value);
}

function parseBase36(value: string): bigint {
  const negative = value.startsWith('-');
  let result = 0n;
  for (const character of negative ? value.slice(1) : value) {
    const digit = BigInt(Number.parseInt(character, 36));
    result = result * 36n + digit;
  }
  return negative ? -result : result;
}

function mapDirectoryCollection(origin: string, record: PublicationDirectoryRecord): DirectoryCollection {
  return {
    id: record.id,
    canonicalUrl: `${origin}/c/${record.publicationSlug}` as HttpUrl,
    title: record.title,
    ...(record.summary === null ? {} : { summary: record.summary }),
    kind: record.kind,
    ...(record.tags.length === 0 ? {} : { tags: [...record.tags] }),
    ...(record.language === null ? {} : { language: record.language }),
    nodeCount: record.nodeCount,
    updatedAt: record.updatedAt,
    visibility: record.visibility,
    links: {
      self: `${origin}/colp/v0.1/collections/${record.id}` as HttpUrl,
      canonical: `${origin}/c/${record.publicationSlug}` as HttpUrl,
      snapshot: `${origin}/colp/v0.1/collections/${record.id}/snapshot` as HttpUrl,
    },
    extensions: {},
  };
}
