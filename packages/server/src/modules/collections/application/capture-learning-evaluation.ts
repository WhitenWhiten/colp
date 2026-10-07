import { resolveCapturePrimaryTie, type CaptureMemoryEvidence, CAPTURE_PRIOR_POLICY_VERSION } from './capture-learning.js';
export interface CaptureEvaluationPage {
  readonly owner: string; readonly collection: string; readonly hostname: string; readonly pageKey: string;
  readonly at: string; readonly taxonomyRevision: string; readonly expectedFolderId: string;
  readonly legalFolders: readonly string[]; readonly automaticEligible: boolean;
  readonly folder: Parameters<typeof resolveCapturePrimaryTie>[0];
}
export interface CaptureEvaluationEvidence extends CaptureMemoryEvidence {
  readonly owner: string; readonly collection: string; readonly hostname: string;
}
/** CPU-only offline comparison. The caller must supply a preregistered temporal cutoff and real labels. */
export function evaluateCapturePrior(pages: readonly CaptureEvaluationPage[], evidence: readonly CaptureEvaluationEvidence[], cutoff: string) {
  const split = Date.parse(cutoff); if (!Number.isFinite(split)) throw new Error('Invalid temporal split');
  const key = (row: { owner: string; collection: string; pageKey: string }) => JSON.stringify([row.owner, row.collection, row.pageKey]);
  const selected = new Map<string, CaptureEvaluationPage>();
  for (const page of [...pages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!Number.isFinite(Date.parse(page.at))) throw new Error('Invalid page timestamp');
    if (Date.parse(page.at) >= split && !selected.has(key(page))) selected.set(key(page), page);
  }
  // Exclude repeated pages on either side of the split; no label can leak back into training.
  const training = evidence.filter(row => {
    if (!Number.isFinite(Date.parse(row.receivedAt))) throw new Error('Invalid evidence timestamp');
    return Date.parse(row.receivedAt) < split && !selected.has(key(row));
  });
  let eligible = 0, baseErrors = 0, personalizedErrors = 0, tiesChanged = 0, correctedTies = 0, regressedTies = 0;
  for (const page of selected.values()) {
    if (!page.automaticEligible || page.folder.decision === 'later') continue;
    eligible++;
    const memory = training.filter(row => row.owner === page.owner && row.collection === page.collection && row.hostname === page.hostname
      && Date.parse(row.receivedAt) > Date.parse(page.at) - 180 * 86400000);
    const result = resolveCapturePrimaryTie(page.folder, memory, page.taxonomyRevision, new Set(page.legalFolders));
    const before = page.folder.folderId !== page.expectedFolderId, after = result.folderId !== page.expectedFolderId;
    baseErrors += Number(before); personalizedErrors += Number(after);
    if (result.explanation) { tiesChanged++; correctedTies += Number(before && !after); regressedTies += Number(!before && after); }
  }
  return { policyVersion: CAPTURE_PRIOR_POLICY_VERSION, cutoff, pages: selected.size, automaticEligible: eligible,
    coverage: selected.size ? eligible / selected.size : null, baseErrors, personalizedErrors,
    baseErrorRate: eligible ? baseErrors / eligible : null, personalizedErrorRate: eligible ? personalizedErrors / eligible : null,
    tiesChanged, correctedTies, regressedTies, gateApproved: false as const };
}
