import { readLimits } from './read-policy.js';
import { legacySite } from './registry.js';
import { installationKey } from './installation.js';
import { cancelImportPlans } from './plan-cancellation.js';
import { createLane } from '../automation/lane.js';
import { cursorPage } from '../sync-state/idb.js';
import type { AdapterMessage, BrowserRuleSnapshot, HostCommand, ImportApproval, ImportPreview, SavePlan, SourceFolderReservation } from './contracts.js';
import type { ImportRead, SourceAuthority, SourceContext, SourceImportRun } from './ledger-types.js';
import type { createSourceLedger } from './ledger.js';
import { requireSourceAuthority } from './ledger.js';
import { get, put, rows, sourceDigest, sourceKey, sourcePrefixRange } from './source-db.js';
import type { createSourceLayout } from './layout.js';
import type { createReadScheduler } from './read-scheduler.js';
import { planDigest } from './planned-executor.js';
import type { StoredSavePlan, SourceOutbox } from './planned-types.js';
import { LIMITS as DEFAULT_LIMITS } from './limits.js';
import { siteFeatures } from './capabilities.js';
import { sourceActivityCounts, type ActivitySink, type ActivityInput } from './activity.js';
import { countImportReviews, importScopeProblems } from './import-problems.js';
import { importAuthorization, preparationContext } from './import-authorization.js';
import { readSourceFingerprintSnapshot, sourceMembershipValue } from './source-fingerprints.js';
type Ledger = ReturnType<typeof createSourceLedger>;
type Layout = ReturnType<typeof createSourceLayout>;
export interface Edge { kind: 'collectedEdge'; collectionId: string; itemId: string }
interface Snapshot { browserRules: BrowserRuleSnapshot; policyRevision: number }
export interface ImportJob {
  installationId?: string;
  id: string; context: SourceContext; selected: readonly string[];
  phase: 'scanning' | 'paused' | 'preparing' | 'preview' | 'approved' | 'attention' | 'cancelled' | 'completed';
  stage: 'collections' | 'items'; found: readonly string[]; collectionIndex: number; cursor: string | null;
  outstanding: string | null; pageWaitUntil?: number; pages: number; edgeCount: number; scanComplete: boolean; omissions: number; omissionCounts?: Record<string, number>; omissionSamples: readonly { id: string; reason: string; collectionId?: string }[]; coverage: 'complete' | 'partial';
  pageReceipts: readonly { id: string; digest: string }[]; reason: string | null;
  previewId: string | null; previewRevision: number; nextEdge: number; prepareAfter?: string; planIds: readonly string[];
  nextPlan: number; scanSnapshot: Snapshot; counts: ImportPreview['counts']; snapshot: Snapshot | null; approvalId: string | null;
}
interface Ports {
  activity?: ActivitySink;
  reconciliation?: { begin(job: ImportJob): Promise<void>; inspect(job: ImportJob, edge: Edge): Promise<boolean>; freeze(job: ImportJob): Promise<void> };
  source(origin?: SourceContext): Promise<{ context: SourceContext; expiresAt: number } | null>;
  send(context: SourceContext, command: HostCommand): void;
  prioritizeLive(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  execute(planId: string, effectId: string): Promise<{ status: string; reason?: string; commandId?: string }>;
  alarm(at: number): void;
}
const key = (id: string) => `importJob:${id}`;
const EDGE_LIMIT = DEFAULT_LIMITS.importItems, PAGE_LIMIT = 2000;
const emptyCounts = () => ({ createFolders: 0, createBookmarks: 0, reuseBookmarks: 0, review: 0 });
const syncWaiting = (reason: string | null) => reason === 'sourceSyncPending' || reason === 'sourceSyncRecovering';
/** Scan facts, freeze exact scope, then approve: none of the first two phases grants native writes. */
export function createSiteImporter(ledger: Ledger, layout: Layout, scheduler: ReturnType<typeof createReadScheduler>, ports: Ports) {
  const db = ledger.db, lane = createLane(), LIMITS = readLimits(ledger.definition), ACTIVE = installationKey('activeImport:v1', ledger.definition);
  const load = async (id?: string) => { const active = id ?? await db.read<string>('meta', ACTIVE); const job = active ? await db.read<ImportJob>('meta', key(active)) : undefined;
    if (job && (job.installationId ?? legacySite.adapterId) !== ledger.definition.adapterId) throw new Error('sourceAuthorizationChanged');
    return job; };
  const log = (job: ImportJob, input: Omit<ActivityInput, 'taskId' | 'counts' | 'phase'>) => ports.activity?.record({ ...input, taskId: job.id, phase: job.phase, connectionId: job.context.connectionId,
    counts: sourceActivityCounts(job) }).catch(() => undefined);
  const save = async (job: ImportJob, details?: Pick<ActivityInput, 'commandId' | 'requestId' | 'collectionId'>) => {
    const previous = await db.transaction(['meta'], 'readwrite', async tx => { const old = await get<ImportJob>(tx, 'meta', key(job.id)); put(tx, 'meta', key(job.id), job); return old; });
    if (previous?.phase !== job.phase || previous?.reason !== job.reason) {
      if (job.phase === 'completed') { await log(job, { kind: 'saved', operation: 'save' }); await ports.activity?.resolve(job.id, 'save').catch(() => undefined); }
      else if (job.phase === 'attention' || job.phase === 'paused' && job.reason !== 'scanFinished' || syncWaiting(job.reason))
        await log(job, { ...details, kind: syncWaiting(job.reason) ? 'waiting' : 'problem', operation: job.phase === 'paused' ? 'read' : 'save', code: job.reason ?? 'unavailable',
          ...(job.reason === 'sourceReviewRequired' && job.previewId ? { reviewSamples: (await db.read<ImportPreview>('importPreviews', job.previewId))?.reviewSamples } : {}),
          ...(syncWaiting(job.reason) ? { automatic: true, retryAt: Date.now() + 3000 } : {}) });
    }
    if (job.nextPlan > (previous?.nextPlan ?? 0)) await ports.activity?.resolve(job.id, 'save').catch(() => undefined);
  };
  async function authority(job: ImportJob, tx?: IDBTransaction) {
    const a = tx ? await get<SourceAuthority>(tx, 'authorities', ledger.definition.adapterId) : await db.read<SourceAuthority>('authorities', ledger.definition.adapterId);
    if (!a?.enabled || a.connectionId !== job.context.connectionId || a.installationGeneration !== job.context.installationGeneration
      || a.sourceSessionGeneration !== job.context.sourceSessionGeneration) throw new Error('sourceAuthorizationChanged');
  }
  async function edgeFingerprint(job: ImportJob, edge: Edge, _plan?: SavePlan) {
    return db.transaction(['items', 'collections', 'memberships', 'representations', 'itemReservations'], 'readonly', async tx => {
      const connection = job.context.connectionId;
      const reps = (await rows<import('./contracts.js').Representation>(tx, 'representations', connection, edge.itemId)).filter(r => r.purpose === 'sourceArchive' && r.sourceCollectionId === edge.collectionId);
      const pending = (await rows<import('./reservations.js').ItemReservation>(tx, 'itemReservations', connection, edge.itemId)).filter(r => r.representation.purpose === 'sourceArchive' && r.representation.sourceCollectionId === edge.collectionId);
      return sourceDigest({ item: (await get<{ entity: unknown }>(tx, 'items', sourceKey(connection, edge.itemId)))?.entity ?? null,
        collection: (await get<{ entity: unknown }>(tx, 'collections', sourceKey(connection, edge.collectionId)))?.entity ?? null,
        membership: sourceMembershipValue(await get<import('./ledger-types.js').LedgerEdge>(tx, 'memberships', sourceKey(connection, edge.itemId, edge.collectionId))),
        representations: reps, reservations: pending });
    });
  }
  const cancelPlans = (job: ImportJob, only?: readonly string[]) => cancelImportPlans(db, job.id, job.approvalId, only);
  async function stopScan(job: ImportJob) {
    await db.transaction(['meta', 'importRuns', 'authorities', 'importApprovals'], 'readwrite', async tx => {
      await authority(job, tx);
      if (job.approvalId) { const a = await get<ImportApproval>(tx, 'importApprovals', job.approvalId); if (a) put(tx, 'importApprovals', a.id, { ...a, state: 'cancelled' }); }
      const run = await get<SourceImportRun>(tx, 'importRuns', job.id); if (!run) throw new Error('importMissing');
      put(tx, 'importRuns', job.id, { ...run, context: job.context, phase: 'stopped', outstanding: null });
      put(tx, 'meta', key(job.id), { ...job, outstanding: null });
    });
    if (job.outstanding) {
      const request = await db.read<ImportRead>('readRequests', job.outstanding);
      if (request) { try { ports.send(request.context, { operation: 'cancelRead', readSessionId: job.id }); } catch { /* the page is already gone */ } }
      await scheduler.finish(job.outstanding);
    }
  }
  async function prepare(job: ImportJob) {
    await authority(job);
    const frozenSnapshot = job.snapshot;
    if (!frozenSnapshot || sourceDigest(await ports.snapshot()) !== sourceDigest(frozenSnapshot)) throw new Error('previewStale');
    await ports.reconciliation?.begin(job);
    const range = sourcePrefixRange('edge', job.id);
    const batch = await db.transaction(['importPages'], 'readonly', tx => cursorPage<Edge>(tx.objectStore('importPages'), job.prepareAfter ? IDBKeyRange.bound(job.prepareAfter, range.upper, true) : range, 20));
    const counts = { ...job.counts };
    for (const edge of batch) {
      let plan: SavePlan | undefined, reviewReason: string | null = null;
      try {
        if (await ports.reconciliation?.inspect(job, edge)) throw new Error('sourceReconcileCandidate');
        const result = await layout.plan({ context: job.context, itemId: edge.itemId, collectionId: edge.collectionId, entry: 'siteImport',
          trigger: { kind: 'import', importRunId: job.id, previewId: job.previewId! } });
        if (result.status === 'represented') counts.reuseBookmarks++;
        else if (result.status !== 'planned') { counts.review++; reviewReason = result.status; }
        else {
          plan = result.plan;
          if (sourceDigest(plan.browserRules) !== sourceDigest(frozenSnapshot.browserRules) || plan.policyRevision !== frozenSnapshot.policyRevision) throw new Error('previewStale');
          const create = plan.effects.find(e => e.kind === 'createBookmark');
          const outbox = create && await db.read<SourceOutbox>('outbox', create.commandId);
          if (outbox && outbox.state !== 'acknowledged') { counts.review++; reviewReason = 'nativeOutcomeUnresolved'; await cancelPlans({ ...job, approvalId: null }, [plan.id]); plan = undefined; }
          else counts.createBookmarks++;
        }
      } catch (e) {
        if (e instanceof Error && (e.message === 'previewStale' || importScopeProblems.has(e.message))) throw e;
        counts.review++;
        reviewReason = e instanceof Error ? e.message.slice(0, 256) : 'sourcePlanNeedsReview';
      }
      const fingerprint = await edgeFingerprint(job, edge, plan);
      await db.transaction(['importPages'], 'readwrite', async tx => { put(tx, 'importPages', sourceKey('frozenEdge', job.previewId, edge.collectionId, edge.itemId), { edge, fingerprint, planId: plan?.id ?? null, reviewReason }); });
    }
    const last = batch.at(-1);
    job = { ...job, nextEdge: job.nextEdge + batch.length, counts, ...(last ? { prepareAfter: sourceKey('edge', job.id, last.collectionId, last.itemId) } : {}) };
    if (job.nextEdge < job.edgeCount) { await save(job); ports.alarm(Date.now() + 100); return; }
    const frozen = await db.transaction(['importPages'], 'readonly', tx => rows<{ planId: string | null; edge: Edge; reviewReason?: string | null }>(tx, 'importPages', 'frozenEdge', job.previewId));
    const planIds = frozen.flatMap(r => r.planId ? [r.planId] : []);
    const folders = new Map<string, SourceFolderReservation>(), mounts = new Map<string, number>(), digests: { id: string; digest: string }[] = [];
    for (const id of planIds) {
      const row = await db.read<StoredSavePlan>('savePlans', id); if (!row) throw new Error('previewStale');
      digests.push({ id, digest: row.digest });
      if (row.plan.mount) mounts.set(row.plan.mount.id, row.plan.mount.revision);
      for (const effect of row.plan.effects) if (effect.kind === 'ensureSourceFolder') {
        const create = row.plan.effects.find(e => e.kind === 'createBookmark');
        const f = row.plan.mount && create?.kind === 'createBookmark' ? await db.read<SourceFolderReservation>('folderReservations', sourceKey(row.plan.mount.id, create.representation.sourceCollectionId)) : undefined; if (!f) throw new Error('previewStale'); folders.set(f.id, f);
      }
    }
    counts.createFolders = [...folders.values()].filter(f => f.state !== 'confirmed').length;
    const preview: ImportPreview = { id: job.previewId!, importRunId: job.id, revision: job.previewRevision, digest: '', pageReceiptsDigest: sourceDigest(job.pageReceipts),
      reviewCounts: countImportReviews(frozen),
      reviewSamples: frozen.filter(f => f.reviewReason).slice(0, 20).map(f => ({ itemId: f.edge.itemId, collectionId: f.edge.collectionId, reason: f.reviewReason! })),
      ledgerOrdinal: await db.read<number>('meta', 'ordinal') ?? 0, browserRules: frozenSnapshot.browserRules, policyRevision: frozenSnapshot.policyRevision,
      classificationPolicyDigest: 'disabled', omissions: { count: job.omissions, samples: job.omissionSamples, unscannedRemainder: !job.scanComplete }, mounts: [...mounts].map(([id, revision]) => ({ id, revision })), coverage: job.coverage, planIds, counts };
    const frozenScope = await db.transaction(['importPages'], 'readonly', tx => rows<object>(tx, 'importPages', 'frozenEdge', job.previewId));
    preview.collectedSetDigest = sourceDigest(frozenScope); preview.plansDigest = sourceDigest(digests);
    preview.digest = previewDigest(preview);
    await ports.reconciliation?.freeze(job);
    await db.transaction(['meta', 'importPreviews'], 'readwrite', async tx => {
      // The immutable scope lives in the preview. Progress checkpoints must not
      // copy thousands of plan IDs again for every saved bookmark.
      put(tx, 'importPreviews', preview.id, preview); put(tx, 'meta', key(job.id), { ...job, counts, planIds: [], phase: 'preview' });
    });
    await log({ ...job, phase: 'preview' }, { kind: 'checked', operation: 'read', reviewSamples: preview.reviewSamples });
    await ports.activity?.resolve(job.id, 'save', [...importScopeProblems, 'previewStale', 'sourceAuthorizationChanged']).catch(() => undefined);
  }
  async function validate(job: ImportJob, preview: ImportPreview) {
    await authority(job);
    if (preview.digest !== previewDigest(preview) || preview.id !== job.previewId || sourceDigest(await ports.snapshot()) !== sourceDigest(job.snapshot)) throw new Error('previewStale');
    const frozen = await db.transaction(['importPages'], 'readonly', tx => rows<{ edge: Edge; fingerprint: string; planId: string | null }>(tx, 'importPages', 'frozenEdge', preview.id));
    if (frozen.length !== job.edgeCount || sourceDigest(frozen) !== preview.collectedSetDigest) throw new Error('previewStale');
    const stored = await db.transaction(['savePlans'], 'readonly', tx => Promise.all(preview.planIds.map(id => get<StoredSavePlan>(tx, 'savePlans', id))));
    const plans = new Map<string, SavePlan>(), digests: { id: string; digest: string }[] = [];
    for (const [index, id] of preview.planIds.entries()) {
      const row = stored[index]; if (!row) throw new Error('previewStale'); plans.set(id, row.plan); digests.push({ id, digest: row.digest });
    }
    if (sourceDigest(digests) !== preview.plansDigest) throw new Error('previewStale');
    const fingerprint = await readSourceFingerprintSnapshot(db, job.context.connectionId), checkedFolders = new Set<string>();
    for (const f of frozen) {
      const plan = f.planId ? plans.get(f.planId) : undefined;
      if (f.fingerprint !== fingerprint(f.edge)) throw new Error('previewStale');
      if (plan) {
        const folder = sourceKey(plan.mount?.id, plan.effects.find(e => e.kind === 'ensureSourceFolder')?.folderReservationDigest ?? plan.id);
        // Native folder checks are shared by all items in a collection. Every
        // individual effect is authorized again immediately before execution.
        if (!checkedFolders.has(folder)) { for (const e of plan.effects) await layout.authorize(plan, e); checkedFolders.add(folder); }
      }
    }
  }
  async function freeze(job: ImportJob) {
    if (['approved', 'cancelled', 'completed'].includes(job.phase)) throw new Error('importChanged');
    job = { ...job, context: await preparationContext(db, ledger.definition, job.context) };
    await stopScan(job); await cancelPlans(job);
    const next: ImportJob = { ...job, phase: 'preparing', outstanding: null, snapshot: await ports.snapshot(), previewId: crypto.randomUUID(), previewRevision: job.previewRevision + 1,
      nextEdge: 0, prepareAfter: undefined, planIds: [], nextPlan: 0, counts: emptyCounts(), approvalId: null, reason: null,
      coverage: job.scanComplete ? job.coverage : 'partial' };
    await save(next);
    await ports.activity?.resolve(job.id, 'read', ['sourceAuthorizationChanged', 'sourceAccountChanged', 'sourceUnresolved', 'restartRequired', 'pageUnavailable']).catch(() => undefined);
    ports.alarm(Date.now() + 100); return next;
  }
  return {
    status: async () => {
      const job = await load(); if (!job) return null;
      const p = job.previewId ? await db.read<ImportPreview>('importPreviews', job.previewId) : undefined;
      const reviewCounts = p?.reviewCounts ?? (p?.counts.review ? await db.transaction(['importPages'], 'readonly', async tx =>
        countImportReviews(await rows<{ reviewReason?: string }>(tx, 'importPages', 'frozenEdge', p.id))) : {});
      const currentId = job.stage === 'items' ? job.found[job.collectionIndex] : undefined;
      const collection = currentId ? await db.read<{ entity: { title: string } }>('collections', sourceKey(job.context.connectionId, currentId)) : undefined;
      const reviewSamples = p?.reviewSamples?.length ? await db.transaction(['items', 'collections'], 'readonly', async tx => {
        const samples = [];
        for (const sample of p.reviewSamples!.slice(0, 20)) {
          const item = await get<{ entity: { title: string } }>(tx, 'items', sourceKey(job.context.connectionId, sample.itemId));
          const list = await get<{ entity: { title: string } }>(tx, 'collections', sourceKey(job.context.connectionId, sample.collectionId));
          samples.push({ ...sample, itemTitle: item?.entity.title, collectionTitle: list?.entity.title });
        }
        return samples;
      }) : p?.reviewSamples;
      const authorization = importAuthorization(job.context, await db.read<SourceAuthority>('authorities', ledger.definition.adapterId));
      return { ...job, authorization, pageReceipts: undefined, context: { connectionId: job.context.connectionId }, planIds: undefined,
        progress: { collectionsRead: job.collectionIndex, collectionsTotal: job.selected.length, currentCollection: collection?.entity.title ?? null,
          prepared: job.nextEdge, saved: job.nextPlan, toSave: p?.planIds.length ?? 0 },
        preview: p ? { id: p.id, revision: p.revision, digest: p.digest, coverage: p.coverage, counts: p.counts, omissions: p.omissions, reviewSamples, reviewCounts } : null };
    },
    start: (selected: readonly string[]) => lane(async () => {
      if (!siteFeatures(ledger.definition).import) throw new Error('unsupported');
      const existing = await load(); if (existing && !['cancelled', 'completed'].includes(existing.phase)) throw new Error('importAlreadyActive');
      if (!selected.length || selected.length > 64 || new Set(selected).size !== selected.length) throw new Error('invalidScope');
      const single = ledger.definition.defaultCollection;
      if (single && (selected.length !== 1 || selected[0] !== single.id)) throw new Error('invalidScope');
      const source = await ports.source(); if (!source) throw new Error('pageUnavailable');
      const id = crypto.randomUUID(); await ledger.startImport(source.context, id);
      if (single) { const receipt = await ledger.acceptCatalog(source.context, crypto.randomUUID(), [single]); if (receipt.status === 'rejected') throw new Error(receipt.reason); }
      const job: ImportJob = { installationId: ledger.definition.adapterId, id, context: source.context, selected, phase: 'scanning', stage: single ? 'items' : 'collections', found: single ? [single.id] : [], collectionIndex: 0, cursor: null, outstanding: null,
        pages: 0, edgeCount: 0, scanComplete: false, omissions: 0, omissionCounts: {}, omissionSamples: [], coverage: 'complete', pageReceipts: [], reason: null, previewId: null, previewRevision: 0, nextEdge: 0,
        planIds: [], nextPlan: 0, scanSnapshot: await ports.snapshot(), counts: emptyCounts(), snapshot: null, approvalId: null };
      await db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', key(id), job); put(tx, 'meta', ACTIVE, id); });
      await log(job, { kind: 'started', operation: 'read' }); ports.alarm(Date.now() + 100); return id;
    }),
    accept: (context: SourceContext, message: AdapterMessage) => lane(async () => {
      if (message.operation !== 'page.result') return null;
      const job = await load(); if (!job || message.readSessionId !== job.id) return null;
      const receipt = await ledger.acceptPage(context, message.pageRequestId, message.result, async (tx, receipt) => {
        const current = await get<ImportJob>(tx, 'meta', key(job.id));
        if (!current || current.phase !== 'scanning' || current.outstanding !== message.pageRequestId) throw new Error('staleContext');
        const omissionCounts = { ...(current.omissionCounts ?? (current.omissions ? { unknown: current.omissions } : {})) };
        let next: ImportJob = { ...current, omissionCounts, pages: current.pages + 1, outstanding: null, pageReceipts: [...current.pageReceipts, { id: receipt.id, digest: receipt.digest }] };
        const result = message.result;
        if (result.status === 'failed') {
          omissionCounts.failed = (omissionCounts.failed ?? 0) + 1;
          next = { ...next, phase: 'paused', coverage: 'partial', reason: result.error.code, omissions: next.omissions + 1,
            omissionSamples: [...next.omissionSamples, { id: next.found[next.collectionIndex] ?? 'catalog', reason: result.error.code }].slice(0, 20) };
        }
        else {
          next = { ...next, cursor: result.page.nextCursor, coverage: next.coverage === 'partial' || result.page.coverage === 'partial' ? 'partial' : 'complete', omissionSamples: next.omissionSamples };
          for (const omission of result.page.omissions ?? []) {
            const collectionId = result.kind === 'items' ? result.collectionId : 'catalog', k = sourceKey('omission', job.id, collectionId, omission.id);
            if (!await get(tx, 'importPages', k)) {
              put(tx, 'importPages', k, { ...omission, collectionId });
              omissionCounts[omission.reason] = (omissionCounts[omission.reason] ?? 0) + 1;
              next = { ...next, omissions: next.omissions + 1, omissionSamples: [...next.omissionSamples, { ...omission, collectionId }].slice(0, 20) };
            }
          }
          if (result.kind === 'collections') {
            const found = [...new Set([...next.found, ...result.page.items.filter(c => next.selected.includes(c.id)).map(c => c.id)])];
            next = { ...next, found };
            if (!result.page.nextCursor) {
              const missing = next.selected.length - found.length;
              if (missing) omissionCounts.collectionMissing = (omissionCounts.collectionMissing ?? 0) + missing;
              next = { ...next, stage: 'items', found: next.selected.filter(id => found.includes(id)), omissions: next.omissions + missing, omissionSamples: [...next.omissionSamples, ...next.selected.filter(id => !found.includes(id)).map(id => ({ id, reason: 'collectionMissing' }))].slice(0, 20),
                coverage: missing ? 'partial' : next.coverage, ...(!found.length ? { phase: 'paused', reason: 'scanFinished', scanComplete: true } : {}) };
            }
          } else {
            for (const { item } of result.page.items) {
              const k = sourceKey('edge', job.id, result.collectionId, item.id);
              if (!await get(tx, 'importPages', k)) { put(tx, 'importPages', k, { kind: 'collectedEdge', itemId: item.id, collectionId: result.collectionId } satisfies Edge); next = { ...next, edgeCount: next.edgeCount + 1 }; }
            }
            if (next.edgeCount + next.omissions > EDGE_LIMIT) throw new Error('capacity');
            if (!result.page.nextCursor) next = { ...next, collectionIndex: next.collectionIndex + 1,
              ...(next.collectionIndex + 1 >= next.found.length ? { phase: 'paused', reason: 'scanFinished', scanComplete: true } : {}) };
          }
        }
        put(tx, 'meta', key(job.id), next);
      });
      if (receipt.status === 'rejected' && job.phase === 'scanning' && job.outstanding === message.pageRequestId)
        await save({ ...job, phase: 'paused', reason: receipt.reason, coverage: 'partial' });
      if (receipt.status === 'accepted') {
        if (message.result.status === 'failed') await log(await load(job.id) ?? job, { kind: 'problem', operation: 'read', requestId: message.pageRequestId,
          code: message.result.error.code, httpStatus: message.result.error.httpStatus, sourceCode: message.result.error.sourceCode,
          collectionId: job.stage === 'items' ? job.found[job.collectionIndex] : undefined });
        else await ports.activity?.resolve(job.id, 'read').catch(() => undefined);
      }
      await scheduler.finish(message.pageRequestId, message.result.status === 'failed' ? message.result.error.retryAfterMs : undefined);
      ports.alarm(Date.now() + LIMITS.spacingMs); return receipt;
    }),
    freeze: (id: string) => lane(async () => {
      const job = await load(id); if (!job) throw new Error('importChanged'); await freeze(job);
    }),
    approve: (input: { jobId: string; previewId: string; revision: number; digest: string }) => lane(async () => {
      const job = await load(input.jobId), preview = await db.read<ImportPreview>('importPreviews', input.previewId);
      if (!job || job.phase !== 'preview' || !preview || preview.id !== job.previewId || preview.revision !== input.revision || preview.digest !== input.digest) throw new Error('previewStale');
      if (!preview.planIds.length && preview.counts.review) {
        const reviews = preview.reviewCounts ?? await db.transaction(['importPages'], 'readonly', async tx => countImportReviews(await rows<{ reviewReason?: string }>(tx, 'importPages', 'frozenEdge', preview.id)));
        if (Object.keys(reviews).some(code => !['sourceReconcileCandidate', 'policySkipped', 'suppressed', 'noMatch'].includes(code)))
          throw new Error(Object.keys(reviews).find(code => importScopeProblems.has(code)) ?? 'sourceReviewRequired');
      }
      await validate(job, preview);
      const approval: ImportApproval = { id: crypto.randomUUID(), state: 'active', importRunId: job.id, previewId: preview.id, previewRevision: preview.revision, previewDigest: preview.digest, approvedAt: Date.now() };
      await db.transaction(['meta', 'importApprovals', 'savePlans', 'authorities'], 'readwrite', async tx => {
        await authority(job, tx); // authorization checked again immediately before activation
        for (const id of preview.planIds) {
          const row = await get<StoredSavePlan>(tx, 'savePlans', id);
          if (!row || row.state !== 'draft' || row.digest !== planDigest(row.plan) || row.plan.trigger.kind !== 'import' || row.plan.trigger.previewId !== preview.id) throw new Error('previewStale');
          put(tx, 'savePlans', id, { ...row, state: 'approved', plan: { ...row.plan, importApprovalId: approval.id } });
        }
        put(tx, 'importApprovals', approval.id, approval); put(tx, 'meta', key(job.id), { ...job, phase: 'approved', approvalId: approval.id });
      }); await log({ ...job, phase: 'approved' }, { kind: 'started', operation: 'save' }); ports.alarm(Date.now() + 100); return approval.id;
    }),
    retry: (id: string) => lane(async () => {
      const job = await load(id);
      if (!job || job.phase !== 'attention' || !job.approvalId || !job.previewId || job.reason === 'sourceReviewRequired') throw new Error('importChanged');
      await authority(job);
      if (sourceDigest(await ports.snapshot()) !== sourceDigest(job.snapshot)) throw new Error('previewStale');
      await db.transaction(['meta', 'importApprovals', 'importPreviews', 'authorities'], 'readwrite', async tx => {
        await authority(job, tx);
        const approval = await get<ImportApproval>(tx, 'importApprovals', job.approvalId!), preview = await get<ImportPreview>(tx, 'importPreviews', job.previewId!);
        if (!approval || approval.state !== 'active' || approval.importRunId !== job.id || approval.previewId !== job.previewId
          || !preview || approval.previewDigest !== preview.digest || preview.digest !== previewDigest(preview)) throw new Error('previewStale');
        put(tx, 'meta', key(id), { ...job, phase: 'approved', reason: null });
      });
      await log({ ...job, phase: 'approved' }, { kind: 'started', operation: 'save' }); ports.alarm(Date.now() + 100);
    }),
    cancel: (id: string) => lane(async () => {
      const job = await load(id); if (!job) throw new Error('importMissing');
      await db.transaction(['meta', 'importRuns', 'importApprovals'], 'readwrite', async tx => {
        put(tx, 'meta', key(id), { ...job, outstanding: null, phase: 'cancelled', reason: null });
        const run = await get<SourceImportRun>(tx, 'importRuns', id); if (run) put(tx, 'importRuns', id, { ...run, phase: 'stopped', outstanding: null });
        if (job.approvalId) { const a = await get<ImportApproval>(tx, 'importApprovals', job.approvalId); if (a) put(tx, 'importApprovals', a.id, { ...a, state: 'cancelled' }); }
      });
      if (job.outstanding) {
        const request = await db.read<ImportRead>('readRequests', job.outstanding);
        if (request) { try { ports.send(request.context, { operation: 'cancelRead', readSessionId: job.id }); } catch { /* the page is already gone */ } }
        await scheduler.finish(job.outstanding);
      }
      await cancelPlans(job);
      await log({ ...job, phase: 'cancelled' }, { kind: 'stopped', operation: job.approvalId ? 'save' : 'read' });
    }),
    resume: (id: string) => lane(async () => {
      const job = await load(id);
      if (!job || job.phase !== 'paused') throw new Error('importChanged');
      const source = await ports.source();
      if (!source) throw new Error('pageUnavailable');
      // A confirmed reconnection may renew both generations. Only discovery can
      // adopt it, and only for the same installation and durable account identity.
      if ((source.context.installationId ?? legacySite.adapterId) !== ledger.definition.adapterId) throw new Error('sourceAuthorizationChanged');
      if (source.context.connectionId !== job.context.connectionId) throw new Error('sourceAccountChanged');
      const restart = ledger.definition.importResume !== 'stableCursor' || job.reason === 'staleCursor';
      await db.transaction(['importRuns', 'meta', 'authorities', 'documentLeases'], 'readwrite', async tx => {
        await requireSourceAuthority(tx, source.context);
        const run = await get<SourceImportRun>(tx, 'importRuns', id); if (!run) throw new Error('importMissing');
        put(tx, 'importRuns', id, { ...run, phase: 'scanning', context: source.context, outstanding: null, ...(restart ? { cursor: null, seenCursors: [] } : {}) });
        put(tx, 'meta', key(id), { ...job, context: source.context, phase: 'scanning', ...(restart ? { stage: ledger.definition.defaultCollection ? 'items' : 'collections', found: ledger.definition.defaultCollection ? [ledger.definition.defaultCollection.id] : [], collectionIndex: 0, cursor: null } : {}), outstanding: null, pageWaitUntil: undefined,
          coverage: 'partial', scanComplete: false, reason: restart ? 'restartAndDeduplicate' : 'stableCursor' });
      });
      if (job.outstanding) {
        try { ports.send(job.context, { operation: 'cancelRead', readSessionId: job.id }); } catch { /* the old page is already gone */ }
        await scheduler.finish(job.outstanding);
      }
      await log({ ...job, context: source.context, phase: 'scanning' }, { kind: 'started', operation: 'read' }); ports.alarm(Date.now() + 100);
    }),
    wake: () => lane(async () => {
      let job = await load(); if (!job) return;
      let failedEffect: Pick<ActivityInput, 'commandId' | 'requestId'> | undefined;
      try {
        if (job.phase === 'paused' && job.reason === 'scanFinished') job = await freeze(job);
        if (job.phase === 'preparing') { await prepare(job); return; }
        if (job.phase === 'approved') {
          job = { ...job, reason: null };
          const preview = job.previewId && await db.read<ImportPreview>('importPreviews', job.previewId); if (!preview) throw new Error('previewStale');
          for (const id of preview.planIds.slice(job.nextPlan, job.nextPlan + 10)) {
            const row = await db.read<StoredSavePlan>('savePlans', id); if (!row) throw new Error('previewStale');
            for (const e of row.plan.effects) { const result = await ports.execute(id, e.effectId); if (result.status !== 'confirmed') {
              failedEffect = { commandId: result.commandId, requestId: e.effectId }; throw new Error(result.reason ?? 'nativeResultUnknown'); } }
            job = { ...job, nextPlan: job.nextPlan + 1 }; await save(job);
          }
          if (job.nextPlan >= preview.planIds.length) await save({ ...job, phase: preview.counts.review ? 'attention' : 'completed', reason: preview.counts.review ? 'sourceReviewRequired' : null }); else ports.alarm(Date.now() + 100);
          return;
        }
        if (job.phase !== 'scanning') return;
        await authority(job); await ports.prioritizeLive();
        if (job.pages >= PAGE_LIMIT) throw new Error('capacity');
        const source = await ports.source(job.context);
        if (!source) {
          const until = job.pageWaitUntil ?? Date.now() + LIMITS.commandMs;
          if (until <= Date.now()) throw new Error('pageUnavailable');
          await save({ ...job, pageWaitUntil: until, reason: 'reconnectingSource' }); ports.alarm(Date.now() + LIMITS.spacingMs); return;
        }
        if (job.pageWaitUntil) { job = { ...job, pageWaitUntil: undefined, reason: null }; await save(job); }
        if (source.context.documentId !== job.context.documentId || source.context.routeEpoch !== job.context.routeEpoch) throw new Error('restartRequired');
        if (source.context.leaseId !== job.context.leaseId) {
          job = { ...job, context: source.context, outstanding: null };
          await db.transaction(['meta', 'importRuns', 'authorities', 'documentLeases'], 'readwrite', async tx => {
            await requireSourceAuthority(tx, source.context);
            const run = await get<SourceImportRun>(tx, 'importRuns', job!.id); if (!run) throw new Error('importMissing');
            put(tx, 'importRuns', job!.id, { ...run, context: source.context, outstanding: null }); put(tx, 'meta', key(job!.id), job);
          });
        }
        if (job.outstanding) {
          const r = await db.read<ImportRead>('readRequests', job.outstanding);
          if (!r || r.deadlineAt <= Date.now()) throw new Error('pageUnavailable'); ports.alarm(r.deadlineAt + LIMITS.spacingMs); return;
        }
        const id = crypto.randomUUID(), deadlineAt = Math.min(Date.now() + LIMITS.commandMs, source.expiresAt - 1000);
        if (deadlineAt <= Date.now() + LIMITS.spacingMs) { ports.alarm(Date.now() + LIMITS.spacingMs); return; }
        const slot = await scheduler.acquire({ id, documentId: source.context.documentId, deadlineAt });
        if (slot.status !== 'ready') { ports.alarm(Date.now() + slot.retryAfterMs); return; }
        const query: ImportRead['query'] = job.stage === 'collections' ? { kind: 'collections', cursor: job.cursor }
          : { kind: 'items', collectionId: job.found[job.collectionIndex]!, cursor: job.cursor };
        await ledger.issuePage({ id, runId: job.id, context: source.context, deadlineAt, query });
        await save({ ...job, outstanding: id });
        ports.send(source.context, { operation: 'readPage', leaseId: source.context.leaseId, readSessionId: job.id, pageRequestId: id, deadlineAt, query }); ports.alarm(deadlineAt + LIMITS.spacingMs);
      } catch (e) {
        if (job.phase === 'approved' && e instanceof Error && syncWaiting(e.message)) {
          await save({ ...job, reason: e.message }, failedEffect); ports.alarm(Date.now() + 3000); return;
        }
        await save({ ...job, phase: job.phase === 'scanning' ? 'paused' : 'attention', coverage: job.phase === 'scanning' ? 'partial' : job.coverage,
        reason: e instanceof Error ? e.message : 'unavailable' }, failedEffect); }
    }),
  };
}
export function previewDigest(preview: ImportPreview) { const { digest: _digest, ...body } = preview; return sourceDigest(body); }
