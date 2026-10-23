import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test, vi } from 'vitest';
import { ackEnvelope } from '../src/sync-engine-wire.js';
import { confirmNativeWait, projectNativeWaits } from '../src/native-wait.js';
import { setupT02, reopenT02, t02Scope as scope } from '../tests/srg-t02-native-harness.js';
import { vectors, type Observation } from './model-vectors.js';

const cursor = (n: number) => n === 0 ? 'cursor-old' : `model-cursor-${n}`;
const ordinal = (c: unknown) => c === 'cursor-old' || c === undefined ? 0 : Number(String(c).replace('model-cursor-', ''));

async function observe(f: Awaited<ReturnType<typeof setupT02>>): Promise<Observation> {
  const published = ordinal((await f.store.getCursor(scope))?.cursor);
  const receipts = (await f.store.listAckIntents(scope)).filter(row => row.state === 'complete');
  const pages = await f.store.listPullPages(scope, ['page_complete']);
  const rows = await Promise.all(pages.map(async page => ({
    page: ordinal(page.nextCursor), generation: scope.generation,
    settled: (await f.store.listPullEventsByPage(scope, String(page.pageId))).every(row => row.state === 'page_complete'),
  })));
  return { published, serverAck: Math.max(0, ...receipts.map(row => ordinal(row.cursor))), rows: rows.sort((a, b) => a.page - b.page) };
}

for (const trace of vectors.traces) test(`Lean/IDB lockstep: ${trace.name}`, async () => {
  let f = await setupT02();
  let pageNumber = 0;
  const waits = new Map<number, { waitRef: string; intentId: string; nativeId: string }>();
  try {
    assert.deepEqual(await observe(f), trace.initial);
    for (const [index, checkpoint] of trace.checkpoints.entries()) {
      const a = checkpoint.action;
      if (a.kind === 'publish') {
        pageNumber += 1;
        const before = f.api.calls.length;
        // Ensure completedAt establishes actual chronological retention order.
        await new Promise(resolve => setTimeout(resolve, 2));
        if (a.hasWait) f.setCrash('after_create_before_evidence');
        await f.applier.stage(f.page([f.createEvent(a.hasWait ? 'Folder' : 'Bookmark', pageNumber)], cursor(pageNumber)));
        if (a.hasWait) {
          await assert.rejects(f.applier.resume(), /worker_crash/u);
          f = await reopenT02(f);
          await assert.rejects(f.applier.resume(), /native_result_unknown/u);
          await f.applier.resume();
          const wait = (await projectNativeWaits(f.store, scope)).find(w => w.colpId === `node-created-${pageNumber}`);
          const native = f.api.calls.slice(before).find(c => c.kind === 'create')?.nativeId;
          assert.ok(wait && native);
          waits.set(pageNumber, { waitRef: wait.waitRef, intentId: wait.intentId, nativeId: native });
        } else await f.applier.resume();
      } else if (a.kind === 'ack') {
        // The HTTP/server boundary is a simulated valid receipt. The actual
        // client repository enforces publication/evidence and persists the intent.
        if (a.page !== ordinal((await f.store.getCursor(scope))?.cursor)) {
          await assert.rejects(f.store.beginAckIntent(scope, ackEnvelope('pull', 'session-t02', cursor(a.page))), /ack_cursor_not_published/u);
        } else {
          const intent = await f.store.beginAckIntent(scope, ackEnvelope('pull', 'session-t02', cursor(a.page)));
          await f.store.completeAckIntent(scope, intent.intentId, {
            replicaId: scope.replicaId, ackedCursor: cursor(a.page), ackedAt: '2026-10-18T00:00:00Z',
          });
        }
      } else if (a.kind === 'confirm') {
        const wait = waits.get(a.page); assert.ok(wait);
        const result = await confirmNativeWait({ scope, store: f.store, api: f.api,
          waitRef: wait.waitRef, intentId: wait.intentId, generation: a.generation, action: 'bind',
          ...(a.proof ? { nativeId: wait.nativeId } : {}),
        });
        if (result.ok) await f.applier.resume();
        else assert.ok(['generation_mismatch', 'request_invalid'].includes(result.code), result.code);
      } else if (a.kind === 'prune') {
        // The model abstracts time. Its prune transition starts after the
        // listener correlation grace period; fresh intents remain protected.
        const intents = await f.store.listApplyIntents(scope);
        const now = vi.spyOn(Date, 'now').mockReturnValue(Math.max(Date.now(), ...intents.map(intent => intent.expiresAt)) + 1);
        try { await f.store.prunePullHistory(scope, 1); } finally { now.mockRestore(); }
      }
      else f = await reopenT02(f);
      assert.deepEqual(await observe(f), checkpoint.expected, `${trace.name}, step ${index}: ${JSON.stringify(a)}`);
    }
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, pageNumber, 'binding an unknown call must never recreate it');
  } finally { f.store.close(); }
});
