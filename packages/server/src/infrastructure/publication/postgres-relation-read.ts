import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Relation } from '@know-n/colp/types';
import type { PoolClient } from 'pg';
import {
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  PublicationSnapshotAnchorNotFoundError,
  type PublicationRelationPosition,
  type PublicationRelationReadPage,
  type PublicationRelationReadPort,
  type PublicationRelationReadRequest,
  type PublicationRelationRecord,
} from '../../modules/publication/index.js';
import { rollbackTransaction, type DatabaseRuntime } from '../database/index.js';
import { bookmarkHidePublicExistsSql } from '../database/collection-control-sql.js';

interface FenceRow { content_revision: string; policy_revision: string; deleted_at: Date | null }
interface RelationRow {
  id: string; collection_id: string; from_node_id: string; to_node_id: string;
  type: Relation['type']; label: string | null; visibility: Relation['visibility'];
  resource_revision: string; created_at: Date; updated_at: Date; deleted_at: Date | null;
  payload_json: unknown; payload_schema_version: number; payload_authority_status: string;
  from_visibility: PublicationRelationRecord['fromVisibility'];
  to_visibility: PublicationRelationRecord['toVisibility'];
  from_authorized: boolean; to_authorized: boolean;
  from_ancestor_visibility: 'protected' | 'private' | null;
  to_ancestor_visibility: 'protected' | 'private' | null;
  from_ancestor_restricted: boolean; to_ancestor_restricted: boolean;
}

export interface PublicationRelationSqlStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

const validators = createValidatorRegistry();

export function createPostgresPublicationRelationReadPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
): PublicationRelationReadPort {
  return Object.freeze({
    async loadPage(request: PublicationRelationReadRequest): Promise<PublicationRelationReadPage> {
      validateRequest(request);
      const client = await runtime.pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const isolation = await client.query<{ isolation: string }>(
          "select current_setting('transaction_isolation') as isolation",
        );
        if (isolation.rows[0]?.isolation !== 'repeatable read') {
          throw new Error('Publication Relation read transaction is not repeatable read');
        }
        const fence = await client.query<FenceRow>(
          `select content_revision, policy_revision, deleted_at from collections where id = $1`,
          [request.collectionId],
        );
        const collection = fence.rows[0];
        if (!collection || collection.deleted_at !== null) {
          await client.query('commit');
          return freezePage(null, null, []);
        }
        const after = await resolveContinuation(client, request);
        const candidateRequest = after === undefined ? request
          : (({ afterLocator: _locator, ...rest }) => ({ ...rest, after }))(request);
        const statement = buildPublicationRelationCandidateStatement(candidateRequest);
        const result = await client.query<RelationRow>(statement.text, [...statement.values]);
        const candidates = result.rows.map(mapRow);
        await client.query('commit');
        return freezePage(collection.content_revision, collection.policy_revision, candidates);
      } catch (error) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Publication relation read');
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

async function resolveContinuation(
  client: PoolClient,
  request: PublicationRelationReadRequest,
): Promise<PublicationRelationPosition | undefined> {
  if (request.after !== undefined) return request.after;
  if (request.afterLocator === undefined) return undefined;
  const result = await client.query<Pick<RelationRow, 'id' | 'from_node_id' | 'to_node_id' | 'type'>>(
    `select id, from_node_id, to_node_id, type from relations
      where collection_id = $1 and deleted_at is null
        and publication_locator_sha256_128(id) = $2`,
    [request.collectionId, request.afterLocator],
  );
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (!row) throw new PublicationSnapshotAnchorNotFoundError();
  return { fromNodeId: row.from_node_id, toNodeId: row.to_node_id, type: row.type, relationId: row.id };
}

export function buildPublicationRelationCandidateStatement(
  request: PublicationRelationReadRequest,
): PublicationRelationSqlStatement {
  validateRequest(request);
  if (request.afterLocator !== undefined) {
    throw new TypeError('Publication Relation statement requires a resolved continuation tuple');
  }
  const values: unknown[] = [request.collectionId];
  const continuation = request.after === undefined ? '' : `and (
      r.from_node_id collate "C", r.to_node_id collate "C", r.type collate "C", r.id collate "C"
    ) > ($2::text collate "C", $3::text collate "C", $4::text collate "C", $5::text collate "C")`;
  if (request.after) values.push(
    request.after.fromNodeId, request.after.toNodeId, request.after.type, request.after.relationId,
  );
  let rootParameter = '';
  let depthParameter = '';
  let scopeReachableAggregate = '';
  if (request.rootId !== undefined || request.depth !== undefined) {
    values.push(request.rootId ?? '');
    rootParameter = `$${values.length}`;
    values.push(request.depth ?? 1_024);
    depthParameter = `$${values.length}`;
    scopeReachableAggregate = `,
         coalesce(bool_or(case when all_live and distance <= ${depthParameter}
             and node_id = case when ${rootParameter} = ''
               then (select root_node_id from collections where id = $1) else ${rootParameter} end
           then true end), false) as scope_reachable`;
  }
  values.push(request.limit + 1);
  const limitParameter = `$${values.length}`;
  const windowWhere = `r.collection_id = $1 and r.deleted_at is null
       ${continuation}`;
  const scopeProbe = rootParameter === '' ? 'true' : 'coalesce(from_facts.scope_reachable, false)';
  const scopeProbeTo = rootParameter === '' ? 'true' : 'coalesce(to_facts.scope_reachable, false)';
  const restrictedFrom = `coalesce(
    from_facts.has_restricted_ancestor or from_facts.has_cycle or not from_facts.reached_top, true)
    or ${bookmarkHidePublicExistsSql('r.from_node_id', 'r.collection_id')}`;
  const restrictedTo = `coalesce(
    to_facts.has_restricted_ancestor or to_facts.has_cycle or not to_facts.reached_top, true)
    or ${bookmarkHidePublicExistsSql('r.to_node_id', 'r.collection_id')}`;
  return Object.freeze({
    text: `with recursive candidate_window as (
        select r.from_node_id, r.to_node_id
          from relations r
         where ${windowWhere}
         order by r.from_node_id collate "C", r.to_node_id collate "C", r.type collate "C", r.id collate "C"
         limit ${limitParameter}
      ),
      endpoint_ids as (
        select distinct v.origin_id
          from candidate_window c
          cross join lateral (values (c.from_node_id), (c.to_node_id)) as v(origin_id)
      ),
      ancestry as (
        select o.origin_id, n.id as node_id, n.parent_id, n.visibility,
               (n.deleted_at is null) as all_live,
               0::integer as distance, array[n.id]::text[] as path, false as cycle
          from endpoint_ids o
          join nodes n on n.collection_id = $1 and n.id = o.origin_id
        union all
        select a.origin_id, p.id as node_id, p.parent_id, p.visibility,
               (a.all_live and p.deleted_at is null) as all_live,
               a.distance + 1, a.path || p.id::text, (p.id::text = any(a.path)) as cycle
          from ancestry a
          join nodes p on p.collection_id = $1 and p.id = a.parent_id
         where not a.cycle and a.distance < 1024
      ),
      facts as (
        select origin_id,
               coalesce(bool_or(case when distance >= 1 then visibility in ('private', 'protected') end), false)
                 as has_restricted_ancestor,
               coalesce(bool_or(case when distance >= 1 then visibility = 'private' end), false)
                 as has_private,
               coalesce(bool_or(case when distance >= 1 then visibility = 'protected' end), false)
                 as has_protected,
               coalesce(bool_or(cycle), false) as has_cycle,
               coalesce(bool_or(parent_id is null), false) as reached_top
               ${scopeReachableAggregate}
          from ancestry
         group by origin_id
      )
      select r.id, r.collection_id, r.from_node_id, r.to_node_id, r.type, r.label, r.visibility,
             r.resource_revision, r.created_at, r.updated_at, r.deleted_at, r.payload_json,
             r.payload_schema_version, r.payload_authority_status,
             case when from_endpoint.id is null then 'private' else from_endpoint.visibility end
               as from_visibility,
             case when to_endpoint.id is null then 'private' else to_endpoint.visibility end
               as to_visibility,
             (from_endpoint.id is not null and (${scopeProbe})) as from_authorized,
             (to_endpoint.id is not null and (${scopeProbeTo})) as to_authorized,
             case when from_endpoint.id is null then null
                  when from_facts.has_private then 'private'
                  when from_facts.has_protected then 'protected'
                  when (from_facts.has_cycle or not from_facts.reached_top) then 'private'
                  else null end as from_ancestor_visibility,
             case when to_endpoint.id is null then null
                  when to_facts.has_private then 'private'
                  when to_facts.has_protected then 'protected'
                  when (to_facts.has_cycle or not to_facts.reached_top) then 'private'
                  else null end as to_ancestor_visibility,
             case when from_endpoint.id is null then true else ${restrictedFrom} end
               as from_ancestor_restricted,
             case when to_endpoint.id is null then true else ${restrictedTo} end
               as to_ancestor_restricted
        from relations r
        left join nodes from_endpoint
          on from_endpoint.collection_id = r.collection_id
         and from_endpoint.id = r.from_node_id and from_endpoint.deleted_at is null
        left join nodes to_endpoint
          on to_endpoint.collection_id = r.collection_id
         and to_endpoint.id = r.to_node_id and to_endpoint.deleted_at is null
        left join facts from_facts on from_facts.origin_id = r.from_node_id
        left join facts to_facts on to_facts.origin_id = r.to_node_id
       where ${windowWhere}
       order by r.from_node_id collate "C", r.to_node_id collate "C", r.type collate "C", r.id collate "C"
       limit ${limitParameter}`,
    values: Object.freeze(values),
  });
}

function validateRequest(request: PublicationRelationReadRequest): void {
  if (!request || typeof request.collectionId !== 'string' || request.collectionId.length === 0) {
    throw new TypeError('Publication Relation collectionId is required');
  }
  if (request.projection !== 'public' && request.projection !== 'member') {
    throw new TypeError('Publication Relation projection is invalid');
  }
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500) {
    throw new RangeError('Publication Relation read limit must be between 1 and 500');
  }
  if (request.after !== undefined && request.afterLocator !== undefined) {
    throw new TypeError('Publication Relation read accepts only one continuation form');
  }
  if (request.after && [request.after.fromNodeId, request.after.toNodeId, request.after.type,
    request.after.relationId].some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('Publication Relation continuation tuple is invalid');
  }
  if (request.afterLocator !== undefined && !/^[0-9a-f]{32}$/u.test(request.afterLocator)) {
    throw new TypeError('Publication Relation continuation locator is invalid');
  }
  if (request.depth !== undefined && (!Number.isSafeInteger(request.depth)
    || request.depth < 0 || request.depth > 1_024)) {
    throw new RangeError('Publication Relation depth must be between 0 and 1024');
  }
}

function mapRow(row: RelationRow): PublicationRelationRecord {
  const structural = validators.validate('relation', row.payload_json);
  if (!structural.valid) throw new Error('Publication Relation payload failed authority validation');
  const payload = row.payload_json as Relation;
  if (payload.id !== row.id || payload.collectionId !== row.collection_id
    || payload.fromNodeId !== row.from_node_id || payload.toNodeId !== row.to_node_id
    || payload.type !== row.type || (payload.label ?? null) !== row.label
    || payload.visibility !== row.visibility || payload.revision !== row.resource_revision
    || Date.parse(payload.createdAt) !== row.created_at.getTime()
    || Date.parse(payload.updatedAt) !== row.updated_at.getTime()
    || row.payload_schema_version !== 1 || row.payload_authority_status !== 'backfilled'
    || row.deleted_at !== null) {
    throw new Error('Publication Relation relational/payload authority mismatch');
  }
  return Object.freeze({
    id: row.id, collectionId: row.collection_id, fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
    visibility: row.visibility, fromVisibility: row.from_visibility, toVisibility: row.to_visibility,
    fromAuthorized: row.from_authorized === true, toAuthorized: row.to_authorized === true,
    fromAncestorVisibility: row.from_ancestor_visibility,
    toAncestorVisibility: row.to_ancestor_visibility,
    fromAncestorRestricted: row.from_ancestor_restricted === true,
    toAncestorRestricted: row.to_ancestor_restricted === true,
    payload: Object.freeze(structuredClone(payload)), deletedAt: row.deleted_at,
  });
}

function freezePage(
  contentRevision: string | null,
  policyRevision: string | null,
  candidates: readonly PublicationRelationRecord[],
): PublicationRelationReadPage {
  return Object.freeze({
    isolation: 'repeatable read', comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION,
    contentRevision, policyRevision, candidates: Object.freeze([...candidates]),
  });
}
