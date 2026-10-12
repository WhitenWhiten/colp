import { requestValue, transactionDone } from '../sync-state/idb.js';
import { captureScopeKey, captureOwnerKey, type CaptureScope, type CaptureTask } from './contracts.js';
import { effectiveLocalFeedback, type CaptureFeedbackEvent } from './feedback.js';
import { captureNeedsAttention } from './statistics.js';

interface StoredTask extends CaptureTask { readonly scopeKey: string; readonly ownerKey: string; readonly activeKey?: string }
const active = (task: CaptureTask) => task.disposition === 'new'
  && (task.save === 'unsubmitted' || task.save === 'unknown' || task.classification === 'waiting' || task.classification === 'running');
const row = (task: CaptureTask): StoredTask => ({ ...task, scopeKey: captureScopeKey(task.scope), ownerKey: captureOwnerKey(task.scope),
  ...(active(task) && !task.saveAnother ? { activeKey: JSON.stringify([captureScopeKey(task.scope), task.url]) } : {}) });
const dto = ({ scopeKey: _scopeKey, ownerKey: _ownerKey, activeKey: _activeKey, ...task }: StoredTask): CaptureTask => task;

/** Separate product ledger, referencing existing native/COLP intents. It never stores sync operations. */
export function createCaptureStore(factory: IDBFactory = indexedDB, onCommitted?: () => void) {
  let connection: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = factory.open('known-capture', 3);
      request.onupgradeneeded = event => {
        if (event.oldVersion < 1) {
        const tasks = request.result.createObjectStore('tasks', { keyPath: ['scopeKey', 'captureId'] });
        tasks.createIndex('command', ['scopeKey', 'commandId'], { unique: true });
        tasks.createIndex('active', 'activeKey', { unique: true });
        tasks.createIndex('history', ['scopeKey', 'createdAt', 'captureId']);
        request.result.createObjectStore('commands', { keyPath: ['scopeKey', 'commandId'] });
        }
        if (event.oldVersion < 2) request.result.createObjectStore('feedback', { keyPath: ['scopeKey', 'eventId'] });
        if (event.oldVersion < 3) {
          request.result.createObjectStore('gc', { keyPath: 'ownerKey' });
          const tasks = request.transaction!.objectStore('tasks');
          tasks.createIndex('ownerHistory', ['ownerKey', 'createdAt', 'captureId']);
          tasks.createIndex('ownerId', ['ownerKey', 'captureId'], { unique: true });
          tasks.createIndex('ownerSaveUrl', ['ownerKey', 'url', 'save']);
          request.transaction!.objectStore('commands').createIndex('capture', ['scopeKey', 'captureId']);
          const feedback = request.transaction!.objectStore('feedback'); feedback.createIndex('owner', 'ownerKey');
          feedback.createIndex('capture', ['scopeKey', 'captureId']);
          for (const store of [tasks, feedback]) {
            const cursor = store.openCursor(); cursor.onsuccess = () => {
              const current = cursor.result; if (!current) return;
              const value = current.value as { scope: CaptureScope }; current.update({ ...value, ownerKey: captureOwnerKey(value.scope) }); current.continue();
            };
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
    });
    return connection;
  }
  async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = (await open()).transaction(['tasks', 'commands', 'feedback', 'gc'], mode);
    const done = transactionDone(tx);
    try { const value = await work(tx); await done; if (mode === 'readwrite') onCommitted?.(); return value; }
    catch (error) { try { tx.abort(); } catch { /* already aborted */ } await done.catch(() => undefined); throw error; }
  }
  return {
    async prune(scope: CaptureScope, now: number): Promise<number> {
      return transaction('readwrite', async tx => {
        const events = tx.objectStore('feedback'), tasks = tx.objectStore('tasks'), commands = tx.objectStore('commands');
        const owner = captureOwnerKey(scope), pending = await requestValue(events.index('owner').getAll(owner)) as CaptureFeedbackEvent[];
        const retained = new Set(pending.filter(event => !event.uploaded && !event.resolved).map(event => event.captureId));
        const gc = tx.objectStore('gc'), prior = await requestValue(gc.get(owner)) as { after?: [number, string] } | undefined;
        const cutoff = now - 90 * 86400000, after = prior?.after && prior.after[0] < cutoff ? prior.after : undefined;
        const old = await requestValue(tasks.index('ownerHistory').getAll(IDBKeyRange.bound(after ? [owner, ...after] : [owner], [owner, cutoff], Boolean(after)), 200)) as StoredTask[];
        let removed = 0;
        for (const task of old) {
          if (task.save !== 'local-saved' || !['confirmed', 'local-only'].includes(task.sync)
            || ['waiting', 'running'].includes(task.classification) || captureNeedsAttention(task.save, task.sync, task.reason)
            || retained.has(task.captureId) || task.editIntent && !task.editIntent.completed && task.editIntent.state !== 'rejected' || task.undo && !task.undo.completed
            || task.sync !== 'local-only' && (task.reportedRevision ?? -1) < task.revision) continue;
          tasks.delete([task.scopeKey, task.captureId]); removed++;
          const aliases = await requestValue(commands.index('capture').getAll([task.scopeKey, task.captureId])) as { commandId: string }[];
          for (const alias of aliases) commands.delete([task.scopeKey, alias.commandId]);
          const feedback = await requestValue(events.index('capture').getAll([task.scopeKey, task.captureId])) as CaptureFeedbackEvent[];
          for (const event of feedback) events.delete([task.scopeKey, event.eventId]);
        }
        const last = old.at(-1); gc.put({ ownerKey: owner, ...(old.length === 200 && last ? { after: [last.createdAt, last.captureId] } : {}) });
        return removed;
      });
    },
    async enqueueFeedback(event: CaptureFeedbackEvent): Promise<CaptureTask> {
      return transaction('readwrite', async tx => {
        const scopeKey = captureScopeKey(event.scope), events = tx.objectStore('feedback'), tasks = tx.objectStore('tasks');
        const task = await requestValue(tasks.get([scopeKey, event.captureId])) as StoredTask | undefined;
        if (!task || task.decisionId !== event.decisionId || task.appliedRevision !== event.nodeRevision) throw new Error('capture_feedback_revision_changed');
        const prior = await requestValue(events.get([scopeKey, event.eventId])) as CaptureFeedbackEvent | undefined;
        if (prior) {
          if (prior.captureId !== event.captureId || prior.kind !== event.kind || prior.nodeRevision !== event.nodeRevision) throw new Error('capture_feedback_reused');
          return dto(task);
        }
        events.add({ ...event, sequence: task.revision + 1, scopeKey, ownerKey: captureOwnerKey(event.scope) });
        if (event.expectedServerRevision !== undefined) {
          const old = await requestValue(events.index('capture').getAll([scopeKey, event.captureId])) as CaptureFeedbackEvent[];
          for (const record of old) if (record.error) events.put({ ...record, scopeKey, resolved: true });
        }
        const next = row({ ...dto(task), feedbackKind: effectiveLocalFeedback(task.feedbackKind, event.kind),
          manualFence: task.manualFence + (event.kind === 'explicit_negative' ? 1 : 0),
          reason: event.expectedServerRevision !== undefined && task.reason === 'feedback_conflict' ? 'feedback_pending' : task.reason,
          revision: task.revision + 1, updatedAt: event.occurredAt });
        tasks.put(next); return dto(next);
      });
    },
    async pendingFeedback(scope: CaptureScope): Promise<readonly CaptureFeedbackEvent[]> {
      return transaction('readonly', async tx => {
        const values = await requestValue(tx.objectStore('feedback').index('owner').getAll(captureOwnerKey(scope))) as CaptureFeedbackEvent[];
        return values.filter(value => !value.uploaded && !value.error).sort((a, b) => a.occurredAt - b.occurredAt || (a.sequence ?? 0) - (b.sequence ?? 0));
      });
    },
    async prepareFeedback(event: CaptureFeedbackEvent, expectedServerRevision: number): Promise<CaptureFeedbackEvent> {
      return transaction('readwrite', async tx => {
        const scopeKey = captureScopeKey(event.scope), events = tx.objectStore('feedback');
        const current = await requestValue(events.get([scopeKey, event.eventId])) as CaptureFeedbackEvent | undefined;
        if (!current) throw new Error('capture_feedback_missing');
        const next = { ...current, scopeKey, expectedServerRevision: current.expectedServerRevision ?? expectedServerRevision };
        events.put(next); return next;
      });
    },
    async settleFeedback(event: CaptureFeedbackEvent, result: { readonly revision?: number; readonly error?: string }): Promise<void> {
      await transaction('readwrite', async tx => {
        const scopeKey = captureScopeKey(event.scope), events = tx.objectStore('feedback'), tasks = tx.objectStore('tasks');
        const current = await requestValue(events.get([scopeKey, event.eventId])) as CaptureFeedbackEvent | undefined;
        const task = await requestValue(tasks.get([scopeKey, event.captureId])) as StoredTask | undefined;
        if (!current || !task) throw new Error('capture_feedback_missing');
        events.put({ ...current, scopeKey, uploaded: result.revision !== undefined, error: result.error });
        tasks.put(row({ ...dto(task), revision: task.revision + 1,
          feedbackServerRevision: Math.max(task.feedbackServerRevision ?? 0, result.revision ?? 0),
          reason: result.error ?? (['feedback_conflict', 'feedback_pending'].includes(task.reason ?? '') ? null : task.reason), updatedAt: Date.now() }));
      });
    },
    async adoptFeedback(task: CaptureTask, state: { revision: number; kind: CaptureTask['feedbackKind'] | null }) {
      return transaction('readwrite', async tx => {
        const scopeKey = captureScopeKey(task.scope), tasks = tx.objectStore('tasks'), events = tx.objectStore('feedback');
        const current = await requestValue(tasks.get([scopeKey, task.captureId])) as StoredTask | undefined;
        if (!current) throw new Error('capture_not_found');
        const old = await requestValue(events.index('capture').getAll([scopeKey, task.captureId])) as CaptureFeedbackEvent[];
        for (const event of old) if (!event.uploaded) events.put({ ...event, scopeKey, error: 'superseded', resolved: true });
        const next = row({ ...dto(current), feedbackKind: state.kind ?? undefined, feedbackServerRevision: state.revision,
          reason: current.reason === 'feedback_conflict' ? null : current.reason, revision: current.revision + 1, updatedAt: Date.now() });
        tasks.put(next); return dto(next);
      });
    },
    async claim(task: CaptureTask): Promise<CaptureTask> {
      return transaction('readwrite', async tx => {
        const value = row(task), tasks = tx.objectStore('tasks'), commands = tx.objectStore('commands');
        const command = await requestValue(commands.get([value.scopeKey, task.commandId])) as { captureId: string } | undefined;
        if (command) {
          const prior = await requestValue(tasks.get([value.scopeKey, command.captureId])) as StoredTask;
          if (!prior || prior.url !== task.url || prior.targetNativeId !== task.targetNativeId
            || prior.saveAnother !== task.saveAnother) throw new Error('capture_command_reused');
          return dto(prior);
        }
        const unknown = !task.saveAnother ? await requestValue(tasks.index('ownerSaveUrl').get([value.ownerKey, task.url, 'unknown'])) as StoredTask | undefined : undefined;
        if (unknown && unknown.scopeKey !== value.scopeKey) throw new Error('capture_prior_result_unknown');
        const prior = value.activeKey
          ? await requestValue(tasks.index('active').get(value.activeKey)) as StoredTask | undefined : undefined;
        if (!prior) tasks.add(value);
        commands.add({ scopeKey: value.scopeKey, commandId: task.commandId, captureId: prior?.captureId ?? task.captureId });
        return prior ? dto(prior) : task;
      });
    },
    async get(scope: CaptureScope, captureId: string): Promise<CaptureTask | null> {
      return transaction('readonly', async tx => {
        const value = await requestValue(tx.objectStore('tasks').get([captureScopeKey(scope), captureId])) as StoredTask | undefined;
        return value ? dto(value) : null;
      });
    },
    async getForOwner(scope: CaptureScope, captureId: string): Promise<CaptureTask | null> {
      return transaction('readonly', async tx => {
        const value = await requestValue(tx.objectStore('tasks').index('ownerId').get([captureOwnerKey(scope), captureId])) as StoredTask | undefined;
        return value ? dto(value) : null;
      });
    },
    async prepareReport(task: CaptureTask): Promise<CaptureTask> {
      return transaction('readwrite', async tx => {
        const tasks = tx.objectStore('tasks'), key = [captureScopeKey(task.scope), task.captureId];
        const current = await requestValue(tasks.get(key)) as StoredTask | undefined;
        if (!current) throw new Error('capture_not_found');
        const intent = current.reportIntent?.revision === current.revision ? current.reportIntent : { revision: current.revision, commandId: crypto.randomUUID() };
        const next = { ...current, reportIntent: intent, reportFailure: current.reportIntent?.revision === current.revision ? current.reportFailure : undefined }; tasks.put(next); return dto(next);
      });
    },
    async reported(task: CaptureTask, revision: number): Promise<void> {
      await transaction('readwrite', async tx => {
        const tasks = tx.objectStore('tasks'), current = await requestValue(tasks.get([captureScopeKey(task.scope), task.captureId])) as StoredTask | undefined;
        if (!current) throw new Error('capture_not_found');
        // Transport metadata must not create another report revision itself.
        tasks.put({ ...current, reportFailure: undefined, reportedRevision: Math.max(current.reportedRevision ?? -1, revision) });
      });
    },
    async reportFailure(task: CaptureTask, code?: string): Promise<void> {
      await transaction('readwrite', async tx => {
        const tasks = tx.objectStore('tasks'), current = await requestValue(tasks.get([captureScopeKey(task.scope), task.captureId])) as StoredTask | undefined;
        if (!current) throw new Error('capture_not_found');
        tasks.put({ ...current, reportFailure: code ? { revision: task.revision, code } : undefined });
      });
    },
    async listForOwner(scope: CaptureScope, before?: readonly [number, string], limit = 50): Promise<readonly CaptureTask[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('capture_page_limit');
      return transaction('readonly', async tx => {
        const key = captureOwnerKey(scope), items: CaptureTask[] = [];
        const range = IDBKeyRange.bound([key], before ? [key, ...before] : [key, []], false, Boolean(before));
        await new Promise<void>((resolve, reject) => {
          const request = tx.objectStore('tasks').index('ownerHistory').openCursor(range, 'prev');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || items.length >= limit) { resolve(); return; }
            items.push(dto(cursor.value as StoredTask)); cursor.continue();
          };
        });
        return items;
      });
    },
    async update(task: CaptureTask, expectedRevision: number): Promise<void> {
      await transaction('readwrite', async tx => {
        const value = row(task), tasks = tx.objectStore('tasks');
        const prior = await requestValue(tasks.get([value.scopeKey, task.captureId])) as StoredTask | undefined;
        if (!prior || prior.revision !== expectedRevision || task.revision !== expectedRevision + 1) throw new Error('capture_revision_conflict');
        tasks.put(value);
      });
    },
    async list(scope: CaptureScope, before?: readonly [number, string], limit = 50): Promise<readonly CaptureTask[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('capture_page_limit');
      return transaction('readonly', async tx => {
        const key = captureScopeKey(scope), items: CaptureTask[] = [];
        const range = IDBKeyRange.bound([key], before ? [key, ...before] : [key, []], false, Boolean(before));
        await new Promise<void>((resolve, reject) => {
          const request = tx.objectStore('tasks').index('history').openCursor(range, 'prev');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || items.length >= limit) { resolve(); return; }
            items.push(dto(cursor.value as StoredTask)); cursor.continue();
          };
        });
        return items;
      });
    },
    async close() { (await connection)?.close(); connection = undefined; },
  };
}
export type CaptureStore = ReturnType<typeof createCaptureStore>;
