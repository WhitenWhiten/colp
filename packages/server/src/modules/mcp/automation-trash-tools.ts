import { AutomationError, type WorkPrincipal } from '../automation/index.js';
import type { ProductSyncCenterPorts } from '../sync/index.js';
import { canonicalCommandFingerprint } from '../commands/index.js';
import { automationCommandResult } from './automation-command-result.js';

/** Uses the same owner, tombstone, revision and conservative restore services
 * as the Sync center. No purge or permanent deletion operation is exposed. */
export async function callAutomationTrashTool(ports: ProductSyncCenterPorts, actor: WorkPrincipal, name: string,
  args: Readonly<Record<string, unknown>>): Promise<unknown> {
  if (!actor.scopes.includes('mcp:read:own')) throw new AutomationError('insufficient_permission', 'Trash requires mcp:read:own.');
  const owner = { accountId: actor.accountId, subjectId: actor.subjectId };
  try {
    if (name === 'automation.trash.list') return await ports.listTrash({ ...owner, collectionId: String(args.collectionId),
      limit: Number(args.limit ?? 20), ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) });
    const deletionId = String(args.deletionId);
    if (name === 'automation.trash.get') return await ports.getTrashDetail({ ...owner, deletionId });
    if (name !== 'automation.trash.restore' && name !== 'automation.trash.restore_subtree')
      throw new AutomationError('automation_unsupported_capability', 'Trash operation is unavailable.');
    if (!actor.scopes.includes('automation:manage') || !actor.scopes.includes('nodes:write'))
      throw new AutomationError('insufficient_permission', 'Restoration requires automation:manage and nodes:write.');
    const expectedRevision = String(args.baseRevision), commandId = String(args.commandId);
    const subtree = name === 'automation.trash.restore_subtree';
    const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: `/api/v1/sync/trash/${deletionId}/${subtree ? 'restore-subtree' : 'restore'}`,
      resource: deletionId, mediaType: '', conditions: { ifMatch: `"${expectedRevision}"` }, body: null });
    const input = { ...owner, deletionId, expectedRevision, commandId, fingerprint };
    return automationCommandResult(await (subtree ? ports.restoreTrashSubtree(input) : ports.restoreTrash(input)));
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'resource_not_found') throw new AutomationError('resource_not_found', 'Deleted content is unavailable under current owner authority.');
    if (code === 'resource_purged') throw new AutomationError('automation_stale_input', 'The deleted content was purged and cannot be restored.');
    if (code === 'precondition_failed') throw new AutomationError('precondition_failed', 'The deleted content or restore destination changed; inspect its current detail.');
    if (code === 'invalid_cursor') throw new AutomationError('invalid_cursor', 'Restart from the first trash page.');
    if (code === 'invalid_request' || code === 'invalid_document') throw new AutomationError('invalid_request', 'This restore request is invalid.');
    throw error;
  }
}
