import {expect,test} from 'vitest';
import {findBreakingChanges} from '../../../scripts/check-openapi-breaking.mjs';
const doc=(content:Record<string,unknown>)=>({paths:{'/settings':{get:{operationId:'getSettings',responses:{'200':{description:'Settings',content}}},
  patch:{operationId:'patchSettings',requestBody:{content},responses:{'200':{description:'Updated'}}}}}});
const json={'application/json':{schema:{type:'string',enum:['managed']}}};
test('a negotiated media representation is additive while the old media remains unchanged',()=>{
  expect(findBreakingChanges(doc(json),doc({...json,'application/vnd.settings.v2+json':{schema:{type:'string',enum:['managed','byok']}}}))).toEqual([]);
});
test('removing or changing the original media still breaks compatibility',()=>{
  expect(findBreakingChanges(doc(json),doc({'application/vnd.settings.v2+json':json['application/json']}))).not.toEqual([]);
  expect(findBreakingChanges(doc(json),doc({'application/json':{schema:{type:'string',enum:['managed','byok']}}}))).not.toEqual([]);
});
