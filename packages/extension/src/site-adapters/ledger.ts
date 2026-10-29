import { requestValue } from '../sync-state/idb.js';
import { documentLeaseKey } from './document-leases.js';
import type { MembershipReadQuery, MembershipReadResult, PageResult, SiteObservation, SiteCollection } from './contracts.js';
import { validMembershipResult, validObservation, validPageResult } from './schemas.js';
import { legacySite, type SiteDefinition } from './registry.js';
import { createSourceDatabase, get, put, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
import type { ImportRead, LedgerAdmission, ObservationRow, SourceAuthority, SourceConnection, SourceContext, SourceImportRun, SourceReceipt } from './ledger-types.js';
import { mergeReadEdges, mergeEdge, mergeEntity, mergeObservation } from './ledger-merge.js';
import { LIMITS } from './limits.js';
export async function authorityForConnection(tx: IDBTransaction, connectionId: string): Promise<SourceAuthority | undefined> {
  return new Promise((resolve, reject) => {
    const request = tx.objectStore('authorities').openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const c = request.result;
      if (!c) { resolve(undefined); return; }
      if ((c.value as SourceAuthority).connectionId === connectionId) { resolve(c.value as SourceAuthority); return; }
      c.continue();
    };
  });
}
export const readConnectionAuthority = (db: SourceDatabase, connectionId: string) => db.transaction(['authorities'], 'readonly', tx => authorityForConnection(tx, connectionId));
const facts = ['meta', 'authorities', 'documentLeases', 'observations', 'receipts', 'readRequests', 'items', 'collections', 'memberships'] as const;
export async function requireSourceAuthority(tx: IDBTransaction, context: SourceContext): Promise<SourceAuthority> {
  const a = await authorityForConnection(tx, context.connectionId);
  if (!a?.enabled || (a.installationId ?? legacySite.adapterId) !== (context.installationId ?? legacySite.adapterId) || a.connectionId !== context.connectionId || a.installationGeneration !== context.installationGeneration
      || a.sourceSessionGeneration !== context.sourceSessionGeneration) throw new Error('staleContext');
  const lease = await get<{ context: SourceContext; expiresAt: number; active: boolean }>(tx, 'documentLeases', documentLeaseKey(context));
  if (!lease?.active || lease.context.connectionId !== context.connectionId || lease.expiresAt <= Date.now() || lease.context.leaseId !== context.leaseId || lease.context.routeEpoch !== context.routeEpoch
      || lease.context.installationGeneration !== context.installationGeneration || lease.context.sourceSessionGeneration !== context.sourceSessionGeneration) throw new Error('staleContext');
  return a;
}
async function ordinal(tx: IDBTransaction): Promise<number> {
  const current = await get<number>(tx, 'meta', 'ordinal') ?? 0; put(tx, 'meta', 'ordinal', current + 1); return current + 1;
}
async function admitObservation(tx: IDBTransaction) {
  const count = await pendingObservations(tx);
  if (count >= LIMITS.pendingObservations) throw new Error('capacity');
  put(tx, 'meta', 'pendingObservations', count + 1);
}
async function pendingObservations(tx: IDBTransaction): Promise<number> {
  const store = tx.objectStore('observations');
  return await requestValue(store.count()) - await requestValue(store.index('state').count('settled'));
}
/** Settling work retains its receipt and complete facts; it frees only pending admission capacity. */
export async function settleSourceObservation(db: SourceDatabase, id: string, result: { reason: string; planIds: readonly string[]; edges?: readonly { collectionId: string; status: string }[]; problem?: string }) {
  await db.transaction(['observations', 'meta', 'work'], 'readwrite', async tx => {
    const row = await get<ObservationRow>(tx, 'observations', id); if (!row || row.state === 'settled') return;
    const count = await pendingObservations(tx);
    put(tx, 'observations', id, { ...row, state: 'settled', planning: result }); put(tx, 'meta', 'pendingObservations', Math.max(0, count - 1));
    if (result.problem) put(tx, 'work', `observation:${row.id}`, { id: `observation:${row.id}`, connectionId: row.context.connectionId,
      dueAt: Number.MAX_SAFE_INTEGER, attempts: 0, reason: result.problem });
  });
}
const rejected = (e: unknown): LedgerAdmission => ({ status: 'rejected', reason: e instanceof Error
  && ['staleContext', 'conflict', 'capacity'].includes(e.message) ? e.message as 'staleContext' | 'conflict' | 'capacity' : 'invalid' });
export function createSourceLedger(db: SourceDatabase = createSourceDatabase(), options: { now?: () => number; random?: () => string; beforeCommit?: (tx: IDBTransaction) => void } = {}, definition: SiteDefinition = legacySite) {
  const AUTHORITY = definition.adapterId;
  const requireAuthority = (tx: IDBTransaction, context: SourceContext) => {
    if ((context.installationId ?? legacySite.adapterId) !== definition.adapterId) throw new Error('staleContext');
    return requireSourceAuthority(tx, context);
  };
  const now = options.now ?? Date.now, random = options.random ?? (() => crypto.randomUUID());
  async function acceptObservation(context: SourceContext, requestId: string, observation: SiteObservation, commit?: (tx: IDBTransaction, receiptId: string) => Promise<void>, readBaseline?: number, hostCatalog = false): Promise<LedgerAdmission> {
    if (!validObservation(observation) || !hostCatalog && !definition.validateMessage({ protocolVersion: 1, requestId, leaseId: context.leaseId, capability: 'host-validated', operation: 'emit', data: observation })) return { status: 'rejected', reason: 'invalid' };
    const key = sourceKey(AUTHORITY, context.installationGeneration, context.documentId, requestId), digest = sourceDigest({ operation: 'emit', observation });
    try { return await db.transaction(facts, 'readwrite', async tx => {
      await requireAuthority(tx, context);
      const previous = await get<SourceReceipt>(tx, 'receipts', key);
      if (previous) {
        if (previous.digest !== digest) return { status: 'rejected', reason: 'conflict' };
        await commit?.(tx, previous.id); return { status: 'duplicate', receiptId: previous.id };
      }
      // Receipts are retained replay evidence, not outstanding work. They never consume admission slots.
      await admitObservation(tx);
      const receipt = { id: random(), digest, ordinal: await ordinal(tx) };
      if (readBaseline !== undefined) {
        const authority = await requireAuthority(tx, context);
        if (observation.type !== 'membership.observed' || observation.memberships.mode !== 'delta' || !Number.isSafeInteger(readBaseline) || readBaseline < 0
          || !authority.negativeReadback && observation.memberships.removed.length) throw new Error('invalid');
        const applied = await mergeReadEdges(tx, context, observation.item.id, observation.memberships, readBaseline, receipt.ordinal, receipt.id);
        observation = { ...observation, memberships: { mode: 'delta', ...applied } };
      }
      const row: ObservationRow = { installationId: definition.adapterId, id: receipt.id, ordinal: receipt.ordinal, context, observation, state: 'pending', acceptedAt: now(), adapterVersion: definition.version,
        readyAt: 0, cause: observation.type === 'favorite.confirmed' || observation.type === 'favorite.uncertain' ? 'siteFavorite' : 'reconcile' };
      put(tx, 'observations', receipt.id, row); put(tx, 'receipts', key, receipt);
      // A single-list site's list is host-authored. A live save before the first import still needs it to plan.
      const single = definition.defaultCollection;
      if (single && (observation.type === 'favorite.confirmed' || observation.type === 'membership.observed')
        && (observation.memberships.mode === 'delta' ? observation.memberships.added : observation.memberships.collectionIds).includes(single.id)
        && !await get(tx, 'collections', sourceKey(context.connectionId, single.id))) await mergeEntity(tx, 'collections', context.connectionId, single, receipt.ordinal, undefined, context);
      if (readBaseline === undefined) await mergeObservation(tx, context, observation, receipt.ordinal, receipt.id);
      else if (observation.type === 'membership.observed') await mergeEntity(tx, 'items', context.connectionId, observation.item, receipt.ordinal, readBaseline);
      await commit?.(tx, receipt.id);
      options.beforeCommit?.(tx);
      return { status: 'accepted', receiptId: receipt.id };
    }); } catch (e) { return rejected(e); }
  }
  return {
    db, definition,
    async setAuthority(input: Omit<SourceAuthority, 'connectionId'>): Promise<SourceAuthority> {
      return db.transaction(['authorities', 'connections'], 'readwrite', async tx => {
        const previous = await get<SourceAuthority>(tx, 'authorities', AUTHORITY);
        if (previous && (input.installationGeneration < previous.installationGeneration || input.sourceSessionGeneration < previous.sourceSessionGeneration)) throw new Error('staleContext');
        if (previous && input.installationGeneration === previous.installationGeneration && input.sourceSessionGeneration === previous.sourceSessionGeneration
          && (input.accountId !== previous.accountId || input.enabled !== previous.enabled)) throw new Error('conflict');
        let connectionId: string | null = null;
        if (input.accountId) {
          if (!definition.validateAccount(input.accountId)) throw new Error('invalid');
          const key = sourceKey(definition.siteKey, definition.identityVersion, input.accountId);
          let connection = await get<SourceConnection>(tx, 'connections', key);
          const legacyKey = sourceKey(definition.siteKey, input.accountId);
          if (!connection) {
            const previous = await get<SourceConnection>(tx, 'connections', legacyKey);
            if (previous?.siteKey === definition.siteKey && previous.identityVersion === definition.identityVersion) {
              connection = previous; put(tx, 'connections', key, previous); tx.objectStore('connections').delete(legacyKey);
            }
          }
          if (!connection) { connection = { id: random(), siteKey: definition.siteKey, accountId: input.accountId, identityVersion: definition.identityVersion }; put(tx, 'connections', key, connection); }
          connectionId = connection.id;
        }
        const result = { ...input, installationId: definition.adapterId, connectionId }; put(tx, 'authorities', AUTHORITY, result); return result;
      });
    },
    async bindLease(context: SourceContext, expiresAt: number) {
      return db.transaction(['authorities', 'documentLeases'], 'readwrite', async tx => {
        const a = await authorityForConnection(tx, context.connectionId);
        if (!a?.enabled || (a.installationId ?? legacySite.adapterId) !== (context.installationId ?? legacySite.adapterId) || a.connectionId !== context.connectionId || a.installationGeneration !== context.installationGeneration
          || a.sourceSessionGeneration !== context.sourceSessionGeneration || expiresAt <= now()) throw new Error('staleContext');
        if ((context.installationId ?? legacySite.adapterId) !== definition.adapterId) throw new Error('staleContext');
        put(tx, 'documentLeases', documentLeaseKey(context), { context, expiresAt, active: true });
      });
    },
    async revokeDocuments(tabId?: number) {
      return db.transaction(['documentLeases'], 'readwrite', async tx => {
        const store = tx.objectStore('documentLeases');
        await new Promise<void>((resolve, reject) => { const r = store.openCursor(); r.onerror = () => reject(r.error);
          r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; }
            if ((c.value.context.installationId ?? legacySite.adapterId) === definition.adapterId && (tabId === undefined || c.value.context.tabId === tabId)) c.update({ ...c.value, active: false }); c.continue(); }; });
      });
    },
    async revokeLease(leaseId: string) {
      return db.transaction(['documentLeases'], 'readwrite', async tx => {
        const store = tx.objectStore('documentLeases');
        await new Promise<void>((resolve, reject) => { const r = store.openCursor(); r.onerror = () => reject(r.error);
          r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; }
            if ((c.value.context.installationId ?? legacySite.adapterId) === definition.adapterId && c.value.context.leaseId === leaseId) c.update({ ...c.value, active: false }); c.continue(); }; });
      });
    },
    acceptObservation: (context: SourceContext, requestId: string, observation: SiteObservation, commit?: (tx: IDBTransaction, receiptId: string) => Promise<void>) => acceptObservation(context, requestId, observation, commit),
    /** Host ingestion of a catalog already validated as a page result or current source facts; no emit capability is required. */
    acceptCatalog: (context: SourceContext, requestId: string, collections: readonly SiteCollection[]) => {
      if (collections.some(c => !definition.validateCollection(c.id) || c.parentId != null && !definition.validateCollection(c.parentId))) return Promise.resolve<LedgerAdmission>({ status: 'rejected', reason: 'invalid' });
      return acceptObservation(context, requestId, { type: 'catalog.upsert', collections }, undefined, undefined, true);
    },
    /** Host-correlated read only: the baseline is captured durably before dispatch, never supplied by page code. */
    acceptReadObservation: (context: SourceContext, requestId: string, observation: Extract<SiteObservation, { type: 'membership.observed' }>, baseline: number, commit?: (tx: IDBTransaction, receiptId: string) => Promise<void>) => acceptObservation(context, requestId, observation, commit, baseline),
    async startImport(context: SourceContext, id: string): Promise<SourceImportRun> {
      return db.transaction(['meta', 'authorities', 'documentLeases', 'importRuns'], 'readwrite', async tx => {
        await requireAuthority(tx, context);
        const old = await get<SourceImportRun>(tx, 'importRuns', id); if (old) throw new Error('conflict');
        const run: SourceImportRun = { id, context, baselineOrdinal: await get<number>(tx, 'meta', 'ordinal') ?? 0,
          phase: 'scanning', outstanding: null, cursor: null, coverage: 'complete', seenItems: [], seenCursors: [] };
        put(tx, 'importRuns', id, run); return run;
      });
    },
    async issuePage(request: ImportRead) {
      return db.transaction(['authorities', 'documentLeases', 'importRuns', 'readRequests'], 'readwrite', async tx => {
        await requireAuthority(tx, request.context);
        const run = await get<SourceImportRun>(tx, 'importRuns', request.runId);
        if (!run || run.context.connectionId !== request.context.connectionId || run.context.installationGeneration !== request.context.installationGeneration
          || run.context.sourceSessionGeneration !== request.context.sourceSessionGeneration || run.phase !== 'scanning' || run.outstanding || request.deadlineAt <= now()) throw new Error('staleContext');
        const old = await get(tx, 'readRequests', request.id); if (old) throw new Error('conflict');
        put(tx, 'readRequests', request.id, { ...request, kind: 'page' }); put(tx, 'importRuns', run.id, { ...run, outstanding: request.id });
      });
    },
    async acceptPage(context: SourceContext, requestId: string, result: PageResult, commit?: (tx: IDBTransaction, receipt: SourceReceipt) => Promise<void>): Promise<LedgerAdmission> {
      if (!validPageResult(result)) return { status: 'rejected', reason: 'invalid' };
      const digest = sourceDigest(result), key = sourceKey('page', requestId);
      try { return await db.transaction([...facts, 'readRequests', 'importRuns', 'importPages'], 'readwrite', async tx => {
        await requireAuthority(tx, context);
        const request = await get<ImportRead>(tx, 'readRequests', requestId), run = request && await get<SourceImportRun>(tx, 'importRuns', request.runId);
        if (!request || !run || request.context.leaseId !== context.leaseId || request.context.documentId !== context.documentId) throw new Error('staleContext');
        const previous = await get<SourceReceipt>(tx, 'receipts', key);
        if (previous) return previous.digest === digest ? { status: 'duplicate', receiptId: previous.id } : { status: 'rejected', reason: 'conflict' };
        if (run.phase !== 'scanning' || run.outstanding !== requestId || request.deadlineAt <= now()) throw new Error('staleContext');
        if (result.status === 'ok' && (request.query.kind !== result.kind || result.kind === 'items'
          && (request.query.kind !== 'items' || request.query.collectionId !== result.collectionId))) throw new Error('invalid');
        const receipt: SourceReceipt = { id: random(), digest, ordinal: await ordinal(tx) };
        if (result.status === 'ok') {
          if (!definition.validateMessage({ protocolVersion: 1, requestId, leaseId: context.leaseId, capability: 'host-validated', operation: 'page.result', readSessionId: run.id, pageRequestId: requestId, result })) throw new Error('invalid');
          const cursorKey = sourceKey(result.kind, result.kind === 'items' ? result.collectionId : null, result.page.nextCursor);
          if (result.page.nextCursor && (result.page.nextCursor === request.query.cursor || run.seenCursors.includes(cursorKey))) throw new Error('invalid');
          if (result.kind === 'collections') for (const c of result.page.items) await mergeEntity(tx, 'collections', context.connectionId, c, receipt.ordinal, run.baselineOrdinal, context);
          else for (const { item } of result.page.items) {
            await mergeEntity(tx, 'items', context.connectionId, item, receipt.ordinal, run.baselineOrdinal);
            await mergeEdge(tx, context, item.id, result.collectionId, 'present', receipt.ordinal, receipt.id, run.baselineOrdinal);
          }
          const seen = new Set([...run.seenItems, ...(result.kind === 'items' ? result.page.items.map(x => x.item.id) : [])]);
          if (seen.size > LIMITS.importItems) throw new Error('capacity');
          put(tx, 'importRuns', run.id, { ...run, seenItems: [...seen], seenCursors: result.page.nextCursor ? [...run.seenCursors, cursorKey] : run.seenCursors, cursor: result.page.nextCursor, outstanding: null,
            coverage: run.coverage === 'partial' || result.page.coverage === 'partial' ? 'partial' : 'complete' });
        } else put(tx, 'importRuns', run.id, { ...run, phase: 'stopped', coverage: 'partial', outstanding: null });
        put(tx, 'receipts', key, receipt); put(tx, 'importPages', requestId, { request, receipt, result });
        await commit?.(tx, receipt); options.beforeCommit?.(tx);
        return { status: 'accepted', receiptId: receipt.id };
      }); } catch (e) { return rejected(e); }
    },
    async issueMembershipRead(context: SourceContext, input: { id: string; query: MembershipReadQuery; deadlineAt: number }) {
      return db.transaction(['meta', 'authorities', 'documentLeases', 'readRequests'], 'readwrite', async tx => {
        await requireAuthority(tx, context);
        if (await get(tx, 'readRequests', input.id) || input.deadlineAt <= now()) throw new Error('conflict');
        put(tx, 'readRequests', input.id, { ...input, context, kind: 'membership', baselineOrdinal: await get<number>(tx, 'meta', 'ordinal') ?? 0 });
      });
    },
    async acceptMembershipRead(context: SourceContext, id: string, result: MembershipReadResult, commit?: (tx: IDBTransaction, receipt: SourceReceipt) => Promise<void>): Promise<LedgerAdmission> {
      try { return await db.transaction(['meta', 'authorities', 'documentLeases', 'readRequests', 'receipts', 'memberships'], 'readwrite', async tx => {
        const authority = await requireAuthority(tx, context);
        const request = await get<{ kind: string; context: SourceContext; query: MembershipReadQuery; deadlineAt: number; baselineOrdinal: number }>(tx, 'readRequests', id);
        if (!request || request.kind !== 'membership' || request.context.leaseId !== context.leaseId || request.deadlineAt <= now()) throw new Error('staleContext');
        if (!validMembershipResult(result, request.query) || result.status === 'ok' && !authority.negativeReadback && result.edges.some(e => e.state === 'absent')) throw new Error('invalid');
        const key = sourceKey('membership', id), digest = sourceDigest(result), previous = await get<SourceReceipt>(tx, 'receipts', key);
        if (previous) return previous.digest === digest ? { status: 'duplicate', receiptId: previous.id } : { status: 'rejected', reason: 'conflict' };
        const receipt = { id: random(), digest, ordinal: await ordinal(tx) };
        if (result.status === 'ok') await mergeReadEdges(tx, context, result.itemId, {
          added: result.edges.filter(e => e.state === 'present').map(e => e.collectionId),
          removed: result.edges.filter(e => e.state === 'absent').map(e => e.collectionId),
        }, request.baselineOrdinal, receipt.ordinal, receipt.id);
        put(tx, 'receipts', key, receipt); await commit?.(tx, receipt); options.beforeCommit?.(tx); return { status: 'accepted', receiptId: receipt.id };
      }); } catch (e) { return rejected(e); }
    },
    async stopImport(context: SourceContext, id: string) {
      return db.transaction(['authorities', 'documentLeases', 'importRuns'], 'readwrite', async tx => {
        await requireAuthority(tx, context); const run = await get<SourceImportRun>(tx, 'importRuns', id);
        if (!run || run.context.connectionId !== context.connectionId) throw new Error('staleContext');
        put(tx, 'importRuns', id, { ...run, phase: 'stopped', outstanding: null });
      });
    },
  };
}
