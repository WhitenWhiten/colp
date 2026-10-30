import type { SourceDatabase } from './source-db.js';
import { sourceDigest, sourceKey } from './source-db.js';
import { deviceResultPage } from '../automation/device-bridge-result.js';
import type { ManagedLibrary } from './copy-identity.js';

export const ADAPTER_TASK_KINDS = ['semantic', 'confirmation', 'import', 'save', 'transfer', 'reconcile', 'observation'] as const;
export type AdapterTaskKind = typeof ADAPTER_TASK_KINDS[number];
export type AdapterTaskAction = 'retry' | 'resume' | 'cancel';
interface TaskRow {
  id?: string; commandId?: string; state?: string; phase?: string; reason?: string | null; retryReason?: string;
  dueAt?: number; attempts?: number; approvalId?: string; progress?: unknown; connectionId?: string; connections?: string[];
  hint?: { code: number }; context?: { connectionId: string }; origin?: { connectionId: string };
  preview?: { context: { connectionId: string } };
  scope?: { serverOrigin: string; accountId: string | null; collectionId: string | null }; owner?: TaskRow['scope'];
}
interface Position { key: IDBValidKey; primaryKey: IDBValidKey }
interface Entry extends Position { row: TaskRow }
export interface AdapterTaskView { id: string; kind: AdapterTaskKind; state: string; reason: string | null; revision: string;
  actions: AdapterTaskAction[]; attempts?: number; retryAt?: number; progress?: unknown }

function source(kind: AdapterTaskKind, connectionId: string) {
  const prefix = (value: string) => IDBKeyRange.bound(value, value + '\uffff');
  const connection = IDBKeyRange.bound([connectionId], [connectionId, []]);
  switch (kind) {
    case 'semantic': return { store: 'semanticJobs' as const, index: 'connections', range: IDBKeyRange.only(connectionId) };
    case 'confirmation': return { store: 'readRequests' as const, index: 'confirmationState', range: connection };
    case 'save': return { store: 'work' as const, index: 'connectionId', range: IDBKeyRange.only(connectionId) };
    case 'transfer': return { store: 'transfers' as const, index: 'connectionState', range: connection };
    case 'observation': return { store: 'observations' as const, index: 'connectionState', range: connection };
    case 'import': return { store: 'meta' as const, range: prefix('importJob:') };
    case 'reconcile': return { store: 'meta' as const, range: prefix('reconcileRun:') };
  }
}
function belongs(row: TaskRow, kind: AdapterTaskKind, connectionId: string, owner: ManagedLibrary) {
  const owned = (scope: TaskRow['scope']) => scope?.serverOrigin === owner.serverOrigin && scope.accountId === owner.accountId && scope.collectionId === owner.collectionId;
  if (kind === 'semantic') return row.connections?.includes(connectionId) && owned(row.scope);
  if (kind === 'transfer') return row.connectionId === connectionId && owned(row.owner);
  if (kind === 'reconcile') return row.preview?.context?.connectionId === connectionId && owned(row.scope);
  if (kind === 'save' && row.id?.startsWith('observation:')) return false;
  return (row.context?.connectionId ?? row.origin?.connectionId ?? row.connectionId) === connectionId;
}
function safeView(row: TaskRow, kind: AdapterTaskKind, id: string): AdapterTaskView {
  try { return view(row, kind); }
  catch { return { id, kind, state: 'attention', reason: 'record_invalid', revision: sourceDigest({ id, kind }), actions: [] }; }
}
function view(row: TaskRow, kind: AdapterTaskKind): AdapterTaskView {
  const state = String(row.phase ?? row.state ?? (row.dueAt === Number.MAX_SAFE_INTEGER ? 'attention' : 'pending'));
  const actions: AdapterTaskAction[] = [];
  if (kind === 'semantic' && ['attention', 'pending'].includes(state)) actions.push('retry');
  if (kind === 'confirmation' && state === 'uncertain' && row.hint?.code === 0 && !['siteWriteFailed', 'negativeReadbackUnavailable', 'sourceChanged', 'conflict'].includes(row.reason ?? '')) actions.push('retry');
  if (kind === 'save' || kind === 'transfer' && state === 'attention' || kind === 'observation' && row.retryReason) actions.push('retry');
  if (kind === 'import') {
    if (state === 'paused') actions.push('resume');
    if (state === 'attention' && row.approvalId && row.reason !== 'sourceReviewRequired') actions.push('retry');
    if (!['cancelled', 'completed'].includes(state)) actions.push('cancel');
  }
  if (kind === 'reconcile' && state !== 'cancelled') actions.push('retry', 'cancel');
  return { id: String(row.id ?? row.commandId), kind, state, reason: row.reason ?? row.retryReason ?? null,
    revision: sourceDigest(row), actions, ...(Number.isFinite(row.attempts) ? { attempts: row.attempts } : {}),
    ...(row.dueAt !== undefined && row.dueAt > 0 && row.dueAt < Number.MAX_SAFE_INTEGER ? { retryAt: row.dueAt } : {}),
    ...(row.progress ? { progress: row.progress } : {}) };
}
const keyFor = (kind: AdapterTaskKind, id: string) => kind === 'confirmation' ? sourceKey('hint', id)
  : kind === 'import' ? `importJob:${id}` : kind === 'reconcile' ? `reconcileRun:${id}` : id;

export async function readAgentTask(db: SourceDatabase, kind: AdapterTaskKind, connectionId: string, id: string, owner: ManagedLibrary) {
  const row = await db.read<TaskRow>(source(kind, connectionId).store, keyFor(kind, id));
  if (!row || !belongs(row, kind, connectionId, owner)) throw Error('adapter_task_unavailable');
  return safeView(row, kind, id);
}

/** Bounded scans and scoped continuations keep another connection's retained
 * history from hiding active work or expanding one diagnostic into a full DB read. */
export async function listAgentTasks(db: SourceDatabase, input: { requestId: string; kind: AdapterTaskKind; connectionId: string;
  owner: ManagedLibrary; cursor?: string }) {
  const { kind, connectionId, owner } = input, binding = sourceDigest({ kind, connectionId, owner });
  let after: Position | undefined;
  if (input.cursor) {
    let parsed; try { parsed = JSON.parse(input.cursor); } catch { throw Error('invalid_cursor'); }
    if (!parsed || parsed.binding !== binding || parsed.key === undefined || parsed.primaryKey === undefined) throw Error('invalid_cursor');
    after = parsed;
  }
  const spec = source(kind, connectionId);
  const entries = await db.transaction([spec.store], 'readonly', tx => new Promise<Entry[]>((resolve, reject) => {
    const store = tx.objectStore(spec.store), target = 'index' in spec && spec.index ? store.index(spec.index) : store;
    const result: Entry[] = [], request = target.openCursor(spec.range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length === 101) return resolve(result);
      if (after) {
        const key = indexedDB.cmp(cursor.key, after.key), primary = key === 0 ? indexedDB.cmp(cursor.primaryKey, after.primaryKey) : key;
        if (key < 0 || primary < 0) {
          if (target instanceof IDBIndex) cursor.continuePrimaryKey(after.key, after.primaryKey); else cursor.continue(after.key);
          return;
        }
        if (key === 0 && primary === 0) { cursor.continue(); return; }
        after = undefined;
      }
      result.push({ key: cursor.key, primaryKey: cursor.primaryKey, row: cursor.value }); cursor.continue();
    };
  }));
  const cursorFor = (entry: Position) => JSON.stringify({ binding, key: entry.key, primaryKey: entry.primaryKey });
  const visible = entries.slice(0, 100).filter(entry => entry.row && typeof entry.row === 'object' && belongs(entry.row, kind, connectionId, owner));
  const positions = new Map<string, Entry>();
  const items = visible.map(entry => { const item = safeView(entry.row, kind, String(entry.primaryKey)); positions.set(item.id, entry); return item; });
  return deviceResultPage(input.requestId, items, { kind, connectionId }, {
    cursorFor: item => cursorFor(positions.get(item.id)!), tailCursor: entries.length > 100 ? cursorFor(entries[99]!) : null,
  });
}

/** Only the derived work deadline changes; the original plan, command and receipt survive. */
export async function retryAgentSave(db: SourceDatabase, connectionId: string, id: string, revision: string) {
  await db.transaction(['work'], 'readwrite', async tx => {
    const store = tx.objectStore('work');
    const row = await new Promise<TaskRow | undefined>((resolve, reject) => { const r = store.get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    if (!row || row.connectionId !== connectionId || sourceDigest(row) !== revision) throw Error('adapter_task_changed');
    store.put({ ...row, dueAt: 0 }, id);
  });
}
