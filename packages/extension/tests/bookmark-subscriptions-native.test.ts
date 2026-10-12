import { expect,test } from 'vitest';
import { database,row,root,leaf,owned,nativeFixture } from './bookmark-subscriptions-fixture.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
test('subscription native writes reject workspace ancestry and accept ordinary same-name folders',async()=>{
 const db=database(),m=row(),f=nativeFixture();await db.put('mappings',m);
 f.nodes.set('workspace',{id:'workspace',parentId:'0',title:'Renamed container'});f.nodes.set('project',{id:'project',parentId:'workspace',title:'Project'});
 f.nodes.set('ordinary',{id:'ordinary',parentId:'bar',title:'Workspaces'});
 const executor=createNativeExecutor(db,f.api);
 await expect(executor.create(m,root,'project')).rejects.toThrow('recovery_target_invalid');expect(f.calls).toEqual([]);
 await expect(executor.create(m,root,'ordinary')).resolves.toMatchObject({parentId:'ordinary'});await db.close();
});
test('create receipt is journaled before rejecting a changed apply epoch',async()=>{
  const db=database(),m=row(),f=nativeFixture();await db.put('mappings',m);const api={...f.api,async create(input:Parameters<typeof f.api.create>[0]){const result=await f.api.create(input);await db.changeMapping(m.id,v=>({...v,applyEpoch:2,enabled:false}));return result;}};
  await expect(createNativeExecutor(db,api).create(m,root,'bar')).rejects.toThrow('apply_epoch_changed');expect(await db.all('nodes')).toHaveLength(1);expect((await db.all('operations'))[0]).toMatchObject({phase:'received',resultId:'1',settled:true});await db.close();
});
test('crash after native create quarantines ambiguous children and never blindly recreates',async()=>{
  const db=database(),m=row(),f=nativeFixture();await db.put('mappings',m);const api={...f.api,async create(input:Parameters<typeof f.api.create>[0]){await f.api.create(input);throw new Error('lost_reply');}};const executor=createNativeExecutor(db,api);
  await expect(executor.create(m,root,'bar')).rejects.toThrow('lost_reply');await expect(executor.recover(m)).rejects.toThrow('recovery_identity_uncertain');await expect(executor.create(m,root,'bar')).rejects.toThrow('recovery_identity_uncertain');expect(f.calls.filter(c=>c.startsWith('create'))).toHaveLength(1);expect(await db.all('exclusions')).toMatchObject([{nativeId:'1',reason:'quarantine'}]);await db.close();
});
test('deleting a source parent never converts unselected owned children into personal copies',async()=>{
  const db=database(),m=row(),f=nativeFixture();await db.put('mappings',m);f.nodes.set('root',{id:'root',parentId:'bar',title:root.title});f.nodes.set('child',{id:'child',parentId:'root',title:'node',url:'https://example.test/node'});await db.put('nodes',owned(m,root,'root'));await db.put('nodes',owned(m,leaf(),'child','root'));
  const ex=createNativeExecutor(db,f.api);await ex.removeOwned(m,new Set([root.key]));expect(f.nodes.has('child')).toBe(true);expect(f.nodes.has('root')).toBe(true);expect(await db.all('exclusions')).toEqual([]);expect(f.calls).toEqual([]);
  await ex.removeOwned(m,new Set([root.key,leaf().key]));expect(f.calls).toEqual(['remove:child','remove:root']);await db.close();
});
test('cleanup preserves unknown personal subtrees and modified leaves; never calls recursive remove',async()=>{
  const db=database(),m=row(),f=nativeFixture();await db.put('mappings',m);f.nodes.set('root',{id:'root',parentId:'bar',title:root.title});f.nodes.set('child',{id:'child',parentId:'root',title:'My change',url:'https://my.test'});f.nodes.set('personal',{id:'personal',parentId:'root',title:'Personal'});f.nodes.set('personal-child',{id:'personal-child',parentId:'personal',title:'Mine',url:'https://mine.test'});await db.put('nodes',owned(m,root,'root'));await db.put('nodes',owned(m,leaf(),'child','root'));
  await createNativeExecutor(db,f.api).removeOwned(m,new Set([root.key,leaf().key]),true);expect(f.nodes.has('root')).toBe(false);expect(f.nodes.get('child')?.title).toBe('My change');expect(f.nodes.get('personal-child')?.parentId).toBe('personal');expect(f.nodes.get('personal')?.parentId).not.toBe('root');expect(await db.all('nodes')).toEqual([]);await db.close();
});
test('permission failure is never interpreted as native absence',async()=>{
  const db=database(),m=row(),f=nativeFixture();await db.put('mappings',m);await db.put('nodes',owned(m,root,'root'));const ex=createNativeExecutor(db,{...f.api,async get(){throw new Error('Permission denied');}});await expect(ex.removeOwned(m,new Set([root.key]),true)).rejects.toThrow('Permission denied');expect(await db.all('nodes')).toHaveLength(1);await db.close();
});
test('concurrent child insertion blocks empty-directory deletion and preserves evidence',async()=>{
  const db=database(),m=row(),f=nativeFixture();await db.put('mappings',m);f.nodes.set('root',{id:'root',parentId:'bar',title:root.title});await db.put('nodes',owned(m,root,'root'));const ex=createNativeExecutor(db,{...f.api,async remove(id){f.nodes.set('late',{id:'late',parentId:id,title:'Late personal'});return f.api.remove(id);}});await expect(ex.removeOwned(m,new Set([root.key]))).rejects.toThrow('not empty');expect(f.nodes.has('late')).toBe(true);expect(await db.all('nodes')).toHaveLength(1);await db.close();
});
