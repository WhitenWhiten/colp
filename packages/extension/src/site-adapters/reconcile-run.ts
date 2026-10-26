import type { CaptureScope } from '../capture/contracts.js';
import { sourceDigest, type SourceDatabase } from './source-db.js';
import type { ReconcileDecision, ReconcileDifference, ReconcilePreview } from './reconcile-model.js';
import { createLane } from '../automation/lane.js';
import { createReconcileRecords } from './reconcile-records.js';
export interface ReconcileOperation {
  id: string; difference: ReconcileDifference; decision: ReconcileDecision; command?: unknown; receipt?: unknown;
  state: 'pending' | 'completed' | 'attention' | 'undone'; reason: string | null; undoCommand?: unknown;
  undoPending?: boolean; undoAuthorized?: boolean; undoReceipt?: unknown;
  revisions?: ReconcileDecision[]; sequence?: number;
}
export interface ReconcileRun {
  id: string; preview: ReconcilePreview; scope: CaptureScope; state: 'approved' | 'completed' | 'cancelled';
  operations: ReconcileOperation[]; updatedAt: number; operationCursor?: number; operationsPartial?: boolean; totalOperations?: number; progress?: { completed: number; attention: number; pending: number; undone: number };
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
    await save(run, [op]);
    await ports.finish(run, op, undo);
    op.state = undo ? 'undone' : 'completed'; op.undoPending = false; op.reason = null;
    await save(run, [op]);
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
        await save(run, [op]); // The immutable command exists before any mutation.
      }
      const result = await ports.execute(run, op, false, undo);
      if (!result) throw new Error('sourceSyncPending'); if (undo) op.undoReceipt = result.receipt; else op.receipt = result.receipt;
      await finish(run, op, undo); return;
    } catch (e) { op.reason = e instanceof Error ? e.message : 'sourceReconcileUnavailable'; op.state = op.reason === 'sourceSyncPending' ? 'pending' : 'attention'; }
    await save(run, [op]);
  }
  return {
    approve: (preview: ReconcilePreview, scope: CaptureScope, decisions: readonly ReconcileDecision[]) => lane(async () => {
      const old = await records.load(preview.id, true);
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
      const queues = runs.map(run => {
        const start = run.operationsPartial ? 0 : (run.operationCursor ?? 0) % Math.max(1, run.operations.length);
        const ordered = run.operations.map((op, index) => ({ op, index: op.sequence ?? index }));
        const operations = [...ordered.slice(start), ...ordered.slice(0, start)].filter(({ op }) =>
          op.state === 'pending' && (run.state === 'approved' || op.undoPending && op.undoAuthorized)
          || run.state === 'cancelled' && ['pending', 'attention'].includes(op.state) && op.command);
        return { run, operations };
      });
      // Give every run a turn before revisiting one, and persist an operation cursor
      // so waiting work cannot monopolize the next wake after worker reconstruction.
      for (let round = 0; budget > 0 && queues.some(q => q.operations[round]); round++) {
        for (const { run, operations } of queues) {
          const next = operations[round]; if (!next || budget <= 0) continue;
          budget--; const { op, index } = next; run.operationCursor = index + 1;
          if (run.state === 'approved' || op.undoPending && op.undoAuthorized) await advance(run, op, op.undoPending);
          else {
            try {
              const receipt = op.undoPending ? op.undoReceipt : op.receipt;
              const result = receipt ? { receipt } : await ports.execute(run, op, true, !!op.undoPending);
              if (result) {
                if (op.undoPending) op.undoReceipt = result.receipt; else op.receipt = result.receipt;
                await finish(run, op, !!op.undoPending);
              }
            } catch (e) { op.reason = e instanceof Error ? e.message : 'sourceReconcileUnavailable'; }
            await save(run, [op]);
          }
        }
      }
      for (const run of runs) {
        if (run.state !== 'cancelled' && (run.progress ? !run.progress.pending && !run.progress.attention : !run.operations.some(op => op.state === 'pending' || op.state === 'attention'))) {
          run.state = 'completed'; await save(run);
        }
        if (run.progress?.pending || run.operations.some(op => op.state === 'pending' && (run.state === 'approved' || op.undoPending && op.undoAuthorized)
          || run.state === 'cancelled' && ['pending', 'attention'].includes(op.state) && op.command)) ports.schedule();
      }
      if (runs.length === 10) ports.schedule();
    }),
    retry: (id: string, destinationId?: string) => lane(async () => { const run = await records.load(id); if (!run) throw new Error('reconcileRunMissing');
      const eligible = run.operations.filter(op => op.state === 'attention' && (run.state !== 'cancelled' || op.undoPending));
      for (const op of eligible) {
        await ports.authorize(run, !!op.undoPending);
        if (!op.command && destinationId && ['move', 'archive'].includes(op.decision.choice)) { op.revisions = [...op.revisions ?? [], op.decision]; op.decision = { ...op.decision, destinationId }; }
        op.state = 'pending'; if (op.undoPending) op.undoAuthorized = true;
      } if (run.state !== 'cancelled') run.state = 'approved'; await save(run, eligible); ports.schedule(); }),
    cancel: (id: string) => lane(async () => { const run = await records.load(id); if (run) { run.state = 'cancelled'; for (const op of run.operations) op.undoAuthorized = false; await save(run, run.operations); } }),
    undo: (id: string, operationId: string) => lane(async () => { const run = await records.load(id), op = run?.operations.find(o => o.id === operationId);
      if (!run || !op || !['completed', 'undone'].includes(op.state)) throw new Error('reconcileRunMissing'); if (op.state === 'undone') return;
      await ports.authorize(run, true); op.undoPending = true; op.undoAuthorized = true; op.state = 'pending'; await save(run, [op]); await advance(run, op, true); ports.schedule(); }),
    current: records.load,
    view: records.view,
    status: (id: string) => records.load(id, true),
    history: records.history,
  };
}
