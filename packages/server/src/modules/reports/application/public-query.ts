import { loadPublicDirectoryEditionData } from './public-directory-editions.js';
import { loadReportIndexability } from './public-indexability.js';
import { createHash } from 'node:crypto';
import { readPublicDirectoryPage, directoryCursorPayload } from './public-directory-page.js';
import type { DigestControlDecision, ReportEditionPageAfter, ReportOwnerProfileFacts,
  ReportTransactionPorts, ReportUnitOfWork } from './contracts.js';
import type { DigestEdition, DigestSeries, ReportSourceFacts } from '../domain/types.js';
import { assertPageLimit, isEligiblePublicSource, isReportIndexable } from '../domain/index.js';
import {
  EMPTY_DIGEST_CONTROL,
  isEditionInPublicListing,
  isEditionPubliclyDirect,
  isSeriesInPublicDirectory,
  isSeriesPubliclyReadable,
  loadDigestEditionControls,
  loadDigestSeriesControls,
} from './digest-public-control.js';
import {
  createReportsCursorSigner,
  createReportsIssueCursorSigner,
  createReportsIssueCursorPayload,
} from './reports-cursor.js';
import {
  loadPublicProjectionData,
  MAX_PUBLIC_EDITION_SCAN,
  type PublicProjectionData,
} from './public-projection-loader.js';

/** Anonymous, deliberately closed report projection. */
export interface PublicReportIssue {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly publishedAt: string;
  /** Report URL only; source collection identifiers never cross this boundary. Null on tombstones. */
  readonly url: string | null;
  /** Series-scoped issue key (for example 2026-W36), copied from the Edition. */
  readonly issueKey: string;
  /** One-based ordinal of the Edition within its series. */
  readonly editionOrdinal: number;
  /** Reporting period bounds carried by the Edition, or null when unset. */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /**
   * Public slug of the source Collection, exposed so readers can open the live
   * entries. Only the slug of an already publicly visible Collection crosses
   * this boundary — never the internal Collection ID, owner, or revisions.
   */
  readonly sourceCollectionSlug: string | null;
  /** 'hidden' marks a hide_public moderation tombstone: position kept, content
      removed. Absent on every visible issue and on older servers' responses. */
  readonly state?: 'visible' | 'hidden';
}
export interface PublicReportSeries {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly slug: string;
  readonly visibility: 'public' | 'unlisted';
  readonly indexable: boolean;
  readonly updatedAt: string;
  /**
   * Public Profile summary of the series owner, resolved through the same
   * identity-owned discoverability projection that completes collection
   * owners. Absent when the owner Profile cannot be projected.
   */
  readonly curator?: ReportOwnerProfileFacts;
  /** Active follower count; absent when the Follow ledger read is not wired. */
  readonly followerCount?: number;
  /** Public slug of the newest visible issue's source Collection. */
  readonly sourceCollectionSlug?: string;
  readonly tags?: readonly string[];
  readonly language?: string | null;
  readonly issues: readonly PublicReportIssue[];
}
export interface PublicReportPage { readonly items: readonly PublicReportSeries[]; readonly nextCursor: string | null; }
export interface PublicReportIssuePage { readonly items: readonly PublicReportIssue[]; readonly nextCursor: string | null; }

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_DIRECTORY_SERIES = 2_000;
const MAX_ISSUES_IN_SERIES_DTO = 100;

type CursorConfig = {
  readonly active: { readonly id: string; readonly secret: string };
  readonly retained?: readonly { readonly id: string; readonly secret: string; readonly lastIssuedAt: string; readonly retainUntil: string }[];
};

function limitOf(value: number | undefined): number {
  return assertPageLimit(value ?? DEFAULT_LIMIT, MAX_LIMIT);
}

function assertCursorSize(cursor: string | undefined): void {
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH)) throw new Error('invalid_cursor');
}

function fenceDigest(requestedIds: readonly string[], sources: readonly ReportSourceFacts[]): string {
  const byId = new Map(sources.map((source) => [source.collectionId, source]));
  // Include missing source IDs as explicit tombstones. Otherwise getMany()
  // omitting a deleted row would leave an old cursor apparently valid.
  const normalized = [...new Set(requestedIds)].sort().map((id) => {
    const source = byId.get(id);
    return source === undefined ? { collectionId: id, missing: true } : {
      collectionId: source.collectionId,
      visibility: source.visibility,
      publishedAt: source.publishedAt,
      publicationSlug: source.publicationSlug,
      hasRoot: source.hasRoot,
      allowSearchIndexing: source.allowSearchIndexing,
      ownerAccountActive: source.ownerAccountActive,
      deleted: source.deleted,
      seedExcluded: source.seedExcluded,
      contentRevision: source.contentRevision,
      policyRevision: source.policyRevision,
      updatedAt: source.updatedAt,
      hiddenPublic: source.hiddenPublic === true,
    };
  });
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

function seriesFence(series: DigestSeries): Record<string, string | null> {
  return {
    id: series.id,
    slug: series.slug,
    state: series.state,
    visibility: series.visibility,
    ownerPublicationRestricted: String(series.ownerPublicationRestricted === true),
    allowSearchIndexing: String(series.allowSearchIndexing),
    resourceRevision: series.resourceRevision,
    contentRevision: series.contentRevision,
    policyRevision: series.policyRevision,
  };
}

function publicIssuePolicyFence(
  series: DigestSeries,
  seriesControl: DigestControlDecision,
  projectionRevision: string,
): string {
  return createHash('sha256').update(JSON.stringify({
    series: seriesFence(series),
    seriesControl,
    projectionRevision,
  }), 'utf8').digest('hex');
}

/** D3 source exposure predicate. Indexing opt-in is intentionally separate. */
export function isVisibleReportSource(source: ReportSourceFacts | null): source is ReportSourceFacts {
  return source !== null && isEligiblePublicSource(source);
}

export function isReportProjectionIndexable(series: DigestSeries, publishedSources: readonly ReportSourceFacts[]): boolean {
  return isReportIndexable({
    series: { visibility: series.visibility, allowSearchIndexing: series.allowSearchIndexing },
    publishedSources,
  });
}

function publicIssue(edition: DigestEdition, reportSlug: string, sourceSlug: string): PublicReportIssue {
  // The source slug is the public locator of an already-visible Collection,
  // copied so readers can navigate to the live entries. No source Collection
  // ID, owner, or revision is copied into the anonymous DTO.
  return {
    id: edition.id,
    title: edition.titleSnapshot,
    summary: edition.summarySnapshot,
    publishedAt: edition.publishedAt!,
    url: `https://know-n.com/reports/${encodeURIComponent(reportSlug)}/issues/${encodeURIComponent(edition.id)}`,
    issueKey: edition.issueKey,
    editionOrdinal: edition.editionOrdinal,
    periodStart: edition.periodStart,
    periodEnd: edition.periodEnd,
    sourceCollectionSlug: sourceSlug,
  };
}

/** Omission surfaces (MCP) strip hide_public tombstone rows; HTTP lists keep them (#21). */
export const visibleReportIssues = <T extends { readonly state?: string }>(items: readonly T[]): readonly T[] =>
  items.filter((issue) => issue.state !== 'hidden');

/** Inert placeholder for a hide_public Edition: identity and ordering facts
    stay (keyset continuity); body content is removed. */
function hiddenIssueTombstone(edition: DigestEdition): PublicReportIssue {
  return {
    id: edition.id,
    title: 'Issue hidden',
    summary: null,
    publishedAt: edition.publishedAt!,
    url: null,
    issueKey: edition.issueKey,
    editionOrdinal: edition.editionOrdinal,
    periodStart: edition.periodStart,
    periodEnd: edition.periodEnd,
    sourceCollectionSlug: null,
    state: 'hidden',
  };
}

function validUpdatedAt(
  series: DigestSeries,
  issues: readonly PublicReportIssue[],
  sources: readonly ReportSourceFacts[],
): string {
  const candidates = [series.updatedAt, ...issues.map((issue) => issue.publishedAt), ...sources.map((source) => source.updatedAt)]
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (candidates.length === 0) return new Date(0).toISOString();
  const latest = candidates.reduce((max, value) => Math.max(max, Date.parse(value)), 0);
  return new Date(latest).toISOString();
}

function projectFrom(
  series: DigestSeries,
  data: PublicProjectionData,
  issueLimit = MAX_ISSUES_IN_SERIES_DTO,
  listing: { readonly omitDelistedEditions?: boolean; readonly tombstoneHiddenEditions?: boolean } = {},
): PublicReportSeries | null {
  const omitDelistedEditions = listing.omitDelistedEditions ?? true;
  const tombstoneHiddenEditions = listing.tombstoneHiddenEditions ?? true;
  if (!isSeriesPubliclyReadable(series, data.seriesControl) || !series.slug) return null;
  const visibility = series.visibility;
  if (visibility !== 'public' && visibility !== 'unlisted') return null;
  const reportSlug = series.slug;
  const published = data.editions.filter((edition) => edition.state === 'published' && edition.publishedAt !== null);
  const byId = new Map(data.sources.map((source) => [source.collectionId, source]));
  const visibleSourceIds = new Set<string>();
  const allIssues = published.flatMap((edition) => {
    const source = byId.get(edition.sourceCollectionId) ?? null;
    const editionControl = data.editionControls.get(edition.id) ?? EMPTY_DIGEST_CONTROL;
    const allowed = omitDelistedEditions
      ? isEditionInPublicListing(series, edition, source, data.seriesControl, editionControl)
      : isEditionPubliclyDirect(series, edition, source, data.seriesControl, editionControl);
    const sourceSlug = source?.publicationSlug ?? null;
    if (!allowed || source === null || sourceSlug === null) {
      /* hide_public never silently shrinks a readable series: the Edition
         keeps its slot as an inert tombstone. Delist and source withdrawal
         still omit — the same rule as collection bookmark tombstones. */
      return tombstoneHiddenEditions && editionControl.hidePublic
        ? [{ issue: hiddenIssueTombstone(edition), editionOrdinal: edition.editionOrdinal }]
        : [];
    }
    visibleSourceIds.add(source.collectionId);
    return [{ issue: publicIssue(edition, reportSlug, sourceSlug), editionOrdinal: edition.editionOrdinal }];
  }).sort(compareProjectedIssues);
  const allProjectedIssues = allIssues.map((entry) => entry.issue);
  const issues = allProjectedIssues.slice(0, issueLimit);
  return {
    id: series.id,
    title: series.title,
    summary: series.summary,
    slug: series.slug,
    visibility,
    indexable: data.indexable,
    // The series revision covers Edition mutations; source freshness includes
    // every candidate scanned to fill this bounded DTO.
    updatedAt: validUpdatedAt(series, allProjectedIssues, data.sources.filter((source) => visibleSourceIds.has(source.collectionId))),
    ...(data.owner ? { curator: data.owner } : {}),
    ...(data.followerCount !== undefined ? { followerCount: data.followerCount } : {}),
    // Issues are sorted newest-first; the first VISIBLE issue names the live
    // source Collection (a leading tombstone exposes no slug).
    ...(allProjectedIssues.find((issue) => issue.state !== 'hidden')?.sourceCollectionSlug
      ? { sourceCollectionSlug: allProjectedIssues.find((issue) => issue.state !== 'hidden')!.sourceCollectionSlug! }
      : {}),
    ...(series.tags && series.tags.length > 0 ? { tags: [...series.tags] } : {}),
    ...(series.language !== undefined ? { language: series.language ?? null } : {}),
    issues,
  };
}

async function loadSeriesBySlug(ports: ReportTransactionPorts, slug: string): Promise<DigestSeries | null> {
  const rows = ports.series.list ? await ports.series.list(slug) : [];
  return rows.find((candidate) => candidate.slug === slug) ?? null;
}

async function loadProjected(ports: ReportTransactionPorts, series: DigestSeries): Promise<PublicReportSeries | null> {
  const data = await loadPublicProjectionData(ports, series);
  return projectFrom(series, data);
}

async function loadOwnerProfiles(
  ports: ReportTransactionPorts,
  ownerSubjectIds: readonly string[],
): Promise<ReadonlyMap<string, ReportOwnerProfileFacts> | undefined> {
  if (!ports.ownerProfiles || ownerSubjectIds.length === 0) return undefined;
  return ports.ownerProfiles.findManyByOwnerSubjectIds(ownerSubjectIds);
}

async function loadFollowerCounts(
  ports: ReportTransactionPorts,
  seriesIds: readonly string[],
): Promise<ReadonlyMap<string, number> | undefined> {
  if (ports.follows?.countActiveBySeriesIds) {
    return ports.follows.countActiveBySeriesIds(seriesIds);
  }
  if (!ports.follows?.countActive || seriesIds.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const seriesId of seriesIds) {
    counts.set(seriesId, await ports.follows.countActive(seriesId));
  }
  return counts;
}

export async function getPublicReportSeries(unit: ReportUnitOfWork, slug: string): Promise<PublicReportSeries | null> {
  return unit.execute(async (ports) => {
    const series = await loadSeriesBySlug(ports, slug);
    return series ? loadProjected(ports, series) : null;
  });
}

export async function getPublicReportIssue(unit: ReportUnitOfWork, slug: string, editionId: string): Promise<{ series: PublicReportSeries; issue: PublicReportIssue } | null> {
  return unit.execute(async (ports) => {
    const series = await loadSeriesBySlug(ports, slug);
    if (!series) return null;
    const edition = ports.editions.findById
      ? await ports.editions.findById(editionId)
      : (ports.editions.listBySeries
          ? await ports.editions.listBySeries(series.id, MAX_PUBLIC_EDITION_SCAN + 1) : [])
        .find((candidate) => candidate.id === editionId) ?? null;
    if (!edition || edition.seriesId !== series.id || edition.state !== 'published' || edition.publishedAt === null) return null;
    const [sources, seriesControls, editionControls, owners, followerCount, indexability] = await Promise.all([
      ports.source.getMany([edition.sourceCollectionId]),
      loadDigestSeriesControls(ports.digestControl, [series.id]),
      loadDigestEditionControls(ports.digestControl, [edition.id]),
      loadOwnerProfiles(ports, [series.ownerSubjectId]),
      ports.follows?.countActive ? ports.follows.countActive(series.id) : Promise.resolve(undefined),
      loadReportIndexability(ports, [series]),
    ]);
    const source = sources.find((candidate) => candidate.collectionId === edition.sourceCollectionId) ?? null;
    const seriesControl = seriesControls.get(series.id) ?? EMPTY_DIGEST_CONTROL;
    const editionControl = editionControls.get(edition.id) ?? EMPTY_DIGEST_CONTROL;
    if (!isEditionPubliclyDirect(series, edition, source, seriesControl, editionControl)) return null;
    const data: PublicProjectionData = { editions: [edition], sources, owner: owners?.get(series.ownerSubjectId) ?? null,
      followerCount, seriesControl, editionControls, indexable: indexability.get(series.id) === true };
    const projected = projectFrom(series, data, 1, { omitDelistedEditions: false });
    if (!projected) return null;
    const issue = projected.issues.find((candidate) => candidate.id === editionId);
    return issue ? { series: { ...projected, issues: [issue] }, issue } : null;
  });
}

function comparePublicSeries(left: PublicReportSeries, right: PublicReportSeries): number {
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return updated !== 0 ? updated : left.id.localeCompare(right.id);
}

function compareProjectedIssues(
  left: { readonly issue: PublicReportIssue; readonly editionOrdinal: number },
  right: { readonly issue: PublicReportIssue; readonly editionOrdinal: number },
): number {
  const published = Date.parse(right.issue.publishedAt) - Date.parse(left.issue.publishedAt);
  return published !== 0
    ? published
    : right.editionOrdinal - left.editionOrdinal || left.issue.id.localeCompare(right.issue.id);
}

export async function listPublicReportDirectory(
  unit: ReportUnitOfWork,
  config: CursorConfig,
  requestedLimit?: number,
  cursor?: string,
  language?: string | null,
): Promise<PublicReportPage> {
  let limit = limitOf(requestedLimit);
  assertCursorSize(cursor);
  return unit.execute(async (ports) => {
    const directoryPage = ports.series.listPublicDirectory
      ? await readPublicDirectoryPage(ports.series.listPublicDirectory, config, { limit, requestedLimit, cursor, language })
      : undefined;
    const rows = directoryPage?.rows ?? (ports.series.listAll ? await ports.series.listAll(MAX_DIRECTORY_SERIES + 1) : []);
    if (rows.length > MAX_DIRECTORY_SERIES) throw new Error('report_directory_limit_exceeded');
    const { editionRows, sources, seriesControls, editionControls } = await loadPublicDirectoryEditionData(
      ports, rows, MAX_ISSUES_IN_SERIES_DTO);
    const sourceIds = editionRows.flat().map((edition) => edition.sourceCollectionId);
    const ownerSubjectIds = [...new Set(rows.map((series) => series.ownerSubjectId))];
    const owners = await loadOwnerProfiles(ports, ownerSubjectIds);
    const followerCounts = await loadFollowerCounts(ports, rows.map((series) => series.id));
    const indexability = await loadReportIndexability(ports, rows);
    const projected = rows.map((series, index) => {
      const control = seriesControls.get(series.id) ?? EMPTY_DIGEST_CONTROL;
      if (!isSeriesInPublicDirectory(series, control)) return null;
      // The directory (like search/sitemap) keeps its omission contract;
      // issue tombstones belong to the readable series surfaces only.
      return projectFrom(series, {
        indexable: indexability.get(series.id) === true,
        editions: editionRows[index] ?? [],
        sources,
        owner: owners?.get(series.ownerSubjectId) ?? null,
        followerCount: followerCounts?.get(series.id),
        seriesControl: control,
        editionControls,
      }, MAX_ISSUES_IN_SERIES_DTO, { tombstoneHiddenEditions: false });
    })
      .filter((value): value is PublicReportSeries => value !== null && value.visibility === 'public')
      .filter((value) => language == null || value.language === language)
      .sort(comparePublicSeries);
    if (directoryPage) return { items: projected, nextCursor: directoryPage.nextCursor };
    const currentFence = createHash('sha256').update(JSON.stringify({
      series: rows.map(seriesFence),
      seriesControls: rows.map((series) => [series.id, seriesControls.get(series.id) ?? EMPTY_DIGEST_CONTROL]),
      editions: editionRows.flat().map((edition) => ({
        id: edition.id,
        state: edition.state,
        publishedAt: edition.publishedAt,
        resourceRevision: edition.resourceRevision,
        control: editionControls.get(edition.id) ?? EMPTY_DIGEST_CONTROL,
      })),
      sources: fenceDigest(sourceIds, sources),
      ...(language === undefined ? {} : { language }),
    }), 'utf8').digest('hex');
    const signer = createReportsCursorSigner(config);
    try {
      let start = 0;
      if (cursor) {
        const payload = signer.verify(cursor, new Date());
        if (payload.principalId !== 'public'
          || (requestedLimit !== undefined && payload.limit !== limit)
          || payload.policyRevision !== currentFence) throw new Error('invalid_cursor');
        limit = payload.limit;
        start = projected.findIndex((item) => comparePublicSeries(item, { id: payload.after.id, updatedAt: payload.after.updatedAt } as PublicReportSeries) > 0);
        if (start < 0) start = projected.length;
      }
      const page = projected.slice(start, start + limit);
      const last = page.at(-1);
      const nextCursor = start + limit < projected.length && last
        ? signer.sign(directoryCursorPayload('public', currentFence, limit, { id: last.id, updatedAt: last.updatedAt }))
        : null;
      return { items: page, nextCursor };
    } finally {
      signer.destroy();
    }
  });
}

/** Bounded issue-list projection for GET /api/v1/public-reports/{slug}/issues. */
export async function listPublicReportIssues(
  unit: ReportUnitOfWork,
  slug: string,
  config: CursorConfig,
  requestedLimit?: number,
  cursor?: string,
): Promise<PublicReportIssuePage | null> {
  let limit = limitOf(requestedLimit);
  assertCursorSize(cursor);
  return unit.execute(async (ports) => {
    const series = await loadSeriesBySlug(ports, slug);
    if (!series) return null;
    const seriesControl = (await loadDigestSeriesControls(ports.digestControl, [series.id])).get(series.id)
      ?? EMPTY_DIGEST_CONTROL;
    const projectionRevision = await ports.editions.publicProjectionRevision?.(series.id) ?? '';
    const policyRevision = publicIssuePolicyFence(series, seriesControl, projectionRevision);
    const signer = createReportsIssueCursorSigner(config);
    try {
      const principalId = `public:${slug}`;
      let after: ReportEditionPageAfter | undefined;
      if (cursor) {
        const payload = signer.verify(cursor, new Date());
        if (payload.principalId !== principalId
          || (requestedLimit !== undefined && payload.limit !== limit)
          || payload.policyRevision !== policyRevision) throw new Error('invalid_cursor');
        limit = payload.limit;
        after = payload.after;
      }
      const data = await loadPublicProjectionData(ports, series, { issueTarget: limit + 1, after, seriesControl });
      const projected = projectFrom(series, data, limit + 1);
      if (!projected) return null;
      const page = projected.issues.slice(0, limit);
      const last = page.at(-1);
      const lastEdition = last ? data.editions.find((edition) => edition.id === last.id) : undefined;
      const continuation = projected.issues.length > limit && lastEdition
        ? { id: lastEdition.id, publishedAt: lastEdition.publishedAt!, editionOrdinal: lastEdition.editionOrdinal }
        : data.hasMoreCandidates ? data.lastScanned : undefined;
      const nextCursor = continuation
        ? signer.sign(createReportsIssueCursorPayload({
          principalId,
          policyRevision,
          limit,
          after: continuation,
        }))
        : null;
      return { items: page, nextCursor };
    } finally {
      signer.destroy();
    }
  });
}
