import { automationCommandResult as commandResult } from './automation-command-result.js';
import { AutomationError, type WorkPrincipal } from '../automation/index.js';
import type { ProductSyncCenterPorts } from '../sync/index.js';
import { canonicalCommandFingerprint } from '../commands/index.js';

function requireScope(actor: WorkPrincipal, scope: string) {
  if (!actor.scopes.includes(scope)) throw new AutomationError('insufficient_permission', `This Sync operation requires ${scope}.`);
}

/** Reuse the owner-scoped Sync center services, including durable receipts and
 * the browser's advertised action capabilities; no generic local reset RPC. */
export async function callAutomationSyncRecovery(ports: ProductSyncCenterPorts, actor: WorkPrincipal, name: string,
  args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const accountId = actor.accountId;
  try {
    if (name === 'automation.sync.conflicts') {
      requireScope(actor, 'mcp:read:own');
      return await ports.getConflicts({ accountId, limit: Number(args.limit ?? 20), ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) });
    }
    if (name === 'automation.sync.replica_plan') {
      const replica = (await ports.getStatus({ accountId })).replicas.find(replica => replica.id === args.replicaId);
      if (!replica) throw new AutomationError('resource_not_found', 'Replica is unavailable under current owner authority.');
      return { replicaId: replica.id, lifecycleRevision: replica.lifecycleRevision, health: replica.health,
        actions: replica.health?.actions ?? [], effects: { retry: 'Retry existing durable work without replacing commands.',
          rebuild: 'Retire the old replica and rebuild its local projection under the existing browser recovery protocol; requires explicit confirmation.' } };
    }
    requireScope(actor, 'automation:manage');
    const commandId = String(args.commandId);
    if (name === 'automation.sync.resolve_conflict') {
      requireScope(actor, 'nodes:write'); requireScope(actor, 'mcp:read:own');
      const conflictId = String(args.conflictId), expectedRevision = String(args.baseRevision);
      const resolution = args.resolution as 'server' | 'incoming' | 'custom' | 'both';
      const body = { resolution, ...(resolution === 'custom' ? { value: args.value } : {}) };
      const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: `/api/v1/sync/conflicts/${conflictId}/resolution`,
        resource: conflictId, mediaType: 'application/json', conditions: { ifMatch: `"${expectedRevision}"` }, body });
      return await commandResult(await ports.resolveConflict({ accountId, subjectId: actor.subjectId,
        conflictId, expectedRevision, commandId, fingerprint, ...body }));
    }
    if (name === 'automation.sync.retry_issue' || name === 'automation.sync.replica_command') {
      const replicaId = String(args.replicaId), issue = name === 'automation.sync.retry_issue';
      const action = issue ? 'retry' : args.action as 'retry' | 'rebuild';
      if (!issue) {
        requireScope(actor, 'nodes:write');
        if (action === 'rebuild' && args.confirmation !== 'rebuild_replica') throw new AutomationError('invalid_request', 'Confirm the reviewed replica rebuild explicitly.');
      }
      const body = { action, ...(issue ? { issueId: String(args.issueId) } : {}) };
      const expectedLifecycleRevision = !issue ? String(args.baseRevision) : undefined;
      const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: `/api/v1/sync/replicas/${replicaId}/commands`,
        resource: replicaId, mediaType: 'application/json', body,
        ...(expectedLifecycleRevision ? { conditions: { ifMatch: `"${expectedLifecycleRevision}"` } } : {}) });
      return await commandResult(await ports.sendReplicaCommand({ accountId, replicaId, ...body,
        commandId, fingerprint, ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}) }));
    }
    throw new AutomationError('automation_unsupported_capability', 'Sync recovery operation is unavailable.');
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'resource_not_found') throw new AutomationError('resource_not_found', 'Sync resource is unavailable under current owner authority.');
    if (code === 'precondition_failed' || code === 'stale_replica' || code === 'replica_action_unavailable')
      throw new AutomationError('precondition_failed', 'Sync state or available actions changed; inspect the current resource before retrying.');
    if (code === 'replica_commands_full') throw new AutomationError('rate_limited', 'This browser has too many outstanding commands.');
    if (code === 'invalid_cursor') throw new AutomationError('invalid_cursor', 'Restart from the first conflict page.');
    if (code === 'unsupported_operation' || code === 'invalid_document') throw new AutomationError('invalid_request', 'The requested resolution is not available for this conflict.');
    throw error;
  }
}
