import { readBoundedJson } from '../json-response.js';
import { assertCredentialHostPermission } from '../server-origin-permission.js';
export class SubscriptionError extends Error {
  constructor(readonly code:string, readonly status=0, readonly retryAfter=0){super(code);this.name='SubscriptionError';}
}
export interface ProductResult<T> { data:T; status:number; etag:string|null }
export function createSubscriptionProductClient(options:{serverOrigin:string;accountId:string;assertCurrent:()=>Promise<void>;fetch?:typeof fetch;wait?:(ms:number)=>Promise<void>}){
  const origin=new URL(options.serverOrigin);
  if(origin.origin!==options.serverOrigin||origin.username||origin.password||!(origin.protocol==='https:'||origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error('invalid_origin');
  const fetcher=options.fetch??fetch;
  const wait=options.wait??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  async function waitForQuota(delay:number){
    // Keep the worker and authority fence active without holding a fetch open.
    while(delay>0){
      await options.assertCurrent();
      const slice=Math.min(delay,10000);
      await wait(slice);
      await options.assertCurrent();
      delay-=slice;
    }
  }
  async function raw(path:string,init:RequestInit={}){ await options.assertCurrent();const url=origin.origin+path;const request:RequestInit={...init,credentials:'include',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)};await assertCredentialHostPermission(url,request);const response=await fetcher(url,request);await options.assertCurrent();return response; }
  async function identity(){
    const session=await readBoundedJson(await raw('/api/v1/session'),65536,'response_invalid') as {authenticated?:boolean;csrfToken?:string};
    const auth=await readBoundedJson(await raw('/api/v1/auth/get-session'),65536,'response_invalid') as {user?:{id?:string};session?:{id?:string}};
    if(session.authenticated!==true||typeof session.csrfToken!=='string'||!session.csrfToken||session.csrfToken.length>1024||auth.user?.id!==options.accountId||!auth.session?.id||auth.session.id.length>256)throw new SubscriptionError('sign_in_required',401);
    return {sessionId:auth.session.id,csrfToken:session.csrfToken};
  }
  async function request<T>(path:string,optionsIn:{method?:'GET'|'POST'|'PATCH';body?:unknown;commandId?:string;ifMatch?:string;ifNoneMatch?:string;nodeAccess?:boolean;maxBytes?:number}={}):Promise<ProductResult<T>>{
    if(!path.startsWith('/me/bookmark-subscription')||path.includes('#'))throw new Error('invalid_path');
    const method=optionsIn.method??'GET';
    if(method==='GET'&&optionsIn.body!==undefined)throw new Error('invalid_request');
    if(optionsIn.nodeAccess&&optionsIn.commandId)throw new Error('invalid_request');
    const body=optionsIn.body===undefined?undefined:JSON.stringify(optionsIn.body);
    if(body&&new TextEncoder().encode(body).length>(optionsIn.nodeAccess?65536:4096))throw new Error('payload_too_large');
    let csrfRetried=false,quotaRetries=0;
    for(;;){
      const auth=await identity();
      const headers:Record<string,string>={Accept:'application/json'};
      if(method!=='GET'){headers['Content-Type']='application/json';headers['X-CSRF-Token']=auth.csrfToken;if(!optionsIn.nodeAccess){if(!UUID.test(optionsIn.commandId??''))throw new Error('command_id_required');headers['Known-Command-Id']=optionsIn.commandId!;}}
      if(optionsIn.ifMatch)headers['If-Match']=optionsIn.ifMatch;
      if(optionsIn.ifNoneMatch)headers['If-None-Match']=optionsIn.ifNoneMatch;
      const response=await raw('/api/v1'+path,{method,headers,...(body===undefined?{}:{body})});
      // The session header is checked before parsing any body or honoring 304/receipts.
      if(response.headers.get('Known-Subscription-Session')!==auth.sessionId)throw new SubscriptionError('sign_in_required',401);
      if(response.status===304){if(method!=='GET'||!optionsIn.ifNoneMatch)throw new SubscriptionError('response_invalid',304);return {data:undefined as T,status:304,etag:response.headers.get('etag')};}
      const data=await readBoundedJson(response,optionsIn.maxBytes??262144,'response_invalid');await options.assertCurrent();
      if(response.ok)return {data:data as T,status:response.status,etag:response.headers.get('etag')};
      const error=(data as {error?:{code?:string}})?.error;
      if(!csrfRetried&&response.status===403&&error?.code==='csrf_failed'){
        csrfRetried=true;
        continue;
      }
      const retry=response.headers.get('Retry-After');
      const parsed=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):0;
      const delay=Number.isFinite(parsed)?Math.max(0,parsed):0;
      // Retry the current batch, retaining its body/command id, instead of restarting a full scan.
      if(response.status===429&&error?.code==='rate_limited'&&delay>0&&delay<=60000&&quotaRetries<2){
        quotaRetries++;
        await waitForQuota(delay);
        continue;
      }
      throw new SubscriptionError(error?.code??'subscription_unavailable',response.status,delay);
    }
  }
  return {request};
}
export type ProductClient=ReturnType<typeof createSubscriptionProductClient>;
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function query(fields:Record<string,string|number|undefined>):string{const params=new URLSearchParams();for(const [key,value] of Object.entries(fields))if(value!==undefined)params.set(key,String(value));return params.size?'?'+params.toString():'';}
