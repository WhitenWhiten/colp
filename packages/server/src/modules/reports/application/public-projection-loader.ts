import { loadReportIndexability } from './public-indexability.js';
import type { DigestEdition, DigestSeries, ReportSourceFacts } from '../domain/types.js';
import type {
  DigestControlDecision,
  ReportEditionPageAfter,
  ReportOwnerProfileFacts,
  ReportTransactionPorts,
} from './contracts.js';
import {
  EMPTY_DIGEST_CONTROL,
  isEditionInPublicListing,
  isSeriesPubliclyReadable,
  loadDigestEditionControls,
  loadDigestSeriesControls,
} from './digest-public-control.js';

const PUBLIC_EDITION_SCAN_BATCH = 200;
export const MAX_PUBLIC_EDITION_SCAN = 10_000;

export interface PublicProjectionData {
  readonly indexable: boolean;
  readonly editions: readonly DigestEdition[];
  readonly sources: readonly ReportSourceFacts[];
  readonly owner?: ReportOwnerProfileFacts | null;
  readonly followerCount?: number;
  readonly seriesControl: DigestControlDecision;
  readonly editionControls: ReadonlyMap<string, DigestControlDecision>;
  /** Last published candidate inspected, including omitted candidates. */
  readonly lastScanned?: ReportEditionPageAfter;
  readonly hasMoreCandidates?: boolean;
}

export async function loadPublicEditionData(
  ports: ReportTransactionPorts,
  series: DigestSeries,
  options: {
    readonly issueTarget?: number;
    readonly after?: ReportEditionPageAfter;
    readonly seriesControl?: DigestControlDecision;
    readonly tombstoneHiddenEditions?: boolean;
  } = {},
): Promise<Omit<PublicProjectionData, 'indexable' | 'owner' | 'followerCount'>> {
  const issueTarget = Math.max(1, Math.min(options.issueTarget ?? 100, 101));
  const seriesControl = options.seriesControl ?? (await loadDigestSeriesControls(
    ports.digestControl, [series.id])).get(series.id) ?? EMPTY_DIGEST_CONTROL;
  const editions: DigestEdition[] = [];
  const sourceById = new Map<string, ReportSourceFacts>();
  const editionControls = new Map<string, DigestControlDecision>();
  let lastScanned: ReportEditionPageAfter | undefined;
  let hasMoreCandidates = false;

  const ingest = async (page: readonly DigestEdition[]) => {
    editions.push(...page);
    const sourceIds = [...new Set(page.map((edition) => edition.sourceCollectionId))]
      .filter((id) => !sourceById.has(id));
    const [sources, controls] = await Promise.all([
      ports.source.getMany(sourceIds),
      loadDigestEditionControls(ports.digestControl, page.map((edition) => edition.id)),
    ]);
    for (const source of sources) sourceById.set(source.collectionId, source);
    for (const [id, control] of controls) editionControls.set(id, control);
  };
  const enoughVisibleIssues = () => editions.filter((edition) => {
    const source = sourceById.get(edition.sourceCollectionId) ?? null;
    const control = editionControls.get(edition.id) ?? EMPTY_DIGEST_CONTROL;
    return isEditionInPublicListing(series, edition, source, seriesControl, control)
      && source?.publicationSlug !== null || (options.tombstoneHiddenEditions !== false && control.hidePublic);
  }).length >= issueTarget;

  if (isSeriesPubliclyReadable(series, seriesControl) && series.slug !== null) {
    if (ports.editions.listPublishedBySeries) {
      let after = options.after;
      let scanned = 0;
      while (scanned < MAX_PUBLIC_EDITION_SCAN) {
        const pageLimit = Math.min(PUBLIC_EDITION_SCAN_BATCH, MAX_PUBLIC_EDITION_SCAN - scanned);
        const rows = await ports.editions.listPublishedBySeries(series.id, pageLimit + 1, after);
        const page = rows.slice(0, pageLimit);
        hasMoreCandidates = rows.length > pageLimit;
        if (page.length === 0) break;
        await ingest(page);
        scanned += page.length;
        const last = page.at(-1)!;
        lastScanned = { id: last.id, publishedAt: last.publishedAt!, editionOrdinal: last.editionOrdinal };
        if (enoughVisibleIssues() || !hasMoreCandidates) break;
        after = lastScanned;
      }
    } else {
      const rows = ports.editions.listBySeries
        ? await ports.editions.listBySeries(series.id, MAX_PUBLIC_EDITION_SCAN + 1)
        : [];
      const candidates = rows.filter((edition) => edition.state === 'published' && edition.publishedAt !== null)
        .sort(comparePublishedEditions)
        .filter((edition) => options.after === undefined || comparePublishedEditionToCursor(
          edition, options.after) > 0);
      const page = candidates.slice(0, MAX_PUBLIC_EDITION_SCAN);
      hasMoreCandidates = candidates.length > page.length;
      await ingest(page);
      const last = page.at(-1);
      if (last) lastScanned = { id: last.id, publishedAt: last.publishedAt!, editionOrdinal: last.editionOrdinal };
    }
  }
  return {
    editions, sources: [...sourceById.values()], seriesControl, editionControls,
    ...(lastScanned ? { lastScanned } : {}),
    ...(hasMoreCandidates ? { hasMoreCandidates: true } : {}),
  };
}

export async function loadPublicProjectionData(
  ports: ReportTransactionPorts,
  series: DigestSeries,
  options: Parameters<typeof loadPublicEditionData>[2] = {},
): Promise<PublicProjectionData> {
  const data = await loadPublicEditionData(ports, series, options);
  const [owners, followerCount, indexability] = await Promise.all([
    ports.ownerProfiles?.findManyByOwnerSubjectIds([series.ownerSubjectId]),
    ports.follows?.countActive ? ports.follows.countActive(series.id) : Promise.resolve(undefined),
    loadReportIndexability(ports, [series]),
  ]);
  return { ...data, indexable: indexability.get(series.id) === true,
    owner: owners?.get(series.ownerSubjectId) ?? null, followerCount };
}

function comparePublishedEditions(left: DigestEdition, right: DigestEdition): number {
  return comparePublishedEditionToCursor(left, {
    id: right.id, publishedAt: right.publishedAt!, editionOrdinal: right.editionOrdinal,
  });
}

function comparePublishedEditionToCursor(left: DigestEdition, right: ReportEditionPageAfter): number {
  const published = Date.parse(right.publishedAt) - Date.parse(left.publishedAt!);
  return published !== 0
    ? published
    : right.editionOrdinal - left.editionOrdinal || left.id.localeCompare(right.id);
}
