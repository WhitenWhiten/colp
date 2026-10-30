import type { BrowserRequest } from '../automation/device-bridge.js';
import { ADAPTER_TASK_KINDS, listAgentTasks, readAgentTask } from '../site-adapters/agent-tasks.js';
import { controlSiteAgent } from '../site-adapters/agent-runtime.js';
import { siteLedger } from '../site-adapters/source-runtime.js';
import { allSites, sitesLoaded } from '../site-adapters/registry.js';
import type { SourceAuthority } from '../site-adapters/ledger-types.js';
import type { SyncScope } from '../sync-state-store.js';

export async function handleAdapterTasks(request: BrowserRequest, scope: SyncScope, authorize: () => Promise<void>) {
  await authorize(); await sitesLoaded();
  const { connectionId, taskKind, taskId } = request.input;
  if (!connectionId || !taskKind || !ADAPTER_TASK_KINDS.includes(taskKind)) throw Error('adapter_task_input_invalid');
  let adapterId: string | undefined;
  for (const site of allSites()) {
    const authority = await siteLedger.db.read<SourceAuthority>('authorities', site.adapterId);
    if (authority?.connectionId === connectionId) { adapterId = site.adapterId; break; }
  }
  if (!adapterId) throw Error('sourceAuthorizationChanged');
  const owner = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId };
  if (request.operation === 'adapters.tasks.list') return listAgentTasks(siteLedger.db, {
    requestId: request.id, kind: taskKind, connectionId, owner, cursor: request.input.cursor,
  });
  if (!taskId) throw Error('adapter_task_input_invalid');
  if (request.operation === 'adapters.tasks.get') return { task: await readAgentTask(siteLedger.db, taskKind, connectionId, taskId, owner) };
  if (request.operation !== 'adapters.tasks.control' || !request.input.revision || !request.input.action) throw Error('adapter_task_input_invalid');
  return controlSiteAgent(adapterId, { kind: taskKind, connectionId, id: taskId, owner,
    revision: request.input.revision, action: request.input.action, assertCurrent: authorize });
}
