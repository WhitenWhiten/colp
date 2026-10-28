import Fastify from 'fastify';
import { expect, test, vi } from 'vitest';
import { registerAutomationRoutes, type AutomationRoutesDeps } from '../../../src/transport/product/automation-rule-routes.js';
import { automationRunRoutes } from '../../../src/transport/product/automation-run-routes.js';
import type { AutomationPorts } from '../../../src/modules/automation/index.js';

vi.mock('../../../src/transport/session-auth.js', () => ({
  requireSessionActor: async () => ({ account: { id: 'owner', subjectId: 'subject' } }),
}));

test('automation status responses bind their body to the authenticated account', async () => {
  const app = Fastify();
  const ports = { now: async () => new Date(), rules: { list: async () => [] }, runs: { list: async () => [] },
    settings: { get: async () => ({ paused: false }) } } as unknown as AutomationPorts;
  const deps = { identityUnitOfWork: {}, allowedOrigins: [], cursorKey: 'a'.repeat(64),
    unitOfWork: { execute: async (_actor: unknown, work: (value: AutomationPorts) => Promise<unknown>) => work(ports) },
  } as unknown as AutomationRoutesDeps;
  registerAutomationRoutes(app, deps, automationRunRoutes(deps.cursorKey));
  try {
    for (const path of ['rules', 'runs']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/me/automations/${path}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['known-automation-account-id']).toBe('owner');
      expect(response.json()).toEqual({ items: [], nextCursor: null });
    }
  } finally { await app.close(); }
});
