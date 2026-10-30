import { createLane } from '../automation/lane.js';
import type { SourceDatabase } from './source-db.js';
import type { SourceAuthority } from './ledger-types.js';
import { readAgentTask, retryAgentSave } from './agent-tasks.js';
import type { SiteAgentAction } from './agent-runtime.js';
import { retryLocalTransfers } from './local-transfer-queue.js';
import { retrySourceObservations } from './local-source-problems.js';

export function createSiteAgentController(ports: {
  db: SourceDatabase; adapterId: string; ready(): Promise<void>; wake(): void;
  importer: { retry(id: string): Promise<void>; resume(id: string): Promise<void>; cancel(id: string): Promise<void> };
  reconcile(id: string, action: string, connectionId: string): Promise<unknown>;
  confirm(id: string): Promise<void>; semantic(id: string, connectionId: string): Promise<void>;
}) {
  const lane = createLane();
  return (input: SiteAgentAction) => lane(async () => {
    await input.assertCurrent(); await ports.ready();
    const authority = await ports.db.read<SourceAuthority>('authorities', ports.adapterId);
    if (!authority?.enabled || authority.connectionId !== input.connectionId) throw Error('sourceAuthorizationChanged');
    const task = await readAgentTask(ports.db, input.kind, input.connectionId, input.id, input.owner);
    if (task.revision !== input.revision) throw Error('adapter_task_changed');
    if (!task.actions.includes(input.action)) throw Error('adapter_action_unavailable');
    await input.assertCurrent();
    switch (input.kind) {
      case 'import': await ports.importer[input.action](input.id); break;
      case 'reconcile': await ports.reconcile(input.id, input.action, input.connectionId); break;
      case 'confirmation': await ports.confirm(input.id); break;
      case 'semantic': await ports.semantic(input.id, input.connectionId); break;
      case 'save': await retryAgentSave(ports.db, input.connectionId, input.id, input.revision); break;
      case 'transfer': await retryLocalTransfers(ports.db, input.connectionId, input.id); break;
      case 'observation': await retrySourceObservations(ports.db, input.connectionId, input.id); break;
    }
    ports.wake(); return { taskId: input.id, kind: input.kind, scheduled: true };
  });
}
