import { publishedSourcesIndexableBySeriesIds } from './report-source-indexability.js';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresResourceIdLedgerPort, type ResourceIdLedgerPort } from '../database/resource-id-ledger.js';
import type { DigestEditionTable, DigestSeriesTable } from '../database/reports-tables.js';
import type {
  DigestEdition,
  DigestMember,
  DigestSeries,
  ReportSourceFacts,
  ReportEditionWritePort,
  ReportMemberWritePort,
  ReportSeriesWritePort,
  ReportSourceReadPort,
  ReportFollowWritePort,
  ReportAuditPort,
  ReportSeriesReadPort,
  ReportEditionReadPort,
  ReportIssueSourceFence,
} from '../../modules/reports/index.js';
import {
  accountRestrictInteractionExistsSql,
  accountRestrictPublicationExistsSql,
  collectionHidePublicControlSql,
  collectionHidePublicExistsSql,
  digestEditionHidePublicExistsSql,
  digestSeriesHidePublicExistsSql,
} from '../governance/collection-control-sql.js';
import {
  listPublishedEditions,
  listPublishedEditionsBySeries,
  mapDigestEditionRow as edition,
  publicProjectionRevision,
} from './report-edition-public-read.js';

const opaque = () => randomBytes(16).toString('base64url');
const MAX_REPORT_BATCH_ROWS = 100_001;

type ReportResourceType = 'digest_series' | 'digest_edition';

async function reserve(
  ledger: ResourceIdLedgerPort,
  id: string,
  resourceType: ReportResourceType,
): Promise<void> {
  await ledger.reserve([{ resourceId: id, resourceType }]);
}

function series(row: DigestSeriesTable): DigestSeries {
  return Object.freeze({
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    title: row.title,
    summary: row.summary,
    slug: row.slug,
    visibility: row.visibility,
    allowSearchIndexing: row.allow_search_indexing,
    state: row.state,
    ...(row.owner_publication_restricted === true ? { ownerPublicationRestricted: true } : {}),
    resourceRevision: row.resource_revision,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    tags: Array.isArray(row.tags) ? Object.freeze(row.tags.filter((item): item is string => typeof item === 'string')) : Object.freeze([]),
    language: typeof row.language === 'string' && row.language.length > 0 ? row.language : null,
  });
}
export {
  createPostgresReportScheduleWritePort,
  createPostgresReportRunLedgerPort,
} from './scheduler-repositories.js';

export function createPostgresReportSeriesWritePort(
  tx: DatabaseTransaction,
  ledger: ResourceIdLedgerPort = createPostgresResourceIdLedgerPort(tx),
): ReportSeriesWritePort {
  return {
    async insert(value) {
      await reserve(ledger, value.id, 'digest_series');
      await tx.insertInto('digest_series').values({ id: value.id, owner_subject_id: value.ownerSubjectId,
        title: value.title, summary: value.summary, slug: value.slug, visibility: value.visibility,
        allow_search_indexing: value.allowSearchIndexing, state: value.state, resource_revision: value.resourceRevision,
        content_revision: value.contentRevision, policy_revision: value.policyRevision, commit_ordinal: 1n,
        tags: sql`${JSON.stringify([...(value.tags ?? [])])}::jsonb`, language: value.language ?? null,
        created_at: sql<Date>`current_timestamp`, updated_at: sql<Date>`current_timestamp`, deleted_at: null }).execute();
    },
    async lockById(id) {
      const row = await tx.selectFrom('digest_series').innerJoin('accounts', 'accounts.subject_id', 'digest_series.owner_subject_id')
        .select(['digest_series.id','digest_series.owner_subject_id','digest_series.title','digest_series.summary','digest_series.slug','digest_series.visibility','digest_series.allow_search_indexing','digest_series.state','digest_series.resource_revision','digest_series.content_revision','digest_series.policy_revision','digest_series.commit_ordinal','digest_series.created_at','digest_series.updated_at','digest_series.deleted_at','digest_series.tags','digest_series.language'])
        .where('digest_series.id', '=', id)
        .where('accounts.status', '=', 'active')
        .where('accounts.deleted_at', 'is', null)
        .forUpdate().executeTakeFirst();
      return row ? series(row) : null;
    },
    async update(id, patch) {
      const values: Record<string, unknown> = {};
      if (patch.title !== undefined) values.title = patch.title;
      if (patch.summary !== undefined) values.summary = patch.summary;
      if (patch.slug !== undefined) values.slug = patch.slug;
      if (patch.visibility !== undefined) values.visibility = patch.visibility;
      if (patch.allowSearchIndexing !== undefined) values.allow_search_indexing = patch.allowSearchIndexing;
      if (patch.state !== undefined) { values.state = patch.state; values.deleted_at = patch.state === 'archived' ? sql<Date>`current_timestamp` : null; }
      if (patch.resourceRevision !== undefined) values.resource_revision = patch.resourceRevision;
      if (patch.contentRevision !== undefined) values.content_revision = patch.contentRevision;
      if (patch.policyRevision !== undefined) values.policy_revision = patch.policyRevision;
      if (patch.tags !== undefined) values.tags = sql`${JSON.stringify([...patch.tags])}::jsonb`;
      if (patch.language !== undefined) values.language = patch.language;
      values.updated_at = sql<Date>`current_timestamp`;
      values.commit_ordinal = sql<bigint>`commit_ordinal + 1`;
      const row = await tx.updateTable('digest_series').set(values).where('id', '=', id).returningAll().executeTakeFirst();
      if (!row) throw new Error(`report series ${id} disappeared`);
      return series(row);
    },
    async nextEditionOrdinal(id) {
      const row = await tx.selectFrom('digest_editions').select(sql<string>`coalesce(max(edition_ordinal),0)+1`.as('next'))
        .where('series_id', '=', id).executeTakeFirstOrThrow();
      return Number(row.next);
    },
    async disableSchedule(id) {
      await tx.updateTable('digest_schedules').set({ enabled: false, next_run_at: null, updated_at: sql<Date>`current_timestamp` })
        .where('series_id', '=', id).execute();
    },
    async list(id) {
      const row = await tx.selectFrom('digest_series').innerJoin('accounts', 'accounts.subject_id', 'digest_series.owner_subject_id').select(['digest_series.id','digest_series.owner_subject_id','digest_series.title','digest_series.summary','digest_series.slug','digest_series.visibility','digest_series.allow_search_indexing','digest_series.state','digest_series.resource_revision','digest_series.content_revision','digest_series.policy_revision','digest_series.commit_ordinal','digest_series.created_at','digest_series.updated_at','digest_series.deleted_at','digest_series.tags','digest_series.language']).where((eb) => eb.or([eb('digest_series.id','=',id), eb('digest_series.slug','=',id)])).where('accounts.status','=','active').where('accounts.deleted_at','is',null).where(sql<boolean>`not ${sql.raw(accountRestrictPublicationExistsSql('accounts.id'))}`).executeTakeFirst();
      return row ? [series(row)] : [];
    },
    async listPublicDirectory(limit, after, language) {
      let query = tx.selectFrom('digest_series')
        .innerJoin('accounts', 'accounts.subject_id', 'digest_series.owner_subject_id')
        .selectAll('digest_series')
        .where('accounts.status', '=', 'active').where('accounts.deleted_at', 'is', null)
        .where('digest_series.state', '=', 'active').where('digest_series.visibility', '=', 'public')
        .where('digest_series.slug', 'is not', null)
        .where(sql<boolean>`not ${sql.raw(accountRestrictPublicationExistsSql('accounts.id'))}`);
      if (language != null) query = query.where('digest_series.language', '=', language);
      if (after) query = query.where(eb => eb.or([
        eb(sql<Date>`date_trunc('milliseconds', digest_series.updated_at)`, '<', new Date(after.updatedAt)),
        eb.and([eb(sql<Date>`date_trunc('milliseconds', digest_series.updated_at)`, '=', new Date(after.updatedAt)), eb('digest_series.id', '>', after.id)]),
      ]));
      return (await query.orderBy(sql`date_trunc('milliseconds', digest_series.updated_at)`, 'desc').orderBy('digest_series.id', 'asc')
        .limit(limit).execute()).map(series);
    },
    async listAll(limit = 2_001) {
      const rows = await tx.selectFrom('digest_series').innerJoin('accounts', 'accounts.subject_id', 'digest_series.owner_subject_id')
        .select(['digest_series.id','digest_series.owner_subject_id','digest_series.title','digest_series.summary','digest_series.slug','digest_series.visibility','digest_series.allow_search_indexing','digest_series.state','digest_series.resource_revision','digest_series.content_revision','digest_series.policy_revision','digest_series.commit_ordinal','digest_series.created_at','digest_series.updated_at','digest_series.deleted_at','digest_series.tags','digest_series.language'])
        .where('accounts.status','=','active').where('accounts.deleted_at','is',null).where('digest_series.state','=','active').where(sql<boolean>`not ${sql.raw(accountRestrictPublicationExistsSql('accounts.id'))}`).orderBy('digest_series.updated_at','desc').orderBy('digest_series.id','asc').limit(limit).execute();
      return rows.map(series);
    },
  };
}

export function createPostgresReportSeriesReadPort(tx: DatabaseTransaction): ReportSeriesReadPort {
  const read = async (column: 'id'|'slug', value: string): Promise<DigestSeries | null> => {
    let query = tx.selectFrom('digest_series').innerJoin('accounts', 'accounts.subject_id', 'digest_series.owner_subject_id')
      .select(['digest_series.id','digest_series.owner_subject_id','digest_series.title','digest_series.summary','digest_series.slug','digest_series.visibility','digest_series.allow_search_indexing','digest_series.state','digest_series.resource_revision','digest_series.content_revision','digest_series.policy_revision','digest_series.commit_ordinal','digest_series.created_at','digest_series.updated_at','digest_series.deleted_at','digest_series.tags','digest_series.language'])
      .where('accounts.status', '=', 'active')
      .where('accounts.deleted_at', 'is', null)
      .where(sql<boolean>`not ${sql.raw(accountRestrictPublicationExistsSql('accounts.id'))}`);
    query = column === 'id' ? query.where('digest_series.id', '=', value) : query.where('digest_series.slug', '=', value);
    const row = await query.executeTakeFirst();
    return row ? series(row) : null;
  };
  return { findById: (id) => read('id', id), findBySlug: (slug) => read('slug', slug) };
}

export function createPostgresReportEditionReadPort(tx: DatabaseTransaction): ReportEditionReadPort {
  const listBySeries = async (seriesId: string, limit = 2_001): Promise<readonly DigestEdition[]> => {
    const rows = await tx.selectFrom('digest_editions').selectAll().where('series_id', '=', seriesId)
      .orderBy('edition_ordinal', 'desc').limit(limit).execute();
    return rows.map(edition);
  };
  const listBySeriesIds = async (seriesIds: readonly string[], limitPerSeries = 2_001): Promise<ReadonlyMap<string, readonly DigestEdition[]>> => {
    const ids = [...new Set(seriesIds)];
    if (ids.length === 0) return new Map();
    if (!Number.isSafeInteger(limitPerSeries) || limitPerSeries < 1 || limitPerSeries > 2_001) {
      throw new RangeError('report edition batch limit is out of range');
    }
    const placeholders = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const rows = await sql<DigestEditionTable>`
      SELECT id, series_id, source_collection_id, issue_key, edition_ordinal,
             title_snapshot, summary_snapshot, source_content_revision,
             source_policy_revision, resource_revision, period_start, period_end,
             state, published_at, created_at, updated_at, withdrawn_at, detached_at
        FROM (
          SELECT e.*, row_number() OVER (
            PARTITION BY e.series_id ORDER BY e.edition_ordinal DESC, e.id ASC
          ) AS report_row_number
            FROM digest_editions e
           WHERE e.series_id IN (${placeholders})
        ) ranked
       WHERE report_row_number <= ${limitPerSeries}
       ORDER BY series_id ASC, edition_ordinal DESC, id ASC
       LIMIT ${MAX_REPORT_BATCH_ROWS}
    `.execute(tx);
    const grouped = new Map<string, DigestEdition[]>();
    for (const row of rows.rows) {
      const values = grouped.get(row.series_id) ?? [];
      values.push(edition(row));
      grouped.set(row.series_id, values);
    }
    return grouped;
  };
  return {
    async findById(id) {
      const row = await tx.selectFrom('digest_editions').selectAll().where('id', '=', id).executeTakeFirst();
      return row ? edition(row) : null;
    },
    listBySeries,
    listBySeriesIds,
    listPublishedBySeries: (seriesId, limit, after) => listPublishedEditions(tx, seriesId, limit, after, true),
    listPublishedBySeriesIds: (seriesIds, limit) => listPublishedEditionsBySeries(tx, seriesIds, limit, true),
    publicProjectionRevision: (seriesId) => publicProjectionRevision(tx, seriesId),
  };
}

export function createPostgresReportEditionWritePort(
  tx: DatabaseTransaction,
  ledger: ResourceIdLedgerPort = createPostgresResourceIdLedgerPort(tx),
): ReportEditionWritePort {
  return {
    async insert(value) {
      await reserve(ledger, value.id, 'digest_edition');
      await tx.insertInto('digest_editions').values({ id: value.id, series_id: value.seriesId, source_collection_id: value.sourceCollectionId,
        issue_key: value.issueKey, edition_ordinal: BigInt(value.editionOrdinal), title_snapshot: value.titleSnapshot,
        summary_snapshot: value.summarySnapshot, source_content_revision: value.sourceContentRevision,
        source_policy_revision: value.sourcePolicyRevision, resource_revision: value.resourceRevision,
        period_start: value.periodStart ? new Date(value.periodStart) : null, period_end: value.periodEnd ? new Date(value.periodEnd) : null,
        state: value.state, published_at: value.publishedAt ? new Date(value.publishedAt) : null,
        created_at: sql<Date>`current_timestamp`, updated_at: sql<Date>`current_timestamp`, withdrawn_at: null, detached_at: null }).execute();
    },
    async lockById(id) {
      const row = await tx.selectFrom('digest_editions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      return row ? edition(row) : null;
    },
    async findByIssueKey(seriesId, issueKey) {
      const row = await tx.selectFrom('digest_editions').selectAll().where('series_id', '=', seriesId).where('issue_key', '=', issueKey).executeTakeFirst();
      return row ? edition(row) : null;
    },
    async findById(id) {
      const row = await tx.selectFrom('digest_editions').selectAll().where('id', '=', id).executeTakeFirst();
      return row ? edition(row) : null;
    },
    async listBySeries(seriesId, limit = 2_001) {
      const rows = await tx.selectFrom('digest_editions').selectAll().where('series_id','=',seriesId).orderBy('edition_ordinal','desc').limit(limit).execute(); return rows.map(edition);
    },
    async listBySeriesIds(seriesIds, limitPerSeries = 2_001) {
      const ids = [...new Set(seriesIds)];
      if (ids.length === 0) return new Map();
      if (!Number.isSafeInteger(limitPerSeries) || limitPerSeries < 1 || limitPerSeries > 2_001) throw new RangeError('report edition batch limit is out of range');
      const placeholders = sql.join(ids.map((id) => sql`${id}`), sql`, `);
      const rows = await sql<DigestEditionTable>`
        SELECT id, series_id, source_collection_id, issue_key, edition_ordinal,
               title_snapshot, summary_snapshot, source_content_revision,
               source_policy_revision, resource_revision, period_start, period_end,
               state, published_at, created_at, updated_at, withdrawn_at, detached_at
          FROM (
            SELECT e.*, row_number() OVER (
              PARTITION BY e.series_id ORDER BY e.edition_ordinal DESC, e.id ASC
            ) AS report_row_number
              FROM digest_editions e
             WHERE e.series_id IN (${placeholders})
          ) ranked
         WHERE report_row_number <= ${limitPerSeries}
         ORDER BY series_id ASC, edition_ordinal DESC, id ASC
         LIMIT ${MAX_REPORT_BATCH_ROWS}
      `.execute(tx);
      const grouped = new Map<string, DigestEdition[]>();
      for (const row of rows.rows) {
        const values = grouped.get(row.series_id) ?? [];
        values.push(edition(row));
        grouped.set(row.series_id, values);
      }
      return grouped;
    },
    listPublishedBySeries: (seriesId, limit, after) => listPublishedEditions(tx, seriesId, limit, after, true),
    listPublishedBySeriesIds: (seriesIds, limit) => listPublishedEditionsBySeries(tx, seriesIds, limit, true),
    publicProjectionRevision: (seriesId) => publicProjectionRevision(tx, seriesId),
    async update(id, patch) {
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || ['id','seriesId','sourceCollectionId','issueKey','editionOrdinal'].includes(key)) continue;
        const map: Record<string,string> = { titleSnapshot:'title_snapshot', summarySnapshot:'summary_snapshot', sourceContentRevision:'source_content_revision', sourcePolicyRevision:'source_policy_revision', resourceRevision:'resource_revision', periodStart:'period_start', periodEnd:'period_end', publishedAt:'published_at', state:'state' };
        const column = map[key]; if (!column) continue;
        values[column] = (key === 'periodStart' || key === 'periodEnd' || key === 'publishedAt') && value !== null ? new Date(value as string) : value;
      }
      if (patch.state === 'withdrawn') values.withdrawn_at = sql<Date>`current_timestamp`;
      if (patch.state === 'detached') values.detached_at = sql<Date>`current_timestamp`;
      values.updated_at = sql<Date>`current_timestamp`;
      const row = await tx.updateTable('digest_editions').set(values).where('id', '=', id).returningAll().executeTakeFirst();
      if (!row) throw new Error(`report edition ${id} disappeared`);
      return edition(row);
    },
  };
}

export function createPostgresReportMemberWritePort(tx: DatabaseTransaction): ReportMemberWritePort {
  return {
    async ensureOwner(value: DigestMember) {
      await tx.insertInto('digest_members').values({ series_id: value.seriesId, subject_id: value.subjectId, role: 'owner', revoked_at: null, granted_at: sql<Date>`current_timestamp` }).onConflict((oc) => oc.columns(['series_id','subject_id']).doNothing()).execute();
      const row = await tx.selectFrom('digest_members').selectAll().where('series_id','=',value.seriesId).where('subject_id','=',value.subjectId).executeTakeFirst();
      if (!row || row.role !== 'owner' || row.revoked_at !== null) throw new Error('digest owner membership invariant violated');
    },
    async get(seriesId, subjectId) {
      const row = await tx.selectFrom('digest_members').innerJoin('accounts', 'accounts.subject_id', 'digest_members.subject_id')
        .select(['digest_members.series_id','digest_members.subject_id','digest_members.role','digest_members.revoked_at'])
        .where('digest_members.series_id','=',seriesId).where('digest_members.subject_id','=',subjectId)
        .where('accounts.status','=','active').where('accounts.deleted_at','is',null).executeTakeFirst();
      return row ? { seriesId: row.series_id, subjectId: row.subject_id, role: row.role, revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null } : null;
    },
    async isActiveSubject(subjectId) {
      const row = await tx.selectFrom('accounts').select('subject_id').where('subject_id','=',subjectId).where('status','=','active').where('deleted_at','is',null).executeTakeFirst();
      return row !== undefined;
    },
    async list(seriesId, limit = 1_001) {
      const rows = await tx.selectFrom('digest_members').innerJoin('accounts', 'accounts.subject_id', 'digest_members.subject_id')
        .select(['digest_members.series_id','digest_members.subject_id','digest_members.role','digest_members.revoked_at'])
        .where('digest_members.series_id', '=', seriesId)
        .where('accounts.status','=','active').where('accounts.deleted_at','is',null)
        .where('digest_members.revoked_at','is',null)
        .orderBy('digest_members.granted_at', 'asc').limit(limit).execute();
      return rows.map((row) => ({ seriesId: row.series_id, subjectId: row.subject_id, role: row.role, revokedAt: null }));
    },
    async upsert(value) {
      if (value.role === 'owner') throw new Error('owner role is immutable');
      const active = await tx.selectFrom('accounts').select('subject_id').where('subject_id','=',value.subjectId).where('status','=','active').where('deleted_at','is',null).executeTakeFirst();
      if (!active) throw new Error('report member subject is not active');
      await tx.insertInto('digest_members').values({ series_id: value.seriesId, subject_id: value.subjectId, role: value.role, revoked_at: null, granted_at: sql<Date>`current_timestamp` }).onConflict((oc) => oc.columns(['series_id','subject_id']).doUpdateSet({ role: value.role, revoked_at: null })).execute();
      const row = await tx.selectFrom('digest_members').selectAll().where('series_id','=',value.seriesId).where('subject_id','=',value.subjectId).executeTakeFirstOrThrow();
      return { seriesId: row.series_id, subjectId: row.subject_id, role: row.role, revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null };
    },
    async revoke(seriesId, subjectId) {
      await tx.updateTable('digest_members').set({ revoked_at: sql<Date>`current_timestamp` }).where('series_id','=',seriesId).where('subject_id','=',subjectId).where('role','!=','owner').execute();
    },
  };
}

export function createPostgresReportSourceReadPort(tx: DatabaseTransaction): ReportSourceReadPort {
  type SourceRow = {
    readonly id: string;
    readonly owner_subject_id: string;
    readonly visibility: ReportSourceFacts['visibility'];
    readonly published_at: Date | null;
    readonly publication_slug: string | null;
    readonly root_node_id: string | null;
    readonly root_node_is_root: boolean;
    readonly allow_search_indexing: boolean;
    readonly content_revision: string;
    readonly policy_revision: string;
    readonly updated_at: Date | null;
    readonly deleted_at: Date | null;
    readonly owner_status: string | null;
    readonly owner_deleted_at: Date | null;
    readonly seed_excluded: boolean;
    readonly member_role?: 'owner' | 'editor' | 'viewer' | null;
    readonly member_status?: string | null;
    readonly member_deleted_at?: Date | null;
    readonly actor_status?: string | null;
    readonly actor_deleted_at?: Date | null;
    readonly hidden_public?: boolean;
  };
  const toFacts = (row: SourceRow): ReportSourceFacts => ({
    collectionId: row.id,
    visibility: row.visibility,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    publicationSlug: row.publication_slug,
    hasRoot: Boolean(row.root_node_id && row.root_node_is_root),
    allowSearchIndexing: Boolean(row.allow_search_indexing),
    ownerAccountActive: row.owner_status === 'active' && row.owner_deleted_at === null,
    deleted: row.deleted_at !== null,
    seedExcluded: Boolean(row.seed_excluded),
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    hiddenPublic: Boolean(row.hidden_public),
  });
  const selectColumns = [
    'collections.id', 'collections.owner_subject_id', 'collections.visibility',
    'collections.published_at', 'collections.publication_slug', 'collections.root_node_id',
    'collections.root_node_is_root', 'collections.allow_search_indexing',
    'collections.content_revision', 'collections.policy_revision', 'collections.deleted_at',
    'collections.updated_at',
    'accounts.status as owner_status',
    'accounts.deleted_at as owner_deleted_at',
    sql<boolean>`exists (select 1 from seed_rows sr where sr.table_name = 'collections' and sr.pk->>0 = collections.id)`.as('seed_excluded'),
    sql<boolean>`${sql.raw(collectionHidePublicExistsSql('collections.id'))}`.as('hidden_public'),
  ] as const;
  const readMany = async (collectionIds: readonly string[]): Promise<readonly ReportSourceFacts[]> => {
    const ids = [...new Set(collectionIds)];
    if (ids.length === 0) return [];
    const rows = await tx.selectFrom('collections').leftJoin('accounts', 'accounts.subject_id', 'collections.owner_subject_id')
      // The account join is deliberately nullable: a deleted/unknown owner
      // must become an inactive source fact rather than disappearing. Scope
      // the row lock to the authoritative collection table; an unqualified
      // FOR SHARE is rejected by PostgreSQL when an outer-joined table is
      // nullable (and would otherwise fail every public projection read).
      .select(selectColumns).where('collections.id', 'in', ids).forShare('collections').execute();
    return rows.map((row) => toFacts(row as unknown as SourceRow));
  };
  const read = async (collectionId: string): Promise<ReportSourceFacts | null> => (await readMany([collectionId]))[0] ?? null;
  const getForActor = async (
    collectionId: string,
    actor: { readonly subjectId: string },
  ): Promise<import('../../modules/reports/index.js').ReportSourceReadResult> => {
    const row = await tx.selectFrom('collections')
      .leftJoin('accounts', 'accounts.subject_id', 'collections.owner_subject_id')
      .leftJoin('accounts as actor_accounts', (join) => join
        .on('actor_accounts.subject_id', '=', actor.subjectId))
      .leftJoin('collection_members', (join) => join
        .onRef('collection_members.collection_id', '=', 'collections.id')
        .on('collection_members.subject_id', '=', actor.subjectId))
      .leftJoin('accounts as member_accounts', (join) => join
        .onRef('member_accounts.subject_id', '=', 'collection_members.subject_id'))
      .select([
        ...selectColumns,
        'collection_members.role as member_role',
        'member_accounts.status as member_status',
        'member_accounts.deleted_at as member_deleted_at',
        'actor_accounts.status as actor_status',
        'actor_accounts.deleted_at as actor_deleted_at',
      ])
      .where('collections.id', '=', collectionId)
      // Lock only the source row. The account/member joins are nullable and
      // PostgreSQL rejects an unqualified FOR SHARE over their nullable side.
      .forShare('collections')
      .executeTakeFirst();
    if (!row) return { verdict: 'not_found' };
    const source = toFacts(row as unknown as SourceRow);
    if (!source.ownerAccountActive || source.deleted
      || row.actor_status !== 'active' || row.actor_deleted_at !== null) {
      return { verdict: 'not_found' };
    }
    const rowWithAccess = row as unknown as SourceRow;
    // Unlisted Collections are intentionally conceal-on-ID for non-members;
    // only a public source grants anonymous read authority.  An unlisted
    // source therefore still requires the actor to be its owner or an active
    // Collection member, matching the shared access-policy evaluator.
    const authorized = source.visibility === 'public'
      || rowWithAccess.owner_subject_id === actor.subjectId
      || (rowWithAccess.member_role !== null && rowWithAccess.member_role !== undefined
        && rowWithAccess.member_status === 'active'
        && rowWithAccess.member_deleted_at === null);
    return authorized
      ? { verdict: 'authorized', facts: source }
      : { verdict: 'not_public' };
  };
  return {
    publishedSourcesIndexableBySeriesIds: (ids) => publishedSourcesIndexableBySeriesIds(tx, ids),
    get: read,
    getMany: readMany,
    getForActor,
  };
}

export function createPostgresReportFollowWritePort(tx: DatabaseTransaction): ReportFollowWritePort {
  return {
    async lockActiveProfile(profileId) {
      const row = await sql<{ account_id: string }>`
        select profiles.account_id
          from profiles
          inner join accounts on accounts.id = profiles.account_id
         where profiles.account_id = ${profileId}
           and accounts.status = 'active'
           and accounts.deleted_at is null
           and not ${sql.raw(accountRestrictInteractionExistsSql('profiles.account_id'))}
         for update of profiles, accounts
      `.execute(tx);
      return row.rows[0] !== undefined;
    },
    async upsert(seriesId, profileId, now) {
      const current = await tx.selectFrom('digest_follows').selectAll().where('series_id','=',seriesId).where('follower_profile_id','=',profileId).forUpdate().executeTakeFirst();
      if (!current) { await tx.insertInto('digest_follows').values({ series_id: seriesId, follower_profile_id: profileId, followed_at: now, unfollowed_at: null }).execute(); return { changed: true, followedAt: now }; }
      if (current.unfollowed_at === null) return { changed: false, followedAt: current.followed_at };
      await tx.updateTable('digest_follows').set({ followed_at: now, unfollowed_at: null }).where('series_id','=',seriesId).where('follower_profile_id','=',profileId).execute(); return { changed: true, followedAt: now };
    },
    async remove(seriesId, profileId, now) {
      const current = await tx.selectFrom('digest_follows').selectAll().where('series_id','=',seriesId).where('follower_profile_id','=',profileId).forUpdate().executeTakeFirst();
      if (!current || current.unfollowed_at !== null) return { changed: false, followedAt: null };
      await tx.updateTable('digest_follows').set({ unfollowed_at: now }).where('series_id','=',seriesId).where('follower_profile_id','=',profileId).execute(); return { changed: true, followedAt: null };
    },
    async countActive(seriesId) {
      const row = await tx.selectFrom('digest_follows').innerJoin('profiles','profiles.account_id','digest_follows.follower_profile_id').innerJoin('accounts','accounts.id','profiles.account_id').select(sql<string>`count(*)`.as('count')).where('digest_follows.series_id','=',seriesId).where('digest_follows.unfollowed_at','is',null).where('accounts.status','=','active').where('accounts.deleted_at','is',null).executeTakeFirstOrThrow(); return Number(row.count);
    },
    async countActiveBySeriesIds(seriesIds) {
      const unique = [...new Set(seriesIds)];
      const counts = new Map<string, number>();
      if (unique.length === 0) return counts;
      if (unique.length > 2_048) throw new RangeError('Report follow batch count exceeds its bound');
      const rows = await tx.selectFrom('digest_follows').innerJoin('profiles','profiles.account_id','digest_follows.follower_profile_id').innerJoin('accounts','accounts.id','profiles.account_id').select(['digest_follows.series_id', sql<string>`count(*)`.as('count')]).where('digest_follows.series_id','in',unique).where('digest_follows.unfollowed_at','is',null).where('accounts.status','=','active').where('accounts.deleted_at','is',null).groupBy('digest_follows.series_id').execute();
      for (const row of rows) counts.set(row.series_id, Number(row.count));
      return counts;
    },
    async readState(seriesId, profileId) {
      const row = await tx.selectFrom('digest_follows').select(['followed_at','unfollowed_at']).where('series_id','=',seriesId).where('follower_profile_id','=',profileId).executeTakeFirst();
      return { following: !!row && row.unfollowed_at === null, followedAt: row && row.unfollowed_at === null ? row.followed_at : null };
    },
    async listOwned(subjectId, limit, after) {
      let q = tx.selectFrom('digest_series').innerJoin('accounts','accounts.subject_id','digest_series.owner_subject_id')
        .select(['digest_series.id','digest_series.owner_subject_id','digest_series.title','digest_series.summary','digest_series.slug','digest_series.visibility','digest_series.allow_search_indexing','digest_series.state','digest_series.resource_revision','digest_series.content_revision','digest_series.policy_revision','digest_series.updated_at'])
        .where('digest_series.owner_subject_id','=',subjectId).where('digest_series.state','=','active').where('accounts.status','=','active').where('accounts.deleted_at','is',null);
      if (after) q = q.where((eb) => eb.or([eb('digest_series.updated_at','<',after.updatedAt), eb.and([eb('digest_series.updated_at','=',after.updatedAt), eb('digest_series.id','>',after.seriesId)])]));
      const rows = await q.orderBy('digest_series.updated_at','desc').orderBy('digest_series.id','asc').limit(limit).execute();
      return rows.map((r) => series(r as unknown as DigestSeriesTable));
    },
    async listFollowed(profileId, limit, after) {
      let q = tx.selectFrom('digest_follows').innerJoin('digest_series','digest_series.id','digest_follows.series_id').innerJoin('accounts','accounts.subject_id','digest_series.owner_subject_id')
        .select(['digest_series.id','digest_series.owner_subject_id','digest_series.title','digest_series.summary','digest_series.slug','digest_series.visibility','digest_series.allow_search_indexing','digest_series.state','digest_series.resource_revision','digest_series.content_revision','digest_series.policy_revision','digest_series.updated_at','digest_follows.followed_at',sql<boolean>`${sql.raw(digestSeriesHidePublicExistsSql('digest_series.id'))}`.as('series_hidden_public')])
        .where('digest_follows.follower_profile_id','=',profileId).where('digest_follows.unfollowed_at','is',null).where('digest_series.state','=','active').where('digest_series.visibility','in',['public','unlisted']).where('accounts.status','=','active').where('accounts.deleted_at','is',null).where(sql<boolean>`not ${sql.raw(accountRestrictPublicationExistsSql('accounts.id'))}`);
      if (after) q = q.where((eb) => eb.or([eb('digest_follows.followed_at','<',after.followedAt), eb.and([eb('digest_follows.followed_at','=',after.followedAt), eb('digest_series.id','<',after.seriesId)])]));
      const rows = await q.orderBy('digest_follows.followed_at','desc').orderBy('digest_series.id','desc').limit(limit).execute();
      return rows.map((r) => Object.freeze({
        ...series(r as unknown as DigestSeriesTable),
        followedAt: r.followed_at,
        /* #21: hide_public keeps the row; the application tombstones it. */
        hiddenPublic: Boolean(r.series_hidden_public),
      }));
    },
    async listFollowedIssues(profileId, limit, after) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_001) {
        throw new RangeError('report timeline limit is out of range');
      }
      let q = tx.selectFrom('digest_follows').innerJoin('profiles','profiles.account_id','digest_follows.follower_profile_id').innerJoin('accounts as follower_accounts','follower_accounts.id','profiles.account_id').innerJoin('digest_series','digest_series.id','digest_follows.series_id').innerJoin('digest_editions','digest_editions.series_id','digest_series.id').innerJoin('collections','collections.id','digest_editions.source_collection_id').innerJoin('accounts','accounts.subject_id','digest_series.owner_subject_id').innerJoin('accounts as source_accounts','source_accounts.subject_id','collections.owner_subject_id')
        .select(['digest_series.id as s_id','digest_series.owner_subject_id as s_owner_subject_id','digest_series.title as s_title','digest_series.summary as s_summary','digest_series.slug as s_slug','digest_series.visibility as s_visibility','digest_series.allow_search_indexing as s_allow_search_indexing','digest_series.state as s_state','digest_series.resource_revision as s_resource_revision','digest_series.content_revision as s_content_revision','digest_series.policy_revision as s_policy_revision','digest_series.updated_at as s_updated_at','digest_editions.id as e_id','digest_editions.series_id as e_series_id','digest_editions.source_collection_id as e_source_collection_id','digest_editions.issue_key as e_issue_key','digest_editions.edition_ordinal as e_edition_ordinal','digest_editions.title_snapshot as e_title_snapshot','digest_editions.summary_snapshot as e_summary_snapshot','digest_editions.source_content_revision as e_source_content_revision','digest_editions.source_policy_revision as e_source_policy_revision','digest_editions.resource_revision as e_resource_revision','digest_editions.period_start as e_period_start','digest_editions.period_end as e_period_end','digest_editions.state as e_state','digest_editions.published_at as e_published_at','collections.visibility as source_visibility','collections.published_at as source_published_at','collections.publication_slug as source_publication_slug','collections.root_node_id as source_root_node_id','collections.root_node_is_root as source_root_node_is_root','collections.allow_search_indexing as source_allow_search_indexing','collections.content_revision as source_content_revision','collections.policy_revision as source_policy_revision','collections.updated_at as source_updated_at','collections.deleted_at as source_deleted_at','source_accounts.status as source_owner_status',sql<boolean>`exists (select 1 from seed_rows sr where sr.table_name = 'collections' and sr.pk->>0 = collections.id)`.as('source_seed_excluded'),sql<boolean>`${sql.raw(digestSeriesHidePublicExistsSql('digest_series.id'))}`.as('series_hidden_public'),sql<boolean>`${sql.raw(digestEditionHidePublicExistsSql('digest_editions.id', 'digest_series.id'))}`.as('edition_hidden_public')])
        .where('digest_follows.follower_profile_id','=',profileId).where('digest_follows.unfollowed_at','is',null).where('digest_editions.state','=','published').where('digest_editions.published_at','is not',null).where('digest_series.state','=','active').where('digest_series.visibility','in',['public','unlisted']).where('collections.visibility','=','public').where('collections.published_at','is not',null).where('collections.publication_slug','is not',null).where('collections.deleted_at','is',null).where('collections.root_node_is_root','=',true).where(sql<boolean>`exists (select 1 from nodes source_root where source_root.collection_id = collections.id and source_root.id = collections.root_node_id and source_root.is_root and source_root.deleted_at is null)`).where(sql<boolean>`not exists (select 1 from seed_rows sr where sr.table_name = 'collections' and sr.pk->>0 = collections.id)`).where('accounts.status','=','active').where('accounts.deleted_at','is',null).where('source_accounts.status','=','active').where('source_accounts.deleted_at','is',null).where('follower_accounts.status','=','active').where('follower_accounts.deleted_at','is',null)
        /* #21: series/edition hide_public keep their row — the application
           tombstones it; a hidden live source still omits the issue. */
        .where(sql.raw<boolean>(collectionHidePublicControlSql('collections')))
        .where(sql<boolean>`not ${sql.raw(accountRestrictPublicationExistsSql('accounts.id'))}`);
      if (after) q = q.where((eb) => eb.or([
        eb('digest_editions.published_at','<',after.publishedAt),
        eb.and([
          eb('digest_editions.published_at','=',after.publishedAt),
          eb('digest_editions.edition_ordinal','<',BigInt(after.editionOrdinal)),
        ]),
        eb.and([
          eb('digest_editions.published_at','=',after.publishedAt),
          eb('digest_editions.edition_ordinal','=',BigInt(after.editionOrdinal)),
          eb('digest_editions.id','>',after.editionId),
        ]),
      ]));
      const rows = await q.orderBy('digest_editions.published_at','desc').orderBy('digest_editions.edition_ordinal','desc').orderBy('digest_editions.id','asc').limit(limit).execute();
      return rows.map((r) => {
        const s = Object.freeze({ id:r.s_id, ownerSubjectId:r.s_owner_subject_id, title:r.s_title, summary:r.s_summary, slug:r.s_slug, visibility:r.s_visibility, allowSearchIndexing:r.s_allow_search_indexing, state:r.s_state, resourceRevision:r.s_resource_revision, contentRevision:r.s_content_revision, policyRevision:r.s_policy_revision, updatedAt:r.s_updated_at?.toISOString(), hiddenPublic: Boolean(r.series_hidden_public) });
        const e = Object.freeze({ id:r.e_id, seriesId:r.e_series_id, sourceCollectionId:r.e_source_collection_id, issueKey:r.e_issue_key, editionOrdinal:Number(r.e_edition_ordinal), titleSnapshot:r.e_title_snapshot, summarySnapshot:r.e_summary_snapshot, sourceContentRevision:r.e_source_content_revision, sourcePolicyRevision:r.e_source_policy_revision, resourceRevision:r.e_resource_revision, periodStart:r.e_period_start?.toISOString() ?? null, periodEnd:r.e_period_end?.toISOString() ?? null, state:r.e_state, publishedAt:r.e_published_at?.toISOString() ?? null });
        const sourceFence: ReportIssueSourceFence = {
          visibility: r.source_visibility,
          publishedAt: r.source_published_at?.toISOString() ?? null,
          publicationSlug: r.source_publication_slug,
          hasRoot: Boolean(r.source_root_node_id && r.source_root_node_is_root),
          allowSearchIndexing: Boolean(r.source_allow_search_indexing),
          ownerAccountActive: r.source_owner_status === 'active',
          deleted: r.source_deleted_at !== null,
          seedExcluded: Boolean(r.source_seed_excluded),
          contentRevision: r.source_content_revision,
          policyRevision: r.source_policy_revision,
          updatedAt: r.source_updated_at?.toISOString(),
        };
        return Object.freeze({ ...e, series: s, editionHiddenPublic: Boolean(r.edition_hidden_public), sourceFence });
      });
    },
  };
}

export function createPostgresReportAuditPort(tx: DatabaseTransaction): ReportAuditPort {
  return { async append(event) { await tx.insertInto('digest_audit_events').values({ series_id: event.seriesId ?? null, edition_id: event.editionId ?? null, principal_id: event.principalId, principal_type: event.principalType, action: event.action, changed: event.changed, occurred_at: event.occurredAt, details: event.details ?? {} }).execute(); } };
}

export { opaque as generateReportOpaqueId };

export { series as mapDigestSeriesRow };
