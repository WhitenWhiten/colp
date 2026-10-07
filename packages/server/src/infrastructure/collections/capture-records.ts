import type { CaptureDecisionInput } from '../../modules/collections/index.js';
import type { ClassificationContentResult } from '../../modules/collections/index.js';

export interface CaptureDecisionTable {
  id: string;
  account_id: string;
  owner_subject_id: string;
  capture_id: string;
  collection_id: string;
  node_id: string;
  command_id: string;
  fingerprint: string;
  input_json: CaptureDecisionInput;
  original_parent_id: string;
  original_url: string | null;
  original_hostname: string | null;
  original_tags: readonly string[];
  execution_command_id: string;
  execution_id: string | null;
  apply_command_id: string | null;
  status: 'waiting' | 'running' | 'suggested' | 'applied' | 'manual';
  reason: string | null;
  revision: number;
  suggestion_json: { path?: readonly string[]; appliedExplicitly?: boolean; evidenceGeneration?: number; folderId: string; addTags: readonly string[]; suggestedTags?: readonly string[]; explanation?: { policyVersion: string; kind: 'exact_score_tie'; pages: number } } | null;
  result_json: (ClassificationContentResult & { collectionTitle?: string; path?: readonly string[] }) | null;
  created_at: Date;
  applied_at: Date | null;
  undo_command_id: string | null;
  undo_result_json: (ClassificationContentResult & { collectionTitle?: string; path?: readonly string[] }) | null;
  undone_at: Date | null;
  current_result_json: (ClassificationContentResult & { collectionTitle?: string; path?: readonly string[] }) | null;
  feedback_revision: number;
  effective_feedback: import('../../modules/collections/index.js').CaptureFeedbackKind | null;
  effective_event_id: string | null;
}
export interface CaptureFeedbackTable {
  account_id: string; event_id: string; decision_id: string; capture_id: string; node_revision: string;
  kind: import('../../modules/collections/index.js').CaptureFeedbackKind; revision: number; fingerprint: string;
  occurred_at: Date; received_at: Date; learning_eligible: boolean; evidence_generation: number;
  correction_json: { beforeParentId: string; afterParentId: string; beforeTags: readonly string[]; afterTags: readonly string[] } | null;
  receipt_json: import('../../modules/collections/index.js').CaptureFeedbackReceipt;
}
export interface CaptureLearningTable { account_id: string; generation: number; cleared_at: Date | null }
export interface CaptureTaskTable {
  account_id: string; capture_id: string; collection_id: string; device_id: string; revision: number;
  started_at: Date; received_at: Date;
  // Mutable progress only: captureId/deviceId/collectionId/revision/startedAt
  // live in the columns above, never in the document.
  report_json: import('../../modules/collections/index.js').CaptureTaskProgress;
}
export interface CaptureEditTable {
  account_id: string;
  command_id: string;
  decision_id: string;
  fingerprint: string;
  result_json: import('../../modules/collections/index.js').CaptureDecision;
  created_at: Date;
}
