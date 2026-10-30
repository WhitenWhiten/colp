import { validMembershipResult } from './schemas.js';
import { createConfirmationRetry } from './confirmation-retry.js';
import { readLimits } from './read-policy.js';
import { createLane } from '../automation/lane.js';
import type { AdapterMessage, HostCommand, MembershipHint } from './contracts.js';
import type { SourceContext } from './ledger-types.js';
import { requireSourceAuthority, type createSourceLedger } from './ledger.js';
import { get, put, sourceDigest, sourceKey } from './source-db.js';
import type { createReadScheduler } from './read-scheduler.js';
import { installationKey } from './installation.js';
import type { ActivitySink } from './activity.js';
type Ledger = ReturnType<typeof createSourceLedger>;
type Command = Extract<HostCommand, { operation: 'readMemberships' | 'resolveItem' }>;
export interface ConfirmationRow {
  id: string; digest: string; origin: SourceContext; hint: MembershipHint; state: 'membership' | 'item' | 'observed' | 'uncertain';
  attempts: number; sourceWaitUntil?: number; cycle?: number; known?: readonly string[]; absent?: readonly string[]; baselineOrdinal?: number; reason?: string; observationId?: string;
  active?: { command: Command; context: SourceContext };
  retryRequested?: 1;
}
interface Ports {
  activity?: ActivitySink;
  source(origin?: SourceContext): Promise<{ context: SourceContext; expiresAt: number } | null>;
  send(context: SourceContext, command: Command): void;
  alarm(at: number): void;
}
const rowKey = (id: string) => sourceKey('hint', id);
/** MAIN hints can spend only a bounded, paced read. Fresh positives remain observed state. */
export function createConfirmationQueue(ledger: Ledger, scheduler: ReturnType<typeof createReadScheduler>, ports: Ports, now = Date.now) {
  const db = ledger.db, lane = createLane(), LIMITS = readLimits(ledger.definition);
  const PENDING = installationKey('confirmationQueue:v1', ledger.definition), PAUSE = installationKey('confirmationPause:v1', ledger.definition), LAST = installationKey('confirmationLast:v1', ledger.definition);
  const scope = (hint: MembershipHint) => [...hint.added, ...(ledger.definition.negativeReadback ? hint.removed : [])];
  const retries = createConfirmationRetry(db, ledger.definition.adapterId, PENDING, LIMITS.queue, hint => scope(hint).length > 0);
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
    await ports.activity?.record({ kind: 'problem', operation: 'inspect', taskId: row.id, connectionId: row.origin.connectionId,
      collectionId: scope(row.hint)[0], requestId: commandId(row), code: reason }).catch(() => undefined);
  }
  return {
    async enqueue(context: SourceContext, requestId: string, hint: MembershipHint) {
      const id = sourceDigest({ connection: context.connectionId, generation: context.installationGeneration, source: context.sourceSessionGeneration,
        document: context.documentId, requestId }).slice(7), digest = sourceDigest(hint);
      return db.transaction(['meta', 'authorities', 'documentLeases', 'readRequests'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, context);
        const old = await get<ConfirmationRow>(tx, 'readRequests', rowKey(id));
        if (old) return old.digest === digest ? { status: 'duplicate' as const, receiptId: id } : { status: 'rejected' as const, reason: 'conflict' as const };
        if (await get(tx, 'meta', PAUSE)) return { status: 'rejected' as const, reason: 'paused' as const };
        const pending = await get<string[]>(tx, 'meta', PENDING) ?? [];
        // Completed read receipts remain available for exact replay; only active confirmations occupy the queue.
        if (pending.length >= LIMITS.queue) return { status: 'rejected' as const, reason: 'capacity' as const };
        const uncertain = hint.code !== 0 || !scope(hint).length;
        const row: ConfirmationRow = { id, digest, origin: context, hint, state: uncertain ? 'uncertain' : 'membership', attempts: 0,
          ...(uncertain ? { reason: hint.code !== 0 ? 'siteWriteFailed' : 'negativeReadbackUnavailable' } : {}) };
        put(tx, 'readRequests', rowKey(id), row);
        if (uncertain) await settle(tx, row); else put(tx, 'meta', PENDING, [...pending, id]);
        return { status: 'accepted' as const, receiptId: id };
      });
    },
    wake: () => lane(async () => {
      if (await db.read('meta', PAUSE)) return;
      const moreRetries = await retries.fill();
      const ids = await db.read<string[]>('meta', PENDING) ?? [], id = ids[0];
      if (!id) { if (moreRetries) ports.alarm(now() + LIMITS.spacingMs); return; }
      let row = await db.read<ConfirmationRow>('readRequests', rowKey(id)); if (!row) return;
      if (row.origin.communityOrigin) { await fail(row, 'communityArchiveRevoked'); ports.alarm(now() + LIMITS.spacingMs); return; }
      if (row.active && row.active.command.deadlineAt > now()) { ports.alarm(row.active.command.deadlineAt + LIMITS.spacingMs); return; }
      if (row.attempts >= LIMITS.commandAttempts) { await fail(row, 'pageUnavailable'); ports.alarm(now() + LIMITS.spacingMs); return; }
      const source = await ports.source(row.origin);
      if (!source) {
        const until = row.sourceWaitUntil ?? now() + LIMITS.commandMs;
        if (until <= now()) { await fail(row, 'pageUnavailable'); ports.alarm(now() + LIMITS.spacingMs); return; }
        const waiting = row;
        await db.transaction(['readRequests'], 'readwrite', async tx => {
          if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(id)), waiting)) throw new Error('staleContext');
          put(tx, 'readRequests', rowKey(id), { ...waiting, sourceWaitUntil: until });
        });
        ports.alarm(Math.min(until, now() + LIMITS.spacingMs)); return;
      }
      const c = source.context, old = row.origin;
      if (c.connectionId !== old.connectionId || c.installationGeneration !== old.installationGeneration || c.sourceSessionGeneration !== old.sourceSessionGeneration) {
        await fail(row, 'sourceChanged'); ports.alarm(now() + LIMITS.spacingMs); return;
      }
      if (ledger.definition.readScope !== 'account' && (c.documentId !== old.documentId || c.tabId !== old.tabId || c.routeEpoch !== old.routeEpoch)) {
        await fail(row, 'navigationChanged'); ports.alarm(now() + LIMITS.spacingMs); return;
      }
      const requestId = `${row.id}:${row.state === 'membership' ? 'm' : 'i'}:${row.cycle ?? 0}:${row.attempts}`, deadlineAt = Math.min(now() + LIMITS.commandMs, source.expiresAt - 1000);
      if (deadlineAt <= now() + LIMITS.spacingMs) { ports.alarm(now() + LIMITS.spacingMs); return; }
      const command: Command = row.state === 'membership' ? { operation: 'readMemberships', leaseId: c.leaseId, readSessionId: row.id, readRequestId: requestId,
        deadlineAt, query: { itemId: row.hint.itemId, collectionIds: scope(row.hint) } }
        : { operation: 'resolveItem', leaseId: c.leaseId, resolutionId: requestId, deadlineAt, url: ledger.definition.itemUrl(row.hint.itemId) ?? (() => { throw new Error('identityUnresolved'); })() };
      const acquired = await scheduler.acquire({ id: requestId, documentId: c.documentId, deadlineAt });
      if (acquired.status !== 'ready') { ports.alarm(now() + acquired.retryAfterMs); return; }
      const prior = row;
      row = { ...row, sourceWaitUntil: undefined, active: { command, context: c }, attempts: row.attempts + 1 };
      await db.transaction(['meta', 'readRequests', 'authorities', 'documentLeases'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, c);
        if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(id)), prior)) throw new Error('staleContext');
        if (command.operation === 'readMemberships') {
          row.baselineOrdinal = await get<number>(tx, 'meta', 'ordinal') ?? 0;
          put(tx, 'readRequests', requestId, { kind: 'membership', id: requestId, context: c, query: command.query, deadlineAt, baselineOrdinal: row.baselineOrdinal });
        }
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
      if (row.origin.communityOrigin) { await fail(row, 'communityArchiveRevoked'); await scheduler.finish(requestId); return true; }
      const result = message.result;
      if (result.status === 'failed') {
        if (['network', 'timeout'].includes(result.error.code) && row.attempts < LIMITS.commandAttempts) {
          await db.transaction(['readRequests'], 'readwrite', async tx => {
            if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(id)), row)) throw new Error('staleContext');
            put(tx, 'readRequests', rowKey(id), { ...row, active: undefined, reason: result.error.code });
          });
          const wait = Math.max(LIMITS.spacingMs, result.error.retryAfterMs ?? LIMITS.backoffMs);
          await scheduler.finish(requestId, wait); ports.alarm(now() + wait); return true;
        }
        await fail(row, result.error.code, ['challenge', 'rateLimited', 'signedOut'].includes(result.error.code));
        await scheduler.finish(requestId, result.error.retryAfterMs); ports.alarm(now() + LIMITS.spacingMs); return true;
      }
      if (message.operation === 'membership.result' && active.command.operation === 'readMemberships') {
        const r = message.result;
        if (r.status !== 'ok' || message.readSessionId !== active.command.readSessionId || !validMembershipResult(r, active.command.query)
          || !ledger.definition.negativeReadback && r.edges.some(e => e.state === 'absent')) return false;
        // Older in-flight rows lack a baseline; retry instead of granting authoritative merge semantics.
        if (row.baselineOrdinal === undefined) { await fail(row, 'readBaselineMissing'); await scheduler.finish(requestId); return true; }
        if (r.edges.some(e => e.state === 'unknown') && row.attempts < LIMITS.commandAttempts) {
          await db.transaction(['readRequests'], 'readwrite', async tx => {
            const current = await get<ConfirmationRow>(tx, 'readRequests', rowKey(id));
            if (!same(current, row)) throw new Error('staleContext');
            put(tx, 'readRequests', rowKey(id), { ...row, active: undefined, reason: 'membershipUncertain' });
          });
          await scheduler.finish(requestId); ports.alarm(now() + LIMITS.spacingMs); return true;
        }
        const known = r.edges.filter(e => e.state === 'present').map(e => e.collectionId), absent = r.edges.filter(e => e.state === 'absent').map(e => e.collectionId);
        if (!known.length && !absent.length) await fail(row, 'membershipUncertain');
        else if (!known.length) {
          const receipt = await ledger.acceptMembershipRead(context, requestId, r, async tx => {
            if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(id)), row)) throw new Error('staleContext');
            await settle(tx, { ...row, state: 'observed', active: undefined, reason: r.edges.some(e => e.state === 'unknown') ? 'partialMembershipEvidence' : undefined });
          });
          if (receipt.status === 'rejected') await fail(row, receipt.reason);
        } else await db.transaction(['readRequests', 'authorities', 'documentLeases'], 'readwrite', async tx => {
          await requireSourceAuthority(tx, context);
          if (!same(await get<ConfirmationRow>(tx, 'readRequests', rowKey(id)), row) || active.command.deadlineAt <= now()) throw new Error('staleContext');
          put(tx, 'readRequests', rowKey(id), { ...row, state: 'item', active: undefined, attempts: 0, known, absent,
            ...(known.length + absent.length < row.hint.added.length + row.hint.removed.length ? { reason: 'partialMembershipEvidence' } : {}) });
        });
      } else if (message.operation === 'item.result' && active.command.operation === 'resolveItem') {
        const r = message.result;
        if (r.status !== 'resolved' || r.item.id !== row.hint.itemId || !row.known?.length || row.baselineOrdinal === undefined) await fail(row, 'identityUnresolved');
        else {
          const receipt = await ledger.acceptReadObservation(context, `hint:${id}`, { type: 'membership.observed', item: r.item,
            memberships: { mode: 'delta', added: row.known, removed: row.absent ?? [] } }, row.baselineOrdinal!, async (tx, observationId) => {
            const current = await get<ConfirmationRow>(tx, 'readRequests', rowKey(id));
            if (current?.active?.command.operation !== 'resolveItem' || current.active.command.resolutionId !== requestId) throw new Error('staleContext');
            await settle(tx, { ...current, state: 'observed', observationId, active: undefined });
          });
          if (receipt.status === 'rejected') await fail(row, receipt.reason);
        }
      } else return false;
      const after = await db.read<ConfirmationRow>('readRequests', rowKey(id));
      if (after?.state === 'observed') await ports.activity?.resolve(row.id, 'inspect').catch(() => undefined);
      await scheduler.finish(requestId); ports.alarm(now() + LIMITS.spacingMs); return true;
    },
    async status() { return { pending: (await db.read<string[]>('meta', PENDING) ?? []).length + await retries.waiting(),
      paused: await db.read('meta', PAUSE) ?? null, last: await db.read('meta', LAST) ?? null }; },
    async retry(id?: string) {
      await retries.request(PAUSE, id); await retries.fill();
      ports.alarm(now() + LIMITS.spacingMs);
    },
  };
}
