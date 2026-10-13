import { expect,test } from 'vitest';
import { compilePredicate } from '../../src/automation/index.js';
import facts from '../fixtures/automation/event-facts.json' with { type:'json' };
test('500 compiled rules over 1000 selected facts stay deterministic with bounded predicates',()=>{
  const start=performance.now();
  const predicates=Array.from({length:500},()=>compilePredicate({kind:'all',items:[
    {kind:'field',field:'bookmark.kind',op:'eq',value:'bookmark'},
    {kind:'field',field:'bookmark.url.host',op:'hostSuffix',value:'arxiv.org'},
  ]}));
  let matched=0;
  for(let member=0;member<1000;member++) for(const p of predicates) {
    if(!p.valid) throw new Error('Load predicate invalid');
    if(p.evaluate(facts).outcome==='matched') matched++;
  }
  expect(matched).toBe(500_000);
  console.log(JSON.stringify({measurement:'AW-44 evaluator',rules:500,members:1000,evaluations:500_000,elapsedMs:Math.round(performance.now()-start)}));
},30_000);
