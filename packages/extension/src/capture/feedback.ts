import type { CaptureScope, FeedbackKind } from './contracts.js';
export interface CaptureFeedbackEvent {
  readonly scope: CaptureScope;
  readonly eventId: string;
  readonly captureId: string;
  readonly decisionId: string;
  readonly nodeRevision: string;
  readonly kind: FeedbackKind;
  readonly occurredAt: number;
  readonly learningEligible: boolean;
  readonly uploaded: boolean;
  readonly evidenceGeneration?: number;
  readonly sequence?: number;
  readonly expectedServerRevision?: number;
  readonly error?: string;
  readonly resolved?: boolean;
}
export function effectiveLocalFeedback(current: FeedbackKind | undefined, next: FeedbackKind): FeedbackKind {
  if (current === 'implicit_positive' && ['dismissed_unrated', 'not_presented'].includes(next)) return current;
  if (['explicit_positive', 'explicit_negative', 'correction_applied'].includes(current ?? '')
    && ['implicit_positive', 'dismissed_unrated', 'not_presented'].includes(next)) return current!;
  return next;
}
