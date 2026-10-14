/** Product capture identity is independent of URL identity and COLP operation identity. */
export const CAPTURE_CONTRACT_VERSION = 1;
export const CAPTURE_RETENTION = { localDays: 90, serverDays: 180, aggregateDays: 365 } as const;
export type CaptureSource = 'action-popup' | 'manual-popup' | 'context-page' | 'context-link' | 'batch';
export interface CaptureScope {
  readonly serverOrigin: string;
  readonly accountId: string | null;
  readonly authorityGeneration: number;
  readonly collectionId: string | null;
}
export interface CaptureLocation {
  readonly collectionId: string | null;
  readonly collectionTitle: string | null;
  readonly nodeId: string | null;
  readonly nativeId: string | null;
  readonly path: readonly string[];
  readonly writable: boolean;
  readonly url: string;
}
export interface QueryCoverage {
  readonly local: 'complete' | 'unavailable';
  readonly cloud: 'complete' | 'partial' | 'unavailable' | 'not-checked';
  readonly collectionIds: readonly string[];
  readonly checkedAt: number;
  readonly stale: boolean;
}
export interface CaptureExistence {
  readonly kind: 'not-found' | 'local' | 'cloud-unmapped' | 'multiple' | 'unavailable';
  readonly exact: readonly CaptureLocation[];
  /** Suggestions never establish identity and never suppress an explicit save. */
  readonly similar: readonly CaptureLocation[];
  readonly coverage: QueryCoverage;
}
export type SaveState = 'unsubmitted' | 'local-saved' | 'unknown' | 'failed';
export type ClassificationState = 'none' | 'waiting' | 'running' | 'applied' | 'manual' | 'failed';
export type SyncState = 'local-only' | 'pending' | 'syncing' | 'confirmed' | 'attention';
export interface CaptureTask {
  readonly version: 1;
  readonly captureId: string;
  readonly commandId: string;
  readonly batchId: string | null;
  readonly scope: CaptureScope;
  readonly source: CaptureSource;
  readonly tabId: number | null;
  readonly url: string;
  readonly title: string;
  readonly favIconUrl?: string;
  readonly targetNativeId: string;
  readonly insertPosition: 'top' | 'bottom';
  readonly saveAnother: boolean;
  readonly allowUnverifiedCloud: boolean;
  readonly resumeNativeIds?: readonly string[];
  /** Tags and note from the save form. The worker keeps them in the annotation store once the bookmark exists. */
  readonly annotation?: import('../bookmark-annotation-store.js').BookmarkAnnotationInput;
  readonly annotationPersisted?: boolean;
  readonly createdAt: number;
  readonly savedAt?: number;
  readonly classificationAppliedAt?: number;
  readonly syncConfirmedAt?: number;
  readonly classificationNativeConfirmedAt?: number;
  readonly deviceId?: string;
  readonly reportedRevision?: number;
  readonly reportIntent?: { readonly revision: number; readonly commandId: string };
  readonly reportFailure?: { readonly revision: number; readonly code: string };
  readonly updatedAt: number;
  readonly revision: number;
  readonly policyVersion: string;
  readonly automaticIntent: boolean;
  readonly disposition: 'new' | 'existing' | 'cancelled';
  readonly save: SaveState;
  readonly classification: ClassificationState;
  readonly sync: SyncState;
  readonly existence: CaptureExistence | null;
  readonly nativeIntentId: string | null;
  readonly nativeId: string | null;
  readonly nodeId: string | null;
  readonly executionId: string | null;
  readonly decisionId: string | null;
  readonly localLocation: CaptureLocation | null;
  readonly cloudLocation: CaptureLocation | null;
  readonly appliedRevision: string | null;
  readonly manualFence: number;
  readonly controlGeneration: number;
  readonly reason: string | null;
  readonly automatic?: import('./automatic.js').AutomaticIntent;
  /** What the account's rules decided before the native create; absent when no rule matched. */
  readonly automation?: CaptureAutomation;
  /** Automatic classification through the user's own provider (local-first; no account, credits or server decision). */
  readonly local?: LocalAutomatic;
  readonly billingAuthorization?: import('./control.js').CaptureControl['consent'];
  readonly undo?: { readonly commandId: string; readonly ifMatch: string; readonly completed: boolean };
  readonly feedbackKind?: FeedbackKind;
  readonly feedbackServerRevision?: number;
  readonly remoteFeedback?: { readonly revision: number; readonly kind: FeedbackKind | null };
  readonly editIntent?: { readonly commandId: string; readonly parentNativeId: string; readonly originalParentNativeId: string;
    readonly tags: readonly string[]; readonly ifMatch: string | null; readonly completed: boolean;
    /** A local edit stays local on replay, even if sync has since resumed. */
    readonly execution?: 'native';
    readonly state?: 'pending' | 'outcome-unknown' | 'completed' | 'rejected' | 'cancelled'; readonly error?: string;
    readonly learningEligible?: boolean; readonly evidenceGeneration?: number };
}
export interface LocalAutomatic {
  /** Spent once before dispatch; a restart never repeats the provider call. */
  readonly commandId: string | null;
  readonly state: 'waiting' | 'running' | 'applied' | 'kept' | 'later' | 'unknown';
  readonly fromNativeId?: string;
  readonly folderNativeId?: string;
  readonly folderTitle?: string;
  /** Retained for the explicit retry offered when the model abstains. */
  readonly folderCandidateCount?: number;
  /** Tags the model selected under the Suggest tag mode: offered in the result panel, never written. */
  readonly suggestedTags?: readonly string[];
}
/**
 * A pre-save rule decision, pinned as evaluated. `placed`: the bookmark was
 * created in the rule's folder (`fromNativeId` is where it would have gone).
 * `kept`: the folder was the user's own choice, so the rule stood aside.
 * `blocked`/`conflict`/`review`: a rule matched but could not decide, and the
 * save kept its own folder. `expired`: a rule matched an out-of-date copy, which
 * never places. Only a placement is reported to the server.
 */
export interface CaptureAutomation {
  readonly outcome: 'placed' | 'kept' | 'blocked' | 'conflict' | 'review' | 'expired';
  readonly reason?: 'bindingUnavailable' | 'evaluation';
  /** The placing rule, or the first matching one. */
  readonly rule: { readonly id: string; readonly name: string; readonly revision: string; readonly bindingRevision: string;
    readonly semanticDigest: string };
  readonly ruleIds: readonly string[];
  readonly bundleRevision: string;
  readonly settingsRevision: number;
  readonly satisfies: readonly 'classify.root'[];
  readonly destination?: { readonly serverUuid: string; readonly collectionId: string; readonly nodeId: string };
  readonly folderTitle?: string;
  readonly fromNativeId: string;
  /** The Sync replica the decision was made under; its receipt belongs to it. */
  readonly collectionId: string;
  readonly replicaId: string;
  readonly generation: number;
}
export type FeedbackKind = 'explicit_positive' | 'explicit_negative' | 'correction_applied'
  | 'implicit_positive' | 'dismissed_unrated' | 'not_presented' | 'withdrawn';
export interface CaptureFeedback {
  readonly eventId: string;
  readonly captureId: string;
  readonly decisionId: string;
  readonly kind: FeedbackKind;
  /** Server CAS revision, never a device clock ordering. */
  readonly revision: number;
  readonly learningEligible: boolean;
  readonly evidenceGeneration: number;
}
export function sameCaptureScope(a: CaptureScope, b: CaptureScope): boolean {
  return a.serverOrigin === b.serverOrigin && a.accountId === b.accountId
    && a.authorityGeneration === b.authorityGeneration && a.collectionId === b.collectionId;
}
export function captureScopeKey(scope: CaptureScope): string {
  return JSON.stringify([scope.serverOrigin, scope.accountId, scope.authorityGeneration, scope.collectionId]);
}
export function captureOwnerKey(scope: CaptureScope): string { return JSON.stringify([scope.serverOrigin, scope.accountId]); }
