import { CaptureError } from './capture-contracts.js';
export type CaptureFeedbackKind = 'explicit_positive' | 'explicit_negative' | 'correction_applied'
  | 'implicit_positive' | 'dismissed_unrated' | 'not_presented' | 'withdrawn';
export interface CaptureFeedbackInput {
  readonly eventId: string;
  readonly kind: Exclude<CaptureFeedbackKind, 'correction_applied'>;
  readonly nodeRevision: string;
  readonly occurredAt: string;
  readonly learningEligible: boolean;
  readonly evidenceGeneration: number;
}
export interface CaptureFeedbackReceipt {
  readonly eventId: string;
  readonly revision: number;
  readonly effectiveFeedback: CaptureFeedbackKind | null;
  readonly learningEligible: boolean;
}
export function feedbackAttitude(kind: CaptureFeedbackKind | null): 1 | -1 | 0.1 | null {
  return kind === 'explicit_positive' ? 1 : kind === 'explicit_negative' || kind === 'correction_applied' ? -1
    : kind === 'implicit_positive' ? 0.1 : null;
}
export function projectCaptureRating(current: CaptureFeedbackKind | null, next: CaptureFeedbackKind,
  expectedRevision: number, currentRevision: number): CaptureFeedbackKind | null {
  const old = feedbackAttitude(current), incoming = feedbackAttitude(next);
  if (next === 'withdrawn') { if (expectedRevision !== currentRevision) throw new CaptureError('precondition_failed'); return null; }
  if (incoming === null || (Math.abs(old ?? 0) === 1 && incoming === 0.1)) return current;
  if (old === incoming) return current;
  if (Math.abs(incoming) === Math.abs(old ?? 0) && expectedRevision !== currentRevision) throw new CaptureError('precondition_failed');
  return next;
}
export function parseCaptureFeedback(value: unknown): CaptureFeedbackInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaptureError('invalid_request');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 6 || typeof raw.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw.eventId)
    || !['explicit_positive', 'explicit_negative', 'implicit_positive', 'dismissed_unrated', 'not_presented', 'withdrawn'].includes(String(raw.kind))
    || typeof raw.nodeRevision !== 'string' || raw.nodeRevision.length > 256 || typeof raw.occurredAt !== 'string'
    || !Number.isFinite(Date.parse(raw.occurredAt)) || typeof raw.learningEligible !== 'boolean'
    || !Number.isSafeInteger(raw.evidenceGeneration) || Number(raw.evidenceGeneration) < 0) throw new CaptureError('invalid_request');
  return raw as unknown as CaptureFeedbackInput;
}
