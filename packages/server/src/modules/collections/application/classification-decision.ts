import { CLASSIFICATION_POLICY as policy, ClassificationError, type ClassificationBookmark, type ClassificationFolder, type ClassificationFolderSelectionMode } from './classification-policy.js';
import { type ClassificationCandidates, selectClassificationDescendants } from './classification-candidates.js';
import { compareClassificationBytes } from './classification-text.js';

export interface ClassificationProbability { readonly folderId: string | null; readonly probability: number }
export interface ClassificationFolderDecision {
  readonly decision: 'later' | 'l1_root' | 'l2';
  readonly folderId: string | null;
  readonly parentFolderId: string | null;
  readonly l1FolderId: string | null;
  readonly depth: number;
  readonly confidence: number;
  readonly l1Confidence: number;
  readonly l2Specificity: number | null;
  readonly probabilities: readonly ClassificationProbability[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ClassificationError('contract_drift');
  return value as Record<string, unknown>;
}
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ClassificationError('contract_drift');
  return value;
}
function choice(value: unknown, allowlist: ReadonlySet<string | null>) {
  const raw = object(value);
  if ((raw.folderId !== null && typeof raw.folderId !== 'string') || !allowlist.has(raw.folderId)) throw new ClassificationError('contract_drift');
  const confidence = probability(raw.confidence);
  if (!Array.isArray(raw.probabilities) || raw.probabilities.length !== allowlist.size) throw new ClassificationError('contract_drift');
  const seen = new Set<string | null>();
  const probabilities = raw.probabilities.map(item => {
    const entry = object(item);
    if ((entry.folderId !== null && typeof entry.folderId !== 'string') || !allowlist.has(entry.folderId) || seen.has(entry.folderId)) throw new ClassificationError('contract_drift');
    seen.add(entry.folderId);
    return { folderId: entry.folderId, probability: probability(entry.probability) };
  }).sort((a, b) => b.probability - a.probability || compareClassificationBytes(a.folderId ?? '', b.folderId ?? ''));
  return { folderId: raw.folderId, confidence, probabilities: probabilities.slice(0, 5) };
}

/** Provider-neutral normalized stages are untrusted at this boundary. */
export function decideClassificationFolder(input: {
  readonly candidates: ClassificationCandidates; readonly bookmark: ClassificationBookmark;
  readonly requested: boolean; readonly l1: unknown; readonly l2: unknown;
  readonly folderSelectionMode?: ClassificationFolderSelectionMode;
}): ClassificationFolderDecision | null {
  if (!input.requested) {
    if (input.l1 !== null || input.l2 !== null) throw new ClassificationError('contract_drift');
    return null;
  }
  const allowLater = input.folderSelectionMode !== 'require_candidate' || input.candidates.l1.length === 0;
  const l1 = choice(input.l1, new Set([...input.candidates.l1.map(f => f.id), ...(allowLater ? [null] : [])]));
  const parent = input.candidates.l1.find(f => f.id === l1.folderId);
  const base = { l1Confidence: l1.confidence, l2Specificity: null, confidence: l1.confidence, probabilities: l1.probabilities };
  if (!parent) {
    if (input.l2 !== null) throw new ClassificationError('contract_drift');
    return { ...base, decision: 'later', folderId: null, parentFolderId: null, l1FolderId: null, depth: 0 };
  }
  const descendants = selectClassificationDescendants(input.candidates, parent.id, input.bookmark).folders;
  const references = (folder: ClassificationFolder) => ({ folderId: folder.id, parentFolderId: folder.parentId, l1FolderId: folder.l1FolderId, depth: folder.depth });
  if (!descendants.length) {
    if (input.l2 !== null) throw new ClassificationError('contract_drift');
    return { ...base, ...references(parent), decision: 'l1_root' };
  }
  const l2 = choice(input.l2, new Set([...descendants.map(f => f.id), parent.id]));
  const specificity = probability(object(input.l2).specificity);
  const selected = descendants.find(f => f.id === l2.folderId);
  const accepted = selected && specificity >= policy.l2SpecificityMin && l2.confidence >= policy.l2ConfidenceMin;
  return { ...references(accepted ? selected : parent), decision: accepted ? 'l2' : 'l1_root',
    confidence: l2.confidence, probabilities: l2.probabilities, l1Confidence: l1.confidence, l2Specificity: specificity };
}

export function decideClassificationTags(input: {
  readonly candidates: readonly string[]; readonly existingTags: readonly string[];
  readonly output: unknown; readonly maxAdded: number;
}): readonly { readonly tag: string; readonly noul: number; readonly selected: boolean }[] {
  if (!Number.isInteger(input.maxAdded) || input.maxAdded < 0 || input.maxAdded > policy.maxAddedTags || input.existingTags.length > policy.maxFinalTags) throw new ClassificationError('invalid_input');
  if (!Array.isArray(input.output) || input.output.length !== input.candidates.length) throw new ClassificationError('contract_drift');
  const seen = new Set<string>();
  const output = input.output.map(item => {
    const raw = object(item);
    if (typeof raw.tag !== 'string' || !input.candidates.includes(raw.tag) || seen.has(raw.tag) || input.existingTags.includes(raw.tag)) throw new ClassificationError('contract_drift');
    seen.add(raw.tag);
    return { tag: raw.tag, noul: probability(raw.noul) };
  }).sort((a, b) => b.noul - a.noul || compareClassificationBytes(a.tag, b.tag));
  const room = Math.min(input.maxAdded, policy.maxFinalTags - input.existingTags.length);
  return output.map((item, i) => ({ ...item, selected: i < room && item.noul >= policy.suggestThreshold }));
}
