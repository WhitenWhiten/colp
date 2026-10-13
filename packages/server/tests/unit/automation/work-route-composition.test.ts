import { expect, test } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { automationWorkRouteDeps, registerAccountProductSurfaces } from '../../../src/transport/register-account-product-surfaces.js';
import type { AppDependencies } from '../../../src/transport/app-dependencies.js';

const env = { DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example', ALLOWED_ORIGINS: 'https://known.example',
  LOG_LEVEL: 'silent', OIDC_JWKS_URI: 'https://issuer.example/certs' };
const work = { KNOWN_FEATURE_AUTOMATION_RULES: 'true', KNOWN_FEATURE_AUTOMATION_CAPTURE: 'true', KNOWN_FEATURE_AUTOMATION_ADMISSION: 'true',
  KNOWN_FEATURE_MCP_WRITE: 'true', KNOWN_FEATURE_AUTOMATION_WORK: 'true' };

test('production composition mounts worker routes only with WORK and always passes the admission budget', async () => {
  const admit = async () => {};
  const parts = { automationPairing: { pair: async () => { throw new Error('Composition only'); } },
    mcpReadTransport: { oauthVerifier: { verify: async () => { throw new Error('Composition only'); } } }, automationWorkAdmit: admit } as unknown as Partial<AppDependencies>;
  for (const enabled of [false, true]) {
    const deps = { ...parts, config: loadConfig({ ...env, ...(enabled ? work : {}) }) } as AppDependencies;
    expect(automationWorkRouteDeps(deps)?.admit).toBe(enabled ? admit : undefined);
    const app = Fastify({ exposeHeadRoutes: false });
    registerAccountProductSurfaces(app, deps);
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/automation-work/pairings/claim' })).toBe(enabled);
    await app.close();
  }
});
