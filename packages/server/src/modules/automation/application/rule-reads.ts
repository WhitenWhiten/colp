import type { AutomationActor } from '../domain/bindings.js';
import type { AutomationPorts } from './ports.js';
import { requireRule } from './rule-service.js';
import { assessRuleHealth } from './health-service.js';
import { createAutomationPagination } from './pagination.js';

export async function getAutomationRule(ports: AutomationPorts, actor: AutomationActor, id: string) {
  return ruleView(ports, actor, (await requireRule(ports, actor, id)).view);
}
export async function listAutomationRules(ports: AutomationPorts, actor: AutomationActor, cursorKey: string, query: { cursor?: string; limit?: string }) {
  const pages = createAutomationPagination(cursorKey), now = await ports.now();
  const { limit, after } = pages.read(query, actor.accountId, 'rules', now);
  const rows = await ports.rules.list(actor.accountId, after, limit + 1), last = rows[limit - 1];
  const items = [];
  for (const row of rows.slice(0, limit)) items.push(await ruleView(ports, actor, row.view));
  return { items, nextCursor: rows.length > limit && last
    ? pages.next(actor.accountId, 'rules', limit, { id: last.view.id, createdAt: last.sortCreatedAt }, now) : null };
}
async function ruleView(ports: AutomationPorts, actor: AutomationActor, rule: import('@know-n/colp/automation').Rule) {
  const view = { ...rule };
  if (ports.runtimeEnabled) view.effectiveState = (await assessRuleHealth(ports, actor, rule.id)).effectiveState;
  if (view.desiredState === 'enabled' && (await ports.settings.get(actor.accountId)).paused) view.effectiveState = 'paused';
  if (ports.usage) view.usage = await ports.usage.rule(rule.id);
  return view;
}
