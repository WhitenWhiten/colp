/**
 * Centralised feature flags controlling mock vs real API for each capability.
 *
 * - `false` -> use mock data (safe even when the backend is unavailable)
 * - `true`  -> use real API; if the API fails the page shows an error, not mock
 *
 * Flags are flipped to `true` only after the corresponding backend Phase
 * is verified and the page's data-fetching hook is wired to productClient.
 *
 * `VITE_EDITION=self-hosted` forces the cloud flags off after this table.
 * The literals stay so the copied boundary tests can still see them.
 */
import { featureFlagsForEdition } from '../lib/edition'

const FEATURE_FLAG_VALUES = {
  // Phase 1 - already wired, flags remain true
  auth: true,
  session: true,
  me: true,
  createCollection: true,
  collectionEditor: true,

  // Phase 2 - already wired
  publicCollection: true,

  // Phase 2B - accepted public Profile uses the generated Product API.
  search: true,
  profilePublic: true,
  // P2B-09 accepted after independent acceptance.
  annotations: true,
  // P2B-14 accepted after independent Relation workflow acceptance.
  relations: true,
  // P2B-20 accepted Reading Progress workflow uses the generated Product API.
  readingProgress: true,
  collectionList: true,
  resourceDetail: true,
  savedResources: true,

  // Live Product surfaces (these flags no longer gate the routes).
  sync: true,
  extension: true,
  import: true,
  // Classify inbox: Product HTTP wired; backend KNOWN_FEATURE_CLASSIFY still defaults off.
  classify: true,
  classification: false,
  classificationBatch: false,
  // OG-FE-02: Product organize-plan HTTP accepted; exposure is now live.
  // VITE_AI_ORGANIZE_ACCEPTANCE remains as an acceptance-only override.
  aiOrganize: true,
  // HV-FE-02: Product collection-version HTTP wired; exposure is now live.
  // VITE_COLLECTION_HISTORY_ACCEPTANCE remains as an acceptance-only override.
  collectionHistory: true,

  // Phase 5 capabilities: wired and accepted; exposure is now live.
  // P5-06/P5-07 follow, P5-14/P5-15 feed, P5-22/P5-23 notifications.
  follow: true,
  // CF-FE-02: Library Following section wired; exposure is now live.
  collectionFollow: true,
  explore: true,
  feed: true,
  notifications: true,
  // MCP write approvals are wired and available in production. Navigation is
  // still limited to signed-in accounts; direct links resume after sign-in.
  writeApprovals: true,
  // C4 two-factor: the 8 /two-factor/* endpoints are `status: 'pending'` in the
  // backend auth-route manifest and absent from BETTER_AUTH_ALLOWLIST, so every
  // call 404s after burning the `mfa` rate-limit budget. Stays off until the
  // backend registers the MFA surface.
  mfa: false,
  // Reader exposure stays off by default until the full workflow is ready.
  // The same gate owns its route, entry links, and readable-replica requests;
  // VITE_READABLE_REPLICA_ACCEPTANCE allows explicit acceptance testing.
  readableReplica: false,
  // LH-04 link health: Product GET+POST accepted; exposure is now live.
  // VITE_LINK_HEALTH_ACCEPTANCE remains as an acceptance-only override.
  linkHealth: true,
  // EXJ-FE owner JSON export jobs: Product GET/POST accepted; production flag is on.
  // VITE_EXPORT_JOBS_ACCEPTANCE remains as an acceptance-only override.
  exportJobs: true,
  // P5-30 optional email delivery channel: exposure is now live.
  // VITE_EMAIL_ACCEPTANCE remains as an acceptance-only override.
  email: true,
  collaborators: true,
  // Share already loads live snapshots; this flag does not gate /share.
  share: true,
  graph: false,
  creator: true,
  // ND-FE-01 News Digest reports: Product HTTP wired; exposure is live, while
  // the backend KNOWN_FEATURE_REPORTS* gates still default off — pages treat
  // 404 as "unavailable". VITE_REPORTS_ACCEPTANCE remains as an
  // acceptance-only override.
  reports: true,
  // FO-05 collection children time sorts: wired against listCollectionChildren;
  // a 404 (backend flag off) falls the page back to curated order.
  faviconPolicy: true,
  // LP-07 link preview requests (Library desk Gallery): Product POST wired; the
  // backend KNOWN_FEATURE_LINK_PREVIEW gate defaults off — a 404 stops further
  // requests for the session and Gallery simply shows text cards.
  linkPreview: true,
  // CS-01 community voting: Product HTTP wired; backend KNOWN_FEATURE_COMMUNITY
  // gates the routes — controls treat 404 as "unavailable" and hide themselves.
  // VITE_COMMUNITY_ACCEPTANCE remains as an acceptance-only override.
  community: true,
  contentGovernance: true,
} as const

export const FEATURE_FLAGS = featureFlagsForEdition(
  FEATURE_FLAG_VALUES,
  import.meta.env.VITE_EDITION,
)

export type FeatureFlag = keyof typeof FEATURE_FLAGS

/** Returns true when the backend capability is ready and the page should use real API. */
export function isLive(flag: FeatureFlag): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.[flag] !== undefined) {
    return window.__KNOWN_FLAGS__[flag] === true
  }
  return FEATURE_FLAGS[flag] === true
}

declare global {
  interface Window { __KNOWN_FLAGS__?: Partial<Record<FeatureFlag, boolean>> }
}

/** Follow exposure is live; VITE_FOLLOW_ACCEPTANCE remains as an acceptance-only override. */
export function isFollowExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.follow !== undefined) {
    return window.__KNOWN_FLAGS__.follow
  }
  try {
    return FEATURE_FLAGS.follow
      || String(import.meta.env?.VITE_FOLLOW_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Collection-follow exposure is live; VITE_COLLECTION_FOLLOW_ACCEPTANCE remains as an acceptance-only override. */
export function isCollectionFollowExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.collectionFollow !== undefined) {
    return window.__KNOWN_FLAGS__.collectionFollow
  }
  try {
    return FEATURE_FLAGS.collectionFollow
      || String(import.meta.env?.VITE_COLLECTION_FOLLOW_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Feed exposure is live; VITE_FEED_ACCEPTANCE remains as an acceptance-only override. */
export function isFeedExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.feed !== undefined) {
    return window.__KNOWN_FLAGS__.feed
  }
  try {
    return FEATURE_FLAGS.feed
      || String(import.meta.env?.VITE_FEED_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Notification exposure is live; VITE_NOTIFICATION_ACCEPTANCE remains as an acceptance-only override. */
export function isNotificationExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.notifications !== undefined) {
    return window.__KNOWN_FLAGS__.notifications
  }
  try {
    return FEATURE_FLAGS.notifications
      || String(import.meta.env?.VITE_NOTIFICATION_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** MCP write approval exposure is live; the Vite switch remains an acceptance override. */
export function isWriteApprovalsExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.writeApprovals !== undefined) {
    return window.__KNOWN_FLAGS__.writeApprovals
  }
  try {
    return FEATURE_FLAGS.writeApprovals
      || String(import.meta.env?.VITE_WRITE_APPROVALS_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** LH-04 link-health exposure is live; VITE_LINK_HEALTH_ACCEPTANCE remains as an acceptance-only override. */
export function isLinkHealthExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.linkHealth !== undefined) {
    return window.__KNOWN_FLAGS__.linkHealth
  }
  try {
    return FEATURE_FLAGS.linkHealth
      || String(import.meta.env?.VITE_LINK_HEALTH_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Classify inbox exposure is live; VITE_CLASSIFY_ACCEPTANCE remains as an acceptance-only override. */
export function isClassifyInboxExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.classify !== undefined) {
    return window.__KNOWN_FLAGS__.classify
  }
  try {
    return FEATURE_FLAGS.classify
      || String(import.meta.env?.VITE_CLASSIFY_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** OG-FE-02 AI organize exposure is live; VITE_AI_ORGANIZE_ACCEPTANCE remains as an acceptance-only override. */
export function isAiOrganizeExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.aiOrganize !== undefined) {
    return window.__KNOWN_FLAGS__.aiOrganize
  }
  try {
    return FEATURE_FLAGS.aiOrganize
      || String(import.meta.env?.VITE_AI_ORGANIZE_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** HV-FE-02 collection history exposure is live; VITE_COLLECTION_HISTORY_ACCEPTANCE is an acceptance-only override. */
export function isCollectionHistoryExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.collectionHistory !== undefined) {
    return window.__KNOWN_FLAGS__.collectionHistory
  }
  try {
    return FEATURE_FLAGS.collectionHistory
      || String(import.meta.env?.VITE_COLLECTION_HISTORY_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** EXJ-FE export-job exposure is live; VITE_EXPORT_JOBS_ACCEPTANCE remains as an acceptance-only override. */
export function isExportJobsExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.exportJobs !== undefined) {
    return window.__KNOWN_FLAGS__.exportJobs
  }
  try {
    return FEATURE_FLAGS.exportJobs
      || String(import.meta.env?.VITE_EXPORT_JOBS_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** P5-30 email channel exposure is live; VITE_EMAIL_ACCEPTANCE remains as an acceptance-only override. */
export function isEmailNotificationsExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.email !== undefined) {
    return window.__KNOWN_FLAGS__.email
  }
  try {
    return FEATURE_FLAGS.email
      || String(import.meta.env?.VITE_EMAIL_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Reader and readable-replica exposure default off; acceptance testing can explicitly opt in. */
export function isReadableReplicaExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.readableReplica !== undefined) {
    return window.__KNOWN_FLAGS__.readableReplica
  }
  try {
    return FEATURE_FLAGS.readableReplica
      || String(import.meta.env?.VITE_READABLE_REPLICA_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** ND-FE-01 News Digest reports exposure is live; VITE_REPORTS_ACCEPTANCE is an acceptance-only override. */
export function isReportsExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.reports !== undefined) {
    return window.__KNOWN_FLAGS__.reports
  }
  try {
    return FEATURE_FLAGS.reports
      || String(import.meta.env?.VITE_REPORTS_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** CS-01 community voting exposure is live; VITE_COMMUNITY_ACCEPTANCE is an acceptance-only override. */
export function isCommunityExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.community !== undefined) {
    return window.__KNOWN_FLAGS__.community
  }
  try {
    return FEATURE_FLAGS.community
      || String(import.meta.env?.VITE_COMMUNITY_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Select mock data until the corresponding live capability has been wired. */
export async function mockOrLive<T>(
  flag: FeatureFlag,
  live: () => Promise<T>,
  mock: T | (() => T),
): Promise<T> {
  if (FEATURE_FLAGS[flag]) {
    return live()
  }
  return typeof mock === 'function' ? (mock as () => T)() : mock
}

/** Semantic classification remains closed until its independent release gates pass. */
export function isClassificationExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.classification !== undefined) return window.__KNOWN_FLAGS__.classification
  return FEATURE_FLAGS.classification || String(import.meta.env?.VITE_CLASSIFICATION_ACCEPTANCE ?? '').toLowerCase() === 'true'
}

/** Batch rollout is independent from single-bookmark suggestions. */
export function isClassificationBatchExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.classificationBatch !== undefined) return window.__KNOWN_FLAGS__.classificationBatch
  return FEATURE_FLAGS.classificationBatch || String(import.meta.env?.VITE_CLASSIFICATION_BATCH_ACCEPTANCE ?? '').toLowerCase() === 'true'
}
