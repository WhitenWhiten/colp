import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildClassificationTaxonomy, buildClassificationCandidates, selectClassificationDescendants } from '../../../src/modules/collections/application/classification-candidates.js';
import { classificationTokens, compileClassificationText, normalizeClassificationBookmark, assertClassificationRequestBudget, classificationBookmarkTokens } from '../../../src/modules/collections/application/classification-text.js';
import { CLASSIFICATION_POLICY } from '../../../src/modules/collections/application/classification-policy.js';

const fixture = JSON.parse(readFileSync(new URL('../../../scripts/classification/fixtures/boundaries.v1.json', import.meta.url), 'utf8'));
const bookmark = { title: '无相关词', url: 'https://example.org/?q=root-33', description: null };
const build = () => buildClassificationCandidates({ bookmark, folders: fixture.collections[0].folders, tagUsage: fixture.collections[0].tags, existingTags: [], requested: { folder: true, tags: true } });

test('deep ancestry preserves actual parent, L1 and duplicate-title paths', () => {
  const taxonomy = buildClassificationTaxonomy(fixture.collections[0].folders);
  const deep = taxonomy.find(f => f.id === 'depth-8')!;
  expect(deep.depth).toBe(8); expect(deep.parentId).toBe('depth-7'); expect(deep.l1FolderId).toBe('root-00');
  expect(deep.path).toHaveLength(8);
  expect(taxonomy.filter(f => f.title === '重复标题')).toHaveLength(66);
});
test('32/64/96 deterministic clipping is visible and excludes omitted gold', () => {
  const candidates = build(); const descendants = selectClassificationDescendants(candidates, 'root-00', bookmark);
  expect(candidates.l1).toHaveLength(32); expect(candidates.tags).toHaveLength(96);
  expect(candidates.tagChunks.map(c => c.length)).toEqual([16, 16, 16, 16, 16, 16]);
  expect(descendants.folders).toHaveLength(64);
  expect(descendants.coverage).toMatchObject({ l1Total: 34, l1Included: 32, descendantTotal: 72, descendantIncluded: 64, tagTotal: 98, tagIncluded: 96 });
  expect(candidates.l1.some(f => f.id === 'root-33')).toBe(false);
  expect(descendants.folders.some(f => f.id === 'child-65')).toBe(false);
  expect(buildClassificationCandidates({ bookmark, folders: [...fixture.collections[0].folders].reverse(), tagUsage: [...fixture.collections[0].tags].reverse(), existingTags: [], requested: { folder: true, tags: true } })).toEqual(candidates);
});
test('query values do not influence recall, path and Han bigrams do', () => {
  expect(classificationBookmarkTokens(bookmark)).toEqual(classificationBookmarkTokens({ ...bookmark, url: 'https://example.org/?secret=标签099' }));
  expect([...classificationTokens('ＡＩ 中文目录 单')]).toEqual(['ai', '中文', '文目', '目录', '单']);
  expect(classificationBookmarkTokens({ ...bookmark, url: 'https://example.org/%E4%B8%AD%E6%96%87' }).has('中文')).toBe(true);
});
test('tag identities remain exact; no requested folder produces zero coverage', () => {
  const candidates = buildClassificationCandidates({ bookmark, folders: [], tagUsage: [{tag: 'AI', count: 1}, {tag: 'ai', count: 2}, {tag: 'ＡＩ', count: 1}], existingTags: ['AI'], requested: { folder: false, tags: true } });
  expect(candidates.tags).toEqual(['ai', 'ＡＩ']); expect(candidates.coverage.l1Total).toBe(0);
});
test('materialized ancestor paths fail closed beyond the derived budget', () => {
  const deep = Array.from({ length: 2000 }, (_, index) => ({ id: `d-${index}`, parentId: index === 0 ? null : `d-${index - 1}`, title: 't', description: null }));
  expect(() => buildClassificationTaxonomy(deep)).toThrow('context_limit');
  const titled = Array.from({ length: 600 }, (_, index) => ({ id: `w-${index}`, parentId: index === 0 ? null : `w-${index - 1}`, title: 't'.repeat(512), description: null }));
  expect(() => buildClassificationTaxonomy(titled)).toThrow('context_limit');
  const legal = buildClassificationTaxonomy(deep.slice(0, 1000));
  expect(legal).toHaveLength(1000); expect(legal.find(f => f.id === 'd-999')!.path).toHaveLength(1000);
});
test('invalid ancestry and invalid requests fail closed', () => {
  expect(() => buildClassificationTaxonomy([{id: 'a', parentId: 'a', title: '', description: null}])).toThrow('invalid_taxonomy');
  expect(() => buildClassificationTaxonomy([{id: 'a', parentId: 'missing', title: '', description: null}])).toThrow('invalid_taxonomy');
  expect(() => normalizeClassificationBookmark({...bookmark, url: 'https://u:p@example.com/'})).toThrow('invalid_input');
  expect(() => normalizeClassificationBookmark({...bookmark, url: 'file:///x'})).toThrow('invalid_input');
});
test('prompt normalization is bounded UTF-8, word safe and does not rewrite inputs', () => {
  expect(compileClassificationText('ＡＩ\n\u0000 资料\u202e', 384)).toBe('AI 资料');
  expect(compileClassificationText('hello world', 8)).toBe('hello');
  expect(Buffer.byteLength(compileClassificationText('中文资料。'.repeat(200), 384))).toBeLessThanOrEqual(384);
  expect(normalizeClassificationBookmark({...bookmark, url: 'https://WWW.Example.org./a'}).hostname).toBe('example.org');
  expect(bookmark.title).toBe('无相关词');
  expect(() => assertClassificationRequestBudget({text: '中'.repeat(32768)})).toThrow('context_limit');
});
test('v3 context has new identities while retaining the frozen candidate budgets', () => {
  const frozen = JSON.parse(readFileSync(new URL('../../../scripts/classification/preregistration.v2.json', import.meta.url), 'utf8'));
  expect(CLASSIFICATION_POLICY.version).toBe('classification.v3');
  expect(CLASSIFICATION_POLICY.candidateVersion).toBe('candidates.v2');
  expect(CLASSIFICATION_POLICY.promptVersion).toBe('topic-context-v3');
  expect(CLASSIFICATION_POLICY.version).not.toBe(frozen.policyVersion);
  expect(CLASSIFICATION_POLICY.maxL1).toBe(frozen.budgets.l1);
  expect(CLASSIFICATION_POLICY.maxDescendants).toBe(frozen.budgets.descendants);
  expect(CLASSIFICATION_POLICY.maxTags).toBe(frozen.budgets.tags);
  expect(CLASSIFICATION_POLICY.folderDescriptionBytes).toBe(frozen.budgets.folderDescriptionBytes);
});
test('turned-down folders and their subfolders are never candidates', () => {
  const folders = [
    { id: 'dev', parentId: null, title: 'Dev', description: null }, { id: 'react', parentId: 'dev', title: 'React', description: null },
    { id: 'hooks', parentId: 'react', title: 'Hooks', description: null }, { id: 'vue', parentId: 'dev', title: 'Vue', description: null },
    { id: 'news', parentId: null, title: 'News', description: null },
  ];
  const candidates = (rejectedFolderIds?: string[]) => buildClassificationCandidates({ bookmark, folders, tagUsage: [], existingTags: [], requested: { folder: true, tags: false }, rejectedFolderIds });
  const l2 = candidates(['react', 'missing']);
  expect(l2.l1.map(f => f.id).sort()).toEqual(['dev', 'news']);
  expect(selectClassificationDescendants(l2, 'dev', bookmark).folders.map(f => f.id)).toEqual(['vue']);
  const l1 = candidates(['dev']);
  expect(l1.l1.map(f => f.id)).toEqual(['news']); expect(l1.coverage.l1Total).toBe(1);
  expect(candidates([])).toEqual(candidates());
});
