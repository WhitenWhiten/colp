import type { CaptureFeedback, FeedbackKind } from './contracts.js';

export interface EffectiveFeedback {
  readonly revision: number;
  readonly eventId: string;
  readonly kind: FeedbackKind;
  readonly attitude: 1 | -1 | 0.1 | null;
}
const explicit = (kind: FeedbackKind) => ['explicit_positive', 'explicit_negative', 'correction_applied'].includes(kind);

/** The API assigns contiguous revisions under a decision lock; eventId replay is idempotent. */
export function projectFeedback(events: readonly CaptureFeedback[]): EffectiveFeedback | null {
  let current: EffectiveFeedback | null = null;
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.revision - b.revision)) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    if (current && event.revision <= current.revision) throw new Error('feedback_revision_conflict');
    if (current && explicit(current.kind) && !explicit(event.kind) && event.kind !== 'withdrawn') continue;
    if (current?.kind === 'implicit_positive' && ['dismissed_unrated', 'not_presented'].includes(event.kind)) continue;
    const attitude = event.kind === 'explicit_positive' ? 1
      : event.kind === 'explicit_negative' || event.kind === 'correction_applied' ? -1
        : event.kind === 'implicit_positive' ? 0.1 : null;
    current = { revision: event.revision, eventId: event.eventId, kind: event.kind, attitude };
  }
  return current;
}
