import { AutomationError } from '../../modules/automation/index.js';
import { saveExecutionPolicy } from '../../modules/automation/index.js';
import { automationView, type AutomationRoute } from './automation-rule-routes.js';
import { createAutomationPagination } from './automation-pagination.js';

export function automationPolicyRoutes(cursorKey: string): AutomationRoute[] {
  const page = createAutomationPagination(cursorKey);
  return [
    { method: 'POST', path: '/execution-policies', action: async ({ ports, request }) => automationView(await saveExecutionPolicy(ports.policies, request.body), 201) },
    { method: 'PUT', path: '/execution-policies/:policyId', ifMatch: true, action: async ({ ports, request, ifMatch }) =>
      automationView(await saveExecutionPolicy(ports.policies, request.body, (request.params as { policyId: string }).policyId, ifMatch)) },
    { method: 'GET', path: '/execution-policies/:policyId', action: async ({ ports, request }) => {
      const policy = await ports.policies.load((request.params as { policyId: string }).policyId);
      if (!policy) throw new AutomationError('resource_not_found', 'Execution policy is unavailable.');
      return automationView(policy);
    } },
    { method: 'GET', path: '/execution-policies', query: ['limit','cursor'], action: async ({ ports, actor, request }) => {
      const now = await ports.now(), { limit, after } = page.read(request.query as Record<string,string>, actor.accountId, 'policies', now);
      const rows = await ports.policies.list(after, limit + 1), last = rows[limit - 1];
      return automationView({ items: rows.slice(0, limit).map(row => row.view), nextCursor: rows.length > limit && last
        ? page.next(actor.accountId, 'policies', limit, { createdAt: last.createdAt, id: last.view.id }, now) : null });
    } },
  ];
}
