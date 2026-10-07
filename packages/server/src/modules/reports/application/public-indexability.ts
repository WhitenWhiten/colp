import type { DigestSeries } from '../domain/types.js';
import { isReportIndexable } from '../domain/validation.js';
import type { ReportTransactionPorts, ReportEditionPageAfter } from './contracts.js';

const BATCH_SIZE = 200;
const FALLBACK_SCAN_LIMIT = 10_000;

/** Indexing policy is series-wide, even when the response contains one issue. */
export async function loadReportIndexability(
  ports: ReportTransactionPorts,
  series: readonly DigestSeries[],
): Promise<ReadonlyMap<string, boolean>> {
  const eligible = series.filter((item) => item.visibility === 'public' && item.allowSearchIndexing);
  if (ports.source.publishedSourcesIndexableBySeriesIds) {
    return ports.source.publishedSourcesIndexableBySeriesIds(eligible.map((item) => item.id));
  }
  // Alternate adapters without the aggregate may prove eligibility through a
  // complete bounded read. An incomplete scan must never grant indexing.
  const batch = ports.editions.listBySeriesIds
    ? await ports.editions.listBySeriesIds(eligible.map((item) => item.id), FALLBACK_SCAN_LIMIT + 1)
    : undefined;
  const result = new Map<string, boolean>();
  for (const item of eligible) {
    let after: ReportEditionPageAfter | undefined;
    let scanned = 0;
    let hasPublished = false;
    let indexable = false;
    do {
      const paged = ports.editions.listPublishedBySeries !== undefined;
      const rows = paged
        ? await ports.editions.listPublishedBySeries!(item.id, BATCH_SIZE + 1, after)
        : batch?.get(item.id) ?? await ports.editions.listBySeries?.(item.id, FALLBACK_SCAN_LIMIT + 1) ?? [];
      const page = paged ? rows.slice(0, BATCH_SIZE) : rows;
      if (scanned + page.length > FALLBACK_SCAN_LIMIT) break;
      const published = page.filter((edition) => edition.state === 'published' && edition.publishedAt !== null);
      hasPublished ||= published.length > 0;
      let allowed = true;
      const ids = [...new Set(published.map((edition) => edition.sourceCollectionId))];
      for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
        const requested = ids.slice(offset, offset + BATCH_SIZE);
        const sources = await ports.source.getMany(requested);
        const found = new Set(sources.map((source) => source.collectionId));
        if (!requested.every((id) => found.has(id)) || !isReportIndexable({ series: item, publishedSources: sources })) {
          allowed = false; break;
        }
      }
      if (!allowed) break;
      scanned += page.length;
      if (!paged || rows.length <= BATCH_SIZE) { indexable = hasPublished; break; }
      const last = page.at(-1)!;
      after = { id: last.id, publishedAt: last.publishedAt!, editionOrdinal: last.editionOrdinal };
    } while (scanned < FALLBACK_SCAN_LIMIT);
    result.set(item.id, indexable);
  }
  return result;
}
