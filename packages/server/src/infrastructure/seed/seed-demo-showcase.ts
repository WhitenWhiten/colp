import { seedCollectionId, seedNodeId } from './seed-opaque-id.js';

/**
 * Wave 14 / Wave 16 debug-period showcase locators and ID prefixes.
 * SQL in seed/demo/data.sql must stay in lockstep with these constants.
 */

export const SEED_SHOWCASE_ACCOUNT_U01 = 'acc-u01wWA7gVl069uG0Vg';
export const SEED_SHOWCASE_SUBJECT_U01 = 'sub-u01';
export const SEED_SHOWCASE_ACCOUNT_MIRA = 'acc-ce01SMsmU3SpSF5tLQ';
export const SEED_SHOWCASE_ACCOUNT_DEVON = 'acc-ce02L1MlSnC3ipQUPw';

export const SEED_SHOWCASE_FLAGSHIP_LEGACY = 'col-u01-01';
export const SEED_SHOWCASE_FLAGSHIP_NODE_001_LEGACY = 'nd-col-u01-01-001';

export const SEED_SHOWCASE_EXPORT_JOB_IDS = ['seed-exp-01', 'seed-exp-02', 'seed-exp-03'] as const;
export const SEED_SHOWCASE_ORGANIZE_PLAN_IDS = ['seed-org-01', 'seed-org-02'] as const;
export const SEED_SHOWCASE_TREE_VERSION_IDS = ['seed-ver-01', 'seed-ver-02', 'seed-ver-03'] as const;
export const SEED_SHOWCASE_RESTORE_RECEIPT_ID = 'seed-rst-01';
export const SEED_SHOWCASE_PUBLIC_ACTIVITY_IDS = [
  'seed-act-01', 'seed-act-02', 'seed-act-03',
  'seed-act-04', 'seed-act-05', 'seed-act-06',
] as const;
export const SEED_SHOWCASE_PUBLIC_ACTIVITY_EVENT_IDS = [
  'seed-evt-pa-01', 'seed-evt-pa-02', 'seed-evt-pa-03',
  'seed-evt-pa-04', 'seed-evt-pa-05', 'seed-evt-pa-06',
] as const;

export const SEED_SHOWCASE_CLASSIFY_SKIPPED_LEGACY = [
  'nd-col-u01-04-001',
  'nd-col-u01-04-002',
] as const;
export const SEED_SHOWCASE_CLASSIFY_ACCEPTED_LEGACY = 'nd-col-u01-04-003';
export const SEED_SHOWCASE_CLASSIFY_SUGGESTION_ID = 'seed-sug-01';

export const SEED_SHOWCASE_REPLICA_READY_LEGACY = [
  'nd-col-u01-01-001',
  'nd-col-u01-01-003',
] as const;
export const SEED_SHOWCASE_REPLICA_FAILED_LEGACY = [
  'nd-col-u01-01-005',
  'nd-col-u01-01-008',
] as const;

export const SEED_SHOWCASE_EXPECTED_ROWS = Object.freeze({
  collection_export_jobs: 3,
  collection_classify_inbox_decision: 3,
  collection_organize_plans: 2,
  collection_tree_versions: 3,
  collection_version_restore_receipts: 1,
  collection_readable_replicas: 4,
  social_public_activity: 6,
});

export const SEED_SHOWCASE_REPORT_FLAGSHIP_SERIES_ID = 'seed-rpt-series-ai-weekly';
export const SEED_SHOWCASE_REPORT_FLAGSHIP_SLUG = 'ai-weekly-field-notes';
export const SEED_SHOWCASE_REPORT_FLAGSHIP_LATEST_EDITION_ID = 'seed-rpt-edition-ai-2026-36';
export const SEED_SHOWCASE_REPORT_PUBLIC_SLUGS = [
  'ai-weekly-field-notes',
  'data-briefing',
  'ai-industry-weekly',
  'frontend-weekly',
  'climate-plain-digest',
  'design-field-notes',
] as const;
export const SEED_SHOWCASE_REPORT_EXPECTED_ROWS = Object.freeze({
  digest_series: 8,
  digest_editions: 33,
  digest_members: 16,
  digest_follows: 40,
  digest_schedules: 3,
  digest_runs: 6,
});

export const SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS = Object.freeze({
  community_votes: 96,
  community_vote_targets: 19,
  community_comments: 30,
  community_comment_curations: 1,
  community_comment_settings: 1,
  comment_reply_notifications: 9,
  catalog_preferences: 3,
  moderation_roles: 3,
  moderation_cases: 14,
  moderation_evidence: 14,
  moderation_actions: 10,
  moderation_appeals: 3,
});

export const SEED_SHOWCASE_HIDDEN_COLLECTION_SLUG = 'indie-toolbox';
export const SEED_SHOWCASE_DELISTED_COLLECTION_SLUG = 'sasha-brutalism';
export const SEED_SHOWCASE_CURATOR_LOCKED_SLUG = 'frontend-engineering';
export const SEED_SHOWCASE_OFFICIAL_LOCKED_SLUG = 'sre-runbook';
export const SEED_SHOWCASE_HIDDEN_SERIES_SLUG = 'climate-plain-digest';
export const SEED_SHOWCASE_MODERATOR_EMAIL = 'lin.yichen@example.com';
export const SEED_SHOWCASE_REVIEWER_ONLY_EMAIL = 'zhou.mengjie@example.com';
export const SEED_SHOWCASE_RESTRICTED_INTERACTION_EMAIL = 'noah.kim@example.com';

/** Quoted HTTP entity-tag stored on organize/history/replica seed rows. */
export function seedQuotedEtag(token: string): string {
  if (typeof token !== 'string' || token.length < 1 || token.length > 254) {
    throw new Error('seedQuotedEtag token must be 1..254 chars');
  }
  const etag = `"${token}"`;
  if (etag.length < 3 || etag.length > 256) {
    throw new Error('seedQuotedEtag produced an out-of-range etag');
  }
  return etag;
}

/** Must match social_public_activity.discoverability_recheck_key CHECK. */
export function seedPublicActivityRecheckKey(collectionId: string): string {
  if (typeof collectionId !== 'string' || collectionId.length < 1) {
    throw new Error('seedPublicActivityRecheckKey collectionId is required');
  }
  return `publication.collection:${collectionId}`;
}

export function seedDemoFlagshipCollectionId(): string {
  return seedCollectionId(SEED_SHOWCASE_FLAGSHIP_LEGACY);
}

export function seedDemoFlagshipNode001Id(): string {
  return seedNodeId(SEED_SHOWCASE_FLAGSHIP_NODE_001_LEGACY);
}

export function seedDemoLibraryEditorPath(): string {
  return `/library/${seedDemoFlagshipCollectionId()}/edit`;
}

export function seedDemoLibraryHistoryPath(): string {
  return `/library/${seedDemoFlagshipCollectionId()}/history`;
}

export function seedDemoLibraryCollaboratorsPath(): string {
  return `/library/${seedDemoFlagshipCollectionId()}/collaborators`;
}

export function seedDemoReaderPath(): string {
  const nodeId = seedDemoFlagshipNode001Id();
  const collectionId = seedDemoFlagshipCollectionId();
  return `/read/${nodeId}?collectionId=${collectionId}&subjectType=node&slug=llm-learning-path`;
}

export function seedDemoReportSeriesPath(): string {
  return `/reports/${SEED_SHOWCASE_REPORT_FLAGSHIP_SLUG}`;
}

export function seedDemoReportIssuePath(): string {
  return `/reports/${SEED_SHOWCASE_REPORT_FLAGSHIP_SLUG}/issues/${SEED_SHOWCASE_REPORT_FLAGSHIP_LATEST_EDITION_ID}`;
}

export function seedDemoHiddenCollectionPath(): string {
  return `/c/${SEED_SHOWCASE_HIDDEN_COLLECTION_SLUG}`;
}

export function seedDemoDelistedCollectionPath(): string {
  return `/c/${SEED_SHOWCASE_DELISTED_COLLECTION_SLUG}`;
}

export function seedDemoMyReportsPath(): string {
  return '/moderation/reports';
}

export function seedDemoOfficialCasesPath(): string {
  return '/admin/moderation/cases';
}
