import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, test, expect } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { DEFAULT_CLASSIFICATION_SETTINGS, classificationSettingsEtag, parseClassificationSettingsPatch, CLASSIFICATION_SETTINGS_V2_MEDIA, type ClassificationSettings, type ClassificationSettingsStore } from '../../../src/modules/collections/application/classification-settings.js';
import { registerClassificationSettingsRoutes } from '../../../src/transport/product/classification-settings-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { createMemoryProductCommandReceiptPort } from '../../support/product-http-harness.js';
import { createProductClassificationClient } from '../../../generated/openapi/product-v1.client.js';
import { loadClassificationConfig } from '../../../src/bootstrap/config-classification.js';

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const now = new Date();
const identity = {sessions: {findByTokenHash: async () => ({id:'s',accountId:'account',csrfTokenHash:'csrf-hash',securityEpoch:1n,createdAt:now,lastSeenAt:now,idleExpiresAt:new Date(now.getTime()+60000),absoluteExpiresAt:new Date(now.getTime()+60000),revokedAt:null}),touch:async()=>true},
  accounts:{findById:async()=>({id:'account',subjectId:'owner',status:'active',securityEpoch:1n,createdAt:now,deletedAt:null})}, clock:{now:async()=>now}} as unknown as IdentityPorts;
const identityUnitOfWork: IdentityUnitOfWork = {execute: work => work(identity)};
const path = '/api/v1/collections/library/classification-settings';
const auth = {cookie:'__Host-known_session=test'};
const headers = (etag = '"classification-settings:library:0"') => ({...auth, origin:'https://app.example.test', 'x-csrf-token':'csrf', 'known-command-id':randomUUID(), 'if-match':etag});
function setup(enabled = true, maxRequests = 100, byokEnabled = false, overrides: Partial<ClassificationSettings> = {}) {
  const server = Fastify({exposeHeadRoutes:false,routerOptions:{querystringParser:parseStrictQuery}}); servers.push(server);
  installProductRouteManifestChecks(server,{requireComplete:false}); installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => sendProductError(request,reply,error instanceof ProductHttpError ? error : new ProductHttpError({statusCode:500,code:'internal_error',message:'test failure'})));
  let current: ClassificationSettings = {contractVersion:'1.0.0',collectionId:'library',revision:'0',updatedAt:now.toISOString(),...DEFAULT_CLASSIFICATION_SETTINGS,...overrides};
  const store: ClassificationSettingsStore = {loadOwned: async input => input.collectionId === 'library' && input.ownerSubjectId === 'owner' ? current : null,
    compareAndSet: async input => {if (input.current.revision !== current.revision) return null; current = {...current,...input.values,revision:String(Number(current.revision)+1)}; return current;}};
  const receipts = createMemoryProductCommandReceiptPort(new Map());
  registerClassificationSettingsRoutes(server,{enabled,byokEnabled,allowedOrigins:['https://app.example.test'],identityUnitOfWork,reads:store,
    commands:{execute:work=>work({settings:store,receipts})},csrfMatches:raw=>raw==='csrf',rateLimiter:createFixedWindowRateLimiter({maxRequests,windowMs:60000})});
  return server;
}
test('M1 closed settings policy rejects auto/BYOK/local and invalid limits', () => {
  for (const patch of [{},{autoTagMode:'auto'},{executionMode:'server_byok'},{executionMode:'extension_local'},{providerProfileId:'profile'},{maxAutoTags:4},{maxAutoTags:1.5},{threshold:0.8}]) expect(()=>parseClassificationSettingsPatch(patch)).toThrow('invalid_document');
  expect(loadClassificationConfig({})).toEqual({managedAdmissionEnabled:true,creditEnabled:false,enabled:false,tagsEnabled:false,batchEnabled:false,autoTagsEnabled:false,byokEnabled:false,priorEnabled:false,provider:null,secretKeys:[],fingerprintKey:null});
  expect(loadClassificationConfig({KNOWN_FEATURE_CLASSIFICATION_CREDITS:'true'})).toMatchObject({creditEnabled:true,enabled:false,batchEnabled:false});
  expect(loadClassificationConfig({KNOWN_FEATURE_CLASSIFICATION_MANAGED_ADMISSION:'false'})).toMatchObject({managedAdmissionEnabled:false});
  expect(()=>loadClassificationConfig({KNOWN_FEATURE_CLASSIFICATION_CREDITS:'yes'})).toThrow();
  expect(()=>loadClassificationConfig({KNOWN_FEATURE_CLASSIFICATION_MANAGED_ADMISSION:'yes'})).toThrow();
  expect(()=>loadClassificationConfig({KNOWN_FEATURE_CLASSIFICATION:'yes'})).toThrow();
});
test('authentication precedes feature-off 404; GET is private with stable virtual ETag', async () => {
  const disabled = setup(false);
  expect((await disabled.inject({method:'GET',url:path})).statusCode).toBe(401);
  expect((await disabled.inject({method:'GET',url:path,headers:auth})).statusCode).toBe(404);
  const response = await setup().inject({method:'GET',url:path,headers:auth});
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.etag).toBe('"classification-settings:library:0"'); expect(response.json().autoTagMode).toBe('suggest');
});
test('PATCH requires CSRF/Origin/If-Match and accepts only documented fields', async () => {
  const server = setup();
  const valid = headers();
  for (const etag of ['*','W/"x"','"a", "b"']) expect((await server.inject({method:'PATCH',url:path,headers:{...valid,'known-command-id':randomUUID(),'if-match':etag},payload:{autoTagMode:'suggest'}})).statusCode).toBe(400);
  const { 'if-match': _, ...missing } = headers();
  expect((await server.inject({method:'PATCH',url:path,headers:missing,payload:{autoTagMode:'suggest'}})).statusCode).toBe(428);
  expect((await server.inject({method:'PATCH',url:path,headers:{...headers(),'x-csrf-token':'bad'},payload:{autoTagMode:'suggest'}})).statusCode).toBe(403);
  expect((await server.inject({method:'PATCH',url:path,headers:{...headers(),origin:'https://evil.test'},payload:{autoTagMode:'suggest'}})).statusCode).toBe(403);
  expect((await server.inject({method:'PATCH',url:path,headers:headers(),payload:{autoTagMode:'auto'}})).statusCode).toBe(422);
});
test('generated client updates and exact retry replays original bytes after settings changed', async () => {
  const server = setup();
  const responses: {body: string; contentType: unknown; etag: unknown; cache: unknown}[] = [];
  const transport: typeof fetch = async (url, init) => {
    const response = await server.inject({method:(init?.method ?? 'GET') as 'GET'|'PATCH',url:new URL(String(url)).pathname,headers:Object.fromEntries(new Headers(init?.headers)),payload:init?.body as string|undefined});
    responses.push({body:response.body,contentType:response.headers['content-type'],etag:response.headers.etag,cache:response.headers['cache-control']});
    return new Response(response.body,{status:response.statusCode,headers:new Headers(response.headers as Record<string,string>)});
  };
  const client = createProductClassificationClient({origin:'https://app.example.test',sessionCookie:auth.cookie,csrfToken:'csrf',originHeader:'https://app.example.test',fetch:transport});
  const first = await client.settings('library'); const command = randomUUID();
  const updated = await client.updateSettings('library',{autoTagMode:'suggest'},command,first.etag!);
  await client.updateSettings('library',{maxAutoTags:1},randomUUID(),updated.etag!);
  const replay = await client.updateSettings('library',{autoTagMode:'suggest'},command,first.etag!);
  expect(replay).toEqual(updated);
  expect(responses[3]).toEqual(responses[1]);
  await expect(client.updateSettings('library',{maxAutoTags:0},command,first.etag!)).rejects.toMatchObject({status:409});
  const stale = await server.inject({method:'PATCH',url:path,headers:headers(first.etag!),payload:{autoTagMode:'off'}});
  expect(stale.statusCode).toBe(412);
  expect(classificationSettingsEtag(updated.settings)).toBe(updated.etag);
});
test('rate limiting and COLP/mixed authentication fail closed', async () => {
  const server = setup(true,1);
  expect((await server.inject({method:'GET',url:path,headers:{authorization:'Bearer colp-sync'}})).statusCode).toBe(401);
  expect((await server.inject({method:'GET',url:path,headers:{...auth,authorization:'Bearer colp-sync'}})).statusCode).toBe(400);
  expect((await server.inject({method:'GET',url:path,headers:auth})).statusCode).toBe(200);
  expect((await server.inject({method:'GET',url:path,headers:auth})).statusCode).toBe(429);
});

test('BYOK metadata remains available without keys; malformed configured keys fail closed',()=>{
  expect(loadClassificationConfig({KNOWN_FEATURE_CLASSIFICATION_BYOK:'true'})).toMatchObject({byokEnabled:true,secretKeys:[],fingerprintKey:null});
  expect(()=>loadClassificationConfig({BOOKMARK_CLASSIFICATION_SECRET_KEYS:'private-malformed-key'})).toThrow('Invalid classification secret key configuration');
  const key=Buffer.alloc(32,1).toString('base64'),fingerprint=Buffer.alloc(32,2).toString('base64');
  const config=loadClassificationConfig({KNOWN_FEATURE_CLASSIFICATION_BYOK:'true',BOOKMARK_CLASSIFICATION_SECRET_KEYS:JSON.stringify([{id:'test',version:1,key}]),BOOKMARK_CLASSIFICATION_SECRET_FINGERPRINT_KEY:fingerprint});
  expect(config.byokEnabled).toBe(true);expect(config.secretKeys[0]?.version).toBe(1);
});

test('settings v2 returns 404 when byokEnabled is false, succeeds when byokEnabled is true', async () => {
  const serverOff = setup(true, 100, false);
  expect((await serverOff.inject({method: 'GET', url: path, headers: {...auth, accept: CLASSIFICATION_SETTINGS_V2_MEDIA}})).statusCode).toBe(404);
  expect((await serverOff.inject({method: 'PATCH', url: path, headers: {...headers(), 'content-type': CLASSIFICATION_SETTINGS_V2_MEDIA}, payload: {autoTagMode: 'suggest'}})).statusCode).toBe(404);

  const serverOn = setup(true, 100, true);
  const getRes = await serverOn.inject({method: 'GET', url: path, headers: {...auth, accept: CLASSIFICATION_SETTINGS_V2_MEDIA}});
  expect(getRes.statusCode).toBe(200);
  expect(getRes.headers['content-type']).toContain(CLASSIFICATION_SETTINGS_V2_MEDIA);
  expect(getRes.json().contractVersion).toBe('2.0.0');

  // v1 on serverOff returns 200 with contractVersion 1.0.0, server_managed, and null providerProfileId
  const v1Res = await serverOff.inject({method: 'GET', url: path, headers: auth});
  expect(v1Res.statusCode).toBe(200);
  expect(v1Res.json().contractVersion).toBe('1.0.0');
  expect(v1Res.json().executionMode).toBe('server_managed');
  expect(v1Res.json().providerProfileId).toBeNull();
});

test('settings v1 never projects a persisted server_byok mode or profile binding', async () => {
  // The BYOK gate is off, but a collection may still carry legacy settings rows.
  const byokMode = setup(true, 100, false, {executionMode: 'server_byok'});
  expect((await byokMode.inject({method: 'GET', url: path, headers: auth})).statusCode).toBe(404);
  const profileBound = setup(true, 100, false, {providerProfileId: 'profile-1'});
  expect((await profileBound.inject({method: 'GET', url: path, headers: auth})).statusCode).toBe(404);

  // Even with the gate on, v1 stays server_managed-only; only v2 exposes BYOK.
  const byokModeOn = setup(true, 100, true, {executionMode: 'server_byok'});
  expect((await byokModeOn.inject({method: 'GET', url: path, headers: auth})).statusCode).toBe(404);
  const v2 = await byokModeOn.inject({method: 'GET', url: path, headers: {...auth, accept: CLASSIFICATION_SETTINGS_V2_MEDIA}});
  expect(v2.statusCode).toBe(200);
  expect(v2.json().executionMode).toBe('server_byok');
});
