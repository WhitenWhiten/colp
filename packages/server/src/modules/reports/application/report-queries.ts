import { createHash } from 'node:crypto';
import type { DigestEdition, DigestSeries } from '../domain/types.js';
import type { ReportActor, ReportIssueSourceFence, ReportUnitOfWork } from './contracts.js';
import {
  createReportsCursorSigner,
  createReportsIssueCursorSigner,
  createReportsIssueCursorPayload,
  type UnsignedReportsCursorPayload,
} from './reports-cursor.js';
import { assertPageLimit } from '../domain/index.js';
import { EMPTY_DIGEST_CONTROL } from './digest-public-control.js';

export interface ReportFollowState { readonly following: boolean; readonly followedAt: string | null; readonly followerCount?: number; }
export interface ReportSeriesPage { readonly items: readonly (DigestSeries & { readonly followedAt?: string; readonly hiddenPublic?: boolean })[]; readonly nextCursor: string | null; }
/**
 * Follower timeline view.  It is intentionally not a `DigestEdition` spread:
 * source collection IDs and internal revision fences are not needed by a
 * follower and must not become an accidental API contract.
 */
export interface ReportIssueTimelineItem {
  readonly id: string;
  readonly seriesId: string;
  readonly issueKey: string;
  readonly editionOrdinal: number;
  readonly titleSnapshot: string;
  readonly summarySnapshot: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** A hide_public series or edition keeps its keyset slot with `hidden`. */
  readonly state: 'published' | 'hidden';
  readonly publishedAt: string;
  readonly series: Pick<DigestSeries, 'id' | 'title' | 'summary' | 'slug' | 'visibility' | 'updatedAt'> & {
    /** Series-level hide_public in force: the embedded series is a tombstone. */
    readonly hiddenPublic?: boolean;
  };
}
export interface ReportIssueTimelinePage { readonly items: readonly ReportIssueTimelineItem[]; readonly nextCursor: string | null; }

const limitOf = (value: number | undefined): number => {
  return assertPageLimit(value ?? 50, 100);
};
const assertCursor = (cursor: string | undefined): void => {
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 2_048)) throw new Error('invalid_cursor');
};
const iso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const signerFor = (config: { active: { id: string; secret: string }; retained?: readonly { id: string; secret: string; lastIssuedAt: string; retainUntil: string }[] }) =>
  createReportsCursorSigner(config);
const issueSignerFor = (config: Parameters<typeof signerFor>[0]) => createReportsIssueCursorSigner(config);
const MAX_TIMELINE_ISSUES = 2_000;
const cursorPayload = (principalId: string, policyRevision: string, limit: number, after: { id: string; updatedAt: string }): UnsignedReportsCursorPayload => ({
  v: 1, purpose: 'reports-list-v1', principalId, policyRevision, limit,
  sort: 'updated_at:desc,id:asc', comparatorVersion: 'updated-desc-id-v1', after,
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
});

function compareTimelineIssues(
  left: Pick<DigestEdition, 'publishedAt' | 'editionOrdinal' | 'id'>,
  right: Pick<DigestEdition, 'publishedAt' | 'editionOrdinal' | 'id'>,
): number {
  const leftTime = left.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.publishedAt);
  const rightTime = right.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(right.publishedAt);
  return rightTime - leftTime
    || right.editionOrdinal - left.editionOrdinal
    || left.id.localeCompare(right.id);
}

/** Return true when `edition` is strictly after the issue cursor tuple. */
function isAfterTimelineCursor(
  edition: Pick<DigestEdition, 'publishedAt' | 'editionOrdinal' | 'id'>,
  after: { readonly publishedAt: string; readonly editionOrdinal: number; readonly id: string },
): boolean {
  return compareTimelineIssues(
    edition,
    { publishedAt: after.publishedAt, editionOrdinal: after.editionOrdinal, id: after.id },
  ) > 0;
}

type TimelineIssueRow = DigestEdition & {
  readonly series: DigestSeries & { readonly hiddenPublic?: boolean };
  /** Edition-level hide_public in force on this row. */
  readonly editionHiddenPublic?: boolean;
  readonly sourceFence?: ReportIssueSourceFence;
};

/**
 * Bind a timeline cursor to the complete bounded read snapshot, not merely
 * the last row.  This prevents source/series edits between pages from making
 * a previously issued cursor silently skip or repeat an issue.
 */
function timelineFence(rows: readonly TimelineIssueRow[]): string {
  const normalized = rows.map((row) => ({
    series: {
      id: row.series.id,
      slug: row.series.slug,
      visibility: row.series.visibility,
      state: row.series.state,
      allowSearchIndexing: row.series.allowSearchIndexing,
      /* A hide_public flip changes a row in place, so the moderation flag is
         part of the fence: stale cursors must not outlive the tombstone. */
      hiddenPublic: row.series.hiddenPublic === true,
      policyRevision: row.series.policyRevision,
      contentRevision: row.series.contentRevision,
      resourceRevision: row.series.resourceRevision,
    },
    edition: {
      id: row.id,
      seriesId: row.seriesId,
      state: row.state,
      publishedAt: row.publishedAt,
      editionOrdinal: row.editionOrdinal,
      hiddenPublic: row.editionHiddenPublic === true,
      resourceRevision: row.resourceRevision,
      sourceCollectionId: row.sourceCollectionId,
      sourceContentRevision: row.sourceContentRevision,
      sourcePolicyRevision: row.sourcePolicyRevision,
    },
    source: row.sourceFence ?? null,
  }));
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

export async function getReportFollowState(unit: ReportUnitOfWork, seriesId: string, actor: ReportActor): Promise<ReportFollowState | null> {
  return unit.execute(async (ports) => {
    const series = await ports.series.lockById(seriesId);
    if (!series || series.state === 'archived' || (series.visibility !== 'public' && series.visibility !== 'unlisted')) return null;
    // A hide_public'd digest is concealed from everyone on this surface, so
    // its existence and follower count cannot leak through the follow state
    // read (the followed feeds keep only an inert tombstone slot for it).
    const controls = ports.digestControl?.seriesControls
      ? await ports.digestControl.seriesControls([seriesId])
      : undefined;
    if ((controls?.get(seriesId) ?? EMPTY_DIGEST_CONTROL).hidePublic) return null;
    // Self-follow is rejected by assertCanFollowSeries, so the owner has no
    // follow state to read.  Conceal the surface (404) like the
    // profile/collection buttons that never render for their owner.
    if (series.ownerSubjectId === actor.subjectId) return null;
    const state = actor.profileId === undefined ? undefined : await ports.follows?.readState?.(series.id, actor.profileId);
    if (!state) return { following: false, followedAt: null };
    const followerCount = ports.follows?.countActive ? await ports.follows.countActive(series.id) : undefined;
    return { following: state.following, followedAt: state.followedAt?.toISOString() ?? null, ...(followerCount === undefined ? {} : { followerCount }) };
  });
}

export async function listOwnedReports(unit: ReportUnitOfWork, subjectId: string, config: Parameters<typeof signerFor>[0], limit?: number, cursor?: string): Promise<ReportSeriesPage> {
  return unit.execute(async (ports) => {
    assertCursor(cursor); if (cursor !== undefined && limit !== undefined) throw new Error('invalid_cursor'); const signer = signerFor(config); const principalId = `owner:${subjectId}`;
    try {
      let after: { id: string; updatedAt: string } | undefined;
      let pageLimit: number;
      if (cursor) {
        const p = signer.verify(cursor, new Date());
        if (p.principalId !== principalId) throw new Error('invalid_cursor');
        pageLimit = p.limit; after = p.after;
      } else pageLimit = limitOf(limit);
      const rows = ports.follows?.listOwned ? await ports.follows.listOwned(subjectId, pageLimit + 1, after && { seriesId: after.id, updatedAt: new Date(after.updatedAt) }) : (ports.series.listAll ? await ports.series.listAll(pageLimit + 1) : []).filter((s) => s.ownerSubjectId === subjectId).slice(0, pageLimit + 1);
      const items = rows.filter((s) => s.state === 'active').slice(0, pageLimit);
      const last = items.at(-1); const nextCursor = rows.length > pageLimit && last ? signer.sign(cursorPayload(principalId, 'owner', pageLimit, { id: last.id, updatedAt: last.updatedAt ?? new Date(0).toISOString() })) : null;
      return { items, nextCursor };
    } finally { signer.destroy(); }
  });
}

export async function listFollowedReports(unit: ReportUnitOfWork, profileId: string, config: Parameters<typeof signerFor>[0], limit?: number, cursor?: string): Promise<ReportSeriesPage> {
  return unit.execute(async (ports) => {
    assertCursor(cursor); if (cursor !== undefined && limit !== undefined) throw new Error('invalid_cursor'); const signer = signerFor(config); const principalId = `followed:${profileId}`;
    try {
      let after: { id: string; updatedAt: string } | undefined;
      let pageLimit: number;
      if (cursor) {
        const p = signer.verify(cursor, new Date());
        if (p.principalId !== principalId) throw new Error('invalid_cursor');
        pageLimit = p.limit; after = p.after;
      } else pageLimit = limitOf(limit);
      const rows = ports.follows?.listFollowed ? await ports.follows.listFollowed(profileId, pageLimit + 1, after && { seriesId: after.id, followedAt: new Date(after.updatedAt) }) : [];
      const items = rows.filter((s) => s.state === 'active' && (s.visibility === 'public' || s.visibility === 'unlisted')).slice(0, pageLimit).map((s) => {
        const followedAt = iso(s.followedAt) ?? new Date(0).toISOString();
        /* #21: a hide_public series keeps its slot as a tombstone — identity
           and the follow instant stay, the readable metadata does not. */
        if (s.hiddenPublic === true) {
          return { ...s, title: 'Digest hidden', summary: null, slug: null, hiddenPublic: true, followedAt };
        }
        return { ...s, followedAt };
      });
      const last = items.at(-1); const nextCursor = rows.length > pageLimit && last ? signer.sign(cursorPayload(principalId, 'followed', pageLimit, { id: last.id, updatedAt: last.followedAt ?? new Date(0).toISOString() })) : null;
      return { items, nextCursor };
    } finally { signer.destroy(); }
  });
}

export async function listFollowedReportIssues(unit: ReportUnitOfWork, profileId: string, config: Parameters<typeof signerFor>[0], limit?: number, cursor?: string): Promise<ReportIssueTimelinePage> {
  return unit.execute(async (ports) => {
    assertCursor(cursor); if (cursor !== undefined && limit !== undefined) throw new Error('invalid_cursor'); const signer = issueSignerFor(config); const principalId = `timeline:${profileId}`;
    try {
      let after: { id: string; publishedAt: string; editionOrdinal: number } | undefined;
      let verifiedCursor: ReturnType<typeof signer.verify> | undefined;
      let pageLimit: number;
      if (cursor) {
        const p = signer.verify(cursor, new Date());
        if (p.principalId !== principalId) throw new Error('invalid_cursor');
        pageLimit = p.limit; after = p.after; verifiedCursor = p;
      } else pageLimit = limitOf(limit);
      // Fetch the complete bounded snapshot so the cursor fence can detect
      // changes to rows before the current page as well as after it.  The
      // adapter still enforces the same 2,001-row hard cap.
      const rows = ports.follows?.listFollowedIssues
        ? await ports.follows.listFollowedIssues(profileId, MAX_TIMELINE_ISSUES + 1)
        : [];
      if (rows.length > MAX_TIMELINE_ISSUES) throw new Error('report_projection_limit_exceeded');
      // Keep the application comparator authoritative even if an adapter or
      // an older N-1 implementation returns rows in a different order.
      let visibleRows = (rows as readonly TimelineIssueRow[])
        .filter((e) => e.state === 'published' && (e.series.visibility === 'public' || e.series.visibility === 'unlisted') && e.publishedAt !== null)
        .sort(compareTimelineIssues);
      const fence = timelineFence(visibleRows);
      if (verifiedCursor?.policyRevision !== undefined && verifiedCursor.policyRevision !== fence) {
        throw new Error('invalid_cursor');
      }
      if (after) visibleRows = visibleRows.filter((edition) => isAfterTimelineCursor(edition, after!));
      const pageRows = visibleRows.slice(0, pageLimit);
      const items = pageRows.map((e): ReportIssueTimelineItem => {
        /* #21: a hide_public series or edition keeps its keyset slot as an
           inert tombstone — ordering facts survive, readable content does
           not. The series link is dropped only when the series itself hid. */
        const hidden = e.series.hiddenPublic === true || e.editionHiddenPublic === true;
        const seriesHidden = e.series.hiddenPublic === true;
        return {
          id: e.id,
          seriesId: e.seriesId,
          issueKey: e.issueKey,
          editionOrdinal: e.editionOrdinal,
          titleSnapshot: hidden ? 'Issue hidden' : e.titleSnapshot,
          summarySnapshot: hidden ? null : e.summarySnapshot,
          periodStart: iso(e.periodStart),
          periodEnd: iso(e.periodEnd),
          state: hidden ? 'hidden' : 'published',
          publishedAt: iso(e.publishedAt)!,
          series: {
            id: e.series.id,
            title: seriesHidden ? 'Digest hidden' : e.series.title,
            summary: seriesHidden ? null : e.series.summary,
            slug: seriesHidden ? null : e.series.slug,
            visibility: e.series.visibility,
            updatedAt: e.series.updatedAt ?? new Date(0).toISOString(),
            ...(seriesHidden ? { hiddenPublic: true } : {}),
          },
        };
      });
      const last = items.at(-1);
      const lastRaw = pageRows.at(-1);
      const nextCursor = visibleRows.length > pageLimit && last && lastRaw
        ? signer.sign(createReportsIssueCursorPayload({
          principalId,
          policyRevision: fence,
          limit: pageLimit,
          after: {
            id: last.id,
            publishedAt: last.publishedAt,
            editionOrdinal: last.editionOrdinal,
          },
        }))
        : null;
      return { items, nextCursor };
    } finally { signer.destroy(); }
  });
}

export const queryReportFollowState = getReportFollowState;
export const queryOwnedReports = listOwnedReports;
export const queryFollowedReports = listFollowedReports;
export const queryFollowedReportIssues = listFollowedReportIssues;
