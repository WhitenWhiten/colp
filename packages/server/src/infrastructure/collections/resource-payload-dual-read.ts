/**
 * ADR-0007 expand dual-read: compare relational projections with payload_json
 * and emit comparison telemetry. Expand window must not fail production reads
 * on mismatch — only record metrics (write-path fail-closed arrives with dual-write).
 */

import type { Kysely } from 'kysely';
import type { Metrics } from '../telemetry/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  compareCollectionPayloadToRelational,
  compareNodePayloadToRelational,
  materializeCollectionPayload,
  materializeNodePayload,
  type CollectionRelationalProjection,
  type NodeRelationalProjection,
  type ResourcePayloadAuthorityStatus,
  type ResourcePayloadComparison,
  type ResourcePayloadResourceType,
} from '../../modules/collections/index.js';

export interface ResourceAuthorityBackfillStats {
  readonly scanned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly malformed: number;
}

export interface ResourceAuthorityScanResult {
  readonly collections: {
    readonly scanned: number;
    readonly matched: number;
    readonly mismatched: number;
    readonly missingPayload: number;
    readonly malformed: number;
    readonly mismatches: readonly ResourcePayloadComparison[];
  };
  readonly nodes: {
    readonly scanned: number;
    readonly matched: number;
    readonly mismatched: number;
    readonly missingPayload: number;
    readonly malformed: number;
    readonly mismatches: readonly ResourcePayloadComparison[];
  };
}

export interface ResourcePayloadBackfillRowResult {
  readonly resourceType: ResourcePayloadResourceType;
  readonly resourceId: string;
  readonly status: ResourcePayloadAuthorityStatus;
  readonly reason?: string;
}

const METRIC_MISMATCH = 'resource_authority_mismatch_total';
const METRIC_BACKFILL_SCANNED = 'resource_authority_backfill_scanned_total';
const METRIC_BACKFILL_SUCCEEDED = 'resource_authority_backfill_succeeded_total';
const METRIC_BACKFILL_FAILED = 'resource_authority_backfill_failed_total';
const METRIC_BACKFILL_SKIPPED = 'resource_authority_backfill_skipped_total';
const METRIC_BACKFILL_MALFORMED = 'resource_authority_backfill_malformed_total';

function mapCollectionRow(row: {
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  kind: string;
  visibility: string;
  allow_search_indexing?: boolean;
  root_node_id: string;
  resource_revision: string;
  content_revision: string;
  policy_revision: string;
  commit_ordinal: bigint | string | number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}): CollectionRelationalProjection {
  return {
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    visibility: row.visibility,
    allowSearchIndexing: row.allow_search_indexing ?? false,
    rootNodeId: row.root_node_id,
    resourceRevision: row.resource_revision,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    commitOrdinal: row.commit_ordinal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapNodeRow(row: {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: string;
  is_root: boolean;
  title: string | null;
  url: string | null;
  description: string | null;
  tags: unknown;
  visibility: string;
  position_token: string | null;
  resource_revision: string;
  children_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_commit_ordinal: bigint | string | number | null;
}): NodeRelationalProjection {
  return {
    id: row.id,
    collectionId: row.collection_id,
    parentId: row.parent_id,
    kind: row.kind,
    isRoot: row.is_root,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: row.tags,
    visibility: row.visibility,
    positionToken: row.position_token,
    resourceRevision: row.resource_revision,
    childrenRevision: row.children_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedCommitOrdinal: row.deleted_commit_ordinal,
  };
}

function recordMismatch(metrics: Metrics | undefined, comparison: ResourcePayloadComparison): void {
  if (!metrics || comparison.equal) return;
  metrics.increment(METRIC_MISMATCH);
  // Label-style secondary counters for resource kind (expand window diagnostics).
  metrics.increment(`${METRIC_MISMATCH}.${comparison.resourceType}`);
}

/**
 * Dual-read one collection row. Never throws on mismatch in expand window.
 */
export function dualReadCollectionPayload(
  row: {
    id: string;
    owner_subject_id: string;
    title: string;
    summary: string | null;
    kind: string;
    visibility: string;
    allow_search_indexing?: boolean;
    root_node_id: string;
    resource_revision: string;
    content_revision: string;
    policy_revision: string;
    commit_ordinal: bigint | string | number;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
    payload_json: unknown | null;
  },
  metrics?: Metrics,
): ResourcePayloadComparison {
  const comparison = compareCollectionPayloadToRelational(
    mapCollectionRow(row),
    row.payload_json,
  );
  recordMismatch(metrics, comparison);
  return comparison;
}

/**
 * Dual-read one node row. Never throws on mismatch in expand window.
 */
export function dualReadNodePayload(
  row: {
    id: string;
    collection_id: string;
    parent_id: string | null;
    kind: string;
    is_root: boolean;
    title: string | null;
    url: string | null;
    description: string | null;
    tags: unknown;
    visibility: string;
    position_token: string | null;
    resource_revision: string;
    children_revision: string;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
    deleted_commit_ordinal: bigint | string | number | null;
    payload_json: unknown | null;
  },
  metrics?: Metrics,
): ResourcePayloadComparison {
  const comparison = compareNodePayloadToRelational(mapNodeRow(row), row.payload_json);
  recordMismatch(metrics, comparison);
  return comparison;
}

/**
 * Full-table dual-read scan for PostgreSQL evidence / ops jobs.
 * Expand semantics: record mismatches, do not mutate rows.
 */
export async function scanResourceAuthorityMismatches(
  db: Kysely<DatabaseSchema>,
  metrics?: Metrics,
): Promise<ResourceAuthorityScanResult> {
  const collectionRows = await db
    .selectFrom('collections')
    .select([
      'id',
      'owner_subject_id',
      'title',
      'summary',
      'kind',
      'visibility',
      'allow_search_indexing',
      'root_node_id',
      'resource_revision',
      'content_revision',
      'policy_revision',
      'commit_ordinal',
      'created_at',
      'updated_at',
      'deleted_at',
      'payload_json',
      'payload_authority_status',
    ])
    .execute();

  const nodeRows = await db
    .selectFrom('nodes')
    .select([
      'id',
      'collection_id',
      'parent_id',
      'kind',
      'is_root',
      'title',
      'url',
      'description',
      'tags',
      'visibility',
      'position_token',
      'resource_revision',
      'children_revision',
      'created_at',
      'updated_at',
      'deleted_at',
      'deleted_commit_ordinal',
      'payload_json',
      'payload_authority_status',
    ])
    .execute();

  const collectionMismatches: ResourcePayloadComparison[] = [];
  let collectionMatched = 0;
  let collectionMissing = 0;
  let collectionMalformed = 0;

  for (const row of collectionRows) {
    if (row.payload_authority_status === 'malformed') {
      collectionMalformed += 1;
      continue;
    }
    if (row.payload_json == null) {
      collectionMissing += 1;
      const comparison: ResourcePayloadComparison = {
        equal: false,
        mismatches: [{ path: 'payload_json', expected: undefined, actual: null }],
        resourceType: 'collection',
        resourceId: row.id,
      };
      collectionMismatches.push(comparison);
      recordMismatch(metrics, comparison);
      continue;
    }
    const comparison = dualReadCollectionPayload(row, metrics);
    if (comparison.equal) collectionMatched += 1;
    else collectionMismatches.push(comparison);
  }

  const nodeMismatches: ResourcePayloadComparison[] = [];
  let nodeMatched = 0;
  let nodeMissing = 0;
  let nodeMalformed = 0;

  for (const row of nodeRows) {
    if (row.payload_authority_status === 'malformed') {
      nodeMalformed += 1;
      continue;
    }
    if (row.payload_json == null) {
      nodeMissing += 1;
      const comparison: ResourcePayloadComparison = {
        equal: false,
        mismatches: [{ path: 'payload_json', expected: undefined, actual: null }],
        resourceType: 'node',
        resourceId: row.id,
      };
      nodeMismatches.push(comparison);
      recordMismatch(metrics, comparison);
      continue;
    }
    const comparison = dualReadNodePayload(row, metrics);
    if (comparison.equal) nodeMatched += 1;
    else nodeMismatches.push(comparison);
  }

  return {
    collections: {
      scanned: collectionRows.length,
      matched: collectionMatched,
      mismatched: collectionMismatches.length,
      missingPayload: collectionMissing,
      malformed: collectionMalformed,
      mismatches: collectionMismatches,
    },
    nodes: {
      scanned: nodeRows.length,
      matched: nodeMatched,
      mismatched: nodeMismatches.length,
      missingPayload: nodeMissing,
      malformed: nodeMalformed,
      mismatches: nodeMismatches,
    },
  };
}

/**
 * Deterministic, idempotent backfill from relational columns.
 * Re-running on already-backfilled correct rows is a no-op (skipped).
 * Malformed legacy rows are marked without fabricating unsupported data.
 */
export async function backfillResourcePayloads(
  db: Kysely<DatabaseSchema>,
  metrics?: Metrics,
): Promise<ResourceAuthorityBackfillStats> {
  let scanned = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let malformed = 0;

  const collectionRows = await db
    .selectFrom('collections')
    .select([
      'id',
      'owner_subject_id',
      'title',
      'summary',
      'kind',
      'visibility',
      'allow_search_indexing',
      'root_node_id',
      'resource_revision',
      'content_revision',
      'policy_revision',
      'commit_ordinal',
      'created_at',
      'updated_at',
      'deleted_at',
      'payload_json',
      'payload_schema_version',
      'payload_authority_status',
    ])
    .execute();

  for (const row of collectionRows) {
    scanned += 1;
    metrics?.increment(METRIC_BACKFILL_SCANNED);
    const projection = mapCollectionRow(row);
    const materialised = materializeCollectionPayload(projection);
    if (!materialised.ok) {
      malformed += 1;
      failed += 1;
      metrics?.increment(METRIC_BACKFILL_MALFORMED);
      metrics?.increment(METRIC_BACKFILL_FAILED);
      await db
        .updateTable('collections')
        .set({
          payload_json: null,
          payload_schema_version: null,
          payload_authority_status: 'malformed',
        })
        .where('id', '=', row.id)
        .execute();
      continue;
    }

    const comparison = compareCollectionPayloadToRelational(projection, row.payload_json);
    if (
      row.payload_authority_status === 'backfilled'
      && row.payload_schema_version === RESOURCE_PAYLOAD_SCHEMA_VERSION
      && comparison.equal
    ) {
      skipped += 1;
      metrics?.increment(METRIC_BACKFILL_SKIPPED);
      continue;
    }

    await db
      .updateTable('collections')
      .set({
        payload_json: materialised.payload as DatabaseSchema['collections']['payload_json'],
        payload_schema_version: materialised.schemaVersion,
        payload_authority_status: 'backfilled',
      })
      .where('id', '=', row.id)
      .execute();
    succeeded += 1;
    metrics?.increment(METRIC_BACKFILL_SUCCEEDED);
  }

  const nodeRows = await db
    .selectFrom('nodes')
    .select([
      'id',
      'collection_id',
      'parent_id',
      'kind',
      'is_root',
      'title',
      'url',
      'description',
      'tags',
      'visibility',
      'position_token',
      'resource_revision',
      'children_revision',
      'created_at',
      'updated_at',
      'deleted_at',
      'deleted_commit_ordinal',
      'payload_json',
      'payload_schema_version',
      'payload_authority_status',
    ])
    .execute();

  for (const row of nodeRows) {
    scanned += 1;
    metrics?.increment(METRIC_BACKFILL_SCANNED);
    const projection = mapNodeRow(row);
    const materialised = materializeNodePayload(projection);
    if (!materialised.ok) {
      malformed += 1;
      failed += 1;
      metrics?.increment(METRIC_BACKFILL_MALFORMED);
      metrics?.increment(METRIC_BACKFILL_FAILED);
      await db
        .updateTable('nodes')
        .set({
          payload_json: null,
          payload_schema_version: null,
          payload_authority_status: 'malformed',
        })
        .where('id', '=', row.id)
        .execute();
      continue;
    }

    const comparison = compareNodePayloadToRelational(projection, row.payload_json);
    if (
      row.payload_authority_status === 'backfilled'
      && row.payload_schema_version === RESOURCE_PAYLOAD_SCHEMA_VERSION
      && comparison.equal
    ) {
      skipped += 1;
      metrics?.increment(METRIC_BACKFILL_SKIPPED);
      continue;
    }

    await db
      .updateTable('nodes')
      .set({
        payload_json: materialised.payload as DatabaseSchema['nodes']['payload_json'],
        payload_schema_version: materialised.schemaVersion,
        payload_authority_status: 'backfilled',
      })
      .where('id', '=', row.id)
      .execute();
    succeeded += 1;
    metrics?.increment(METRIC_BACKFILL_SUCCEEDED);
  }

  return { scanned, succeeded, failed, skipped, malformed };
}

/**
 * SQL-friendly live resource rows missing a valid backfilled payload.
 * Used by integration tests and ops verification.
 */
export async function countLiveResourcesMissingValidPayload(
  db: Kysely<DatabaseSchema>,
): Promise<{ collections: number; nodes: number }> {
  const collections = await db
    .selectFrom('collections')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([
      eb('payload_json', 'is', null),
      eb('payload_authority_status', 'is', null),
      eb('payload_authority_status', '!=', 'backfilled'),
      eb('payload_schema_version', 'is', null),
      eb('payload_schema_version', '!=', RESOURCE_PAYLOAD_SCHEMA_VERSION),
    ]))
    .executeTakeFirstOrThrow();

  const nodes = await db
    .selectFrom('nodes')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([
      eb('payload_json', 'is', null),
      eb('payload_authority_status', 'is', null),
      eb('payload_authority_status', '!=', 'backfilled'),
      eb('payload_schema_version', 'is', null),
      eb('payload_schema_version', '!=', RESOURCE_PAYLOAD_SCHEMA_VERSION),
    ]))
    .executeTakeFirstOrThrow();

  return {
    collections: Number(collections.count),
    nodes: Number(nodes.count),
  };
}
