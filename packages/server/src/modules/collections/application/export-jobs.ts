import { createHash } from 'node:crypto';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandResult,
} from '../../commands/index.js';
import { formatUtcDateTime, generateOpaqueId } from '../domain/index.js';
import {
  EXPORT_JOB_MAX_BYTES,
  type ExportObjectStore,
} from './export-object-store.js';

export const EXPORT_JOB_COMMAND_SCOPE = 'collections:export-jobs:v1';
export const EXPORT_JOB_CONTRACT_VERSION = '1.0.0';
export const EXPORT_JOB_ROUTE = '/api/v1/me/export-jobs';
export const EXPORT_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPORT_JOB_LIST_LIMIT = 50;
export const EXPORT_JOB_CONFLICT_RETRY_AFTER_SECONDS = 5;
export const EXPORT_LIBRARY_JSON_CONTENT_TYPE = 'application/json';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export type ExportJobStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

export class ExportJobInputError extends Error {
  readonly code: 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'ExportJobInputError';
    this.code = 'invalid_request';
  }
}

/** Cross-job conflict: a different command id while pending|running already exists. */
export class ExportJobCapacityError extends Error {
  constructor() { super('Export projection exceeds its byte budget'); this.name = 'ExportJobCapacityError'; }
}

export class ExportJobConflictError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = EXPORT_JOB_CONFLICT_RETRY_AFTER_SECONDS) {
    super('An export job is already in progress.');
    this.name = 'ExportJobConflictError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ExportJobRecord {
  readonly jobId: string;
  readonly ownerSubjectId: string;
  readonly status: ExportJobStatus;
  readonly objectKey: string | null;
  readonly byteSize: number | null;
  readonly createdAt: Date;
  readonly readyAt: Date | null;
  readonly expiresAt: Date;
  readonly errorClass: string | null;
}

export interface ExportJob {
  readonly jobId: string;
  readonly status: ExportJobStatus;
  readonly createdAt: string;
  readonly readyAt?: string;
  readonly expiresAt?: string;
  readonly errorClass?: string;
}

export interface ExportJobPage {
  readonly items: readonly ExportJob[];
}

export interface ExportNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: 'folder' | 'bookmark';
  readonly isRoot: boolean;
  readonly title: string | null;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: 'inherit' | 'protected' | 'private';
}

export interface ExportCollection {
  readonly id: string;
  readonly title: string;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly publicationSlug: string | null;
  readonly nodes: readonly ExportNode[];
}

export interface ExportLibraryDocument {
  readonly exportedAt: string;
  readonly collections: readonly ExportCollection[];
}

export interface ExportJobWritePort {
  findActive(ownerSubjectId: string): Promise<ExportJobRecord | null>;
  insertPending(input: {
    readonly jobId: string;
    readonly ownerSubjectId: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<void>;
}

export interface ExportJobReadPort {
  listByOwner(ownerSubjectId: string, limit: number): Promise<readonly ExportJobRecord[]>;
  getById(jobId: string): Promise<ExportJobRecord | null>;
}

export interface ExportLibraryProjectionPort {
  loadOwnedLiveTree(ownerSubjectId: string, maxBytes?: number): Promise<readonly ExportCollection[]>;
}

export interface ExportJobWorkerPort {
  renewLease?(input: { readonly jobId: string; readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<boolean>;
  markExpired(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
  }): Promise<boolean>;
  markRunning(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly objectKey?: string;
  }): Promise<boolean>;
  markFailed(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly errorClass: string;
  }): Promise<boolean>;
  markReady(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly objectKey: string;
    readonly byteSize: number;
    readonly readyAt: Date;
  }): Promise<boolean>;
}

export interface ExportJobClaim {
  readonly jobId: string;
  readonly ownerSubjectId: string;
  readonly status: ExportJobStatus;
  readonly objectKey: string | null;
  readonly expiresAt: Date;
  readonly leaseOwner: string;
}

/**
 * Receipt port for export-job POST. `lookup` is a read-only peek: it must not
 * insert a row. Cross-job conflict throws before claim so command id B never
 * gets an in_progress receipt (sendProductCommandReceiptOutcome in_progress
 * would say “this id” and would leave B’s row).
 */
export interface ExportJobReceiptPort {
  claim(
    binding: ProductCommandBinding,
    fingerprint: string,
  ): Promise<ProductCommandClaim>;
  complete(
    binding: ProductCommandBinding,
    fingerprint: string,
    result: ProductCommandResult,
  ): Promise<void>;
  lookup(
    binding: ProductCommandBinding,
    fingerprint: string,
  ): Promise<
    | { readonly kind: 'absent' }
    | Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>
  >;
}

export interface CreateMyExportJobPorts {
  readonly receipts: ExportJobReceiptPort;
  readonly jobs: ExportJobWritePort;
  readonly clock: { now(): Date | Promise<Date> };
  readonly ids?: { nextJobId(): string };
}

export interface CreateMyExportJobInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
}

export type CreateMyExportJobResult =
  | { readonly kind: 'succeeded'; readonly job: ExportJob }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };

export function exportJobsFingerprint(): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: EXPORT_JOB_ROUTE,
    mediaType: 'application/json',
    body: null,
  });
}

export function toExportJob(record: ExportJobRecord): ExportJob {
  const job: {
    jobId: string;
    status: ExportJobStatus;
    createdAt: string;
    readyAt?: string;
    expiresAt?: string;
    errorClass?: string;
  } = {
    jobId: record.jobId,
    status: record.status,
    createdAt: formatUtcDateTime(record.createdAt),
  };
  if (record.readyAt) job.readyAt = formatUtcDateTime(record.readyAt);
  job.expiresAt = formatUtcDateTime(record.expiresAt);
  if (record.errorClass) job.errorClass = record.errorClass;
  return job;
}

export function encodeExportLibraryDocument(document: ExportLibraryDocument): Buffer {
  return Buffer.from(JSON.stringify(document), 'utf8');
}

export async function createMyExportJob(
  ports: CreateMyExportJobPorts,
  input: CreateMyExportJobInput,
): Promise<CreateMyExportJobResult> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new ExportJobInputError('The export job actor is invalid.');
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new ExportJobInputError('commandId must be a canonical UUID v4.');
  }
  const fingerprint = exportJobsFingerprint();
  const binding = {
    principalId: input.actor.principalId,
    commandScope: EXPORT_JOB_COMMAND_SCOPE,
    commandId,
  };
  const active = await ports.jobs.findActive(input.actor.subjectId);
  if (active) {
    const existing = await ports.receipts.lookup(binding, fingerprint);
    if (existing.kind !== 'absent') return mapClaim(existing);
    // Different command id while pending|running already exists. Throw before
    // claim so B never gets a receipt row (same-id replay used lookup above).
    throw new ExportJobConflictError();
  }
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const createdAt = await Promise.resolve(ports.clock.now());
  const expiresAt = new Date(createdAt.getTime() + EXPORT_JOB_TTL_MS);
  const jobId = ports.ids?.nextJobId() ?? generateOpaqueId();
  try {
    await ports.jobs.insertPending({
      jobId,
      ownerSubjectId: input.actor.subjectId,
      createdAt,
      expiresAt,
    });
  } catch (error: unknown) {
    if (error instanceof ExportJobConflictError) throw error;
    throw error;
  }
  const job = toExportJob({
    jobId,
    ownerSubjectId: input.actor.subjectId,
    status: 'pending',
    objectKey: null,
    byteSize: null,
    createdAt,
    readyAt: null,
    expiresAt,
    errorClass: null,
  });
  await ports.receipts.complete(binding, fingerprint, productResult(job));
  return { kind: 'succeeded', job };
}

export async function listMyExportJobs(
  reads: ExportJobReadPort,
  ownerSubjectId: string,
): Promise<ExportJobPage> {
  if (typeof ownerSubjectId !== 'string' || ownerSubjectId.length < 1) {
    throw new ExportJobInputError('The export job actor is invalid.');
  }
  const rows = await reads.listByOwner(ownerSubjectId, EXPORT_JOB_LIST_LIMIT);
  return { items: rows.map(toExportJob) };
}

export async function getMyExportJob(
  reads: ExportJobReadPort,
  input: { readonly ownerSubjectId: string; readonly jobId: string },
): Promise<ExportJob | null> {
  if (typeof input.ownerSubjectId !== 'string' || input.ownerSubjectId.length < 1) {
    throw new ExportJobInputError('The export job actor is invalid.');
  }
  if (typeof input.jobId !== 'string' || !OPAQUE_ID.test(input.jobId)) return null;
  const row = await reads.getById(input.jobId);
  if (!row || row.ownerSubjectId !== input.ownerSubjectId) return null;
  return toExportJob(row);
}

export async function downloadMyExportJob(
  ports: {
    readonly reads: ExportJobReadPort;
    readonly store: ExportObjectStore;
    readonly clock: { now(): Date | Promise<Date> };
  },
  input: { readonly ownerSubjectId: string; readonly jobId: string },
): Promise<Buffer | null> {
  if (typeof input.ownerSubjectId !== 'string' || input.ownerSubjectId.length < 1) {
    throw new ExportJobInputError('The export job actor is invalid.');
  }
  if (typeof input.jobId !== 'string' || !OPAQUE_ID.test(input.jobId)) return null;
  const row = await ports.reads.getById(input.jobId);
  const now = await Promise.resolve(ports.clock.now());
  if (!row || row.ownerSubjectId !== input.ownerSubjectId) return null;
  if (row.status !== 'ready' || now.getTime() >= row.expiresAt.getTime()) return null;
  return row.objectKey ? ports.store.get(row.objectKey) : null;
}

export async function processExportJobClaim(
  ports: {
    readonly worker: ExportJobWorkerPort;
    readonly projection: ExportLibraryProjectionPort;
    readonly store: ExportObjectStore;
    readonly clock: { now(): Date };
    readonly maxBytes?: number;
  },
  claim: ExportJobClaim,
): Promise<void> {
  const now = ports.clock.now();
  const maxBytes = ports.maxBytes ?? EXPORT_JOB_MAX_BYTES;
  if (now.getTime() >= claim.expiresAt.getTime()) {
    if (claim.objectKey) {
      // Do not make the row terminal until object cleanup succeeds. A transient
      // store failure leaves the lease reclaimable so the next pass can retry.
      await ports.store.delete(claim.objectKey);
    }
    await ports.worker.markExpired({ jobId: claim.jobId, leaseOwner: claim.leaseOwner });
    return;
  }
  // A generation owns its object for its entire lifetime, including late cleanup.
  const objectKey = `${claim.jobId}/${createHash('sha256').update(claim.leaseOwner).digest('hex')}`;
  // Clean the prior reserved key before replacing its durable reference.
  if (claim.objectKey && claim.objectKey !== objectKey) await ports.store.delete(claim.objectKey);
  const running = await ports.worker.markRunning({
    jobId: claim.jobId, leaseOwner: claim.leaseOwner, objectKey,
  });
  if (!running) return;
  try {
    const collections = await ports.projection.loadOwnedLiveTree(claim.ownerSubjectId, maxBytes);
    const document: ExportLibraryDocument = {
      exportedAt: formatUtcDateTime(now),
      collections,
    };
    const body = encodeExportLibraryDocument(document);
    if (body.byteLength > maxBytes) {
      throw new ExportJobCapacityError();
    }
    await ports.store.put(objectKey, body, EXPORT_LIBRARY_JSON_CONTENT_TYPE);
    const ready = await ports.worker.markReady({
      jobId: claim.jobId,
      leaseOwner: claim.leaseOwner,
      objectKey,
      byteSize: body.byteLength,
      readyAt: ports.clock.now(),
    });
    if (!ready) await ports.store.delete(objectKey);
  } catch (error: unknown) {
    try {
      await ports.worker.markFailed({
        jobId: claim.jobId, leaseOwner: claim.leaseOwner, errorClass: error instanceof ExportJobCapacityError ? 'over_capacity' : 'internal',
      });
    } catch (markFailure: unknown) {
      throw new AggregateError([error, markFailure],
        'Export job processing and failure persistence both failed');
    }
    // Persisting the failure must not hide its cause from the worker logger.
    throw error;
  }
}

function productResult(job: ExportJob): ProductCommandResult {
  const body = JSON.stringify(job);
  return {
    status: 201,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: EXPORT_JOB_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CreateMyExportJobResult {
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return { kind: 'expired' };
  return { kind: 'reused' };
}
