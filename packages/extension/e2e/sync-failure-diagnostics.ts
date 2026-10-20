import { test, type Page } from '@playwright/test';

/** Failure-only observation. It never sends a status/resume/wake command. */
export async function withSyncFailureDetails<T>(page: Page, stage: string, task: () => Promise<T>): Promise<T> {
  return test.step(stage, async () => {
    try { return await task(); } catch (error) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const snapshot = await Promise.race([
        page.evaluate(readSyncDiagnosticSnapshot).catch(() => ({ unavailable: 'document_unavailable' })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'diagnostic_read_timeout' }), 2_000); }),
      ]).finally(() => clearTimeout(timer));
      const body = JSON.stringify({ stage, snapshot }, null, 2);
      await test.info().attach('sync-failure-state', { body, contentType: 'application/json' });
      console.log(`Sync failure state: ${body}`);
      throw error;
    }
  });
}

/** Self-contained for page.evaluate. No bookmark content, IDs, bodies or credentials leave the page. */
export async function readSyncDiagnosticSnapshot() {
  const name = 'known-phase3-indexeddb-entry';
  if (!(await indexedDB.databases()).some(row => row.name === name)) return { unavailable: 'database_missing' };
  const request = indexedDB.open(name);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const names = ['sync_scopes', 'sync_engine', 'bootstrap_runs', 'bootstrap_advanced_plans', 'bootstrap_advanced_steps',
      'outbound_queue', 'receipts', 'apply_intents', 'ack_intents', 'bookmark_events', 'mount_bindings',
      'boundary_confirmation_commands', 'native_mappings', 'diagnostics', 'recovery_staging', 'pull_pages', 'pull_events']
      .filter(store => db.objectStoreNames.contains(store));
    const tx = db.transaction(names, 'readonly');
    type Row = Record<string, any>;
    const all = Object.fromEntries(await Promise.all(names.map(async store => {
      const read = tx.objectStore(store).getAll();
      const rows = await new Promise<Row[]>((resolve, reject) => {
        read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
      });
      return [store, rows] as const;
    })));
    const code = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/u.test(value) ? value : undefined;
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const count = (rows: Row[], key: string) => rows.reduce<Record<string, number>>((counts, row) => {
      const state = code(row[key]) ?? 'unspecified'; counts[state] = (counts[state] ?? 0) + 1; return counts;
    }, {});
    // A frozen or expired live replica is precisely what a failed convergence
    // check needs to show. Only retired archives belong outside this snapshot.
    return { lifecycleCounts: count(all.sync_scopes ?? [], 'lifecycle'),
      scopes: (all.sync_scopes ?? []).filter(scope => scope.lifecycle !== 'retired').map(scope => {
      const rows = (store: string) => (all[store] ?? []).filter(row => row.scopeKey === scope.scopeKey);
      const engine = rows('sync_engine')[0];
      return {
        lifecycle: code(scope.lifecycle), firstRun: code(scope.firstRun), rootStatus: code(scope.rootStatus), recoveryCode: code(scope.metadata?.recoveryCode),
        generation: number(scope.generation), selectedCount: scope.selectedRoots?.length, privateCount: scope.privateRoots?.length,
        engine: engine ? { phase: code(engine.phase), error: code(engine.lastError), frozen: engine.recoveryFrozen === true,
          authorityRefreshRequired: engine.authorityRefreshRequired === true, cursorPresent: typeof engine.lastPublishedCursor === 'string',
          cursorsEqual: engine.lastPublishedCursor === engine.lastAckedCursor } : null,
        bootstrap: rows('bootstrap_runs').map(row => ({ phase: code(row.phase), mode: code(row.bootstrapMode),
          retryReason: code(row.retryReason), resumeCursor: code(row.resumeCursor), updatedAt: number(row.updatedAt) })),
        advancedPlans: rows('bootstrap_advanced_plans').map(row => ({ state: code(row.state), error: code(row.error) })),
        advancedSteps: rows('bootstrap_advanced_steps').map(row => ({ state: code(row.state), error: code(row.error),
          operation: code(row.definition?.operation), side: code(row.definition?.side), action: code(row.definition?.action),
          order: number(row.order), evidencePresent: !!row.evidence })),
        queue: count(rows('outbound_queue'), 'status'),
        unsettledQueue: rows('outbound_queue').filter(row => row.status !== 'terminal').slice(0, 30).map(row => ({
          sequence: number(row.sequence), type: code(row.payload?.type), status: code(row.status), recovery: code(row.recovery?.code),
          attempts: number(row.retry?.attempt), notBefore: number(row.retry?.notBefore), hasTransportAttempt: !!row.attempt,
          dependencyCount: row.payload?.dependencies?.length })),
        receipts: rows('receipts').length, intents: rows('apply_intents').map(row => ({ state: code(row.state),
          kind: code(row.liveWorkKind), apiPhase: code(row.apiPhase), nativeResult: code(row.nativeResult),
          waitReason: code(row.waitReason), confirmation: code(row.nativeResultConfirmation?.kind) })),
        ack: count(rows('ack_intents'), 'state'), captures: count(rows('bookmark_events'), 'status'),
        mounts: rows('mount_bindings').map(row => ({ status: code(row.status), role: code(row.rootRole),
          bound: typeof row.remoteMountNodeId === 'string', materialized: row.materialized === true })),
        boundaryCommands: rows('boundary_confirmation_commands').map(row => ({ state: code(row.state),
          kind: code(row.kind), error: code(row.error), completedSteps: Array.isArray(row.completedSteps) ? row.completedSteps.map(code) : [] })),
        mappings: rows('native_mappings').length, diagnostics: count(rows('diagnostics'), 'code'),
        recovery: rows('recovery_staging').map(row => ({ phase: code(row.phase), complete: row.complete === true })),
        pullPages: count(rows('pull_pages'), 'state'), pullEvents: count(rows('pull_events'), 'state'),
      };
    }) };
  } finally { db.close(); }
}
