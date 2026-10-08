import {expect,test} from 'vitest';
import {normalizeClassificationHostname,eligibleClassificationHostnameFolder,rankClassificationHostnameTies,
  APPROVED_CLASSIFICATION_PRIOR_EVALUATION,type ClassificationFolderDecision,type ClassificationHostnameEvidence} from '../../../src/modules/collections/index.js';
const row=(folderId:string,count:number,current=count):ClassificationHostnameEvidence=>({hostname:'example.org',folderId,acceptedCount:count,currentRevisionCount:current,rejectedCount:null,lastAcceptedAt:new Date(0).toISOString()});
test('hostname identity preserves subdomains, IDNA and rejects IP, localhost and invalid URLs',()=>{
  expect(normalizeClassificationHostname('https://WWW.Example.ORG.:443/a?b=c')).toBe('example.org');
  expect(normalizeClassificationHostname('https://docs.example.org/a')).toBe('docs.example.org');
  expect(normalizeClassificationHostname('https://例子.测试/')).toBe('xn--fsqu00a.xn--0zwm56d');
  for(const url of ['http://127.1/','http://0x7f000001/','https://[::1]/','http://localhost./','http://a.localhost/','ftp://example.org/','https://user:password@example.org/','bad'])expect(normalizeClassificationHostname(url)).toBeNull();
});
test('all sample/share/margin gates apply and stale evidence carries a lower weight',()=>{
  expect(eligibleClassificationHostnameFolder([row('a',4)],'https://example.org/')).toBeNull();
  expect(eligibleClassificationHostnameFolder([row('a',7),row('b',3)],'https://example.org/')).toBe('a');
  expect(eligibleClassificationHostnameFolder([row('a',6),row('b',4)],'https://example.org/')).toBeNull();
  expect(eligibleClassificationHostnameFolder([row('a',7,0),row('b',3)],'https://example.org/')).toBeNull();
  expect(eligibleClassificationHostnameFolder([row('a',10)],'https://sub.example.org/')).toBeNull();
  expect(APPROVED_CLASSIFICATION_PRIOR_EVALUATION).toBeNull();
});
test('tie-break changes only equal-probability ordering, never chosen destination or confidence',()=>{
  const decision:ClassificationFolderDecision={decision:'later',folderId:null,parentFolderId:null,l1FolderId:null,depth:0,confidence:0.1,l1Confidence:0.1,l2Specificity:null,
    probabilities:[{folderId:null,probability:0.5},{folderId:'a',probability:0.5}]};
  const ranked=rankClassificationHostnameTies(decision,[row('a',5)],'https://example.org/')!;
  expect(ranked.probabilities.map(p=>p.folderId)).toEqual(['a',null]);expect({...ranked,probabilities:decision.probabilities}).toEqual(decision);
  const unequal={...decision,probabilities:[{folderId:null,probability:0.6},{folderId:'a',probability:0.4}]};
  expect(rankClassificationHostnameTies(unequal,[row('a',5)],'https://example.org/')).toEqual(unequal);
});
