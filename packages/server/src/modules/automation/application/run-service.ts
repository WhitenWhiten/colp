import type { Run, EffectReceiptView } from '@know-n/colp/automation';
import type { PageAfter } from './ports.js';
import { AutomationError } from '../domain/errors.js';
import { requireEtag } from './rule-service.js';
export interface StoredRun { view: Run; sortCreatedAt: string }
export interface RunStore {
  load(id: string): Promise<StoredRun | null>;
  list(after: PageAfter | null, limit: number, bookmark?: { collectionId: string; nodeId: string }): Promise<StoredRun[]>;
  cancel(id: string): Promise<void>;
  effects(id: string): Promise<EffectReceiptView[]>;
}
export async function getAutomationRun(store: RunStore, id: string): Promise<Run> {
  const run = await store.load(id);
  if (!run) throw new AutomationError('resource_not_found', 'Run is unavailable under current owner authority.');
  return { ...run.view, effects: await store.effects(id) };
}
export async function cancelAutomationRun(store: RunStore, id: string, ifMatch: string): Promise<Run> {
  const run = await getAutomationRun(store, id); requireEtag(run.revision, ifMatch);
  if (['waiting', 'running', 'blocked', 'review'].includes(run.status)) await store.cancel(id);
  return getAutomationRun(store, id);
}
