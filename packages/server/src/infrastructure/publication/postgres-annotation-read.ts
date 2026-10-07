import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Annotation } from '@know-n/colp/types';
import type { PoolClient } from 'pg';
import { rollbackTransaction, type DatabaseRuntime } from '../database/index.js';
import {
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PublicationSnapshotAnchorNotFoundError,
  type PublicationAnnotationPosition,
  type PublicationAnnotationReadPage,
  type PublicationAnnotationReadPort,
  type PublicationAnnotationReadRequest,
  type PublicationAnnotationRecord,
} from '../../modules/publication/index.js';
import { bookmarkHidePublicExistsSql } from '../database/collection-control-sql.js';

interface CollectionFenceRow {
  content_revision: string;
  policy_revision: string;
  deleted_at: Date | null;
}

interface AnnotationRow {
  id: string;
  collection_id: string;
  subject_type: 'collection' | 'node';
  subject_id: string;
  creator_principal_id: string;
  type: Annotation['type'];
  format: Annotation['format'] | null;
  value_json: unknown;
  visibility: Annotation['visibility'];
  resource_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  payload_json: unknown;
  payload_schema_version: number;
  payload_authority_status: string;
  subject_visibility: PublicationAnnotationRecord['subjectVisibility'];
  subject_ancestor_restricted: boolean;
  /** Public projection only: computed by the page-level ancestry walk, filtered in the port. */
  is_visible?: boolean;
}

export interface PublicationAnnotationSqlStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface PostgresPublicationAnnotationReadOptions {
  /** Product origin that owns the canonical public `/profiles/{handle}` Actor URI. */
  readonly origin: string;
}

const validators = createValidatorRegistry();
/**
 * The public correction loop re-queries the window while it is full but has not
 * collected limit + 1 visible rows. Each iteration advances the exclusive tuple
 * cursor past the previous window, so the loop is monotonic; this cap is only a
 * guard against pathological database corruption.
 */
const MAX_PAGE_SKIP_ITERATIONS = 10_000;

export function createPostgresPublicationAnnotationReadPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
  options: PostgresPublicationAnnotationReadOptions,
): PublicationAnnotationReadPort {
  const origin = normalizeOrigin(options.origin);
  return Object.freeze({
    async loadPage(request: PublicationAnnotationReadRequest): Promise<PublicationAnnotationReadPage> {
      validateRequest(request);
      const client = await runtime.pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const isolation = await client.query<{ isolation: string }>(
          "select current_setting('transaction_isolation') as isolation",
        );
        if (isolation.rows[0]?.isolation !== 'repeatable read') {
          throw new Error('Publication Annotation read transaction is not repeatable read');
        }
        const fence = await client.query<CollectionFenceRow>(
          `select content_revision, policy_revision, deleted_at
             from collections
            where id = $1`,
          [request.collectionId],
        );
        const collection = fence.rows[0];
        if (!collection || collection.deleted_at !== null) {
          await client.query('commit');
          return freezePage(null, null, []);
        }
        const after = await resolveContinuation(client, request);
        const candidateRequest = after === undefined
          ? request
          : (({ afterLocator: _afterLocator, ...rest }) => ({ ...rest, after }))(request);
        const rows = request.projection === 'public'
          ? await loadPublicAnnotationCandidates(client, candidateRequest)
          : await loadAnnotationCandidatesOnce(client, candidateRequest);
        const candidates = rows.map((row) => mapRow(row, origin));
        await client.query('commit');
        return freezePage(collection.content_revision, collection.policy_revision, candidates);
      } catch (error) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Publication annotation read');
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

async function resolveContinuation(
  client: PoolClient,
  request: PublicationAnnotationReadRequest,
): Promise<PublicationAnnotationPosition | undefined> {
  if (request.after !== undefined) return request.after;
  if (request.afterLocator === undefined) return undefined;
  const result = await client.query<Pick<AnnotationRow, 'id' | 'subject_type' | 'subject_id'>>(
    `select id, subject_type, subject_id
       from annotations
      where collection_id = $1 and deleted_at is null
        and publication_locator_sha256_128(id) = $2`,
    [request.collectionId, request.afterLocator],
  );
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (!row) throw new PublicationSnapshotAnchorNotFoundError();
  return { subjectType: row.subject_type, subjectId: row.subject_id, annotationId: row.id };
}

async function loadAnnotationCandidatesOnce(
  client: PoolClient,
  request: PublicationAnnotationReadRequest,
): Promise<AnnotationRow[]> {
  const statement = buildPublicationAnnotationCandidateStatement(request);
  const result = await client.query<AnnotationRow>(statement.text, [...statement.values]);
  return result.rows;
}

async function loadPublicAnnotationCandidates(
  client: PoolClient,
  request: PublicationAnnotationReadRequest,
): Promise<AnnotationRow[]> {
  const target = request.limit + 1;
  const collected: AnnotationRow[] = [];
  let after = request.after;
  let skipCapExceeded = false;
  for (let iteration = 0; iteration < MAX_PAGE_SKIP_ITERATIONS; iteration += 1) {
    const statement = buildPublicationAnnotationCandidateStatement({ ...request, after });
    const result = await client.query<AnnotationRow>(statement.text, [...statement.values]);
    const rows = result.rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.is_visible === true) collected.push(row);
    }
    if (rows.length < target || collected.length >= target) break;
    const last = rows[rows.length - 1]!;
    after = { subjectType: last.subject_type, subjectId: last.subject_id, annotationId: last.id };
    if (iteration === MAX_PAGE_SKIP_ITERATIONS - 1) skipCapExceeded = true;
  }
  if (skipCapExceeded) throw new Error('Publication Annotation page exceeded the maximum skip iterations');
  return collected.slice(0, target);
}

export function buildPublicationAnnotationCandidateStatement(
  request: PublicationAnnotationReadRequest,
): PublicationAnnotationSqlStatement {
  validateRequest(request);
  if (request.afterLocator !== undefined) {
    throw new TypeError('Publication Annotation statement requires a resolved continuation tuple');
  }
  const values: unknown[] = [request.collectionId];
  const continuation = request.after === undefined
    ? ''
    : `and (
         a.subject_type collate "C",
         a.subject_id collate "C",
         a.id collate "C"
       ) > ($2::text collate "C", $3::text collate "C", $4::text collate "C")`;
  if (request.after) {
    values.push(request.after.subjectType, request.after.subjectId, request.after.annotationId);
  }
  let memberPrincipal = '';
  if (request.projection === 'member') {
    values.push(request.principalId!);
    memberPrincipal = `$${values.length}`;
  }
  let scopeCte = '';
  let scopedNodePredicate = '';
  if (request.rootId !== undefined || request.depth !== undefined) {
    values.push(request.rootId ?? '');
    const rootParameter = `$${values.length}`;
    values.push(request.depth ?? 1_024);
    const depthParameter = `$${values.length}`;
    scopeCte = `scoped as (
      select n.id, 0::integer as scope_depth
        from nodes n
       where n.collection_id = $1
         and n.id = case when ${rootParameter} = ''
           then (select root_node_id from collections where id = $1) else ${rootParameter} end
         and n.deleted_at is null
      union all
      select child.id, parent.scope_depth + 1
        from nodes child join scoped parent on child.parent_id = parent.id
       where child.collection_id = $1 and child.deleted_at is null
         and parent.scope_depth < ${depthParameter}
    )`;
    scopedNodePredicate = `and (a.subject_type = 'collection' or exists (
      select 1 from scoped where scoped.id = a.subject_id and scoped.scope_depth <= ${depthParameter}
    ))`;
  }
  const visibilityPredicate = request.projection === 'public'
    ? `a.visibility in ('public', 'unlisted')`
    : `(a.visibility in ('public', 'unlisted', 'protected')
        or (a.visibility = 'private' and a.creator_principal_id = ${memberPrincipal}))`;
  values.push(request.limit + 1);
  const limitParameter = `$${values.length}`;
  const windowWhere = `a.collection_id = $1 and a.deleted_at is null
         and ((a.subject_type = 'collection' and a.subject_id = a.collection_id)
           or (a.subject_type = 'node' and exists (
             select 1 from nodes live_subject
              where live_subject.collection_id = a.collection_id
                and live_subject.id = a.subject_id and live_subject.deleted_at is null
           )))
         and ${visibilityPredicate}
         ${scopedNodePredicate}
         ${continuation}`;
  const restrictedExpression = `coalesce(
    facts_row.has_restricted_ancestor or facts_row.has_cycle or not facts_row.reached_top, true)
    or ${bookmarkHidePublicExistsSql('a.subject_id', 'a.collection_id')}`;
  const isVisibleColumn = request.projection === 'public'
    ? `,
         case when a.subject_type = 'collection' then true
              else (subject_node.visibility = 'inherit' and not ${restrictedExpression})
         end as is_visible`
    : '';
  return Object.freeze({
    text: `with recursive ${scopeCte}${scopeCte === '' ? '' : ', '}candidate_window as (
        select a.id, a.subject_type, a.subject_id
          from annotations a
         where ${windowWhere}
         order by a.subject_type collate "C", a.subject_id collate "C", a.id collate "C"
         limit ${limitParameter}
      ),
      origins as (
        select distinct subject_id as origin_id
          from candidate_window
         where subject_type = 'node'
      ),
      ancestry as (
        select o.origin_id, n.id as node_id, n.parent_id, n.visibility,
               0::integer as distance, array[n.id]::text[] as path, false as cycle
          from origins o
          join nodes n on n.collection_id = $1 and n.id = o.origin_id and n.deleted_at is null
        union all
        select a.origin_id, p.id as node_id, p.parent_id, p.visibility,
               a.distance + 1, a.path || p.id::text, (p.id::text = any(a.path)) as cycle
          from ancestry a
          join nodes p on p.collection_id = $1 and p.id = a.parent_id
         where not a.cycle and a.distance < 1024
      ),
      facts as (
        select origin_id,
               coalesce(bool_or(case when distance >= 1 then visibility in ('private', 'protected') end), false)
                 as has_restricted_ancestor,
               coalesce(bool_or(cycle), false) as has_cycle,
               coalesce(bool_or(parent_id is null), false) as reached_top
          from ancestry
         group by origin_id
      )
      select a.id, a.collection_id, a.subject_type, a.subject_id, a.creator_principal_id,
             a.type, a.format, a.value_json, a.visibility, a.resource_revision,
             a.created_at, a.updated_at, a.deleted_at, a.payload_json,
             a.payload_schema_version, a.payload_authority_status,
             case when a.subject_type = 'collection' then (
               select subject_collection.visibility from collections subject_collection
                where subject_collection.id = a.collection_id and subject_collection.deleted_at is null
             ) else subject_node.visibility end as subject_visibility,
             case when a.subject_type = 'collection' then false
                  else ${restrictedExpression} end as subject_ancestor_restricted
             ${isVisibleColumn}
        from annotations a
        left join nodes subject_node
          on subject_node.collection_id = a.collection_id
         and subject_node.id = a.subject_id and subject_node.deleted_at is null
        left join facts facts_row on facts_row.origin_id = a.subject_id
       where ${windowWhere}
       order by a.subject_type collate "C", a.subject_id collate "C", a.id collate "C"
       limit ${limitParameter}`,
    values: Object.freeze(values),
  });
}

function validateRequest(request: PublicationAnnotationReadRequest): void {
  if (!request || typeof request.collectionId !== 'string' || request.collectionId.length === 0) {
    throw new TypeError('Publication Annotation collectionId is required');
  }
  if (request.projection !== 'public' && request.projection !== 'member') {
    throw new TypeError('Publication Annotation projection is invalid');
  }
  if (request.projection === 'member' && (!request.principalId || typeof request.principalId !== 'string')) {
    throw new TypeError('Publication member Annotation projection requires a principal');
  }
  if (request.projection === 'public' && request.principalId !== undefined) {
    throw new TypeError('Publication public Annotation projection cannot accept a principal');
  }
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500) {
    throw new RangeError('Publication Annotation read limit must be between 1 and 500');
  }
  if (request.after !== undefined && request.afterLocator !== undefined) {
    throw new TypeError('Publication Annotation read accepts only one continuation form');
  }
  if (request.after && (request.after.subjectType !== 'collection' && request.after.subjectType !== 'node')) {
    throw new TypeError('Publication Annotation continuation tuple is invalid');
  }
  if (request.after && [request.after.subjectId, request.after.annotationId].some((value) =>
    typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('Publication Annotation continuation tuple is invalid');
  }
  if (request.afterLocator !== undefined && !/^[0-9a-f]{32}$/u.test(request.afterLocator)) {
    throw new TypeError('Publication Annotation continuation locator is invalid');
  }
  if (request.depth !== undefined && (!Number.isSafeInteger(request.depth) || request.depth < 0 || request.depth > 1_024)) {
    throw new RangeError('Publication Annotation depth must be between 0 and 1024');
  }
}

function mapRow(row: AnnotationRow, origin: string): PublicationAnnotationRecord {
  const structural = validators.validate('annotation', row.payload_json);
  if (!structural.valid) throw new Error('Publication Annotation payload failed authority validation');
  const payload = row.payload_json as Annotation;
  if (!payload.creator || payload.id !== row.id || payload.collectionId !== row.collection_id
    || payload.subject.type !== row.subject_type || payload.subject.id !== row.subject_id
    || payload.type !== row.type || (payload.format ?? null) !== row.format
    || canonicalJson(payload.value) !== canonicalJson(row.value_json)
    || payload.visibility !== row.visibility || payload.revision !== row.resource_revision
    || parseInstant(payload.createdAt) !== row.created_at.getTime()
    || parseInstant(payload.updatedAt) !== row.updated_at.getTime()
    || row.payload_schema_version !== 1 || row.payload_authority_status !== 'backfilled'
    || row.deleted_at !== null) {
    throw new Error('Publication Annotation relational/payload authority mismatch');
  }
  const creator = publicCreator(payload.creator, origin);
  return Object.freeze({
    id: row.id, collectionId: row.collection_id, subjectType: row.subject_type,
    subjectId: row.subject_id, creatorPrincipalId: row.creator_principal_id,
    creatorUri: creator.id, creatorDisplayName: creator.name,
    visibility: row.visibility, subjectVisibility: row.subject_visibility,
    subjectAncestorRestricted: row.subject_ancestor_restricted === true,
    payload: Object.freeze(structuredClone(payload)), deletedAt: row.deleted_at,
  });
}

function publicCreator(
  creator: NonNullable<Annotation['creator']>,
  origin: string,
): { readonly id: string; readonly name: string } {
  const url = new URL(creator.id);
  const profileSegment = url.pathname.slice('/profiles/'.length);
  if (url.origin !== origin || !url.pathname.startsWith('/profiles/')
    || profileSegment === '' || profileSegment.includes('/') || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '') {
    throw new Error('Publication Annotation creator is not a public Actor URI');
  }
  return Object.freeze({ id: url.href, name: creator.name });
}

function parseInstant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Publication Annotation timestamp is invalid');
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Publication Annotation value is not canonical JSON');
  return encoded;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || url.username !== '' || url.password !== ''
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new TypeError('Publication Annotation origin must be an exact HTTP(S) origin');
  }
  return url.origin;
}

function freezePage(
  contentRevision: string | null,
  policyRevision: string | null,
  candidates: readonly PublicationAnnotationRecord[],
): PublicationAnnotationReadPage {
  return Object.freeze({
    isolation: 'repeatable read', comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
    contentRevision, policyRevision, candidates: Object.freeze([...candidates]),
  });
}
