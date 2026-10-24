import { requestValue } from '../sync-state/idb.js';
import type { MembershipReadQuery, MembershipReadResult, PageResult, SiteObservation } from './contracts.js';
import { validMembershipResult, validObservation, validPageResult } from './schemas.js';
import { validBilibiliMessage } from './bilibili/wire.js';
import { createSourceDatabase, get, put, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
import type { ImportRead, LedgerAdmission, LedgerEdge, ObservationRow, SourceAuthority, SourceConnection, SourceContext, SourceImportRun, SourceReceipt } from './ledger-types.js';
import { mergeEdge, mergeEntity, mergeObservation } from './ledger-merge.js';
import { LIMITS } from './limits.js';
const AUTHORITY = 'bundled.bilibili';
const facts = ['meta', 'authorities', 'documentLeases', 'observations', 'receipts', 'readRequests', 'items', 'collections', 'memberships'] as const;
export async function requireSourceAuthority(tx: IDBTransaction, context: SourceContext): Promise<SourceAuthority> {
  const a = await get<SourceAuthority>(tx, 'authorities', AUTHORITY);
  if (!a?.enabled || a.connectionId !== context.connectionId || a.installationGeneration !== context.installationGeneration
      || a.sourceSessionGeneration !== context.sourceSessionGeneration) throw new Error('staleContext');
  const lease = await get<{ context: SourceContext; expiresAt: number; active: boolean }>(tx, 'documentLeases', context.documentId);
  if (!lease?.active || lease.expiresAt <= Date.now() || lease.context.leaseId !== context.leaseId || lease.context.routeEpoch !== context.routeEpoch
      || lease.context.installationGeneration !== context.installationGeneration || lease.context.sourceSessionGeneration !== context.sourceSessionGeneration) throw new Error('staleContext');
  return a;
}
async function ordinal(tx: IDBTransaction): Promise<number> {
  const current = await get<number>(tx, 'meta', 'ordinal') ?? 0; put(tx, 'meta', 'ordinal', current + 1); return current + 1;
}
async function capacity(tx: IDBTransaction, store: 'observations' | 'receipts', max: number) {
  if (await requestValue(tx.objectStore(store).count()) >= max) throw new Error('capacity');
}
const rejected = (e: unknown): LedgerAdmission => ({ status: 'rejected', reason: e instanceof Error
  && ['staleContext', 'conflict', 'capacity'].includes(e.message) ? e.message as 'staleContext' | 'conflict' | 'capacity' : 'invalid' });
export function createSourceLedger(db: SourceDatabase = createSourceDatabase(), options: { now?: () => number; random?: () => string; beforeCommit?: (tx: IDBTransaction) => void } = {}) {
  const now = options.now ?? Date.now, random = options.random ?? (() => crypto.randomUUID());
  return {
    db,
    async setAuthority(input: Omit<SourceAuthority, 'connectionId'>): Promise<SourceAuthority> {
      return db.transaction(['authorities', 'connections'], 'readwrite', async tx => {
        const previous = await get<SourceAuthority>(tx, 'authorities', AUTHORITY);
        if (previous && (input.installationGeneration < previous.installationGeneration || input.sourceSessionGeneration < previous.sourceSessionGeneration)) throw new Error('staleContext');
        if (previous && input.installationGeneration === previous.installationGeneration && input.sourceSessionGeneration === previous.sourceSessionGeneration
          && (input.accountId !== previous.accountId || input.enabled !== previous.enabled)) throw new Error('conflict');
        let connectionId: string | null = null;
        if (input.accountId) {
          const key = sourceKey('bilibili', input.accountId);
          let connection = await get<SourceConnection>(tx, 'connections', key);
          if (!connection) { connection = { id: random(), siteKey: 'bilibili', accountId: input.accountId, identityVersion: 1 }; put(tx, 'connections', key, connection); }
          connectionId = connection.id;
        }
        const result = { ...input, connectionId }; put(tx, 'authorities', AUTHORITY, result); return result;
      });
    },
    async bindLease(context: SourceContext, expiresAt: number) {
      return db.transaction(['authorities', 'documentLeases'], 'readwrite', async tx => {
        const a = await get<SourceAuthority>(tx, 'authorities', AUTHORITY);
        if (!a?.enabled || a.connectionId !== context.connectionId || a.installationGeneration !== context.installationGeneration
          || a.sourceSessionGeneration !== context.sourceSessionGeneration || expiresAt <= now()) throw new Error('staleContext');
        put(tx, 'documentLeases', context.documentId, { context, expiresAt, active: true });
      });
    },
    async revokeDocuments(tabId?: number) {
      return db.transaction(['documentLeases'], 'readwrite', async tx => {
        const store = tx.objectStore('documentLeases');
        await new Promise<void>((resolve, reject) => { const r = store.openCursor(); r.onerror = () => reject(r.error);
          r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; }
            if (tabId === undefined || c.value.context.tabId === tabId) c.update({ ...c.value, active: false }); c.continue(); }; });
      });
    },
    async revokeLease(leaseId: string) {
      return db.transaction(['documentLeases'], 'readwrite', async tx => {
        const store = tx.objectStore('documentLeases');
        await new Promise<void>((resolve, reject) => { const r = store.openCursor(); r.onerror = () => reject(r.error);
          r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; }
            if (c.value.context.leaseId === leaseId) c.update({ ...c.value, active: false }); c.continue(); }; });
      });
    },
    async acceptObservation(context: SourceContext, requestId: string, observation: SiteObservation, commit?: (tx: IDBTransaction, receiptId: string) => Promise<void>): Promise<LedgerAdmission> {
      if (!validObservation(observation) || !validBilibiliMessage({ protocolVersion: 1, requestId, leaseId: context.leaseId, capability: 'host-validated', operation: 'emit', data: observation })) return { status: 'rejected', reason: 'invalid' };
      const key = sourceKey(AUTHORITY, context.installationGeneration, context.documentId, requestId), digest = sourceDigest({ operation: 'emit', observation });
      try { return await db.transaction(facts, 'readwrite', async tx => {
        await requireSourceAuthority(tx, context);
        const previous = await get<SourceReceipt>(tx, 'receipts', key);
        if (previous) {
          if (previous.digest !== digest) return { status: 'rejected', reason: 'conflict' };
          await commit?.(tx, previous.id); return { status: 'duplicate', receiptId: previous.id };
        }
        await capacity(tx, 'observations', LIMITS.pendingObservations); await capacity(tx, 'receipts', 100000);
        const receipt = { id: random(), digest, ordinal: await ordinal(tx) };
        const row: ObservationRow = { id: receipt.id, ordinal: receipt.ordinal, context, observation, state: 'pending', acceptedAt: now(), adapterVersion: '1.0.0',
          cause: observation.type === 'favorite.confirmed' || observation.type === 'favorite.uncertain' ? 'siteFavorite' : 'reconcile' };
        put(tx, 'observations', receipt.id, row); put(tx, 'receipts', key, receipt);
        await mergeObservation(tx, context, observation, receipt.ordinal, receipt.id);
        await commit?.(tx, receipt.id);
        options.beforeCommit?.(tx);
        return { status: 'accepted', receiptId: receipt.id };
      }); } catch (e) { return rejected(e); }
    },
    async startImport(context: SourceContext, id: string): Promise<SourceImportRun> {
      return db.transaction(['meta', 'authorities', 'documentLeases', 'importRuns'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, context);
        const old = await get<SourceImportRun>(tx, 'importRuns', id); if (old) throw new Error('conflict');
        const run: SourceImportRun = { id, context, baselineOrdinal: await get<number>(tx, 'meta', 'ordinal') ?? 0,
          phase: 'scanning', outstanding: null, cursor: null, coverage: 'complete', seenItems: [], seenCursors: [] };
        put(tx, 'importRuns', id, run); return run;
      });
    },
    async issuePage(request: ImportRead) {
      return db.transaction(['authorities', 'documentLeases', 'importRuns', 'readRequests'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, request.context);
        const run = await get<SourceImportRun>(tx, 'importRuns', request.runId);
        if (!run || run.phase !== 'scanning' || run.outstanding || request.deadlineAt <= now()) throw new Error('staleContext');
        const old = await get(tx, 'readRequests', request.id); if (old) throw new Error('conflict');
        put(tx, 'readRequests', request.id, { ...request, kind: 'page' }); put(tx, 'importRuns', run.id, { ...run, outstanding: request.id });
      });
    },
    async acceptPage(context: SourceContext, requestId: string, result: PageResult): Promise<LedgerAdmission> {
      if (!validPageResult(result)) return { status: 'rejected', reason: 'invalid' };
      const digest = sourceDigest(result), key = sourceKey('page', requestId);
      try { return await db.transaction([...facts, 'readRequests', 'importRuns', 'importPages'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, context);
        const request = await get<ImportRead>(tx, 'readRequests', requestId), run = request && await get<SourceImportRun>(tx, 'importRuns', request.runId);
        if (!request || !run || request.context.leaseId !== context.leaseId || request.context.documentId !== context.documentId) throw new Error('staleContext');
        const previous = await get<SourceReceipt>(tx, 'receipts', key);
        if (previous) return previous.digest === digest ? { status: 'duplicate', receiptId: previous.id } : { status: 'rejected', reason: 'conflict' };
        if (run.phase !== 'scanning' || run.outstanding !== requestId || request.deadlineAt <= now()) throw new Error('staleContext');
        if (result.status === 'ok' && (request.query.kind !== result.kind || result.kind === 'items'
          && (request.query.kind !== 'items' || request.query.collectionId !== result.collectionId))) throw new Error('invalid');
        const receipt: SourceReceipt = { id: random(), digest, ordinal: await ordinal(tx) };
        if (result.status === 'ok') {
          if (!validBilibiliMessage({ protocolVersion: 1, requestId, leaseId: context.leaseId, capability: 'host-validated', operation: 'page.result', readSessionId: run.id, pageRequestId: requestId, result })) throw new Error('invalid');
          const cursorKey = sourceKey(result.kind, result.kind === 'items' ? result.collectionId : null, result.page.nextCursor);
          if (result.page.nextCursor && (result.page.nextCursor === request.query.cursor || run.seenCursors.includes(cursorKey))) throw new Error('invalid');
          if (result.kind === 'collections') for (const c of result.page.items) await mergeEntity(tx, 'collections', context.connectionId, c, receipt.ordinal, run.baselineOrdinal);
          else for (const { item } of result.page.items) {
            await mergeEntity(tx, 'items', context.connectionId, item, receipt.ordinal, run.baselineOrdinal);
            await mergeEdge(tx, context, item.id, result.collectionId, 'present', receipt.ordinal, receipt.id, run.baselineOrdinal);
          }
          const seen = new Set([...run.seenItems, ...(result.kind === 'items' ? result.page.items.map(x => x.item.id) : [])]);
          if (seen.size > LIMITS.importItems) throw new Error('capacity');
          put(tx, 'importRuns', run.id, { ...run, seenItems: [...seen], seenCursors: result.page.nextCursor ? [...run.seenCursors, cursorKey] : run.seenCursors, cursor: result.page.nextCursor, outstanding: null,
            coverage: run.coverage === 'partial' || result.page.coverage === 'partial' ? 'partial' : 'complete' });
        } else put(tx, 'importRuns', run.id, { ...run, phase: 'stopped', coverage: 'partial', outstanding: null });
        put(tx, 'receipts', key, receipt); put(tx, 'importPages', requestId, { request, receipt, result }); options.beforeCommit?.(tx);
        return { status: 'accepted', receiptId: receipt.id };
      }); } catch (e) { return rejected(e); }
    },
    async issueMembershipRead(context: SourceContext, input: { id: string; query: MembershipReadQuery; deadlineAt: number }) {
      return db.transaction(['meta', 'authorities', 'documentLeases', 'readRequests'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, context);
        if (await get(tx, 'readRequests', input.id) || input.deadlineAt <= now()) throw new Error('conflict');
        put(tx, 'readRequests', input.id, { ...input, context, kind: 'membership', baselineOrdinal: await get<number>(tx, 'meta', 'ordinal') ?? 0 });
      });
    },
    async acceptMembershipRead(context: SourceContext, id: string, result: MembershipReadResult): Promise<LedgerAdmission> {
      try { return await db.transaction(['meta', 'authorities', 'documentLeases', 'readRequests', 'receipts', 'memberships'], 'readwrite', async tx => {
        const authority = await requireSourceAuthority(tx, context);
        const request = await get<{ kind: string; context: SourceContext; query: MembershipReadQuery; deadlineAt: number; baselineOrdinal: number }>(tx, 'readRequests', id);
        if (!request || request.kind !== 'membership' || request.context.leaseId !== context.leaseId || request.deadlineAt <= now()) throw new Error('staleContext');
        if (!validMembershipResult(result, request.query) || result.status === 'ok' && !authority.negativeReadback && result.edges.some(e => e.state === 'absent')) throw new Error('invalid');
        const key = sourceKey('membership', id), digest = sourceDigest(result), previous = await get<SourceReceipt>(tx, 'receipts', key);
        if (previous) return previous.digest === digest ? { status: 'duplicate', receiptId: previous.id } : { status: 'rejected', reason: 'conflict' };
        const receipt = { id: random(), digest, ordinal: await ordinal(tx) };
        if (result.status === 'ok') for (const edge of result.edges) {
          if (edge.state === 'unknown') continue;
          const edgeKey = sourceKey(context.connectionId, result.itemId, edge.collectionId), old = await get<LedgerEdge>(tx, 'memberships', edgeKey);
          if (old && old.ordinal > request.baselineOrdinal) continue;
          put(tx, 'memberships', edgeKey, { connectionId: context.connectionId, itemId: result.itemId, collectionId: edge.collectionId,
            state: edge.state, ordinal: receipt.ordinal, liveOrdinal: old?.liveOrdinal ?? 0, evidence: 'read', observationId: receipt.id, conflicts: [] } satisfies LedgerEdge);
        }
        put(tx, 'receipts', key, receipt); options.beforeCommit?.(tx); return { status: 'accepted', receiptId: receipt.id };
      }); } catch (e) { return rejected(e); }
    },
    async stopImport(context: SourceContext, id: string) {
      return db.transaction(['authorities', 'documentLeases', 'importRuns'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, context); const run = await get<SourceImportRun>(tx, 'importRuns', id);
        if (!run || run.context.connectionId !== context.connectionId) throw new Error('staleContext');
        put(tx, 'importRuns', id, { ...run, phase: 'stopped', outstanding: null });
      });
    },
  };
}
