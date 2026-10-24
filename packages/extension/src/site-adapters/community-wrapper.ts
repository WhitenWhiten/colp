/** Generated code runs exclusively through userScripts in one named USER_SCRIPT world. */
export function communityWrapper(input: { id: string; generation: number; credential: string; script: string }) {
  const identity = JSON.stringify({ installationId: input.id, generation: input.generation, credential: input.credential });
  return `(async()=>{ 'use strict';
const identity=${identity}, key='__colpCommunity';
globalThis[key]?.stop?.();
let epoch=0, lease=null, cleanup=null, controller=null, stopped=false;
const send=chrome.runtime.sendMessage.bind(chrome.runtime);
async function bootstrap(){ const r=await send({kind:'known.community.bootstrap',...identity}); if(r?.status!=='ready') throw Error(r?.reason||'communityUnavailable'); lease=r; return r; }
function end(){epoch++;controller?.abort();try{cleanup?.();}catch{}cleanup=null;lease=null;}
async function start(){if(stopped)return;end();const current=epoch;controller=new AbortController();
 try{const r=await bootstrap();if(stopped||epoch!==current)return;
 const api=Object.freeze({mode:r.mode,signal:controller.signal,reportHint:async(hint)=>{
 if(stopped||epoch!==current||controller.signal.aborted)throw Error('communityRevoked');
 if(!lease||lease.expiresAt<=Date.now()+1000)await bootstrap();
 if(stopped||epoch!==current)throw Error('communityRevoked');
 return send({kind:'known.community.hint',installationId:identity.installationId,generation:identity.generation,leaseId:lease.leaseId,capability:lease.capability,requestId:crypto.randomUUID(),hint});}});
 const result=await (async(api)=>{\n${input.script}\n})(api);
 if(epoch===current&&!stopped)cleanup=typeof result==='function'?result:null;else if(typeof result==='function')result();
 }catch{end();}}
const hide=()=>end(), show=()=>void start();
const stop=()=>{stopped=true;end();removeEventListener('pagehide',hide);removeEventListener('pageshow',show);};
globalThis[key]={stop};addEventListener('pagehide',hide);addEventListener('pageshow',show);void start();
})()`;
}
