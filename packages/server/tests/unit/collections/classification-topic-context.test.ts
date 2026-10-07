import { expect, test } from 'vitest';
import { addClassificationFolderExamples, buildClassificationCandidates, buildClassificationTaxonomy,
  decideClassificationFolder, selectClassificationDescendants, CLASSIFICATION_POLICY,
  captureFolderGate, eligibleCapturePrior, CAPTURE_POLICY_VERSION,
  type ClassificationFolderInput, type CaptureFolderCalibration, type CapturePriorEvaluation } from '../../../src/modules/collections/index.js';
import { folderPrompt } from '../../../src/infrastructure/collections/classification-jev-prompts.js';

const bookmark = { title: 'React', url: 'https://react.dev/', description: 'React documentation' };
const folder = (id: string, parentId: string | null, title: string): ClassificationFolderInput => ({ id, parentId, title, description: null });
const build = (folders: readonly ClassificationFolderInput[]) => buildClassificationCandidates({
  bookmark, folders, tagUsage: [], existingTags: [], requested: { folder: true, tags: false } });

test('browser roots are containers in any language and a promoted topic retains its actual parent and depth', () => {
  const candidates = build([
    { ...folder('other', null, '其它收藏夹'), folderRole: 'other-bookmarks' },
    { ...folder('bar', null, 'Favoritenleiste'), folderRole: 'bookmarks-bar' },
    { ...folder('mobile', null, 'Mobile'), folderRole: 'mobile-bookmarks' },
    { ...folder('managed', null, 'Company'), folderRole: 'managed-bookmarks' },
    folder('hidden', 'managed', 'React'), folder('tools', 'other', '工具'),
    folder('react', 'tools', 'React'), folder('reading', 'bar', 'Reading'),
    folder('custom', null, '其它收藏夹'),
  ]);
  expect(candidates.l1.map(f => f.id)).toEqual(['custom', 'reading', 'tools']);
  expect(candidates.coverage.l1Total).toBe(3);
  expect(selectClassificationDescendants(candidates, 'tools', bookmark).folders.map(f => f.id)).toEqual(['react']);
  const decision = decideClassificationFolder({ candidates, bookmark, requested: true,
    l1: { folderId: 'tools', confidence: 0.9, probabilities: [...candidates.l1.map(f => ({ folderId: f.id, probability: f.id === 'tools' ? 0.9 : 0 })),
      { folderId: null, probability: 0.1 }] },
    l2: { folderId: 'tools', confidence: 0.8, specificity: 0.2, probabilities: [{ folderId: 'tools', probability: 0.8 }, { folderId: 'react', probability: 0.2 }] } });
  expect(decision).toMatchObject({ decision: 'l1_root', folderId: 'tools', parentFolderId: 'other', depth: 2, l1FolderId: 'tools' });
});

test('a large branch is recalled by its best descendant scope rather than diluted by unrelated folder names', () => {
  const roots = Array.from({ length: 32 }, (_, i) => folder(`a-${i}`, null, `React reference${i}`));
  const target = folder('z-tools', null, '工具');
  const children = Array.from({ length: 200 }, (_, i) => folder(`z-child-${i}`, target.id, `无关目录${i}`));
  children.push({ ...folder('z-react', target.id, '文档'), description: 'React react.dev' });
  expect(build([...roots, target, ...children]).l1.some(f => f.id === target.id)).toBe(true);
  expect(build([...roots, { ...target, bookmarkExamples: [{ title: 'React', hostname: 'react.dev' }] }]).l1.some(f => f.id === target.id)).toBe(true);
});

test('examples are bounded, deterministic, domain-diverse and propagate to parent topics without exposing URL paths', () => {
  const folders = [folder('tools', null, '工具'), folder('docs', 'tools', '文档')];
  const bookmarks = [
    { parentId: 'docs', title: 'React', url: 'https://react.dev/private/path?secret=do-not-send' },
    { parentId: 'docs', title: 'Another React page', url: 'https://react.dev/other' },
    { parentId: 'docs', title: 'TypeScript', url: 'https://typescriptlang.org/' },
    { parentId: 'docs', title: 'Vite', url: 'https://vite.dev/' },
    { parentId: 'docs', title: 'Vue', url: 'https://vuejs.org/' },
    { parentId: 'docs', title: 'Unsupported', url: 'javascript:alert(1)' },
    { parentId: 'unknown', title: 'Outside taxonomy', url: 'https://outside.example/' },
  ];
  const enriched = addClassificationFolderExamples({ folders, bookmarks });
  expect(addClassificationFolderExamples({ folders, bookmarks: [...bookmarks].reverse() })).toEqual(enriched);
  expect(enriched[0]!.bookmarkExamples).toEqual(enriched[1]!.bookmarkExamples);
  expect(enriched[1]!.bookmarkExamples).toHaveLength(CLASSIFICATION_POLICY.maxFolderExamples);
  expect(enriched[1]!.bookmarkExamples?.map(example => example.hostname)).toEqual(['react.dev', 'typescriptlang.org', 'vite.dev']);
  expect(JSON.stringify(enriched)).not.toMatch(/secret|private\/path|Unsupported|Outside taxonomy/);
});

test('production supplies descriptions and existing examples to both independent L2 questions; archived variants retain their original context', () => {
  const taxonomy = buildClassificationTaxonomy([
    folder('tools', null, '工具'), { ...folder('docs', 'tools', '文档'), description: 'developer guides', bookmarkExamples: [{ title: 'React manual', hostname: 'react.dev' }] },
  ]);
  const input = { bookmark, collection: { title: 'Library', summary: 'My development resources' }, taxonomy,
    candidates: [taxonomy.find(f => f.id === 'docs')!], parent: taxonomy.find(f => f.id === 'tools')! };
  const request = folderPrompt({ ...input, variant: 'production' }).request;
  expect(request.state.bookmark).toMatchObject({ description: bookmark.description });
  expect(request.state.collection.summary).toBe(input.collection.summary);
  expect(request.state.descendants?.f0?.bookmarkExamples).toContain('React manual (react.dev)');
  expect(JSON.stringify(request).match(/React manual/g)).toHaveLength(1);
  expect(JSON.stringify(folderPrompt({ ...input, variant: 'C' }).request)).not.toMatch(/React manual|My development resources|React documentation/);
});

test('a frozen batch taxonomy omits each target from its own examples at candidate construction', () => {
  const folders = addClassificationFolderExamples({ folders: [folder('tools', null, '工具')], bookmarks: [
    { id: 'target', parentId: 'tools', title: 'Current page', url: 'https://current.example/' },
    { id: 'existing', parentId: 'tools', title: 'Other page', url: 'https://other.example/' },
  ] });
  const candidates = buildClassificationCandidates({ bookmark, folders, tagUsage: [], existingTags: [],
    requested: { folder: true, tags: false }, excludeBookmarkId: 'target' });
  expect(candidates.l1[0]!.bookmarkExamples).toEqual([{ title: 'Other page', hostname: 'other.example', bookmarkId: 'existing' }]);
  const wire = JSON.stringify(folderPrompt({ bookmark, collection: { title: 'Library', summary: null },
    taxonomy: candidates.taxonomy, candidates: candidates.l1, variant: 'production' }).request);
  expect(wire).toContain('Other page');
  expect(wire).not.toMatch(/Current page|bookmarkId|existing/);
});

test('optional example context never causes an otherwise valid request to exceed its byte budget', () => {
  const folders = Array.from({ length: 32 }, (_, i) => ({ ...folder(String(i), null, '工具 '.repeat(70)), description: '范围 '.repeat(50),
    bookmarkExamples: [{ title: 'A documentation example '.repeat(8), hostname: 'documentation.example.org' }] }));
  const taxonomy = buildClassificationTaxonomy(folders);
  const request = folderPrompt({ bookmark, collection: { title: 'Library', summary: null }, taxonomy, candidates: taxonomy, variant: 'production' }).request;
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(CLASSIFICATION_POLICY.maxRequestBytes);
  expect((JSON.stringify(request).match(/Existing bookmarks:/g) ?? []).length).toBeLessThan(32);
});

test('confidence and personal-preference approvals for archived context cannot authorize the new production context', () => {
  const identity = { providerId: 'fixture-provider', modelVersion: 'fixture-model' };
  const calibration: CaptureFolderCalibration = { ...identity, policyVersion: CAPTURE_POLICY_VERSION,
    promptVersion: CLASSIFICATION_POLICY.promptVersion, candidateVersion: CLASSIFICATION_POLICY.candidateVersion,
    threshold: 0.9, calibrationHash: 'a'.repeat(64), holdoutHash: 'b'.repeat(64), correct: 200, wrong: 0, provenance: 'human' };
  const prior: CapturePriorEvaluation = { ...identity, policyVersion: 'capture-explicit-tie.v1', provenance: 'explicit_user_commands',
    promptVersion: CLASSIFICATION_POLICY.promptVersion, candidateVersion: CLASSIFICATION_POLICY.candidateVersion,
    holdoutHash: 'a'.repeat(64), registrationHash: 'b'.repeat(64), pages: 200, baseErrors: 20, personalizedErrors: 10,
    ties: 20, correctedTies: 10, pairedPValue: 0.01, laterToFolderIncreasePp: 0, collectionIsolationVerified: true };
  expect(captureFolderGate(calibration, identity)).toBe(true);
  expect(eligibleCapturePrior(prior, identity)).toBe(true);
  expect(captureFolderGate({ ...calibration, promptVersion: 'l1-description-c-v2', candidateVersion: 'candidates.v1' }, identity)).toBe(false);
  expect(eligibleCapturePrior({ ...prior, promptVersion: 'l1-description-c-v2', candidateVersion: 'candidates.v1' }, identity)).toBe(false);
});
