import type { CaptureScope } from '../capture/contracts.js';
import { sourceDigest, type SourceDatabase } from './source-db.js';
import type { ReconcileDecision, ReconcileDifference, ReconcilePreview } from './reconcile-model.js';
import { createLane } from '../automation/lane.js';
import { createReconcileRecords, reconcileRunKey as key } from './reconcile-records.js';
export interface ReconcileOperation {
  id: string; difference: ReconcileDifference; decision: ReconcileDecision; command?: unknown; receipt?: unknown;
  state: 'pending' | 'completed' | 'attention' | 'undone'; reason: string | null; undoCommand?: unknown;
  undoPending?: boolean; undoAuthorized?: boolean; undoReceipt?: unknown;
  revisions?: ReconcileDecision[];
}
export interface ReconcileRun {
  id: string; preview: ReconcilePreview; scope: CaptureScope; state: 'approved' | 'completed' | 'cancelled';
  operations: ReconcileOperation[]; updatedAt: number;
}
export interface ReconcileRunPorts {
  authorize(run: ReconcileRun, undo?: boolean): Promise<void>;
  prepare(run: ReconcileRun, op: ReconcileOperation, undo: boolean): Promise<unknown>;
  execute(run: ReconcileRun, op: ReconcileOperation, recover: boolean, undo: boolean): Promise<{ receipt: unknown } | null>;
  finish(run: ReconcileRun, op: ReconcileOperation, undo: boolean): Promise<void>;
  schedule(): void;
}
export function createReconcileRuns(db: SourceDatabase, ports: ReconcileRunPorts) {
  const lane = createLane(), records = createReconcileRecords(db), save = records.save;
  async function finish(run: ReconcileRun, op: ReconcileOperation, undo: boolean) {
    // Retain the exact result before updating associations or acknowledging the native executor.
    await save(run);
    await ports.finish(run, op, undo);
    op.state = undo ? 'undone' : 'completed'; op.undoPending = false; op.reason = null;
    await save(run);
  }
  async function advance(run: ReconcileRun, op: ReconcileOperation, undo = false) {
    try {
      if (undo ? op.undoReceipt : op.receipt) { await finish(run, op, undo); return; }
      const command = undo ? op.undoCommand : op.command;
      if (command) {
        const found = await ports.execute(run, op, true, undo);
        if (found) { if (undo) op.undoReceipt = found.receipt; else op.receipt = found.receipt; await finish(run, op, undo); return; }
      }
      await ports.authorize(run, undo);
      if (!command) {
        const prepared = await ports.prepare(run, op, undo); if (undo) op.undoCommand = prepared; else op.command = prepared;
        await save(run); // The immutable command exists before any mutation.
      }
      const result = await ports.execute(run, op, false, undo);
      if (!result) throw new Error('sourceSyncPending'); if (undo) op.undoReceipt = result.receipt; else op.receipt = result.receipt;
      await finish(run, op, undo); return;
    } catch (e) { op.reason = e instanceof Error ? e.message : 'sourceReconcileUnavailable'; op.state = op.reason === 'sourceSyncPending' ? 'pending' : 'attention'; }
    await save(run);
  }
  return {
    approve: (preview: ReconcilePreview, scope: CaptureScope, decisions: readonly ReconcileDecision[]) => lane(async () => {
      const old = await db.read<ReconcileRun>('meta', key(preview.id));
      if (old) { if (sourceDigest(old.preview) !== sourceDigest(preview)) throw new Error('previewStale');
        const normalized = (input: readonly ReconcileDecision[]) => [...input].filter(d => d.choice !== 'keep').sort((a, b) => a.id.localeCompare(b.id));
        if (sourceDigest(normalized(old.operations.map(o => o.decision))) !== sourceDigest(normalized(decisions))) throw new Error('reconcileAlreadyApproved'); return old; }
      const selected = new Set<string>(), operations: ReconcileOperation[] = [];
      for (const decision of decisions) {
        const difference = preview.differences.find(d => d.id === decision.id);
        if (!difference || selected.has(decision.id) || !difference.choices.includes(decision.choice)) throw new Error('invalidReconcileChoice'); selected.add(decision.id);
        if (decision.choice === 'adopt' && !difference.candidates?.some(n => n.native.nativeId === decision.nativeId)) throw new Error('invalidReconcileChoice');
        if (['move', 'archive'].includes(decision.choice) && !decision.destinationId) throw new Error('reconcileDestinationRequired');
        if (decision.choice !== 'keep') operations.push({ id: crypto.randomUUID(), decision, difference, state: 'pending', reason: null });
      }
      const run: ReconcileRun = { id: preview.id, preview, scope, operations, state: 'approved', updatedAt: Date.now() };
      await ports.authorize(run); await save(run); ports.schedule(); return run;
    }),
    wake: () => lane(async () => {
      const runs = await records.wakePage(); let budget = 10;
      for (const run of runs) if (run.state === 'approved' || run.operations.some(op => op.undoPending && op.undoAuthorized)) {
        for (const op of run.operations) if (op.state === 'pending' && (run.state === 'approved' || op.undoPending && op.undoAuthorized) && budget-- > 0) await advance(run, op, op.undoPending);
        if (run.state !== 'cancelled' && !run.operations.some(op => op.state === 'pending' || op.state === 'attention')) { run.state = 'completed'; await save(run); }
        if (run.operations.some(op => op.state === 'pending' && (run.state === 'approved' || op.undoPending && op.undoAuthorized))) ports.schedule();
        if (budget <= 0) { ports.schedule(); break; }
      }
      for (const run of runs) if (run.state === 'cancelled') for (const op of run.operations) if (['pending', 'attention'].includes(op.state) && op.command && budget-- > 0) {
        try { const receipt = op.undoPending ? op.undoReceipt : op.receipt;
          const result = receipt ? { receipt } : await ports.execute(run, op, true, !!op.undoPending); if (result) {
          if (op.undoPending) op.undoReceipt = result.receipt; else op.receipt = result.receipt;
          await finish(run, op, !!op.undoPending);
        } } catch (e) { op.reason = e instanceof Error ? e.message : 'sourceReconcileUnavailable'; await save(run); }
      }
      if (runs.length === 10 && budget <= 0) ports.schedule();
    }),
    retry: (id: string, destinationId?: string) => lane(async () => { const run = await db.read<ReconcileRun>('meta', key(id)); if (!run) throw new Error('reconcileRunMissing');
      const eligible = run.operations.filter(op => op.state === 'attention' && (run.state !== 'cancelled' || op.undoPending));
      for (const op of eligible) {
        await ports.authorize(run, !!op.undoPending);
        if (!op.command && destinationId && ['move', 'archive'].includes(op.decision.choice)) { op.revisions = [...op.revisions ?? [], op.decision]; op.decision = { ...op.decision, destinationId }; }
        op.state = 'pending'; if (op.undoPending) op.undoAuthorized = true;
      } if (run.state !== 'cancelled') run.state = 'approved'; await save(run); ports.schedule(); }),
    cancel: (id: string) => lane(async () => { const run = await db.read<ReconcileRun>('meta', key(id)); if (run) { run.state = 'cancelled'; for (const op of run.operations) op.undoAuthorized = false; await save(run); } }),
    undo: (id: string, operationId: string) => lane(async () => { const run = await db.read<ReconcileRun>('meta', key(id)), op = run?.operations.find(o => o.id === operationId);
      if (!run || !op || !['completed', 'undone'].includes(op.state)) throw new Error('reconcileRunMissing'); if (op.state === 'undone') return;
      await ports.authorize(run, true); op.undoPending = true; op.undoAuthorized = true; op.state = 'pending'; await save(run); await advance(run, op, true); ports.schedule(); }),
    status: (id: string) => db.read<ReconcileRun>('meta', key(id)),
    history: records.history,
  };
}
