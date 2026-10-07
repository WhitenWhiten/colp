import { test, expect } from 'vitest';
import { buildClassificationTaxonomy } from '../../../src/modules/collections/application/classification-candidates.js';
import { folderPrompt, normalizeExperimentAnswer, type Variant } from '../../../scripts/classification/prompts.js';
const taxonomy = buildClassificationTaxonomy([
  {id:'later',parentId:null,title:'技术',description:'scope-only'},
  {id:'child',parentId:'later',title:'child-title',description:null},
]);
const make = (variant: Variant) => folderPrompt({bookmark:{title:'Page',url:'https://example.org/',description:'bookmark-only'},collection:{title:'Library',summary:'summary-only'},taxonomy,candidates:[taxonomy.find(f => f.id === 'later')!],variant});
test('A/B/C/D isolate description/child/full context without duplicating folder text in state', () => {
  const [a,b,c,d] = (['A','B','C','D'] as const).map(v => JSON.stringify(make(v).request));
  expect(a).not.toContain('scope-only'); expect(a).toContain('child-title');
  expect(b).toContain('scope-only'); expect(b).not.toContain('child-title');
  expect(c).toContain('scope-only'); expect(c).toContain('child-title'); expect(c).not.toContain('bookmark-only');
  expect(d).toContain('bookmark-only'); expect(d).toContain('summary-only');
  expect(d?.match(/scope-only/g)).toHaveLength(1);
});
test('reserved-looking opaque IDs cannot collide with later; unknown options fail closed', () => {
  const options = make('C').options;
  expect(options.get('f0')).toBe('later'); expect(options.get('later')).toBeNull();
  expect(normalizeExperimentAnswer({answers:{folder:{choice:'f0',confidence:0.9,probabilities:{f0:0.9,later:0.1}}}},options,false)).toMatchObject({folderId:'later'});
  expect(() => normalizeExperimentAnswer({answers:{folder:{choice:'unknown',probabilities:{}}}},options,false)).toThrow('contract_drift');
});
test('independent L2 Noul receives named descendants and descriptions are shared exactly once', () => {
  const folders=buildClassificationTaxonomy([{id:'p',parentId:null,title:'Parent',description:null},{id:'c',parentId:'p',title:'React',description:'React-only scope'}]);
  for(const variant of ['A','B','C','D'] as const){
    const prompt=folderPrompt({bookmark:{title:'React',url:'https://react.dev/',description:null},collection:{title:'Library',summary:null},taxonomy:folders,candidates:folders.filter(f=>f.depth>1),parent:folders.find(f=>f.id==='p')!,variant});
    expect(prompt.request.state.descendants?.f0?.path).toBe('Parent / React');
    const text=JSON.stringify(prompt.request);
    expect(text.match(/React-only scope/g)?.length??0).toBe(variant==='A'?0:1);
    expect(JSON.stringify(prompt.request.questions.specific)).toContain('state.descendants');
    expect(JSON.stringify(prompt.request.questions.folder)).not.toContain('React-only scope');
  }
});
