import { insertTestParentCredential } from './account-credential-db-fixture.js';
import { createPostgresAccountCredentialUnitOfWork } from '../../src/infrastructure/auth/account-credentials-postgres.js';
import { createChildCredential,exchangeAccountKey,loadCredentialAuthority,resolveMachineMcpBinding,revokeCredential } from '../../src/modules/auth/index.js';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { automationFixture } from './automation-fixture.js';
import { loadConfig } from './test-config.js';
import { createAutomationUnitOfWork } from '../../src/infrastructure/automation/index.js';
import { createTargetWorkerService } from '../../src/infrastructure/automation/target-worker.js';
import { createAutomationBindingVerifier } from '../../src/bootstrap/automation-binding-verifier.js';
import { createMcpOauthVerifier,MCP_OAUTH_DEFAULT_SECURITY_EPOCH } from '../../src/modules/mcp/index.js';
import { createPostgresMcpOauthRevocationStore } from '../../src/infrastructure/database/index.js';
import { createMemoryMcpRateLimiter } from '../../src/infrastructure/rate-limit/index.js';
import { AutomationError,type WorkPrincipal } from '../../src/modules/automation/index.js';
import { registerAutomationRoutes } from '../../src/transport/product/automation-rule-routes.js';
import { automationTargetRoutes } from '../../src/transport/product/automation-target-routes.js';
import { registerAutomationWorkRoutes } from '../../src/transport/automation-work-routes.js';
import { installProductAdmission,parseStrictQuery } from '../../src/transport/product-admission.js';
import { ProductHttpError,sendProductError } from '../../src/transport/product-error.js';

export const AUTOMATION_WORKER_ORIGIN = 'https://automation.example.test';
export async function automationWorkerFixture(prefix: string,maxPairRequests = 100,machineMode = false) {
  const f = await automationFixture(prefix),origin = AUTOMATION_WORKER_ORIGIN,issuer = origin+'/api/v1/auth',audience = origin+'/collections/-/mcp';
  const keys = await generateKeyPair('ES256',{ extractable: true }),jwk = { ...await exportJWK(keys.publicKey),kid: 'aw-worker',alg: 'ES256',use: 'sig' };
  const privateJwk = { ...await exportJWK(keys.privateKey),kid: 'aw-worker' };
  const hmac = Buffer.alloc(32,17).toString('base64url');
  const config = loadConfig({ DATABASE_URL: 'postgres://unused/known',PRODUCT_ORIGIN: origin,ALLOWED_ORIGINS: origin,
    OIDC_JWKS_URI: 'https://issuer.example/certs',NODE_ENV: 'test',LOG_LEVEL: 'silent',
    ...(machineMode ? { KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',AUTOMATION_CURSOR_HMAC_KEY: hmac,AUTOMATION_ES256_PRIVATE_JWK: JSON.stringify(privateJwk) } : {}) });
  const credentials = createPostgresAccountCredentialUnitOfWork(f.db,undefined,undefined,{ secretHmacKey: hmac });
  let child: { id: string; secret: string } | undefined;
  if (machineMode) {
    const expiresAt = new Date(Date.now()+86_400_000).toISOString(),parent = await insertTestParentCredential(f.db,f.owner,hmac,expiresAt);
    const issued = await credentials.execute(p => createChildCredential(p,{ managerAccountId: f.owner.accountId,parentId: parent.id,commandId: randomUUID(),actor: 'manager',
      body: { label: 'Dedicated polling worker',expiresAt,account: { mode: 'existing',accountId: f.owner.accountId } } }));
    if (issued.kind !== 'succeeded' || !issued.body.secret) throw new Error('Worker credential issuance failed');
    child = { id: issued.body.credential.id,secret: issued.body.secret };
  }
  const revocations = createPostgresMcpOauthRevocationStore({ db: f.db });
  const verifier = createMcpOauthVerifier({ issuer,audience,allowedScopes: ['automation:work','automation:read','automation:manage','mcp:read:own'],
    jwks: { getKeySet: async () => ({ keys: [jwk] }) },securityEpoch: async () => MCP_OAUTH_DEFAULT_SECURITY_EPOCH,
    isRevoked: input => revocations.isRevoked(input),requireAccountEpoch: true,clockToleranceSeconds: 0,
    ...(machineMode ? { machine: { kids: new Set(['aw-worker']),bind: (input: Parameters<typeof resolveMachineMcpBinding>[0]) => resolveMachineMcpBinding({ ...input,load: id => credentials.execute(p => loadCredentialAuthority(p,id)) }) } } : {}),
    resolveAccountBySubject: async sub => { const a = await f.db.selectFrom('accounts').selectAll().where('subject_id','=',sub).executeTakeFirst();
      return a ? { id: a.id,subjectId: a.subject_id,status: a.status,securityEpoch: String(a.security_epoch) } : null; },
    readAccountSecurityBoundary: async id => { const a = await f.db.selectFrom('accounts').selectAll().where('id','=',id).executeTakeFirst();
      return a ? { status: a.status,securityEpoch: String(a.security_epoch),bumpedAt: a.security_epoch_bumped_at } : null; },
  });
  const mint = async (options: { subjectId?: string; clientId?: string; scopes?: string[] } = {}) => {
    if (machineMode) {
      if (!child || options.subjectId || options.clientId) throw new Error('Machine fixture cannot change its verified identity');
      const issued = await credentials.execute(p => exchangeAccountKey(p,{ body: { grant_type: 'urn:known:params:oauth:grant-type:account-key',credential: child!.secret,audience: 'mcp_strict',scope: (options.scopes ?? ['automation:work']).join(' ') },
        supportedScopes: ['automation:work','automation:read','automation:manage','mcp:read:own'],audienceConfig: { productOrigin: origin,mcpStrictAudience: audience },privateJwk: config.accountCredentials.es256PrivateJwk!,issuer }));
      return issued.access_token;
    }
    const subjectId = options.subjectId ?? f.owner.subjectId,account = await f.db.selectFrom('accounts').select('security_epoch').where('subject_id','=',subjectId).executeTakeFirstOrThrow();
    const now = Math.floor(Date.now()/1000);
    return new SignJWT({ client_id: options.clientId ?? 'poll-worker',scope: (options.scopes ?? ['automation:work']).join(' '),known_account_epoch: String(account.security_epoch) })
      .setProtectedHeader({ alg: 'ES256',kid: 'aw-worker' }).setIssuer(issuer).setSubject(subjectId).setAudience(audience)
      .setJti(randomUUID()).setIssuedAt(now).setNotBefore(now).setExpirationTime(now+300).sign(keys.privateKey);
  };
  const token = await mint(),verified = await verifier.verify({ authorization: 'Bearer '+token,requiredScopes: ['automation:work'] });
  const actor: WorkPrincipal = { accountId: verified.binding.principalId,subjectId: verified.accountSubjectId,clientId: verified.binding.clientId,
    credentialBindingId: verified.binding.credentialBindingId,resourceAudience: verified.binding.resourceAudience,securityEpoch: verified.binding.securityEpoch,
    scopes: verified.scopes,credentialDigest: verified.credentialDigest,expiresAt: verified.expiresAt.toISOString(),issuedAtSeconds: verified.issuedAtSeconds,accountSecurityEpoch: verified.accountSecurityEpoch };
  const limiter = createMemoryMcpRateLimiter({ request: { maxRequests: maxPairRequests,windowMs: 60_000 } });
  const worker = createTargetWorkerService(f.db,createAutomationBindingVerifier(config,async () => MCP_OAUTH_DEFAULT_SECURITY_EPOCH),async a => {
    const result = await limiter.consume({ policy: 'request',facts: JSON.stringify(['automation-pair',a.accountId,a.clientId,a.credentialBindingId]) });
    if (result.kind !== 'allowed') throw new AutomationError(result.kind === 'denied' ? 'rate_limited' : 'feature_temporarily_unavailable','Pairing admission denied.',[],null,result.kind === 'denied' ? result.decision.retryAfterSeconds : 30);
  });
  const uow = createAutomationUnitOfWork(f.db,'server',{ runtimeEnabled: true,verifyTargetBinding: createAutomationBindingVerifier(config,async () => MCP_OAUTH_DEFAULT_SECURITY_EPOCH) });
  const app = Fastify({ exposeHeadRoutes: false,routerOptions: { querystringParser: parseStrictQuery } }); installProductAdmission(app);
  app.setErrorHandler((error,request,reply) => sendProductError(request,reply,error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500,code: 'internal_error',message: String(error) })));
  registerAutomationRoutes(app,{ identityUnitOfWork: f.identity,unitOfWork: uow,allowedOrigins: [origin],cursorKey: 'worker-test-cursor-at-least-32-bytes' },automationTargetRoutes('worker-test-cursor-at-least-32-bytes'));
  registerAutomationWorkRoutes(app,{ pairing: worker,oauthVerifier: verifier,allowedOrigins: [origin] }); await app.ready();
  const ownerHeaders = (commandId = randomUUID(),etag?: string) => ({ cookie: f.owner.cookie,origin,'x-csrf-token': f.owner.csrfToken,'known-command-id': commandId,...(etag ? { 'if-match': etag } : {}) });
  const ownerPost = (path: string,payload: unknown,etag?: string,commandId?: string) => app.inject({ method: 'POST',url: '/api/v1/me/automations'+path,headers: ownerHeaders(commandId,etag),payload });
  const pair = (grant: { pairingId: string; code: string | null },commandId = randomUUID(),bearer = token) => app.inject({ method: 'POST',url: '/api/v1/automation-work/pairings/claim',headers: { authorization: 'Bearer '+bearer,'known-command-id': commandId },payload: { pairingId: grant.pairingId,code: grant.code } });
  async function setup(options: { privacy?: 'standard' | 'restricted'; wakeMode?: 'poll' | 'events' } = {}) {
    const p = await ownerPost('/connection-profiles',{ name: 'Polling worker',automationEnabled: true,authorizedClientId: actor.clientId,credentialBindingId: actor.credentialBindingId,catalogs: ['automationWorker'] });
    if (p.statusCode !== 201) throw new Error(p.body);
    const t = await ownerPost('/targets',{ name: 'Polling target',providerLabel: 'Deterministic injected output',broadcastOptIn: false,privacy: options.privacy ?? 'standard',
      connectionProfileId: p.json().id,wakeMode: options.wakeMode ?? 'poll',pollIntervalMinutes: 1 });
    if (t.statusCode !== 201) throw new Error(t.body);
    const g = await ownerPost(`/targets/${t.json().id}/pairings`,{ reason: 'Owner pairs this exact worker' },String(t.headers.etag));
    if (g.statusCode !== 201) throw new Error(g.body);
    return { profile: p.json(),target: t.json(),grant: g.json(),grantEtag: String(g.headers.etag) };
  }
  return { ...f,config,uow,app,worker,actor,token,mint,verifier,revocations,limiter,ownerHeaders,ownerPost,pair,setup,
    revokeWorker: async () => {
      if (!child) throw new Error('No machine credential');
      return credentials.execute(p => revokeCredential(p,{ managerAccountId: f.owner.accountId,credentialId: child!.id,commandId: randomUUID(),ifMatch: `"${child!.id}:1"`,body: { reason: 'Revoke dedicated test worker' } }));
    },
    close: async () => { await app.close();await limiter.close();await f.isolated.close(); } };
}
