import {beforeEach,expect,test,vi} from 'vitest';
import {localClassificationCredential,localClassificationRequested,LOCAL_CLASSIFICATION_KEY,LOCAL_CLASSIFICATION_ENABLED,LOCAL_CLASSIFICATION_PROJECTION,LOCAL_CLASSIFICATION_GRANTED_ORIGIN,releaseStaleClassificationOrigin,type LocalClassificationCredential} from '../src/classification-local-session.js';
import {classificationEndpointAllowed} from '../src/classification-local-presets.js';
import {readLocalClassificationProjection} from '../src/classification-local-projection.js';
import {previewLocalClassification} from '../src/classification-local-preview.js';
import {connectionFailureCopy,probeClassificationConnection} from '../src/classification-local-options.js';
import {scopeKey} from '../src/sync-state/scope-key.js';
import type {SyncScope,createSyncStateStore} from '../src/sync-state-store.js';

const scope:SyncScope={environment:'production',serverId:'server',serverOrigin:'https://known.example',accountId:'account',browserProfileId:'browser',collectionId:'collection',replicaId:'replica',generation:1};
const localValues:Record<string,unknown>={},sessionValues:Record<string,unknown>={},syncValues:Record<string,unknown>={};
const storage=(values:Record<string,unknown>)=>({get:async(key:string)=>({[key]:values[key]}),set:async(value:Record<string,unknown>)=>Object.assign(values,value),
  remove:async(keys:string|string[])=>{for(const key of typeof keys==='string'?[keys]:keys)delete values[key];},setAccessLevel:vi.fn(async()=>{})});
const credential:LocalClassificationCredential={
  version:3,generation:'credential-1',presetId:'cloudflare',
  endpoint:`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`,model:'typesafe/jev',
  accountId:'a'.repeat(32),gatewayId:'default',secret:'fixture-secret',disclosed:true,
};
const taxonomy={folders:[],tagUsage:[{tag:'AI',count:1}],title:'Library',summary:null,revision:'revision',collectionId:scope.collectionId};
const projection={scopeKey:scopeKey(scope),authorityGeneration:1,pulledAt:1000,cursor:'cursor',collectionId:scope.collectionId,title:'Library',summary:null,contentRevision:'revision',folders:[],tagUsage:[{tag:'AI',count:1}]};

beforeEach(()=>{
  for(const object of [localValues,sessionValues,syncValues])for(const key of Object.keys(object))delete object[key];
  localValues[LOCAL_CLASSIFICATION_ENABLED]=true;localValues[LOCAL_CLASSIFICATION_KEY]=credential;sessionValues[LOCAL_CLASSIFICATION_PROJECTION]=projection;
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__',true);
  vi.stubGlobal('chrome',{
    storage:{local:storage(localValues),session:storage(sessionValues),sync:storage(syncValues)},
    permissions:{contains:vi.fn(async()=>true),request:vi.fn(async()=>true),remove:vi.fn(async()=>true)},
  });
});

test.each([429,529])('HTTP %s retries recheck pause, key and destination authority before sending',async status=>{
  for(const reason of ['sourceAutomationPaused','local_authority_changed','destination_policy_changed']){
    let authorized=true,calls=0;
    const result=previewLocalClassification({credential,taxonomy,commandId:`retry-${status}-${reason}`,
      document:{source:'extension',bookmark:{title:'AI',url:'https://example.org/',description:null},requested:{folder:false,tags:true}},
      signal:new AbortController().signal,assertCurrent:async()=>{if(!authorized)throw new Error(reason);},
      transport:async()=>{calls++;authorized=false;return new Response('{}',{status,headers:{'retry-after':'0'}});}});
    await expect(result).rejects.toThrow(reason);
    expect(calls).toBe(1);
  }
});

test('a still-authorized rate limit retry completes without repeating its durable command',async()=>{
  let calls=0;
  const input={credential,taxonomy,commandId:'authorized-retry',
    document:{source:'extension' as const,bookmark:{title:'AI',url:'https://example.org/',description:null},requested:{folder:false,tags:true as const}},
    signal:new AbortController().signal,assertCurrent:async()=>{},transport:async()=>++calls===1
      ?new Response('{}',{status:429,headers:{'retry-after':'0'}})
      :Response.json({model:'typesafe/jev',answers:{t0:{noul:0.95}}})};
  await expect(previewLocalClassification(input)).resolves.toMatchObject({tags:{candidates:[{tag:'AI'}]}});
  await expect(previewLocalClassification(input)).rejects.toThrow('local_result_unavailable');
  expect(calls).toBe(2);
});

test('stale/incomplete authority and pending local structure block the local provider',async()=>{
  let pending=false;
  const store={getEngineState:async()=>({phase:'sleeping',recoveryFrozen:false,authorityRefreshRequired:false,lastAckedCursor:'cursor',lastPublishedCursor:'cursor'}),
    listBookmarkEventsByStatus:async()=>pending?[{}]:[],listProjectionIntents:async()=>[{state:'terminal'}],listQueue:async()=>[],listImportPlans:async()=>[]} as unknown as ReturnType<typeof createSyncStateStore>;
  expect(await readLocalClassificationProjection(store,scope,1,61000)).toEqual(projection);
  expect(await readLocalClassificationProjection(store,scope,1,61001)).toEqual(projection);
  expect(await readLocalClassificationProjection(store,scope,1,1000+180*86400000)).toEqual(projection);
  pending=true;await expect(readLocalClassificationProjection(store,scope,1,2000)).rejects.toThrow('local_projection_unavailable');
  pending=false;await expect(readLocalClassificationProjection(store,{...scope,collectionId:'other'},1,2000)).rejects.toThrow();
});

test('key loss or deployment disable never silently changes a local preference to server mode',async()=>{
  expect(await localClassificationCredential()).toEqual(credential);
  // Local-first: the key is not tied to an account or collection, so no sync scope is consulted.
  localValues[LOCAL_CLASSIFICATION_KEY]={...credential,scopeKey:undefined,authorityGeneration:undefined};
  expect(await localClassificationCredential()).toMatchObject({generation:credential.generation});
  localValues[LOCAL_CLASSIFICATION_KEY]={...credential,version:2};
  expect(await localClassificationCredential()).toBeNull();
  localValues[LOCAL_CLASSIFICATION_KEY]=credential;
  delete localValues[LOCAL_CLASSIFICATION_KEY];expect(await localClassificationCredential()).toBeNull();expect(await localClassificationRequested()).toBe(true);
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__',false);expect(await localClassificationRequested()).toBe(true);expect(await localClassificationCredential()).toBeNull();
});

test('unknown local result cannot resend the original command and no raw decisions enter storage',async()=>{
  let calls=0;const input={credential,taxonomy,commandId:'once',document:{source:'extension' as const,bookmark:{title:'AI',url:'https://example.org/',description:null},requested:{folder:false,tags:true as const}},
    signal:new AbortController().signal,assertCurrent:async()=>{},transport:async()=>{calls++;throw new Error('upstream response lost');}};
  await expect(previewLocalClassification(input)).rejects.toThrow('outcome_unknown');await expect(previewLocalClassification(input)).rejects.toThrow('local_result_unavailable');expect(calls).toBe(1);
  expect(JSON.stringify(sessionValues)).not.toContain('fixture-secret');expect(JSON.stringify(sessionValues)).not.toMatch(/probabilities|rawResponse/u);
  // The key stays in its own storage.local slot on this browser: nothing reaches sync storage, which follows the profile.
  expect(JSON.stringify({...localValues,[LOCAL_CLASSIFICATION_KEY]:undefined})).not.toContain('fixture-secret');
  expect(Object.keys(syncValues)).toEqual([]);
});

test('the key survives a browser restart and a key left in session storage by an earlier build is migrated',async()=>{
  // A restart clears storage.session only.
  for(const key of Object.keys(sessionValues))delete sessionValues[key];
  expect(await localClassificationCredential()).toEqual(credential);
  delete localValues[LOCAL_CLASSIFICATION_KEY];sessionValues['known.classification.local-session.v1']=credential;
  expect(await localClassificationCredential()).toEqual(credential);
  expect(localValues[LOCAL_CLASSIFICATION_KEY]).toEqual(credential);
  expect(sessionValues['known.classification.local-session.v1']).toBeUndefined();
});

test('credential v3 requires matching origin permission, but a missing grant never deletes the saved key',async()=>{
  (chrome.permissions.contains as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
  expect(await localClassificationCredential()).toBeNull();
  expect(localValues[LOCAL_CLASSIFICATION_KEY]).toEqual(credential);
  expect(await localClassificationCredential()).toEqual(credential);
});

test('connection test surfaces exact failure reasons for 404, 422, and schema mismatch',async()=>{
  const validAnswers={folder:{choice:'alpha',confidence:0.95,probabilities:{alpha:0.95,beta:0.05}},tag:{noul:0.99}};

  // 1. CF preset success — and it must refuse Unified Billing fallback
  let cfHeaders:Headers|undefined;
  const okTransport:typeof fetch=async(_url,init)=>{cfHeaders=new Headers(init?.headers);return Response.json({model:'typesafe/jev',answers:validAnswers});};
  const cfSuccess=await probeClassificationConnection({
    presetId:'cloudflare',endpoint:'https://api.cloudflare.com/ai/run',model:'typesafe/jev',secret:'tok',gatewayId:'default',transport:okTransport,
  });
  expect(cfSuccess).toEqual({ok:true,model:'typesafe/jev'});
  expect(cfHeaders?.get('cf-aig-no-wholesale')).toBe('true');
  expect(cfHeaders?.get('cf-aig-gateway-id')).toBe('default');

  // 1b. A native-wire preset has no Cloudflare gateway in front of it, so the
  // BYOK-only header would be meaningless and must not be sent.
  let nativeHeaders:Headers|undefined;
  const nativeTransport:typeof fetch=async(_url,init)=>{nativeHeaders=new Headers(init?.headers);return Response.json({model:'jev-latest',answers:validAnswers});};
  const nativeSuccess=await probeClassificationConnection({
    presetId:'typesafe',endpoint:'https://api.typesafe.ai/v1/systemone',model:'jev-latest',secret:'tok',transport:nativeTransport,
  });
  expect(nativeSuccess).toEqual({ok:true,model:'jev-latest'});
  expect(nativeHeaders?.get('cf-aig-no-wholesale')).toBeNull();

  // 2. CF preset 404
  const notFoundTransport:typeof fetch=async()=>new Response('Not Found',{status:404,statusText:'Not Found'});
  const cf404=await probeClassificationConnection({
    presetId:'cloudflare',endpoint:'https://api.cloudflare.com/ai/run',model:'typesafe/jev',secret:'tok',transport:notFoundTransport,
  });
  expect(cf404).toEqual({ok:false,error:'404 Not Found',status:404});

  // 3. CF preset 422
  const unprocTransport:typeof fetch=async()=>new Response('Unprocessable',{status:422,statusText:'Unprocessable Entity'});
  const cf422=await probeClassificationConnection({
    presetId:'cloudflare',endpoint:'https://api.cloudflare.com/ai/run',model:'typesafe/jev',secret:'tok',transport:unprocTransport,
  });
  expect(cf422).toEqual({ok:false,error:'422 Unprocessable Entity',status:422});

  // 4. CF preset schema mismatch
  const badCfTransport:typeof fetch=async()=>Response.json({model:'typesafe/jev',answers:{invalid:true}});
  const cfBad=await probeClassificationConnection({
    presetId:'cloudflare',endpoint:'https://api.cloudflare.com/ai/run',model:'typesafe/jev',secret:'tok',transport:badCfTransport,
  });
  expect(cfBad).toMatchObject({ok:false,error:expect.stringContaining('schema_mismatch')});

  // 5. Custom preset success (bounded Choice/Noul contract)
  const customAnswers={folder:{choice:'alpha',confidence:0.9,probabilities:{alpha:0.9,beta:0.1}},tag:{noul:0.95}};
  const customOkTransport:typeof fetch=async()=>Response.json({model:'custom-classifier-v1',answers:customAnswers});
  const customSuccess=await probeClassificationConnection({
    presetId:'custom',endpoint:'https://custom.example.org/classify',model:'custom-classifier-v1',transport:customOkTransport,
  });
  expect(customSuccess).toEqual({ok:true,model:'custom-classifier-v1'});

  // 5b. Custom preset returning an unbounded answer is refused, not accepted as "close enough"
  for (const partial of [
    {folder:{choice:'alpha'}},
    {folder:{choice:'alpha',confidence:0.9,probabilities:{alpha:0.9,beta:0.4}}},
    {folder:{choice:'gamma',confidence:0.9,probabilities:{alpha:0.9,beta:0.1}},tag:{noul:0.9}},
    {folder:{choice:'alpha',confidence:0.9,probabilities:{alpha:0.9,beta:0.1}}},
  ]) {
    const partialProbe=await probeClassificationConnection({presetId:'custom',endpoint:'https://custom.example.org/classify',model:'custom-classifier-v1',
      transport:async()=>Response.json({model:'custom-classifier-v1',answers:partial})});
    expect(partialProbe).toMatchObject({ok:false,error:expect.stringContaining('bounded Choice/Noul contract')});
  }

  // 6. Custom preset schema mismatch (no folder or tag in answers)
  const customBadTransport:typeof fetch=async()=>Response.json({model:'custom-classifier-v1',answers:{other:123}});
  const customBad=await probeClassificationConnection({
    presetId:'custom',endpoint:'https://custom.example.org/classify',model:'custom-classifier-v1',transport:customBadTransport,
  });
  expect(customBad).toMatchObject({ok:false,error:expect.stringContaining('schema_mismatch')});

  // 7. Custom preset 404
  const custom404=await probeClassificationConnection({
    presetId:'custom',endpoint:'https://custom.example.org/classify',model:'custom-classifier-v1',transport:notFoundTransport,
  });
  expect(custom404).toEqual({ok:false,error:'404 Not Found',status:404});
});

test('custom preset preview classifies successfully with credential v3',async()=>{
  const customCredential:LocalClassificationCredential={
    version:3,generation:'custom-gen-1',presetId:'custom',
    endpoint:'https://custom.example.org/classify',model:'custom-v1',disclosed:true,
  };
  const transport:typeof fetch=async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    // The custom preset speaks the native System One wire: state/questions at the top level.
    expect(request.input).toBeUndefined();
    expect(typeof request.model).toBe('string');
    const answers=Object.fromEntries(Object.entries(request.questions as Record<string,{type:string;criteria:Record<string,string>}>).map(([key,value])=>{
      const options=Object.keys(value.criteria);return [key,value.type==='noul'?{noul:0.95}:{choice:options[0],confidence:0.9,probabilities:Object.fromEntries(options.map((id,index)=>[id,index===0?0.9:0.1]))}];
    }));
    return Response.json({model:'custom-reported-v1',answers,usage:{input_tokens:10,output_tokens:0}});
  };
  const input={
    credential:customCredential,taxonomy,commandId:'custom-cmd-1',
    document:{source:'extension' as const,bookmark:{title:'Tech News',url:'https://example.org/tech',description:'AI update'},requested:{folder:true as const,tags:true as const}},
    signal:new AbortController().signal,assertCurrent:async()=>{},transport,
  };
  const result=await previewLocalClassification(input);
  expect(result.contractVersion).toBe('1.0.0');
  expect(result.collectionId).toBe(scope.collectionId);
  expect(result.provider.model).toBe('custom-v1');
});

test('hosted presets require their session credential and speak the native wire',async()=>{
  const typesafeCredential:LocalClassificationCredential={version:3,generation:'ts-1',
    presetId:'typesafe',endpoint:'https://api.typesafe.ai/v1/systemone',model:'jev-latest',secret:'typesafe-key',disclosed:true};
  localValues[LOCAL_CLASSIFICATION_KEY]=typesafeCredential;
  expect(await localClassificationCredential()).toEqual(typesafeCredential);
  // A hosted preset without its credential is refused instead of sending an anonymous request.
  localValues[LOCAL_CLASSIFICATION_KEY]={...typesafeCredential,secret:undefined};
  expect(await localClassificationCredential()).toBeNull();

  let body:Record<string,any>={};
  const probe=await probeClassificationConnection({presetId:'vercel',endpoint:'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    model:'typesafe-ai/jev',secret:'gateway-key',transport:async(_url,init)=>{
      body=JSON.parse(String(init?.body));
      return Response.json({model:'typesafe-ai/jev',answers:{folder:{choice:'alpha',confidence:0.9,probabilities:{alpha:0.9,beta:0.1}},tag:{noul:0.99}}});
    }});
  expect(body.input).toBeUndefined();
  expect(body.model).toBe('typesafe-ai/jev');
  expect(body.questions.folder.type).toBe('choice');
  expect(probe).toEqual({ok:true,model:'typesafe-ai/jev'});
  expect(JSON.stringify(syncValues)).not.toContain('typesafe-key');
  expect(Object.keys(syncValues)).toEqual([]);
});

test('switching the local endpoint releases the origin permission it replaces',async()=>{
  const removed:string[]=[];
  vi.stubGlobal('chrome',{storage:{local:storage(localValues),session:storage(sessionValues)},permissions:{
    contains:vi.fn(async()=>true),request:vi.fn(async()=>true),
    remove:vi.fn(async(input:{origins?:string[]})=>{removed.push(...(input.origins??[]));return true;}),
  }});
  await releaseStaleClassificationOrigin('https://api.typesafe.ai/*');
  expect(localValues[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]).toBe('https://api.typesafe.ai/*');
  await releaseStaleClassificationOrigin('https://ai-gateway.vercel.sh/*');
  expect(removed).toContain('https://api.typesafe.ai/*');
  await releaseStaleClassificationOrigin('');
  expect(removed).toContain('https://ai-gateway.vercel.sh/*');
  expect(localValues[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]).toBeUndefined();
});

test('a host grant that could not be released stays tracked for a later retry',async()=>{
  localValues[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]='https://api.typesafe.ai/*';
  vi.stubGlobal('chrome',{storage:{local:storage(localValues),session:storage(sessionValues)},permissions:{
    // Removal keeps failing and the origin is still granted: the record must survive.
    contains:vi.fn(async()=>true),request:vi.fn(async()=>true),
    remove:vi.fn(async()=>{throw new Error('permission store unavailable');}),
  }});
  await releaseStaleClassificationOrigin('https://ai-gateway.vercel.sh/*');
  expect(localValues[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]).toBe('https://api.typesafe.ai/*');
  // Once the removal succeeds the tracked value advances to the active origin.
  vi.stubGlobal('chrome',{storage:{local:storage(localValues),session:storage(sessionValues)},permissions:{
    contains:vi.fn(async()=>true),request:vi.fn(async()=>true),remove:vi.fn(async()=>true),
  }});
  await releaseStaleClassificationOrigin('https://ai-gateway.vercel.sh/*');
  expect(localValues[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]).toBe('https://ai-gateway.vercel.sh/*');
});

test('endpoint policy allows local plain HTTP but never public HTTP',async()=>{
  expect(classificationEndpointAllowed('https://api.typesafe.ai/v1/systemone')).toBe(true);
  for(const local of ['http://127.0.0.1:8080/v1/systemone','http://localhost:11434/v1/systemone','http://10.0.0.5:8000/v1/systemone','http://192.168.1.20:1234/v1/systemone','http://172.16.4.4:8080/v1/systemone','http://169.254.10.20/v1/systemone']) {
    expect(classificationEndpointAllowed(local)).toBe(true);
  }
  for(const rejected of ['http://classifier.example.org/v1/systemone','http://172.32.0.1:8080/v1/systemone','ftp://127.0.0.1/v1/systemone','https://user:pass@127.0.0.1/v1/systemone']) {
    expect(classificationEndpointAllowed(rejected)).toBe(false);
  }

  // A local endpoint survives session validation; a public HTTP one is refused.
  const localCredential:LocalClassificationCredential={version:3,generation:'local-http-1',
    presetId:'custom',endpoint:'http://127.0.0.1:8080/v1/systemone',model:'local-model',disclosed:true};
  localValues[LOCAL_CLASSIFICATION_KEY]=localCredential;
  expect(await localClassificationCredential()).toEqual(localCredential);
  localValues[LOCAL_CLASSIFICATION_KEY]={...localCredential,endpoint:'http://classifier.example.org/v1/systemone'};
  expect(await localClassificationCredential()).toBeNull();

  const probe=await probeClassificationConnection({presetId:'custom',endpoint:'http://classifier.example.org/v1/systemone',model:'local-model',
    transport:async()=>Response.json({model:'local-model',answers:{folder:{choice:'alpha'}}})});
  expect(probe).toMatchObject({ok:false,error:expect.stringContaining('HTTPS')});
});

test('a Cloudflare preset with another model is not pinned to the default version',async()=>{
  const credentialOverride:LocalClassificationCredential={...credential,generation:'cf-custom-model',model:'typesafe/jev-next'};
  const transport:typeof fetch=async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    expect(request.model).toBe('typesafe/jev-next');
    const answers=Object.fromEntries(Object.entries(request.input.questions as Record<string,{type:string;criteria:Record<string,string>}>).map(([key,value])=>{
      const options=Object.keys(value.criteria);return [key,value.type==='noul'?{noul:0.95}:{choice:options[0],confidence:0.9,probabilities:Object.fromEntries(options.map((id,index)=>[id,index===0?0.9:0.1]))}];
    }));
    // The upstream reports its own version; a pinned default would fail this as contract_drift.
    return Response.json({model:'jev-1.14.0',answers,usage:{input_tokens:10,output_tokens:0}});
  };
  const input={credential:credentialOverride,taxonomy,commandId:'cf-custom-model-cmd',
    document:{source:'extension' as const,bookmark:{title:'Tech News',url:'https://example.org/tech',description:'AI update'},requested:{folder:true as const,tags:false as const}},
    signal:new AbortController().signal,assertCurrent:async()=>{},transport};
  const result=await previewLocalClassification(input);
  expect(result.provider.model).toBe('typesafe/jev-next');
});

test('a failed connection test explains itself in a sentence and never shows the raw reason',()=>{
  const sentence=(error:string,status?:number)=>connectionFailureCopy({ok:false,error,...(status===undefined?{}:{status})});
  expect(sentence('HTTP 401 Unauthorized',401)).toMatch(/did not accept the key/);
  expect(sentence('404 Not Found',404)).toMatch(/endpoint was not found/);
  expect(sentence('422 Unprocessable Entity',422)).toMatch(/did not accept the model/);
  expect(sentence('schema_mismatch: missing answers')).toMatch(/unexpected format/);
  for(const [error,status] of [['HTTP 502 Bad Gateway',502],['Failed to fetch',undefined],['schema_mismatch: invalid JSON',undefined]] as const){
    expect(sentence(error,status)).not.toMatch(/HTTP|502|Failed to fetch|schema_mismatch|\$1/);
  }
});

test('pause after reserving but before dispatch releases only the unspent command', async () => {
  let checks=0,calls=0;
  const input={credential,taxonomy,commandId:'paused-before-send',document:{source:'extension' as const,bookmark:{title:'AI',url:'https://example.org/',description:null},requested:{folder:false,tags:true as const}},
    signal:new AbortController().signal,assertCurrent:async()=>{if(++checks===2)throw new Error('sourceAutomationPaused');},transport:async()=>{calls++;throw new Error('lost reply');}};
  await expect(previewLocalClassification(input)).rejects.toThrow('sourceAutomationPausedBeforeDispatch');
  expect(calls).toBe(0);
  await expect(previewLocalClassification({...input,assertCurrent:async()=>{}})).rejects.toThrow('outcome_unknown');
  expect(calls).toBe(1);
  await expect(previewLocalClassification({...input,assertCurrent:async()=>{}})).rejects.toThrow('local_result_unavailable');
});
