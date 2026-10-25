import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createReconcileRuns, type ReconcileRunPorts } from '../src/site-adapters/reconcile-run.js';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import type { ReconcilePreview } from '../src/site-adapters/reconcile-model.js';
const preview: ReconcilePreview = { version: 1, id: 'preview', importId: 'import', digest: 'frozen', createdAt: 1, policyRevision: 1,
  context: { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', tabId: 1, routeEpoch: 0 }, snapshots: [],
  differences: [{ id: 'personal', collectionId: 'saved', itemId: null, kind: 'personal', title: 'Personal', choices: ['keep', 'move'] }] };
const scope = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', authorityGeneration: 1 };
async function fixture() {
  const db = createSourceDatabase(new IDBFactory());
  const ports: ReconcileRunPorts = { authorize: vi.fn(async () => {}), prepare: vi.fn(async () => ({ id: 'immutable' })),
    execute: vi.fn<ReconcileRunPorts['execute']>(async (_r, _o, recover) => recover ? null : { receipt: { id: 'receipt' } }), finish: vi.fn(async () => {}), schedule: vi.fn() };
  const runs = createReconcileRuns(db, ports); return { db, ports, runs, approve: () => runs.approve(preview, scope, [{ id: 'personal', choice: 'move', destinationId: 'history' }]) };
}
test('approval freezes only allowed explicit choices and repeating it does not create another run', async () => {
  const f = await fixture(); try {
    await expect(f.runs.approve(preview, scope, [{ id: 'personal', choice: 'restore' }])).rejects.toThrow('invalidReconcileChoice');
    await expect(f.runs.approve(preview, scope, [{ id: 'personal', choice: 'move' }])).rejects.toThrow('reconcileDestinationRequired');
    await f.approve(); await f.approve(); await f.runs.wake();
    expect(f.ports.prepare).toHaveBeenCalledOnce(); expect(f.ports.finish).toHaveBeenCalledOnce();
    expect((await f.runs.status(preview.id))?.state).toBe('completed');
    await expect(f.runs.approve(preview, scope, [{ id: 'personal', choice: 'keep' }])).rejects.toThrow('reconcileAlreadyApproved');
  } finally { await f.db.close(); }
});
test('a lost reply recovers the exact durable command instead of dispatching another move', async () => {
  const f = await fixture(); try {
    vi.mocked(f.ports.execute).mockResolvedValueOnce(null).mockResolvedValueOnce({ receipt: { id: 'original-receipt' } });
    await f.approve(); await f.runs.wake(); const command = (await f.runs.status(preview.id))!.operations[0]!.command;
    await f.runs.wake(); expect(f.ports.prepare).toHaveBeenCalledOnce();
    expect(f.ports.execute).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ command }), true, false);
    expect((await f.runs.status(preview.id))?.operations[0]?.state).toBe('completed');
  } finally { await f.db.close(); }
});
test('cancelled work recovers an issued receipt without sending an unissued operation', async () => {
  const f = await fixture(); try {
    vi.mocked(f.ports.execute).mockResolvedValueOnce(null).mockResolvedValueOnce({ receipt: { id: 'late' } });
    await f.approve(); await f.runs.wake(); await f.runs.cancel(preview.id); await f.runs.wake();
    expect(f.ports.execute).toHaveBeenCalledTimes(2); expect(f.ports.execute).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), true, false);
    expect((await f.runs.status(preview.id))?.state).toBe('cancelled');
  } finally { await f.db.close(); }
});
test('one conflicting item retains its command and requires explicit retry', async () => {
  const f = await fixture(); try {
    vi.mocked(f.ports.execute).mockRejectedValueOnce(new Error('source_reconcile_conflict'));
    await f.approve(); await f.runs.wake(); await f.runs.wake(); expect(f.ports.execute).toHaveBeenCalledOnce();
    expect((await f.runs.status(preview.id))?.operations[0]).toMatchObject({ state: 'attention', reason: 'source_reconcile_conflict', command: { id: 'immutable' } });
  } finally { await f.db.close(); }
});
test('undo keeps the original receipt and receives its own durable command', async () => {
  const f = await fixture(); try {
    await f.approve(); await f.runs.wake(); const op = (await f.runs.status(preview.id))!.operations[0]!;
    await f.runs.undo(preview.id, op.id);
    expect((await f.runs.status(preview.id))?.operations[0]).toMatchObject({ state: 'undone', receipt: { id: 'receipt' }, undoReceipt: { id: 'receipt' }, undoCommand: { id: 'immutable' } });
  } finally { await f.db.close(); }
});
test('undoing a completed operation after cancellation can resume without reopening cancelled forward work', async () => {
  const f = await fixture(); try {
    await f.approve(); await f.runs.wake(); await f.runs.cancel(preview.id);
    const op = (await f.runs.status(preview.id))!.operations[0]!;
    vi.mocked(f.ports.execute).mockClear().mockResolvedValueOnce(null);
    await f.runs.undo(preview.id, op.id);
    expect((await f.runs.status(preview.id))?.operations[0]?.state).toBe('pending');
    await f.runs.wake();
    expect((await f.runs.status(preview.id))?.operations[0]?.state).toBe('undone');
    expect((await f.runs.status(preview.id))?.state).toBe('cancelled');
    expect(vi.mocked(f.ports.execute).mock.calls.every(call => call[3] === true)).toBe(true);
  } finally { await f.db.close(); }
});
test('cancelling an in-progress undo permits receipt recovery but no further dispatch', async () => {
  const f = await fixture(); try {
    await f.approve(); await f.runs.wake();
    const op = (await f.runs.status(preview.id))!.operations[0]!;
    vi.mocked(f.ports.execute).mockClear().mockResolvedValue(null);
    await f.runs.undo(preview.id, op.id); await f.runs.cancel(preview.id);
    vi.mocked(f.ports.execute).mockClear(); await f.runs.wake();
    expect(f.ports.execute).toHaveBeenCalledOnce(); expect(f.ports.execute).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), true, true);
  } finally { await f.db.close(); }
});
test('history is paged independently of the wake queue and completed checks do not block new work', async () => {
  const f = await fixture(); try {
    for (let n = 0; n < 27; n++) await f.runs.approve({ ...preview, id: `old-${n}`, createdAt: n + 1 }, scope, []);
    const page = await f.runs.history('source');
    expect(page.runs).toHaveLength(25); expect(page.runs[0]).toMatchObject({ id: 'old-26', state: 'completed' });
    expect((await f.runs.history('source', page.next!)).runs).toHaveLength(2);
    await expect(f.runs.history('another-source', page.next!)).rejects.toThrow('invalid');
    await f.approve(); await f.runs.wake(); expect(f.ports.prepare).toHaveBeenCalledOnce();
    expect((await f.runs.status(preview.id))?.state).toBe('completed');
  } finally { await f.db.close(); }
});
