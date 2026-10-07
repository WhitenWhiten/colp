import type { DigestControlDecision, DigestControlPort } from './contracts.js';
import type { DigestEdition, DigestSeries, ReportSourceFacts } from '../domain/types.js';
import { isEligiblePublicSource } from '../domain/validation.js';

export const EMPTY_DIGEST_CONTROL: DigestControlDecision = Object.freeze({
  hidePublic: false,
  delisted: false,
});

export async function loadDigestSeriesControls(
  port: DigestControlPort | undefined,
  seriesIds: readonly string[],
): Promise<ReadonlyMap<string, DigestControlDecision>> {
  if (port === undefined) return emptyControls(seriesIds);
  return port.seriesControls(seriesIds);
}

export async function loadDigestEditionControls(
  port: DigestControlPort | undefined,
  editionIds: readonly string[],
): Promise<ReadonlyMap<string, DigestControlDecision>> {
  if (port === undefined) return emptyControls(editionIds);
  return port.editionControls(editionIds);
}

export function isSeriesPubliclyReadable(
  series: DigestSeries,
  control: DigestControlDecision,
): boolean {
  return series.state === 'active'
    && series.slug !== null
    && (series.visibility === 'public' || series.visibility === 'unlisted')
    && series.ownerPublicationRestricted !== true
    && !control.hidePublic;
}

export function isSeriesInPublicDirectory(
  series: DigestSeries,
  control: DigestControlDecision,
): boolean {
  return isSeriesPubliclyReadable(series, control)
    && series.visibility === 'public'
    && !control.delisted;
}

export function isEditionPubliclyDirect(
  series: DigestSeries,
  edition: DigestEdition,
  source: ReportSourceFacts | null,
  seriesControl: DigestControlDecision,
  editionControl: DigestControlDecision,
): boolean {
  if (!isSeriesPubliclyReadable(series, seriesControl) || editionControl.hidePublic) return false;
  if (edition.state !== 'published' || edition.publishedAt === null) return false;
  if (source === null || !isEligiblePublicSource(source)) return false;
  return !(series.visibility === 'public' && !source.allowSearchIndexing);
}

export function isEditionInPublicListing(
  series: DigestSeries,
  edition: DigestEdition,
  source: ReportSourceFacts | null,
  seriesControl: DigestControlDecision,
  editionControl: DigestControlDecision,
): boolean {
  return isEditionPubliclyDirect(series, edition, source, seriesControl, editionControl)
    && !editionControl.delisted;
}

function emptyControls(ids: readonly string[]): ReadonlyMap<string, DigestControlDecision> {
  const out = new Map<string, DigestControlDecision>();
  for (const id of ids) out.set(id, EMPTY_DIGEST_CONTROL);
  return out;
}
