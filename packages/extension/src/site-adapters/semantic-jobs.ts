import { createLane } from '../automation/lane.js';
import { cursorPage, requestValue, iterateCursor } from '../sync-state/idb.js';
import type { CaptureScope } from '../capture/contracts.js';
import type { ManagedContent } from './copy-identity.js';
import type { SemanticClaim, ManagedReference } from './managed-client.js';
import type { NativeBinding } from './contracts.js';
import type { PlannedNativeCommand, PlannedNativeResult } from './planned-types.js';
import { get, put, sourceKey, sourceDigest, type SourceDatabase } from './source-db.js';
export interface SemanticSource { connectionId: string; policyRevision: number; installationGeneration: number; sourceSessionGeneration: number }
export interface SemanticInput {
  scopeId: string; scope: CaptureScope; content: ManagedContent; title: string; url: string; source: SemanticSource;
}
export interface SemanticSelection { folder: NativeBinding<'folder'>; tags: string[]; destinationDigest: string }
export interface SemanticJob extends Omit<SemanticInput, 'source'> {
  id: string; connections: string[]; sources: SemanticSource[];
  state: 'pending' | 'attention' | 'completed' | 'suppressed'; step: 'queued' | 'waiting' | 'classifying' | 'classified' | 'saving';
  providerCommandId: string; claim?: SemanticClaim; selection?: SemanticSelection; command?: PlannedNativeCommand;
  native?: NativeBinding<'bookmark'>; written?: { title: string; parentId: string; url: string }; reason: string | null; updatedAt: number; controlRevision: number;
}
export type SemanticExisting = { status: 'missing' | 'waiting' | 'suppressed' | 'detached' }
  | { status: 'saved'; native: NativeBinding<'bookmark'>; written: { title: string; parentId: string; url: string }; shared?: ManagedReference };
export interface SemanticPorts {
  authorize(job: SemanticJob): Promise<void>;
  existing(job: SemanticJob): Promise<SemanticExisting>;
  claim(job: SemanticJob): Promise<{ status: 'claimed'; claim?: SemanticClaim } | { status: 'waiting'; claim: SemanticClaim }>;
  release(job: SemanticJob): Promise<void>;
  beforeClassify?(job: SemanticJob): Promise<void>;
  classify(job: SemanticJob): Promise<SemanticSelection>;
  prepare(job: SemanticJob, selection: SemanticSelection): Promise<PlannedNativeCommand>;
  execute(job: SemanticJob, recover: boolean): Promise<PlannedNativeResult | null>;
  finish(job: SemanticJob, native: NativeBinding<'bookmark'>, written: { title: string; parentId: string; url: string }, shared?: ManagedReference): Promise<void>;
  schedule(): void;
}
export const semanticIndexKey = (scopeId: string, content: ManagedContent) => sourceKey(scopeId, content.site, content.identityVersion, content.accountId, content.itemId);
const waiting = new Set(['sourceSyncPending', 'sourceSyncRecovering', 'semanticOtherDevice', 'semanticOffline', 'local_call_in_progress']);
/** One durable task per content/library. Collection copies and classification failures are independent. */
export function createSemanticJobs(db: SourceDatabase, ports: SemanticPorts) {
  const enqueueLane = createLane(); let running: Promise<void> | undefined;
  const save = async (job: SemanticJob) => { await db.transaction(['semanticJobs'], 'readwrite', async tx => {
    const current = await get<SemanticJob>(tx, 'semanticJobs', job.id);
    if (!current || current.controlRevision !== job.controlRevision) throw new Error('semanticJobChanged');
    put(tx, 'semanticJobs', job.id, { ...job, sources: current.sources, connections: current.connections, updatedAt: Date.now() });
  }); };
  async function complete(job: SemanticJob, native: NativeBinding, written?: { title: string; parentId: string; url?: string }, shared?: ManagedReference) {
    if (native.kind !== 'bookmark' || !written?.parentId) throw new Error('semanticReceiptInvalid');
    await ports.finish(job, native as NativeBinding<'bookmark'>, { title: written.title, parentId: written.parentId, url: written.url ?? job.url }, shared);
    await save({ ...job, native: native as NativeBinding<'bookmark'>, written: { title: written.title, parentId: written.parentId, url: written.url ?? job.url }, state: 'completed', reason: null });
  }
  async function advance(original: SemanticJob) {
    let job = original;
    try {
      if (job.step === 'saving' && job.command) {
        const recovered = await ports.execute(job, true);
        if (recovered?.status === 'confirmed') { await complete(job, recovered.native, recovered.written); return; }
        if (recovered) throw new Error(recovered.reason);
      }
      await ports.authorize(job);
      if (!job.command) {
        const existing = await ports.existing(job);
        if (existing.status === 'saved') { await complete(job, existing.native, existing.written, existing.shared); return; }
        if (existing.status === 'suppressed') { await save({ ...job, state: 'suppressed', reason: 'sourceCopySuppressed' }); return; }
        if (existing.status === 'detached') throw new Error('sourceCopyDetached');
        if (existing.status === 'waiting') throw new Error('sourceSyncPending');
      }
      if (job.step === 'classifying') throw new Error('semanticResultUnknown');
      if (!job.selection && !job.command) {
        const claim = await ports.claim(job);
        job = { ...job, claim: claim.claim };
        if (claim.status === 'waiting') { await save({ ...job, step: 'waiting', reason: 'semanticOtherDevice' }); ports.schedule(); return; }
        await ports.beforeClassify?.(job);
        job = { ...job, step: 'classifying', reason: null }; await save(job);
        const selection = await ports.classify(job);
        job = { ...job, step: 'classified', selection }; await save(job); await ports.authorize(job);
      }
      if (!job.command) {
        job = { ...job, command: await ports.prepare(job, job.selection!), step: 'saving' }; await save(job);
      }
      await ports.authorize(job);
      const result = await ports.execute(job, false);
      if (result?.status === 'confirmed') { await complete(job, result.native, result.written); return; }
      throw new Error(result?.reason ?? 'semanticReceiptUnknown');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'semanticUnavailable';
      if (reason === 'semanticJobChanged') return;
      await save({ ...job, ...(['local_call_in_progress', 'semanticOffline'].includes(reason) && job.step === 'classifying' ? { step: 'queued' as const } : {}),
        state: reason === 'sourceCopySuppressed' ? 'suppressed' : waiting.has(reason) ? 'pending' : 'attention', reason }).catch(e => { if (!(e instanceof Error) || e.message !== 'semanticJobChanged') throw e; });
      if (waiting.has(reason)) ports.schedule();
    }
  }
  return {
    enqueue: (input: SemanticInput) => enqueueLane(async () => {
      const changed = await db.transaction(['semanticJobs', 'semanticIndexes'], 'readwrite', async tx => {
        const index = semanticIndexKey(input.scopeId, input.content), id = await get<string>(tx, 'semanticIndexes', index);
        const old = id && await get<SemanticJob>(tx, 'semanticJobs', id);
        if (old) {
          const previous = old.sources.find(s => s.connectionId === input.source.connectionId);
          if (previous && sourceDigest(previous) === sourceDigest(input.source)) return false;
          const sources = previous ? old.sources.map(s => s.connectionId === input.source.connectionId ? input.source : s) : [...old.sources, input.source];
          put(tx, 'semanticJobs', old.id, { ...old, sources, connections: sources.map(s => s.connectionId) }); return old.state === 'pending';
        }
        const active = tx.objectStore('semanticJobs').index('stateUpdatedAt');
        const count = async (state: string) => requestValue(active.count(IDBKeyRange.bound([state, 0], [state, Number.MAX_SAFE_INTEGER])));
        if (await count('pending') + await count('attention') >= 50000) throw new Error('capacity');
        const job: SemanticJob = { scopeId: input.scopeId, scope: input.scope, content: input.content, title: input.title, url: input.url,
          id: crypto.randomUUID(), connections: [input.source.connectionId], sources: [input.source], state: 'pending', step: 'queued',
          providerCommandId: crypto.randomUUID(), reason: null, updatedAt: Date.now(), controlRevision: 0 };
        put(tx, 'semanticIndexes', index, job.id); put(tx, 'semanticJobs', job.id, job);
        return true;
      }); if (changed) ports.schedule();
    }),
    wake() {
      return running ??= (async () => {
        const jobs = await db.transaction(['semanticJobs'], 'readonly', tx => cursorPage<SemanticJob>(tx.objectStore('semanticJobs').index('stateUpdatedAt'),
          IDBKeyRange.bound(['pending', 0], ['pending', Number.MAX_SAFE_INTEGER]), 10));
        for (const job of jobs) await advance(job);
        if (jobs.length === 10) ports.schedule();
      })().finally(() => { running = undefined; });
    },
    retry: (id: string, connectionId: string, reclassify = false) => enqueueLane(async () => {
      const job = await db.read<SemanticJob>('semanticJobs', id);
      if (!job || !job.connections.includes(connectionId) || !['attention', 'pending'].includes(job.state)) throw new Error('semanticJobUnavailable');
      await ports.authorize(job);
      const frozen = await db.transaction(['semanticJobs'], 'readwrite', async tx => {
        const current = await get<SemanticJob>(tx, 'semanticJobs', id);
        if (!current || current.controlRevision !== job.controlRevision) throw new Error('semanticJobChanged');
        if (current.command && reclassify) throw new Error('semanticSavePending');
        const next = { ...current, controlRevision: current.controlRevision + 1, state: 'attention' as const, reason: 'semanticRetrying' };
        put(tx, 'semanticJobs', id, next); return next;
      });
      // An issued save is always recovered under its original command. Only classification gets a new explicit attempt.
      if (!frozen.command && (!frozen.selection || reclassify)) {
        if (frozen.claim) try { await ports.release(frozen); } catch (error) {
          await save({ ...frozen, reason: error instanceof Error ? error.message : 'semanticUnavailable' }); throw error;
        }
        await save({ ...frozen, state: 'pending', step: 'queued', claim: undefined, selection: undefined, providerCommandId: crypto.randomUUID(), reason: null });
      } else await save({ ...frozen, state: 'pending', step: frozen.command ? 'saving' : 'classified', reason: null });
      ports.schedule();
    }),
    async status(connectionId: string) {
      const counts = { pending: 0, attention: 0, completed: 0, suppressed: 0 }, jobs: SemanticJob[] = [];
      // Completed history is counted by index; only unfinished/suppressed jobs need their bodies read.
      await db.transaction(['semanticJobs'], 'readonly', async tx => {
        const store = tx.objectStore('semanticJobs');
        const total = await requestValue(store.index('connections').count(IDBKeyRange.only(connectionId)));
        for (const state of ['pending', 'attention', 'suppressed'] as const) {
          await iterateCursor(store.index('stateUpdatedAt'), IDBKeyRange.bound([state, 0], [state, Number.MAX_SAFE_INTEGER]), value => {
            const job = value as SemanticJob; if (!job.connections.includes(connectionId)) return;
            counts[state]++; jobs.push(job); jobs.sort((a, b) => b.updatedAt - a.updatedAt); if (jobs.length > 20) jobs.pop();
          });
        }
        counts.completed = total - counts.pending - counts.attention - counts.suppressed;
      });
      return { ...counts,
        jobs: jobs
          .map(j => ({ id: j.id, title: j.title, state: j.state, reason: j.reason, takeover: j.reason === 'semanticOtherDevice' })) };
    },
  };
}
