/**
 * ADR-0007 expand: deterministic canonical resource payload materialization.
 *
 * Relational columns remain the constraint Owner for structure fields.
 * payload_json holds the full protocol-oriented representation plus kind-specific
 * fields and extensions. Overlapping fields are same-transaction materialization
 * copies and must equal the relational projection (dual-read equality).
 *
 * Phase 1 only supports collections and nodes. Unsupported resource kinds are
 * never fabricated.
 */

import { canonicalJson } from '../../commands/index.js';
import type { JsonObject, JsonValue } from './canonical-mutation.js';
import { formatUtcDateTime } from './time.js';
import {
  COLLECTION_KINDS,
  NODE_KINDS,
  NODE_VISIBILITIES,
  assertValidHttpUrlNoUserInfo,
  assertValidNodeDescription,
  assertValidNodeTags,
  type CollectionKind,
  type NodeKind,
  type NodeVisibility,
} from './validation.js';

/** Storage schema version for resource payload_json (not outbox event_version). */
export const RESOURCE_PAYLOAD_SCHEMA_VERSION = 1 as const;

export type ResourcePayloadAuthorityStatus =
  | 'pending'
  | 'backfilled'
  | 'malformed';

export const RESOURCE_PAYLOAD_AUTHORITY_STATUSES = Object.freeze([
  'pending',
  'backfilled',
  'malformed',
] as const);

export type ResourcePayloadResourceType = 'collection' | 'node';

export interface CollectionRelationalProjection {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: string;
  readonly visibility: string;
  readonly allowSearchIndexing?: boolean;
  readonly rootNodeId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly commitOrdinal: bigint | number | string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly deletedAt: Date | string | null;
}

export interface NodeRelationalProjection {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly isRoot: boolean;
  readonly title: string | null;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: unknown;
  readonly visibility: string;
  readonly positionToken: string | null;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly deletedAt: Date | string | null;
  readonly deletedCommitOrdinal: bigint | number | string | null;
}

export type MaterializeOk = {
  readonly ok: true;
  readonly payload: JsonObject;
  readonly schemaVersion: typeof RESOURCE_PAYLOAD_SCHEMA_VERSION;
};

export type MaterializeMalformed = {
  readonly ok: false;
  readonly reason: string;
  readonly fieldPath?: string;
};

export type MaterializeResult = MaterializeOk | MaterializeMalformed;

export interface PayloadFieldMismatch {
  readonly path: string;
  readonly expected: JsonValue | undefined;
  readonly actual: JsonValue | undefined;
}

export interface ResourcePayloadComparison {
  readonly equal: boolean;
  readonly mismatches: readonly PayloadFieldMismatch[];
  readonly resourceType: ResourcePayloadResourceType;
  readonly resourceId: string;
}

const COLLECTION_VISIBILITIES = new Set([
  'private',
  'protected',
  'public',
  'unlisted',
]);
const COLLECTION_KIND_SET = new Set<string>(COLLECTION_KINDS);
const NODE_KIND_SET = new Set<string>([...NODE_KINDS, 'separator']);
const NODE_VISIBILITY_SET = new Set<string>(NODE_VISIBILITIES);
const REVISION_TOKEN = /^[A-Za-z0-9._~-]{1,128}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function formatCanonicalTime(value: Date | string, path: string): MaterializeResult | string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { ok: false, reason: `${path} is not a valid timestamp`, fieldPath: path };
    }
    return formatUtcDateTime(value);
  }
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: `${path} is required`, fieldPath: path };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: `${path} is not a valid timestamp`, fieldPath: path };
  }
  // Prefer already-canonical Z strings without inventing a different encoding.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return formatUtcDateTime(parsed);
  }
  return formatUtcDateTime(parsed);
}

function formatOptionalTime(
  value: Date | string | null,
  path: string,
): MaterializeResult | string | null {
  if (value === null) return null;
  return formatCanonicalTime(value, path);
}

function ordinalToString(
  value: bigint | number | string,
  path: string,
): MaterializeResult | string {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      return { ok: false, reason: `${path} must be non-negative`, fieldPath: path };
    }
    return value.toString(10);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
      return { ok: false, reason: `${path} must be a non-negative safe integer`, fieldPath: path };
    }
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return value;
  }
  return { ok: false, reason: `${path} is not a valid ordinal`, fieldPath: path };
}

function optionalOrdinalToString(
  value: bigint | number | string | null,
  path: string,
): MaterializeResult | string | null {
  if (value === null) return null;
  return ordinalToString(value, path);
}

function parseTags(value: unknown, path: string): MaterializeResult | readonly string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    return { ok: false, reason: `${path} must be a JSON array or null`, fieldPath: path };
  }
  try {
    return assertValidNodeTags(value as readonly string[]);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : `${path} is invalid`,
      fieldPath: path,
    };
  }
}

function assertRevision(value: unknown, path: string): MaterializeResult | string {
  if (!isNonEmptyString(value) || !REVISION_TOKEN.test(value)) {
    return { ok: false, reason: `${path} is not a valid revision token`, fieldPath: path };
  }
  return value;
}

/**
 * Build the deterministic collection payload from relational Owner fields.
 * Returns malformed when legacy rows violate domain invariants (no fabrication).
 */
export function materializeCollectionPayload(
  row: CollectionRelationalProjection,
): MaterializeResult {
  if (!isNonEmptyString(row.id)) {
    return { ok: false, reason: 'id is required', fieldPath: 'id' };
  }
  if (!isNonEmptyString(row.ownerSubjectId)) {
    return { ok: false, reason: 'ownerSubjectId is required', fieldPath: 'ownerSubjectId' };
  }
  if (!isNonEmptyString(row.title) || row.title.length > 512 || row.title.trim().length === 0) {
    return { ok: false, reason: 'title is invalid', fieldPath: 'title' };
  }
  if (row.summary !== null) {
    if (typeof row.summary !== 'string' || row.summary.length > 2000) {
      return { ok: false, reason: 'summary is invalid', fieldPath: 'summary' };
    }
  }
  if (!COLLECTION_KIND_SET.has(row.kind)) {
    return { ok: false, reason: 'kind is not a Phase 1 collection kind', fieldPath: 'kind' };
  }
  if (!COLLECTION_VISIBILITIES.has(row.visibility)) {
    return { ok: false, reason: 'visibility is invalid', fieldPath: 'visibility' };
  }
  if (row.allowSearchIndexing !== undefined && typeof row.allowSearchIndexing !== 'boolean') {
    return { ok: false, reason: 'allowSearchIndexing is invalid', fieldPath: 'allowSearchIndexing' };
  }
  if (!isNonEmptyString(row.rootNodeId)) {
    return { ok: false, reason: 'rootNodeId is required', fieldPath: 'rootNodeId' };
  }

  const resourceRevisionResult = assertRevision(row.resourceRevision, 'resourceRevision');
  if (typeof resourceRevisionResult !== 'string') return resourceRevisionResult;
  const resourceRevision = resourceRevisionResult;
  const contentRevisionResult = assertRevision(row.contentRevision, 'contentRevision');
  if (typeof contentRevisionResult !== 'string') return contentRevisionResult;
  const contentRevision = contentRevisionResult;
  const policyRevisionResult = assertRevision(row.policyRevision, 'policyRevision');
  if (typeof policyRevisionResult !== 'string') return policyRevisionResult;
  const policyRevision = policyRevisionResult;

  const commitOrdinalResult = ordinalToString(row.commitOrdinal, 'commitOrdinal');
  if (typeof commitOrdinalResult !== 'string') return commitOrdinalResult;
  const commitOrdinal = commitOrdinalResult;

  const createdAtResult = formatCanonicalTime(row.createdAt, 'createdAt');
  if (typeof createdAtResult !== 'string') return createdAtResult;
  const createdAt = createdAtResult;
  const updatedAtResult = formatCanonicalTime(row.updatedAt, 'updatedAt');
  if (typeof updatedAtResult !== 'string') return updatedAtResult;
  const updatedAt = updatedAtResult;
  const deletedAtResult = formatOptionalTime(row.deletedAt, 'deletedAt');
  if (deletedAtResult !== null && typeof deletedAtResult !== 'string') return deletedAtResult;
  const deletedAt = deletedAtResult;

  const payload: JsonObject = {
    schemaVersion: RESOURCE_PAYLOAD_SCHEMA_VERSION,
    resourceType: 'collection',
    id: row.id,
    ownerSubjectId: row.ownerSubjectId,
    title: row.title,
    summary: row.summary,
    kind: row.kind as CollectionKind,
    visibility: row.visibility,
    allowSearchIndexing: row.allowSearchIndexing ?? false,
    rootNodeId: row.rootNodeId,
    resourceRevision,
    contentRevision,
    policyRevision,
    commitOrdinal,
    createdAt,
    updatedAt,
    deletedAt,
    extensions: {},
  };

  return {
    ok: true,
    payload,
    schemaVersion: RESOURCE_PAYLOAD_SCHEMA_VERSION,
  };
}

/**
 * Build the deterministic node payload from relational Owner fields.
 * Root rows (is_root) materialize folderRole/root parent/position copies.
 */
export function materializeNodePayload(row: NodeRelationalProjection): MaterializeResult {
  if (!isNonEmptyString(row.id)) {
    return { ok: false, reason: 'id is required', fieldPath: 'id' };
  }
  if (!isNonEmptyString(row.collectionId)) {
    return { ok: false, reason: 'collectionId is required', fieldPath: 'collectionId' };
  }
  if (!NODE_KIND_SET.has(row.kind)) {
    return { ok: false, reason: 'kind is not a Phase 1 node kind', fieldPath: 'kind' };
  }
  if (typeof row.isRoot !== 'boolean') {
    return { ok: false, reason: 'isRoot is required', fieldPath: 'isRoot' };
  }
  if (row.kind === 'separator' ? row.title !== null
    : !isNonEmptyString(row.title) || row.title.length > 512 || row.title.trim().length === 0) {
    return { ok: false, reason: 'title is invalid', fieldPath: 'title' };
  }
  if (!NODE_VISIBILITY_SET.has(row.visibility)) {
    return { ok: false, reason: 'visibility is invalid', fieldPath: 'visibility' };
  }

  if (row.isRoot) {
    if (row.kind !== 'folder') {
      return { ok: false, reason: 'root node must be folder kind', fieldPath: 'kind' };
    }
    if (row.parentId !== null) {
      return { ok: false, reason: 'root parentId must be null', fieldPath: 'parentId' };
    }
    if (row.positionToken !== null) {
      return { ok: false, reason: 'root positionToken must be null', fieldPath: 'positionToken' };
    }
    if (row.url !== null) {
      return { ok: false, reason: 'root url must be null', fieldPath: 'url' };
    }
  } else {
    if (!isNonEmptyString(row.parentId)) {
      return { ok: false, reason: 'non-root parentId is required', fieldPath: 'parentId' };
    }
    if (!isNonEmptyString(row.positionToken)) {
      return { ok: false, reason: 'non-root positionToken is required', fieldPath: 'positionToken' };
    }
  }

  if (row.kind === 'bookmark') {
    if (!isNonEmptyString(row.url)) {
      return { ok: false, reason: 'bookmark url is required', fieldPath: 'url' };
    }
    try {
      assertValidHttpUrlNoUserInfo(row.url);
    } catch (error: unknown) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'bookmark url is invalid',
        fieldPath: 'url',
      };
    }
  } else if (row.url !== null) {
    return { ok: false, reason: 'non-Bookmark url must be null', fieldPath: 'url' };
  }

  try {
    assertValidNodeDescription(row.description);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'description is invalid',
      fieldPath: 'description',
    };
  }

  const tagsResult = parseTags(row.tags, 'tags');
  if (!Array.isArray(tagsResult)) {
    return tagsResult as MaterializeMalformed;
  }
  const tags = tagsResult;

  const resourceRevisionResult = assertRevision(row.resourceRevision, 'resourceRevision');
  if (typeof resourceRevisionResult !== 'string') return resourceRevisionResult;
  const resourceRevision = resourceRevisionResult;
  const childrenRevisionResult = assertRevision(row.childrenRevision, 'childrenRevision');
  if (typeof childrenRevisionResult !== 'string') return childrenRevisionResult;
  const childrenRevision = childrenRevisionResult;

  const createdAtResult = formatCanonicalTime(row.createdAt, 'createdAt');
  if (typeof createdAtResult !== 'string') return createdAtResult;
  const createdAt = createdAtResult;
  const updatedAtResult = formatCanonicalTime(row.updatedAt, 'updatedAt');
  if (typeof updatedAtResult !== 'string') return updatedAtResult;
  const updatedAt = updatedAtResult;
  const deletedAtResult = formatOptionalTime(row.deletedAt, 'deletedAt');
  if (deletedAtResult !== null && typeof deletedAtResult !== 'string') return deletedAtResult;
  const deletedAt = deletedAtResult;

  const deletedCommitOrdinalResult = optionalOrdinalToString(
    row.deletedCommitOrdinal,
    'deletedCommitOrdinal',
  );
  if (deletedCommitOrdinalResult !== null && typeof deletedCommitOrdinalResult !== 'string') {
    return deletedCommitOrdinalResult;
  }
  const deletedCommitOrdinal = deletedCommitOrdinalResult;
  if (row.deletedAt !== null && row.deletedCommitOrdinal === null) {
    return {
      ok: false,
      reason: 'deleted node must have deletedCommitOrdinal',
      fieldPath: 'deletedCommitOrdinal',
    };
  }
  if (row.deletedAt === null && row.deletedCommitOrdinal !== null) {
    return {
      ok: false,
      reason: 'live node cannot have deletedCommitOrdinal',
      fieldPath: 'deletedCommitOrdinal',
    };
  }

  const wireKind: NodeKind | 'separator' | 'root' = row.isRoot
    ? 'root' : (row.kind as NodeKind | 'separator');

  const payload: JsonObject = {
    schemaVersion: RESOURCE_PAYLOAD_SCHEMA_VERSION,
    resourceType: 'node',
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    kind: wireKind,
    isRoot: row.isRoot,
    ...(row.isRoot ? { folderRole: 'root', title: row.title, url: null }
      : row.kind === 'folder' ? { folderRole: null, title: row.title, url: null }
        : row.kind === 'bookmark' ? { folderRole: null, title: row.title, url: row.url }
          : {}),
    description: row.description,
    tags: [...tags],
    visibility: row.visibility as NodeVisibility,
    position: row.positionToken,
    resourceRevision,
    childrenRevision,
    createdAt,
    updatedAt,
    deletedAt,
    deletedCommitOrdinal,
    extensions: {},
  };

  return {
    ok: true,
    payload,
    schemaVersion: RESOURCE_PAYLOAD_SCHEMA_VERSION,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Validate a stored payload against the expand schema (schema/domain invariants). */
export function validateResourcePayload(
  resourceType: ResourcePayloadResourceType,
  payload: unknown,
): MaterializeResult {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'payload must be a plain object', fieldPath: '' };
  }
  if (payload.schemaVersion !== RESOURCE_PAYLOAD_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `payload.schemaVersion must be ${RESOURCE_PAYLOAD_SCHEMA_VERSION}`,
      fieldPath: 'schemaVersion',
    };
  }
  if (payload.resourceType !== resourceType) {
    return {
      ok: false,
      reason: `payload.resourceType must be ${resourceType}`,
      fieldPath: 'resourceType',
    };
  }
  if (!isPlainObject(payload.extensions)) {
    return { ok: false, reason: 'extensions must be a plain object', fieldPath: 'extensions' };
  }

  if (resourceType === 'collection') {
    if (payload.allowSearchIndexing !== undefined && typeof payload.allowSearchIndexing !== 'boolean') {
      return {
        ok: false,
        reason: 'payload.allowSearchIndexing must be a boolean',
        fieldPath: 'allowSearchIndexing',
      };
    }
    return materializeCollectionPayload({
      id: String(payload.id ?? ''),
      ownerSubjectId: String(payload.ownerSubjectId ?? ''),
      title: String(payload.title ?? ''),
      summary: payload.summary === null || payload.summary === undefined
        ? null
        : String(payload.summary),
      kind: String(payload.kind ?? ''),
      visibility: String(payload.visibility ?? ''),
      allowSearchIndexing: payload.allowSearchIndexing === true,
      rootNodeId: String(payload.rootNodeId ?? ''),
      resourceRevision: String(payload.resourceRevision ?? ''),
      contentRevision: String(payload.contentRevision ?? ''),
      policyRevision: String(payload.policyRevision ?? ''),
      commitOrdinal: String(payload.commitOrdinal ?? ''),
      createdAt: String(payload.createdAt ?? ''),
      updatedAt: String(payload.updatedAt ?? ''),
      deletedAt: payload.deletedAt === null || payload.deletedAt === undefined
        ? null
        : String(payload.deletedAt),
    });
  }

  return materializeNodePayload({
    id: String(payload.id ?? ''),
    collectionId: String(payload.collectionId ?? ''),
    parentId: payload.parentId === null || payload.parentId === undefined
      ? null
      : String(payload.parentId),
    kind: payload.kind === 'root' ? 'folder' : String(payload.kind ?? ''),
    isRoot: Boolean(payload.isRoot === true || payload.kind === 'root'),
    title: payload.kind === 'separator' && payload.title === undefined
      ? null
      : String(payload.title ?? ''),
    url: payload.url === null || payload.url === undefined ? null : String(payload.url),
    description: payload.description === null || payload.description === undefined
      ? null
      : String(payload.description),
    tags: payload.tags,
    visibility: String(payload.visibility ?? ''),
    positionToken: payload.position === null || payload.position === undefined
      ? null
      : String(payload.position),
    resourceRevision: String(payload.resourceRevision ?? ''),
    childrenRevision: String(payload.childrenRevision ?? ''),
    createdAt: String(payload.createdAt ?? ''),
    updatedAt: String(payload.updatedAt ?? ''),
    deletedAt: payload.deletedAt === null || payload.deletedAt === undefined
      ? null
      : String(payload.deletedAt),
    deletedCommitOrdinal: payload.deletedCommitOrdinal === null
      || payload.deletedCommitOrdinal === undefined
      ? null
      : String(payload.deletedCommitOrdinal),
  });
}

function collectMismatches(
  expected: unknown,
  actual: unknown,
  path: string,
  out: PayloadFieldMismatch[],
): void {
  if (expected === actual) return;
  if (
    typeof expected === 'object'
    && expected !== null
    && typeof actual === 'object'
    && actual !== null
    && !Array.isArray(expected)
    && !Array.isArray(actual)
  ) {
    const expectedKeys = new Set(Object.keys(expected as object));
    const actualKeys = new Set(Object.keys(actual as object));
    for (const key of new Set([...expectedKeys, ...actualKeys])) {
      const child = path ? `${path}.${key}` : key;
      collectMismatches(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        child,
        out,
      );
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max; i += 1) {
      collectMismatches(expected[i], actual[i], `${path}[${i}]`, out);
    }
    return;
  }
  out.push({
    path: path || '$',
    expected: expected as JsonValue | undefined,
    actual: actual as JsonValue | undefined,
  });
}

/**
 * Dual-read equality: relational projection materialization vs stored payload_json.
 * Mismatches are never silently accepted — callers must record telemetry.
 */
export function compareResourcePayload(input: {
  readonly resourceType: ResourcePayloadResourceType;
  readonly resourceId: string;
  readonly expected: JsonObject;
  readonly actual: unknown;
}): ResourcePayloadComparison {
  const mismatches: PayloadFieldMismatch[] = [];
  if (!isPlainObject(input.actual)) {
    mismatches.push({
      path: '$',
      expected: input.expected,
      actual: input.actual as JsonValue | undefined,
    });
    return {
      equal: false,
      mismatches,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    };
  }

  try {
    if (canonicalJson(input.expected) === canonicalJson(input.actual)) {
      return {
        equal: true,
        mismatches: [],
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      };
    }
  } catch {
    // Fall through to structural mismatch collection when canonicalization fails.
  }

  collectMismatches(input.expected, input.actual, '', mismatches);
  return {
    equal: mismatches.length === 0,
    mismatches,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  };
}

export function compareCollectionPayloadToRelational(
  row: CollectionRelationalProjection,
  storedPayload: unknown,
): ResourcePayloadComparison {
  const materialised = materializeCollectionPayload(row);
  if (!materialised.ok) {
    return {
      equal: false,
      mismatches: [{
        path: materialised.fieldPath ?? '$',
        expected: undefined,
        actual: storedPayload as JsonValue | undefined,
      }],
      resourceType: 'collection',
      resourceId: row.id,
    };
  }
  let compatiblePayload = storedPayload;
  if (isPlainObject(compatiblePayload) && compatiblePayload.allowSearchIndexing === undefined) {
    compatiblePayload = { ...compatiblePayload, allowSearchIndexing: false };
  }
  return compareResourcePayload({
    resourceType: 'collection',
    resourceId: row.id,
    expected: materialised.payload,
    actual: compatiblePayload,
  });
}

export function compareNodePayloadToRelational(
  row: NodeRelationalProjection,
  storedPayload: unknown,
): ResourcePayloadComparison {
  const materialised = materializeNodePayload(row);
  if (!materialised.ok) {
    return {
      equal: false,
      mismatches: [{
        path: materialised.fieldPath ?? '$',
        expected: undefined,
        actual: storedPayload as JsonValue | undefined,
      }],
      resourceType: 'node',
      resourceId: row.id,
    };
  }
  return compareResourcePayload({
    resourceType: 'node',
    resourceId: row.id,
    expected: materialised.payload,
    actual: storedPayload,
  });
}
