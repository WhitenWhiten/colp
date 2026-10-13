import { assessRuleHealth, revalidateRule, ruleDependencies, acknowledgeIncident, parseContract, requireRule, requireEtag } from '../../modules/automation/index.js';
import { automationView, type AutomationRoute } from './automation-rule-routes.js';
import { createAutomationPagination } from './automation-pagination.js';
export function automationHealthRoutes(cursorKey: string): AutomationRoute[] {
  const page = createAutomationPagination(cursorKey);
  const ruleId = (params: unknown) => (params as { ruleId: string }).ruleId;
  return [
    { method: 'GET', path: '/rules/:ruleId/health', noBody: true, action: async ({ ports, actor, request }) => automationView(await assessRuleHealth(ports, actor, ruleId(request.params))) },
    { method: 'GET', path: '/rules/:ruleId/dependencies', noBody: true, action: async ({ ports, actor, request }) => automationView(await ruleDependencies(ports, actor, ruleId(request.params))) },
    { method: 'POST', path: '/rules/:ruleId/revalidate', ifMatch: true, action: async ({ ports, actor, request, ifMatch }) => {
      parseContract('CommandReason', request.body);
      requireEtag((await requireRule(ports, actor, ruleId(request.params))).view.revision, ifMatch);
      return automationView(await revalidateRule(ports, actor, ruleId(request.params)));
    } },
    { method: 'GET', path: '/incidents', query: ['limit', 'cursor'], action: async ({ ports, actor, request }) => {
      const now = await ports.now(), { limit, after } = page.read(request.query as Record<string,string>, actor.accountId, 'incidents', now);
      const rows = await ports.health.list(actor.accountId, after, limit + 1), last = rows[limit - 1];
      return automationView({ items: rows.slice(0, limit), nextCursor: rows.length > limit && last ? page.next(actor.accountId, 'incidents', limit,
        { createdAt: last.firstSeenAt, id: last.id }, now) : null });
    } },
    { method: 'POST', path: '/incidents/:incidentId/acknowledge', action: async ({ ports, actor, request }) => {
      parseContract('CommandReason', request.body);
      return automationView(await acknowledgeIncident(ports, actor, (request.params as { incidentId: string }).incidentId));
    } },
  ];
}
