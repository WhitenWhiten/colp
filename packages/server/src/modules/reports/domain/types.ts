export const REPORT_VISIBILITIES = Object.freeze(['private', 'protected', 'unlisted', 'public'] as const);
export type ReportVisibility = (typeof REPORT_VISIBILITIES)[number];

export const DIGEST_SERIES_STATES = Object.freeze(['active', 'archived'] as const);
export type DigestSeriesState = (typeof DIGEST_SERIES_STATES)[number];

export const DIGEST_EDITION_STATES = Object.freeze(['draft', 'published', 'withdrawn', 'detached'] as const);
export type DigestEditionState = (typeof DIGEST_EDITION_STATES)[number];

export const DIGEST_MEMBER_ROLES = Object.freeze(['owner', 'editor', 'viewer'] as const);
export type DigestMemberRole = (typeof DIGEST_MEMBER_ROLES)[number];

export const DIGEST_RUN_STATES = Object.freeze([
  'pending', 'leased', 'succeeded', 'retryable', 'failed', 'cancelled',
] as const);
export type DigestRunState = (typeof DIGEST_RUN_STATES)[number];

export const REPORT_TITLE_MAX_LENGTH = 512;
export const REPORT_SUMMARY_MAX_LENGTH = 2_000;
export const REPORT_SLUG_MIN_LENGTH = 3;
export const REPORT_SLUG_MAX_LENGTH = 63;
export const REPORT_ISSUE_KEY_MAX_LENGTH = 128;
export const REPORT_RRULE_MAX_LENGTH = 1_024;
export const REPORT_PAGE_MAX_LIMIT = 100;
export const REPORT_CURSOR_TTL_MS = 15 * 60 * 1_000;
export const REPORT_CURSOR_MAX_PREVIOUS_KEYS = 8;
export const REPORT_MAX_TITLE_LENGTH = REPORT_TITLE_MAX_LENGTH;
export const REPORT_MAX_SUMMARY_LENGTH = REPORT_SUMMARY_MAX_LENGTH;
export const REPORT_MAX_SLUG_LENGTH = REPORT_SLUG_MAX_LENGTH;
export const REPORT_MAX_ISSUE_KEY_LENGTH = REPORT_ISSUE_KEY_MAX_LENGTH;

export interface DigestSeries {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly slug: string | null;
  readonly visibility: ReportVisibility;
  readonly allowSearchIndexing: boolean;
  readonly state: DigestSeriesState;
  /** Official account publication restriction on the series owner. */
  readonly ownerPublicationRestricted?: boolean;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly updatedAt?: string;
  readonly tags?: readonly string[];
  readonly language?: string | null;
}

export interface DigestEdition {
  readonly id: string;
  readonly seriesId: string;
  readonly sourceCollectionId: string;
  readonly issueKey: string;
  readonly editionOrdinal: number;
  readonly titleSnapshot: string;
  readonly summarySnapshot: string | null;
  readonly sourceContentRevision: string;
  readonly sourcePolicyRevision: string | null;
  readonly resourceRevision: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly state: DigestEditionState;
  readonly publishedAt: string | null;
}

export interface DigestMember {
  readonly seriesId: string;
  readonly subjectId: string;
  readonly role: DigestMemberRole;
  readonly revokedAt: string | null;
}

export interface DigestRun {
  readonly id: string;
  readonly scheduleId: string;
  /** NULL only for pre-fence ledger rows, which must be revalidated at claim. */
  readonly scheduleRevision: string | null;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly state: DigestRunState;
  readonly leaseOwner: string | null;
  readonly leaseUntil: string | null;
  readonly leaseGeneration: number;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly lastErrorClass: string | null;
  readonly issueKey: string | null;
  readonly commandId: string | null;
  readonly editionId: string | null;
}

export interface DigestSchedule {
  readonly id: string;
  readonly seriesId: string;
  readonly enabled: boolean;
  readonly rrule: string;
  readonly dtstart: string;
  readonly timeZone: string;
  readonly catchUpPolicy: 'skip' | 'one';
  readonly maxCatchUp: number;
  readonly nextRunAt: string | null;
  readonly resourceRevision: string;
}

export interface ReportSourceFacts {
  readonly collectionId: string;
  readonly visibility: ReportVisibility;
  readonly publishedAt: string | null;
  readonly publicationSlug: string | null;
  readonly hasRoot: boolean;
  readonly allowSearchIndexing: boolean;
  readonly ownerAccountActive: boolean;
  readonly deleted: boolean;
  readonly seedExcluded: boolean;
  readonly contentRevision: string;
  readonly policyRevision: string;
  /** Live source change instant used for representation/sitemap last-modified. */
  readonly updatedAt?: string;
  /** Official collection hide_public currently in force on this live source. */
  readonly hiddenPublic?: boolean;
}

export interface ReportIndexabilityInput {
  readonly series: Pick<DigestSeries, 'visibility' | 'allowSearchIndexing'>;
  readonly publishedSources: readonly ReportSourceFacts[];
}
