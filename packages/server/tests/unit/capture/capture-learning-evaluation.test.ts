import { expect, test } from 'vitest';
import { evaluateCapturePrior, type CaptureEvaluationPage } from '../../../src/modules/collections/application/capture-learning-evaluation.js';
test('temporal comparison isolates accounts and pages and reports abstention coverage', () => {
  const base: CaptureEvaluationPage = { owner: 'owner', collection: 'c', hostname: 'example.org', pageKey: 'test',
    at: '2026-02-01T00:00:00Z', taxonomyRevision: 't', expectedFolderId: 'b', legalFolders: ['a', 'b'], automaticEligible: true,
    folder: { folderId: 'a', decision: 'l1_root', confidence: 0.95, probabilities: [{ folderId: 'a', probability: 0.5 }, { folderId: 'b', probability: 0.5 }] } };
  const evidence = Array.from({ length: 5 }, (_, i) => ({ owner: 'owner', collection: 'c', hostname: 'example.org',
    pageKey: String(i), folderId: 'b', positive: 1, negative: 0, taxonomyRevision: 't', receivedAt: '2026-01-01T00:00:00Z' }));
  const pages = [base, base, { ...base, owner: 'other' }, { ...base, pageKey: 'later', automaticEligible: false }];
  const report = evaluateCapturePrior(pages, evidence, '2026-01-15T00:00:00Z');
  expect(report).toMatchObject({ pages: 3, automaticEligible: 2, baseErrors: 2, personalizedErrors: 1, tiesChanged: 1, correctedTies: 1, gateApproved: false });
  expect(evaluateCapturePrior([base], evidence.map(row => ({ ...row, pageKey: 'test' })), '2026-01-15T00:00:00Z').tiesChanged).toBe(0);
  expect(evaluateCapturePrior([base], evidence.map(row => ({ ...row, receivedAt: '2026-01-20T00:00:00Z' })), '2026-01-15T00:00:00Z').tiesChanged).toBe(0);
});
