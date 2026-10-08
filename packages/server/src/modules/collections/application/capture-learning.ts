import { CLASSIFICATION_POLICY } from './classification-policy.js';

export const CAPTURE_PRIOR_POLICY_VERSION = 'capture-explicit-tie.v1';
export interface CaptureMemoryEvidence {
  readonly pageKey: string; readonly folderId: string; readonly positive: number; readonly negative: number;
  readonly taxonomyRevision: string; readonly receivedAt: string;
}
export interface CapturePriorEvaluation {
  readonly policyVersion: typeof CAPTURE_PRIOR_POLICY_VERSION; readonly provenance: 'explicit_user_commands';
  readonly holdoutHash: string; readonly pages: number; readonly baseErrors: number; readonly personalizedErrors: number;
  readonly ties: number; readonly correctedTies: number;
  readonly registrationHash: string; readonly providerId: string; readonly modelVersion: string;
  readonly promptVersion: string; readonly candidateVersion: string; readonly pairedPValue: number;
  readonly laterToFolderIncreasePp: number; readonly collectionIsolationVerified: true;
}
export const APPROVED_CAPTURE_PRIOR_EVALUATION: CapturePriorEvaluation | null = null;
export function eligibleCapturePrior(
  value: CapturePriorEvaluation | null,
  identity?: { readonly providerId: string; readonly modelVersion: string }
): boolean {
  return Boolean(value && identity && value.policyVersion === CAPTURE_PRIOR_POLICY_VERSION && value.provenance === 'explicit_user_commands'
    && /^[a-f0-9]{64}$/u.test(value.holdoutHash) && Number.isSafeInteger(value.pages) && value.pages >= 200
    && /^[a-f0-9]{64}$/u.test(value.registrationHash) && value.registrationHash !== value.holdoutHash
    && value.providerId === identity.providerId && value.modelVersion === identity.modelVersion
    && value.promptVersion === CLASSIFICATION_POLICY.promptVersion && value.candidateVersion === CLASSIFICATION_POLICY.candidateVersion
    && value.collectionIsolationVerified === true && value.pairedPValue >= 0 && value.pairedPValue < 0.05
    && value.laterToFolderIncreasePp <= 1 && value.laterToFolderIncreasePp >= -100
    && Number.isSafeInteger(value.ties) && value.ties > 0 && Number.isSafeInteger(value.correctedTies) && value.correctedTies > 0
    && Number.isSafeInteger(value.baseErrors) && Number.isSafeInteger(value.personalizedErrors)
    && value.personalizedErrors >= 0 && value.personalizedErrors < value.baseErrors && value.baseErrors <= value.pages
    && value.ties <= value.pages && value.correctedTies <= value.ties && 100 * (value.baseErrors - value.personalizedErrors) / value.pages >= 2);
}
/** Evidence is already one current source per page, with directory/tag deltas separated by the adapter. */
export function chooseCapturePreference(evidence: readonly CaptureMemoryEvidence[], taxonomyRevision: string,
  allowed: ReadonlySet<string>): { folderId: string; pages: number } | null {
  const latest = new Map<string, string>();
  for (const row of evidence) if (!latest.has(row.pageKey) || latest.get(row.pageKey)! < row.receivedAt) latest.set(row.pageKey, row.receivedAt);
  const totals = new Map<string, { positive: number; negative: number }>(), pages = new Set<string>();
  const seen = new Set<string>();
  for (const row of evidence) {
    if (!allowed.has(row.folderId) || row.receivedAt !== latest.get(row.pageKey)) continue;
    const key = JSON.stringify([row.pageKey, row.folderId]); if (seen.has(key)) continue; seen.add(key);
    if (![row.positive, row.negative].every(value => Number.isFinite(value) && value >= 0)) return null;
    const weight = row.taxonomyRevision === taxonomyRevision ? 1 : 0.25, total = totals.get(row.folderId) ?? { positive: 0, negative: 0 };
    total.positive += row.positive * weight; total.negative += row.negative * weight; totals.set(row.folderId, total);
    if (row.positive > 0) pages.add(row.pageKey);
  }
  if (pages.size < 5) return null;
  const ranked = [...totals].sort((a, b) => b[1].positive - a[1].positive || a[0].localeCompare(b[0]));
  const sum = ranked.reduce((value, [, score]) => value + score.positive, 0), first = ranked[0];
  if (!first || !sum || !Number.isFinite(sum) || first[1].negative >= first[1].positive || first[1].positive / sum < 0.7
    || (first[1].positive - (ranked[1]?.[1].positive ?? 0)) / sum < 0.2) return null;
  return { folderId: first[0], pages: pages.size };
}
export function resolveCapturePrimaryTie(input: {
  readonly folderId: string; readonly decision: string; readonly confidence: number;
  readonly probabilities: readonly { readonly folderId: string | null; readonly probability: number }[];
}, evidence: readonly CaptureMemoryEvidence[], taxonomyRevision: string, legalFolders: ReadonlySet<string>) {
  if (!['l1_root', 'l2'].includes(input.decision) || !input.probabilities.length
    || input.probabilities.some(value => !Number.isFinite(value.probability) || value.probability < 0 || value.probability > 1)) return { folderId: input.folderId, explanation: null };
  const max = Math.max(...input.probabilities.map(value => value.probability));
  const tied = new Set(input.probabilities.filter(value => value.probability === max && value.folderId && legalFolders.has(value.folderId)).map(value => value.folderId!));
  if (tied.size < 2 || !tied.has(input.folderId)) return { folderId: input.folderId, explanation: null };
  const preferred = chooseCapturePreference(evidence, taxonomyRevision, legalFolders);
  if (!preferred || !tied.has(preferred.folderId) || preferred.folderId === input.folderId) return { folderId: input.folderId, explanation: null };
  return { folderId: preferred.folderId, explanation: { policyVersion: CAPTURE_PRIOR_POLICY_VERSION, kind: 'exact_score_tie' as const, pages: preferred.pages } };
}
export interface CaptureLearningView {
  readonly generation: number; readonly clearedAt: string | null; readonly enabled: boolean; readonly priorAvailable: boolean;
  readonly records: readonly { readonly hostname: string; readonly kind: string; readonly beforePath: readonly string[];
    readonly afterPath: readonly string[]; readonly receivedAt: string; readonly available: boolean }[];
}
