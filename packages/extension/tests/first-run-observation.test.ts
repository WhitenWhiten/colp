import { expect, test } from 'vitest';
import { observeFirstRunResponse } from '../src/first-run-observation.js';
import { projectFirstRunSurface } from '../src/first-run-draft.js';

test('a new status clears the prior attention report rather than mixing phases from different snapshots', () => {
  const prior = { firstRun: 'none' as const, phase: 'needs_attention' as const,
    attention: { reportId: 'old', pendingCount: 1, candidateCount: 1, conflictCount: 0 } };
  const next = observeFirstRunResponse({ ok: true, firstRun: 'running', phase: 'syncing' }, prior);
  expect(next.attention).toBeUndefined(); expect(projectFirstRunSurface(next)).toBe('syncing');
});
test('a failed read retains the last valid phase and a completed snapshot closes onboarding', () => {
  const prior = { firstRun: 'running' as const, phase: 'syncing' as const };
  expect(observeFirstRunResponse({ ok: false, error: 'offline' }, prior)).toBe(prior);
  const complete = observeFirstRunResponse({ ok: true, firstRun: 'completed', phase: 'completed' }, prior);
  expect(complete.firstRun).toBe('completed'); expect(projectFirstRunSurface(complete)).toBe('hide');
});
