import { AutomationError, type WorkPrincipal } from '../automation/index.js';
import { callAutomationSyncRecovery } from './automation-sync-tools.js';
import { ActivityCommandError, type ActivityPorts, type ActivityReadRequest } from '../activity/index.js';
import type { ProductSyncCenterUnitOfWork } from '../sync/index.js';
import { pageQuery } from './automation-manager.js';
import { callAutomationTrashTool } from './automation-trash-tools.js';
export interface AutomationAccountTools { activity?: ActivityPorts; sync?: ProductSyncCenterUnitOfWork }
export async function callAutomationAccountTool(ports: AutomationAccountTools, actor: WorkPrincipal, name: string,
  args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const accountId = actor.accountId;
  if (name.startsWith('automation.activity.')) {
    if (!ports.activity) throw unavailable();
    try {
      if (name === 'automation.activity.list') return ports.activity.list(accountId, { ...pageQuery(args), ...(args.state ? { state: String(args.state) } : {}) });
      if (name === 'automation.activity.summary') return ports.activity.summary(accountId);
      if (name === 'automation.activity.read') return await ports.activity.markRead(accountId, args.request as ActivityReadRequest, String(args.commandId));
    } catch (error) {
      if (!(error instanceof ActivityCommandError)) throw error;
      throw new AutomationError('automation_command_conflict', error.message);
    }
  }
  if (name.startsWith('automation.sync.') || name.startsWith('automation.trash.')) {
    if (!ports.sync) throw unavailable();
    return ports.sync.execute(async reads => {
      if (name.startsWith('automation.trash.')) return callAutomationTrashTool(reads, actor, name, args);
      if (name === 'automation.sync.status') return reads.getStatus({ accountId });
      if (name === 'automation.sync.devices') return { items: (await reads.getStatus({ accountId })).devices };
      if (name === 'automation.sync.issues') {
        try { return await reads.getReplicaIssues({ accountId, replicaId: String(args.replicaId) }); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'resource_not_found')
            throw new AutomationError('resource_not_found', 'Replica is unavailable under current owner authority.');
          throw error;
        }
      }
      return callAutomationSyncRecovery(reads, actor, name, args);
    });
  }
  throw unavailable();
}
function unavailable() { return new AutomationError('automation_unsupported_capability', 'Account diagnostics are unavailable.'); }
