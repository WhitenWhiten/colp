import { automationCapabilities } from '../../../src/modules/automation/index.js';
import { afterEach, test, expect, vi } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork } from '../../support/product-http-harness.js';
import type { AutomationUnitOfWork } from '../../../src/modules/automation/index.js';
const env = { DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example', ALLOWED_ORIGINS: 'https://known.example',
  LOG_LEVEL: 'silent', OIDC_JWKS_URI: 'https://issuer.example/certs' };
const apps: ReturnType<typeof buildApiApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
const admission = { KNOWN_FEATURE_AUTOMATION_RULES: 'true', KNOWN_FEATURE_AUTOMATION_CAPTURE: 'true', KNOWN_FEATURE_AUTOMATION_ADMISSION: 'true' };
const work = { ...admission, KNOWN_FEATURE_MCP_WRITE: 'true', KNOWN_FEATURE_AUTOMATION_WORK: 'true' };
test('design rollout flags are explicit, disabled by default and reject invalid values', () => {
  expect(loadConfig(env)).toMatchObject({ automationRulesEnabled: false, automationCaptureEnabled: false,
    automationAdmissionEnabled: false, automationWorkEnabled: false, mcpEventsEnabled: false });
  expect(loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_RULES: 'true' }).automationRulesEnabled).toBe(true);
  expect(loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_CAPTURE: 'true' })).toMatchObject({ automationCaptureEnabled: true, automationAdmissionEnabled: false });
  expect(loadConfig({ ...env, ...admission }).automationAdmissionEnabled).toBe(true);
  expect(loadConfig({ ...env, ...work }).automationWorkEnabled).toBe(true);
  expect(() => loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_RULES: 'yes' })).toThrow('KNOWN_FEATURE_AUTOMATION_RULES');
});
test('flags enforce the rollout order and reject the pre-design names', () => {
  expect(() => loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_ADMISSION: 'true', KNOWN_FEATURE_AUTOMATION_RULES: 'true' })).toThrow('requires');
  expect(() => loadConfig({ ...env, ...admission, KNOWN_FEATURE_AUTOMATION_WORK: 'true' })).toThrow('KNOWN_FEATURE_MCP_WRITE');
  expect(() => loadConfig({ ...env, ...admission, KNOWN_FEATURE_MCP_EVENTS: 'true', AUTOMATION_WEBHOOK_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') }))
    .toThrow('KNOWN_FEATURE_AUTOMATION_WORK');
  expect(() => loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_RUNTIME: 'false' })).toThrow('renamed to KNOWN_FEATURE_AUTOMATION_ADMISSION');
  expect(() => loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_CONFIGURATION: 'true' })).toThrow('renamed to KNOWN_FEATURE_AUTOMATION_RULES');
});
test('main composition runs health startup, mounts authenticated routes and separates runtime readiness', async () => {
  const startup = vi.fn(async () => {});
  const unitOfWork: AutomationUnitOfWork = { execute: async () => { throw new Error('No authenticated service action expected in this composition test.'); } };
  const app = buildApiApp({ config: loadConfig(env), identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date())),
    automationUnitOfWork: unitOfWork, automationHealthStartup: startup }); apps.push(app);
  expect((await app.inject({ method: 'GET', url: '/api/v1/me/automations/capabilities' })).statusCode).toBe(401);
  const readiness = await app.inject({ method: 'GET', url: '/ready/features/automation' });
  expect(readiness.statusCode).toBe(503); expect(readiness.json()).toMatchObject({ configuration: 'ready', reason: 'runtimeUnsupported' });
  expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200); expect(startup).toHaveBeenCalledTimes(1);
});
test('without configuration composition the runtime and routes stay disabled', async () => {
  const app = buildApiApp({ config: loadConfig(env) }); apps.push(app);
  expect((await app.inject({ method: 'GET', url: '/api/v1/me/automations/capabilities' })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/ready/features/automation' })).json()).toMatchObject({ status: 'disabled', configuration: 'disabled' });
});

test('installed M1 runtime advertises ready without requiring Events, agents or device Sync composition', async () => {
  const unitOfWork: AutomationUnitOfWork = { execute: async () => { throw new Error('No service action expected.'); } };
  const app = buildApiApp({ config: loadConfig({ ...env, ...admission }),
    identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date())), automationUnitOfWork: unitOfWork }); apps.push(app);
  expect((await app.inject({ method: 'GET', url: '/ready/features/automation' })).json()).toMatchObject({ status: 'ready', reason: 'm1RuntimeInstalled' });
});

test('configuration-only composition cannot distribute an active device bundle', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerAccountProductSurfaces } = await import('../../../src/transport/register-account-product-surfaces.js');
  for (const enabled of [false, true]) {
    const app = Fastify({ exposeHeadRoutes: false }); apps.push(app);
    registerAccountProductSurfaces(app, {
      config: loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_RULES: 'true', KNOWN_FEATURE_AUTOMATION_CAPTURE: 'true', KNOWN_FEATURE_AUTOMATION_ADMISSION: String(enabled) }),
      automationDeviceUnitOfWork: { execute: async () => { throw new Error('Route composition only'); } },
      syncSessionRoutes: {
        path: '/test-sync', allowedOrigins: ['https://known.example'], rateLimit: { maxRequests: 10, windowMs: 60000 },
        credentialVerifier: { verify: async () => { throw new Error('No authentication expected'); } },
        application: { issue: async () => { throw new Error('No session expected'); } },
      },
    });
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/automation-device/bundle' })).toBe(enabled);
  }
});

test('Events requires explicit flag and a canonical 32-byte encryption key',()=>{
  expect(loadConfig(env).mcpEventsEnabled).toBe(false);
  expect(()=>loadConfig({...env,...work,KNOWN_FEATURE_MCP_EVENTS:'true'})).toThrow('AUTOMATION_WEBHOOK_MASTER_KEY');
  expect(()=>loadConfig({...env,...work,KNOWN_FEATURE_MCP_EVENTS:'true',AUTOMATION_WEBHOOK_MASTER_KEY:Buffer.alloc(24).toString('base64')})).toThrow('AUTOMATION_WEBHOOK_MASTER_KEY');
  const config=loadConfig({...env,...work,KNOWN_FEATURE_MCP_EVENTS:'true',AUTOMATION_WEBHOOK_MASTER_KEY:Buffer.alloc(32,7).toString('base64')});
  expect(config.mcpEventsEnabled).toBe(true);expect(config.automationWebhookMasterKey).toHaveLength(32);
  expect(config.automationWebhookPreviousMasterKey).toBeUndefined();
  const keys={...env,...work,KNOWN_FEATURE_MCP_EVENTS:'true',AUTOMATION_WEBHOOK_MASTER_KEY:Buffer.alloc(32,7).toString('base64')};
  expect(loadConfig({...keys,AUTOMATION_WEBHOOK_PREVIOUS_MASTER_KEY:Buffer.alloc(32,6).toString('base64')}).automationWebhookPreviousMasterKey).toHaveLength(32);
  expect(()=>loadConfig({...keys,AUTOMATION_WEBHOOK_PREVIOUS_MASTER_KEY:'short'})).toThrow('AUTOMATION_WEBHOOK_PREVIOUS_MASTER_KEY');
});

test('Events capability requires installed runtime, worker and explicit Events composition',()=>{
  expect(automationCapabilities({runtimeEnabled:true,workerEnabled:true,eventsEnabled:true}).eventsEnabled).toBe(true);
  expect(automationCapabilities({runtimeEnabled:true,workerEnabled:true,eventsEnabled:false}).eventsEnabled).toBe(false);
  expect(automationCapabilities({runtimeEnabled:false,workerEnabled:true,eventsEnabled:true}).eventsEnabled).toBe(false);
  expect(automationCapabilities({runtimeEnabled:true,workerEnabled:false,eventsEnabled:true}).eventsEnabled).toBe(false);
});
