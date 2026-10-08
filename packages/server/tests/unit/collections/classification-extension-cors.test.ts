import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { classificationProductAllowedOrigins, installClassificationExtensionCors } from '../../../src/transport/classification-extension-cors.js';
const origin=`chrome-extension://${'a'.repeat(32)}`;
const config={allowedOrigins:['https://known.test'],betterAuth:{enabled:true,trustedOrigins:[origin,'https://known.test']}};
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
test('only exact configured Extension origins receive classification and bootstrap CORS',async()=>{
  const app=Fastify();apps.push(app);installClassificationExtensionCors(app,config);
  for(const path of ['/api/v1/collections/library/editor','/api/v1/session','/api/v1/collections/library/classification-settings','/api/v1/collections/library/classification/preview','/api/v1/collections/library/nodes/bookmark/classification-confirmations']){
    const result=await app.inject({method:'OPTIONS',url:path,headers:{origin,'access-control-request-method':'POST'}});
    expect(result.statusCode).toBe(204);expect(result.headers['access-control-allow-origin']).toBe(origin);
    expect(result.headers['access-control-allow-credentials']).toBe('true');
    expect(String(result.headers['access-control-allow-headers'])).not.toMatch(/Authorization|Cookie/);
  }
  for(const path of ['/api/v1/me','/api/v1/collections/library/nodes/bookmark','/api/v1/admin','/api/v1/collections/library/classification/preview/extra']){
    expect((await app.inject({method:'OPTIONS',url:path,headers:{origin}})).headers['access-control-allow-origin']).toBeUndefined();
  }
  expect((await app.inject({method:'OPTIONS',url:'/api/v1/session',headers:{origin:`chrome-extension://${'b'.repeat(32)}`}})).headers['access-control-allow-origin']).toBeUndefined();
  expect((await app.inject({method:'OPTIONS',url:'/api/v1/session',headers:{origin}})).headers['access-control-allow-methods']).toBe('GET, OPTIONS');
});
test('classification mutation allowlist does not modify global Product origins and requires enabled BA',()=>{
  expect(classificationProductAllowedOrigins(config)).toEqual(['https://known.test',origin]);
  expect(config.allowedOrigins).toEqual(['https://known.test']);
  expect(classificationProductAllowedOrigins({...config,betterAuth:{...config.betterAuth,enabled:false}})).toEqual(['https://known.test']);
});

test('annotation CORS grants exact paths/methods and exposes only the bound session header', async () => {
  const app = Fastify(); apps.push(app); installClassificationExtensionCors(app, config);
  for (const [path, methods] of [['/api/v1/collections/c/annotations', 'GET, POST, OPTIONS'],
    ['/api/v1/collections/c/annotations/a', 'GET, PATCH, DELETE, OPTIONS']]) {
    const response = await app.inject({ method: 'OPTIONS', url: path, headers: { origin } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toBe(methods);
    expect(response.headers['access-control-allow-headers']).toContain('Known-Annotation-Session');
    expect(response.headers['access-control-expose-headers']).toContain('Known-Annotation-Session');
  }
  for (const path of ['/api/v1/collections/c/annotations/a/extra', '/api/v1/collections/c/nodes/n']) {
    expect((await app.inject({ method: 'OPTIONS', url: path, headers: { origin } })).headers['access-control-allow-origin']).toBeUndefined();
  }
});
