/**
 * The evidence surface is a development/e2e channel: it can read and rewrite
 * arbitrary sync state for one scope. `handleSyncStateEvidence` dispatches on
 * `message.method`, so the method NAME is the whole authorization surface —
 * an unlisted string used to reach the dispatcher unchecked.
 *
 * Keep this list in step with the `case` labels in `sw/evidence.ts`; a test
 * compares the two.
 */
export const SYNC_STATE_EVIDENCE_METHODS: readonly string[] = Object.freeze([
  'acquireEvidenceLease',
  'bookmarkImportStatus',
  'claimEvidenceQueue',
  'completeEvidenceQueue',
  'configureCaptureFaultEvidence',
  'configureDurableEngineEvidence',
  'configureEventEvidence',
  'configureOutboundBookmarkRoot',
  'configureOutboundBoundaryEvidence',
  'configureOutboundCanonicalFixture',
  'configureOutboundLeaseEvidence',
  'configureOutboundPushFaultEvidence',
  'configureProjectionApplyBarrierEvidence',
  'releaseProjectionApplyBarrierEvidence',
  'confirmBookmarkEventEvidence',
  'downloadEffectPagesEvidence',
  'drainBookmarkEventCaptureEvidence',
  'dropNativeMappingEvidence',
  'duplicateAlarm',
  'enqueueEvidence',
  'exportArchive',
  'exportAuthorityIdentity',
  'exportFaviconSidecarEvidence',
  'exportLegacyDiagnostic',
  'exportOutboundPushEvidence',
  'exportPullApplyEvidence',
  'exportScope',
  'projectionApplyBarrierStatus',
  'pullNowEvidence',
  'recoverBookmarkEventEvidence',
  'registerEvidenceScope',
  'resumePullApplyEvidence',
  'seedEvidence',
  'seedOutboundPushEvidence',
  'stagePullCreateCrashEvidence',
  'stagePullCreateEvidence',
  'syncEngineState',
  'wakeDurableEngineEvidence',
  'wakeOutboundPushEvidence',
]);

const METHOD_SET: ReadonlySet<string> = new Set(SYNC_STATE_EVIDENCE_METHODS);

/** Rejects an unlisted method name, so the dispatcher only sees known verbs. */
export function isSyncStateEvidenceMethod(method: string): boolean {
  return METHOD_SET.has(method);
}

/** Serialized argument budget: the channel is for test fixtures, not payloads. */
export const SYNC_STATE_EVIDENCE_MAX_ARGS = 8;
export const SYNC_STATE_EVIDENCE_MAX_ARG_BYTES = 64 * 1024;
