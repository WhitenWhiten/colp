import { AutomationError, getAutomationRule, listAutomationRules, requireBinding, saveBinding, assessRuleHealth,
  ruleDependencies, getAutomationRun, cancelAutomationRun, createAutomationPagination,
  setPause, type AutomationPorts, type AutomationActor } from '../automation/index.js';
import { automationConfigurationTool, CONFIGURATION_MUTATIONS } from './automation-configuration-tools.js';
import { pageQuery } from './automation-tool-query.js';
export { pageQuery } from './automation-tool-query.js';

/** The same owner-scoped services and stores used by product HTTP routes. */
export async function automationManagerReadOrRecover(ports: AutomationPorts, actor: AutomationActor, name: string,
  args: Readonly<Record<string, unknown>>, cursorKey: string): Promise<unknown> {
  const etag = `"${String(args.baseRevision)}"`, pages = createAutomationPagination(cursorKey);
  switch (name) {
    case 'automation.pause.get': return ports.settings.get(actor.accountId);
    case 'automation.pause.set': return setPause(ports, actor, args.change, etag);
    case 'automation.rules.list': return listAutomationRules(ports, actor, cursorKey, pageQuery(args));
    case 'automation.rules.get': return getAutomationRule(ports, actor, String(args.ruleId));
    case 'automation.rules.health': return assessRuleHealth(ports, actor, String(args.ruleId));
    case 'automation.rules.diagnostics': return ruleDependencies(ports, actor, String(args.ruleId));
    case 'automation.bindings.get': return requireBinding(ports, actor, String(args.bindingSetId));
    case 'automation.bindings.save': return saveBinding(ports, actor, args.binding, args.mode === 'update' ? String(args.bindingSetId) : undefined, etag);
    case 'automation.runs.get': return getAutomationRun(ports.runs, String(args.runId));
    case 'automation.runs.cancel': return cancelAutomationRun(ports.runs, String(args.runId), etag);
    case 'automation.jobs.retry':
      if (!ports.ownerJobs) throw unavailable();
      return ports.ownerJobs.retry(String(args.jobId), args.request, etag);
    case 'automation.deliveries.retry':
      if (!ports.deliveries) throw unavailable();
      return ports.deliveries.retry(String(args.deliveryId));
    case 'automation.runs.list':
    case 'automation.outputs.list':
    case 'automation.deliveries.list': {
      const scope = name === 'automation.outputs.list' ? JSON.stringify(['outputs', String(args.runId)])
        : name === 'automation.runs.list' ? JSON.stringify(['runs', null, null]) : 'deliveries';
      const now = await ports.now(), { limit, after } = pages.read(pageQuery(args), actor.accountId, scope, now);
      const rows = name === 'automation.runs.list' ? (await ports.runs.list(after, limit + 1)).map(r => ({ view: r.view, createdAt: r.sortCreatedAt }))
        : name === 'automation.outputs.list' ? await (ports.outputs ?? missing()).list(String(args.runId), after, limit + 1)
        : await (ports.deliveries ?? missing()).list(after, limit + 1);
      const last = rows[limit - 1];
      return { items: rows.slice(0, limit).map(r => r.view), nextCursor: rows.length > limit && last
        ? pages.next(actor.accountId, scope, limit, { id: last.view.id, createdAt: last.createdAt }, now) : null };
    }
    default: return automationConfigurationTool(ports, actor, name, args, cursorKey);
  }
}
function unavailable() { return new AutomationError('automation_unsupported_capability', 'Management operation is unavailable.'); }
function missing(): never { throw unavailable(); }
export const AUTOMATION_MANAGER_MUTATIONS = new Set(['automation.rules.save', 'automation.rules.set_state',
  'automation.bindings.save', 'automation.runs.cancel', 'automation.jobs.retry', 'automation.deliveries.retry', 'automation.pause.set', ...CONFIGURATION_MUTATIONS]);
