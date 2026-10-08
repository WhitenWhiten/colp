/** Shared, environment-independent §12.6 metric definitions. No model calls or database authority here. */
export interface CaptureStatisticFact {
  readonly captureId: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly disposition: 'new' | 'existing' | 'cancelled';
  readonly save: 'unsubmitted' | 'local-saved' | 'unknown' | 'failed';
  readonly automaticIntent: boolean;
  readonly originalApplied: boolean;
  readonly feedback: 'explicit_positive' | 'explicit_negative' | 'correction_applied' | 'implicit_positive' | 'dismissed_unrated' | 'not_presented' | 'withdrawn' | null;
  readonly sync: 'local-only' | 'pending' | 'syncing' | 'confirmed' | 'attention';
  readonly needsAttention: boolean;
  readonly saveDurationMs?: number | null;
  readonly classificationDurationMs?: number | null;
  readonly reason?: string | null;
}
export interface CaptureCounters {
  total: number; saved: number; failed: number; pending: number; unknown: number; existing: number; cancelled: number;
  automaticEligible: number; automaticApplied: number; positive: number; negative: number; implicit: number; unrated: number;
  syncConfirmed: number; syncPending: number; syncAttention: number; attention: number;
}
export interface CaptureStatistics {
  readonly definitionVersion: 'capture-metrics.v1'; readonly timezone: string; readonly updatedAt: number;
  readonly from: number; readonly to: number; readonly counts: CaptureCounters;
  readonly days: readonly { readonly date: string; readonly counts: CaptureCounters }[];
  readonly latency: { readonly save: CaptureLatency; readonly classification: CaptureLatency };
  readonly saveFailures: Readonly<Record<string, number>>;
  readonly classificationDeferrals: Readonly<Record<string, number>>;
}
export interface CaptureLatency { readonly samples: number; readonly p50: number | null; readonly p95: number | null }
export const emptyCaptureCounters = (): CaptureCounters => ({ total: 0, saved: 0, failed: 0, pending: 0, unknown: 0,
  existing: 0, cancelled: 0, automaticEligible: 0, automaticApplied: 0, positive: 0, negative: 0, implicit: 0, unrated: 0,
  syncConfirmed: 0, syncPending: 0, syncAttention: 0, attention: 0 });
export function captureDateFormatter(timezone: string): (timestamp: number) => string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return timestamp => { const parts = formatter.formatToParts(timestamp), get = (type: string) => parts.find(part => part.type === type)!.value;
    return `${get('year')}-${get('month')}-${get('day')}`; };
}
export function aggregateCaptures(facts: readonly CaptureStatisticFact[], input: { from: number; to: number; timezone: string; now: number }): CaptureStatistics {
  const dateKey = captureDateFormatter(input.timezone);
  const unique = new Map<string, CaptureStatisticFact>();
  for (const fact of facts) { const prior = unique.get(fact.captureId); if (!prior || fact.revision > prior.revision) unique.set(fact.captureId, fact); }
  const counts = emptyCaptureCounters(), days = new Map<string, CaptureCounters>(), saves: number[] = [], classifications: number[] = [];
  const failures = new Map<string, number>(), deferrals = new Map<string, number>();
  for (const fact of unique.values()) {
    if (fact.createdAt < input.from || fact.createdAt >= input.to) continue;
    const date = dateKey(fact.createdAt);
    const day = days.get(date) ?? emptyCaptureCounters(); days.set(date, day);
    countCapture(counts, fact); countCapture(day, fact);
    if (fact.disposition === 'new' && fact.save === 'failed') { const reason = fact.reason ?? 'save_failed'; failures.set(reason, (failures.get(reason) ?? 0) + 1); }
    if (fact.disposition === 'new' && fact.save === 'local-saved' && fact.automaticIntent && !fact.originalApplied) {
      const reason = fact.reason ?? 'waiting'; deferrals.set(reason, (deferrals.get(reason) ?? 0) + 1);
    }
    if (fact.disposition === 'new' && fact.save === 'local-saved') {
      if (typeof fact.saveDurationMs === 'number' && Number.isFinite(fact.saveDurationMs) && fact.saveDurationMs >= 0) saves.push(fact.saveDurationMs);
      if (fact.originalApplied && typeof fact.classificationDurationMs === 'number' && Number.isFinite(fact.classificationDurationMs) && fact.classificationDurationMs >= 0) classifications.push(fact.classificationDurationMs);
    }
  }
  return { definitionVersion: 'capture-metrics.v1', timezone: input.timezone, updatedAt: input.now,
    from: input.from, to: input.to, counts, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, counts })),
    latency: { save: latency(saves), classification: latency(classifications) }, saveFailures: Object.fromEntries(failures), classificationDeferrals: Object.fromEntries(deferrals) };
}
function latency(values: number[]): CaptureLatency {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50: values.length ? values[Math.ceil(values.length * 0.5) - 1]! : null,
    p95: values.length ? values[Math.ceil(values.length * 0.95) - 1]! : null };
}
function countCapture(counts: CaptureCounters, fact: CaptureStatisticFact) {
  if (fact.disposition !== 'new') { counts[fact.disposition]++; return; }
  counts.total++;
  if (fact.save === 'local-saved') counts.saved++;
  else if (fact.save === 'unknown') counts.unknown++;
  else if (fact.save === 'failed') counts.failed++;
  else counts.pending++;
  if (fact.save === 'local-saved' && fact.automaticIntent) {
    counts.automaticEligible++;
    if (fact.originalApplied) {
      counts.automaticApplied++;
      if (fact.feedback === 'explicit_positive') counts.positive++;
      else if (fact.feedback === 'explicit_negative' || fact.feedback === 'correction_applied') counts.negative++;
      else if (fact.feedback === 'implicit_positive') counts.implicit++;
      else counts.unrated++;
    }
  }
  if (fact.sync === 'confirmed') counts.syncConfirmed++;
  else if (fact.sync === 'attention') counts.syncAttention++;
  else if (fact.sync !== 'local-only') counts.syncPending++;
  if (fact.needsAttention) counts.attention++;
}

export const CAPTURE_ATTENTION_REASONS = ['authorization_required', 'sign_in_required', 'permission_required',
  'target_not_mapped', 'low_confidence', 'period_credit_limit', 'insufficient_credits', 'authorization_expired', 'resume_disabled', 'suggestion_requires_confirmation', 'execution_control_changed', 'feedback_conflict', 'feedback_needs_attention', 'existence_unavailable'] as const;
export const captureNeedsAttention = (save: CaptureStatisticFact['save'], sync: CaptureStatisticFact['sync'], reason: string | null): boolean =>
  save === 'failed' || save === 'unknown' || sync === 'attention' || (CAPTURE_ATTENTION_REASONS as readonly string[]).includes(reason ?? '');
