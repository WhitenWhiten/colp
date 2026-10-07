/**
 * Shared helpers for the P4A-I14 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides an in-memory cleanup ledger (claimCleanup batch keyset + complete
 * CAS under the fence + quarantine + readCleanupState), a recording in-memory
 * object store (HEAD/DELETE call logs + scripted fault outcomes), an
 * in-memory unit-of-work with deterministic commit-fault injection
 * (commit-response-lost), a deterministic crash marker, and a full
 * AttachmentsFeatureConfig with the I14 cleanup lease/retry surface.
 */
import type {
  AttachmentsFeatureConfig,
  ClaimCleanupInput,
  ClaimCleanupResult,
  CleanupClaim,
  CleanupKeysetCursor,
  CleanupVerdict,
  CompleteCleanupInput,
  CompleteCleanupResult,
  GenerationDeleteOutcome,
  GenerationHeadOutcome,
  GenerationObjectHandle,
  GenerationObjectStorePort,
  GenerationReadOptions,
  GenerationReadOutcome,
  GenerationState,
  IntentUnitOfWork,
  QuarantineGenerationInput,
  QuarantineGenerationResult,
  ReadCleanupStateInput,
  ReadCleanupStateResult,
} from '../../src/modules/attachments/index.js';
import { createUnitOfWork, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { generationRetentionDeadlineExpired } from '../../src/modules/attachments/index.js';

export function cleanupKeyFor(uuidValue: string): string {
  return `phase4a-i14/${uuidValue}`;
}

export function cleanupUuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

export interface I14Identity {
  blobId: string;
  intentId: string;
  generationId: string;
  key: string;
  fingerprint: string;
}

/** Deterministic generation identity for a numbered fixture slot. */
export function identityFor(n: number): I14Identity {
  const blobId = cleanupUuidFor(1000 + n);
  const intentId = cleanupUuidFor(2000 + n);
  const generationId = cleanupUuidFor(3000 + n);
  const key = cleanupKeyFor(cleanupUuidFor(4000 + n));
  return { blobId, intentId, generationId, key, fingerprint: `fingerprint-${key}` };
}

export function makeI14Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'known-private-attachments',
      livePrefix: 'attachments/live/',
      probePrefix: 'attachments/probe/',
      rwSecretRef: 'known/r2/rw/primary',
      roSecretRef: 'known/r2/ro/primary',
    },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    allowedMedia: ['image/png', 'application/pdf', 'text/plain'],
    verification: { leaseMs: 60_000, timeoutMs: 15_000, retryCount: 2 },
    retention: { intentRetentionHours: 24, storedRetentionDays: 30, retiredRetentionDays: 90 },
    cleanupBatchSize: 10,
    cleanup: { leaseMs: 60_000, retryCount: 1 },
    isolatedDeliveryOrigin: 'https://delivery.known.test',
    deliveryCapabilitySecretRef: 'known/delivery/hmac/primary',
    deliveryCapabilityTtlSeconds: 60,
  };
  return { ...base, ...overrides, r2: { ...base.r2, ...overrides.r2 } };
}

/** Simulated lost commit acknowledgement (classifies as unknown_outcome). */
export class CleanupCommitOutcomeUnknownError extends Error {
  readonly kind = 'commit_outcome_unknown' as const;
  constructor() {
    super('commit_outcome_unknown');
    this.name = 'CleanupCommitOutcomeUnknownError';
  }
}

export interface InMemoryGenerationRow {
  generationId: string;
  blobId: string;
  key: string;
  fingerprint: string;
  observedEtag: string | null;
  observedSize: number | null;
  state: GenerationState;
  attemptToken: string | null;
  leaseOwner: string | null;
  leaseGeneration: bigint;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  retiredAt: Date | null;
  orphanedAt: Date | null;
  currentGenerationId: string | null;
}

/**
 * Faithful in-memory cleanup ledger for the coordinator's claimed surface.
 * Applies the SAME retention rule as the production SQL (via
 * `generationRetentionDeadlineExpired`) and the same CAS fence semantics.
 */
export class InMemoryCleanupLedger {
  readonly rows = new Map<string, InMemoryGenerationRow>();
  readonly claimCalls: Array<{ leaseOwner: string; leaseTtlSeconds: number; limit: number; cursor: CleanupKeysetCursor | null; retiredRetentionDays?: number }> = [];
  readonly completeCalls: Array<{ generationId: string; verdict: CleanupVerdict; mismatchReason?: string }> = [];
  readonly quarantineCalls: Array<{ generationId: string; reason: string }> = [];
  readonly readStateCalls: string[] = [];
  private tokenCounter = 0;

  seed(row: Omit<InMemoryGenerationRow, 'attemptToken' | 'leaseOwner' | 'leaseGeneration' | 'leaseExpiresAt'>): void {
    this.rows.set(row.generationId, {
      ...row,
      attemptToken: null,
      leaseOwner: null,
      leaseGeneration: 0n,
      leaseExpiresAt: null,
    });
  }

  row(generationId: string): InMemoryGenerationRow | undefined {
    return this.rows.get(generationId);
  }

  /** Simulates DB lease expiry (takeover window) for restart tests. */
  expireLeases(): void {
    for (const row of this.rows.values()) {
      row.leaseExpiresAt = new Date(0);
    }
  }

  async claimCleanup(_tx: unknown, input: ClaimCleanupInput): Promise<ClaimCleanupResult> {
    this.claimCalls.push({
      leaseOwner: input.leaseOwner,
      leaseTtlSeconds: input.leaseTtlSeconds,
      limit: input.limit ?? 1,
      cursor: input.cursor ?? null,
      retiredRetentionDays: input.retiredRetentionDays,
    });
    if (input.generationId) {
      const row = this.rows.get(input.generationId);
      if (!row) return { outcome: 'not_claimable' };
      if (row.state !== 'retired' && row.state !== 'orphaned' && row.state !== 'deletion_pending') return { outcome: 'not_claimable' };
      if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() >= Date.now()) return { outcome: 'lease_held' };
      const claimed = this.markClaimed(row, input.leaseOwner, input.leaseTtlSeconds);
      return { outcome: 'claimed', claim: this.toClaim(claimed) };
    }
    const cursor = input.cursor ?? null;
    const days = input.retiredRetentionDays;
    const candidates = [...this.rows.values()]
      .filter((row) => {
        if (row.generationId === row.currentGenerationId) return false;
        if (row.state !== 'retired' && row.state !== 'orphaned' && row.state !== 'deletion_pending') return false;
        if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() >= Date.now()) return false;
        if (days !== undefined) {
          if (row.state === 'deletion_pending') return true;
          return generationRetentionDeadlineExpired(row.retiredAt, row.orphanedAt, days, Date.now());
        }
        return true;
      })
      .filter((row) => {
        if (!cursor) return true;
        const left = `${row.createdAt.toISOString()}|${row.generationId}`;
        const right = `${cursor.createdAtIso}|${cursor.generationId}`;
        return left > right;
      })
      .sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) return byTime;
        return a.generationId.localeCompare(b.generationId);
      })
      .slice(0, input.limit ?? 1);
    if (candidates.length === 0) return { outcome: 'none' };
    const claims = candidates.map((row) => this.toClaim(this.markClaimed(row, input.leaseOwner, input.leaseTtlSeconds)));
    return { outcome: 'batch', claims };
  }

  private markClaimed(row: InMemoryGenerationRow, leaseOwner: string, leaseTtlSeconds: number): InMemoryGenerationRow {
    this.tokenCounter += 1;
    row.state = 'deletion_pending';
    row.attemptToken = `token-${this.tokenCounter}`;
    row.leaseOwner = leaseOwner;
    row.leaseGeneration += 1n;
    row.leaseExpiresAt = new Date(Date.now() + leaseTtlSeconds * 1000);
    return row;
  }

  private toClaim(row: InMemoryGenerationRow): CleanupClaim {
    return {
      generationId: row.generationId,
      createdAt: row.createdAt,
      blobId: row.blobId,
      bucket: 'known-i14',
      key: row.key,
      keyFingerprint: row.fingerprint,
      observedEtag: row.observedEtag,
      observedSize: row.observedSize,
      leaseOwner: row.leaseOwner!,
      attemptToken: row.attemptToken!,
      leaseGeneration: row.leaseGeneration,
      leaseExpiresAt: row.leaseExpiresAt!,
      currentGenerationId: row.currentGenerationId,
    };
  }

  async completeCleanup(_tx: unknown, input: CompleteCleanupInput): Promise<CompleteCleanupResult> {
    this.completeCalls.push({ generationId: input.claim.generationId, verdict: input.verdict, mismatchReason: input.mismatchReason });
    const row = this.rows.get(input.claim.generationId);
    if (!row) return { outcome: 'not_claimable' };
    if (row.state === 'deleted') return { outcome: 'already_deleted' };
    if (row.state === 'quarantined') return { outcome: 'already_quarantined' };
    if (row.state !== 'deletion_pending'
      || row.attemptToken !== input.claim.attemptToken
      || row.leaseOwner !== input.claim.leaseOwner
      || row.leaseGeneration !== input.claim.leaseGeneration) {
      return { outcome: 'lease_lost' };
    }
    if (input.verdict === 'candidate_mismatch') {
      row.state = 'quarantined';
      return { outcome: 'quarantined' };
    }
    if (input.verdict === 'unknown_retryable') {
      row.attemptToken = null;
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      return { outcome: 'released' };
    }
    row.state = 'deleted';
    row.attemptToken = null;
    row.leaseOwner = null;
    row.leaseExpiresAt = null;
    return { outcome: 'completed', state: 'deleted' };
  }

  async quarantineGeneration(_tx: unknown, input: QuarantineGenerationInput): Promise<QuarantineGenerationResult> {
    this.quarantineCalls.push(input);
    const row = this.rows.get(input.generationId);
    if (!row) return { outcome: 'not_claimable' };
    if (row.state === 'quarantined') return { outcome: 'already_quarantined' };
    row.state = 'quarantined';
    return { outcome: 'quarantined' };
  }

  async readCleanupState(_tx: unknown, input: ReadCleanupStateInput): Promise<ReadCleanupStateResult> {
    this.readStateCalls.push(input.generationId);
    const row = this.rows.get(input.generationId);
    if (!row) return { outcome: 'not_found' };
    return {
      outcome: 'found',
      row: {
        generationState: row.state,
        cleanupAttemptToken: row.attemptToken,
        cleanupLeaseOwner: row.leaseOwner,
        cleanupLeaseGeneration: row.leaseGeneration,
      },
    };
  }
}

export type InMemoryCleanupTx = { readonly ledger: InMemoryCleanupLedger };

/**
 * In-memory unit of work: the callback mutates the ledger, then the optional
 * `afterCommitAcknowledged` fault throws to simulate a lost commit response.
 */
export class InMemoryCleanupUow {
  constructor(
    private readonly ledger: InMemoryCleanupLedger,
    private readonly options: { afterCommitAcknowledged?: () => void | Promise<void> } = {},
  ) {}

  async execute<Result>(callback: (context: { transaction: InMemoryCleanupTx }) => Promise<Result>): Promise<Result> {
    const result = await callback({ transaction: { ledger: this.ledger } });
    if (this.options.afterCommitAcknowledged) {
      await this.options.afterCommitAcknowledged();
    }
    return result;
  }
}

/** Scripted provider outcomes: 'default' falls through to the object map. */
export type HeadScriptEntry = GenerationHeadOutcome | 'default';
export type DeleteScriptEntry = GenerationDeleteOutcome | 'default';

/**
 * Recording in-memory object store for the coordinator: every HEAD/DELETE is
 * logged (so "the mismatch sent NO DELETE" and "only the exact retired key
 * was deleted" are provable) and outcomes can be scripted per call.
 */
export class InMemoryCleanupObjectStore implements GenerationObjectStorePort {
  readonly objects = new Map<string, { etag: string; size: number }>();
  readonly headCalls: GenerationObjectHandle[] = [];
  readonly deleteCalls: GenerationObjectHandle[] = [];
  options: { headScript?: HeadScriptEntry[]; deleteScript?: DeleteScriptEntry[] } = {};

  seed(key: string, etag: string, size: number): void {
    this.objects.set(key, { etag, size });
  }

  async headExact(handle: GenerationObjectHandle): Promise<GenerationHeadOutcome> {
    this.headCalls.push(handle);
    const scripted = this.options.headScript?.shift();
    if (scripted && scripted !== 'default') return scripted;
    const object = this.objects.get(handle.key);
    if (!object) return { class: 'not_found' };
    return {
      class: 'ok',
      identity: { generationId: handle.generationId, etag: object.etag, size: object.size, metadata: {} },
    };
  }

  async readBounded(_handle: GenerationObjectHandle, _options: GenerationReadOptions): Promise<GenerationReadOutcome> {
    throw new Error('cleanup never reads bodies');
  }

  async deleteExact(handle: GenerationObjectHandle): Promise<GenerationDeleteOutcome> {
    this.deleteCalls.push(handle);
    const scripted = this.options.deleteScript?.shift();
    if (scripted && scripted !== 'default') return scripted;
    if (!this.objects.has(handle.key)) return { class: 'not_found' };
    this.objects.delete(handle.key);
    return { class: 'deleted' };
  }

  async confirmAbsent(handle: GenerationObjectHandle): Promise<{ absent: boolean }> {
    const head = await this.headExact(handle);
    return { absent: head.class === 'not_found' };
  }
}

/** Crash marker thrown by fault-injector hooks to simulate a process death. */
export function cleanupCrash(hook: string): never {
  throw new Error(`cleanup_crash:${hook}`);
}

/**
 * Production-shaped unit of work for the coordinator: execute passes the
 * `{ transaction }` context exactly like `createUnitOfWork` /
 * `IntentUnitOfWork`. (The I07 `i07Uow` hands the raw transaction to the
 * callback and is NOT coordinator-shaped; passing it to `runCleanupBatch`
 * would destructure `Kysely#transaction` — a method — and break the claim.)
 */
export function i14Uow(runtime: DatabaseRuntime): IntentUnitOfWork<unknown> {
  return {
    execute<Result>(callback: (context: { transaction: unknown }) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(runtime.db).execute(({ transaction }) => callback({ transaction }));
    },
  };
}
