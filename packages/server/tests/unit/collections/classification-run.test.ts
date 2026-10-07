import { expect,test } from 'vitest';
import { parseClassificationRunCreate,parseClassificationRunApply,selectClassificationRunNodes } from '../../../src/modules/collections/index.js';
const create={sourceFolderIds:['a'],requested:{folder:true,tags:true},maxItems:50};
test('run selectors are closed, nonempty, unique and bounded without requiring both selectors',()=>{
  expect(parseClassificationRunCreate(create)).toMatchObject({sourceFolderIds:['a'],nodeIds:[]});
  for(const document of [{...create,extra:true},{...create,sourceFolderIds:[]},{...create,sourceFolderIds:['a','a']},
    {...create,sourceFolderIds:['中'.repeat(43)]},{...create,nodeIds:Array.from({length:51},(_,i)=>String(i))},
    {...create,maxItems:51},{...create,requested:{folder:false,tags:false}},{...create,requested:{folder:true,tags:true,extra:false}}]) {
    expect(()=>parseClassificationRunCreate(document)).toThrow();
  }
});
test('source descendants and explicit nodes union by identity and preserve deterministic creation order before truncation',()=>{
  const bookmark=(id:string,parentId:string,createdAt:string)=>({id,parentId,createdAt,title:id,url:'https://example.org',description:null,tags:[],resourceRevision:'r1'});
  const tree={rootId:'root',folders:[{id:'a',parentId:null,title:'Same',description:null},{id:'b',parentId:'a',title:'Same',description:null}],
    bookmarks:[bookmark('z','root','2026-01-01'),bookmark('a1','a','2026-01-02'),bookmark('b2','b','2026-01-02')]};
  expect(selectClassificationRunNodes(parseClassificationRunCreate({...create,nodeIds:['z','a1'],maxItems:2}),tree).map(n=>n.id)).toEqual(['z','a1']);
  expect(()=>selectClassificationRunNodes(parseClassificationRunCreate({...create,nodeIds:['foreign']}),tree)).toThrow();
  expect(selectClassificationRunNodes(parseClassificationRunCreate({...create,sourceFolderIds:['root']}),tree)).toHaveLength(3);
});
test('Apply accepts one bounded atomic selection and rejects duplicates, unknown fields and empty operations',()=>{
  const selection={actionId:'a',folderId:null,addTags:['AI']};
  expect(parseClassificationRunApply({selections:[selection]})).toEqual([selection]);
  for(const document of [{selections:[]},{selections:[selection,selection]},{selections:[{...selection,addTags:[]}]},
    {selections:[{...selection,removeTags:['old']}]},{selections:Array.from({length:51},(_,i)=>({...selection,actionId:String(i)}))}]) {
    expect(()=>parseClassificationRunApply(document)).toThrow();
  }
});
