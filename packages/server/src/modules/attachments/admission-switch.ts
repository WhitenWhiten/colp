/**
 * P4A-I15 durable admission switch: stop admission + drain verification +
 * resume, backed by a durable single-row switch with lease semantics.
 *
 * The switch is a DB row/flag (not a process kill): `stopAdmissionAndDrain`
 * persists admission_enabled=false + drain_verification=true with a lease
 * (owner, generation, expiry), so issuance stops durably and verification
 * drains; `resumeAdmission` restores admission. Lease fencing prevents two
 * operators from fighting: while the lease is active a different operator is
 * `lease_conflict`; after the lease expires a new operator can take over and
 * the lease generation is bumped so a stale operator's CAS never lands.
 *
 * `issueUploadIntentWithAdmissionGate` composes the production
 * `issueUploadIntent` use case behind the gate (the composition I16 wires):
 * while stopped it refuses BEFORE any use-case work and creates no ledger
 * rows.
 */
import {
  issueUploadIntent,
  type IssueUploadIntentDeps,
  type IssueUploadIntentInput,
  type IssueUploadIntentResult,
} from './issue-upload-intent.js';

export const ADMISSION_MAINTENANCE_REASONS = ['maintenance', 'rotation', 'incident'] as const;
export type AdmissionMaintenanceReason = typeof ADMISSION_MAINTENANCE_REASONS[number];

export interface AttachmentsAdmissionSwitchState {
  readonly admissionEnabled: boolean;
  readonly drainVerification: boolean;
  /** Fixed non-secret reason code ('maintenance' | 'rotation' | 'incident'). */
  readonly reason: string | null;
  readonly leaseOwner: string | null;
  readonly leaseGeneration: string;
  readonly leaseExpiresAtIso: string | null;
  readonly updatedAtIso: string;
}

export interface AttachmentsAdmissionSwitchStore {
  read(): Promise<AttachmentsAdmissionSwitchState>;
  /**
   * Single-row CAS: only succeeds when `expectedLeaseGeneration` matches the
   * current row (lease fencing). Returns `lease_conflict` otherwise.
   */
  transition(input: {
    readonly expectedLeaseGeneration: string;
    readonly admissionEnabled: boolean;
    readonly drainVerification: boolean;
    readonly reason: string | null;
    readonly leaseOwner: string | null;
    readonly leaseGeneration: string;
    readonly leaseExpiresAtIso: string | null;
  }): Promise<{ outcome: 'updated'; state: AttachmentsAdmissionSwitchState } | { outcome: 'lease_conflict' }>;
}

export type AdmissionCommandResult =
  | { readonly outcome: 'stopped'; readonly state: AttachmentsAdmissionSwitchState }
  | { readonly outcome: 'already_stopped'; readonly state: AttachmentsAdmissionSwitchState }
  | { readonly outcome: 'resumed'; readonly state: AttachmentsAdmissionSwitchState }
  | { readonly outcome: 'already_resumed'; readonly state: AttachmentsAdmissionSwitchState }
  | { readonly outcome: 'lease_conflict'; readonly reason: 'held_by_another_operator' }
  | { readonly outcome: 'invalid_reason' };

export interface AdmissionSwitchDeps {
  readonly store: AttachmentsAdmissionSwitchStore;
  readonly now: () => Date;
}

export function admissionAllowsIssuance(state: AttachmentsAdmissionSwitchState): boolean {
  return state.admissionEnabled === true && state.drainVerification === false;
}

/** Planned maintenance is active while the switch is stopped or draining. */
export function admissionMaintenanceActive(state: AttachmentsAdmissionSwitchState): boolean {
  return state.admissionEnabled === false || state.drainVerification === true;
}

export async function readAdmissionState(deps: AdmissionSwitchDeps): Promise<AttachmentsAdmissionSwitchState> {
  return deps.store.read();
}

function nextLeaseGeneration(current: string): string {
  const value = /^\d+$/u.test(current) ? BigInt(current) : 0n;
  return String(value + 1n);
}

function leaseActive(state: AttachmentsAdmissionSwitchState, nowMs: number): boolean {
  return state.leaseOwner !== null
    && state.leaseExpiresAtIso !== null
    && Date.parse(state.leaseExpiresAtIso) > nowMs;
}

export async function stopAdmissionAndDrain(
  deps: AdmissionSwitchDeps,
  input: {
    readonly reason: AdmissionMaintenanceReason;
    readonly operatorId: string;
    readonly leaseTtlSeconds: number;
  },
): Promise<AdmissionCommandResult> {
  if (!ADMISSION_MAINTENANCE_REASONS.includes(input.reason)) return { outcome: 'invalid_reason' };
  if (!Number.isSafeInteger(input.leaseTtlSeconds) || input.leaseTtlSeconds < 1) {
    return { outcome: 'invalid_reason' };
  }
  const current = await deps.store.read();
  const nowMs = deps.now().getTime();
  const leaseExpiresAtIso = new Date(nowMs + input.leaseTtlSeconds * 1_000).toISOString();

  if (current.admissionEnabled === false) {
    if (leaseActive(current, nowMs)) {
      if (current.leaseOwner === input.operatorId) {
        return { outcome: 'already_stopped', state: current };
      }
      return { outcome: 'lease_conflict', reason: 'held_by_another_operator' };
    }
    // Lease expired or stale: a new operator may take over (lease bumped).
    const takeover = await deps.store.transition({
      expectedLeaseGeneration: current.leaseGeneration,
      admissionEnabled: false,
      drainVerification: true,
      reason: input.reason,
      leaseOwner: input.operatorId,
      leaseGeneration: nextLeaseGeneration(current.leaseGeneration),
      leaseExpiresAtIso,
    });
    if (takeover.outcome === 'lease_conflict') {
      return { outcome: 'lease_conflict', reason: 'held_by_another_operator' };
    }
    return { outcome: 'stopped', state: takeover.state };
  }

  const updated = await deps.store.transition({
    expectedLeaseGeneration: current.leaseGeneration,
    admissionEnabled: false,
    drainVerification: true,
    reason: input.reason,
    leaseOwner: input.operatorId,
    leaseGeneration: nextLeaseGeneration(current.leaseGeneration),
    leaseExpiresAtIso,
  });
  if (updated.outcome === 'lease_conflict') {
    return { outcome: 'lease_conflict', reason: 'held_by_another_operator' };
  }
  return { outcome: 'stopped', state: updated.state };
}

export async function resumeAdmission(
  deps: AdmissionSwitchDeps,
  input: { readonly operatorId: string },
): Promise<AdmissionCommandResult> {
  const current = await deps.store.read();
  if (current.admissionEnabled === true) {
    return { outcome: 'already_resumed', state: current };
  }
  const nowMs = deps.now().getTime();
  if (leaseActive(current, nowMs)) {
    if (current.leaseOwner === input.operatorId) {
      // The lease owner may resume.
      const updated = await deps.store.transition({
        expectedLeaseGeneration: current.leaseGeneration,
        admissionEnabled: true,
        drainVerification: false,
        reason: null,
        leaseOwner: null,
        leaseGeneration: nextLeaseGeneration(current.leaseGeneration),
        leaseExpiresAtIso: null,
      });
      if (updated.outcome === 'lease_conflict') {
        return { outcome: 'lease_conflict', reason: 'held_by_another_operator' };
      }
      return { outcome: 'resumed', state: updated.state };
    }
    return { outcome: 'lease_conflict', reason: 'held_by_another_operator' };
  }
  // No active lease: the switch may be resumed (e.g. a stale stopped row).
  const updated = await deps.store.transition({
    expectedLeaseGeneration: current.leaseGeneration,
    admissionEnabled: true,
    drainVerification: false,
    reason: null,
    leaseOwner: null,
    leaseGeneration: nextLeaseGeneration(current.leaseGeneration),
    leaseExpiresAtIso: null,
  });
  if (updated.outcome === 'lease_conflict') {
    return { outcome: 'lease_conflict', reason: 'held_by_another_operator' };
  }
  return { outcome: 'resumed', state: updated.state };
}

/** Compose the production issue use case behind the durable admission gate. */
export async function issueUploadIntentWithAdmissionGate<Transaction>(
  deps: IssueUploadIntentDeps<Transaction> & {
    readonly admissionState: () => Promise<AttachmentsAdmissionSwitchState>;
  },
  input: IssueUploadIntentInput,
): Promise<{ outcome: 'admission_stopped' } | { outcome: 'issued'; result: IssueUploadIntentResult }> {
  const state = await deps.admissionState();
  if (!admissionAllowsIssuance(state)) {
    return { outcome: 'admission_stopped' };
  }
  const result = await issueUploadIntent(deps, input);
  return { outcome: 'issued', result };
}