import type { CaptureExistence, CaptureLocation, CaptureScope, CaptureTask, SyncState } from './contracts.js';
import { transitionCapture } from './state.js';
import type { CaptureStore } from './store.js';

export interface CaptureReceipt { readonly nativeId: string; readonly location: CaptureLocation; readonly sync: SyncState; readonly savedAt?: number; readonly nativeDateAdded?: number; readonly reuseMode?: 'reuse' | 'suggest' | 'reclassify' }
export interface CapturePorts {
  readonly store: CaptureStore;
  now(): number;
  assertCurrent(scope: CaptureScope, task?: CaptureTask): Promise<void>;
  existence(task: CaptureTask): Promise<CaptureExistence>;
  create(task: CaptureTask, reserved: (intentId: string) => Promise<void>, saved: (receipt: CaptureReceipt) => Promise<void>): Promise<CaptureReceipt>;
  receipt(task: CaptureTask): Promise<CaptureReceipt | null>;
  acknowledge?(task: CaptureTask): Promise<void | boolean>;
}

export function createCaptureCoordinator(ports: CapturePorts) {
  const running = new Map<string, Promise<CaptureTask>>();
  async function run(scope: CaptureScope, id: string): Promise<CaptureTask> {
    let task = await ports.store.get(scope, id);
    if (!task) throw new Error('capture_not_found');
    await ports.assertCurrent(scope, task!);
    const acknowledge = async () => {
      const persisted = await ports.acknowledge?.(task!);
      if (task!.save === 'local-saved' && task!.annotation && !task!.annotationPersisted && persisted === true) {
        await ports.assertCurrent(scope, task!);
        const next = { ...task!, annotationPersisted: true, revision: task!.revision + 1, updatedAt: ports.now() };
        await ports.store.update(next, task!.revision); task = next;
      }
    };
    const update = async (next: CaptureTask) => {
      await ports.assertCurrent(scope, task!);
      await ports.store.update(next, task!.revision); task = next;
      // Saved consumes the identity; a terminal failure has no receipt to keep,
      // so both release consumer retention instead of holding it until its TTL.
      if (next.save === 'local-saved' || next.save === 'failed') await acknowledge();
    };
    if (task.disposition !== 'new' || task.save === 'failed') return task;
    if (task.save === 'local-saved' && task.annotation && !task.annotationPersisted) { await acknowledge(); return task; }
    if (task.save === 'unknown') {
      const receipt = await ports.receipt(task);
      if (receipt) await update(transitionCapture(task, { kind: 'saved', ...receipt }, ports.now()));
      return task;
    }
    if (task.save !== 'unsubmitted') return task;
    const existence = await ports.existence(task);
    await update(transitionCapture(task, { kind: 'existence', result: existence, saveAnother: task.saveAnother }, ports.now()));
    if (task.disposition !== 'new') return task;
    if (existence.coverage.local !== 'complete') {
      await update(transitionCapture(task, { kind: 'save-failed', reason: 'existence_unavailable' }, ports.now()));
      return task;
    }
    let receiptSaved = false;
    try {
      await ports.assertCurrent(scope, task!);
      const receipt = await ports.create(task, async intentId => {
        await update(transitionCapture(task!, { kind: 'submitted', intentId }, ports.now()));
      }, async receipt => { await update(transitionCapture(task!, { kind: 'saved', ...receipt }, ports.now())); receiptSaved = true; });
      if (!receiptSaved) await update(transitionCapture(task, { kind: 'saved', ...receipt }, ports.now()));
    } catch (error) {
      // After the durable reservation, even an exception may mean native success.
      if (task.save === 'unsubmitted') {
        await update(transitionCapture(task, { kind: 'save-failed', reason: 'native_save_unavailable' }, ports.now()));
      } else if (task.save !== 'unknown' && task.save !== 'local-saved') throw error;
    }
    return task;
  }
  return {
    async start(task: CaptureTask) {
      await ports.assertCurrent(task.scope, task);
      return ports.store.claim(task);
    },
    resume(scope: CaptureScope, id: string): Promise<CaptureTask> {
      const key = JSON.stringify([scope, id]);
      const existing = running.get(key);
      if (existing) return existing;
      const promise = run(scope, id).finally(() => running.delete(key));
      running.set(key, promise); return promise;
    },
  };
}
