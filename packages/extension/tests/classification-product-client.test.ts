import { expect, test, vi } from 'vitest';
import { createClassificationProductClient } from '../src/classification-product-client.js';
import { validClassificationRequest } from '../src/classification-messages.js';
const document={source:'extension' as const,bookmark:{title:'Test',url:'https://example.org',description:null},requested:{folder:false,tags:true as const}};
const command='12345678-1234-4123-8123-123456789abc';
test('capture editor reads reject a cookie session change between bootstrap and data read', async () => {
  const client = createClassificationProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'auth-user',
    assertCurrent: async () => undefined,
    fetch: async url => String(url).endsWith('/api/v1/session') ? Response.json({ authenticated: true, csrfToken: 'csrf' })
      : String(url).endsWith('/auth/get-session') ? Response.json({ user: { id: 'auth-user' }, session: { id: 'original' } })
        : Response.json({ nodes: [] }, { headers: { 'Known-Editor-Session': 'other-session' } }),
  });
  await expect(client.editorPage('library')).rejects.toMatchObject({ code: 'reconnect_required' });
});
function fixture(options:{csrfFailure?:boolean;unknown?:boolean;malformed?:boolean;user?:string}={}){
  const calls:{url:string;init:RequestInit}[]=[];let mutations=0,bootstraps=0;
  const fetcher:typeof fetch=async(url,init={})=>{
    calls.push({url:String(url),init});
    if(String(url).endsWith('/api/v1/session'))return Response.json({authenticated:true,csrfToken:`csrf-${++bootstraps}`});
    if(String(url).endsWith('/auth/get-session'))return Response.json({user:{id:options.user??'auth-user'}});
    mutations++;
    if(options.csrfFailure&&mutations===1)return Response.json({error:{code:'csrf_failed',sameRequestRetrySafe:false}},{status:403});
    if(options.malformed)return new Response('truncated',{status:200});
    if(options.unknown)return Response.json({error:{code:'feature_temporarily_unavailable',sameRequestRetrySafe:false}},{status:503});
    return Response.json({folder:null,tags:{mode:'off',candidates:[]}});
  };
  return {calls,client:createClassificationProductClient({serverOrigin:'https://known.example',expectedAuthUserId:'auth-user',assertCurrent:async()=>{},fetch:fetcher})};
}
test('bootstrap and preview use browser credentials without Cookie, Authorization or secret fallback',async()=>{
  const {client,calls}=fixture();await client.preview('library',document,command);
  expect(calls).toHaveLength(3);
  for(const call of calls){expect(call.init.credentials).toBe('include');expect(call.init.redirect).toBe('error');
    const headers=new Headers(call.init.headers);expect(headers.has('cookie')).toBe(false);expect(headers.has('authorization')).toBe(false);}
  expect(new Headers(calls[2]!.init.headers).get('x-csrf-token')).toBe('csrf-1');
});
test('verified CSRF rejection refreshes once and preserves the exact paid intent',async()=>{
  const {client,calls}=fixture({csrfFailure:true});await client.preview('library',document,command);
  const sent=calls.filter(call=>call.init.method==='POST');expect(sent).toHaveLength(2);expect(sent[0]!.init.body).toBe(sent[1]!.init.body);
  expect(new Headers(sent[1]!.init.headers).get('known-command-id')).toBe(command);
  expect(new Headers(sent[1]!.init.headers).get('x-csrf-token')).toBe('csrf-2');
});
test('ambiguous provider outcomes are not resent; mismatched browser accounts require reconnect',async()=>{
  const unknown=fixture({unknown:true});await expect(unknown.client.preview('library',document,command)).rejects.toMatchObject({status:503,sameRequestRetrySafe:false});
  expect(unknown.calls.filter(call=>call.init.method==='POST')).toHaveLength(1);
  const malformed=fixture({malformed:true});await expect(malformed.client.preview('library',document,command)).rejects.toMatchObject({code:'classification_response_invalid',sameRequestRetrySafe:true});
  expect(malformed.calls.filter(call=>call.init.method==='POST')).toHaveLength(1);
  const other=fixture({user:'other-account'});await expect(other.client.preview('library',document,command)).rejects.toMatchObject({code:'reconnect_required'});
  expect(other.calls).toHaveLength(2);
});
test('authority revocation and malformed origins fail before network; trusted messages remain closed',async()=>{
  const fetch=vi.fn();const client=createClassificationProductClient({serverOrigin:'https://known.example',expectedAuthUserId:'auth-user',fetch,
    assertCurrent:async()=>{throw new Error('authority_fenced');}});
  await expect(client.session()).rejects.toThrow('authority_fenced');expect(fetch).not.toHaveBeenCalled();
  expect(()=>createClassificationProductClient({serverOrigin:'https://known.example/path',expectedAuthUserId:'x',fetch,assertCurrent:async()=>{}})).toThrow();
  const valid={kind:'known.classification.preview',collectionId:'library',commandId:command,userGesture:true,document};
  expect(validClassificationRequest(valid)).toBe(true);
  for(const value of [{...valid,userGesture:false},{...valid,authorization:'bearer'}, {...valid,document:{...document,taxonomy:[]}},
    {...valid,document:{...document,bookmark:{...document.bookmark,tags:['AI']}}},
    {...valid,document:{...document,bookmark:{...document.bookmark,url:'chrome://settings'}}},
    {...valid,document:{...document,bookmark:{...document.bookmark,url:'https://user:pass@example.org'}}},
    {...valid,document:{...document,bookmark:{...document.bookmark,title:'中'.repeat(342)}}}])expect(validClassificationRequest(value)).toBe(false);
});

test('settings read the server_managed JSON projection, never the BYOK-gated v2 media type',async()=>{
  // KNOWN_FEATURE_CLASSIFICATION_BYOK=false is the shipped default and the v2
  // media type answers 404 there (plan D4), so an Accept override would turn
  // every server-managed classification into `classification_unavailable`.
  const {client,calls}=fixture();
  await client.settings('library');
  const read=calls.find(call=>call.url.endsWith('/api/v1/collections/library/classification-settings'))!;
  expect(read).toBeDefined();
  expect(read.init.method??'GET').toBe('GET');
  expect(new Headers(read.init.headers).get('accept')).toBeNull();
  expect(read.init.credentials).toBe('include');
});

test('capture-capabilities returns unsupported when the route is 404', async () => {
  const client = createClassificationProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'auth-user', cloudEnabled: true,
    assertCurrent: async () => {},
    fetch: async (url) => {
      const href = String(url);
      if (href.endsWith('/api/v1/session')) return Response.json({ authenticated: true, csrfToken: 'csrf' });
      if (href.endsWith('/auth/get-session')) return Response.json({ user: { id: 'auth-user' }, session: { id: 'session' } });
      return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    } });
  await expect(client.captureCapabilities()).resolves.toBe('unsupported');
});

test('capture-capabilities returns unsupported when manifest features.cloud is false', async () => {
  const urls: string[] = [];
  const client = createClassificationProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'auth-user',
    assertCurrent: async () => {},
    fetch: async (url) => {
      urls.push(String(url));
      return Response.json({ mounts: [{ features: { cloud: false } }] });
    } });
  await expect(client.captureCapabilities()).resolves.toBe('unsupported');
  expect(urls).toEqual(['https://known.example/.well-known/collection-protocol']);
});

test('capture-capabilities returns unsupported when cloud automation is off', async () => {
  const client = createClassificationProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'auth-user', cloudEnabled: true,
    assertCurrent: async () => {},
    fetch: async (url) => {
      const href = String(url);
      if (href.endsWith('/api/v1/session')) return Response.json({ authenticated: true, csrfToken: 'csrf' });
      if (href.endsWith('/auth/get-session')) return Response.json({ user: { id: 'auth-user' }, session: { id: 'session' } });
      return Response.json({ policyVersion: 'capture-folder.v1', automaticFolderAvailable: false, automaticTagsAvailable: false });
    } });
  await expect(client.captureCapabilities()).resolves.toBe('unsupported');
});

test('pause during bootstrap fences the POST immediately before dispatch', async () => {
  let paused = false; const post = vi.fn();
  const client = createClassificationProductClient({ serverOrigin: 'https://known.example', expectedAuthUserId: 'auth-user',
    assertCurrent: async () => {}, assertMutation: async () => { if (paused) throw new Error('capture_dispatch_fenced'); },
    fetch: async (url, init) => {
      if (String(url).endsWith('/api/v1/session')) return Response.json({ authenticated: true, csrfToken: 'csrf' });
      if (String(url).endsWith('/auth/get-session')) { paused = true; return Response.json({ user: { id: 'auth-user' } }); }
      post(init); return Response.json({});
    } });
  await expect(client.preview('library', document, command)).rejects.toThrow('capture_dispatch_fenced'); expect(post).not.toHaveBeenCalled();
});
