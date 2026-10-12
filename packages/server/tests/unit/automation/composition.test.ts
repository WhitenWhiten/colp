import { afterEach, test, expect, vi } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork } from '../../support/product-http-harness.js';
import type { AutomationUnitOfWork } from '../../../src/modules/automation/index.js';
const env = { DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example', ALLOWED_ORIGINS: 'https://known.example',
  LOG_LEVEL: 'silent', OIDC_JWKS_URI: 'https://issuer.example/certs' };
const apps: ReturnType<typeof buildApiApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
test('configuration gate is explicit, disabled by default and rejects invalid values', () => {
  expect(loadConfig(env).automationConfigurationEnabled).toBe(false);
  expect(loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_CONFIGURATION: 'true' }).automationConfigurationEnabled).toBe(true);
  expect(() => loadConfig({ ...env, KNOWN_FEATURE_AUTOMATION_CONFIGURATION: 'yes' })).toThrow('KNOWN_FEATURE_AUTOMATION_CONFIGURATION');
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
