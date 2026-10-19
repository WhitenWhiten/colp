/**
 * Shared fake ports for favicon execution unit tests (T06/T07/T08).
 *
 * All state is in memory and time is a controlled counter: no real timers,
 * no database, no object store. Lease takeover is simulated by mutating
 * `state.job.leaseOwner` from a deterministic hook (fetch/store/item read).
 */
import {
  DEFAULT_FAVICON_PROVIDER_TEMPLATE,
  type FaviconPolicyRow,
} from '../../../src/modules/collections/application/favicon-policy.js';
import type {
  BookmarkIconRow,
  BookmarkIconWritePort,
} from '../../../src/modules/collections/application/ports.js';
import type {
  FaviconJobRecord,
  FaviconJobErrorReason,
} from '../../../src/modules/collections/application/favicon-job.js';
import type {
  FaviconBatchCasPorts,
} from '../../../src/modules/collections/application/favicon-batch-execution.js';
import type {
  FaviconJobItemRow,
  FaviconSourceRestoreRow,
} from '../../../src/modules/collections/application/favicon-batch-policy.js';
import type {
  FaviconBatchExecutionPorts,
  FaviconJobClaim,
  FaviconRefreshCasPorts,
  FaviconRefreshExecutionPorts,
  FaviconFetchedImage,
  FaviconJobWorkerPort,
} from '../../../src/modules/collections/application/favicon-job-execution.js';

export const NOW = new Date('2026-09-17T00:00:00.000Z');
export const PROVIDER_URL = 'https://favicone.com/example.com';
export const FETCHED: FaviconFetchedImage = {
  body: Buffer.from('fetched-png-bytes'),
  mime: 'image/png',
  width: 16,
  height: 16,
};

export function makeClaim(overrides: Partial<FaviconJobClaim> = {}): FaviconJobClaim {
  return Object.freeze({
    jobId: 'job-1',
    leaseOwner: 'worker-old',
    accountId: 'account-1',
    ownerSubjectId: 'subject-1',
    operation: 'fill_missing',
    status: 'running',
    attempts: 0,
    collectionId: 'collection-1',
    nodeId: 'node-1',
    sourceUrl: PROVIDER_URL,
    sourceRevision: '1',
    policyRevision: '2',
    nodeResourceRevision: 'rev-1',
    objectId: null,
    ...overrides,
  });
}

export function makeJob(overrides: Partial<FaviconJobRecord> = {}): FaviconJobRecord {
  return Object.freeze({
    jobId: 'job-1',
    accountId: 'account-1',
    ownerSubjectId: 'subject-1',
    operation: 'refresh_one',
    policyRevision: 2n,
    status: 'running',
    total: 1,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errorNodeId: null,
    errorReason: null,
    collectionId: 'collection-1',
    nodeId: 'node-1',
    sourceUrl: PROVIDER_URL,
    sourceRevision: 1n,
    nodeResourceRevision: 'rev-1',
    objectId: null,
    objectContentType: null,
    objectByteSize: null,
    objectDigestSha256: null,
    createdAt: NOW,
    updatedAt: NOW,
    leaseOwner: 'worker-old',
    leaseUntil: new Date(NOW.getTime() + 60_000),
    ...overrides,
  });
}

export function makeItem(overrides: Partial<FaviconJobItemRow> = {}): FaviconJobItemRow {
  return Object.freeze({
    jobId: 'job-1',
    nodeId: 'node-1',
    collectionId: 'collection-1',
    sourceUrl: PROVIDER_URL,
    sourceRevision: 1n,
    nodeResourceRevision: 'rev-1',
    status: 'pending',
    errorReason: null,
    attempts: 0,
    nextAttemptAt: null,
    objectId: null,
    objectContentType: null,
    objectByteSize: null,
    objectDigestSha256: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

export function makeBinding(objectId: string, nodeId = 'node-1'): BookmarkIconRow {
  return Object.freeze({
    nodeId,
    collectionId: 'collection-1',
    objectId,
    contentType: 'image/png',
    byteSize: 5,
    digestSha256: Buffer.alloc(32),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export function makePolicy(revision = 2n): FaviconPolicyRow {
  return Object.freeze({
    accountId: 'account-1',
    newDefault: 'online',
    providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
    fillMissing: false,
    forceAllOnline: false,
    revision,
    updatedAt: NOW,
  });
}

export function makeRestore(overrides: Partial<FaviconSourceRestoreRow> = {}): FaviconSourceRestoreRow {
  return Object.freeze({
    nodeId: 'node-1',
    collectionId: 'collection-1',
    accountId: 'account-1',
    originalSourceMode: 'online',
    originalObjectId: 'object-original',
    originalContentType: 'image/png',
    originalByteSize: 5,
    originalDigestSha256: Buffer.alloc(32),
    sourceRevision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function sourceRow(revision = 1n) {
  return {
    nodeId: 'node-1',
    collectionId: 'collection-1',
    sourceMode: 'online' as const,
    revision,
    updatedAt: NOW,
  };
}

function nodeRow(revision = 'rev-1') {
  return {
    id: 'node-1',
    collectionId: 'collection-1',
    kind: 'bookmark' as const,
    deletedAt: null,
    url: 'https://example.com/bookmark',
    resourceRevision: revision,
    parentId: 'parent-1',
    positionToken: 'p1',
    title: 't',
    description: null,
    tags: [],
    visibility: 'private' as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function collectionRow() {
  return {
    id: 'collection-1',
    ownerSubjectId: 'subject-1',
    deletedAt: null,
    visibility: 'private' as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const unused = async (): Promise<never> => {
  throw new Error('port not used by this test');
};

/** Writable single-job (refresh_one) execution harness. */
export interface SingleHarness {
  readonly ports: FaviconRefreshExecutionPorts;
  readonly tx: FaviconRefreshCasPorts;
  readonly state: {
    job: FaviconJobRecord;
    binding: BookmarkIconRow | null;
    sourceRevision: bigint;
    nodeRevision: string;
    policyRevision: bigint;
    locks: string[];
    objectIdWrites: number;
    upserts: number;
    retired: Array<{ objectId: string; deletableAt: Date }>;
    successMarks: number;
    retryWrites: Array<{ attempts: number; nextAttemptAt: Date }>;
    failedWrites: Array<{ attempts: number; reason: FaviconJobErrorReason }>;
    fetches: number;
    puts: number;
    nowMs: number;
  };
}

export function makeSingleHarness(options: {
  readonly claim?: Partial<FaviconJobClaim>;
  readonly binding?: BookmarkIconRow | null;
  readonly retentionSeconds?: number;
  readonly objectBytes?: Map<string, Buffer>;
  readonly onFetch?: (state: SingleHarness['state']) => void;
  readonly onNodeRead?: (state: SingleHarness['state']) => void;
  readonly fetcherThrows?: unknown;
} = {}): SingleHarness {
  const state: SingleHarness['state'] = {
    job: makeJob({ operation: 'refresh_one', objectId: options.claim?.objectId ?? null }),
    binding: options.binding ?? null,
    sourceRevision: 1n,
    nodeRevision: 'rev-1',
    policyRevision: 2n,
    locks: [],
    objectIdWrites: 0,
    upserts: 0,
    retired: [],
    successMarks: 0,
    retryWrites: [],
    failedWrites: [],
    fetches: 0,
    puts: 0,
    nowMs: NOW.getTime(),
  };
  const bytes = options.objectBytes ?? new Map<string, Buffer>();
  const now = () => new Date(state.nowMs);
  const worker: FaviconJobWorkerPort = {
    async markRunning() { return true; },
    async scheduleRetry(input) {
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      state.retryWrites.push({ attempts: input.attempts, nextAttemptAt: input.nextAttemptAt });
      state.job = { ...state.job, status: 'pending', attempts: input.attempts, leaseOwner: null, leaseUntil: null };
      return true;
    },
    async markFailed(input) {
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      state.failedWrites.push({ attempts: input.attempts, reason: input.errorReason });
      state.job = { ...state.job, status: 'failed', attempts: input.attempts, leaseOwner: null, leaseUntil: null };
      return true;
    },
    async markSucceeded(input) {
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      state.successMarks += 1;
      state.job = { ...state.job, status: 'succeeded', leaseOwner: null, leaseUntil: null };
      return true;
    },
    async updateBatch() { return false; },
    async renewLease(input) { return state.job.leaseOwner === input.leaseOwner; },
  };
  const tx: FaviconRefreshCasPorts = {
    jobs: {
      insert: unused,
      async findByJobId(jobId) { return jobId === state.job.jobId ? state.job : null; },
      async lockByJobId(jobId) {
        state.locks.push(jobId);
        return jobId === state.job.jobId ? state.job : null;
      },
      async setObjectId(input) {
        state.objectIdWrites += 1;
        state.job = { ...state.job, objectId: input.objectId };
      },
      async setObjectMetadata(input) {
        state.job = { ...state.job, objectId: input.objectId };
      },
    },
    gc: {
      async recordRetired(input) {
        state.retired.push({ objectId: input.objectId, deletableAt: input.deletableAt });
      },
    },
    collections: {
      async lockForUpdate() { return collectionRow() as never; },
    },
    nodes: {
      async getNode() {
        options.onNodeRead?.(state);
        return nodeRow(state.nodeRevision) as never;
      },
    },
    sources: {
      async findByNodeId() { return sourceRow(state.sourceRevision); },
      async setMode() { return undefined; },
    },
    policies: {
      async findByAccountId() { return makePolicy(state.policyRevision); },
    },
    bookmarkIcons: {
      async findByNodeId() { return state.binding; },
      async upsert(row) {
        state.upserts += 1;
        state.binding = row;
      },
    } as unknown as BookmarkIconWritePort,
  };
  const ports: FaviconRefreshExecutionPorts = {
    verify: { async run(work) { return work(tx); } },
    worker,
    async fetcher() {
      state.fetches += 1;
      options.onFetch?.(state);
      if (options.fetcherThrows !== undefined) throw options.fetcherThrows;
      return FETCHED;
    },
    store: {
      async get(objectId) {
        const body = bytes.get(objectId);
        return body === undefined ? null : { contentType: 'image/png', body };
      },
      async put(objectId, body) {
        state.puts += 1;
        bytes.set(objectId, body);
      },
    },
    clock: { now: async () => now() },
    now,
    options: {
      maxAttempts: 5,
      backoffSeconds: [1, 2, 4, 8, 16],
      retentionSeconds: options.retentionSeconds ?? 86_400,
      maxBytes: 65_536,
      maxDecompressedBytes: 65_536 * 64,
      fetchTimeoutMs: 10_000,
      maxRedirects: 3,
    },
  };
  return { ports, tx, state };
}

/** Writable batch-item execution harness. */
export interface BatchHarness {
  readonly ports: FaviconBatchExecutionPorts;
  readonly tx: FaviconBatchCasPorts;
  readonly state: {
    job: FaviconJobRecord;
    items: Map<string, FaviconJobItemRow>;
    binding: BookmarkIconRow | null;
    restore: FaviconSourceRestoreRow | null;
    locks: string[];
    itemWrites: string[];
    restoreDeletes: number;
    retired: Array<{ objectId: string; deletableAt: Date }>;
    renews: Array<{ leaseOwner: string; at: number }>;
    retryWrites: Array<{ attempts: number; nextAttemptAt: Date }>;
    successMarks: number;
    updateBatches: number;
    fetches: number;
    puts: number;
    nowMs: number;
  };
}

export function makeBatchHarness(options: {
  readonly claim?: Partial<FaviconJobClaim>;
  readonly items?: readonly FaviconJobItemRow[];
  readonly binding?: BookmarkIconRow | null;
  readonly restore?: FaviconSourceRestoreRow | null;
  readonly retentionSeconds?: number;
  readonly batchSize?: number;
  readonly onFetch?: (state: BatchHarness['state']) => void;
  readonly onItemRead?: (state: BatchHarness['state']) => void;
  readonly onItemSucceeded?: (state: BatchHarness['state'], nodeId: string) => void;
  readonly fetcherThrows?: unknown;
} = {}): BatchHarness {
  const items = new Map<string, FaviconJobItemRow>();
  for (const item of options.items ?? [makeItem(), makeItem({ nodeId: 'node-2' })]) {
    items.set(item.nodeId, item);
  }
  const state: BatchHarness['state'] = {
    job: makeJob({ operation: options.claim?.operation ?? 'fill_missing' }),
    items,
    binding: options.binding ?? null,
    restore: options.restore ?? null,
    locks: [],
    itemWrites: [],
    restoreDeletes: 0,
    retired: [],
    renews: [],
    retryWrites: [],
    successMarks: 0,
    updateBatches: 0,
    fetches: 0,
    puts: 0,
    nowMs: NOW.getTime(),
  };
  const now = () => new Date(state.nowMs);
  const updateItem = (nodeId: string, patch: Partial<FaviconJobItemRow>) => {
    const current = state.items.get(nodeId);
    if (current === undefined) return;
    state.items.set(nodeId, { ...current, ...patch, updatedAt: now() });
  };
  const worker: FaviconJobWorkerPort = {
    async markRunning() { return true; },
    async scheduleRetry(input) {
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      state.retryWrites.push({ attempts: input.attempts, nextAttemptAt: input.nextAttemptAt });
      return true;
    },
    async markFailed(input) {
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      return true;
    },
    async markSucceeded(input) {
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      state.successMarks += 1;
      return true;
    },
    async updateBatch(input) {
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      state.updateBatches += 1;
      state.job = {
        ...state.job,
        status: input.status,
        succeeded: input.succeeded,
        failed: input.failed,
        skipped: input.skipped,
        leaseOwner: null,
        leaseUntil: null,
      };
      return true;
    },
    async renewLease(input) {
      state.renews.push({ leaseOwner: input.leaseOwner, at: state.nowMs });
      if (state.job.leaseOwner !== input.leaseOwner) return false;
      state.job = { ...state.job, leaseUntil: new Date(state.nowMs + input.leaseDurationMs) };
      return true;
    },
  };
  const tx: FaviconBatchCasPorts = {
    jobs: {
      insert: unused,
      async findByJobId(jobId) { return jobId === state.job.jobId ? state.job : null; },
      async lockByJobId(jobId) {
        state.locks.push(jobId);
        return jobId === state.job.jobId ? state.job : null;
      },
      async setObjectId(input) { state.job = { ...state.job, objectId: input.objectId }; },
      async setObjectMetadata(input) { state.job = { ...state.job, objectId: input.objectId }; },
    },
    items: {
      async findByJobAndNode(jobId, nodeId) {
        options.onItemRead?.(state);
        if (jobId !== state.job.jobId) return null;
        return state.items.get(nodeId) ?? null;
      },
      async markSkipped(jobId, nodeId) {
        state.itemWrites.push(`skipped:${nodeId}`);
        updateItem(nodeId, { status: 'skipped', errorReason: null, nextAttemptAt: null });
      },
      async markFailed(jobId, nodeId, attempts, reason) {
        state.itemWrites.push(`failed:${nodeId}:${attempts}:${reason}`);
        updateItem(nodeId, { status: 'failed', attempts, errorReason: reason, nextAttemptAt: null });
      },
      async scheduleRetry(jobId, nodeId, attempts, nextAttemptAt, reason) {
        state.itemWrites.push(`retry:${nodeId}:${attempts}:${reason}`);
        state.retryWrites.push({ attempts, nextAttemptAt });
        updateItem(nodeId, { status: 'pending', attempts, errorReason: reason, nextAttemptAt });
      },
      async setObjectId(jobId, nodeId, objectId) {
        state.itemWrites.push(`object-id:${nodeId}`);
        updateItem(nodeId, { objectId });
      },
      async setObjectMetadata(input) {
        state.itemWrites.push(`object-metadata:${input.nodeId}`);
        updateItem(input.nodeId, {
          objectId: input.objectId,
          objectContentType: input.contentType,
          objectByteSize: input.byteSize,
          objectDigestSha256: input.digestSha256,
        });
      },
      async markSucceeded(jobId, nodeId) {
        state.itemWrites.push(`succeeded:${nodeId}`);
        updateItem(nodeId, { status: 'succeeded', errorReason: null, nextAttemptAt: null });
        options.onItemSucceeded?.(state, nodeId);
      },
      async listDueItems(input) {
        return [...state.items.values()]
          .filter((item) => item.status === 'pending'
            && (item.nextAttemptAt === null || item.nextAttemptAt.getTime() <= input.now.getTime()))
          .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
          .slice(0, input.limit);
      },
      async aggregateItems() {
        const all = [...state.items.values()];
        let succeeded = 0;
        let failed = 0;
        let skipped = 0;
        let pendingCount = 0;
        let nextAttemptAt: Date | null = null;
        for (const item of all) {
          if (item.status === 'succeeded') succeeded += 1;
          else if (item.status === 'failed') failed += 1;
          else if (item.status === 'skipped') skipped += 1;
          else {
            pendingCount += 1;
            if (item.nextAttemptAt !== null
              && (nextAttemptAt === null || item.nextAttemptAt.getTime() < nextAttemptAt.getTime())) {
              nextAttemptAt = item.nextAttemptAt;
            }
          }
        }
        return { total: all.length, succeeded, failed, skipped, pendingCount, nextAttemptAt };
      },
      async listAllItems() { return [...state.items.values()]; },
      async listFailedItems() { return []; },
      async insertRestoreGapItems() { return []; },
      async extendRestoreGeneration() {
        return { readCount: 0, gapReadCount: 0, scanComplete: true, gapCaughtUp: true, cursorNodeId: null, inactive: false };
      },
    },
    collections: {
      async lockForUpdate() { return collectionRow() as never; },
    },
    nodes: {
      async getNode() { return nodeRow() as never; },
    },
    sources: {
      async findByNodeId() { return sourceRow(); },
      async setMode() { return undefined; },
    },
    policies: {
      async findByAccountId() { return makePolicy(); },
    },
    bookmarkIcons: {
      async findByNodeId() { return state.binding; },
      async upsert(row) { state.binding = row; },
    } as unknown as BookmarkIconWritePort,
    gc: {
      async recordRetired(input) {
        state.retired.push({ objectId: input.objectId, deletableAt: input.deletableAt });
      },
    },
    restores: {
      async upsert() { return undefined; },
      async findByNodeId() { return state.restore; },
      async deleteByNodeId(nodeId) {
        state.restoreDeletes += 1;
        state.restore = null;
      },
    },
  };
  const ports: FaviconBatchExecutionPorts = {
    verify: { async run(work) { return work(tx); } },
    worker,
    async fetcher() {
      state.fetches += 1;
      options.onFetch?.(state);
      if (options.fetcherThrows !== undefined) throw options.fetcherThrows;
      return FETCHED;
    },
    store: {
      async get() { return null; },
      async put(objectId, body) {
        state.puts += 1;
        return undefined;
      },
    },
    clock: { now: async () => now() },
    now,
    options: {
      maxAttempts: 5,
      backoffSeconds: [1, 2, 4, 8, 16],
      retentionSeconds: options.retentionSeconds ?? 86_400,
      maxBytes: 65_536,
      maxDecompressedBytes: 65_536 * 64,
      fetchTimeoutMs: 10_000,
      maxRedirects: 3,
      batchSize: options.batchSize ?? 100,
      leaseDurationMs: 60_000,
    },
  };
  return { ports, tx, state };
}
