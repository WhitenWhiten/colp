import type { StorageArea } from '../credential-store.js';
import { createLane, type Lane } from '../automation/lane.js';
import { sourceDigest } from './source-db.js';

export type SiteOperation = 'connect' | 'configure' | 'read' | 'save' | 'reconcile' | 'recover' | 'classify' | 'inspect' | 'status';
export type ProblemFamily = 'connection' | 'permission' | 'rate' | 'network' | 'destination' | 'changed' | 'unconfirmed' | 'unsupported' | 'source' | 'storage' | 'capacity' | 'configuration' | 'unknown';
export interface ActivityCounts { read: number; saved: number; skipped: number; total?: number; readFailures?: number; unclassified?: number }
export function sourceActivityCounts(job: { edgeCount: number; nextPlan: number; omissions: number; omissionCounts?: Record<string, number> }): ActivityCounts {
  const counts = job.omissionCounts ?? {}, skipped = (counts.invalid ?? 0) + (counts.unsupported ?? 0) + (counts.missing ?? 0);
  return { read: job.edgeCount, saved: job.nextPlan, skipped, readFailures: counts.failed ?? 0,
    unclassified: Math.max(0, job.omissions - skipped - (counts.failed ?? 0) - (counts.collectionMissing ?? 0)) };
}
export interface SiteActivity {
  id: string; kind: 'started' | 'checked' | 'saved' | 'stopped' | 'configured' | 'waiting' | 'problem'; operation: SiteOperation;
  firstAt: number; lastAt: number; occurrences: number; resolvedAt?: number;
  taskRef?: string; requestRef?: string; commandRef?: string; collectionRef?: string; connectionRef?: string;
  phase?: string; code?: string; family?: ProblemFamily; counts?: ActivityCounts; latestCounts?: ActivityCounts;
  retryAt?: number; latestRetryAt?: number; automatic?: boolean; resolution?: 'recovered' | 'dismissed'; httpStatus?: number; sourceCode?: number; action?: string;
  review?: readonly { code: string; itemRef?: string; collectionRef?: string }[];
}
export interface ActivityInput {
  kind: SiteActivity['kind']; operation: SiteOperation; taskId?: string; requestId?: string; commandId?: string; collectionId?: string; connectionId?: string;
  phase?: string; code?: string; counts?: ActivityCounts; retryAt?: number; automatic?: boolean; httpStatus?: number; sourceCode?: number; action?: string;
  reviewSamples?: readonly { reason: string; itemId: string; collectionId: string }[];
}
export interface ActivitySink {
  record(input: ActivityInput): Promise<SiteActivity>;
  resolve(taskId: string, operation: SiteOperation, codes?: readonly string[]): Promise<void>;
}
const lanes = new WeakMap<StorageArea, Map<string, Lane>>();
export const activityReference = (value?: string) => value ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  ? value : sourceDigest(value).slice(7, 31) : undefined;
const ref = activityReference;
const token = (value?: string) => value && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) ? value : undefined;
export const activityCode = (value: string) => token(value) ?? 'unclassified';
const number = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Closed or superseded import incidents stay in history; current management failures remain actionable. */
export function currentSiteProblem(events: readonly SiteActivity[], scope: { taskId?: string; connectionId?: string; phase?: string }) {
  return events.find(e => e.kind === 'problem' && !e.resolvedAt && (!e.connectionRef || e.connectionRef === ref(scope.connectionId))
    && !(e.taskRef === ref(scope.taskId) && ['scanning', 'preparing', 'approved'].includes(scope.phase ?? ''))
    && (!e.taskRef || e.taskRef === ref(scope.taskId) || e.taskRef === ref(`management:${e.operation}`)
      || !!e.connectionRef && !e.phase || e.operation === 'inspect')) ?? null;
}
export function problemFamily(code: string): ProblemFamily {
  if (['signedOut', 'sourceUnresolved', 'sourceAuthorizationChanged', 'sourceAccountChanged', 'pageUnavailable', 'navigationChanged', 'restartRequired'].includes(code)) return 'connection';
  if (['permissionRequired', 'storageBoundaryUnavailable', 'communityToggleRequired', 'communityPermissionRequired'].includes(code)) return 'permission';
  if (['rateLimited', 'challenge'].includes(code)) return 'rate';
  if (['network', 'timeout', 'sourceSyncPending', 'sourceSyncRecovering', 'semanticOffline'].includes(code)) return 'network';
  if (code === 'invalidData') return 'source';
  if (code === 'sourceStoreUnavailable') return 'storage';
  if (code === 'capacity') return 'capacity';
  if (['sourceAutomationPaused', 'sourcePolicyUnavailable', 'local_key_required'].includes(code)) return 'configuration';
  if (/Unknown|Unresolved|unsettled|nativeOutcome|unconfirmed/iu.test(code)) return 'unconfirmed';
  if (/Destination|Migration|bindingUnavailable|folderChanged|sourceNeedsReview|chooseArchiveRoot|folderCreateFailed/iu.test(code)) return 'destination';
  if (/Changed|Stale|staleCursor|previewStale|conflict|sourceReviewRequired|refreshCatalogRequired/iu.test(code)) return 'changed';
  if (['unsupported', 'browserUnsupported', 'schemaIncompatible', 'sourceSyncUpgradeRequired'].includes(code)) return 'unsupported';
  return 'unknown';
}
export function siteOperation(kind: string): SiteOperation {
  if (/\.import\.(start|freeze|resume)/u.test(kind)) return 'read';
  if (/\.import\.(approve|retry|cancel)/u.test(kind)) return 'save';
  if (kind.includes('.reconcile.')) return 'reconcile';
  if (kind.includes('.repair.')) return 'recover';
  if (kind.includes('.operations.')) return 'recover';
  if (kind.includes('.semantic.')) return 'classify';
  if (kind.includes('.cloud.')) return kind.includes('configure') ? 'configure' : 'save';
  if (kind.startsWith('known.community.')) return 'configure';
  if (kind.includes('.archive.')) return 'configure';
  if (/\.(enable|confirm|reconnect)$/u.test(kind)) return 'connect';
  if (/\.(inspect|retryConfirmation)$/u.test(kind)) return 'inspect';
  return 'status';
}

/** Host-owned, bounded history, independent of source IndexedDB health. No page payloads or private content. */
export function createSiteActivity(storage: StorageArea, adapter: { adapterId: string; version: string; siteKey: string },
  environment: { extensionVersion: string; browserMajor?: number | null }, now = Date.now, random = () => crypto.randomUUID()) {
  const key = `known.siteAdapters.activity.v1:${adapter.adapterId}`;
  const byKey = lanes.get(storage) ?? new Map<string, Lane>(); lanes.set(storage, byKey);
  const lane = byKey.get(key) ?? createLane(); byKey.set(key, lane);
  const read = async (): Promise<SiteActivity[]> => {
    const stored = (await storage.get(key))[key] as { version: number; events: SiteActivity[] } | undefined;
    if (stored && stored.version !== 1) throw new Error('activitySchemaIncompatible');
    return stored?.events ?? [];
  };
  const write = (events: SiteActivity[]) => {
    const pinned = events.filter(e => e.kind === 'problem' && !e.resolvedAt).slice(-20);
    const rest = events.filter(e => !pinned.includes(e)).slice(-(80 - pinned.length));
    return storage.set({ [key]: { version: 1, events: [...rest, ...pinned].sort((a, b) => a.firstAt - b.firstAt) } });
  };
  return {
    record: (input: ActivityInput) => lane(async () => {
      const events = await read(), at = now(), taskRef = ref(input.taskId), collectionRef = ref(input.collectionId);
      const code = ['problem', 'waiting'].includes(input.kind) ? token(input.code) ?? 'unclassified' : undefined;
      const counts = input.counts ? { read: number(input.counts.read), saved: number(input.counts.saved), skipped: number(input.counts.skipped),
        ...(input.counts.total === undefined ? {} : { total: number(input.counts.total) }),
        ...(input.counts.readFailures === undefined ? {} : { readFailures: number(input.counts.readFailures) }),
        ...(input.counts.unclassified === undefined ? {} : { unclassified: number(input.counts.unclassified) }) } : undefined;
      for (const event of events) if (event.taskRef === taskRef && !event.resolvedAt && (event.kind === 'problem' || event.kind === 'waiting')
        && (input.kind === 'stopped' || input.kind === 'checked' && (event.operation === 'read' || event.code === 'sourceReviewRequired') || input.kind === 'problem' && event.kind === 'waiting' && event.operation === input.operation)) {
        event.resolvedAt = at; event.resolution = 'dismissed';
      }
      const existing = ['problem', 'waiting'].includes(input.kind) && events.findLast(e => e.kind === input.kind && !e.resolvedAt && e.operation === input.operation
        && e.taskRef === taskRef && e.collectionRef === collectionRef && e.connectionRef === ref(input.connectionId) && e.code === code);
      const confirmed = input.kind === 'saved' && input.commandId && events.find(e => e.kind === 'saved' && e.commandRef === ref(input.commandId));
      if (confirmed) return structuredClone(confirmed);
      if (existing) {
        existing.lastAt = at; existing.occurrences++; existing.latestCounts = counts;
        if (Number.isFinite(input.retryAt)) existing.latestRetryAt = input.retryAt;
        await write(events); return structuredClone(existing);
      }
      const event: SiteActivity = { id: random(), kind: input.kind, operation: input.operation, firstAt: at, lastAt: at, occurrences: 1,
        taskRef, collectionRef, connectionRef: ref(input.connectionId), requestRef: ref(input.requestId), commandRef: ref(input.commandId), phase: token(input.phase), action: token(input.action), counts,
        ...(input.reviewSamples?.length ? { review: input.reviewSamples.slice(0, 20).map(r => ({ code: activityCode(r.reason), itemRef: ref(r.itemId), collectionRef: ref(r.collectionId) })) } : {}),
        ...(code ? { code, family: problemFamily(code) } : {}),
        ...(Number.isInteger(input.httpStatus) && Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599 ? { httpStatus: input.httpStatus } : {}),
        ...(Number.isSafeInteger(input.sourceCode) && Math.abs(Number(input.sourceCode)) <= 1_000_000_000 ? { sourceCode: input.sourceCode } : {}),
        ...(Number.isFinite(input.retryAt) ? { retryAt: input.retryAt, automatic: input.automatic === true } : {}) };
      events.push(event); await write(events); return structuredClone(event);
    }),
    resolve: (taskId: string, operation: SiteOperation, codes?: readonly string[]) => lane(async () => {
      const events = await read(); let changed = false;
      for (const event of events) if ((event.kind === 'problem' || event.kind === 'waiting') && !event.resolvedAt && event.taskRef === ref(taskId) && event.operation === operation && (!codes || !!event.code && codes.includes(event.code))) {
        event.resolvedAt = now(); event.resolution = 'recovered'; changed = true;
      }
      if (changed) await write(events);
    }),
    dismiss: (id: string) => lane(async () => {
      const events = await read(), event = events.find(e => e.id === id);
      if (!event) throw new Error('activityMissing');
      if (event.kind === 'problem' && !event.resolvedAt) { event.resolvedAt = now(); event.resolution = 'dismissed'; await write(events); }
    }),
    list: () => lane(async () => (await read()).slice().sort((a, b) => b.lastAt - a.lastAt)),
    report: (id?: string) => lane(async () => {
      const events = await read(), incident = id ? events.find(e => e.id === id) : events.findLast(e => e.kind === 'problem');
      if (id && !incident) throw new Error('activityMissing');
      const history = incident?.taskRef ? events.filter(e => e.taskRef === incident.taskRef) : events.slice(-20);
      return { format: 'known.site-adapter-report/v1', capturedAt: now(), adapter: { adapterId: adapter.adapterId, version: adapter.version, siteKey: adapter.siteKey },
        environment: { extensionVersion: environment.extensionVersion, browserMajor: environment.browserMajor },
        incident: incident ?? null, history: history.slice(-40) };
    }),
  };
}
