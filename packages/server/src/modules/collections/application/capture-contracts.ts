import type { ClassificationBillingConsent, ClassificationPreviewRuntime } from './classification-execution.js';

export const CAPTURE_POLICY_VERSION = 'capture-folder.v1';
export interface CaptureDecisionInput {
  readonly captureId: string;
  readonly nodeId: string;
  readonly nodeEtag: string;
  readonly policyVersion: string;
  readonly controlGeneration: number;
  readonly billing: ClassificationBillingConsent;
  readonly periodPoints: number;
  /** The saving browser's tag preference. Absent (older clients) keeps the calibrated automatic-tag behaviour. */
  readonly tagMode?: CaptureTagMode;
}
export type CaptureTagMode = 'off' | 'suggest' | 'add';
export interface CaptureDecision {
  readonly decisionId: string;
  readonly captureId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly status: 'waiting' | 'running' | 'suggested' | 'applied' | 'manual';
  readonly reason: string | null;
  readonly revision: number;
  readonly nodeEtag: string;
  readonly originalParentId: string;
  readonly parentId: string | null;
  readonly suggestedPath?: readonly string[];
  readonly suggestedParentId: string | null;
  readonly tags: readonly string[];
  /** Tags the classifier picked but left for the user to add (tagMode "suggest"). */
  readonly suggestedTags?: readonly string[];
  readonly creditChargeId?: string | null;
  readonly executionId: string | null;
  readonly createdAt: string;
  readonly appliedAt: string | null;
  readonly undoneAt: string | null;
  readonly feedbackRevision: number;
  readonly effectiveFeedback: import('./capture-feedback.js').CaptureFeedbackKind | null;
  readonly collectionTitle?: string;
  readonly path?: readonly string[];
  readonly automaticApplied?: boolean;
  readonly explanation?: { readonly policyVersion: string; readonly kind: 'exact_score_tie'; readonly pages: number };
}
export interface CaptureActor { readonly principalId: string; readonly subjectId: string }
export interface CaptureRuntime {
  capabilities(): { policyVersion: string; automaticFolderAvailable: boolean; automaticTagsAvailable: boolean };
  classify(actor: CaptureActor, collectionId: string, commandId: string, input: CaptureDecisionInput, requestId: string): Promise<CaptureDecision>;
  get(actor: CaptureActor, collectionId: string, decisionId: string): Promise<CaptureDecision | null>;
  find(actor: CaptureActor, collectionId: string, captureId: string): Promise<CaptureDecision | null>;
  apply(actor: CaptureActor, collectionId: string, decisionId: string, commandId: string, ifMatch: string, controlGeneration: number, userInitiated?: boolean): Promise<CaptureDecision>;
  undo(actor: CaptureActor, collectionId: string, decisionId: string, commandId: string, ifMatch: string): Promise<CaptureDecision>;
  correct(actor: CaptureActor, collectionId: string, decisionId: string, commandId: string, ifMatch: string,
    selection: { readonly parentId: string; readonly tags: readonly string[]; readonly learningEligible?: boolean; readonly evidenceGeneration?: number }): Promise<CaptureDecision>;
  feedback(actor: CaptureActor, collectionId: string, decisionId: string, expectedRevision: number,
    event: import('./capture-feedback.js').CaptureFeedbackInput): Promise<import('./capture-feedback.js').CaptureFeedbackReceipt>;
}
export type CapturePreview = Pick<ClassificationPreviewRuntime, 'preview'>;

export class CaptureError extends Error {
  constructor(readonly code: 'invalid_request' | 'resource_not_found' | 'precondition_failed' | 'command_id_reused' | 'capture_policy_unavailable') {
    super(code); this.name = 'CaptureError';
  }
}
export function parseCaptureDecisionInput(value: unknown): CaptureDecisionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaptureError('invalid_request');
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).length;
  if (keys !== (Object.hasOwn(raw, 'tagMode') ? 8 : 7) || Object.hasOwn(raw, 'tagMode') && !['off', 'suggest', 'add'].includes(raw.tagMode as string)
    || typeof raw.captureId !== 'string' || !/^[0-9a-f-]{36}$/u.test(raw.captureId)
    || typeof raw.nodeId !== 'string' || !raw.nodeId || raw.nodeId.length > 128
    || typeof raw.nodeEtag !== 'string' || !/^"[^"\r\n]+"$/u.test(raw.nodeEtag)
    || raw.policyVersion !== CAPTURE_POLICY_VERSION || !Number.isSafeInteger(raw.controlGeneration) || Number(raw.controlGeneration) < 0
    || !raw.billing || typeof raw.billing !== 'object' || Array.isArray(raw.billing)) throw new CaptureError('invalid_request');
  const billing = raw.billing as Record<string, unknown>;
  if (Object.keys(billing).length !== 2 || typeof billing.priceVersion !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(billing.priceVersion)
    || !Number.isSafeInteger(billing.maxPoints) || Number(billing.maxPoints) < 0 || Number(billing.maxPoints) > 2147483647) throw new CaptureError('invalid_request');
  if (!Number.isSafeInteger(raw.periodPoints) || Number(raw.periodPoints) < Number(billing.maxPoints)
    || Number(raw.periodPoints) > 2147483647) throw new CaptureError('invalid_request');
  return raw as unknown as CaptureDecisionInput;
}
