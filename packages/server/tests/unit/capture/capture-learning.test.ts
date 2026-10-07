import { describe, expect, test } from 'vitest';
import { chooseCapturePreference, resolveCapturePrimaryTie, eligibleCapturePrior, APPROVED_CAPTURE_PRIOR_EVALUATION,
  type CaptureMemoryEvidence } from '../../../src/modules/collections/application/capture-learning.js';
const legal = new Set(['a', 'b']);
const row = (page: string, folderId = 'b', positive = 1, negative = 0, taxonomyRevision = 'current'): CaptureMemoryEvidence =>
  ({ pageKey: page, folderId, positive, negative, taxonomyRevision, receivedAt: '2026-01-01T00:00:00Z' });
const five = Array.from({ length: 5 }, (_, i) => row(String(i)));
const base = { folderId: 'a', decision: 'l1_root', confidence: 0.95, probabilities: [{ folderId: 'a', probability: 0.5 }, { folderId: 'b', probability: 0.5 }] };
describe('explicit personal folder preference', () => {
  test('requires distinct pages and current effective choices', () => {
    expect(chooseCapturePreference(Array(10).fill(row('same')), 'current', legal)).toBeNull();
    expect(chooseCapturePreference(five.slice(1), 'current', legal)).toBeNull();
    expect(chooseCapturePreference(five, 'current', legal)).toEqual({ folderId: 'b', pages: 5 });
    expect(chooseCapturePreference([...five, ...five.map(r => ({ ...r, folderId: 'a', receivedAt: '2026-02-01T00:00:00Z' }))], 'current', legal)?.folderId).toBe('a');
  });
  test('requires 70 percent share and 20 percent margin; negatives veto', () => {
    expect(chooseCapturePreference([...five, row('x', 'a', 3)], 'current', legal)).toBeNull();
    expect(chooseCapturePreference([...five, row('x', 'b', 0, 5)], 'current', legal)).toBeNull();
    expect(chooseCapturePreference([...five, row('x', 'a', 2)], 'current', legal)?.folderId).toBe('b');
  });
  test('discounts old taxonomy and excludes unavailable folders', () => {
    expect(chooseCapturePreference([...five.map(r => ({ ...r, taxonomyRevision: 'old' })), row('x', 'a', 5)], 'current', legal)?.folderId).toBe('a');
    expect(chooseCapturePreference(five, 'current', new Set(['a']))).toBeNull();
  });
  test('changes the real primary choice only for exact top ties, retaining input confidence', () => {
    expect(resolveCapturePrimaryTie(base, five, 'current', legal)).toMatchObject({ folderId: 'b', explanation: { kind: 'exact_score_tie', pages: 5 } });
    expect(base.confidence).toBe(0.95);
    expect(resolveCapturePrimaryTie({ ...base, probabilities: [{ folderId: 'a', probability: 0.500001 }, { folderId: 'b', probability: 0.5 }] }, five, 'current', legal).folderId).toBe('a');
    expect(resolveCapturePrimaryTie({ ...base, decision: 'later' }, five, 'current', legal).folderId).toBe('a');
  });
  test('production quality gate has no fabricated approval', () => {
    expect(APPROVED_CAPTURE_PRIOR_EVALUATION).toBeNull(); expect(eligibleCapturePrior(null)).toBe(false);
  });
});
