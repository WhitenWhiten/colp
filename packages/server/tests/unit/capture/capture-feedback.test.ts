import { expect, test } from 'vitest';
import { feedbackAttitude, projectCaptureRating, parseCaptureFeedback } from '../../../src/modules/collections/index.js';
test('explicit signals dominate implicit ones; equal-priority conflicts require CAS', () => {
  expect(projectCaptureRating('implicit_positive', 'explicit_negative', 0, 3)).toBe('explicit_negative');
  expect(projectCaptureRating('explicit_positive', 'implicit_positive', 0, 4)).toBe('explicit_positive');
  expect(projectCaptureRating('implicit_positive', 'dismissed_unrated', 0, 4)).toBe('implicit_positive');
  expect(() => projectCaptureRating('explicit_positive', 'explicit_negative', 0, 4)).toThrow('precondition_failed');
  expect(projectCaptureRating('explicit_positive', 'withdrawn', 4, 4)).toBeNull();
  expect(feedbackAttitude('implicit_positive')).toBe(0.1);
  expect(feedbackAttitude('dismissed_unrated')).toBeNull();
});
test('clients cannot forge a successful correction or attach arbitrary learning metadata', () => {
  expect(() => parseCaptureFeedback({ eventId: crypto.randomUUID(), kind: 'correction_applied', nodeRevision: 'r',
    occurredAt: new Date().toISOString(), learningEligible: true, evidenceGeneration: 0 })).toThrow('invalid_request');
});
