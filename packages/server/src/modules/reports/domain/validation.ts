import {
  REPORT_ISSUE_KEY_MAX_LENGTH,
  REPORT_RRULE_MAX_LENGTH,
  REPORT_SLUG_MAX_LENGTH,
  REPORT_SLUG_MIN_LENGTH,
  REPORT_SUMMARY_MAX_LENGTH,
  REPORT_TITLE_MAX_LENGTH,
  type ReportIndexabilityInput,
  type ReportSourceFacts,
  type ReportVisibility,
} from './types.js';
import { ReportsDomainError } from './errors.js';

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function invalid(message: string): never {
  throw new ReportsDomainError('invalid_input', message);
}

export function assertReportTitle(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > REPORT_TITLE_MAX_LENGTH) {
    return invalid(`title must be 1..${REPORT_TITLE_MAX_LENGTH} characters`);
  }
  if (value.trim().length === 0) return invalid('title cannot be whitespace-only');
  return value;
}

export function assertReportSummary(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > REPORT_SUMMARY_MAX_LENGTH) {
    return invalid(`summary must be null or at most ${REPORT_SUMMARY_MAX_LENGTH} characters`);
  }
  return value;
}

/** Uses the caller-supplied canonical Product slug predicate; no regex is copied here. */
export function assertReportSlug(value: string, isCanonical: (value: string) => boolean): string {
  if (typeof value !== 'string' || value.length < REPORT_SLUG_MIN_LENGTH || value.length > REPORT_SLUG_MAX_LENGTH
      || !isCanonical(value)) {
    return invalid(`slug must be canonical and ${REPORT_SLUG_MIN_LENGTH}..${REPORT_SLUG_MAX_LENGTH} characters`);
  }
  return value;
}

export function assertReportVisibility(value: string): ReportVisibility {
  if (value !== 'private' && value !== 'protected' && value !== 'unlisted' && value !== 'public') {
    return invalid('visibility must be private, protected, unlisted, or public');
  }
  return value;
}

export function assertIssueKey(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > REPORT_ISSUE_KEY_MAX_LENGTH
      || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalid(`issue key must be 1..${REPORT_ISSUE_KEY_MAX_LENGTH} characters and contain no control characters`);
  }
  return value;
}

export function assertRrule(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > REPORT_RRULE_MAX_LENGTH
      || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalid(`rrule must be 1..${REPORT_RRULE_MAX_LENGTH} characters and contain no control characters`);
  }
  return value;
}

export function normalizeReportInstant(value: string | null): string | null {
  if (value === null) return null;
  if (!RFC3339_WITH_OFFSET.test(value)) return invalid('instant must be RFC3339 with an explicit offset');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return invalid('instant must be a real RFC3339 instant');
  return new Date(parsed).toISOString();
}

export function assertPeriod(start: string | null, end: string | null): readonly [string | null, string | null] {
  const normalizedStart = normalizeReportInstant(start);
  const normalizedEnd = normalizeReportInstant(end);
  if (normalizedStart !== null && normalizedEnd !== null && Date.parse(normalizedEnd) <= Date.parse(normalizedStart)) {
    return invalid('period end must be after period start');
  }
  return [normalizedStart, normalizedEnd];
}

export function assertSourceRebind(originalSourceCollectionId: string, nextSourceCollectionId: string): void {
  if (originalSourceCollectionId !== nextSourceCollectionId) {
    throw new ReportsDomainError('source_rebind_forbidden', 'edition source collection cannot be changed');
  }
}

export function assertCanFollowSeries(actorSubjectId: string, ownerSubjectId: string): void {
  if (actorSubjectId === ownerSubjectId) throw new ReportsDomainError('self_follow_forbidden', 'series owner cannot follow their own series');
}

export function assertPageLimit(value: number, max = 100): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return invalid(`limit must be an integer in 1..${max}`);
  return value;
}

export function isEligiblePublicSource(source: ReportSourceFacts): boolean {
  return source.visibility === 'public' && source.publishedAt !== null && source.publicationSlug !== null
    && source.hasRoot && source.ownerAccountActive
    && !source.deleted && source.hiddenPublic !== true;
}

export function isReportIndexable(input: ReportIndexabilityInput): boolean {
  if (input.series.visibility !== 'public' || !input.series.allowSearchIndexing || input.publishedSources.length < 1) return false;
  return input.publishedSources.every((source) => isEligiblePublicSource(source)
    && source.allowSearchIndexing && !source.seedExcluded);
}
