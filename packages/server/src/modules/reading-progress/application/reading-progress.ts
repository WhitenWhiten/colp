import { assertCanonicalCommandId, canonicalJson, type ProductCommandReceiptPort,
  type ProductCommandResult } from '../../commands/index.js';
import { readingProgressEtag } from './reading-progress-query.js';

export type ReadingProgressResourceType = 'collection' | 'node';
export type ReadingProgressStatus = 'not_started' | 'in_progress' | 'completed';
export const READING_PROGRESS_CONTRACT_VERSION = '1.0.0';
const PROGRESS_SCALE = 100_000;

export type ReadingProgressErrorCode = 'invalid_reading_progress_input'
  | 'invalid_reading_progress_target' | 'invalid_reading_progress_state' | 'reading_progress_not_found'
  | 'reading_progress_precondition_failed';
export class ReadingProgressError extends Error {
  constructor(readonly code: ReadingProgressErrorCode, message: string, readonly currentEtag: string | null = null) {
    super(message); this.name = 'ReadingProgressError';
  }
}

export interface ReadingProgressRecord {
  readonly accountId: string; readonly resourceType: ReadingProgressResourceType; readonly resourceId: string;
  readonly status: ReadingProgressStatus; readonly progress: number; readonly revision: number;
  readonly completedAt: Date | null; readonly createdAt: Date; readonly updatedAt: Date;
}
export interface ReadingProgressTargetFacts {
  readonly resourceType: ReadingProgressResourceType; readonly resourceId: string; readonly collectionId: string;
}
export interface ReadingProgressAuditEvent {
  readonly principalId: string; readonly accountId: string;
  readonly eventType: 'reading_progress.upserted' | 'reading_progress.reset';
  readonly resourceType: ReadingProgressResourceType; readonly status?: ReadingProgressStatus;
  readonly createdAt: Date;
}
export interface ReadingProgressCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly targets: { resolveAccessible(input: { readonly actorSubjectId: string;
    readonly resourceType: ReadingProgressResourceType; readonly resourceId: string }): Promise<ReadingProgressTargetFacts | null> };
  readonly progress: {
    findForUpdate?(input: { readonly accountId: string; readonly resourceType: ReadingProgressResourceType;
      readonly resourceId: string }): Promise<ReadingProgressRecord | null>;
    upsert(input: { readonly accountId: string; readonly resourceType: ReadingProgressResourceType;
      readonly resourceId: string; readonly status: ReadingProgressStatus; readonly progress: number;
      readonly at: Date }): Promise<{ readonly record: ReadingProgressRecord; readonly inserted: boolean }>;
    insertOnly?(input: { readonly accountId: string; readonly resourceType: ReadingProgressResourceType;
      readonly resourceId: string; readonly status: ReadingProgressStatus; readonly progress: number;
      readonly at: Date }): Promise<ReadingProgressRecord | null>;
    reset(input: { readonly accountId: string; readonly resourceType: ReadingProgressResourceType;
      readonly resourceId: string }): Promise<ReadingProgressRecord | null>;
  };
  readonly audit: { append(event: ReadingProgressAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}
export interface ReadingProgressUnitOfWork {
  execute<Result>(work: (ports: ReadingProgressCommandPorts) => Promise<Result>, request?: { readonly signal?: AbortSignal }): Promise<Result>;
}
export interface ReadingProgressCommandBaseInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string; readonly accountId: string };
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope?: string };
  readonly target: { readonly resourceType: ReadingProgressResourceType; readonly resourceId: string };
  /** null means create-only; a strong tag means update/reset that exact account-owned representation. */
  readonly concurrency?: { readonly expectedEtag: string | null };
}
export interface ReadingProgressCommandInput extends ReadingProgressCommandBaseInput {
  readonly state: { readonly status: ReadingProgressStatus; readonly progress: number };
}
export interface ReadingProgressResetCommandInput extends ReadingProgressCommandBaseInput {
  readonly state?: never;
}
export type ReadingProgressCommandResult =
  | { readonly kind: 'upserted'; readonly inserted: boolean; readonly readingProgress: ReadingProgressRecord }
  | { readonly kind: 'reset'; readonly changed: boolean }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export function readingProgressCommandScope(action: 'upsert' | 'reset',
  target: ReadingProgressCommandBaseInput['target']): string {
  return `reading-progress:${target.resourceType}:${target.resourceId}:${action}`;
}

export async function upsertReadingProgress(ports: ReadingProgressCommandPorts,
  input: ReadingProgressCommandInput): Promise<ReadingProgressCommandResult> {
  const value = validateUpsertInput(input);
  const binding = { principalId: value.actor.principalId, commandScope: value.command.commandScope,
    commandId: value.command.commandId };
  const claim = await ports.receipts.claim(binding, value.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const target = await ports.targets.resolveAccessible({ actorSubjectId: value.actor.subjectId,
    resourceType: value.target.resourceType, resourceId: value.target.resourceId });
  if (!target || target.resourceType !== value.target.resourceType || target.resourceId !== value.target.resourceId
      || typeof target.collectionId !== 'string' || target.collectionId.length === 0) {
    throw new ReadingProgressError('reading_progress_not_found', 'Reading progress target was not found.');
  }
  await enforcePrecondition(ports, value);
  const now = await ports.clock.now();
  const write = { accountId: value.actor.accountId, ...value.target, ...value.state, at: now };
  let outcome: { readonly record: ReadingProgressRecord; readonly inserted: boolean };
  if (value.concurrency?.expectedEtag === null && ports.progress.insertOnly) {
    const inserted = await ports.progress.insertOnly(write);
    if (!inserted) { const current = await ports.progress.findForUpdate?.({ accountId: value.actor.accountId, ...value.target });
      throw new ReadingProgressError('reading_progress_precondition_failed',
        'The Reading Progress representation changed before this command.', current ? readingProgressEtag(current) : null); }
    outcome = { record: inserted, inserted: true };
  } else outcome = await ports.progress.upsert(write);
  assertOwnedRecord(outcome.record, value.actor.accountId, value.target);
  await ports.audit.append({ principalId: value.actor.principalId, accountId: value.actor.accountId,
    eventType: 'reading_progress.upserted', resourceType: value.target.resourceType,
    status: outcome.record.status, createdAt: now });
  await ports.receipts.complete(binding, value.command.fingerprint,
    upsertProductResult(outcome.record, outcome.inserted));
  return { kind: 'upserted', inserted: outcome.inserted, readingProgress: outcome.record };
}

export async function resetReadingProgress(ports: ReadingProgressCommandPorts,
  input: ReadingProgressResetCommandInput): Promise<ReadingProgressCommandResult> {
  const value = validateResetInput(input);
  const binding = { principalId: value.actor.principalId, commandScope: value.command.commandScope,
    commandId: value.command.commandId };
  const claim = await ports.receipts.claim(binding, value.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  await enforcePrecondition(ports, value);
  const now = await ports.clock.now();
  const removed = await ports.progress.reset({ accountId: value.actor.accountId, ...value.target });
  if (removed) assertOwnedRecord(removed, value.actor.accountId, value.target);
  await ports.audit.append({ principalId: value.actor.principalId, accountId: value.actor.accountId,
    eventType: 'reading_progress.reset', resourceType: value.target.resourceType, createdAt: now });
  await ports.receipts.complete(binding, value.command.fingerprint, resetProductResult(value.target));
  return { kind: 'reset', changed: removed !== null };
}

interface ValidatedBaseInput extends ReadingProgressCommandBaseInput {
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope: string };
}
interface ValidatedInput extends ValidatedBaseInput {
  readonly state: { readonly status: ReadingProgressStatus; readonly progress: number };
}
function validateBaseInput(input: ReadingProgressCommandBaseInput,
  action: 'upsert' | 'reset'): ValidatedBaseInput {
  if (!input || typeof input !== 'object' || !input.actor || !input.command || !input.target) {
    throw new ReadingProgressError('invalid_reading_progress_input', 'Reading progress command input is required.');
  }
  for (const value of [input.actor.principalId, input.actor.subjectId, input.actor.accountId,
    input.command.fingerprint, input.target.resourceId]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ReadingProgressError('invalid_reading_progress_input', 'Reading progress identity fields are required.');
    }
  }
  if (input.target.resourceType !== 'collection' && input.target.resourceType !== 'node') {
    throw new ReadingProgressError('invalid_reading_progress_target', 'Only Collection and Node targets support progress.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch { throw new ReadingProgressError('invalid_reading_progress_input', 'commandId must be a canonical UUID v4.'); }
  return { ...input, command: { commandId, fingerprint: input.command.fingerprint,
    commandScope: input.command.commandScope?.trim() || readingProgressCommandScope(action, input.target) } };
}
function validateUpsertInput(input: ReadingProgressCommandInput): ValidatedInput {
  const base = validateBaseInput(input, 'upsert');
  if (!input.state || typeof input.state !== 'object') {
    throw new ReadingProgressError('invalid_reading_progress_input', 'Reading progress state is required.');
  }
  const state = input.state as unknown as Record<string, unknown>;
  if (Object.keys(state).some((key) => key !== 'status' && key !== 'progress')) {
    throw new ReadingProgressError('invalid_reading_progress_input',
      'Clients may submit only Reading Progress status and progress.');
  }
  if (state.status !== 'not_started' && state.status !== 'in_progress' && state.status !== 'completed') {
    throw new ReadingProgressError('invalid_reading_progress_state', 'Reading progress status is invalid.');
  }
  if (typeof state.progress !== 'number' || !Number.isFinite(state.progress)) {
    throw new ReadingProgressError('invalid_reading_progress_state', 'Reading progress must be a finite number.');
  }
  const scaled = Math.round(state.progress * PROGRESS_SCALE);
  if (!Number.isSafeInteger(scaled) || state.progress !== scaled / PROGRESS_SCALE) {
    throw new ReadingProgressError('invalid_reading_progress_state', 'Reading progress supports at most five decimals.');
  }
  const progress = scaled === 0 ? 0 : scaled / PROGRESS_SCALE;
  if (progress < 0 || progress > 1
      || (state.status === 'not_started' && progress !== 0)
      || (state.status === 'in_progress' && (progress <= 0 || progress >= 1))
      || (state.status === 'completed' && progress !== 1)) {
    throw new ReadingProgressError('invalid_reading_progress_state', 'Reading progress does not match its status.');
  }
  return { ...base, state: { status: state.status, progress } };
}
function validateResetInput(input: ReadingProgressResetCommandInput): ValidatedBaseInput {
  if (input && typeof input === 'object' && Object.hasOwn(input, 'state')) {
    throw new ReadingProgressError('invalid_reading_progress_input', 'Reset does not accept Reading Progress state.');
  }
  return validateBaseInput(input, 'reset');
}

function assertOwnedRecord(record: ReadingProgressRecord, accountId: string,
  target: ReadingProgressCommandBaseInput['target']): void {
  const expectedProgress = record.status === 'not_started' ? 0 : record.status === 'completed' ? 1 : record.progress;
  if (record.accountId !== accountId || record.resourceType !== target.resourceType || record.resourceId !== target.resourceId
      || (record.status !== 'not_started' && record.status !== 'in_progress' && record.status !== 'completed')
      || !Number.isInteger(record.revision) || record.revision < 1 || !Number.isFinite(record.progress)
      || record.progress !== Math.round(record.progress * PROGRESS_SCALE) / PROGRESS_SCALE
      || record.progress !== expectedProgress || record.progress < 0 || record.progress > 1
      || (record.status === 'in_progress' && (record.progress <= 0 || record.progress >= 1))
      || !(record.createdAt instanceof Date) || !Number.isFinite(record.createdAt.getTime())
      || !(record.updatedAt instanceof Date) || !Number.isFinite(record.updatedAt.getTime())
      || record.updatedAt.getTime() < record.createdAt.getTime()
      || (record.status === 'completed' ? !(record.completedAt instanceof Date)
        || !Number.isFinite(record.completedAt.getTime())
        || record.completedAt.getTime() < record.createdAt.getTime()
        || record.completedAt.getTime() > record.updatedAt.getTime()
        : record.completedAt !== null)) {
    throw new ReadingProgressError('invalid_reading_progress_input', 'Storage returned invalid progress authority facts.');
  }
}

function upsertProductResult(record: ReadingProgressRecord, inserted: boolean): ProductCommandResult {
  return { status: inserted ? 201 : 200, body: Buffer.from(canonicalJson({ status: record.status,
    progress: record.progress, completedAt: record.completedAt?.toISOString() ?? null, updatedAt: record.updatedAt.toISOString() })),
  stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json', etag: readingProgressEtag(record) },
  mediaType: 'application/json', contractVersion: READING_PROGRESS_CONTRACT_VERSION,
  targetIdentity: `${record.resourceType}:${record.resourceId}` };
}

async function enforcePrecondition(ports: ReadingProgressCommandPorts, input: ValidatedBaseInput): Promise<void> {
  if (input.concurrency === undefined) return;
  if (!ports.progress.findForUpdate) throw new ReadingProgressError('invalid_reading_progress_input', 'Storage does not support Reading Progress preconditions.');
  const current = await ports.progress.findForUpdate({ accountId: input.actor.accountId, ...input.target });
  const currentEtag = current ? readingProgressEtag(current) : null;
  if (input.concurrency.expectedEtag !== currentEtag) throw new ReadingProgressError('reading_progress_precondition_failed',
    'The Reading Progress representation changed before this command.', currentEtag);
}
function resetProductResult(target: ReadingProgressCommandInput['target']): ProductCommandResult {
  return { status: 204, body: Buffer.alloc(0), stableHeaders: { 'cache-control': 'private, no-store' },
    mediaType: 'application/json', contractVersion: READING_PROGRESS_CONTRACT_VERSION,
    targetIdentity: `${target.resourceType}:${target.resourceId}` };
}
function mapClaim(claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>,
  { kind: 'claimed' }>): ReadingProgressCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
