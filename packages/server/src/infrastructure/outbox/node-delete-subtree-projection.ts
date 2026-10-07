import type { PoolClient } from 'pg';
import {
  NODE_DELETE_AFFECTED_FACT_PAGE_SIZE,
  persistNodeDeleteAffectedFacts,
  type AffectedFactExecutor,
} from '../collections/canonical-node-delete-affected-facts.js';

export interface SubtreeDeleteProjectionInput {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly commitOrdinal: bigint;
  readonly affectedCount: number;
  readonly handlerName: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly eventId: string;
  readonly payloadJson: string;
}

interface FactCensus {
  readonly n: number;
  readonly rooted: number;
  readonly minOrdinal: number | null;
  readonly maxOrdinal: number | null;
}

function pgExecutor(client: PoolClient): AffectedFactExecutor {
  return async (statement, parameters) => {
    const result = await client.query<Record<string, unknown>>(statement, [...parameters]);
    return { rows: result.rows };
  };
}

function readNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error('node.deleted subtree fact ordinal is not an integer');
  }
  return parsed;
}

function readInt(value: unknown, label: string): number {
  const parsed = readNullableInt(value);
  if (parsed === null) throw new Error(`node.deleted subtree fact ${label} is missing`);
  return parsed;
}

function censusMatches(census: FactCensus, affectedCount: number): boolean {
  return census.n === affectedCount
    && census.rooted === census.n
    && census.minOrdinal === 0
    && census.maxOrdinal === affectedCount - 1;
}

async function readCensus(
  execute: AffectedFactExecutor,
  collectionId: string,
  commitOrdinal: string,
  rootNodeId: string,
): Promise<FactCensus> {
  const result = await execute(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE root_node_id = $3)::int AS rooted,
            min(fact_ordinal) FILTER (WHERE root_node_id = $3) AS min_ordinal,
            max(fact_ordinal) FILTER (WHERE root_node_id = $3) AS max_ordinal
     FROM node_delete_affected_resources
     WHERE collection_id = $1 AND commit_ordinal = $2::bigint`,
    [collectionId, commitOrdinal, rootNodeId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('node.deleted subtree fact census returned no row');
  return {
    n: readInt(row.n, 'count'),
    rooted: readInt(row.rooted, 'rooted count'),
    minOrdinal: readNullableInt(row.min_ordinal),
    maxOrdinal: readNullableInt(row.max_ordinal),
  };
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return payloadRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Old deletes have no fact rows. The hot operation payload is the only
 * trustworthy id list. A changed node tree is not a source.
 */
function trustedPayloadIds(
  payload: Record<string, unknown>,
  rootNodeId: string,
  affectedCount: number,
): readonly string[] | null {
  const intent = payloadRecord(payload.deleteIntent);
  const ids = payload.affectedResourceIds;
  if (
    payload.action !== 'delete'
    || payload.resourceKind !== 'node'
    || payload.resourceId !== rootNodeId
    || intent?.scope !== 'subtree'
    || !Array.isArray(ids)
    || ids.length !== affectedCount
    || ids.some((id) => typeof id !== 'string' || id.length === 0)
  ) return null;
  const resourceIds = ids as readonly string[];
  if (new Set(resourceIds).size !== resourceIds.length || !resourceIds.includes(rootNodeId)) return null;
  return resourceIds;
}

async function ensureFacts(
  execute: AffectedFactExecutor,
  input: SubtreeDeleteProjectionInput,
  commitOrdinal: string,
): Promise<void> {
  const where = `(collection=${input.collectionId}, ordinal=${commitOrdinal}, root=${input.rootNodeId})`;
  let census = await readCensus(execute, input.collectionId, commitOrdinal, input.rootNodeId);
  if (census.n === 0) {
    const found = await execute(
      `SELECT operation_id, payload_json
       FROM operation_payloads
       WHERE collection_id = $1 AND commit_ordinal = $2::bigint`,
      [input.collectionId, commitOrdinal],
    );
    const row = found.rows.length === 1 ? found.rows[0] : undefined;
    const payload = row ? payloadRecord(row.payload_json) : null;
    const operationId = row && typeof row.operation_id === 'string' ? row.operation_id : null;
    const ids = payload && operationId
      ? trustedPayloadIds(payload, input.rootNodeId, input.affectedCount)
      : null;
    if (!ids || !operationId) {
      throw new Error(
        `node.deleted subtree has no immutable affected-resource facts and no trustworthy hot operation payload ${where}`,
      );
    }
    await persistNodeDeleteAffectedFacts(execute, {
      collectionId: input.collectionId,
      commitOrdinal: input.commitOrdinal,
      rootNodeId: input.rootNodeId,
      operationId,
      resourceIds: ids,
    });
    census = await readCensus(execute, input.collectionId, commitOrdinal, input.rootNodeId);
  }
  if (!censusMatches(census, input.affectedCount)) {
    throw new Error(
      `node.deleted subtree affected-resource facts do not cover every target ${where}`,
    );
  }
}

async function projectPage(
  execute: AffectedFactExecutor,
  input: SubtreeDeleteProjectionInput,
  commitOrdinal: string,
  resourceIds: readonly string[],
): Promise<{ readonly written: number; readonly stale: number }> {
  const result = await execute(
    `WITH page AS (
       SELECT resource_id FROM unnest($8::text[]) AS page(resource_id)
     ),
     written AS (
       INSERT INTO collection_mutation_projection_resources (
         collection_id, resource_type, resource_id,
         last_handler_name, last_event_type, last_event_version,
         last_domain_event_id, last_commit_ordinal, state_json, deleted, updated_at
       )
       SELECT $1, 'node', page.resource_id,
         $2, $3, $4, $5, $6::bigint, $7::jsonb, true, current_timestamp
       FROM page
       ON CONFLICT (collection_id, resource_type, resource_id) DO UPDATE
       SET last_handler_name = EXCLUDED.last_handler_name,
           last_event_type = EXCLUDED.last_event_type,
           last_event_version = EXCLUDED.last_event_version,
           last_domain_event_id = EXCLUDED.last_domain_event_id,
           last_commit_ordinal = EXCLUDED.last_commit_ordinal,
           state_json = EXCLUDED.state_json,
           deleted = true,
           updated_at = current_timestamp
       WHERE collection_mutation_projection_resources.last_commit_ordinal
             < EXCLUDED.last_commit_ordinal
       RETURNING resource_id
     ),
     stale AS (
       SELECT page.resource_id
       FROM page
       JOIN collection_mutation_projection_resources existing
         ON existing.collection_id = $1
        AND existing.resource_type = 'node'
        AND existing.resource_id = page.resource_id
        AND existing.last_commit_ordinal >= $6::bigint
     )
     SELECT (SELECT count(*)::int FROM page) AS required_count,
            (SELECT count(*)::int FROM written) AS written_count,
            (SELECT count(*)::int FROM stale) AS stale_count`,
    [
      input.collectionId,
      input.handlerName,
      input.eventType,
      input.eventVersion,
      input.eventId,
      commitOrdinal,
      input.payloadJson,
      resourceIds,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('node.deleted subtree page returned no tally');
  const required = readInt(row.required_count, 'page size');
  const written = readInt(row.written_count, 'written count');
  const stale = readInt(row.stale_count, 'stale count');
  if (required !== resourceIds.length || written + stale !== required) {
    throw new Error(
      `node.deleted subtree target was neither materialised nor stale-skipped `
      + `(collection=${input.collectionId}, ordinal=${commitOrdinal}, `
      + `page=${resourceIds.length}, written=${written}, stale=${stale})`,
    );
  }
  return { written, stale };
}

/**
 * Materialise one subtree delete from immutable facts, paging so a large
 * subtree is not one statement. A resource already at this ordinal or a
 * newer one is stale-skipped. Written row count is not the required target
 * count. The caller advances the watermark only after this returns.
 */
export async function projectDeletedNodeSubtree(
  client: PoolClient,
  input: SubtreeDeleteProjectionInput,
): Promise<'applied' | 'stale_skipped'> {
  const execute = pgExecutor(client);
  const commitOrdinal = input.commitOrdinal.toString();
  await ensureFacts(execute, input, commitOrdinal);
  let cursor = -1;
  let seen = 0;
  let written = 0;
  for (;;) {
    const page = await execute(
      `SELECT resource_id, fact_ordinal
       FROM node_delete_affected_resources
       WHERE collection_id = $1
         AND commit_ordinal = $2::bigint
         AND root_node_id = $3
         AND fact_ordinal > $4
       ORDER BY fact_ordinal
       LIMIT $5`,
      [input.collectionId, commitOrdinal, input.rootNodeId, cursor, NODE_DELETE_AFFECTED_FACT_PAGE_SIZE],
    );
    if (page.rows.length === 0) break;
    const resourceIds: string[] = [];
    for (const [index, row] of page.rows.entries()) {
      const ordinal = readInt(row.fact_ordinal, 'page ordinal');
      const resourceId = row.resource_id;
      if (ordinal !== cursor + 1 + index || typeof resourceId !== 'string' || resourceId.length === 0) {
        throw new Error(
          `node.deleted subtree fact page is not contiguous `
          + `(collection=${input.collectionId}, ordinal=${commitOrdinal})`,
        );
      }
      resourceIds.push(resourceId);
    }
    const tally = await projectPage(execute, input, commitOrdinal, resourceIds);
    written += tally.written;
    seen += resourceIds.length;
    cursor = readInt(page.rows[page.rows.length - 1]?.fact_ordinal, 'page end');
    if (page.rows.length < NODE_DELETE_AFFECTED_FACT_PAGE_SIZE) break;
  }
  if (seen !== input.affectedCount) {
    throw new Error(
      `node.deleted subtree facts ended before every target was handled `
      + `(collection=${input.collectionId}, ordinal=${commitOrdinal}, seen=${seen}, required=${input.affectedCount})`,
    );
  }
  return written === 0 ? 'stale_skipped' : 'applied';
}
