import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeTreeProof, localProofDigest } from '../src/native-tree-proof.js';

test('native proof excludes incidental timestamps and includes ancestry, order and inherited management', () => {
  const tree = [{ id:'1', title:'Bookmarks', unmodifiable:'managed', dateLastUsed:42,
    children:[{id:'2',title:'Read',url:'https://example.test',parentId:'wrong',dateLastUsed:101}] }];
  const proof = nativeTreeProof(tree);
  assert.deepEqual(proof[1],{id:'2',parentId:'1',title:'Read',url:'https://example.test',index:0,dateAdded:null,managed:true});
  assert.equal(JSON.stringify(proof).includes('dateLastUsed'),false);
});
test('invalid duplicate native identity rejects an entire preview', () => {
  assert.throws(() => nativeTreeProof([{id:'1',title:'a',children:[{id:'1',title:'b'}]}]),/preview_too_large/);
});
test('proof digest detects edits but is deterministic for the same facts', async () => {
  const first = nativeTreeProof([{id:'1',title:'A'}]);
  assert.equal(await localProofDigest(first),await localProofDigest(first));
  assert.notEqual(await localProofDigest(first),await localProofDigest(nativeTreeProof([{id:'1',title:'B'}])));
});
