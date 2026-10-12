import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { configurePersonalSyncTransport, personalSyncFetch, personalSyncNativeApi } from '../src/personal-sync-fetch.js';
const values = new Map();
const policy = createPersonalSyncPolicyStore({get:async k=>({[k]:values.get(k)}),set:async v=>{for(const [k,x] of Object.entries(v))values.set(k,x);}});
configurePersonalSyncTransport(policy);
const identity = name=>({serverOrigin:'https://known.test',accountId:name,collectionId:'collection'});
test('network adapter aborts an admitted call without making Pause wait for its response', async () => {
  const owner=identity('abort'); await policy.write(owner,'enabled');
  let signal, release; const stalled=new Promise(r=>{release=r;});
  const send=personalSyncFetch(owner,async (_i,init)=>{signal=init.signal;await stalled;return new Response('{}');});
  const response=send('https://known.test/colp/push'); void response.catch(()=>{});
  while(!signal)await new Promise(r=>setTimeout(r,0));
  await policy.write(owner,'paused'); assert.equal(signal.aborted,true);
  release(); await assert.rejects(response,/personal_sync_stopped/);
});
test('a fetch created before Pause cannot revive when the user quickly resumes', async () => {
  const owner=identity('old'); await policy.write(owner,'enabled');
  let calls=0;const old=personalSyncFetch(owner,async()=>{calls++;return new Response('{}');});
  await policy.write(owner,'paused');await policy.write(owner,'enabled');
  await assert.rejects(old('https://known.test/colp/push'),/personal_sync_stopped/);assert.equal(calls,0);
});
test('wrapped advanced native mutations cannot run while paused or after resume under an old lease', async () => {
  const owner=identity('native');await policy.write(owner,'enabled');let calls=0;
  const api=await personalSyncNativeApi(owner,{create:async()=>{calls++;return {id:'1'};}});
  assert.deepEqual(await api.create(),{id:'1'});await policy.write(owner,'paused');await policy.write(owner,'enabled');
  await assert.rejects(api.create(),/personal_sync_stopped/);assert.equal(calls,1);
});
test('one account pause never stops an explicitly independent subscription port', async () => {
  const owner=identity('subscription');await policy.write(owner,'paused');let calls=0;
  const subscriptionFetch=async()=>{calls++;return new Response('{}');};
  assert.equal((await subscriptionFetch()).ok,true);assert.equal(calls,1);
});
test('Pause during a second admission gate prevents the underlying fetch', async () => {
  const owner = identity('nested-gate'); await policy.write(owner, 'enabled');
  let enter, release, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const send = personalSyncFetch(owner, async () => { calls++; return new Response('{}'); }, async publish => {
    enter(); await blocked; return publish();
  });
  const request = send('https://known.test/api/v1/annotations');
  const refused = assert.rejects(request, /personal_sync_stopped/);
  await entered; await policy.write(owner, 'paused'); release(); await refused;
  assert.equal(calls, 0);
});
