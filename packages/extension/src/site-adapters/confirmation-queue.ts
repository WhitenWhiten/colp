import { readLimits } from './read-policy.js';
import { createLane } from '../automation/lane.js';
import { requestValue } from '../sync-state/idb.js';
import type { AdapterMessage, HostCommand, MembershipHint } from './contracts.js';
import type { SourceContext } from './ledger-types.js';
import { requireSourceAuthority, type createSourceLedger } from './ledger.js';
import { get, put, sourceDigest, sourceKey } from './source-db.js';
import type { createReadScheduler } from './read-scheduler.js';
import { installationKey } from './installation.js';
type Ledger = ReturnType<typeof createSourceLedger>;
type Command = Extract<HostCommand, { operation: 'readMemberships' | 'resolveItem' }>;
export interface ConfirmationRow {
  id: string; digest: string; origin: SourceContext; hint: MembershipHint; state: 'membership' | 'item' | 'observed' | 'uncertain';
  attempts: number; cycle?: number; known?: readonly string[]; reason?: string; observationId?: string;
  active?: { command: Command; context: SourceContext };
}
interface Ports {
  authorizeOrigin?(context: SourceContext, collectionIds: readonly string[]): Promise<void>;
  source(): Promise<{ context: SourceContext; expiresAt: number } | null>;
  send(context: SourceContext, command: Command): void;
  alarm(at: number): void;
}
const rowKey = (id: string) => sourceKey('hint', id);
/** MAIN hints can spend only a bounded, paced read. Fresh positives remain observed state. */
export function createConfirmationQueue(ledger: Ledger, scheduler: ReturnType<typeof createReadScheduler>, ports: Ports, now = Date.now) {
  const db = ledger.db, lane = createLane(), LIMITS = readLimits(ledger.definition);
  const PENDING = installationKey('confirmationQueue:v1', ledger.definition), PAUSE = installationKey('confirmationPause:v1', ledger.definition), LAST = installationKey('confirmationLast:v1', ledger.definition);
  const commandId = (r: ConfirmationRow) => r.active?.command.operation === 'resolveItem' ? r.active.command.resolutionId : r.active?.command.readRequestId;
  const same = (a: ConfirmationRow | undefined, b: ConfirmationRow) => a?.state === b.state && a.attempts === b.attempts && commandId(a) === commandId(b);
  async function settle(tx: IDBTransaction, row: ConfirmationRow) {
    put(tx, 'readRequests', rowKey(row.id), row);
    put(tx, 'meta', PENDING, (await get<string[]>(tx, 'meta', PENDING) ?? []).filter(id => id !== row.id));
    put(tx, 'meta', LAST, { id: row.id, state: row.state, reason: row.reason ?? null, observationId: row.observationId ?? null });
  }
  async function fail(row: ConfirmationRow, reason: string, pause = false) {
    await db.transaction(['meta', 'readRequests'], 'readwrite', async tx => {
      if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(row.id)), row)) throw new Error('staleContext');
      await settle(tx, { ...row, active: undefined, state: 'uncertain', reason });
      if (pause) put(tx, 'meta', PAUSE, reason);
    });
  }
  return {
    async enqueue(context: SourceContext, requestId: string, hint: MembershipHint) {
      const id = sourceDigest({ connection: context.connectionId, generation: context.installationGeneration, source: context.sourceSessionGeneration,
        document: context.documentId, requestId, ...(context.communityOrigin ? { communityOrigin: context.communityOrigin } : {}) }).slice(7), digest = sourceDigest(hint);
      return db.transaction(['meta', 'authorities', 'documentLeases', 'readRequests'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, context);
        const old = await get<ConfirmationRow>(tx, 'readRequests', rowKey(id));
        if (old) return old.digest === digest ? { status: 'duplicate' as const, receiptId: id } : { status: 'rejected' as const, reason: 'conflict' as const };
        if (await get(tx, 'meta', PAUSE)) return { status: 'rejected' as const, reason: 'paused' as const };
        const pending = await get<string[]>(tx, 'meta', PENDING) ?? [];
        if (pending.length >= LIMITS.queue || await requestValue(tx.objectStore('readRequests').count()) >= 100000) return { status: 'rejected' as const, reason: 'capacity' as const };
        const uncertain = hint.code !== 0 || !hint.added.length;
        const row: ConfirmationRow = { id, digest, origin: context, hint, state: uncertain ? 'uncertain' : 'membership', attempts: 0,
          ...(uncertain ? { reason: hint.code !== 0 ? 'siteWriteFailed' : 'negativeReadbackUnavailable' } : {}) };
        put(tx, 'readRequests', rowKey(id), row);
        if (uncertain) await settle(tx, row); else put(tx, 'meta', PENDING, [...pending, id]);
        return { status: 'accepted' as const, receiptId: id };
      });
    },
    wake: () => lane(async () => {
      if (await db.read('meta', PAUSE)) return;
      const ids = await db.read<string[]>('meta', PENDING) ?? [], id = ids[0]; if (!id) return;
      let row = await db.read<ConfirmationRow>('readRequests', rowKey(id)); if (!row) return;
      if (row.origin.communityOrigin) try { if (!ports.authorizeOrigin) throw new Error('communityArchiveRevoked'); await ports.authorizeOrigin(row.origin, row.hint.added); }
      catch { await fail(row, 'communityArchiveRevoked'); ports.alarm(now() + LIMITS.spacingMs); return; }
      if (row.active && row.active.command.deadlineAt > now()) { ports.alarm(row.active.command.deadlineAt + LIMITS.spacingMs); return; }
      if (row.attempts >= LIMITS.attempts) { await fail(row, 'pageUnavailable'); ports.alarm(now() + LIMITS.spacingMs); return; }
      const source = await ports.source(); if (!source) { ports.alarm(now() + 30000); return; }
      const c = source.context, old = row.origin;
      if (c.connectionId !== old.connectionId || c.installationGeneration !== old.installationGeneration || c.sourceSessionGeneration !== old.sourceSessionGeneration) {
        await fail(row, 'sourceChanged'); ports.alarm(now() + LIMITS.spacingMs); return;
      }
      const requestId = `${row.id}:${row.state === 'membership' ? 'm' : 'i'}:${row.cycle ?? 0}:${row.attempts}`, deadlineAt = Math.min(now() + LIMITS.commandMs, source.expiresAt - 1000);
      if (deadlineAt <= now() + LIMITS.spacingMs) { ports.alarm(now() + LIMITS.spacingMs); return; }
      const command: Command = row.state === 'membership' ? { operation: 'readMemberships', leaseId: c.leaseId, readSessionId: row.id, readRequestId: requestId,
        deadlineAt, query: { itemId: row.hint.itemId, collectionIds: row.hint.added } }
        : { operation: 'resolveItem', leaseId: c.leaseId, resolutionId: requestId, deadlineAt, url: ledger.definition.itemUrl(row.hint.itemId) ?? (() => { throw new Error('identityUnresolved'); })() };
      const acquired = await scheduler.acquire({ id: requestId, documentId: c.documentId, deadlineAt });
      if (acquired.status !== 'ready') { ports.alarm(now() + acquired.retryAfterMs); return; }
      const prior = row;
      row = { ...row, active: { command, context: c }, attempts: row.attempts + 1 };
      await db.transaction(['meta', 'readRequests', 'authorities', 'documentLeases'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, c);
        if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(id)), prior)) throw new Error('staleContext');
        put(tx, 'readRequests', rowKey(id), row);
      });
      ports.send(c, command); ports.alarm(deadlineAt + LIMITS.spacingMs);
    }),
    async accept(context: SourceContext, message: AdapterMessage) {
      if (message.operation !== 'membership.result' && message.operation !== 'item.result') return false;
      const requestId = message.operation === 'membership.result' ? message.readRequestId : message.resolutionId;
      const id = requestId.split(':')[0]!;
      const row = await db.read<ConfirmationRow>('readRequests', rowKey(id)), active = row?.active;
      if (!row || !active || message.requestId !== requestId || active.command.deadlineAt <= now() || active.context.documentId !== context.documentId
        || active.context.leaseId !== context.leaseId || (active.command.operation === 'readMemberships' ? active.command.readRequestId : active.command.resolutionId) !== requestId) return false;
      if (row.origin.communityOrigin) try { if (!ports.authorizeOrigin) throw new Error('communityArchiveRevoked'); await ports.authorizeOrigin(row.origin, row.hint.added); }
      catch { await fail(row, 'communityArchiveRevoked'); await scheduler.finish(requestId); return true; }
      const result = message.result;
      if (result.status === 'failed') {
        await fail(row, result.error.code, ['challenge', 'rateLimited', 'signedOut'].includes(result.error.code));
        await scheduler.finish(requestId, result.error.retryAfterMs); ports.alarm(now() + LIMITS.spacingMs); return true;
      }
      if (message.operation === 'membership.result' && active.command.operation === 'readMemberships') {
        const r = message.result;
        if (r.status !== 'ok' || r.itemId !== row.hint.itemId || r.edges.length !== row.hint.added.length || !r.edges.every(e => row.hint.added.includes(e.collectionId))) return false;
        const known = r.edges.filter(e => e.state === 'present').map(e => e.collectionId);
        if (!known.length) await fail(row, 'membershipUncertain');
        else await db.transaction(['readRequests', 'authorities', 'documentLeases'], 'readwrite', async tx => {
          await requireSourceAuthority(tx, context);
          if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(id)), row) || active.command.deadlineAt <= now()) throw new Error('staleContext');
          put(tx, 'readRequests', rowKey(id), { ...row, state: 'item', active: undefined, attempts: 0, known,
            ...(known.length < row.hint.added.length || row.hint.removed.length ? { reason: 'partialMembershipEvidence' } : {}) });
        });
      } else if (message.operation === 'item.result' && active.command.operation === 'resolveItem') {
        const r = message.result;
        if (r.status !== 'resolved' || r.item.id !== row.hint.itemId || !row.known?.length) await fail(row, 'identityUnresolved');
        else {
          const receipt = await ledger.acceptObservation({ ...context, ...(row.origin.communityOrigin ? { communityOrigin: row.origin.communityOrigin } : {}) }, `hint:${id}`, { type: 'membership.observed', item: r.item,
            memberships: { mode: 'delta', added: row.known, removed: [] } }, async (tx, observationId) => {
            const current = await get<ConfirmationRow>(tx, 'readRequests', rowKey(id));
            if (current?.active?.command.operation !== 'resolveItem' || current.active.command.resolutionId !== requestId) throw new Error('staleContext');
            await settle(tx, { ...current, state: 'observed', observationId, active: undefined });
          });
          if (receipt.status === 'rejected') await fail(row, receipt.reason);
        }
      } else return false;
      await scheduler.finish(requestId); ports.alarm(now() + LIMITS.spacingMs); return true;
    },
    async status() { return { pending: (await db.read<string[]>('meta', PENDING) ?? []).length,
      paused: await db.read('meta', PAUSE) ?? null, last: await db.read('meta', LAST) ?? null }; },
    async retry() {
      await db.transaction(['meta', 'readRequests'], 'readwrite', async tx => {
        const last = await get<{ id: string }>(tx, 'meta', LAST), row = last && await get<ConfirmationRow>(tx, 'readRequests', rowKey(last.id));
        const pending = await get<string[]>(tx, 'meta', PENDING) ?? [];
        if (row?.state === 'uncertain' && row.hint.code === 0 && row.hint.added.length && !['siteWriteFailed', 'negativeReadbackUnavailable', 'sourceChanged', 'conflict'].includes(row.reason ?? '')) {
          if (pending.length >= LIMITS.queue) throw new Error('capacity');
          put(tx, 'readRequests', rowKey(row.id), { ...row, state: 'membership', attempts: 0, cycle: (row.cycle ?? 0) + 1, active: undefined, known: undefined });
          put(tx, 'meta', PENDING, [...pending, row.id]);
        }
        tx.objectStore('meta').delete(PAUSE);
      });
      ports.alarm(now() + LIMITS.spacingMs);
    },
  };
}
