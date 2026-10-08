import { createHash } from 'node:crypto';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Annotation, HttpUrl, Relation, Snapshot, SnapshotNode } from '@know-n/colp/types';
import { formatUtcDateTime } from '../domain/time.js';
import { serializeNetscapeBookmarkHtml } from './netscape-serializer.js';

/**
 * Owner or member export. JSON is the publication snapshot shape
 * (`access: authorized-private`, annotations included) even when the
 * collection has no publication slug. The publication HTTP reader refuses
 * those collections; export still has to return the owner's tree.
 */
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const ORDER_KEY = /^[0-9A-Za-z_-]{1,128}$/u;
const validators = createValidatorRegistry();

/**
 * Synchronous collection exports are intentionally smaller than the
 * asynchronous library export.  The read port performs a database-side
 * preflight before materializing rows and rejects a source above these caps.
 */
export const COLLECTION_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
export const COLLECTION_EXPORT_MAX_NODES = 50_000;
export const COLLECTION_EXPORT_MAX_ANNOTATIONS = 25_000;
export const COLLECTION_EXPORT_MAX_RELATIONS = 25_000;

export const COLLECTION_EXPORT_JSON_TYPE =
  'application/vnd.collection-protocol.snapshot+json; charset=utf-8';
export const COLLECTION_EXPORT_HTML_TYPE = 'text/html; charset=utf-8';

export class ExportCollectionError extends Error {
  readonly code: 'not_found' | 'invalid' | 'capacity';

  constructor(code: 'not_found' | 'invalid' | 'capacity', message: string) {
    super(message);
    this.name = 'ExportCollectionError';
    this.code = code;
  }
}

export class CollectionExportCapacityError extends ExportCollectionError {
  constructor(message = 'collection export exceeds the supported size limit') {
    super('capacity', message);
    this.name = 'CollectionExportCapacityError';
  }
}

export interface ExportNodeSource {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly isRoot: boolean;
  readonly title: string | null;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: 'inherit' | 'protected' | 'private';
  readonly position: string | null;
  readonly revision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ExportAnnotationSource {
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly creatorPrincipalId: string;
  readonly payload: unknown;
}

export interface ExportRelationSource {
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly payload: unknown;
}

export interface ExportCollectionSource {
  readonly id: string;
  readonly access: 'owner' | 'editor' | 'viewer';
  readonly title: string;
  readonly summary: string | null;
  readonly kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
  readonly publicationSlug: string | null;
  readonly rootNodeId: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly nodes: readonly ExportNodeSource[];
  readonly annotations: readonly ExportAnnotationSource[];
  readonly relations: readonly ExportRelationSource[];
}

export interface CollectionExportReadPort {
  loadForPrincipal(input: {
    readonly collectionId: string;
    readonly subjectId: string;
    readonly signal?: AbortSignal;
  }): Promise<ExportCollectionSource | null>;
  listOwnedIds(ownerSubjectId: string): Promise<readonly string[]>;
}

export interface CollectionExportEntry {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly version: string;
}

export interface BuiltCollectionExport {
  readonly snapshot: Snapshot;
  readonly filenameSlug: string;
  readonly entry: CollectionExportEntry;
}

export interface RenderedCollectionExport {
  readonly filename: string;
  readonly contentType: string;
  readonly body: string;
  readonly entry: CollectionExportEntry;
}

export function collectionExportSlug(
  publicationSlug: string | null,
  title: string,
  id: string,
): string {
  const published = safeSlug(publicationSlug ?? '');
  if (published !== undefined) return published;
  const fromTitle = safeSlug(title.normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80));
  if (fromTitle !== undefined) return fromTitle;
  return safeSlug(id) ?? 'collection';
}

export function buildCollectionExport(
  source: ExportCollectionSource,
  input: { readonly principalId: string; readonly origin: string },
): BuiltCollectionExport {
  const snapshot = snapshotFromSource(source, input);
  const structural = validators.validate('snapshot', snapshot);
  if (!structural.valid) {
    throw new ExportCollectionError('invalid', 'collection export is not a valid COLP snapshot');
  }
  const filenameSlug = collectionExportSlug(source.publicationSlug, source.title, source.id);
  return {
    snapshot,
    filenameSlug,
    entry: {
      id: source.id,
      slug: filenameSlug,
      title: source.title,
      version: snapshot.revision,
    },
  };
}

export function renderCollectionExport(
  source: ExportCollectionSource,
  input: {
    readonly principalId: string;
    readonly origin: string;
    readonly format: 'json' | 'html';
  },
): RenderedCollectionExport {
  const built = buildCollectionExport(source, input);
  const html = input.format === 'html';
  const body = html
    ? serializeNetscapeBookmarkHtml(built.snapshot)
    : `${JSON.stringify(built.snapshot, null, 2)}\n`;
  if (Buffer.byteLength(body, 'utf8') > COLLECTION_EXPORT_MAX_BYTES) {
    throw new CollectionExportCapacityError();
  }
  return {
    filename: `${built.filenameSlug}.${html ? 'html' : 'json'}`,
    contentType: html ? COLLECTION_EXPORT_HTML_TYPE : COLLECTION_EXPORT_JSON_TYPE,
    body,
    entry: built.entry,
  };
}

function snapshotFromSource(
  source: ExportCollectionSource,
  input: { readonly principalId: string; readonly origin: string },
): Snapshot {
  const root = source.nodes.find((node) => node.isRoot && node.id === source.rootNodeId)
    ?? source.nodes.find((node) => node.isRoot);
  if (root === undefined) throw new ExportCollectionError('invalid', 'collection export is missing its root');
  const revision = coerceOpaque(`${source.contentRevision}.${source.policyRevision}`, source.id);
  const positions = positionsFor(source.nodes, root.id);
  const present = new Set(source.nodes.map((node) => node.id));
  const nodes: SnapshotNode[] = source.nodes.map((node) => mapNode(node, source.id, root.id, positions, present));
  const canonicalUrl = canonicalCollectionUrl(input.origin, source.publicationSlug);
  const filenameSlug = collectionExportSlug(source.publicationSlug, source.title, source.id);
  return {
    protocolVersion: '0.1',
    snapshotId: coerceOpaque(`export.${source.id}.${revision}`, `snapshot:${source.id}`),
    mode: 'publication',
    complete: true,
    collection: {
      schemaVersion: '0.1',
      id: requireOpaque(source.id, 'collection id'),
      ...(canonicalUrl === undefined ? {} : { canonicalUrl: canonicalUrl as HttpUrl }),
      ...(source.publicationSlug === null ? { slug: filenameSlug } : { slug: source.publicationSlug }),
      kind: source.kind,
      title: source.title,
      ...(source.summary === null ? {} : { summary: source.summary }),
      rootNodeId: requireOpaque(root.id, 'root id'),
      visibility: source.visibility,
      createdAt: formatUtcDateTime(source.createdAt),
      updatedAt: formatUtcDateTime(source.updatedAt),
      revision,
    },
    nodes,
    annotations: visibleAnnotations(source.annotations, input.principalId),
    attachments: [],
    relations: visibleRelations(source.relations, source.access),
    tombstones: [],
    revision,
    generatedAt: formatUtcDateTime(source.updatedAt),
    page: { nextCursor: null, hasMore: false, sequence: 1 },
    warnings: [],
  };
}

function mapNode(
  node: ExportNodeSource,
  collectionId: string,
  rootId: string,
  positions: ReadonlyMap<string, string | null>,
  present: ReadonlySet<string>,
): SnapshotNode {
  const id = requireOpaque(node.id, 'node id');
  const tags = uniqueTags(node.tags);
  const common = {
    id,
    collectionId: requireOpaque(collectionId, 'collection id'),
    createdAt: formatUtcDateTime(node.createdAt),
    updatedAt: formatUtcDateTime(node.updatedAt),
    revision: coerceOpaque(node.revision, `node:${id}`),
    ...(node.description === null ? {} : { description: node.description }),
    ...(tags === undefined ? {} : { tags }),
  };
  if (node.isRoot || node.id === rootId) {
    return {
      ...common,
      kind: 'root',
      parentId: null,
      position: null,
      folderRole: 'root',
      title: node.title ?? '',
    };
  }
  const visibility = node.visibility === 'inherit' ? {} : { visibility: node.visibility };
  const parentId = node.parentId !== null && present.has(node.parentId) && node.parentId !== node.id
    ? node.parentId
    : rootId;
  const position = positions.get(node.id) ?? 'z000000';
  if (node.kind === 'folder') {
    return { ...common, ...visibility, kind: 'folder', parentId: requireOpaque(parentId, 'parent id'), position, title: node.title ?? '' };
  }
  if (node.kind === 'separator') {
    return { ...common, ...visibility, kind: 'separator', parentId: requireOpaque(parentId, 'parent id'), position };
  }
  if (node.url === null || node.url.length === 0) {
    throw new ExportCollectionError('invalid', `bookmark ${id} is missing a url`);
  }
  return {
    ...common,
    ...visibility,
    kind: 'bookmark',
    parentId: requireOpaque(parentId, 'parent id'),
    position,
    title: node.title ?? '',
    url: node.url,
  };
}

function positionsFor(nodes: readonly ExportNodeSource[], rootId: string): Map<string, string | null> {
  const assigned = new Map<string, string | null>();
  const groups = new Map<string, ExportNodeSource[]>();
  for (const node of nodes) {
    if (node.isRoot || node.id === rootId) {
      assigned.set(node.id, null);
      continue;
    }
    const parent = node.parentId !== null && node.parentId.length > 0 ? node.parentId : rootId;
    const group = groups.get(parent) ?? [];
    group.push(node);
    groups.set(parent, group);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => {
      const leftPosition = left.position ?? '';
      const rightPosition = right.position ?? '';
      if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
    const used = new Set<string>();
    sorted.forEach((node, index) => {
      let token = node.position !== null && ORDER_KEY.test(node.position) ? node.position : '';
      if (token.length === 0 || used.has(token)) {
        let sequence = index;
        do {
          token = `z${sequence.toString(36).padStart(6, '0')}`;
          sequence += 1;
        } while (used.has(token));
      }
      used.add(token);
      assigned.set(node.id, token);
    });
  }
  return assigned;
}

function visibleAnnotations(
  rows: readonly ExportAnnotationSource[],
  principalId: string,
): Annotation[] {
  const annotations: Annotation[] = [];
  for (const row of rows) {
    if (row.visibility === 'private' && row.creatorPrincipalId !== principalId) continue;
    if (!validators.validate('annotation', row.payload).valid) continue;
    const payload = row.payload as Annotation;
    if (payload.visibility !== row.visibility) continue;
    annotations.push(payload);
  }
  return annotations;
}

function visibleRelations(
  rows: readonly ExportRelationSource[],
  access: ExportCollectionSource['access'],
): Relation[] {
  const allowPrivate = access === 'owner' || access === 'editor';
  const relations: Relation[] = [];
  for (const row of rows) {
    if (row.visibility === 'private' && !allowPrivate) continue;
    if (!validators.validate('relation', row.payload).valid) continue;
    const payload = row.payload as Relation;
    if (payload.visibility !== row.visibility) continue;
    relations.push(payload);
  }
  return relations;
}

function uniqueTags(tags: readonly string[]): readonly string[] | undefined {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag);
  }
  return unique.length > 0 ? unique : undefined;
}

function canonicalCollectionUrl(origin: string, slug: string | null): string | undefined {
  if (slug === null || slug.length === 0) return undefined;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return undefined;
  }
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username !== '' || base.password !== '') {
    return undefined;
  }
  return new URL(`/c/${encodeURIComponent(slug)}`, base.origin).href;
}

function safeSlug(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._~-]{1,200}$/u.test(trimmed)) return undefined;
  if (trimmed === '.' || trimmed === '..') return undefined;
  return trimmed;
}

function requireOpaque(value: string, label: string): string {
  if (!OPAQUE_ID.test(value)) throw new ExportCollectionError('invalid', `${label} is not a COLP id`);
  return value;
}

function coerceOpaque(value: string, seed: string): string {
  if (OPAQUE_ID.test(value)) return value;
  const digest = createHash('sha256').update(`${seed}\n${value}`).digest('base64url').slice(0, 32);
  return `id-${digest}`;
}
