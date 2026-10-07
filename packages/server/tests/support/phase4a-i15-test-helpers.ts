/**
 * Shared helpers for the P4A-I15 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides an in-memory durable admission switch store (single-row CAS with
 * lease-generation fencing mirroring the production PostgreSQL store),
 * deterministic admission switch states, a recording per-exact-key PITR object
 * store (HEAD call log + seeded facts + scripted outcomes) and an in-memory
 * PITR ledger, plus a fake secret resolver keyed by reference.
 */
import type {
  AttachmentsAdmissionSwitchState,
  AttachmentsAdmissionSwitchStore,
  AttachmentCredentialValue,
  PitrHeadOutcome,
  PitrLedgerRow,
  PitrObjectStorePort,
} from '../../src/modules/attachments/index.js';
import { makeBucket } from './phase4a-i07-test-helpers.js';

export function uuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

export const I15_BUCKET = makeBucket(); // shared phase4a fixture bucket used by the I07/I13 seed helpers
export const I15_LIVE_PREFIX = 'attachments/live/';

export function makeAdmissionState(
  overrides: Partial<AttachmentsAdmissionSwitchState> = {},
): AttachmentsAdmissionSwitchState {
  return {
    admissionEnabled: true,
    drainVerification: false,
    reason: null,
    leaseOwner: null,
    leaseGeneration: '0',
    leaseExpiresAtIso: null,
    updatedAtIso: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Faithful in-memory single-row switch with the same CAS semantics as the
 * production store: `transition` only succeeds when `expectedLeaseGeneration`
 * matches the current row, so a stale operator can never overwrite a newer
 * one (lease fencing).
 */
export class InMemoryAdmissionSwitchStore implements AttachmentsAdmissionSwitchStore {
  private row: AttachmentsAdmissionSwitchState = makeAdmissionState();
  readonly transitionCalls: number[] = [];

  setRow(row: AttachmentsAdmissionSwitchState): void {
    this.row = { ...row };
  }

  async read(): Promise<AttachmentsAdmissionSwitchState> {
    return { ...this.row };
  }

  async transition(input: {
    readonly expectedLeaseGeneration: string;
    readonly admissionEnabled: boolean;
    readonly drainVerification: boolean;
    readonly reason: string | null;
    readonly leaseOwner: string | null;
    readonly leaseGeneration: string;
    readonly leaseExpiresAtIso: string | null;
  }): Promise<{ outcome: 'updated'; state: AttachmentsAdmissionSwitchState } | { outcome: 'lease_conflict' }> {
    this.transitionCalls.push(1);
    if (input.expectedLeaseGeneration !== this.row.leaseGeneration) return { outcome: 'lease_conflict' };
    this.row = {
      admissionEnabled: input.admissionEnabled,
      drainVerification: input.drainVerification,
      reason: input.reason,
      leaseOwner: input.leaseOwner,
      leaseGeneration: input.leaseGeneration,
      leaseExpiresAtIso: input.leaseExpiresAtIso,
      updatedAtIso: '2026-08-08T00:00:01.000Z',
    };
    return { outcome: 'updated', state: { ...this.row } };
  }
}

// ---------------------------------------------------------------------------
// PITR fixtures
// ---------------------------------------------------------------------------

export function pitrRowFor(
  n: number,
  overrides: Partial<PitrLedgerRow> = {},
): PitrLedgerRow {
  const generationId = uuidFor(3000 + n);
  return {
    generationId,
    blobId: uuidFor(1000 + n),
    key: `${I15_LIVE_PREFIX}${uuidFor(4000 + n)}`,
    bucket: I15_BUCKET,
    generationState: 'active',
    expectedEtag: `"etag-${generationId}"`,
    expectedSize: 7,
    ...overrides,
  };
}

export type PitrScriptEntry = PitrHeadOutcome | 'default';

/** Recording per-exact-key PITR object store: logs every HEAD, never lists. */
export class RecordingPitrStore implements PitrObjectStorePort {
  readonly headCalls: Array<{ generationId: string; key: string }> = [];
  readonly facts = new Map<string, { etag: string; size: number }>();
  options: { script?: PitrScriptEntry[] } = {};

  seed(key: string, etag: string, size: number): void {
    this.facts.set(key, { etag, size });
  }

  async headExact(handle: { generationId: string; key: string }): Promise<PitrHeadOutcome> {
    this.headCalls.push({ generationId: handle.generationId, key: handle.key });
    const scripted = this.options.script?.shift();
    if (scripted && scripted !== 'default') return scripted;
    const fact = this.facts.get(handle.key);
    if (!fact) return { class: 'not_found' };
    return { class: 'ok', etag: fact.etag, size: fact.size };
  }
}

export class InMemoryPitrLedger {
  private rows: PitrLedgerRow[] = [];

  setRows(rows: PitrLedgerRow[]): void {
    this.rows = rows.map((row) => ({ ...row }));
  }

  async listClaimedGenerations(): Promise<PitrLedgerRow[]> {
    return this.rows.map((row) => ({ ...row }));
  }
}

// ---------------------------------------------------------------------------
// Rotation / secret fixtures
// ---------------------------------------------------------------------------

/** Deterministic non-secret key for a credential VALUE (test-local only). */
export function credentialValueKey(value: AttachmentCredentialValue): string {
  if (value.kind === 's3') return `s3:${value.accessKeyId}:${value.secretAccessKey}`;
  return `bearer:${value.token}`;
}

export function makeS3Credential(accessKeyId: string, secretAccessKey: string): AttachmentCredentialValue {
  return { kind: 's3', accessKeyId, secretAccessKey };
}

export function makeBearerCredential(token: string): AttachmentCredentialValue {
  return { kind: 'bearer', token };
}

export function makeSecretResolver(values: Readonly<Record<string, AttachmentCredentialValue>>): {
  readonly resolve: (ref: string) => Promise<AttachmentCredentialValue>;
  readonly resolvedRefs: string[];
} {
  const resolvedRefs: string[] = [];
  return {
    resolvedRefs,
    async resolve(ref: string): Promise<AttachmentCredentialValue> {
      resolvedRefs.push(ref);
      const value = values[ref];
      if (!value) throw new Error(`secret_ref_not_found:${ref}`);
      return value;
    },
  };
}