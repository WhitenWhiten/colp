import { test, expect } from 'vitest';
import { buildClassificationCandidates } from '../../../src/modules/collections/application/classification-candidates.js';
import { decideClassificationFolder, decideClassificationTags } from '../../../src/modules/collections/application/classification-decision.js';

const bookmark = { title: 'React', url: 'https://react.dev/', description: null };
const candidates = buildClassificationCandidates({bookmark, folders: [
  {id: 'tech', parentId: null, title: '技术', description: null},
  {id: 'front', parentId: 'tech', title: '前端', description: null},
  {id: 'react', parentId: 'front', title: 'React', description: null},
], tagUsage: [], existingTags: [], requested: {folder: true, tags: false}});
const l1 = {folderId: 'tech', confidence: 0.9, probabilities: [{folderId: 'tech', probability: 0.9}, {folderId: null, probability: 0.1}]};
const l2 = {folderId: 'react', confidence: 0.8, specificity: 0.9, probabilities: [{folderId: 'tech', probability: 0.1}, {folderId: 'front', probability: 0.1}, {folderId: 'react', probability: 0.8}]};
const decide = (first: unknown = l1, second: unknown = l2) => decideClassificationFolder({candidates, bookmark, requested: true, l1: first, l2: second});

test('second-stage descendant has actual depth/parent and only conditional probabilities', () => {
  const result = decide();
  expect(result).toMatchObject({decision: 'l2', depth: 3, folderId: 'react', parentFolderId: 'front', l1FolderId: 'tech', confidence: 0.8, l1Confidence: 0.9});
  expect(result?.probabilities).toHaveLength(3); expect(result?.probabilities[0]?.probability).toBe(0.8);
});
test('low specificity/confidence falls back to parent, later remains stage-one only', () => {
  for (const second of [{...l2, specificity: 0.49}, {...l2, confidence: 0.39}, {...l2, folderId: 'tech'}]) {
    expect(decide(l1, second)).toMatchObject({decision: 'l1_root', depth: 1, parentFolderId: null, folderId: 'tech'});
  }
  expect(decide({...l1, folderId: null}, null)).toMatchObject({decision: 'later', folderId: null, depth: 0, l2Specificity: null});
});
test('out-of-snapshot, missing, duplicate, NaN and out-of-range outputs are contract drift', () => {
  for (const first of [{...l1, folderId: 'evil'}, {...l1, probabilities: []}, {...l1, probabilities: [l1.probabilities[0], l1.probabilities[0]]}, ...[NaN, Infinity, -0.1, 1.1].map(confidence => ({...l1, confidence}))]) expect(() => decide(first)).toThrow('contract_drift');
  expect(() => decide(l1, {...l2, folderId: 'other-root-child'})).toThrow('contract_drift');
  expect(() => decide(l1, null)).toThrow('contract_drift');
  expect(() => decide({...l1, folderId: null}, l2)).toThrow('contract_drift');
});
test('folder not requested is null and cannot hide an unexpected model call', () => {
  expect(decideClassificationFolder({candidates, bookmark, requested: false, l1: null, l2: null})).toBeNull();
  expect(() => decideClassificationFolder({candidates, bookmark, requested: false, l1, l2: null})).toThrow('contract_drift');
});

test('requiring a candidate validates the restricted allowlist, while an empty taxonomy can abstain', () => {
  const roots = buildClassificationCandidates({ bookmark, folders: [{ id: 'a', parentId: null, title: 'A', description: null }],
    tagUsage: [], existingTags: [], requested: { folder: true, tags: false } });
  const input = { candidates: roots, bookmark, requested: true, folderSelectionMode: 'require_candidate' as const, l2: null };
  expect(decideClassificationFolder({ ...input, l1: { folderId: 'a', confidence: 0.2, probabilities: [{ folderId: 'a', probability: 1 }] } }))
    .toMatchObject({ decision: 'l1_root', folderId: 'a' });
  expect(() => decideClassificationFolder({ ...input, l1: { folderId: null, confidence: 1, probabilities: [{ folderId: null, probability: 1 }] } }))
    .toThrow('contract_drift');
  expect(decideClassificationFolder({ ...input, candidates: { ...roots, l1: [] },
    l1: { folderId: null, confidence: 1, probabilities: [{ folderId: null, probability: 1 }] } })).toMatchObject({ decision: 'later' });
});
test('tag selection caps union, keeps exact strings and validates all Noul values', () => {
  const tags = ['AI', 'ai', 'web', 'dev']; const output = tags.map(tag => ({tag, noul: 0.9}));
  expect(decideClassificationTags({candidates: tags, existingTags: [], output, maxAdded: 3}).filter(t => t.selected)).toHaveLength(3);
  expect(decideClassificationTags({candidates: tags, existingTags: Array.from({length: 63}, (_, i) => `t${i}`), output, maxAdded: 3}).filter(t => t.selected)).toHaveLength(1);
  for (const bad of [[...output.slice(1), output[1]], [...output.slice(1), {tag: 'unknown', noul: 1}], [...output.slice(1), {tag: 'AI', noul: NaN}]]) expect(() => decideClassificationTags({candidates: tags, existingTags: [], output: bad, maxAdded: 3})).toThrow('contract_drift');
});
