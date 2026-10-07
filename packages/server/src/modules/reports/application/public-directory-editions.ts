import type { DigestEdition, DigestSeries } from '../domain/types.js';
import type { ReportTransactionPorts } from './contracts.js';
import {
  EMPTY_DIGEST_CONTROL, isEditionInPublicListing, isSeriesInPublicDirectory,
  loadDigestEditionControls, loadDigestSeriesControls,
} from './digest-public-control.js';
import { loadPublicEditionData, MAX_PUBLIC_EDITION_SCAN } from './public-projection-loader.js';

const MAX_DIRECTORY_SOURCES = 10_000;
const MAX_DIRECTORY_EDITIONS = 100_000;

/** Batch the common case; continue only series whose first page was filtered. */
export async function loadPublicDirectoryEditionData(
  ports: ReportTransactionPorts,
  series: readonly DigestSeries[],
  issueLimit: number,
) {
  const ids = series.map(row => row.id);
  const batch = ports.editions.listPublishedBySeriesIds
    ? await ports.editions.listPublishedBySeriesIds(ids, issueLimit)
    : ports.editions.listBySeriesIds
      ? await ports.editions.listBySeriesIds(ids, MAX_PUBLIC_EDITION_SCAN + 1) : undefined;
  const editionRows: DigestEdition[][] = [];
  let total = 0;
  for (const row of series) {
    const candidates = batch ? batch.get(row.id) ?? []
      : ports.editions.listPublishedBySeries ? await ports.editions.listPublishedBySeries(row.id, issueLimit)
        : await ports.editions.listBySeries?.(row.id, MAX_PUBLIC_EDITION_SCAN + 1) ?? [];
    const published = candidates.filter(edition => edition.state === 'published' && edition.publishedAt !== null)
      .sort((left, right) => Date.parse(right.publishedAt!) - Date.parse(left.publishedAt!)
        || right.editionOrdinal - left.editionOrdinal || left.id.localeCompare(right.id));
    editionRows.push(published);
    total += published.length;
    if (total > MAX_DIRECTORY_EDITIONS) throw new Error('report_projection_limit_exceeded');
  }
  const inspectedSourceIds = new Set(editionRows.flat().map(edition => edition.sourceCollectionId));
  const sourceIds = [...inspectedSourceIds];
  if (sourceIds.length > MAX_DIRECTORY_SOURCES) throw new Error('report_projection_limit_exceeded');
  const [sources, seriesControls, initialControls] = await Promise.all([
    ports.source.getMany(sourceIds), loadDigestSeriesControls(ports.digestControl, ids),
    loadDigestEditionControls(ports.digestControl, editionRows.flat().map(edition => edition.id)),
  ]);
  const sourceById = new Map(sources.map(source => [source.collectionId, source]));
  const editionControls = new Map(initialControls);
  for (const [index, row] of series.entries()) {
    const control = seriesControls.get(row.id) ?? EMPTY_DIGEST_CONTROL;
    const candidates = editionRows[index]!;
    if (!isSeriesInPublicDirectory(row, control) || candidates.length < issueLimit) continue;
    const visible = candidates.filter(edition => {
      const source = sourceById.get(edition.sourceCollectionId) ?? null;
      return source?.publicationSlug != null && isEditionInPublicListing(row, edition, source, control,
        editionControls.get(edition.id) ?? EMPTY_DIGEST_CONTROL);
    });
    if (visible.length >= issueLimit || !(ports.editions.listPublishedBySeries || ports.editions.listBySeries)) continue;
    const last = candidates.at(-1)!;
    const tail = await loadPublicEditionData(ports, row, {
      issueTarget: issueLimit - visible.length, seriesControl: control, tombstoneHiddenEditions: false,
      after: { id: last.id, publishedAt: last.publishedAt!, editionOrdinal: last.editionOrdinal },
    });
    total += tail.editions.length;
    if (total > MAX_DIRECTORY_EDITIONS) throw new Error('report_projection_limit_exceeded');
    candidates.push(...tail.editions);
    for (const edition of tail.editions) inspectedSourceIds.add(edition.sourceCollectionId);
    if (inspectedSourceIds.size > MAX_DIRECTORY_SOURCES) throw new Error('report_projection_limit_exceeded');
    for (const source of tail.sources) sourceById.set(source.collectionId, source);
    for (const [id, decision] of tail.editionControls) editionControls.set(id, decision);
  }
  return { editionRows, sources: [...sourceById.values()], seriesControls, editionControls };
}
