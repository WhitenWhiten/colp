import Fastify from 'fastify';
import type { JWK } from 'jose';
import type { AppConfig } from '../../src/bootstrap/config.js';
import { createDatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { createTargetWorkerService, createResultSubmissionPort, createProposalPlanGateway, createAutomationWorkerService } from '../../src/infrastructure/automation/index.js';
import { createAutomationBindingVerifier } from '../../src/bootstrap/automation-binding-verifier.js';
import { createPhase4bMcpWriteComposition, createMcpChangePlanRateLimitPort } from '../../src/bootstrap/mcp-write-composition.js';
import { MCP_OAUTH_DEFAULT_SECURITY_EPOCH } from '../../src/modules/mcp/index.js';
import { registerAutomationWorkRoutes } from '../../src/transport/automation-work-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../src/transport/product-error.js';
import { automationWorkerVerifier } from './automation-worker-verifier.js';

if (!process.send) throw new Error('IPC test process required');
process.once('message', async (message: { databaseUrl: string; config: AppConfig; jwk: JWK; origin: string; crash?: 'before' | 'after' }) => {
  const runtime = createDatabaseRuntime(message.databaseUrl,{ maxConnections: 6 });
  const db = runtime.db;
  const { verifier } = automationWorkerVerifier(db,message.jwk,message.origin,true);
  const worker = createTargetWorkerService(db,createAutomationBindingVerifier(message.config,async () => MCP_OAUTH_DEFAULT_SECURITY_EPOCH),async () => {});
  const crashWindow = async (phase: 'before' | 'after') => {
    if (message.crash !== phase) return;
    process.send!({ type: 'crash-window',phase });
    await new Promise<never>(() => { /* parent sends SIGKILL at the exact durable boundary */ });
  };
  let results: ReturnType<typeof createResultSubmissionPort>;
  const composition = createPhase4bMcpWriteComposition({ db,serverUuid: '11111111-1111-4111-8111-111111111111',
    approvalBaseUri: message.origin+'/approvals',requestStateKey: 'aw31-request-state-key-at-least-32-bytes',allowedScopes: ['automation:work'],
    rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 100,windowMs: 60000 }),beforeBeginCommit: async ({ transaction,planId }) => {
      await results.guard(transaction,planId); await crashWindow('before');
    } });
  results = createResultSubmissionPort(db,'server',worker.authorize,createProposalPlanGateway(db,composition.changePlanOptions),{ afterCanonicalCommit: () => crashWindow('after') });
  const work = createAutomationWorkerService(db,'server',worker,results,'worker-test-cursor-at-least-32-bytes',1000);
  const app = Fastify({ exposeHeadRoutes: false,routerOptions: { querystringParser: parseStrictQuery } });
  installProductAdmission(app);
  app.setErrorHandler((error,request,reply) => sendProductError(request,reply,error instanceof ProductHttpError ? error
    : new ProductHttpError({ statusCode: 500,code: 'internal_error',message: 'Test worker server failed.' })));
  registerAutomationWorkRoutes(app,{ pairing: worker,worker: work,oauthVerifier: verifier,allowedOrigins: [message.origin] });
  const stop = async () => { await app.close(); await runtime.close(); process.disconnect?.(); };
  process.once('SIGTERM',() => { void stop(); });
  try {
    const address = await app.listen({ host: '127.0.0.1',port: 0 });
    process.send!({ type: 'listening',address });
  } catch { process.send!({ type: 'failure' }); await stop(); process.exitCode=1; }
});
