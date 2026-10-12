import type { LocalImportItem, LocalImportPlan, LocalImportStatus } from './contracts.js';
import type { LocalImportStore } from './store.js';

export interface LocalImportPorts {
  readonly store: LocalImportStore;
  hasPermission(): Promise<boolean>;
  assertFolder(nativeId: string): Promise<void>;
  create(input: { parentId: string; title: string; url?: string }): Promise<{ id: string }>;
  get(nativeId: string): Promise<{ parentId?: string; title: string; url?: string } | undefined>;
  restoreMetadata?(plan: LocalImportPlan, items: readonly LocalImportItem[]): Promise<void>;
}
export function createLocalImporter(ports: LocalImportPorts) {
  async function parent(plan: LocalImportPlan, item: LocalImportItem): Promise<string> {
    if (item.parentIndex === null) return plan.targetNativeId;
    const predecessor = await ports.store.item(plan.commandId, item.parentIndex);
    if (predecessor?.state !== 'completed' || !predecessor.nativeId) throw new Error('local_import_parent_missing');
    return predecessor.nativeId;
  }
  async function status(commandId?: string): Promise<LocalImportStatus | null> {
    const plan = await ports.store.plan(commandId);
    if (!plan) return null;
    const item = plan.reason === 'native_result_unknown' ? await ports.store.item(plan.commandId, plan.next) : undefined;
    return { ...plan, ...(item ? { pending: { parentNativeId: await parent(plan, item), title: item.title, url: item.url } } : {}) };
  }
  async function run(commandId: string, limit = 100): Promise<LocalImportPlan> {
    let plan = await ports.store.plan(commandId);
    if (!plan) throw new Error('local_import_not_found');
    for (let count = 0; count < limit && plan.state === 'running'; count++) {
      if (plan.next === plan.total) {
        try {
          if (!await ports.hasPermission()) throw new Error('permission_required');
          if (!ports.restoreMetadata) throw new Error('backup_restore_unavailable');
          await ports.restoreMetadata(plan, await ports.store.items(commandId));
          return ports.store.complete(plan);
        } catch (error) { return ports.store.state(plan, 'attention', error instanceof Error ? error.message : 'backup_restore_failed'); }
      }
      const item = await ports.store.item(commandId, plan.next);
      if (!item) throw new Error('local_import_item_missing');
      // A worker can die after Chrome creates a node but before its receipt is recorded.
      // Only an explicit user-confirmed native identity can resolve this gap.
      if (item.state === 'submitted') return ports.store.state(plan, 'attention', 'native_result_unknown');
      try {
        if (!await ports.hasPermission()) throw new Error('permission_required');
        const parentId = await parent(plan, item);
        await ports.assertFolder(parentId);
        await ports.store.started(plan, item);
        const node = await ports.create({ parentId, title: item.title, ...(item.url === undefined ? {} : { url: item.url }) });
        plan = await ports.store.confirm(plan, item, node.id);
      } catch (error) {
        const pending = await ports.store.item(commandId, plan.next);
        const reason = pending?.state === 'submitted' ? 'native_result_unknown'
          : error instanceof Error ? error.message : 'local_import_failed';
        return ports.store.state(plan, 'attention', reason);
      }
    }
    return plan;
  }
  async function resume(commandId: string) {
    const plan = await ports.store.plan(commandId);
    if (!plan) throw new Error('local_import_not_found');
    if (plan.state === 'completed' || plan.state === 'cancelled') return plan;
    return ports.store.state(plan, 'running', null);
  }
  async function resolve(commandId: string, nativeId: string) {
    const plan = await ports.store.plan(commandId);
    if (!plan || plan.state !== 'attention' || plan.reason !== 'native_result_unknown') throw new Error('local_import_changed');
    if (!await ports.hasPermission()) throw new Error('permission_required');
    const item = await ports.store.item(commandId, plan.next);
    if (!item) throw new Error('local_import_item_missing');
    const parentId = await parent(plan, item);
    await ports.assertFolder(parentId);
    const node = await ports.get(nativeId);
    if (!node || node.parentId !== parentId || node.title !== item.title || node.url !== item.url) throw new Error('local_import_identity_mismatch');
    return ports.store.confirm(plan, item, nativeId);
  }
  return { run, status, resume, resolve };
}
