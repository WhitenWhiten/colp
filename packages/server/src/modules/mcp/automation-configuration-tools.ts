import { AutomationError, createAutomationPagination, parseContract, requireEtag, saveConnectionProfile, saveTarget, saveExecutor, saveExecutionPolicy,
  type AutomationActor, type AutomationPorts } from '../automation/index.js';
import { pageQuery } from './automation-tool-query.js';

/** Configuration mutations run inside the manager's receipt transaction and
 * use the same validators and owner-scoped stores as Product HTTP. */
export async function automationConfigurationTool(ports: AutomationPorts, actor: AutomationActor, name: string,
  args: Readonly<Record<string, unknown>>, cursorKey: string): Promise<unknown> {
  const resources = {
    connection_profiles: { store: ports.targets.profiles, idKey: 'profileId', scope: 'connection_profiles',
      save: (body: unknown, id?: string, etag?: string) => saveConnectionProfile(ports.targets, body, id, etag) },
    targets: { store: ports.targets.targets, idKey: 'targetId', scope: 'targets',
      save: (body: unknown, id?: string, etag?: string) => saveTarget(ports.targets, body, id, etag) },
    executors: { store: ports.targets.executors, idKey: 'executorId', scope: 'executors',
      save: (body: unknown, id?: string, etag?: string) => saveExecutor(ports.targets, body, id, etag) },
    execution_policies: { store: ports.policies, idKey: 'policyId', scope: 'execution_policies',
      save: (body: unknown, id?: string, etag?: string) => saveExecutionPolicy(ports.policies, body, id, etag) },
  };
  const [, resource, operation] = name.split('.');
  if (!resource || !Object.hasOwn(resources, resource)) throw new AutomationError('automation_unsupported_capability', 'Configuration operation is unavailable.');
  const spec = resources[resource as keyof typeof resources], id = String(args[spec.idKey]);
  if (operation === 'get') {
    const value = await spec.store.load(id);
    if (!value) throw new AutomationError('resource_not_found', 'Configuration is unavailable under current owner authority.');
    return value;
  }
  if (operation === 'save') return spec.save(args.configuration, args.mode === 'update' ? id : undefined,
    args.mode === 'update' ? `"${String(args.baseRevision)}"` : undefined);
  if (operation === 'list') {
    const pages = createAutomationPagination(cursorKey), now = await ports.now();
    const { limit, after } = pages.read(pageQuery(args), actor.accountId, spec.scope, now);
    const rows = await spec.store.list(after, limit + 1), last = rows[limit - 1];
    return { items: rows.slice(0, limit).map(row => row.view), nextCursor: rows.length > limit && last
      ? pages.next(actor.accountId, spec.scope, limit, { id: last.view.id, createdAt: last.createdAt }, now) : null };
  }
  if (resource === 'targets' && (operation === 'revoke' || operation === 'issue_pairing')) {
    parseContract('CommandReason', { reason: args.reason });
    const target = await ports.targets.targets.load(id);
    if (!target) throw new AutomationError('resource_not_found', 'Target is unavailable.');
    requireEtag(target.revision, `"${String(args.baseRevision)}"`);
    if (operation === 'issue_pairing') {
      const grant = await ports.targets.issuePairing(id);
      const current = (await ports.targets.targets.load(id))!;
      return { ...grant, targetRevision: current.revision, replayed: false };
    }
    return ports.targets.revoke(id);
  }
  throw new AutomationError('automation_unsupported_capability', 'Configuration operation is unavailable.');
}

export const CONFIGURATION_MUTATIONS = ['automation.connection_profiles.save', 'automation.targets.save', 'automation.targets.revoke',
  'automation.executors.save', 'automation.execution_policies.save', 'automation.targets.issue_pairing'];

/** Pairing codes are returned once and stored only as hashes by the target
 * store. A lost response requires an explicit new grant, not secret replay. */
export function configurationReceiptValue(name: string, value: unknown): unknown {
  return name === 'automation.targets.issue_pairing' ? { ...(value as Record<string, unknown>), code: null, replayed: true } : value;
}
