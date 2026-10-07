import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { collectionHidePublicExistsSql, digestEditionHidePublicExistsSql } from './collection-control-sql.js';
import {
  GovernanceModerationError,
  governanceTimestamp,
  type EvidenceCapture,
  type GovernanceTarget,
  type ModerationTargetResolver,
} from '../../modules/governance/index.js';

type Executor = Kysely<DatabaseSchema> | DatabaseTransaction;

export function createPostgresModerationTargetResolver(
  executor: Executor,
  clock: { now(): Promise<Date> },
): ModerationTargetResolver {
  return {
    async resolve(actor, target) {
      const capturedAt = governanceTimestamp(await clock.now());
      if (target.kind === 'collection') return readCollection(executor, actor, target, capturedAt);
      if (target.kind === 'bookmark') return readBookmark(executor, actor, target, capturedAt);
      if (target.kind === 'digest_series') return readSeries(executor, actor, target, capturedAt);
      if (target.kind === 'digest_edition') return readEdition(executor, target, capturedAt);
      if (target.kind === 'account') return readAccount(executor, target, capturedAt);
      if (target.kind === 'comment') return readComment(executor, actor, target, capturedAt);
      throw new GovernanceModerationError('invalid_request', 'comment targets are not supported');
    },
  };
}

async function readCollection(
  executor: Executor,
  actor: { readonly subjectId: string },
  target: Extract<GovernanceTarget, { kind: 'collection' }>,
  capturedAt: string,
): Promise<EvidenceCapture> {
  const collection = await loadCollection(executor, target.id);
  // Same standard as the current public read: an officially hide_public'd
  // Collection is concealed from reporters who can only reach it through the
  // public/origin path; the owner and active members keep their private
  // management entry (hide_public preserves owner access).
  await assertCollectionReportable(executor, actor, collection);
  return snapshot({
    target,
    capturedAt,
    sourceRevision: collection.resource_revision,
    title: collection.title,
    text: collection.summary,
    sourceUrl: null,
  });
}

async function readBookmark(
  executor: Executor,
  actor: { readonly subjectId: string },
  target: Extract<GovernanceTarget, { kind: 'bookmark' }>,
  capturedAt: string,
): Promise<EvidenceCapture> {
  const collection = await loadCollection(executor, target.collectionId);
  const access = await resolveCollectionAccess(executor, actor, collection);
  if (access === 'denied') conceal();
  const requirePublicNode = access === 'origin';
  if (requirePublicNode && await isCollectionHiddenPublic(executor, collection.id)) conceal();
  // Origin-path reporters may only capture bookmark nodes they can actually
  // read through the public projection: a node must be visibility 'inherit'
  // with no private/protected ancestor (mirrors the COLP snapshot
  // isPubliclyVisible predicate). Owner/member reporters keep their private
  // management read.
  const node = await loadReportableBookmarkNode(executor, target, requirePublicNode);
  if (!node) conceal();
  return snapshot({
    target,
    capturedAt,
    sourceRevision: node.resource_revision,
    title: node.title,
    text: node.description,
    sourceUrl: httpUrl(node.url),
  });
}

async function readSeries(
  executor: Executor,
  actor: { readonly subjectId: string },
  target: Extract<GovernanceTarget, { kind: 'digest_series' }>,
  capturedAt: string,
): Promise<EvidenceCapture> {
  const series = await loadSeries(executor, target.id);
  // hide_public on the series blocks the public/origin reporter like the
  // public issue GET; the series owner and active members keep their private
  // management entry.
  const access = await resolveSeriesAccess(executor, actor, series);
  if (access === 'denied') conceal();
  if (access === 'origin' && await isSeriesHiddenPublic(executor, series.id)) conceal();
  return snapshot({
    target,
    capturedAt,
    sourceRevision: series.resource_revision,
    title: series.title,
    text: series.summary,
    sourceUrl: null,
  });
}

async function readEdition(
  executor: Executor,
  target: Extract<GovernanceTarget, { kind: 'digest_edition' }>,
  capturedAt: string,
): Promise<EvidenceCapture> {
  const series = await loadSeries(executor, target.seriesId);
  // Edition targets are captured under the same standard as the public direct
  // issue GET (isEditionPubliclyDirect): the series must itself be publicly
  // direct-readable and the edition must be a published issue of an eligible
  // public live source. A public series cannot make a draft/withdrawn edition
  // or a private/delisted source reportable (CG-02 rejects private content;
  // the digest export table checks series, edition, and live source
  // independently). The original unlisted-directory CG-05 report path keeps
  // working because published editions sourced from public Collections still
  // satisfy every gate below.
  if (!isSeriesPubliclyDirectReadable(series)) conceal();
  const result = await sql<{
    id: string;
    title_snapshot: string;
    summary_snapshot: string | null;
    resource_revision: string;
    source_allow_search_indexing: boolean;
  }>`
    SELECT e.id, e.title_snapshot, e.summary_snapshot, e.resource_revision,
           c.allow_search_indexing AS source_allow_search_indexing
      FROM digest_editions e
      JOIN collections c ON c.id = e.source_collection_id
      LEFT JOIN accounts acc ON acc.subject_id = c.owner_subject_id
     WHERE e.id = ${target.id}
       AND e.series_id = ${target.seriesId}
       AND e.state = 'published'
       AND e.published_at IS NOT NULL
       AND c.deleted_at IS NULL
       AND acc.status = 'active'
       AND acc.deleted_at IS NULL
       AND c.visibility = 'public'
       AND c.published_at IS NOT NULL
       AND c.publication_slug IS NOT NULL
       AND c.root_node_id IS NOT NULL
       AND c.root_node_is_root
       AND NOT ${sql.raw(collectionHidePublicExistsSql('c.id'))}
       AND NOT ${sql.raw(digestEditionHidePublicExistsSql('e.id', 'e.series_id'))}
       AND NOT EXISTS (
         SELECT 1 FROM moderation_actions ma
          WHERE ma.target_kind = 'digest_series'
            AND ma.target_id = e.series_id
            AND ma.state = 'active'
            AND ma.action = 'hide_public'
       )
     LIMIT 1
  `.execute(executor);
  const edition = result.rows[0];
  if (!edition) conceal();
  // Direct-read parity: a public series only grants direct issue reads while
  // the live source remains search-indexable (isEditionPubliclyDirect).
  if (series.visibility === 'public' && !edition.source_allow_search_indexing) conceal();
  return snapshot({
    target,
    capturedAt,
    sourceRevision: edition.resource_revision,
    title: edition.title_snapshot,
    text: edition.summary_snapshot,
    sourceUrl: null,
  });
}

async function readAccount(
  executor: Executor,
  target: Extract<GovernanceTarget, { kind: 'account' }>,
  capturedAt: string,
): Promise<EvidenceCapture> {
  const result = await sql<{
    id: string;
    display_name: string | null;
    handle: string | null;
  }>`
    SELECT a.id, p.display_name, h.handle
      FROM accounts a
      LEFT JOIN profiles p ON p.account_id = a.id
      LEFT JOIN profile_handles h ON h.account_id = a.id
     WHERE a.id = ${target.id}
       AND a.deleted_at IS NULL
       AND a.status = 'active'
     LIMIT 1
  `.execute(executor);
  const account = result.rows[0];
  if (!account) conceal();
  return snapshot({
    target,
    capturedAt,
    sourceRevision: null,
    title: account.display_name,
    text: account.handle,
    sourceUrl: null,
  });
}

async function readComment(
  executor: Executor,
  actor: { readonly subjectId: string },
  target: Extract<GovernanceTarget, { kind: 'comment' }>,
  capturedAt: string,
): Promise<EvidenceCapture> {
  const result = await sql<{
    comment_id: string;
    body: string | null;
    state: string;
    revision: string;
    target_kind: string;
    target_id: string;
    target_collection_id: string | null;
    target_series_id: string | null;
  }>`
    SELECT comment_id, body, state, revision::text AS revision,
           target_kind, target_id, target_collection_id, target_series_id
      FROM community_comments
     WHERE comment_id = ${target.id}
     LIMIT 1
  `.execute(executor);
  const comment = result.rows[0];
  if (!comment || comment.state === 'deleted') conceal();
  // Origin reporters only capture comments whose parent is still
  // reportable on the public/origin path; owner and active members keep
  // the same private-parent exception collection/bookmark/series reports
  // already grant (leftover comments after a collection goes private).
  await assertCommentParentReportable(executor, actor, comment, capturedAt);
  return snapshot({
    target,
    capturedAt,
    sourceRevision: comment.revision,
    title: comment.comment_id,
    text: comment.body,
    sourceUrl: null,
  });
}

async function assertCommentParentReportable(
  executor: Executor,
  actor: { readonly subjectId: string },
  comment: {
    readonly target_kind: string;
    readonly target_id: string;
    readonly target_collection_id: string | null;
    readonly target_series_id: string | null;
  },
  capturedAt: string,
): Promise<void> {
  if (comment.target_kind === 'collection') {
    await readCollection(executor, actor, { kind: 'collection', id: comment.target_id }, capturedAt);
    return;
  }
  if (comment.target_kind === 'bookmark') {
    if (comment.target_collection_id === null) conceal();
    await readBookmark(executor, actor, {
      kind: 'bookmark',
      id: comment.target_id,
      collectionId: comment.target_collection_id,
    }, capturedAt);
    return;
  }
  if (comment.target_kind === 'digest_series') {
    await readSeries(executor, actor, { kind: 'digest_series', id: comment.target_id }, capturedAt);
    return;
  }
  if (comment.target_kind === 'digest_edition') {
    if (comment.target_series_id === null) conceal();
    await readEdition(executor, {
      kind: 'digest_edition',
      id: comment.target_id,
      seriesId: comment.target_series_id,
    }, capturedAt);
    return;
  }
  conceal();
}

async function loadCollection(executor: Executor, collectionId: string): Promise<{
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  visibility: string;
  resource_revision: string;
}> {
  const result = await sql<{
    id: string;
    owner_subject_id: string;
    title: string;
    summary: string | null;
    visibility: string;
    resource_revision: string;
  }>`
    SELECT id, owner_subject_id, title, summary, visibility, resource_revision
      FROM collections
     WHERE id = ${collectionId} AND deleted_at IS NULL
     LIMIT 1
  `.execute(executor);
  const row = result.rows[0];
  if (!row) conceal();
  return row;
}

async function loadSeries(executor: Executor, seriesId: string): Promise<{
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  slug: string | null;
  visibility: string;
  resource_revision: string;
}> {
  const result = await sql<{
    id: string;
    owner_subject_id: string;
    title: string;
    summary: string | null;
    slug: string | null;
    visibility: string;
    resource_revision: string;
  }>`
    SELECT id, owner_subject_id, title, summary, slug, visibility, resource_revision
      FROM digest_series
     WHERE id = ${seriesId} AND deleted_at IS NULL AND state = 'active'
     LIMIT 1
  `.execute(executor);
  const row = result.rows[0];
  if (!row) conceal();
  return row;
}

type ReportAccess = 'owner' | 'member' | 'origin' | 'denied';

async function assertCollectionReportable(
  executor: Executor,
  actor: { readonly subjectId: string },
  collection: { readonly owner_subject_id: string; readonly visibility: string; readonly id: string },
): Promise<void> {
  const access = await resolveCollectionAccess(executor, actor, collection);
  if (access === 'denied') conceal();
  if (access === 'origin' && await isCollectionHiddenPublic(executor, collection.id)) conceal();
}

async function resolveCollectionAccess(
  executor: Executor,
  actor: { readonly subjectId: string },
  collection: { readonly owner_subject_id: string; readonly visibility: string; readonly id: string },
): Promise<ReportAccess> {
  if (collection.owner_subject_id === actor.subjectId) return 'owner';
  const member = await sql<{ subject_id: string }>`
    SELECT subject_id FROM collection_members
     WHERE collection_id = ${collection.id} AND subject_id = ${actor.subjectId}
     LIMIT 1
  `.execute(executor);
  if (member.rows[0]) return 'member';
  if (isOriginReadable(collection.visibility)) return 'origin';
  return 'denied';
}

async function resolveSeriesAccess(
  executor: Executor,
  actor: { readonly subjectId: string },
  series: { readonly owner_subject_id: string; readonly visibility: string; readonly id: string },
): Promise<ReportAccess> {
  if (series.owner_subject_id === actor.subjectId) return 'owner';
  const member = await sql<{ subject_id: string }>`
    SELECT subject_id FROM digest_members
     WHERE series_id = ${series.id} AND subject_id = ${actor.subjectId} AND revoked_at IS NULL
     LIMIT 1
  `.execute(executor);
  if (member.rows[0]) return 'member';
  if (isOriginReadable(series.visibility)) return 'origin';
  return 'denied';
}

async function isCollectionHiddenPublic(executor: Executor, collectionId: string): Promise<boolean> {
  const result = await sql<{ hidden: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM moderation_actions ma
       WHERE ma.target_kind = 'collection'
         AND ma.target_id = ${collectionId}
         AND ma.state = 'active'
         AND ma.action = 'hide_public'
    ) AS hidden
  `.execute(executor);
  return result.rows[0]?.hidden === true;
}

async function isSeriesHiddenPublic(executor: Executor, seriesId: string): Promise<boolean> {
  const result = await sql<{ hidden: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM moderation_actions ma
       WHERE ma.target_kind = 'digest_series'
         AND ma.target_id = ${seriesId}
         AND ma.state = 'active'
         AND ma.action = 'hide_public'
    ) AS hidden
  `.execute(executor);
  return result.rows[0]?.hidden === true;
}

async function loadReportableBookmarkNode(
  executor: Executor,
  target: Extract<GovernanceTarget, { kind: 'bookmark' }>,
  requirePublic: boolean,
): Promise<{
  readonly id: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly url: string | null;
  readonly resource_revision: string;
} | undefined> {
  const result = await sql<{
    id: string;
    title: string | null;
    description: string | null;
    url: string | null;
    resource_revision: string;
  }>`
    SELECT n.id, n.title, n.description, n.url, n.resource_revision
      FROM nodes n
     WHERE n.id = ${target.id}
       AND n.collection_id = ${target.collectionId}
       AND n.kind = 'bookmark'
       AND n.deleted_at IS NULL
       ${requirePublic
         ? sql`AND n.visibility = 'inherit'
       AND NOT EXISTS (
         WITH RECURSIVE ancestors AS (
           SELECT p.id, p.parent_id, p.visibility
             FROM nodes p
            WHERE p.collection_id = n.collection_id
              AND p.id = n.parent_id
           UNION ALL
           SELECT p.id, p.parent_id, p.visibility
             FROM nodes p
             JOIN ancestors a ON p.id = a.parent_id
            WHERE p.collection_id = n.collection_id
         )
         SELECT 1 FROM ancestors WHERE visibility IN ('private', 'protected')
       )`
         : sql``}
     LIMIT 1
  `.execute(executor);
  return result.rows[0];
}

function isOriginReadable(visibility: string): boolean {
  return visibility === 'public' || visibility === 'unlisted';
}

/**
 * Series-level half of the public digest direct-read standard
 * (isSeriesPubliclyReadable): loadSeries already proves state = 'active' and
 * a live row, so only the slug/visibility half and the hide_public control
 * (checked in the edition SQL) remain.
 */
function isSeriesPubliclyDirectReadable(series: { readonly slug: string | null; readonly visibility: string }): boolean {
  return series.slug !== null && isOriginReadable(series.visibility);
}

function snapshot(input: EvidenceCapture): EvidenceCapture {
  return Object.freeze({ ...input });
}

function httpUrl(value: string | null): string | null {
  if (value === null || value.length < 1 || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return value;
  } catch {
    return null;
  }
}

function conceal(): never {
  throw new GovernanceModerationError('resource_not_found', 'target was not found', 'conceal');
}
